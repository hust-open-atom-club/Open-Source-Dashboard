/**
 * GraphQL Backfill Script
 * 
 * 使用 GraphQL API 高效回填历史数据。
 * 相比 REST API 可以提升约 100 倍性能。
 * 
 * 用法: node run_graphql_backfill.js [days]
 * 例如: node run_graphql_backfill.js 365
 */

require('dotenv').config();
const { Pool } = require('pg');
const Redis = require('redis');
const axios = require('axios');
const fs = require('fs/promises');
const path = require('path');

// --- Configuration ---
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ORG_NAME = 'hust-open-atom-club';
const PROGRESS_FILE = path.join(__dirname, 'backfill_progress.json');

// --- Optimized Concurrency Settings ---
const GRAPHQL_CONCURRENCY_LIMIT = 5;  // GraphQL requests (rate limited)
const COMMIT_CONCURRENCY_LIMIT = 5;   // Commit fetching (also GraphQL)
const BASE_DELAY_MS = 100;            // Base delay between requests (reduced from 500ms)

// --- Rate Limit Tracking ---
let rateLimitRemaining = 5000;
let rateLimitResetTime = null;

// --- Database Connection ---
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// --- Redis Connection ---
const redisClient = Redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});
redisClient.on('error', (err) => console.error('Redis Client Error', err));

// --- Utility Functions ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const formatDate = (date) => {
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
};

// --- GraphQL API with Adaptive Rate Limiting ---
async function githubGraphQL(query, variables = {}) {
    if (!GITHUB_TOKEN) {
        throw new Error("GITHUB_TOKEN is not set in environment variables.");
    }

    // Adaptive delay based on remaining rate limit
    let delayMs = BASE_DELAY_MS;
    if (rateLimitRemaining < 500) {
        // Very low - significantly slow down
        delayMs = 2000;
        console.warn(`[Rate Limit] Low remaining points (${rateLimitRemaining}), slowing down...`);
    } else if (rateLimitRemaining < 1000) {
        // Getting low - moderate slowdown
        delayMs = 500;
    } else if (rateLimitRemaining < 2000) {
        // Caution zone
        delayMs = 200;
    }

    await delay(delayMs);

    try {
        const response = await axios.post(
            'https://api.github.com/graphql',
            { query, variables },
            {
                timeout: 60000,
                headers: {
                    'Authorization': `Bearer ${GITHUB_TOKEN}`,
                    'Content-Type': 'application/json',
                }
            }
        );

        // Update rate limit tracking from response headers
        if (response.headers['x-ratelimit-remaining']) {
            rateLimitRemaining = parseInt(response.headers['x-ratelimit-remaining'], 10);
        }
        if (response.headers['x-ratelimit-reset']) {
            rateLimitResetTime = parseInt(response.headers['x-ratelimit-reset'], 10) * 1000;
        }

        if (response.data.errors) {
            const errorMessages = response.data.errors.map(e => e.message).join(', ');
            throw new Error(`GraphQL Error: ${errorMessages}`);
        }

        return response.data.data;
    } catch (error) {
        if (error.response && error.response.status === 403) {
            const resetTime = error.response.headers['x-ratelimit-reset'];
            if (resetTime) {
                const resetDate = new Date(parseInt(resetTime) * 1000);
                const waitTime = Math.max(0, resetDate.getTime() - Date.now() + 5000);
                console.warn(`[Rate Limit] Exceeded! Waiting ${Math.ceil(waitTime / 1000)} seconds until reset...`);
                rateLimitRemaining = 0;
                await delay(waitTime);
                rateLimitRemaining = 5000; // Reset after waiting
                return githubGraphQL(query, variables);
            }
        }
        throw error;
    }
}

