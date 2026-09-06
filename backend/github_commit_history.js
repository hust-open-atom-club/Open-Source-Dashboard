const axios = require('axios');
const { isBotContributor } = require('./contributor_filters');
const {
    MAX_RATE_LIMIT_RETRIES,
    getPrimaryRateLimitWaitMs,
} = require('./github_rate_limit');

const DEFAULT_ORG_NAME = 'hust-open-atom-club';
const GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeDate(date) {
    const normalized = new Date(date);
    normalized.setHours(0, 0, 0, 0);
    return normalized;
}

function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function createEmptyCommitStats() {
    return {
        new_commits: 0,
        lines_added: 0,
        lines_deleted: 0,
        authorStats: {},
    };
}

function validateDateRange(startDate, endDate) {
    const normalizedStartDate = normalizeDate(startDate);
    const normalizedEndDate = normalizeDate(endDate);

    if (Number.isNaN(normalizedStartDate.getTime()) || Number.isNaN(normalizedEndDate.getTime())) {
        throw new Error('startDate and endDate must be valid dates.');
    }

    if (normalizedStartDate > normalizedEndDate) {
        throw new Error('startDate cannot be later than endDate.');
    }

    return { normalizedStartDate, normalizedEndDate };
}

function buildDailyStatsMap(normalizedStartDate, normalizedEndDate) {
    const statsMap = new Map();
    const currentDate = new Date(normalizedStartDate);
    while (currentDate <= normalizedEndDate) {
        statsMap.set(formatDate(currentDate), createEmptyCommitStats());
        currentDate.setDate(currentDate.getDate() + 1);
    }
    return statsMap;
}

function applyCommitToStats(result, commit) {
    // Match `git log --numstat`: merge commits still count as commits,
    // but their combined diff must not duplicate changes already
    // attributed to the commits merged into the target branch.
    const isMergeCommit = commit.parents?.totalCount > 1;
    const additions = isMergeCommit ? 0 : (commit.additions || 0);
    const deletions = isMergeCommit ? 0 : (commit.deletions || 0);
    result.new_commits++;
    result.lines_added += additions;
    result.lines_deleted += deletions;

    const user = commit.author?.user;
    if (!user?.login || isBotContributor(user.login)) {
        return;
    }

    if (!result.authorStats[user.login]) {
        result.authorStats[user.login] = {
            github_id: user.databaseId,
            avatar_url: user.avatarUrl,
            commits: 0,
            lines_added: 0,
            lines_deleted: 0,
        };
    }

    result.authorStats[user.login].commits++;
    result.authorStats[user.login].lines_added += additions;
    result.authorStats[user.login].lines_deleted += deletions;
}

function recordHistoryNode(statsMap, commit, repoName, seenOids = null) {
    if (seenOids !== null) {
        if (!commit.oid) {
            throw new Error(`Repository ${repoName} returned a commit without an oid.`);
        }
        // The same commit can be reachable from several branches; every
        // unique commit is only counted once across the whole walk.
        if (seenOids.has(commit.oid)) {
            return;
        }
        seenOids.add(commit.oid);
    }

    const commitDate = new Date(commit.committedDate);
    if (Number.isNaN(commitDate.getTime())) {
        throw new Error(`Repository ${repoName} returned a commit without a valid committedDate.`);
    }
    const dateKey = formatDate(commitDate);
    const result = statsMap.get(dateKey);
    if (!result) {
        return;
    }

    applyCommitToStats(result, commit);
}

async function defaultGraphQLClient(query, variables = {}, options = {}) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        throw new Error('GITHUB_TOKEN is not set in environment variables.');
    }

    const request = options.request || axios.post;
    const sleep = options.delay || delay;

    for (let retryCount = 0; ; retryCount++) {
        try {
            const response = await request(
                GRAPHQL_ENDPOINT,
                { query, variables },
                {
                    timeout: 60000,
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                    },
                }
            );

            if (response.data.errors) {
                const errorMessages = response.data.errors.map((error) => error.message).join(', ');
                throw new Error(`GraphQL Error: ${errorMessages}`);
            }

            return response.data.data;
        } catch (error) {
            const waitTime = getPrimaryRateLimitWaitMs(error);
            if (waitTime !== null && retryCount < MAX_RATE_LIMIT_RETRIES) {
                console.warn(`[GraphQL Commits] Primary rate limit exhausted. Waiting ${Math.ceil(waitTime / 1000)} seconds...`);
                await sleep(waitTime);
                continue;
            }

            throw error;
        }
    }
}

