const assert = require('node:assert/strict');
const test = require('node:test');

const {
    resolveSigSlugFromPropertyValues,
    normalizeAssociatedPropertyRows,
    normalizeAssociatedRepositoryListing,
    fetchAssociatedOrgRepositoryAssignments,
    applyAssociatedOrgRepositories,
} = require('../associated_repository_sync');
const { SIG_DEFINITIONS } = require('../repository_sig_sync');

function propertyRow(name, id, { properties = [] } = {}) {
    return {
        repository_name: name,
        repository_id: id,
        repository_full_name: `rustsbi/${name}`,
        properties,
    };
}

function repoRow(name, id, { private: isPrivate = false } = {}) {
    return { name, id, private: isPrivate };
}

test('osd_sig property values resolve to supported SIG slugs', () => {
    assert.equal(
        resolveSigSlugFromPropertyValues('rustsbi', [{ property_name: 'osd_sig', value: 'r2' }]),
        'r2'
    );
    assert.equal(
        resolveSigSlugFromPropertyValues('linux-kernel-dev', [{ property_name: 'osd_sig', value: 'linux-kernel' }]),
        'linux-kernel'
    );
    // No declaration (or an explicit untracked declaration) means the
    // repository is not tracked.
    assert.equal(resolveSigSlugFromPropertyValues('sbi-spec', []), null);
    assert.equal(resolveSigSlugFromPropertyValues('sbi-spec', [{ property_name: 'osd_sig', value: 'untracked' }]), null);
    assert.equal(
        resolveSigSlugFromPropertyValues('notes', [{ property_name: 'other_property', value: 'r2' }]),
        null
    );
});

test('osd_sig property resolution fails closed on invalid declarations', () => {
    assert.throws(
        () => resolveSigSlugFromPropertyValues('rustsbi', [{ property_name: 'osd_sig', value: 'does-not-exist' }]),
        /declares unsupported osd_sig value: does-not-exist/
    );
    assert.throws(
        () => resolveSigSlugFromPropertyValues('rustsbi', [
            { property_name: 'osd_sig', value: 'r2' },
            { property_name: 'osd_sig', value: 'hctt' },
        ]),
        /declares multiple osd_sig values/
    );
    assert.throws(
        () => resolveSigSlugFromPropertyValues('rustsbi', undefined),
        /without a valid properties list/
    );
    assert.throws(
        () => resolveSigSlugFromPropertyValues('rustsbi', [{ property_name: 'osd_sig', value: null }]),
        /invalid osd_sig value/
    );
});

test('property listing normalization keeps ids stable and detects duplicates', () => {
    const declarations = normalizeAssociatedPropertyRows([
        propertyRow('rustsbi', 501, { properties: [{ property_name: 'osd_sig', value: 'r2' }] }),
        propertyRow('silent-repo', 502),
        propertyRow('slides', 504, { properties: [{ property_name: 'osd_sig', value: 'hctt' }] }),
    ], 'osd_sig');

    assert.deepEqual(declarations, [
        { repositoryId: '501', repositoryName: 'rustsbi', sigSlug: 'r2' },
        { repositoryId: '502', repositoryName: 'silent-repo', sigSlug: null },
        { repositoryId: '504', repositoryName: 'slides', sigSlug: 'hctt' },
    ]);

    assert.throws(
        () => normalizeAssociatedPropertyRows([propertyRow('Example', 701), propertyRow('example', 702)], 'osd_sig'),
        /duplicate Custom Property rows for example/
    );
    assert.throws(
        () => normalizeAssociatedPropertyRows([propertyRow('first', 703), propertyRow('second', 703)], 'osd_sig'),
        /duplicate repository_id 703/
    );
    assert.throws(
        () => normalizeAssociatedRepositoryListing([repoRow('first', 703), repoRow('second', 703)]),
        /duplicate associated repository id 703/
    );
    assert.throws(
        () => normalizeAssociatedRepositoryListing([{ name: 'opaque', id: 704 }]),
        /without a privacy flag/
    );
});

