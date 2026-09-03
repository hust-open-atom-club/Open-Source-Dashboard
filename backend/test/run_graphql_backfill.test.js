const assert = require('node:assert/strict');
const test = require('node:test');

const {
    fetchCommitHistoryViaGraphQL,
    fetchCommitsViaGraphQL,
    fetchRepoStatsViaGraphQL,
    formatDate,
} = require('../run_graphql_backfill');
const { runPromisesWithConcurrency } = require('../promise_concurrency');
const {
    defaultGraphQLClient,
} = require('../github_commit_history');
const {
    getPrimaryRateLimitWaitMs,
} = require('../github_rate_limit');

test('only a confirmed primary rate-limit 403 is retryable', () => {
    const resetTime = Math.floor(Date.now() / 1000) + 60;

    assert.equal(getPrimaryRateLimitWaitMs({
        response: {
            status: 403,
            headers: {
                'x-ratelimit-remaining': '4999',
                'x-ratelimit-reset': String(resetTime),
            },
        },
    }), null);

    assert.equal(typeof getPrimaryRateLimitWaitMs({
        response: {
            status: 403,
            headers: {
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': String(resetTime),
            },
        },
    }), 'number');
});

test('the default GraphQL client bounds primary rate-limit retries', async () => {
    const previousToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    let calls = 0;
    const rateLimitError = Object.assign(new Error('rate limit exceeded'), {
        response: {
            status: 403,
            headers: {
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': '0',
            },
        },
    });

    try {
        await assert.rejects(
            defaultGraphQLClient('query Test { viewer { login } }', {}, {
                request: async () => {
                    calls++;
                    throw rateLimitError;
                },
                delay: async () => {},
            }),
            (error) => error === rateLimitError
        );
    } finally {
        if (previousToken === undefined) {
            delete process.env.GITHUB_TOKEN;
        } else {
            process.env.GITHUB_TOKEN = previousToken;
        }
    }

    assert.equal(calls, 2);
});

test('the default GraphQL client does not retry permission 403 responses', async () => {
    const previousToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    let calls = 0;
    let delays = 0;
    const permissionError = Object.assign(new Error('resource protected by SAML SSO'), {
        response: {
            status: 403,
            headers: {
                'x-ratelimit-remaining': '4999',
                'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
            },
        },
    });

    try {
        await assert.rejects(
            defaultGraphQLClient('query Test { viewer { login } }', {}, {
                request: async () => {
                    calls++;
                    throw permissionError;
                },
                delay: async () => { delays++; },
            }),
            (error) => error === permissionError
        );
    } finally {
        if (previousToken === undefined) {
            delete process.env.GITHUB_TOKEN;
        } else {
            process.env.GITHUB_TOKEN = previousToken;
        }
    }

    assert.equal(calls, 1);
    assert.equal(delays, 0);
});

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

test('commit collection paginates GraphQL history and aggregates human authors', async () => {
    const calls = [];
    const pages = {
        first: {
            pageInfo: { hasNextPage: true, endCursor: 'page-2' },
            nodes: [
                {
                    committedDate: '2026-08-31T02:00:00Z',
                    additions: 12,
                    deletions: 3,
                    author: { user: { login: 'alice', databaseId: 101, avatarUrl: 'https://example.test/alice' } },
                },
                {
                    committedDate: '2026-08-31T03:00:00Z',
                    additions: 4,
                    deletions: 1,
                    author: { user: { login: 'dependabot[bot]', databaseId: 102, avatarUrl: 'https://example.test/bot' } },
                },
            ],
        },
        'page-2': {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
                {
                    committedDate: '2026-08-31T04:00:00Z',
                    additions: 7,
                    deletions: 2,
                    author: { user: { login: 'alice', databaseId: 101, avatarUrl: 'https://example.test/alice' } },
                },
            ],
        },
    };

    const result = await fetchCommitsViaGraphQL(
        'example-repo',
        new Date('2026-08-31T12:00:00Z'),
        async (_query, variables) => {
            calls.push(variables);
            const history = pages[variables.cursor || 'first'];
            return { repository: { defaultBranchRef: { target: { history } } } };
        }
    );

    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.cursor), [null, 'page-2']);
    assert.equal(calls[0].owner, 'hust-open-atom-club');
    assert.equal(calls[0].repo, 'example-repo');
    assert.equal(new Date(calls[0].until).getTime() - new Date(calls[0].since).getTime(), 24 * 60 * 60 * 1000);
    assert.equal(result.new_commits, 3);
    assert.equal(result.lines_added, 23);
    assert.equal(result.lines_deleted, 6);
    assert.deepEqual(result.authorStats, {
        alice: {
            github_id: 101,
            avatar_url: 'https://example.test/alice',
            commits: 2,
            lines_added: 19,
            lines_deleted: 5,
        },
    });
});

test('commit history fetches a date range once and buckets commits by local date', async () => {
    const firstDate = new Date(2026, 7, 30);
    const secondDate = new Date(2026, 7, 31);
    const calls = [];

    const statsMap = await fetchCommitHistoryViaGraphQL(
        'example-repo',
        firstDate,
        secondDate,
        async (_query, variables) => {
            calls.push(variables);
            return {
                repository: {
                    defaultBranchRef: {
                        target: {
                            history: {
                                pageInfo: { hasNextPage: false, endCursor: null },
                                nodes: [
                                    {
                                        committedDate: new Date(2026, 7, 30, 12).toISOString(),
                                        additions: 5,
                                        deletions: 1,
                                        author: { user: null },
                                    },
                                    {
                                        committedDate: new Date(2026, 7, 31, 12).toISOString(),
                                        additions: 8,
                                        deletions: 2,
                                        author: { user: null },
                                    },
                                ],
                            },
                        },
                    },
                },
            };
        }
    );

    assert.equal(calls.length, 1);
    assert.equal(statsMap.size, 2);
    assert.deepEqual(statsMap.get(formatDate(firstDate)), {
        new_commits: 1,
        lines_added: 5,
        lines_deleted: 1,
        authorStats: {},
    });
    assert.deepEqual(statsMap.get(formatDate(secondDate)), {
        new_commits: 1,
        lines_added: 8,
        lines_deleted: 2,
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
