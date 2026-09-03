const assert = require('node:assert/strict');
const test = require('node:test');

const { storeCommitAuthorStats } = require('../commit_author_stats');

function createDatabaseDouble({ failOn } = {}) {
    const queries = [];
    let released = false;

    const client = {
        async query(sql, params = []) {
            const text = sql.trim();
            queries.push({ sql: text, params });

            if (failOn && text.includes(failOn)) {
                throw new Error('database write failed');
            }
            if (text.startsWith('SELECT org_id')) {
                return { rows: [{ org_id: 7 }] };
            }
            if (text.startsWith('SELECT contributor_id')) {
                return { rows: [{ contributor_id: 41 }] };
            }
            if (text.startsWith('INSERT INTO contributors')) {
                return { rows: [{ id: 42 }] };
            }
            return { rows: [], rowCount: 1 };
        },
        release() {
            released = true;
        },
    };

    return {
        pool: { connect: async () => client },
        queries,
        wasReleased: () => released,
    };
}

test('commit authors are persisted and organization daily totals are rebuilt', async () => {
    const database = createDatabaseDouble();

    await storeCommitAuthorStats({
        pool: database.pool,
        repoId: 11,
        snapshotDate: '2026-09-02',
        authorStats: {
            alice: {
                github_id: 101,
                avatar_url: 'https://example.test/alice',
                commits: 2,
                lines_added: 15,
                lines_deleted: 4,
            },
        },
    });

    assert.equal(database.queries[0].sql, 'BEGIN');
    assert.equal(database.queries.at(-1).sql, 'COMMIT');
    assert.equal(database.wasReleased(), true);

    const contributorInsert = database.queries.find((query) => query.sql.startsWith('INSERT INTO contributors'));
    assert.deepEqual(contributorInsert.params, [
        'alice',
        101,
        'https://example.test/alice',
        '2026-09-02',
    ]);

    const repoActivityInsert = database.queries.find((query) => query.sql.startsWith('INSERT INTO contributor_repo_activities'));
    assert.deepEqual(repoActivityInsert.params, [42, 11, '2026-09-02', 2, 15, 4]);

    const lockQuery = database.queries.find((query) => query.sql.includes('pg_advisory_xact_lock'));
    assert.deepEqual(lockQuery.params, [7, '2026-09-02']);

    const dailyInsert = database.queries.find((query) => query.sql.startsWith('INSERT INTO contributor_daily_activities'));
    assert.deepEqual(dailyInsert.params, [7, '2026-09-02', [41, 42]]);
    assert.match(dailyInsert.sql, /SUM\(cra\.commits_count\)/);
    assert.match(dailyInsert.sql, /r\.sig_id IS NOT NULL/);
});

test('commit author persistence rolls back and propagates write failures', async () => {
    const database = createDatabaseDouble({ failOn: 'INSERT INTO contributor_repo_activities' });

    await assert.rejects(
        storeCommitAuthorStats({
            pool: database.pool,
            repoId: 11,
            snapshotDate: '2026-09-02',
            authorStats: {
                alice: {
                    github_id: 101,
                    avatar_url: null,
                    commits: 1,
                    lines_added: 3,
                    lines_deleted: 1,
                },
            },
        }),
        /database write failed/
    );

    assert.equal(database.queries.some((query) => query.sql === 'ROLLBACK'), true);
    assert.equal(database.queries.some((query) => query.sql === 'COMMIT'), false);
    assert.equal(database.wasReleased(), true);
});