function associatedHttpClient({ propertyPages, repositoryPages }) {
    const calls = [];
    const httpClient = {
        async get(url) {
            calls.push(url);
            const propertyMatch = url.match(/\/orgs\/rustsbi\/properties\/values.*[?&]page=(\d+)/);
            if (propertyMatch) {
                const page = Number(propertyMatch[1]);
                return { data: propertyPages[page - 1] ?? [], headers: propertyPages[page] ? pageLink('properties/values', page + 1) : {} };
            }
            if (url.includes('/orgs/rustsbi/properties/values')) {
                return {
                    data: propertyPages[0],
                    headers: propertyPages[1] ? pageLink('properties/values', 2) : {},
                };
            }
            const repositoryMatch = url.match(/\/orgs\/rustsbi\/repos.*[?&]page=(\d+)/);
            if (repositoryMatch) {
                const page = Number(repositoryMatch[1]);
                return { data: repositoryPages[page - 1] ?? [], headers: repositoryPages[page] ? pageLink('repos', page + 1) : {} };
            }
            if (url.includes('/orgs/rustsbi/repos')) {
                return {
                    data: repositoryPages[0],
                    headers: repositoryPages[1] ? pageLink('repos', 2) : {},
                };
            }
            throw new Error(`Unexpected URL requested by sync: ${url}`);
        },
    };
    return { httpClient, calls };

    function pageLink(path, page) {
        return {
            link: `<https://api.github.test/orgs/rustsbi/${path}?per_page=100&page=${page}>; rel="next", <https://api.github.test/orgs/rustsbi/${path}?per_page=100&page=${page}>; rel="last"`,
        };
    }
}

test('associated reader tracks declared public repositories and skips private ones', async () => {
    const { httpClient, calls } = associatedHttpClient({
        propertyPages: [
            [
                propertyRow('rustsbi', 501, { properties: [{ property_name: 'osd_sig', value: 'r2' }] }),
                propertyRow('silent-repo', 502),
                propertyRow('ruyisbi', 503, { properties: [{ property_name: 'osd_sig', value: 'r2' }] }),
            ],
            [
                propertyRow('slides', 504, { properties: [{ property_name: 'osd_sig', value: 'hctt' }] }),
            ],
        ],
        repositoryPages: [
            [
                repoRow('rustsbi', 501),
                repoRow('silent-repo', 502),
                repoRow('ruyisbi', 503, { private: true }),
            ],
            [
                repoRow('slides', 504),
            ],
        ],
    });

    const { assignments, skippedPrivate } = await fetchAssociatedOrgRepositoryAssignments({
        githubToken: 'test-token',
        ownerLogin: 'rustsbi',
        httpClient,
    });

    // Both listings are consumed page by page.
    assert.equal(calls.filter((url) => url.includes('properties/values')).length, 2);
    assert.equal(calls.filter((url) => url.includes('/repos')).length, 2);

    // The declared r2/hctt repositories are tracked; the undeclared
    // repository and the private one are not.
    assert.deepEqual(assignments, [
        { repositoryId: '501', repositoryName: 'rustsbi', sigSlug: 'r2' },
        { repositoryId: '504', repositoryName: 'slides', sigSlug: 'hctt' },
    ]);
    assert.deepEqual(skippedPrivate, ['ruyisbi']);
});

test('associated reader fails closed when a declared repository is missing from the listing', async () => {
    const { httpClient } = associatedHttpClient({
        propertyPages: [
            [propertyRow('ghost', 501, { properties: [{ property_name: 'osd_sig', value: 'r2' }] })],
        ],
        repositoryPages: [
            [repoRow('other', 999)],
        ],
    });

    await assert.rejects(
        () => fetchAssociatedOrgRepositoryAssignments({
            githubToken: 'test-token',
            ownerLogin: 'rustsbi',
            httpClient,
        }),
        /declares osd_sig=r2 but is missing from the organization repository listing/
    );
});

