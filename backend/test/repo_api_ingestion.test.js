const assert = require('node:assert/strict');
const test = require('node:test');

const { collectAndPersistRepoApiStats } = require('../repo_api_ingestion');

test('REST collection failures abort before replacement persistence', async () => {
    let requestCount = 0;
    let persistenceCount = 0;

    await assert.rejects(
        collectAndPersistRepoApiStats({
            githubRest: async () => {
                requestCount++;
                if (requestCount === 2) throw new Error('search unavailable');
                return { total_count: 1, items: [] };
            },
            pool: {},
            orgName: 'example-org',
            repoId: 11,
            repoName: 'example-repo',
            snapshotDate: '2026-09-03',
            persistRepoApiStats: async () => {
                persistenceCount++;
            },
        }),
        /search unavailable/
    );

    assert.equal(requestCount, 2);
    assert.equal(persistenceCount, 0);
});

test('successful REST collection persists metrics and human contributor facts once', async () => {
    const responses = [
        {
            total_count: 2,
            items: [
                { user: { login: 'alice', id: 101, avatar_url: 'alice.png' } },
                { user: { login: 'dependabot[bot]', id: 202, avatar_url: 'bot.png' } },
            ],
        },
        {
            total_count: 1,
            items: [{ user: { login: 'alice', id: 101, avatar_url: 'alice.png' } }],
        },
        {
            total_count: 1,
            items: [{ user: { login: 'bob', id: 303, avatar_url: 'bob.png' } }],
        },
        { total_count: 0, items: [] },
    ];
    const persisted = [];

    const result = await collectAndPersistRepoApiStats({
        githubRest: async () => responses.shift(),
        pool: { name: 'database-pool' },
        orgName: 'example-org',
        repoId: 11,
        repoName: 'example-repo',
        snapshotDate: '2026-09-03',
        persistRepoApiStats: async (options) => {
            persisted.push(options);
            return { snapshotId: 99, storedContributorCount: 2 };
        },
    });

    assert.equal(persisted.length, 1);
    assert.deepEqual(persisted[0].apiMetrics, {
        new_prs: 2,
        closed_merged_prs: 1,
        new_issues: 1,
        closed_issues: 0,
        active_contributors: 2,
    });
    assert.deepEqual(persisted[0].contributorDetails, [
        {
            username: 'alice',
            avatar_url: 'alice.png',
            github_id: 101,
            prs_opened: 1,
            prs_closed: 0,
            issues_opened: 1,
            issues_closed: 0,
        },
        {
            username: 'bob',
            avatar_url: 'bob.png',
            github_id: 303,
            prs_opened: 0,
            prs_closed: 1,
            issues_opened: 0,
            issues_closed: 0,
        },
    ]);
    assert.equal(result.snapshotId, 99);
});
