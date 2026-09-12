const assert = require('node:assert/strict');
const test = require('node:test');
const configured = require('../external_repositories.json');
const { SIG_DEFINITIONS, syncRepositorySigsFromGitHub } = require('../repository_sig_sync');
const { resolveRepository } = require('../repository_name');
const { fetchCommitsViaGraphQL } = require('../github_commit_history');
const { fetchRepoStatsViaGraphQL } = require('../run_graphql_backfill');
const { collectAndPersistRepoApiStats } = require('../repo_api_ingestion');
const { mapRepositoryInsightRow } = require('../repository_insights');

function githubClient(externalGet) {
    return { async get(url) {
        if (url.includes('/properties/schema/')) return { data: {
            property_name: 'osd_sig', value_type: 'single_select',
            allowed_values: ['untracked', ...Object.keys(SIG_DEFINITIONS)],
        } };
        if (url.includes('/properties/values')) return { data: [{
            repository_id: 1, repository_name: 'rustsbi',
            properties: [{ property_name: 'osd_sig', value: 'r2' }],
        }], headers: {} };
        return externalGet(url);
    } };
}

test('external RustSBI repositories join R² alongside the club repository without name collisions', async () => {
    const inserted = [];
    const groups = new Map();
    const fetched = [];
    const result = await syncRepositorySigsFromGitHub({
        githubToken: 'test-token',
        httpClient: githubClient(async url => {
            const fullName = url.split('/repos/')[1];
            fetched.push(fullName);
            return { data: { id: 100 + fetched.length, full_name: fullName } };
        }),
        pool: { async connect() { return {
            async query(sql, params) {
                if (sql.includes('INSERT INTO organizations')) {
                    assert.deepEqual(params, ['hust-open-atom-club']);
                    return { rows: [{ id: 1 }] };
                }
                if (sql.includes('INSERT INTO special_interest_groups')) {
                    groups.set(params[1], groups.size + 1);
                    return { rows: [{ id: groups.get(params[1]) }] };
                }
                if (sql.includes('INSERT INTO repositories')) inserted.push(params);
                return { rows: [], rowCount: 0 };
            },
            release() {},
        }; } },
    });
    assert.deepEqual(fetched, configured.r2);
    const expectedNames = ['rustsbi', ...configured.r2];
    assert.equal(result.tracked, expectedNames.length);
    assert.deepEqual(inserted.map(row => row[3]).sort(), expectedNames.sort());
    assert.equal(new Set(inserted.map(row => row[3])).size, expectedNames.length);
    assert.ok(inserted.every(row => row[0] === 1 && row[1] === groups.get('r2')));
});

test('failed external lookups and duplicate identities abort before database writes', async () => {
    for (const externalGet of [
        async () => { throw new Error('lookup failed'); },
        async () => ({ data: { id: 1, full_name: 'rustsbi/rustsbi' } }),
    ]) {
        let connected = false;
        await assert.rejects(syncRepositorySigsFromGitHub({
            githubToken: 'test-token',
            externalRepositorySigs: { r2: ['rustsbi/rustsbi'] },
            httpClient: githubClient(externalGet),
            pool: { connect() { connected = true; throw new Error('Unexpected database access'); } },
        }), /lookup failed|duplicate repository_id/);
        assert.equal(connected, false);
    }
});

test('REST searches use the external owner but persistence retains the dashboard organization', async () => {
    await collectAndPersistRepoApiStats({
        orgName: 'hust-open-atom-club', repoName: 'rustsbi/spacemit-hal',
        repoId: 42, snapshotDate: '2026-09-12',
        githubRest: async (endpoint, params) => {
            assert.ok(params.q.startsWith('repo:rustsbi/spacemit-hal '));
            return { items: [], total_count: 0 };
        },
        persistRepoApiStats: async params => {
            assert.equal(params.orgName, 'hust-open-atom-club');
            assert.equal(params.repoId, 42);
            return {};
        },
    });
});

test('commit and PR/issue backfill use external repository coordinates', async () => {
    const date = new Date('2026-09-12T12:00:00Z');
    let calls = 0;
    const client = async (query, variables) => {
        calls++;
        assert.equal(variables.owner, 'rustsbi');
        assert.equal(variables.repo, 'spacemit-hal');
        return { repository: {
            defaultBranchRef: null,
            pullRequests: { nodes: [], pageInfo: { hasNextPage: false } },
            issues: { nodes: [], pageInfo: { hasNextPage: false } },
        } };
    };
    await fetchCommitsViaGraphQL('rustsbi/spacemit-hal', date, client);
    await fetchRepoStatsViaGraphQL('rustsbi/spacemit-hal', date, date, client);
    assert.equal(calls, 3);
});

test('short repository names keep their owner while external links resolve to RustSBI', () => {
    assert.deepEqual(resolveRepository('rustsbi', 'hust-open-atom-club'), {
        owner: 'hust-open-atom-club', repo: 'rustsbi',
    });
    assert.equal(mapRepositoryInsightRow({ name: 'rustsbi/spacemit-hal' }, 'hust-open-atom-club').url,
        'https://github.com/rustsbi/spacemit-hal');
});