test('associated synchronization upserts declared repositories with owner, disables dropped declarations', async () => {
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
            if (compact.startsWith('SELECT r.id, r.github_id')) {
                return {
                    rows: [
                        // Tracked before but the declaration was removed.
                        { id: 20, github_id: '900', name: 'rustsbi', sig_id: null, sig_slug: null },
                        // Still tracked, but no longer declares the property.
                        { id: 21, github_id: '901', name: 'removed-declaration', sig_id: r2SigId, sig_slug: 'r2' },
                        // Disappeared from the org listing entirely.
                        { id: 22, github_id: '902', name: 'deleted-associated', sig_id: r2SigId, sig_slug: 'r2' },
                    ],
                    rowCount: 3,
                };
            }
            return { rows: [], rowCount: 1 };
        },
        release() {
            queries.push({ sql: 'RELEASE', params: [] });
        },
    };
    const pool = { async connect() { return client; } };

    const result = await applyAssociatedOrgRepositories({
        pool,
        ownerLogin: 'rustsbi',
        assignments: [
            // Previously untracked row (id 20) regains tracking via its declaration.
            { repositoryId: '900', repositoryName: 'rustsbi', sigSlug: 'r2' },
            // Newly declared repository.
            { repositoryId: '903', repositoryName: 'sbi-spec', sigSlug: 'r2' },
        ],
    });

    assert.equal(result.repositories, 2);
    assert.equal(result.tracked, 2);
    assert.equal(result.created, 1);
    assert.equal(result.disabled, 2);

    // Newly created repositories carry the associated org owner login.
    const inserts = queries.filter((query) => query.sql.includes('INSERT INTO repositories'));
    assert.equal(inserts.length, 1);
    assert.deepEqual(inserts[0].params, [1, r2SigId, '903', 'sbi-spec', 'rustsbi']);

    // The previously untracked row is re-enabled with its SIG restored.
    const updateExisting = queries.find((query) =>
        query.sql.includes('UPDATE repositories') && query.sql.includes('SET name = $1, sig_id = $2, github_id = $3')
    );
    assert.ok(updateExisting);
    assert.deepEqual(updateExisting.params, ['rustsbi', r2SigId, '900', 20]);

    // Repositories that dropped their osd_sig declaration (21) or vanished
    // from the org listing (22) keep history but stop being tracked.
    const disables = queries.filter((query) =>
        query.sql === 'UPDATE repositories SET sig_id = NULL WHERE id = $1'
    );
    assert.deepEqual(disables.map((query) => query.params[0]), [21, 22]);

    assert.ok(queries.some((query) => query.sql === 'COMMIT'));
    assert.ok(!queries.some((query) => query.sql === 'ROLLBACK'));
    assert.equal(queries.at(-1).sql, 'RELEASE');
});

test('associated synchronization supports distinct SIG declarations per repository', async () => {
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
                return { rows: [], rowCount: 0 };
            }
            return { rows: [], rowCount: 1 };
        },
        release() {
            queries.push({ sql: 'RELEASE', params: [] });
        },
    };
    const pool = { async connect() { return client; } };

    const result = await applyAssociatedOrgRepositories({
        pool,
        ownerLogin: 'rustsbi',
        assignments: [
            { repositoryId: '904', repositoryName: 'rustsbi', sigSlug: 'r2' },
            { repositoryId: '905', repositoryName: 'tutorial', sigSlug: 'hctt' },
        ],
    });

    assert.equal(result.tracked, 2);
    assert.equal(result.created, 2);

    const inserts = queries.filter((query) => query.sql.includes('INSERT INTO repositories'));
    assert.deepEqual(inserts.map((insert) => insert.params[3]), ['rustsbi', 'tutorial']);
    assert.deepEqual(inserts.map((insert) => insert.params[1]), [sigIds.get('r2'), sigIds.get('hctt')]);
    assert.deepEqual(inserts.map((insert) => insert.params[4]), ['rustsbi', 'rustsbi']);
});
