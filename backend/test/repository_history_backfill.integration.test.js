const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { publishSnapshotBatch, readSnapshotGeneration } = require('../snapshot_batch');
const { repairMissingRepositoryHistory } = require('../repository_history_backfill');
const { findMissingRepositorySnapshots } = require('../repository_snapshot_coverage');
const { checkSnapshotConsistency } = require('../snapshot_hierarchy');

test('history repair rejects invalid work limits without accessing the database', async () => {
    for (const maxDates of [0, -1, 1.5, 367]) await assert.rejects(repairMissingRepositoryHistory({ maxDates }), /date limit/);
});

test('repository lifecycle history repair against PostgreSQL', { skip: !process.env.SNAPSHOT_TEST_DATABASE_URL }, async t => {
    const connectionString = process.env.SNAPSHOT_TEST_DATABASE_URL;
    const schema = `history_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString });
    const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); });
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const filename of ['schema.sql', 'contributors_schema.sql']) {
        await pool.query((await fs.readFile(path.join(__dirname, '../../db', filename), 'utf8')).replace(/^\\.*$/gm, ''));
    }
    await pool.query('ALTER TABLE repositories DROP COLUMN github_created_at');
    const migration = await fs.readFile(path.join(__dirname, '../../db/migrations/005_repository_github_created_at.sql'), 'utf8');
    await pool.query(migration); await pool.query(migration);
    await pool.query("INSERT INTO organizations (name) VALUES ('history-org')");
    await pool.query("INSERT INTO special_interest_groups (org_id,slug,name) VALUES (1,'one','one')");
    await pool.query("INSERT INTO repositories (org_id,sig_id,name,github_created_at) VALUES (1,1,'existing','2020-01-01T00:00:00Z')");
    const baseRepo = (await pool.query('SELECT id,name,sig_id FROM repositories')).rows[0];
    const zero = () => ({ new_commits: 0, lines_added: 0, lines_deleted: 0, authorStats: {} });
    const apiZero = () => ({ new_prs: 0, closed_merged_prs: 0, new_issues: 0, closed_issues: 0 });
    const retainedDates = ['2024-09-05', '2026-09-20', '2026-09-21'];
    for (const snapshotDate of retainedDates) {
        await publishSnapshotBatch({ pool, orgId: 1, orgName: 'history-org', snapshotDate, repositories: [baseRepo],
            entries: [{ repoId: 1, commitStats: zero(), apiMetrics: apiZero(), contributorDetails: [] }],
            expectedGeneration: await readSnapshotGeneration(pool, 1), markFresh: true });
    }
    await pool.query("INSERT INTO repositories (org_id,sig_id,name,github_created_at) VALUES (1,1,'new','2026-09-21T14:04:30Z')");
    const freshness = (await pool.query('SELECT last_ingestion_completed_at FROM organizations')).rows[0].last_ingestion_completed_at;
    const oldRows = (await pool.query('SELECT * FROM repo_snapshots WHERE repo_id=1 ORDER BY id')).rows;
    const calls = [];
    const dateKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const days = (first, last) => {
        const result = []; for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) result.push(dateKey(d)); return result;
    };
    const fetchCommits = async (repo, first, last) => {
        calls.push({ repo: repo.id, first: dateKey(first), last: dateKey(last) });
        return new Map(days(first, last).map(date => {
            const count = repo.id === 2 && date === '2024-09-05' ? 2 : repo.id === 2 && date === '2026-09-21' ? 1 : 0;
            return [date, { ...zero(), new_commits: count, authorStats: count ? { alice: { github_id: 123, commits: count, lines_added: 0, lines_deleted: 0 } } : {} }];
        }));
    };
    const fetchApi = async (_repo, first, last) => ({ statsMap: new Map(days(first, last).map(date => [date, apiZero()])), contributorDetailsMap: new Map(days(first, last).map(date => [date, new Map()])) });
    const options = { pool, orgId: 1, orgName: 'history-org', fetchCommits, fetchApi };

    await t.test('coverage separates pre-creation uncertainty from post-creation missing data', async () => {
        const missing = await findMissingRepositorySnapshots(pool, 1);
        assert.equal(missing.length, 3);
        assert.equal(missing.filter(row => row.reason === 'pre_creation_unverified').length, 2);
        assert.equal(missing.filter(row => row.reason === 'missing_after_creation').length, 1);
    });
    await t.test('repairs recent gaps first, stores verified zeros, and preserves old facts and freshness', async () => {
        assert.deepEqual(await repairMissingRepositoryHistory({ ...options, maxDates: 2 }), { publishedDates: 2, remainingDates: 1 });
        assert.equal((await pool.query("SELECT new_commits FROM repo_snapshots WHERE repo_id=2 AND snapshot_date='2026-09-20'")).rows[0].new_commits, 0);
        assert.deepEqual((await pool.query('SELECT * FROM repo_snapshots WHERE repo_id=1 ORDER BY id')).rows, oldRows);
        assert.deepEqual((await pool.query('SELECT last_ingestion_completed_at FROM organizations')).rows[0].last_ingestion_completed_at, freshness);
    });
    await t.test('resume discovers remaining gaps and retains imported commits predating creation', async () => {
        assert.deepEqual(await repairMissingRepositoryHistory(options), { publishedDates: 1, remainingDates: 0 });
        assert.ok(calls.some(call => call.first === '2024-09-05'));
        assert.equal((await pool.query("SELECT new_commits FROM repo_snapshots WHERE repo_id=2 AND snapshot_date='2024-09-05'")).rows[0].new_commits, 2);
        assert.equal((await pool.query("SELECT first_seen_date::text AS first FROM contributors WHERE github_username='alice'")).rows[0].first, '2024-09-05');
        assert.deepEqual(await findMissingRepositorySnapshots(pool, 1), []);
        const generation = await readSnapshotGeneration(pool, 1);
        assert.deepEqual(await repairMissingRepositoryHistory(options), { publishedDates: 0, remainingDates: 0 });
        assert.equal(await readSnapshotGeneration(pool, 1), generation);
    });
    await t.test('two new repositories are published together; collection failure writes no zeros', async () => {
        await pool.query("INSERT INTO repositories (org_id,sig_id,name) VALUES (1,1,'third'),(1,1,'fourth')");
        const generation = await readSnapshotGeneration(pool, 1);
        await assert.rejects(repairMissingRepositoryHistory({ ...options, fetchApi: async (repo, ...args) => {
            if (repo.id === 4) throw Error('GitHub unavailable');
            return fetchApi(repo, ...args);
        } }), /GitHub unavailable/);
        assert.equal(await readSnapshotGeneration(pool, 1), generation);
        assert.equal((await pool.query('SELECT COUNT(*)::integer AS n FROM repo_snapshots WHERE repo_id IN (3,4)')).rows[0].n, 0);
        await repairMissingRepositoryHistory(options);
        assert.deepEqual(await findMissingRepositorySnapshots(pool, 1), []);
        assert.deepEqual(await checkSnapshotConsistency(pool, 1), []);
        assert.ok(calls.every(call => Date.parse(call.last) - Date.parse(call.first) <= 6 * 86400000),
            'sparse retained dates must not create an unbounded GitHub query window');
    });
    await t.test('a concurrent publication rejects stale historical results', async () => {
        await pool.query("INSERT INTO repositories (org_id,sig_id,name) VALUES (1,1,'fifth')");
        let changed = false;
        await assert.rejects(repairMissingRepositoryHistory({ ...options, fetchCommits: async (...args) => {
            if (!changed) { changed = true; await pool.query('UPDATE organizations SET snapshot_generation=snapshot_generation+1'); }
            return fetchCommits(...args);
        } }), /generation changed/);
        assert.equal((await pool.query('SELECT COUNT(*)::integer AS n FROM repo_snapshots WHERE repo_id=5')).rows[0].n, 0);
    });
});
