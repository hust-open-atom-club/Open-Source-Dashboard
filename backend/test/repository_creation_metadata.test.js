const assert = require('node:assert/strict');
const test = require('node:test');
const { applyRepositorySigAssignments, fetchRepositoryCreationTimes, syncRepositorySigsFromGitHub, SIG_DEFINITIONS } = require('../repository_sig_sync');

test('creation metadata paginates by stable ID and retains GitHub timestamps', async () => {
    const calls = [];
    const data = await fetchRepositoryCreationTimes({ githubToken: 'test', httpClient: { get: async url => {
        calls.push(url);
        return url.endsWith('page=2')
            ? { data: [{ id: 2, name: 'renamed', created_at: '2020-01-02T03:04:05Z' }] }
            : { data: [{ id: 1, name: 'new', created_at: '2026-09-21T14:04:30Z' }], headers: { link: '<https://api.github.com/orgs/test/repos?page=2>; rel="next"' } };
    } } });
    assert.equal(calls.length, 2);
    assert.equal(data.get('1').createdAt, '2026-09-21T14:04:30.000Z');
    assert.equal(data.get('2').createdAt, '2020-01-02T03:04:05.000Z');
});

test('metadata rejects missing timestamps, duplicate IDs and foreign pagination before following it', async () => {
    for (const response of [
        { data: [{ id: 1, name: 'one' }] },
        { data: [{ id: 1, name: 'one', created_at: 'invalid' }] },
        { data: Array(2).fill({ id: 1, name: 'one', created_at: '2026-01-01T00:00:00Z' }) },
        { data: [], headers: { link: '<https://evil.invalid/repos>; rel="next"' } },
    ]) {
        let calls = 0;
        await assert.rejects(fetchRepositoryCreationTimes({ githubToken: 'test', httpClient: { get: async () => { calls++; return response; } } }));
        assert.equal(calls, 1);
    }
});

test('incomplete metadata prevents any database mutation', async () => {
    let connected = false;
    await assert.rejects(syncRepositorySigsFromGitHub({
        pool: { connect: async () => { connected = true; throw Error('must not connect'); } }, githubToken: 'test',
        httpClient: { get: async url => {
            if (url.includes('/schema/')) return { data: { property_name: 'osd_sig', value_type: 'single_select', allowed_values: ['untracked', ...Object.keys(SIG_DEFINITIONS)] } };
            if (url.includes('/properties/values')) return { data: [{ repository_id: 1, repository_name: 'repo', properties: [{ property_name: 'osd_sig', value: 'r2' }] }] };
            return { data: [] };
        } },
    }), /coverage differ/);
    assert.equal(connected, false);
});

test('existing repository creation metadata is filled without changing its SIG or freshness', async () => {
    const queries = [];
    const createdAt = '2026-09-21T14:04:30.000Z';
    const client = {
        query: async (sql, params = []) => {
            queries.push({ sql, params });
            if (sql.includes('INSERT INTO organizations')) return { rows: [{ id: 1 }] };
            if (sql.includes('INSERT INTO special_interest_groups')) return { rows: [{ id: params[1] === 'r2' ? 2 : 3 }] };
            if (sql.includes('SELECT r.id, r.github_id')) return { rows: [
                { id: 10, github_id: '100', name: 'repo', sig_id: 2, sig_slug: 'r2', is_in_organization: true, github_created_at: null },
            ] };
            return { rows: [], rowCount: 0 };
        },
        release() {},
    };
    const result = await applyRepositorySigAssignments({ pool: { connect: async () => client }, assignments: [
        { repositoryId: '100', repositoryName: 'repo', sigSlug: 'r2', propertyValue: 'r2', githubCreatedAt: createdAt },
    ] });
    assert.equal(result.metadataUpdated, 1);
    assert.deepEqual(result.changes, []);
    assert.deepEqual(result.affectedSigIds, []);
    assert.ok(queries.some(({ sql, params }) => sql.includes('UPDATE repositories')
        && sql.includes('github_created_at') && params[4] === createdAt));
    assert.ok(!queries.some(({ sql }) => sql.includes('last_ingestion_completed_at')));
    assert.ok(queries.some(({ sql }) => sql === 'COMMIT'));
});