// --- Fetch Repo Stats via GraphQL ---
async function fetchRepoStatsViaGraphQL(repoName, startDate, endDate) {
    const startDateStr = formatDate(startDate);
    const endDateStr = formatDate(endDate);

    console.log(`[GraphQL] Fetching ${repoName} stats from ${startDateStr} to ${endDateStr}...`);

    const statsMap = new Map();
    const contributorDetailsMap = new Map(); // 新增：保存每天的贡献者详情
    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
        const dateKey = formatDate(currentDate);
        statsMap.set(dateKey, {
            new_prs: 0,
            closed_merged_prs: 0,
            new_issues: 0,
            closed_issues: 0,
            active_contributors: new Set(),
        });
        contributorDetailsMap.set(dateKey, new Map()); // 每天的贡献者详情
        currentDate.setDate(currentDate.getDate() + 1);
    }

    const query = `
        query RepoStats($owner: String!, $repo: String!, $prCursor: String, $issueCursor: String) {
            repository(owner: $owner, name: $repo) {
                pullRequests(first: 100, after: $prCursor, orderBy: {field: CREATED_AT, direction: DESC}) {
                    totalCount
                    pageInfo { hasNextPage endCursor }
                    nodes {
                        createdAt
                        closedAt
                        mergedAt
                        state
                        author { 
                            login 
                            avatarUrl
                            ... on User {
                                databaseId
                            }
                        }
                    }
                }
                issues(first: 100, after: $issueCursor, orderBy: {field: CREATED_AT, direction: DESC}) {
                    totalCount
                    pageInfo { hasNextPage endCursor }
                    nodes {
                        createdAt
                        closedAt
                        state
                        author { 
                            login 
                            avatarUrl
                            ... on User {
                                databaseId
                            }
                        }
                    }
                }
            }
        }
    `;

    try {
        // Fetch PRs with pagination
        let prCursor = null;
        let prDone = false;
        let totalPrsFetched = 0;

        while (!prDone) {
            const data = await githubGraphQL(query, {
                owner: ORG_NAME,
                repo: repoName,
                prCursor: prCursor,
                issueCursor: null,
            });

            if (!data.repository) {
                console.warn(`[GraphQL] Repository ${repoName} not found or inaccessible.`);
                return statsMap;
            }

            const prs = data.repository.pullRequests;
            totalPrsFetched += prs.nodes.length;

            for (const pr of prs.nodes) {
                const createdDate = pr.createdAt ? pr.createdAt.split('T')[0] : null;
                const closedDate = pr.closedAt ? pr.closedAt.split('T')[0] : null;

                if (createdDate && createdDate >= startDateStr && createdDate <= endDateStr) {
                    if (statsMap.has(createdDate)) {
                        statsMap.get(createdDate).new_prs++;
                        if (pr.author?.login) {
                            const username = pr.author.login;
                            statsMap.get(createdDate).active_contributors.add(username);

                            // 保存贡献者详情
                            const dayContributors = contributorDetailsMap.get(createdDate);
                            if (!dayContributors.has(username)) {
                                dayContributors.set(username, {
                                    username,
                                    avatar_url: pr.author.avatarUrl || null,
                                    github_id: pr.author.databaseId || null,
                                    prs_opened: 0,
                                    prs_closed: 0,
                                    issues_opened: 0,
                                    issues_closed: 0
                                });
                            }
                            dayContributors.get(username).prs_opened++;
                        }
                    }
                }

                if (closedDate && closedDate >= startDateStr && closedDate <= endDateStr) {
                    if (statsMap.has(closedDate)) {
                        statsMap.get(closedDate).closed_merged_prs++;
                        if (pr.author?.login) {
                            const username = pr.author.login;

                            // 保存贡献者详情
                            const dayContributors = contributorDetailsMap.get(closedDate);
                            if (!dayContributors.has(username)) {
                                dayContributors.set(username, {
                                    username,
                                    avatar_url: pr.author.avatarUrl || null,
                                    github_id: pr.author.databaseId || null,
                                    prs_opened: 0,
                                    prs_closed: 0,
                                    issues_opened: 0,
                                    issues_closed: 0
                                });
                            }
                            dayContributors.get(username).prs_closed++;
                        }
                    }
                }

                if (createdDate && createdDate < startDateStr) {
                    prDone = true;
                    break;
                }
            }

            if (prs.pageInfo.hasNextPage && !prDone) {
                prCursor = prs.pageInfo.endCursor;
            } else {
                prDone = true;
            }
        }

        // Fetch Issues with pagination
        let issueCursor = null;
        let issueDone = false;
        let totalIssuesFetched = 0;

        while (!issueDone) {
            const data = await githubGraphQL(query, {
                owner: ORG_NAME,
                repo: repoName,
                prCursor: null,
                issueCursor: issueCursor,
            });

            const issues = data.repository.issues;
            totalIssuesFetched += issues.nodes.length;

            for (const issue of issues.nodes) {
                const createdDate = issue.createdAt ? issue.createdAt.split('T')[0] : null;
                const closedDate = issue.closedAt ? issue.closedAt.split('T')[0] : null;

                if (createdDate && createdDate >= startDateStr && createdDate <= endDateStr) {
                    if (statsMap.has(createdDate)) {
                        statsMap.get(createdDate).new_issues++;
                        if (issue.author?.login) {
                            const username = issue.author.login;
                            statsMap.get(createdDate).active_contributors.add(username);

                            // 保存贡献者详情
                            const dayContributors = contributorDetailsMap.get(createdDate);
                            if (!dayContributors.has(username)) {
                                dayContributors.set(username, {
                                    username,
                                    avatar_url: issue.author.avatarUrl || null,
                                    github_id: issue.author.databaseId || null,
                                    prs_opened: 0,
                                    prs_closed: 0,
                                    issues_opened: 0,
                                    issues_closed: 0
                                });
                            }
                            dayContributors.get(username).issues_opened++;
                        }
                    }
                }

                if (closedDate && closedDate >= startDateStr && closedDate <= endDateStr) {
                    if (statsMap.has(closedDate)) {
                        statsMap.get(closedDate).closed_issues++;
                        if (issue.author?.login) {
                            const username = issue.author.login;

                            // 保存贡献者详情
                            const dayContributors = contributorDetailsMap.get(closedDate);
                            if (!dayContributors.has(username)) {
                                dayContributors.set(username, {
                                    username,
                                    avatar_url: issue.author.avatarUrl || null,
                                    github_id: issue.author.databaseId || null,
                                    prs_opened: 0,
                                    prs_closed: 0,
                                    issues_opened: 0,
                                    issues_closed: 0
                                });
                            }
                            dayContributors.get(username).issues_closed++;
                        }
                    }
                }

                if (createdDate && createdDate < startDateStr) {
                    issueDone = true;
                    break;
                }
            }

            if (issues.pageInfo.hasNextPage && !issueDone) {
                issueCursor = issues.pageInfo.endCursor;
            } else {
                issueDone = true;
            }
        }

        console.log(`[GraphQL] ${repoName}: Fetched ${totalPrsFetched} PRs and ${totalIssuesFetched} Issues.`);

        // 返回统计数据和贡献者详情
        return { statsMap, contributorDetailsMap };

    } catch (error) {
        console.error(`[GraphQL] Error fetching stats for ${repoName}:`, error.message);
        return { statsMap, contributorDetailsMap };
    }
}

