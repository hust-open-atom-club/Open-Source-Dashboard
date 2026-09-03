const assert = require('node:assert/strict');
const test = require('node:test');

const {
    SIG_DEFINITIONS,
    applyRepositorySigAssignments,
    fetchRepositorySigAssignments,
    normalizeAssignments,
} = require('../repository_sig_sync');

const allowedValues = ['untracked', ...Object.keys(SIG_DEFINITIONS)];

function propertyRow(repositoryName, value, repositoryId) {
    return {
        repository_id: repositoryId,
        repository_name: repositoryName,
        properties: [{ property_name: 'osd_sig', value }],
    };
}

test('Custom Property reader consumes every page before returning assignments', async () => {
    const calls = [];
    const httpClient = {
        async get(url) {
            calls.push(url);
            if (url.includes('/properties/schema/osd_sig')) {
                return {
                    data: {
                        property_name: 'osd_sig',
                        value_type: 'single_select',
                        allowed_values: allowedValues,
                    },
                    headers: {},
                };
            }
            if (url.endsWith('page=2')) {
                return {
                    data: [propertyRow('tracked-repo', 'r2', 102)],
                    headers: {},
                };
            }
            return {
                data: [propertyRow('ignored-repo', 'untracked', 101)],
                headers: {
                    link: '<https://api.github.test/values?page=2>; rel="next", <https://api.github.test/values?page=2>; rel="last"',
                },
            };
        },
    };

    const assignments = await fetchRepositorySigAssignments({
        githubToken: 'test-token',
        httpClient,
    });

    assert.equal(calls.length, 3);
    assert.deepEqual(assignments, [
        { repositoryId: '101', repositoryName: 'ignored-repo', propertyValue: 'untracked', sigSlug: null },
        { repositoryId: '102', repositoryName: 'tracked-repo', propertyValue: 'r2', sigSlug: 'r2' },
    ]);
});

test('Custom Property reader fails closed on an unsupported schema value', async () => {
    let calls = 0;
    const httpClient = {
        async get() {
            calls += 1;
            return {
                data: {
                    property_name: 'osd_sig',
                    value_type: 'single_select',
                    allowed_values: [...allowedValues, 'new-sig'],
                },
                headers: {},
            };
        },
    };

    await assert.rejects(
        fetchRepositorySigAssignments({ githubToken: 'test-token', httpClient }),
        /Unsupported osd_sig value\(s\): new-sig/
    );
    assert.equal(calls, 1);
});

test('assignment normalization rejects duplicate repository rows ignoring case', () => {
    assert.throws(
        () => normalizeAssignments([
            propertyRow('Example', 'r2', 201),
            propertyRow('example', 'r2', 202),
        ], 'osd_sig'),
        /duplicate Custom Property rows/
    );
});

test('assignment normalization rejects duplicate GitHub repository IDs', () => {
    assert.throws(
        () => normalizeAssignments([
            propertyRow('first', 'r2', 203),
            propertyRow('second', 'hctt', 203),
        ], 'osd_sig'),
        /duplicate repository_id 203/
    );
});

test('database synchronization preserves untracked rows and reaggregates changed SIGs transactionally', async () => {
    const queries = [];
    const sigIds = new Map(Object.keys(SIG_DEFINITIONS).map((slug, index) => [slug, 100 + index]));
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
            if (compact.startsWith('SELECT r.id, r.github_id')) {
                return {
                    rows: [
                        { id: 10, github_id: null, name: 'tracked-old', sig_id: 2, sig_slug: 'linux-kernel' },
                        { id: 11, github_id: null, name: 'removed-repo', sig_id: 3, sig_slug: 'r2' },
                        { id: 12, github_id: null, name: 'already-untracked', sig_id: null, sig_slug: null },
                    ],
                    rowCount: 3,
                };
            }
            if (compact.includes('INSERT INTO sig_snapshots')) {
                return { rows: [], rowCount: 12 };
            }
            if (compact.includes('INSERT INTO activity_snapshots')) {
                return { rows: [], rowCount: 6 };
            }
            if (compact.startsWith('INSERT INTO contributor_daily_activities')) {
                return { rows: [], rowCount: 8 };
            }
            return { rows: [], rowCount: 1 };
        },
        release() {
            queries.push({ sql: 'RELEASE', params: [] });
        },
    };
    const pool = { async connect() { return client; } };

    const result = await applyRepositorySigAssignments({
        pool,
        assignments: [
            { repositoryId: '301', repositoryName: 'tracked-old', propertyValue: 'r2', sigSlug: 'r2' },
            { repositoryId: '302', repositoryName: 'already-untracked', propertyValue: 'untracked', sigSlug: null },
            { repositoryId: '303', repositoryName: 'new-repo', propertyValue: 'hctt', sigSlug: 'hctt' },
        ],
    });

    assert.equal(result.repositories, 3);
    assert.equal(result.tracked, 2);
    assert.equal(result.untracked, 1);
    assert.equal(result.created, 1);
    assert.equal(result.disabled, 1);
    assert.deepEqual(
        result.changes.map((change) => change.repository).sort(),
        ['new-repo', 'removed-repo', 'tracked-old']
    );
    assert.equal(result.reaggregation.sigSnapshots, 12);
    assert.equal(result.reaggregation.organizationSnapshots, 6);
    assert.equal(result.reaggregation.contributorDailyActivities, 8);
    assert.ok(queries.some((query) =>
        query.sql.includes('INSERT INTO contributor_daily_activities')
        && query.sql.includes('r.sig_id IS NOT NULL')
    ));
    assert.ok(queries.some((query) =>
        query.sql.includes('UPDATE contributor_daily_activities cda')
        && query.sql.includes('NOT EXISTS')
    ));
    assert.ok(queries.some((query) => query.sql.includes('HAVING BOOL_OR')));
    assert.ok(queries.some((query) => query.sql === 'COMMIT'));
    assert.ok(!queries.some((query) => query.sql === 'ROLLBACK'));
    assert.equal(queries.at(-1).sql, 'RELEASE');
});

