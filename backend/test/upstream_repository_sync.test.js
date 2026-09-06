const assert = require('node:assert/strict');
const test = require('node:test');

const {
    normalizeUpstreamRepositories,
    fetchUpstreamOrgRepositories,
    applyUpstreamOrgRepositories,
} = require('../upstream_repository_sync');
const { SIG_DEFINITIONS } = require('../repository_sig_sync');

function repoRow(name, id, { archived = false, fork = false } = {}) {
    return { name, id, archived, fork };
}

test('upstream repository reader consumes every page and normalizes ids', async () => {
    const calls = [];
    const httpClient = {
        async get(url) {
            calls.push(url);
            if (url.endsWith('page=2')) {
                return { data: [repoRow('rustsbi', 501)], headers: {} };
            }
            return {
                data: [repoRow('sbi-spec', 502)],
                headers: {
                    link: '<https://api.github.test/orgs/rustsbi/repos?per_page=100&page=2>; rel="next", <https://api.github.test/orgs/rustsbi/repos?per_page=100&page=2>; rel="last"',
                },
            };
        },
    };

    const assignments = await fetchUpstreamOrgRepositories({
        githubToken: 'test-token',
        ownerLogin: 'rustsbi',
        httpClient,
    });

    assert.equal(calls.length, 2);
    assert.deepEqual(assignments, [
        { repositoryId: '501', repositoryName: 'rustsbi' },
        { repositoryId: '502', repositoryName: 'sbi-spec' },
    ]);
});

test('upstream repository reader honors archived and fork filters', () => {
    const assignments = normalizeUpstreamRepositories([
        repoRow('active', 601),
        repoRow('archived-repo', 602, { archived: true }),
        repoRow('forked-repo', 603, { fork: true }),
    ], { includeArchived: false, includeForks: false });

    assert.deepEqual(assignments, [{ repositoryId: '601', repositoryName: 'active' }]);

    const includingEverything = normalizeUpstreamRepositories([
        repoRow('active', 601),
        repoRow('archived-repo', 602, { archived: true }),
        repoRow('forked-repo', 603, { fork: true }),
    ], { includeArchived: true, includeForks: true });

    assert.equal(includingEverything.length, 3);
});

test('upstream repository reader rejects duplicate names and ids', () => {
    assert.throws(
        () => normalizeUpstreamRepositories([repoRow('Example', 701), repoRow('example', 702)], {}),
        /duplicate upstream repositories named example/
    );
    assert.throws(
        () => normalizeUpstreamRepositories([repoRow('first', 703), repoRow('second', 703)], {}),
        /duplicate upstream repository id 703/
    );
});

test('upstream synchronization upserts repositories with owner and all-branch flag, disables removed ones', async () => {
    const queries = [];
    const sigIds = new Map(Object.keys(SIG_DEFINITIONS).map((slug, index) => [slug, 100 + index]));
    const r2SigId = sigIds.get('r2');
    const client = {
        async query(sql, params = []) {
            queries.push({ sql, params });
            const compact = sql.replace(/\s+/g, ' ').trim();

            if (compact === 'BEGIN' || compact === 'COMMIT' || compact === 'ROLLBACK') {
                return { rows: [], rowCount: 0 };
            }
            if (compact.startsWith('INSERT INTO organizations')) {
                return { rows: [{ id: 1 }], rowCount: 1 };
            }
            if (compact.startsWith('INSERT INTO special_interest_groups')) {
                return { rows: [{ id: sigIds.get(params[1]) }], rowCount: 1 };
            }
            if (compact.startsWith('SELECT id, github_id, name, sig_id, track_all_branches')) {
                return {
                    rows: [
                        { id: 20, github_id: '900', name: 'rustsbi', sig_id: null, track_all_branches: false },
                        { id: 21, github_id: '901', name: 'removed-upstream', sig_id: r2SigId, track_all_branches: false },
                    ],
                    rowCount: 2,
                };
            }
            return { rows: [], rowCount: 1 };
        },
        release() {
            queries.push({ sql: 'RELEASE', params: [] });
        },
    };
    const pool = { async connect() { return client; } };

    const result = await applyUpstreamOrgRepositories({
        pool,
        ownerLogin: 'rustsbi',
        sigSlug: 'r2',
        mainRepoName: 'rustsbi',
        assignments: [
            { repositoryId: '900', repositoryName: 'rustsbi' },
            { repositoryId: '902', repositoryName: 'sbi-spec' },
        ],
    });

    assert.equal(result.repositories, 2);
    assert.equal(result.created, 1);
    assert.equal(result.disabled, 1);

    // Existing main repository gains all-branch tracking without losing its row.
    const updateExisting = queries.find((query) =>
        query.sql.includes('UPDATE repositories') && query.sql.includes('track_all_branches = $4')
    );
    assert.ok(updateExisting);
    assert.deepEqual(updateExisting.params, ['rustsbi', r2SigId, '900', true, 20]);

    // Newly created repositories carry the upstream owner; only the main
    // repository is flagged for all-branch commit statistics.
    const inserts = queries.filter((query) => query.sql.includes('INSERT INTO repositories'));
    assert.equal(inserts.length, 1);
    assert.deepEqual(inserts[0].params, [1, r2SigId, '902', 'sbi-spec', 'rustsbi', false]);

    // Repositories that disappeared from the upstream org keep history but
    // stop being tracked.
    const disable = queries.find((query) =>
        query.sql === 'UPDATE repositories SET sig_id = NULL WHERE id = $1'
    );
    assert.ok(disable);
    assert.equal(disable.params[0], 21);

    assert.ok(queries.some((query) => query.sql === 'COMMIT'));
    assert.ok(!queries.some((query) => query.sql === 'ROLLBACK'));
    assert.equal(queries.at(-1).sql, 'RELEASE');
});

test('upstream synchronization rejects unknown SIG slugs', async () => {
    const client = {
        async query() { return { rows: [], rowCount: 0 }; },
        release() {},
    };

    await assert.rejects(
        applyUpstreamOrgRepositories({
            pool: { async connect() { return client; } },
            ownerLogin: 'rustsbi',
            sigSlug: 'does-not-exist',
            assignments: [],
        }),
        /Unsupported upstream SIG slug/
    );
});