// --- Store Stats to Database ---
async function storeRepoApiStatsForDate(repoId, repoName, dateStr, stats, contributorDetails = []) {
    const apiMetrics = {
        new_prs: stats.new_prs || 0,
        closed_merged_prs: stats.closed_merged_prs || 0,
        new_issues: stats.new_issues || 0,
        closed_issues: stats.closed_issues || 0,
        active_contributors: stats.active_contributors instanceof Set ? stats.active_contributors.size : (stats.active_contributors || 0),
    };

    try {
        await pool.query(
            `INSERT INTO repo_snapshots (repo_id, snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (repo_id, snapshot_date) DO UPDATE
             SET new_prs = EXCLUDED.new_prs,
                 closed_merged_prs = EXCLUDED.closed_merged_prs,
                 new_issues = EXCLUDED.new_issues,
                 closed_issues = EXCLUDED.closed_issues,
                 active_contributors = EXCLUDED.active_contributors,
                 created_at = NOW()`,
            [repoId, dateStr, apiMetrics.new_prs, apiMetrics.closed_merged_prs, apiMetrics.new_issues, apiMetrics.closed_issues, apiMetrics.active_contributors]
        );

        // 保存贡献者详细信息
        if (contributorDetails.length > 0) {
            await storeContributorActivities(repoId, dateStr, contributorDetails);
        }
    } catch (error) {
        console.error(`[GraphQL] Error storing stats for ${repoName}@${dateStr}:`, error.message);
    }
}