/**
 * Fetch commit history from a repository's default branch for a local calendar-date range.
 * The injected client keeps this function deterministic in tests and lets callers share
 * their existing GraphQL rate-limit handling.
 */
async function fetchCommitHistoryViaGraphQL(
    repoName,
    startDate,
    endDate,
    graphQLClient = defaultGraphQLClient,
    orgName = DEFAULT_ORG_NAME
) {
    const { normalizedStartDate, normalizedEndDate } = validateDateRange(startDate, endDate);

    const endExclusive = new Date(normalizedEndDate);
    endExclusive.setDate(endExclusive.getDate() + 1);

    const statsMap = buildDailyStatsMap(normalizedStartDate, normalizedEndDate);

    const query = `
        query RepoCommits($owner: String!, $repo: String!, $since: GitTimestamp!, $until: GitTimestamp!, $cursor: String) {
            repository(owner: $owner, name: $repo) {
                defaultBranchRef {
                    target {
                        ... on Commit {
                            history(first: 100, since: $since, until: $until, after: $cursor) {
                                pageInfo {
                                    hasNextPage
                                    endCursor
                                }
                                nodes {
                                    committedDate
                                    author {
                                        user {
                                            login
                                            databaseId
                                            avatarUrl
                                        }
                                    }
                                    additions
                                    deletions
                                    parents {
                                        totalCount
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    `;

    try {
        let cursor = null;
        let hasNextPage = true;

        while (hasNextPage) {
            const data = await graphQLClient(query, {
                owner: orgName,
                repo: repoName,
                since: normalizedStartDate.toISOString(),
                until: endExclusive.toISOString(),
                cursor,
            });

            if (!data?.repository) {
                throw new Error(`Repository ${repoName} not found or inaccessible.`);
            }

            if (!data.repository.defaultBranchRef) {
                break;
            }

            const history = data.repository.defaultBranchRef.target?.history;
            if (!history?.nodes) {
                throw new Error(`Repository ${repoName} default branch did not return commit history.`);
            }

            for (const commit of history.nodes) {
                recordHistoryNode(statsMap, commit, repoName);
            }

            hasNextPage = history.pageInfo?.hasNextPage || false;
            cursor = history.pageInfo?.endCursor || null;
        }
    } catch (error) {
        throw new Error(`[GraphQL] Failed to fetch commits for ${repoName}: ${error.message}`, { cause: error });
    }

    return statsMap;
}

/**
 * List every live branch (refs/heads/*) of a repository.
 */
async function fetchBranchNamesViaGraphQL(
    repoName,
    graphQLClient = defaultGraphQLClient,
    orgName = DEFAULT_ORG_NAME
) {
    const query = `
        query RepoBranches($owner: String!, $repo: String!, $cursor: String) {
            repository(owner: $owner, name: $repo) {
                refs(refPrefix: "refs/heads/", first: 100, after: $cursor) {
                    pageInfo {
                        hasNextPage
                        endCursor
                    }
                    nodes {
                        name
                    }
                }
            }
        }
    `;

    const branchNames = [];
    let cursor = null;
    let hasNextPage = true;

    while (hasNextPage) {
        const data = await graphQLClient(query, { owner: orgName, repo: repoName, cursor });

        if (!data?.repository) {
            throw new Error(`Repository ${repoName} not found or inaccessible.`);
        }

        const refs = data.repository.refs;
        if (!refs?.nodes) {
            throw new Error(`Repository ${repoName} did not return a branch list.`);
        }

        for (const ref of refs.nodes) {
            branchNames.push(ref.name);
        }

        hasNextPage = refs.pageInfo?.hasNextPage || false;
        cursor = refs.pageInfo?.endCursor || null;
    }

    return branchNames;
}

