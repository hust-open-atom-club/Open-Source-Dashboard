const assert = require('node:assert/strict');
const test = require('node:test');

const {
    fetchCommitsViaGraphQL,
    fetchRepoStatsViaGraphQL,
    runPromisesWithConcurrency,
} = require('../run_graphql_backfill');

test('commit collection propagates GraphQL request failures instead of returning zeros', async () => {
    const requestError = new Error('Bad credentials');

    await assert.rejects(
        fetchCommitsViaGraphQL(
            'example-repo',
            new Date('2026-08-31T00:00:00Z'),
            async () => { throw requestError; }
        ),
        (error) => {
            assert.match(error.message, /Failed to fetch commits for example-repo: Bad credentials/);
            assert.equal(error.cause, requestError);
            return true;
        }
    );
});

test('PR and issue collection propagates GraphQL request failures instead of returning empty maps', async () => {
    const requestError = new Error('secondary rate limit');

    await assert.rejects(
        fetchRepoStatsViaGraphQL(
            'example-repo',
            new Date('2026-08-01T00:00:00Z'),
            new Date('2026-08-31T00:00:00Z'),
            async () => { throw requestError; }
        ),
        (error) => {
            assert.match(error.message, /Failed to fetch stats for example-repo: secondary rate limit/);
            assert.equal(error.cause, requestError);
            return true;
        }
    );
});

test('a missing repository is treated as a collection failure', async () => {
    await assert.rejects(
        fetchCommitsViaGraphQL(
            'missing-repo',
            new Date('2026-08-31T00:00:00Z'),
            async () => ({ repository: null })
        ),
        /Repository missing-repo not found or inaccessible/
    );
});

test('an empty repository with no default branch still produces legitimate zero commit stats', async () => {
    const result = await fetchCommitsViaGraphQL(
        'empty-repo',
        new Date('2026-08-31T00:00:00Z'),
        async () => ({ repository: { defaultBranchRef: null } })
    );

    assert.deepEqual(result, {
        new_commits: 0,
        lines_added: 0,
        lines_deleted: 0,
        authorStats: {},
    });
});

test('the concurrency runner reports task failures after allowing other tasks to finish', async () => {
    const completed = [];

    await assert.rejects(
        runPromisesWithConcurrency([
            async () => { completed.push('first'); },
            async () => { throw new Error('request failed'); },
            async () => { completed.push('third'); },
        ], 2),
        (error) => {
            assert.ok(error instanceof AggregateError);
            assert.match(error.message, /1 task\(s\) failed/);
            assert.equal(error.errors[0].message, 'request failed');
            return true;
        }
    );

    assert.deepEqual(completed.sort(), ['first', 'third']);
});
