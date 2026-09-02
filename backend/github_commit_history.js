const axios = require('axios');
const { isBotContributor } = require('./contributor_filters');

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

async function defaultGraphQLClient(query, variables = {}) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        throw new Error('GITHUB_TOKEN is not set in environment variables.');
    }

    try {
        const response = await axios.post(
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
        if (error.response?.status === 403) {
            const resetTime = Number.parseInt(error.response.headers['x-ratelimit-reset'], 10);
            if (Number.isFinite(resetTime)) {
                const waitTime = Math.max(0, resetTime * 1000 - Date.now() + 5000);
                console.warn(`[GraphQL Commits] Rate limit exceeded. Waiting ${Math.ceil(waitTime / 1000)} seconds...`);
                await delay(waitTime);
                return defaultGraphQLClient(query, variables);
            }
        }

        throw error;
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
    const normalizedStartDate = normalizeDate(startDate);
    const normalizedEndDate = normalizeDate(endDate);

    if (Number.isNaN(normalizedStartDate.getTime()) || Number.isNaN(normalizedEndDate.getTime())) {
        throw new Error('startDate and endDate must be valid dates.');
    }

    if (normalizedStartDate > normalizedEndDate) {
        throw new Error('startDate cannot be later than endDate.');
    }

    const endExclusive = new Date(normalizedEndDate);
    endExclusive.setDate(endExclusive.getDate() + 1);

    const statsMap = new Map();
    const currentDate = new Date(normalizedStartDate);
    while (currentDate <= normalizedEndDate) {
        statsMap.set(formatDate(currentDate), createEmptyCommitStats());
        currentDate.setDate(currentDate.getDate() + 1);
    }

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
                const commitDate = new Date(commit.committedDate);
                if (Number.isNaN(commitDate.getTime())) {
                    throw new Error(`Repository ${repoName} returned a commit without a valid committedDate.`);
                }

                const dateKey = formatDate(commitDate);
                const result = statsMap.get(dateKey);
                if (!result) {
                    continue;
                }

                const additions = commit.additions || 0;
                const deletions = commit.deletions || 0;
                result.new_commits++;
                result.lines_added += additions;
                result.lines_deleted += deletions;

                const user = commit.author?.user;
                if (!user?.login || isBotContributor(user.login)) {
                    continue;
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

            hasNextPage = history.pageInfo?.hasNextPage || false;
            cursor = history.pageInfo?.endCursor || null;
        }
    } catch (error) {
        throw new Error(`[GraphQL] Failed to fetch commits for ${repoName}: ${error.message}`, { cause: error });
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

module.exports = {
    defaultGraphQLClient,
    fetchCommitHistoryViaGraphQL,
    fetchCommitsViaGraphQL,
};
