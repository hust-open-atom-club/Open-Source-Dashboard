const assert = require('node:assert/strict');
const test = require('node:test');

const {
    fetchBranchNamesViaGraphQL,
    fetchAllBranchCommitHistoryViaGraphQL,
    fetchAllBranchCommitsViaGraphQL,
} = require('../github_commit_history');

function commitNode(oid, { date, login, additions, deletions, parents = 1 }) {
    return {
        oid,
        committedDate: date.toISOString(),
        author: login
            ? { user: { login, databaseId: login.length, avatarUrl: `https://example.test/${login}` } }
            : { user: null },
        additions,
        deletions,
        parents: { totalCount: parents },
    };
}

function dispatchingClient({ branches, historiesByBranch, repositoryMissing = false }) {
    return async (query, variables) => {
        if (query.includes('refs(refPrefix: "refs/heads/"')) {
            if (repositoryMissing) {
                return { repository: null };
            }
            return {
                repository: {
                    refs: {
                        pageInfo: { hasNextPage: false, endCursor: null },
                        nodes: branches.map((name) => ({ name })),
                    },
                },
            };
        }

        const history = historiesByBranch[variables.ref];
        if (!history) {
            throw new Error(`unexpected ref ${variables.ref}`);
        }
        return {
            repository: {
                ref: {
                    target: {
                        history: {
                            pageInfo: { hasNextPage: false, endCursor: null },
                            nodes: history,
                        },
                    },
                },
            },
        };
    };
}

test('all-branch history deduplicates commits shared between branches', async () => {
    const day = new Date(2026, 8, 2);
    const client = dispatchingClient({
        branches: ['main', '0.4.2'],
        historiesByBranch: {
            'refs/heads/main': [
                commitNode('a1', { date: new Date(2026, 8, 2, 10), login: 'alice', additions: 10, deletions: 2 }),
                commitNode('b1', { date: new Date(2026, 8, 2, 11), login: 'alice', additions: 50, deletions: 5, parents: 2 }),
            ],
            // a1 is the same commit reachable from the release branch; it must
            // only be counted once. c1 exists solely on 0.4.2.
            'refs/heads/0.4.2': [
                commitNode('c1', { date: new Date(2026, 8, 2, 12), login: 'bob', additions: 3, deletions: 1 }),
                commitNode('a1', { date: new Date(2026, 8, 2, 10), login: 'alice', additions: 10, deletions: 2 }),
            ],
        },
    });

    const statsMap = await fetchAllBranchCommitHistoryViaGraphQL(
        'rustsbi',
        day,
        day,
        client,
        'rustsbi'
    );

    assert.equal(statsMap.size, 1);
    assert.deepEqual(statsMap.get('2026-09-02'), {
        new_commits: 3,
        lines_added: 13,
        lines_deleted: 3,
        authorStats: {
            alice: {
                github_id: 5,
                avatar_url: 'https://example.test/alice',
                commits: 2,
                lines_added: 10,
                lines_deleted: 2,
            },
            bob: {
                github_id: 3,
                avatar_url: 'https://example.test/bob',
                commits: 1,
                lines_added: 3,
                lines_deleted: 1,
            },
        },
    });
});

test('all-branch history returns zero stats for a repository without branches', async () => {
    const day = new Date(2026, 8, 2);
    const client = dispatchingClient({ branches: [], historiesByBranch: {} });

    const stats = await fetchAllBranchCommitsViaGraphQL('rustsbi', day, client, 'rustsbi');

    assert.deepEqual(stats, {
        new_commits: 0,
        lines_added: 0,
        lines_deleted: 0,
        authorStats: {},
    });
});

test('all-branch history fails closed on inaccessible repositories', async () => {
    const day = new Date(2026, 8, 2);
    const client = dispatchingClient({ branches: [], historiesByBranch: {}, repositoryMissing: true });

    await assert.rejects(
        fetchAllBranchCommitHistoryViaGraphQL('missing-repo', day, day, client, 'rustsbi'),
        /Repository missing-repo not found or inaccessible/
    );
});

test('branch listing paginates refs and propagates the owner', async () => {
    const calls = [];
    const client = async (query, variables) => {
        calls.push({ query, variables });
        if (variables.cursor === null) {
            return {
                repository: {
                    refs: {
                        pageInfo: { hasNextPage: true, endCursor: 'page-2' },
                        nodes: [{ name: 'main' }],
                    },
                },
            };
        }
        return {
            repository: {
                refs: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{ name: '0.4.2' }],
                },
            },
        };
    };

    const branchNames = await fetchBranchNamesViaGraphQL('rustsbi', client, 'rustsbi');

    assert.deepEqual(branchNames, ['main', '0.4.2']);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].variables.owner, 'rustsbi');
    assert.equal(calls[0].variables.repo, 'rustsbi');
});