// --- Store Contributor Activities ---
async function storeContributorActivities(repoId, dateStr, contributorDetails) {
    if (contributorDetails.length === 0) return;

    try {
        const orgResult = await pool.query("SELECT id FROM organizations WHERE name = $1", [ORG_NAME]);
        if (orgResult.rows.length === 0) {
            console.error('[Contributors] Organization not found');
            return;
        }
        const orgId = orgResult.rows[0].id;

        for (const contributor of contributorDetails) {
            try {
                // 1. 插入或更新贡献者基本信息
                const contributorResult = await pool.query(
                    `INSERT INTO contributors (github_username, github_id, avatar_url, first_seen_date, last_seen_date)
                     VALUES ($1, $2, $3, $4, $4)
                     ON CONFLICT (github_username) DO UPDATE
                     SET last_seen_date = GREATEST(contributors.last_seen_date, EXCLUDED.last_seen_date),
                         avatar_url = COALESCE(contributors.avatar_url, EXCLUDED.avatar_url),
                         github_id = COALESCE(contributors.github_id, EXCLUDED.github_id),
                         updated_at = NOW()
                     RETURNING id`,
                    [contributor.username, contributor.github_id, contributor.avatar_url, dateStr]
                );

                const contributorId = contributorResult.rows[0].id;

                // 2. 插入贡献者-仓库活动
                await pool.query(
                    `INSERT INTO contributor_repo_activities 
                     (contributor_id, repo_id, snapshot_date, prs_opened, prs_closed, issues_opened, issues_closed)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)
                     ON CONFLICT (contributor_id, repo_id, snapshot_date) DO UPDATE
                     SET prs_opened = EXCLUDED.prs_opened,
                         prs_closed = EXCLUDED.prs_closed,
                         issues_opened = EXCLUDED.issues_opened,
                         issues_closed = EXCLUDED.issues_closed`,
                    [contributorId, repoId, dateStr,
                        contributor.prs_opened, contributor.prs_closed,
                        contributor.issues_opened, contributor.issues_closed]
                );

                // 3. 更新贡献者每日活动（聚合到组织级别）
                await pool.query(
                    `INSERT INTO contributor_daily_activities 
                     (contributor_id, org_id, snapshot_date, prs_opened, prs_closed, issues_opened, issues_closed, active_repos_count)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
                     ON CONFLICT (contributor_id, org_id, snapshot_date) DO UPDATE
                     SET prs_opened = EXCLUDED.prs_opened,
                         prs_closed = EXCLUDED.prs_closed,
                         issues_opened = EXCLUDED.issues_opened,
                         issues_closed = EXCLUDED.issues_closed,
                         active_repos_count = EXCLUDED.active_repos_count`,
                    [contributorId, orgId, dateStr,
                        contributor.prs_opened, contributor.prs_closed,
                        contributor.issues_opened, contributor.issues_closed]
                );

            } catch (error) {
                console.error(`[Contributors] Error storing contributor ${contributor.username}:`, error.message);
            }
        }
    } catch (error) {
        console.error('[Contributors] Error in storeContributorActivities:', error.message);
    }
}

// --- GraphQL Commit Fetching (replaces git log) ---

/**
 * Fetch commits for a repository on a specific date using GraphQL API
 * Returns commit count, line stats, and per-author breakdown with proper GitHub usernames
 */