test('database synchronization matches a renamed repository by GitHub ID', async () => {
    const queries = [];
    const sigIds = new Map(Object.keys(SIG_DEFINITIONS).map((slug, index) => [slug, 100 + index]));
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
            if (compact.startsWith('SELECT r.id, r.github_id')) {
                return {
                    rows: [{ id: 10, github_id: '98765', name: 'old-name', sig_id: sigIds.get('r2'), sig_slug: 'r2' }],
                    rowCount: 1,
                };
            }
            return { rows: [], rowCount: 1 };
        },
        release() {},
    };

    const result = await applyRepositorySigAssignments({
        pool: { async connect() { return client; } },
        assignments: [{
            repositoryId: '98765',
            repositoryName: 'new-name',
            propertyValue: 'r2',
            sigSlug: 'r2',
        }],
    });

    assert.equal(result.created, 0);
    assert.equal(result.disabled, 0);
    assert.deepEqual(result.changes, [{
        repository: 'new-name',
        previousRepository: 'old-name',
        from: 'r2',
        to: 'r2',
    }]);
    assert.ok(queries.some((query) =>
        query.sql.includes('UPDATE repositories')
        && query.params[0] === 'new-name'
        && query.params[3] === 10
    ));
    assert.ok(!queries.some((query) => query.sql.includes('INSERT INTO repositories (org_id')));
});

test('database synchronization preserves an old identity when its repository name is reused', async () => {
    const queries = [];
    const sigIds = new Map(Object.keys(SIG_DEFINITIONS).map((slug, index) => [slug, 100 + index]));
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
            if (compact.startsWith('SELECT r.id, r.github_id')) {
                return {
                    rows: [{ id: 10, github_id: '111', name: 'reused-name', sig_id: sigIds.get('r2'), sig_slug: 'r2' }],
                    rowCount: 1,
                };
            }
            return { rows: [], rowCount: 1 };
        },
        release() {},
    };

    const result = await applyRepositorySigAssignments({
        pool: { async connect() { return client; } },
        assignments: [{
            repositoryId: '222',
            repositoryName: 'reused-name',
            propertyValue: 'hctt',
            sigSlug: 'hctt',
        }],
    });

    assert.equal(result.created, 1);
    assert.equal(result.disabled, 1);
    assert.ok(queries.some((query) =>
        query.sql === 'UPDATE repositories SET name = $1 WHERE id = $2'
        && query.params[0].includes('~osd-history-github-111')
        && query.params[1] === 10
    ));
    assert.ok(queries.some((query) =>
        query.sql.includes('INSERT INTO repositories (org_id')
        && query.params[2] === '222'
        && query.params[3] === 'reused-name'
    ));
    assert.ok(queries.some((query) =>
        query.sql === 'UPDATE repositories SET sig_id = NULL WHERE id = $1'
        && query.params[0] === 10
    ));
    assert.ok(queries.some((query) => query.sql === 'COMMIT'));
    assert.ok(!queries.some((query) => query.sql === 'ROLLBACK'));
});

test('database synchronization rolls back when a write fails', async () => {
    const commands = [];
    const client = {
        async query(sql) {
            const compact = sql.replace(/\s+/g, ' ').trim();
            commands.push(compact);
            if (compact.startsWith('INSERT INTO organizations')) {
                throw new Error('database unavailable');
            }
            return { rows: [], rowCount: 0 };
        },
        release() {
            commands.push('RELEASE');
        },
    };

    await assert.rejects(
        applyRepositorySigAssignments({
            pool: { async connect() { return client; } },
            assignments: [],
        }),
        /database unavailable/
    );

    assert.ok(commands.includes('ROLLBACK'));
    assert.equal(commands.at(-1), 'RELEASE');
});