/**
 * Fetch commit history across ALL live branches of a repository for a local
 * calendar-date range. The same commit (identical oid) reachable from several
 * branches is counted exactly once; merge commits keep the `git log --numstat`
 * semantics shared with the default-branch pipeline.
 */
async function fetchAllBranchCommitHistoryViaGraphQL(
    repoName,
    startDate,
    endDate,
    graphQLClient = defaultGraphQLClient,
    orgName = DEFAULT_ORG_NAME
) {
    const { normalizedStartDate, normalizedEndDate } = validateDateRange(startDate, endDate);

    const endExclusive = new Date(normalizedEndDate);
    endExclusive.setDate(endExclusive.getDate() + 1);

    const statsMap = buildDailyStatsMap(normalizedStartDate, normalizedEndDate);
    const seenOids = new Set();

    const branchNames = await fetchBranchNamesViaGraphQL(repoName, graphQLClient, orgName);

    const query = `
        query RefCommits($owner: String!, $repo: String!, $ref: String!, $since: GitTimestamp!, $until: GitTimestamp!, $cursor: String) {
            repository(owner: $owner, name: $repo) {
                ref(qualifiedName: $ref) {
                    target {
                        ... on Commit {
                            history(first: 100, since: $since, until: $until, after: $cursor) {
                                pageInfo {
                                    hasNextPage
                                    endCursor
                                }
                                nodes {
                                    oid
                                    committedDate
                                    author {
                                        user {
                                            login
                                            databaseId
                                            avatarUrl
                                        }
                                    }
                                    additions
                                    deletions
                                    parents {
                                        totalCount
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    `;

    try {
        for (const branchName of branchNames) {
            let cursor = null;
            let hasNextPage = true;

            while (hasNextPage) {
                const data = await graphQLClient(query, {
                    owner: orgName,
                    repo: repoName,
                    ref: `refs/heads/${branchName}`,
                    since: normalizedStartDate.toISOString(),
                    until: endExclusive.toISOString(),
                    cursor,
                });

                if (!data?.repository) {
                    throw new Error(`Repository ${repoName} not found or inaccessible.`);
                }

                // The branch may have been deleted between listing refs and
                // walking its history; nothing left to count for it.
                const ref = data.repository.ref;
                if (!ref) {
                    break;
                }

                const history = ref.target?.history;
                if (!history?.nodes) {
                    throw new Error(`Repository ${repoName} branch ${branchName} did not return commit history.`);
                }

                for (const commit of history.nodes) {
                    recordHistoryNode(statsMap, commit, repoName, seenOids);
                }

                hasNextPage = history.pageInfo?.hasNextPage || false;
                cursor = history.pageInfo?.endCursor || null;
            }
        }
    } catch (error) {
        throw new Error(`[GraphQL] Failed to fetch all-branch commits for ${repoName}: ${error.message}`, { cause: error });
    }

    return statsMap;
}

async function fetchCommitsViaGraphQL(
    repoName,
    targetDate,
    graphQLClient = defaultGraphQLClient,
    orgName = DEFAULT_ORG_NAME
) {
    const normalizedTargetDate = normalizeDate(targetDate);
    const statsMap = await fetchCommitHistoryViaGraphQL(
        repoName,
        normalizedTargetDate,
        normalizedTargetDate,
        graphQLClient,
        orgName
    );
    return statsMap.get(formatDate(normalizedTargetDate));
}

async function fetchAllBranchCommitsViaGraphQL(
    repoName,
    targetDate,
    graphQLClient = defaultGraphQLClient,
    orgName = DEFAULT_ORG_NAME
) {
    const normalizedTargetDate = normalizeDate(targetDate);
    const statsMap = await fetchAllBranchCommitHistoryViaGraphQL(
        repoName,
        normalizedTargetDate,
        normalizedTargetDate,
        graphQLClient,
        orgName
    );
    return statsMap.get(formatDate(normalizedTargetDate));
}

module.exports = {
    defaultGraphQLClient,
    fetchCommitHistoryViaGraphQL,
    fetchCommitsViaGraphQL,
    fetchBranchNamesViaGraphQL,
    fetchAllBranchCommitHistoryViaGraphQL,
    fetchAllBranchCommitsViaGraphQL,
};