async function fetchCommitsViaGraphQL(repoName, targetDate) {
    const startDate = new Date(targetDate);
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date(targetDate);
    endDate.setDate(endDate.getDate() + 1);
    endDate.setHours(0, 0, 0, 0);

    // GitHub requires ISO 8601 format for timestamps
    const since = startDate.toISOString();
    const until = endDate.toISOString();

    const query = `
        query RepoCommits($owner: String!, $repo: String!, $since: GitTimestamp!, $until: GitTimestamp!, $cursor: String) {
            repository(owner: $owner, name: $repo) {
                defaultBranchRef {
                    target {
                        ... on Commit {
                            history(first: 100, since: $since, until: $until, after: $cursor) {
                                totalCount
                                pageInfo {
                                    hasNextPage
                                    endCursor
                                }
                                nodes {
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

    const result = {
        new_commits: 0,
        lines_added: 0,
        lines_deleted: 0,
        authorStats: {} // { username: { github_id, avatar_url, commits, lines_added, lines_deleted } }
    };

    try {
        let cursor = null;
        let hasNextPage = true;

        while (hasNextPage) {
            const data = await githubGraphQL(query, {
                owner: ORG_NAME,
                repo: repoName,
                since,
                until,
                cursor
            });

            const history = data?.repository?.defaultBranchRef?.target?.history;
            if (!history || !history.nodes) {
                break;
            }

            for (const commit of history.nodes) {
                result.new_commits++;
                result.lines_added += commit.additions || 0;
                result.lines_deleted += commit.deletions || 0;

                // Track per-author stats using GitHub username
                const user = commit.author?.user;
                if (user?.login) {
                    const username = user.login;
                    if (!result.authorStats[username]) {
                        result.authorStats[username] = {
                            github_id: user.databaseId,
                            avatar_url: user.avatarUrl,
                            commits: 0,
                            lines_added: 0,
                            lines_deleted: 0
                        };
                    }
                    result.authorStats[username].commits++;
                    result.authorStats[username].lines_added += commit.additions || 0;
                    result.authorStats[username].lines_deleted += commit.deletions || 0;
                }
            }

            hasNextPage = history.pageInfo?.hasNextPage || false;
            cursor = history.pageInfo?.endCursor || null;
        }
    } catch (error) {
        // Repository might not exist or have no commits
        if (!error.message?.includes('404')) {
            console.error(`[GraphQL] Error fetching commits for ${repoName}:`, error.message);
        }
    }

    return result;
}

/**
 * Fetch and store commit statistics for a repository (GraphQL-based)
 */
async function fetchAndStoreRepoCommitStats(repoId, repoName, targetDate) {
    const targetDateStr = formatDate(targetDate);

    // Fetch commit data via GraphQL
    const commitStats = await fetchCommitsViaGraphQL(repoName, targetDate);

    try {
        // Store repo-level commit stats
        await pool.query(
            `INSERT INTO repo_snapshots (repo_id, snapshot_date, new_commits, lines_added, lines_deleted)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (repo_id, snapshot_date) DO UPDATE
             SET new_commits = EXCLUDED.new_commits,
                 lines_added = EXCLUDED.lines_added,
                 lines_deleted = EXCLUDED.lines_deleted,
                 created_at = NOW()`,
            [repoId, targetDateStr, commitStats.new_commits, commitStats.lines_added, commitStats.lines_deleted]
        );

        // Store per-author commit stats (now with correct GitHub usernames!)
        if (Object.keys(commitStats.authorStats).length > 0) {
            // Get org_id from repo
            const repoResult = await pool.query('SELECT org_id FROM repositories WHERE id = $1', [repoId]);
            if (repoResult.rows.length === 0) return;
            const orgId = repoResult.rows[0].org_id;

            for (const [username, stats] of Object.entries(commitStats.authorStats)) {
                try {
                    // Find or create contributor
                    let contributorResult = await pool.query(
                        'SELECT id FROM contributors WHERE github_username = $1',
                        [username]
                    );

                    let contributorId;
                    if (contributorResult.rows.length === 0) {
                        // Create new contributor
                        const insertResult = await pool.query(
                            `INSERT INTO contributors (github_username, github_id, avatar_url, first_seen_date, last_seen_date)
                             VALUES ($1, $2, $3, $4, $4)
                             ON CONFLICT (github_username) DO UPDATE SET last_seen_date = $4
                             RETURNING id`,
                            [username, stats.github_id, stats.avatar_url, targetDateStr]
                        );
                        contributorId = insertResult.rows[0].id;
                    } else {
                        contributorId = contributorResult.rows[0].id;
                        // Update last_seen_date
                        await pool.query(
                            'UPDATE contributors SET last_seen_date = GREATEST(last_seen_date, $1) WHERE id = $2',
                            [targetDateStr, contributorId]
                        );
                    }

                    // Update contributor_daily_activities with commit data
                    await pool.query(
                        `INSERT INTO contributor_daily_activities 
                         (contributor_id, org_id, snapshot_date, commits_count, lines_added, lines_deleted)
                         VALUES ($1, $2, $3, $4, $5, $6)
                         ON CONFLICT (contributor_id, org_id, snapshot_date) DO UPDATE
                         SET commits_count = EXCLUDED.commits_count,
                             lines_added = EXCLUDED.lines_added,
                             lines_deleted = EXCLUDED.lines_deleted`,
                        [contributorId, orgId, targetDateStr, stats.commits, stats.lines_added, stats.lines_deleted]
                    );
                } catch (err) {
                    console.error(`[Commits] Error storing commit stats for ${username}:`, err.message);
                }
            }
        }
    } catch (error) {
        console.error(`[Commits] Error storing commit data for ${repoName}:`, error.message);
    }
}

// --- Aggregation Functions ---
async function aggregateSigSnapshot(sigId, targetDate) {
    const targetDateStr = formatDate(targetDate);

    const aggregateResult = await pool.query(
        `SELECT COALESCE(SUM(rs.new_prs), 0) as new_prs,
                COALESCE(SUM(rs.closed_merged_prs), 0) as closed_merged_prs,
                COALESCE(SUM(rs.new_issues), 0) as new_issues,
                COALESCE(SUM(rs.closed_issues), 0) as closed_issues,
                COALESCE(SUM(rs.active_contributors), 0) as active_contributors,
                COALESCE(SUM(rs.new_commits), 0) as new_commits,
                COALESCE(SUM(rs.lines_added), 0) as lines_added,
                COALESCE(SUM(rs.lines_deleted), 0) as lines_deleted
         FROM repo_snapshots rs
         JOIN repositories r ON rs.repo_id = r.id
         WHERE r.sig_id = $1 AND rs.snapshot_date = $2`,
        [sigId, targetDateStr]
    );

    const agg = aggregateResult.rows[0];

    await pool.query(
        `INSERT INTO sig_snapshots (sig_id, snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors, new_commits, lines_added, lines_deleted)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (sig_id, snapshot_date) DO UPDATE
         SET new_prs = EXCLUDED.new_prs,
             closed_merged_prs = EXCLUDED.closed_merged_prs,
             new_issues = EXCLUDED.new_issues,
             closed_issues = EXCLUDED.closed_issues,
             active_contributors = EXCLUDED.active_contributors,
             new_commits = EXCLUDED.new_commits,
             lines_added = EXCLUDED.lines_added,
             lines_deleted = EXCLUDED.lines_deleted,
             created_at = NOW()`,
        [sigId, targetDateStr,
            parseInt(agg.new_prs) || 0, parseInt(agg.closed_merged_prs) || 0,
            parseInt(agg.new_issues) || 0, parseInt(agg.closed_issues) || 0,
            parseInt(agg.active_contributors) || 0, parseInt(agg.new_commits) || 0,
            parseInt(agg.lines_added) || 0, parseInt(agg.lines_deleted) || 0]
    );
}

// --- Concurrency Helper ---
async function runPromisesWithConcurrency(tasks, concurrency) {
    const results = [];
    let currentIndex = 0;

    const worker = async () => {
        while (currentIndex < tasks.length) {
            const taskIndex = currentIndex++;
            const task = tasks[taskIndex];
            try {
                results[taskIndex] = await task();
            } catch (error) {
                results[taskIndex] = error;
                console.error(`Task at index ${taskIndex} failed:`, error.message);
            }
        }
    };

    const workers = Array(concurrency).fill(null).map(() => worker());
    await Promise.all(workers);

    return results;
}

// --- Progress Checkpoint Functions ---
async function loadProgress() {
    try {
        const data = await fs.readFile(PROGRESS_FILE, 'utf8');
        return JSON.parse(data);
    } catch {
        return { completedRepos: {}, gitCompleted: false, graphqlCompleted: false };
    }
}

async function saveProgress(progress) {
    await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

async function clearProgress() {
    try {
        await fs.unlink(PROGRESS_FILE);
    } catch {
        // File doesn't exist, that's fine
    }
}

// --- Progress Logging ---
function formatElapsedTime(startTime) {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const hours = Math.floor(elapsed / 3600);
    const minutes = Math.floor((elapsed % 3600) / 60);
    const seconds = elapsed % 60;
    if (hours > 0) {
        return `${hours}h ${minutes}m ${seconds}s`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
}


// --- Main Backfill Function (Optimized) ---
async function runGraphQLBackfill(days = 30) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`--- Starting Optimized GraphQL Backfill Job ---`);
    console.log(`--- Processing ${days} days of data ---`);
    console.log(`${'='.repeat(60)}\n`);

    const startTime = Date.now();
    let progress = await loadProgress();

    try {
        await redisClient.connect();

        const orgsResult = await pool.query("SELECT id FROM organizations WHERE name = $1", [ORG_NAME]);
        const org = orgsResult.rows[0];
        if (!org) {
            console.log('Monitored organization not found. Skipping backfill.');
            return;
        }

        const reposResult = await pool.query('SELECT id, name, sig_id FROM repositories WHERE org_id = $1', [org.id]);
        const repositories = reposResult.rows;

        if (repositories.length === 0) {
            console.log('No repositories configured to monitor. Skipping backfill.');
            return;
        }

        const sigsResult = await pool.query('SELECT id, name FROM special_interest_groups WHERE org_id = $1', [org.id]);
        const sigs = sigsResult.rows;

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const startDate = new Date(today);
        startDate.setDate(today.getDate() - days);

        const endDate = new Date(today);
        endDate.setDate(today.getDate() - 1);

        console.log(`📅 Date range: ${formatDate(startDate)} to ${formatDate(endDate)}`);
        console.log(`📦 Repositories: ${repositories.length}`);
        console.log(`🏷️  SIGs: ${sigs.length}`);
        console.log(`⚡ Commit Concurrency: ${COMMIT_CONCURRENCY_LIMIT}`);
        console.log(`⚡ GraphQL Concurrency: ${GRAPHQL_CONCURRENCY_LIMIT}`);
        console.log(`⏱️  Base delay: ${BASE_DELAY_MS}ms\n`);

        // Build list of all dates
        const allDates = [];
        for (let i = days; i >= 1; i--) {
            const targetDate = new Date(today);
            targetDate.setDate(today.getDate() - i);
            allDates.push(targetDate);
        }

        // === PHASE 1 & 2: Run Git and GraphQL in parallel ===
        console.log('=== PHASE 1 & 2: Git + GraphQL (Parallel) ===\n');

        // Build all Git tasks as a single pool (repo × date combinations)
        const gitTasks = [];
        let gitTasksSkipped = 0;
        for (const repo of repositories) {
            for (const targetDate of allDates) {
                const dateStr = formatDate(targetDate);
                const taskKey = `git:${repo.name}:${dateStr}`;
                if (progress.completedRepos[taskKey]) {
                    gitTasksSkipped++;
                    continue;
                }
                gitTasks.push(async () => {
                    await fetchAndStoreRepoCommitStats(repo.id, repo.name, targetDate);
                    progress.completedRepos[taskKey] = true;
                });
            }
        }

        // Build GraphQL tasks (one per repo, fetches entire date range)
        const graphqlTasks = [];
        let graphqlTasksSkipped = 0;
        for (const repo of repositories) {
            const taskKey = `graphql:${repo.name}`;
            if (progress.completedRepos[taskKey]) {
                graphqlTasksSkipped++;
                continue;
            }
            graphqlTasks.push(async () => {
                try {
                    const { statsMap, contributorDetailsMap } = await fetchRepoStatsViaGraphQL(repo.name, startDate, endDate);

                    for (const [dateStr, stats] of statsMap) {
                        const contributorDetails = contributorDetailsMap.has(dateStr)
                            ? Array.from(contributorDetailsMap.get(dateStr).values())
                            : [];
                        await storeRepoApiStatsForDate(repo.id, repo.name, dateStr, stats, contributorDetails);
                    }

                    progress.completedRepos[taskKey] = true;
                    await saveProgress(progress);
                    console.log(`[GraphQL] ${repo.name}: ✅ ${statsMap.size} days (${formatElapsedTime(startTime)}, Rate limit: ${rateLimitRemaining})`);
                } catch (error) {
                    console.error(`[GraphQL] ${repo.name}: ❌ ${error.message}`);
                }
            });
        }

        console.log(`📊 Git tasks: ${gitTasks.length} pending, ${gitTasksSkipped} skipped`);
        console.log(`📊 GraphQL tasks: ${graphqlTasks.length} pending, ${graphqlTasksSkipped} skipped\n`);

        // Run Git and GraphQL tasks in parallel
        const gitPromise = (async () => {
            if (gitTasks.length > 0) {
                console.log(`[Commits] Starting ${gitTasks.length} tasks with concurrency ${COMMIT_CONCURRENCY_LIMIT}...`);
                const batchSize = repositories.length * 10; // Save progress every 10 days of all repos
                for (let i = 0; i < gitTasks.length; i += batchSize) {
                    const batch = gitTasks.slice(i, i + batchSize);
                    await runPromisesWithConcurrency(batch, COMMIT_CONCURRENCY_LIMIT);
                    await saveProgress(progress);
                    const pct = Math.round(((i + batch.length) / gitTasks.length) * 100);
                    console.log(`[Git] Progress: ${pct}% (${formatElapsedTime(startTime)})`);
                }
                console.log(`[Git] ✅ Complete!`);
            }
        })();

        const graphqlPromise = (async () => {
            if (graphqlTasks.length > 0) {
                console.log(`[GraphQL] Starting ${graphqlTasks.length} repos with concurrency ${GRAPHQL_CONCURRENCY_LIMIT}...`);
                await runPromisesWithConcurrency(graphqlTasks, GRAPHQL_CONCURRENCY_LIMIT);
                console.log(`[GraphQL] ✅ Complete!`);
            }
        })();

        await Promise.all([gitPromise, graphqlPromise]);
        console.log('\n=== PHASE 1 & 2 Complete ===\n');

        // === PHASE 3: Aggregation ===
        console.log('=== PHASE 3: Data Aggregation ===\n');

        const aggregationBatchSize = 30; // Aggregate 30 days at a time for logging
        for (let batchStart = 0; batchStart < allDates.length; batchStart += aggregationBatchSize) {
            const batchEnd = Math.min(batchStart + aggregationBatchSize, allDates.length);

            for (let i = batchStart; i < batchEnd; i++) {
                const targetDate = allDates[i];
                const targetDateStr = formatDate(targetDate);

                for (const sig of sigs) {
                    await aggregateSigSnapshot(sig.id, targetDate);
                }

                const orgAggregationResult = await pool.query(
                    `SELECT COALESCE(SUM(ss.new_prs), 0) as new_prs,
                            COALESCE(SUM(ss.closed_merged_prs), 0) as closed_merged_prs,
                            COALESCE(SUM(ss.new_issues), 0) as new_issues,
                            COALESCE(SUM(ss.closed_issues), 0) as closed_issues,
                            COALESCE(SUM(ss.active_contributors), 0) as active_contributors,
                            COALESCE(SUM(ss.new_commits), 0) as new_commits,
                            COALESCE(SUM(ss.lines_added), 0) as lines_added,
                            COALESCE(SUM(ss.lines_deleted), 0) as lines_deleted
                     FROM sig_snapshots ss
                     JOIN special_interest_groups sig ON ss.sig_id = sig.id
                     WHERE sig.org_id = $1 AND ss.snapshot_date = $2`,
                    [org.id, targetDateStr]
                );

                const orgAgg = orgAggregationResult.rows[0];

                await pool.query(
                    `INSERT INTO activity_snapshots (org_id, snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors, new_repos, new_commits, lines_added, lines_deleted)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                     ON CONFLICT (org_id, snapshot_date) DO UPDATE
                     SET new_prs = EXCLUDED.new_prs,
                         closed_merged_prs = EXCLUDED.closed_merged_prs,
                         new_issues = EXCLUDED.new_issues,
                         closed_issues = EXCLUDED.closed_issues,
                         active_contributors = EXCLUDED.active_contributors,
                         new_repos = EXCLUDED.new_repos,
                         new_commits = EXCLUDED.new_commits,
                         lines_added = EXCLUDED.lines_added,
                         lines_deleted = EXCLUDED.lines_deleted,
                         created_at = NOW()`,
                    [org.id, targetDateStr,
                    parseInt(orgAgg.new_prs) || 0, parseInt(orgAgg.closed_merged_prs) || 0,
                    parseInt(orgAgg.new_issues) || 0, parseInt(orgAgg.closed_issues) || 0,
                    parseInt(orgAgg.active_contributors) || 0, 0,
                    parseInt(orgAgg.new_commits) || 0, parseInt(orgAgg.lines_added) || 0,
                    parseInt(orgAgg.lines_deleted) || 0]
                );
            }

            const pct = Math.round((batchEnd / allDates.length) * 100);
            console.log(`[Aggregation] Progress: ${pct}% (${formatElapsedTime(startTime)})`);
        }

        console.log('=== PHASE 3 Complete ===\n');

        // Clear cache
        console.log('--- Clearing Redis Cache ---');
        await redisClient.flushAll();
        console.log('✅ Redis cache cleared.');

        // Display contributor statistics
        console.log('\n=== Contributor Statistics ===');
        try {
            const contributorStatsResult = await pool.query(`
                SELECT 
                    COUNT(DISTINCT c.id) as total_contributors,
                    COUNT(DISTINCT CASE WHEN c.first_seen_date >= $1 THEN c.id END) as new_contributors,
                    COUNT(DISTINCT cda.snapshot_date) as days_with_activity,
                    SUM(cda.prs_opened + cda.prs_closed + cda.issues_opened + cda.issues_closed) as total_activities
                FROM contributors c
                LEFT JOIN contributor_daily_activities cda ON c.id = cda.contributor_id AND cda.snapshot_date >= $1
            `, [formatDate(startDate)]);

            const cStats = contributorStatsResult.rows[0];
            console.log(`  - 总贡献者数: ${cStats.total_contributors || 0}`);
            console.log(`  - 新贡献者: ${cStats.new_contributors || 0}`);
            console.log(`  - 有活动的天数: ${cStats.days_with_activity || 0}`);
            console.log(`  - 总活动数: ${cStats.total_activities || 0}`);
        } catch (error) {
            console.log('  - (贡献者统计不可用，可能需要先创建表)');
        }
        console.log('='.repeat(30) + '\n');

        // Clear progress file on success
        await clearProgress();

        console.log(`\n${'='.repeat(60)}`);
        console.log(`--- GraphQL Backfill Job Finished Successfully ---`);
        console.log(`⏱️  Total time: ${formatElapsedTime(startTime)}`);
        console.log(`${'='.repeat(60)}\n`);

    } catch (error) {
        console.error('GraphQL Backfill Job Failed:', error.message);
        console.error(error.stack);
        console.log('Progress saved. Run again to resume.');
    } finally {
        await pool.end();
        await redisClient.quit();
    }
}

// --- Run ---
const days = parseInt(process.argv[2], 10) || 730;
runGraphQLBackfill(days);
