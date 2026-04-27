const fs = require('fs/promises');

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const Redis = require('redis');
const cron = require('node-cron');
const axios = require('axios');
const path = require('path');
const { Parser } = require('json2csv');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const {
    cloneOrPullRepoSecure,
    redactSecrets,
    runGit,
} = require('./git_secure');
const {
    isBotContributor,
    filterBotContributors,
    buildHumanContributorSqlCondition,
} = require('./contributor_filters');

const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_API_BASE = 'https://api.github.com';
const REPO_STORAGE_PATH = path.join(__dirname, '..', 'repos');
const ORG_NAME = 'hust-open-atom-club';
const HUMAN_CONTRIBUTOR_SQL = buildHumanContributorSqlCondition('c.github_username');
const isEnvEnabled = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
const ENABLE_STARTUP_CACHE_FLUSH = isEnvEnabled(process.env.ENABLE_STARTUP_CACHE_FLUSH);
const ENABLE_STARTUP_BACKFILL = isEnvEnabled(process.env.ENABLE_STARTUP_BACKFILL);
const parsedStartupBackfillDays = parseInt(process.env.STARTUP_BACKFILL_DAYS || '30', 10);
const STARTUP_BACKFILL_DAYS = Number.isInteger(parsedStartupBackfillDays) && parsedStartupBackfillDays > 0
    ? parsedStartupBackfillDays
    : 30;

// --- Utility Functions ---

/**
 * Introduces a delay to prevent hitting API rate limits.
 * @param {number} ms Milliseconds to wait.
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Formats a Date object to YYYY-MM-DD string.
 * @param {Date} date 
 */
const formatDate = (date) => {
    // getFullYear(), getMonth(), getDate() all return values based on the local timezone.
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0'); // getMonth() is 0-indexed
    const day = date.getDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
};

/**
 * Parse range parameter and return startDateStr
 * Supports: '7d', '30d', '90d', '180d', '365d', 'all'
 * @param {string} range 
 * @returns {{ startDateStr: string, days: number|null }}
 */
const parseRange = (range) => {
    if (range === 'all') {
        return { startDateStr: '2000-01-01', days: null };
    }

    let days = 30; // default
    if (range && range.endsWith('d')) {
        days = parseInt(range.slice(0, -1), 10) || 30;
    }

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    return { startDateStr: formatDate(startDate), days };
};

// --- Database (PostgreSQL) Configuration ---
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

pool.on('error', (err, client) => {
    console.error('Unexpected error on idle client', err);
    process.exit(-1);
});

// --- Cache (Redis) Configuration ---
const redisClient = Redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));

async function connectRedis() {
    try {
        await redisClient.connect();
        console.log('Redis connected successfully.');
    } catch (e) {
        console.error('Failed to connect to Redis:', e.message);
    }
}

connectRedis();

async function retryWithBackoff(fn, retries = 3, delayMs = 1000) {
    let lastError;
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            console.warn(`Attempt ${i + 1} failed. Retrying in ${delayMs / 1000}s... Error: ${error.message}`);
            await delay(delayMs);
            delayMs *= 2; // Exponential backoff
        }
    }
    throw lastError;
}

// --- Middleware ---
app.use(express.json());
// Allow CORS from any origin for external access
app.use(require('cors')());

// --- GitHub API Utility ---

/**
 * Executes a REST API call against the GitHub API with a delay.
 */
async function githubRest(endpoint, params = {}) {
    if (!GITHUB_TOKEN) {
        throw new Error("GITHUB_TOKEN is not set in environment variables.");
    }

    let allItems = [];
    let nextUrl = `${GITHUB_API_BASE}${endpoint}`;
    let isFirstPage = true;
    let totalCountFromApi = 0; // <-- 新增变量，用于存储真实的total_count

    while (nextUrl) {
        // 对于Search API，每分钟30次，每次请求之间间隔2秒足够（留出安全余量）
        await delay(2000);

        try {
            const response = await axios.get(nextUrl, {
                timeout: 30000,
                params: isFirstPage ? params : {},
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                }
            });

            // 如果是第一页，并且是Search API的返回结构，就记录下total_count
            if (isFirstPage && response.data.total_count !== undefined) {
                totalCountFromApi = response.data.total_count;
            }

            if (Array.isArray(response.data.items)) {
                allItems = allItems.concat(response.data.items);
            } else if (Array.isArray(response.data)) {
                allItems = allItems.concat(response.data);
                if (isFirstPage) totalCountFromApi = allItems.length; // 对于非search API，total_count就是数组长度
            }

            const linkHeader = response.headers.link;
            nextUrl = null;
            if (linkHeader) {
                const nextLink = linkHeader.split(',').find(s => s.includes('rel="next"'));
                if (nextLink) {
                    nextUrl = nextLink.match(/<(.+)>/)[1];
                }
            }
            isFirstPage = false;

        } catch (error) {
            if (error.response && error.response.status === 403) {
                // 处理Rate Limit错误
                const resetTime = error.response.headers['x-ratelimit-reset'];
                const remaining = error.response.headers['x-ratelimit-remaining'];

                if (resetTime) {
                    const resetDate = new Date(parseInt(resetTime) * 1000);
                    const now = new Date();
                    const waitTime = Math.max(0, resetDate.getTime() - now.getTime() + 5000); // 额外等待5秒
                    const waitSeconds = Math.ceil(waitTime / 1000);

                    console.warn(`Rate limit exceeded. Remaining: ${remaining || 0}. Waiting ${waitSeconds} seconds until ${resetDate.toISOString()}...`);
                    await delay(waitTime);

                    // 重试当前请求
                    console.log(`Retrying request to ${nextUrl}...`);
                    continue; // 重新执行当前循环
                } else {
                    // 如果没有reset时间，等待60秒后重试
                    console.warn(`Rate limit exceeded (no reset time). Waiting 60 seconds...`);
                    await delay(60000);
                    console.log(`Retrying request to ${nextUrl}...`);
                    continue; // 重新执行当前循环
                }
            }

            // 其他错误直接抛出
            console.error(`GitHub REST API Error on ${nextUrl}:`, error.response ? error.response.data : error.message);
            throw new Error(`GitHub API request failed for ${nextUrl}: ${error.message}`);
        }
    }

    // 返回一个与原始Search API结构相似的对象，方便后续处理
    return {
        total_count: totalCountFromApi,
        items: allItems
    };
}

// --- GitHub GraphQL API Utility ---

/**
 * Executes a GraphQL query against the GitHub API.
 * @param {string} query The GraphQL query string.
 * @param {object} variables Variables for the query.
 * @returns {Promise<object>} The data portion of the response.
 */
async function githubGraphQL(query, variables = {}) {
    if (!GITHUB_TOKEN) {
        throw new Error("GITHUB_TOKEN is not set in environment variables.");
    }

    // GraphQL API 限制: 5000 点/小时，比 REST API 更宽松
    // 但仍需要小延迟以避免突发请求
    await delay(500);

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

        if (response.data.errors) {
            const errorMessages = response.data.errors.map(e => e.message).join(', ');
            throw new Error(`GraphQL Error: ${errorMessages}`);
        }

        return response.data.data;
    } catch (error) {
        if (error.response && error.response.status === 403) {
            // Rate limit handling
            const resetTime = error.response.headers['x-ratelimit-reset'];
            if (resetTime) {
                const resetDate = new Date(parseInt(resetTime) * 1000);
                const waitTime = Math.max(0, resetDate.getTime() - Date.now() + 5000);
                console.warn(`GraphQL Rate limit exceeded. Waiting ${Math.ceil(waitTime / 1000)} seconds...`);
                await delay(waitTime);
                return githubGraphQL(query, variables); // Retry
            }
        }
        throw error;
    }
}

/**
 * Fetches all PRs and Issues for a repository via GraphQL, then aggregates by date.
 * This is MUCH more efficient than REST API for historical backfill.
 * @param {string} repoName Repository name
 * @param {Date} startDate Start of date range
 * @param {Date} endDate End of date range
 * @returns {Promise<Map<string, object>>} Map of date string -> stats
 */
async function fetchRepoStatsViaGraphQL(repoName, startDate, endDate) {
    const startDateStr = formatDate(startDate);
    const endDateStr = formatDate(endDate);

    console.log(`[GraphQL] Fetching ${repoName} stats from ${startDateStr} to ${endDateStr}...`);

    // Initialize result map with all dates in range
    const statsMap = new Map();
    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
        statsMap.set(formatDate(currentDate), {
            new_prs: 0,
            closed_merged_prs: 0,
            new_issues: 0,
            closed_issues: 0,
            active_contributors: new Set(),
        });
        currentDate.setDate(currentDate.getDate() + 1);
    }

    // GraphQL query to fetch PRs and Issues
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
                        author { login }
                    }
                }
                issues(first: 100, after: $issueCursor, orderBy: {field: CREATED_AT, direction: DESC}) {
                    totalCount
                    pageInfo { hasNextPage endCursor }
                    nodes {
                        createdAt
                        closedAt
                        state
                        author { login }
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

                // Check if PR is within our date range
                if (createdDate && createdDate >= startDateStr && createdDate <= endDateStr) {
                    if (statsMap.has(createdDate)) {
                        statsMap.get(createdDate).new_prs++;
                        if (pr.author?.login && !isBotContributor(pr.author.login)) {
                            statsMap.get(createdDate).active_contributors.add(pr.author.login);
                        }
                    }
                }

                if (closedDate && closedDate >= startDateStr && closedDate <= endDateStr) {
                    if (statsMap.has(closedDate)) {
                        statsMap.get(closedDate).closed_merged_prs++;
                    }
                }

                // Early exit: if we've gone past our date range
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
                        if (issue.author?.login && !isBotContributor(issue.author.login)) {
                            statsMap.get(createdDate).active_contributors.add(issue.author.login);
                        }
                    }
                }

                if (closedDate && closedDate >= startDateStr && closedDate <= endDateStr) {
                    if (statsMap.has(closedDate)) {
                        statsMap.get(closedDate).closed_issues++;
                    }
                }

                // Early exit
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

        console.log(`[GraphQL] ${repoName}: Fetched ${totalPrsFetched} PRs for ${totalIssuesFetched} Issues.`);
        return statsMap;

    } catch (error) {
        console.error(`[GraphQL] Error fetching stats for ${repoName}:`, error.message);
        return statsMap;
    }
}

/**
 * Stores the GraphQL-fetched stats for a single date to the database.
 * @param {number} repoId Repository ID in database
 * @param {string} repoName Repository name (for logging)
 * @param {string} dateStr Date string (YYYY-MM-DD)
 * @param {object} stats Stats object with new_prs, closed_merged_prs, etc.
 */
async function storeRepoApiStatsForDate(repoId, repoName, dateStr, stats) {
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
    } catch (error) {
        console.error(`[GraphQL] Error storing stats for ${repoName}@${dateStr}:`, error.message);
    }
}

// --- Git Commit Statistics Service ---

/**
 * Clones or pulls a repository and returns the path.
 */
async function cloneOrPullRepo(repoName) {
    const repoPath = path.join(REPO_STORAGE_PATH, repoName);

    try {
        return await cloneOrPullRepoSecure({
            repoName,
            repoStoragePath: REPO_STORAGE_PATH,
            orgName: ORG_NAME,
        });
    } catch (error) {
        console.error(`${repoName}: operate failed\n${redactSecrets(error.message)}`);
        // 确保目录存在，即使 git 操作失败
        await fs.mkdir(repoPath, { recursive: true }).catch(() => { });
        return repoPath;
    }
}

/**
 * Gets commit stats for a repository within a 24-hour window using git log.
 */
async function getCommitStats(repoName, targetDate) {
    const repoPath = await cloneOrPullRepo(repoName);

    const startDate = new Date(targetDate);
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date(targetDate);
    endDate.setDate(endDate.getDate() + 1);
    endDate.setHours(0, 0, 0, 0);

    // 使用我们之前修复过的、时区正确的 formatDate 函数
    const endISO = formatDate(endDate);
    const startISO = formatDate(startDate);

    try {
        const { stdout } = await runGit([
            '-C',
            repoPath,
            'log',
            `--since=${startISO}`,
            `--until=${endISO}`,
            '--pretty=format:COMMIT_SEPARATOR%an',
            '--numstat',
        ], { maxBuffer: 1024 * 1024 * 10 });
        if (!stdout.trim()) {
            return { new_commits: 0, lines_added: 0, lines_deleted: 0, committers: new Set() };
        }

        const lines = stdout.trim().split('\n');

        let newCommits = 0;
        let linesAdded = 0;
        let linesDeleted = 0;
        const committers = new Set();

        // --- BUG FIX: 使用更健壮的解析逻辑 ---
        for (const line of lines) {
            if (line.startsWith('COMMIT_SEPARATOR')) {
                // 这是一个新的 commit，我们提取作者名
                newCommits++;
                const author = line.substring('COMMIT_SEPARATOR'.length).trim();
                if (author) {
                    committers.add(author);
                }
            } else {
                // 这是一个潜在的 numstat 行，我们需要严格验证它
                const parts = line.split('\t');

                // 验证：必须有3个部分，且前两个部分必须是数字或'-'
                if (parts.length === 3) {
                    const isInsertionsValid = !isNaN(parseInt(parts[0], 10)) || parts[0] === '-';
                    const isDeletionsValid = !isNaN(parseInt(parts[1], 10)) || parts[1] === '-';

                    if (isInsertionsValid && isDeletionsValid) {
                        // 确认这是一个合法的 numstat 行，再进行解析
                        const insertions = parseInt(parts[0], 10);
                        const deletions = parseInt(parts[1], 10);

                        if (!isNaN(insertions)) {
                            linesAdded += insertions;
                        }
                        if (!isNaN(deletions)) {
                            linesDeleted += deletions;
                        }
                    }
                    // 如果验证失败，我们会静默地忽略这一行，因为它不是我们想要的 numstat 数据
                }
            }
        }

        return {
            new_commits: newCommits,
            lines_added: linesAdded,
            lines_deleted: linesDeleted,
            committers: committers,
        };

    } catch (error) {
        console.error(`Git command failed for ${repoName}\n${redactSecrets(error.message)}`);
        return { new_commits: 0, lines_added: 0, lines_deleted: 0, committers: new Set() };
    }
}

// --- Data Ingestion Service (Cron Job & Backfill) ---

/**
 * [PIPELINE 1] Fetches ONLY commit stats via Git and stores them.
 * This process is completely independent of the API fetching process.
 */
async function fetchAndStoreRepoCommitStats(repoId, repoName, targetDate) {
    const targetDateStr = formatDate(targetDate);
    let commitStats;

    try {
        // This is the only fallible operation in this pipeline
        commitStats = await getCommitStats(repoName, targetDate);
        console.log(`[Git Pipeline] ${repoName}@${targetDateStr}: 采集到 commits=${commitStats.new_commits}, lines=+${commitStats.lines_added}/-${commitStats.lines_deleted}, committers=${commitStats.committers.size}`);
    } catch (error) {
        console.error(`[Git Pipeline] Failed to get commit stats for ${repoName}. Storing zero values. Error: ${error.message}`);
        // If git log fails, we ensure zero values are stored for these specific fields.
        commitStats = { new_commits: 0, lines_added: 0, lines_deleted: 0, committers: new Set() };
    }

    try {
        // Use ON CONFLICT to insert a new row or update an existing one.
        // This makes the process idempotent and safe for parallel execution.
        const result = await pool.query(
            `INSERT INTO repo_snapshots (repo_id, snapshot_date, new_commits, lines_added, lines_deleted)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (repo_id, snapshot_date) DO UPDATE
             SET new_commits = EXCLUDED.new_commits,
                 lines_added = EXCLUDED.lines_added,
                 lines_deleted = EXCLUDED.lines_deleted,
                 created_at = NOW()
             RETURNING id`,
            [repoId, targetDateStr, commitStats.new_commits, commitStats.lines_added, commitStats.lines_deleted]
        );
        console.log(`[Git Pipeline] ${repoName}@${targetDateStr}: ✅ 已存储到数据库 (id=${result.rows[0].id})`);
    } catch (error) {
        console.error(`[Git Pipeline] Error storing commit data for repo ${repoName}:`, error.message);
        // We throw here because a DB error is more critical.
        throw error;
    }
}

/**
 * Stores contributor activities to the database
 */
async function storeContributorActivities(repoId, dateStr, contributorDetails) {
    const humanContributorDetails = filterBotContributors(contributorDetails);
    if (humanContributorDetails.length === 0) return;

    try {
        const orgResult = await pool.query("SELECT id FROM organizations WHERE name = $1", [ORG_NAME]);
        if (orgResult.rows.length === 0) {
            console.error('[Contributors] Organization not found');
            return;
        }
        const orgId = orgResult.rows[0].id;

        for (const contributor of humanContributorDetails) {
            try {
                // 1. 插入或更新贡献者基本信息
                const contributorResult = await pool.query(
                    `INSERT INTO contributors (github_username, github_id, avatar_url, first_seen_date, last_seen_date)
                     VALUES ($1, $2, $3, $4, $4)
                     ON CONFLICT (github_username) DO UPDATE
                     SET last_seen_date = GREATEST(contributors.last_seen_date, EXCLUDED.last_seen_date),
                         avatar_url = EXCLUDED.avatar_url,
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
                     SET prs_opened = contributor_repo_activities.prs_opened + EXCLUDED.prs_opened,
                         prs_closed = contributor_repo_activities.prs_closed + EXCLUDED.prs_closed,
                         issues_opened = contributor_repo_activities.issues_opened + EXCLUDED.issues_opened,
                         issues_closed = contributor_repo_activities.issues_closed + EXCLUDED.issues_closed`,
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
                     SET prs_opened = contributor_daily_activities.prs_opened + EXCLUDED.prs_opened,
                         prs_closed = contributor_daily_activities.prs_closed + EXCLUDED.prs_closed,
                         issues_opened = contributor_daily_activities.issues_opened + EXCLUDED.issues_opened,
                         issues_closed = contributor_daily_activities.issues_closed + EXCLUDED.issues_closed,
                         active_repos_count = contributor_daily_activities.active_repos_count + 1`,
                    [contributorId, orgId, dateStr,
                        contributor.prs_opened, contributor.prs_closed,
                        contributor.issues_opened, contributor.issues_closed]
                );

            } catch (error) {
                console.error(`[Contributors] Error storing contributor ${contributor.username}:`, error.message);
            }
        }

        console.log(`[Contributors] Stored ${humanContributorDetails.length} contributors for ${dateStr}`);
    } catch (error) {
        console.error('[Contributors] Error in storeContributorActivities:', error.message);
    }
}

/**
 * [PIPELINE 2] Fetches ONLY API-related stats (PRs, Issues) and stores them.
 * This process is completely independent of the Git stats process.
 */
async function fetchAndStoreRepoApiStats(repoId, repoName, targetDate) {
    const targetDateStr = formatDate(targetDate);
    let apiMetrics;
    const contributorDetails = []; // 新增：保存贡献者详情
    console.log(`[API Pipeline] Starting to fetch API stats for: ${repoName}`);

    try {
        // This block contains all fallible API calls.
        const targetDateStr = formatDate(targetDate); // 格式如 "2025-11-08"
        const repoQuery = `repo:${ORG_NAME}/${repoName}`;

        // 直接在查询中使用 YYYY-MM-DD 格式，GitHub Search API 会自动将其识别为全天
        const createdPrs = await githubRest('/search/issues', { q: `${repoQuery} is:pr created:${targetDateStr}`, per_page: 100 });
        const createdIssues = await githubRest('/search/issues', { q: `${repoQuery} is:issue -is:pr created:${targetDateStr}`, per_page: 100 });
        const closedPrs = await githubRest('/search/issues', { q: `${repoQuery} is:pr is:closed closed:${targetDateStr}`, per_page: 100 });
        const closedIssues = await githubRest('/search/issues', { q: `${repoQuery} is:issue -is:pr is:closed closed:${targetDateStr}`, per_page: 100 });

        const activeContributors = new Set();
        const contributorStats = new Map(); // 新增：统计每个贡献者的活动

        // 处理 PR 开启
        createdPrs.items.forEach(item => {
            const username = item.user.login;
            if (isBotContributor(username)) {
                return;
            }
            activeContributors.add(username);
            if (!contributorStats.has(username)) {
                contributorStats.set(username, {
                    username,
                    avatar_url: item.user.avatar_url,
                    github_id: item.user.id,
                    prs_opened: 0,
                    prs_closed: 0,
                    issues_opened: 0,
                    issues_closed: 0
                });
            }
            contributorStats.get(username).prs_opened++;
        });

        // 处理 PR 关闭
        closedPrs.items.forEach(item => {
            const username = item.user.login;
            if (isBotContributor(username)) {
                return;
            }
            activeContributors.add(username);
            if (!contributorStats.has(username)) {
                contributorStats.set(username, {
                    username,
                    avatar_url: item.user.avatar_url,
                    github_id: item.user.id,
                    prs_opened: 0,
                    prs_closed: 0,
                    issues_opened: 0,
                    issues_closed: 0
                });
            }
            contributorStats.get(username).prs_closed++;
        });

        // 处理 Issue 开启
        createdIssues.items.forEach(item => {
            const username = item.user.login;
            if (isBotContributor(username)) {
                return;
            }
            activeContributors.add(username);
            if (!contributorStats.has(username)) {
                contributorStats.set(username, {
                    username,
                    avatar_url: item.user.avatar_url,
                    github_id: item.user.id,
                    prs_opened: 0,
                    prs_closed: 0,
                    issues_opened: 0,
                    issues_closed: 0
                });
            }
            contributorStats.get(username).issues_opened++;
        });

        // 处理 Issue 关闭
        closedIssues.items.forEach(item => {
            const username = item.user.login;
            if (isBotContributor(username)) {
                return;
            }
            activeContributors.add(username);
            if (!contributorStats.has(username)) {
                contributorStats.set(username, {
                    username,
                    avatar_url: item.user.avatar_url,
                    github_id: item.user.id,
                    prs_opened: 0,
                    prs_closed: 0,
                    issues_opened: 0,
                    issues_closed: 0
                });
            }
            contributorStats.get(username).issues_closed++;
        });

        apiMetrics = {
            new_prs: createdPrs.total_count,
            closed_merged_prs: closedPrs.total_count,
            new_issues: createdIssues.total_count,
            closed_issues: closedIssues.total_count,
            active_contributors: activeContributors.size,
        };

        contributorDetails.push(...contributorStats.values());

        console.log(`[API Pipeline] ${repoName}@${targetDateStr}: 采集到 PRs=${apiMetrics.new_prs} (closed=${apiMetrics.closed_merged_prs}), Issues=${apiMetrics.new_issues} (closed=${apiMetrics.closed_issues}), contributors=${apiMetrics.active_contributors}`);
    } catch (error) {
        console.error(`[API Pipeline] Failed to fetch API metrics for ${repoName}. Storing zero values. Error: ${error.message}`);
        apiMetrics = { new_prs: 0, closed_merged_prs: 0, new_issues: 0, closed_issues: 0, active_contributors: 0 };
    }

    try {
        // This query will insert or update, safely merging with data from the commit pipeline.
        const result = await pool.query(
            `INSERT INTO repo_snapshots (repo_id, snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (repo_id, snapshot_date) DO UPDATE
             SET new_prs = EXCLUDED.new_prs,
                 closed_merged_prs = EXCLUDED.closed_merged_prs,
                 new_issues = EXCLUDED.new_issues,
                 closed_issues = EXCLUDED.closed_issues,
                 active_contributors = EXCLUDED.active_contributors,
                 created_at = NOW()
             RETURNING id`,
            [repoId, targetDateStr, apiMetrics.new_prs, apiMetrics.closed_merged_prs, apiMetrics.new_issues, apiMetrics.closed_issues, apiMetrics.active_contributors]
        );
        console.log(`[API Pipeline] ${repoName}@${targetDateStr}: saved in database (id=${result.rows[0].id})`);

        // 新增：保存贡献者数据
        if (contributorDetails.length > 0) {
            await storeContributorActivities(repoId, targetDateStr, contributorDetails);
        }
    } catch (error) {
        console.error(`[API Pipeline] Error storing API data for repo ${repoName}:`, error.message);
        throw error;
    }
}

/**
 * Runs an array of promise-returning functions with limited concurrency.
 * @param {Array<() => Promise<any>>} tasks An array of functions that each return a Promise.
 * @param {number} concurrency The maximum number of tasks to run at once.
 * @returns {Promise<any[]>} A promise that resolves with an array of all task results.
 */
async function runPromisesWithConcurrency(tasks, concurrency) {
    const results = [];
    let currentIndex = 0;

    // The worker function that processes tasks one by one from the tasks array.
    const worker = async () => {
        while (currentIndex < tasks.length) {
            const taskIndex = currentIndex++;
            const task = tasks[taskIndex];
            try {
                results[taskIndex] = await task();
            } catch (error) {
                // Store error to review later if needed, or handle it
                results[taskIndex] = error;
                console.error(`Task at index ${taskIndex} failed:`, error.message);
            }
        }
    };

    // Create and start the workers.
    const workers = Array(concurrency).fill(null).map(() => worker());

    // Wait for all workers to complete.
    await Promise.all(workers);

    return results;
}

/**
 * Aggregates repo snapshots into SIG snapshots.
 */
async function aggregateSigSnapshot(sigId, targetDate) {
    const targetDateStr = formatDate(targetDate);

    // 获取SIG名称
    const sigResult = await pool.query('SELECT name FROM special_interest_groups WHERE id = $1', [sigId]);
    const sigName = sigResult.rows[0]?.name || `SIG-${sigId}`;

    // 1. Aggregate from repo_snapshots
    const aggregateResult = await pool.query(
        `SELECT COALESCE(SUM(rs.new_prs), 0) as new_prs,
                COALESCE(SUM(rs.closed_merged_prs), 0) as closed_merged_prs,
                COALESCE(SUM(rs.new_issues), 0) as new_issues,
                COALESCE(SUM(rs.closed_issues), 0) as closed_issues,
                COALESCE(SUM(rs.active_contributors), 0) as active_contributors,
                COALESCE(SUM(rs.new_commits), 0) as new_commits,
                COALESCE(SUM(rs.lines_added), 0) as lines_added,
                COALESCE(SUM(rs.lines_deleted), 0) as lines_deleted,
                COUNT(*) as repo_count
         FROM repo_snapshots rs
         JOIN repositories r ON rs.repo_id = r.id
         WHERE r.sig_id = $1 AND rs.snapshot_date = $2`,
        [sigId, targetDateStr]
    );

    const agg = aggregateResult.rows[0];

    // 2. Store SIG-level snapshot
    const sigMetrics = {
        new_prs: parseInt(agg.new_prs) || 0,
        closed_merged_prs: parseInt(agg.closed_merged_prs) || 0,
        new_issues: parseInt(agg.new_issues) || 0,
        closed_issues: parseInt(agg.closed_issues) || 0,
        active_contributors: parseInt(agg.active_contributors) || 0,
        new_commits: parseInt(agg.new_commits) || 0,
        lines_added: parseInt(agg.lines_added) || 0,
        lines_deleted: parseInt(agg.lines_deleted) || 0,
    };

    console.log(`[聚合] ${sigName}@${targetDateStr}: 从 ${agg.repo_count} 个仓库聚合得到 commits=${sigMetrics.new_commits}, PRs=${sigMetrics.new_prs}, Issues=${sigMetrics.new_issues}, lines=+${sigMetrics.lines_added}/-${sigMetrics.lines_deleted}`);

    const result = await pool.query(
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
             created_at = NOW()
         RETURNING id`,
        [sigId, targetDateStr, sigMetrics.new_prs, sigMetrics.closed_merged_prs, sigMetrics.new_issues, sigMetrics.closed_issues, sigMetrics.active_contributors, sigMetrics.new_commits, sigMetrics.lines_added, sigMetrics.lines_deleted]
    );
    console.log(`[聚合] ${sigName}@${targetDateStr}: ✅ 已存储SIG快照 (id=${result.rows[0].id})`);
    return sigMetrics;
}

/**
 * 主动刷新 Redis 缓存
 */
async function refreshCache() {
    console.log('--- Refreshing Redis Cache ---');
    try {
        const org = await getMonitoredOrg();
        if (!org) {
            console.log('Organization not found. Skipping cache refresh.');
            return;
        }

        // 刷新组织时间序列数据（30天）
        const range = '30d';
        const days = 30;
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        const startDateStr = formatDate(startDate);

        const dataResult = await pool.query(
            `SELECT 
                snapshot_date, 
                new_prs, 
                closed_merged_prs, 
                new_issues, 
                closed_issues, 
                active_contributors, 
                new_repos,
                new_commits,
                lines_added,
                lines_deleted
             FROM activity_snapshots
             WHERE org_id = $1 AND snapshot_date >= $2
             ORDER BY snapshot_date ASC`,
            [org.id, startDateStr]
        );

        const timeseriesData = dataResult.rows.map(row => ({
            date: formatDate(row.snapshot_date),
            new_prs: row.new_prs,
            closed_merged_prs: row.closed_merged_prs,
            new_issues: row.new_issues,
            closed_issues: row.closed_issues,
            active_contributors: row.active_contributors,
            new_repos: row.new_repos,
            new_commits: row.new_commits,
            lines_added: row.lines_added,
            lines_deleted: row.lines_deleted,
        }));

        const cacheKey = `org:${ORG_NAME}:range:${range}`;
        const cacheTTL = 60 * 10; // 10 minutes
        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(timeseriesData));
        console.log(`Cached organization timeseries data (${timeseriesData.length} records)`);

        // 刷新所有 SIG 的缓存
        const sigsResult = await pool.query('SELECT id, name FROM special_interest_groups WHERE org_id = $1', [org.id]);

        for (const sig of sigsResult.rows) {
            // 刷新 SIG commit 数据
            const commitDataResult = await pool.query(
                `SELECT snapshot_date, new_commits, lines_added, lines_deleted
                 FROM sig_snapshots
                 WHERE sig_id = $1 AND snapshot_date >= $2
                 ORDER BY snapshot_date ASC`,
                [sig.id, startDateStr]
            );

            const commitData = commitDataResult.rows.map(row => ({
                date: formatDate(row.snapshot_date),
                new_commits: row.new_commits,
                lines_added: row.lines_added,
                lines_deleted: row.lines_deleted,
            }));

            const commitCacheKey = `sig:${sig.id}:commits:range:${range}`;
            await redisClient.setEx(commitCacheKey, cacheTTL, JSON.stringify(commitData));

            // 刷新 SIG API 数据
            const apiDataResult = await pool.query(
                `SELECT snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors
                 FROM sig_snapshots
                 WHERE sig_id = $1 AND snapshot_date >= $2
                 ORDER BY snapshot_date ASC`,
                [sig.id, startDateStr]
            );

            const apiData = apiDataResult.rows.map(row => ({
                date: formatDate(row.snapshot_date),
                new_prs: row.new_prs,
                closed_merged_prs: row.closed_merged_prs,
                new_issues: row.new_issues,
                closed_issues: row.closed_issues,
                active_contributors: row.active_contributors,
            }));

            const apiCacheKey = `sig:${sig.id}:api:range:${range}`;
            await redisClient.setEx(apiCacheKey, cacheTTL, JSON.stringify(apiData));
        }

        console.log(`Cached ${sigsResult.rows.length} SIG timeseries data`);
        console.log('--- Cache Refresh Complete ---');

    } catch (error) {
        console.error('Failed to refresh cache:', error.message);
    }
}

/**
 * Runs the daily ingestion job for the current day using decoupled pipelines.
 */
async function runDailyIngestionJob() {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    const targetDate = yesterday;
    const targetDateStr = formatDate(targetDate);

    console.log(`--- Starting Daily Data Ingestion Job for date: ${targetDateStr} ---`);
    try {
        const orgsResult = await pool.query("SELECT id FROM organizations WHERE name = $1", [ORG_NAME]);
        const org = orgsResult.rows[0];
        if (!org) {
            console.log('Monitored organization not found. Skipping job.');
            return;
        }

        const reposResult = await pool.query('SELECT id, name, sig_id FROM repositories WHERE org_id = $1', [org.id]);
        const repositories = reposResult.rows;

        if (repositories.length === 0) {
            console.log('No repositories configured to monitor. Skipping job.');
            return;
        }

        // Git操作可以并发更高（不受API限流影响），API操作并发较低（避免限流）
        const gitConcurrencyLimit = 5; // Git操作并发5个
        const apiConcurrencyLimit = 3; // API操作并发3个（每分钟30次，3个并发×2秒间隔=6秒，安全）
        console.log(`Processing ${repositories.length} repos with Git concurrency: ${gitConcurrencyLimit}, API concurrency: ${apiConcurrencyLimit}`);

        // --- PIPELINE 1: Process all Git-based stats ---
        console.log('\n--- [Phase 1/3] Starting Git Commit Stats Ingestion ---');
        const commitTasks = repositories.map(repo =>
            () => fetchAndStoreRepoCommitStats(repo.id, repo.name, targetDate)
        );
        await runPromisesWithConcurrency(commitTasks, gitConcurrencyLimit);
        console.log('--- [Phase 1/3] Git Commit Stats Ingestion Finished ---');

        // --- PIPELINE 2: Process all API-based stats ---
        console.log('\n--- [Phase 2/3] Starting GitHub API Stats Ingestion ---');
        const apiTasks = repositories.map(repo =>
            () => fetchAndStoreRepoApiStats(repo.id, repo.name, targetDate)
        );
        await runPromisesWithConcurrency(apiTasks, apiConcurrencyLimit);
        console.log('--- [Phase 2/3] GitHub API Stats Ingestion Finished ---');

        // --- FINAL PHASE: Aggregate all data ---
        console.log('\n--- [Phase 3/3] Starting Data Aggregation ---');
        // The aggregation logic remains the same, as it reads from the now-populated table.
        const sigsResult = await pool.query('SELECT id, name FROM special_interest_groups WHERE org_id = $1', [org.id]);
        const sigs = sigsResult.rows;

        const sigAggregationPromises = sigs.map(sig => aggregateSigSnapshot(sig.id, targetDate));
        await Promise.all(sigAggregationPromises);
        console.log(`Successfully stored all ${sigs.length} SIG snapshots for ${targetDateStr}.`);

        // 4. Aggregate SIG Snapshots into Organization Snapshot
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
     JOIN organizations org ON sig.org_id = org.id
     WHERE org.name = $1 AND ss.snapshot_date = $2`,
            [ORG_NAME, targetDateStr] // <-- 查询条件更精确
        );

        const orgAgg = orgAggregationResult.rows[0];
        const orgMetrics = {
            new_prs: parseInt(orgAgg.new_prs) || 0,
            closed_merged_prs: parseInt(orgAgg.closed_merged_prs) || 0,
            new_issues: parseInt(orgAgg.new_issues) || 0,
            closed_issues: parseInt(orgAgg.closed_issues) || 0,
            active_contributors: parseInt(orgAgg.active_contributors) || 0,
            new_commits: parseInt(orgAgg.new_commits) || 0,
            lines_added: parseInt(orgAgg.lines_added) || 0,
            lines_deleted: parseInt(orgAgg.lines_deleted) || 0,
            new_repos: 0,
        };

        console.log(`[aggregation] organization@${targetDateStr}: commits=${orgMetrics.new_commits}, PRs=${orgMetrics.new_prs} (合并=${orgMetrics.closed_merged_prs}), Issues=${orgMetrics.new_issues} (关闭=${orgMetrics.closed_issues}), contributors=${orgMetrics.active_contributors}, lines=+${orgMetrics.lines_added}/-${orgMetrics.lines_deleted}`);

        const result = await pool.query(
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
         created_at = NOW()
     RETURNING id`,
            [org.id, targetDateStr, orgMetrics.new_prs, orgMetrics.closed_merged_prs, orgMetrics.new_issues, orgMetrics.closed_issues, orgMetrics.active_contributors, orgMetrics.new_repos, orgMetrics.new_commits, orgMetrics.lines_added, orgMetrics.lines_deleted]
        );
        console.log(`[aggregation] organization@${targetDateStr}: saved snapshot (id=${result.rows[0].id})`);
        console.log(`Successfully stored organization snapshot for ${ORG_NAME} on ${targetDateStr}.`);

        console.log('--- Daily Data Ingestion Job Finished Successfully ---');

        // 主动刷新缓存
        await refreshCache();

    } catch (error) {
        console.error('CRON Job Failed:', error.message);
    }
}

/**
 * Runs a backfill job for the last N days using decoupled pipelines.
 */
async function runBackfillJob(days = 7) {
    console.log(`--- Starting Backfill Job for the last ${days} days ---`);
    try {
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

        // Get today's date (midnight)
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Calculate date range
        const startDate = new Date(today);
        startDate.setDate(today.getDate() - days);
        const startDateStr = formatDate(startDate);
        const todayStr = formatDate(today);

        console.log(`Checking for existing data between ${startDateStr} and ${todayStr}...`);
        const existingSnapshotsResult = await pool.query(
            `SELECT DISTINCT snapshot_date
             FROM activity_snapshots
             WHERE org_id = $1 AND snapshot_date >= $2 AND snapshot_date <= $3`,
            [org.id, startDateStr, todayStr]
        );

        // 将日期字符串存入 Set 以便快速查找
        const existingDates = new Set(
            existingSnapshotsResult.rows.map(row => formatDate(new Date(row.snapshot_date)))
        );

        if (existingDates.size > 0) {
            console.log(`Found ${existingDates.size} completed days. Will skip them.`);
        } else {
            console.log('No existing data found in the range. Will backfill all days.');
        }

        console.log(`\ndates: ${startDateStr} to ${todayStr}`);
        console.log(`repo nums: ${repositories.length}`);
        console.log(`SIG nums: ${sigs.length}\n`);

        // Loop from the oldest day (30 days ago) to yesterday to backfill data
        for (let i = days; i >= 1; i--) {
            const targetDate = new Date(today);
            targetDate.setDate(today.getDate() - i);
            const targetDateStr = formatDate(targetDate);

            if (existingDates.has(targetDateStr)) {
                console.log(`[Skip] Data for ${targetDateStr} already exists.`);
                continue; // 跳到下一天
            }

            console.log(`\n--- Backfilling data for date: ${targetDateStr} ---`);
            // Git操作可以并发更高，API操作并发较低
            const gitConcurrencyLimit = 5;
            const apiConcurrencyLimit = 3;

            // --- PIPELINE 1: Process all Git-based stats for the target date ---
            console.log(`[${targetDateStr}] [Phase 1/3] Starting Git Commit Stats Backfill...`);
            const commitTasks = repositories.map(repo =>
                () => fetchAndStoreRepoCommitStats(repo.id, repo.name, targetDate)
            );
            await runPromisesWithConcurrency(commitTasks, gitConcurrencyLimit);
            console.log(`[${targetDateStr}] [Phase 1/3] Git Commit Stats Backfill Finished.`);

            // --- PIPELINE 2: Process all API-based stats for the target date ---
            console.log(`[${targetDateStr}] [Phase 2/3] Starting GitHub API Stats Backfill...`);
            const apiTasks = repositories.map(repo =>
                () => fetchAndStoreRepoApiStats(repo.id, repo.name, targetDate)
            );
            await runPromisesWithConcurrency(apiTasks, apiConcurrencyLimit);
            console.log(`[${targetDateStr}] [Phase 2/3] GitHub API Stats Backfill Finished.`);

            // --- FINAL PHASE: Aggregate all data for the target date ---
            console.log(`[${targetDateStr}] [Phase 3/3] Starting Data Aggregation...`);
            // SIG Aggregation
            const sigAggregationPromises = sigs.map(sig => aggregateSigSnapshot(sig.id, targetDate));
            await Promise.all(sigAggregationPromises);

            // Organization Aggregation (using your existing logic)
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
            const orgMetrics = {
                new_prs: parseInt(orgAgg.new_prs) || 0,
                closed_merged_prs: parseInt(orgAgg.closed_merged_prs) || 0,
                new_issues: parseInt(orgAgg.new_issues) || 0,
                closed_issues: parseInt(orgAgg.closed_issues) || 0,
                active_contributors: parseInt(orgAgg.active_contributors) || 0,
                new_commits: parseInt(orgAgg.new_commits) || 0,
                lines_added: parseInt(orgAgg.lines_added) || 0,
                lines_deleted: parseInt(orgAgg.lines_deleted) || 0,
                new_repos: 0,
            };

            console.log(`[aggregation] organisation@${targetDateStr}: commits=${orgMetrics.new_commits}, PRs=${orgMetrics.new_prs} (merged=${orgMetrics.closed_merged_prs}), Issues=${orgMetrics.new_issues} (closed=${orgMetrics.closed_issues}), contributors=${orgMetrics.active_contributors}, lines=+${orgMetrics.lines_added}/-${orgMetrics.lines_deleted}`);

            const result = await pool.query(
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
                     created_at = NOW()
                 RETURNING id`,
                [org.id, targetDateStr, orgMetrics.new_prs, orgMetrics.closed_merged_prs, orgMetrics.new_issues, orgMetrics.closed_issues, orgMetrics.active_contributors, orgMetrics.new_repos, orgMetrics.new_commits, orgMetrics.lines_added, orgMetrics.lines_deleted]
            );
            console.log(`[aggregation] organisation@${targetDateStr}: snapshot saved (id=${result.rows[0].id})`);
            console.log(`[${targetDateStr}] [Phase 3/3] Data Aggregation Done.`);
        }

        console.log('\n--- Backfill Job Finished Successfully ---');

        // 主动刷新缓存
        await refreshCache();

    } catch (error) {
        console.error('Backfill Job Failed:', error.message);
    }
}

/**
 * Runs a backfill job using GraphQL API for efficient batch data fetching.
 * This is MUCH faster than the REST API version for historical data.
 * @param {number} days Number of days to backfill
 */
async function runBackfillJobWithGraphQL(days = 30) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`--- Starting GraphQL Backfill Job for the last ${days} days ---`);
    console.log(`${'='.repeat(60)}\n`);

    const startTime = Date.now();

    try {
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

        // Calculate date range
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const startDate = new Date(today);
        startDate.setDate(today.getDate() - days);

        const endDate = new Date(today);
        endDate.setDate(today.getDate() - 1); // Yesterday

        const startDateStr = formatDate(startDate);
        const endDateStr = formatDate(endDate);

        console.log(`Date range: ${startDateStr} to ${endDateStr}`);
        console.log(`Repositories: ${repositories.length}`);
        console.log(`SIGs: ${sigs.length}\n`);

        // === PHASE 1: Git Commit Stats (unchanged, still per-day) ===
        console.log('=== PHASE 1: Git Commit Stats ===');
        console.log('Note: Git stats are collected per-day as they require local git operations.\n');

        const gitConcurrencyLimit = 5;

        for (let i = days; i >= 1; i--) {
            const targetDate = new Date(today);
            targetDate.setDate(today.getDate() - i);
            const targetDateStr = formatDate(targetDate);

            console.log(`[Git] Processing ${targetDateStr}...`);
            const commitTasks = repositories.map(repo =>
                () => fetchAndStoreRepoCommitStats(repo.id, repo.name, targetDate)
            );
            await runPromisesWithConcurrency(commitTasks, gitConcurrencyLimit);
        }
        console.log('=== PHASE 1 Complete ===\n');

        // === PHASE 2: GraphQL API Stats (batch per-repo) ===
        console.log('=== PHASE 2: GraphQL API Stats ===');
        console.log('Using GraphQL to fetch all PR/Issue data per repo in batch.\n');

        const graphqlConcurrencyLimit = 3; // 并发3个仓库

        const graphqlTasks = repositories.map(repo => async () => {
            try {
                // Fetch all stats for this repo in one batch
                const statsMap = await fetchRepoStatsViaGraphQL(repo.name, startDate, endDate);

                // Store each date's stats to the database
                for (const [dateStr, stats] of statsMap) {
                    await storeRepoApiStatsForDate(repo.id, repo.name, dateStr, stats);
                }

                console.log(`[GraphQL] ${repo.name}: ✅ Stored ${statsMap.size} days of data.`);
            } catch (error) {
                console.error(`[GraphQL] ${repo.name}: ❌ Error: ${error.message}`);
            }
        });

        await runPromisesWithConcurrency(graphqlTasks, graphqlConcurrencyLimit);
        console.log('=== PHASE 2 Complete ===\n');

        // === PHASE 3: Aggregation ===
        console.log('=== PHASE 3: Data Aggregation ===\n');

        for (let i = days; i >= 1; i--) {
            const targetDate = new Date(today);
            targetDate.setDate(today.getDate() - i);
            const targetDateStr = formatDate(targetDate);

            // SIG Aggregation
            for (const sig of sigs) {
                await aggregateSigSnapshot(sig.id, targetDate);
            }

            // Organization Aggregation
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
            const orgMetrics = {
                new_prs: parseInt(orgAgg.new_prs) || 0,
                closed_merged_prs: parseInt(orgAgg.closed_merged_prs) || 0,
                new_issues: parseInt(orgAgg.new_issues) || 0,
                closed_issues: parseInt(orgAgg.closed_issues) || 0,
                active_contributors: parseInt(orgAgg.active_contributors) || 0,
                new_commits: parseInt(orgAgg.new_commits) || 0,
                lines_added: parseInt(orgAgg.lines_added) || 0,
                lines_deleted: parseInt(orgAgg.lines_deleted) || 0,
                new_repos: 0,
            };

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
                [org.id, targetDateStr, orgMetrics.new_prs, orgMetrics.closed_merged_prs, orgMetrics.new_issues, orgMetrics.closed_issues, orgMetrics.active_contributors, orgMetrics.new_repos, orgMetrics.new_commits, orgMetrics.lines_added, orgMetrics.lines_deleted]
            );

            console.log(`[Aggregation] ${targetDateStr}: ✅ PRs=${orgMetrics.new_prs}, Issues=${orgMetrics.new_issues}, Commits=${orgMetrics.new_commits}`);
        }

        console.log('=== PHASE 3 Complete ===\n');

        // Refresh cache
        console.log('--- Refreshing Redis Cache ---');
        await refreshCache();

        const elapsedTime = Math.round((Date.now() - startTime) / 1000);
        console.log(`\n${'='.repeat(60)}`);
        console.log(`--- GraphQL Backfill Job Finished Successfully ---`);
        console.log(`Total time: ${Math.floor(elapsedTime / 60)}m ${elapsedTime % 60}s`);
        console.log(`${'='.repeat(60)}\n`);

    } catch (error) {
        console.error('GraphQL Backfill Job Failed:', error.message);
        console.error(error.stack);
    }
}

// Schedule the job to run once every 24 hours (e.g., at 00:00 UTC)
// cron.schedule('0 0 * * *', runDailyIngestionJob); // Daily at midnight
cron.schedule('0 */6 * * *', runDailyIngestionJob); // Every 6 hours for testing

// --- API Routes ---

// Helper function for security check (now simplified for single org)
async function getMonitoredOrg() {
    const orgResult = await pool.query("SELECT id, name FROM organizations WHERE name = $1", [ORG_NAME]);
    return orgResult.rows[0];
}

// GET /api/v1/organization/sigs - New route to get all monitored SIGs
app.get('/api/v1/organization/sigs', async (req, res) => {
    try {
        const org = await getMonitoredOrg();
        if (!org) {
            return res.status(404).json({ error: 'Monitored organization not found.' });
        }

        const sigsResult = await pool.query('SELECT id, name FROM special_interest_groups WHERE org_id = $1 ORDER BY name', [org.id]);
        res.json(sigsResult.rows);
    } catch (error) {
        console.error('Error fetching SIGs:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/organization/timeseries - New route for Organization timeseries
app.get('/api/v1/organization/timeseries', async (req, res) => {
    const range = req.query.range || '30d';
    const cacheKey = `org:${ORG_NAME}:timeseries:range:${range}`;
    const cacheTTL = 60 * 10;

    try {
        const org = await getMonitoredOrg();
        if (!org) return res.status(404).json({ error: 'Org not found' });

        const cached = await redisClient.get(cacheKey);
        if (cached) return res.json(JSON.parse(cached));

        let { startDateStr } = parseRange(range);

        const result = await pool.query(
            `SELECT snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors, new_repos, new_commits, lines_added, lines_deleted
             FROM activity_snapshots
             WHERE org_id = $1 AND snapshot_date >= $2
             ORDER BY snapshot_date ASC`,
            [org.id, startDateStr]
        );

        const data = result.rows.map(row => ({
            date: formatDate(row.snapshot_date),
            new_prs: row.new_prs,
            closed_merged_prs: row.closed_merged_prs,
            new_issues: row.new_issues,
            closed_issues: row.closed_issues,
            active_contributors: row.active_contributors,
            new_repos: row.new_repos,
            new_commits: row.new_commits,
            lines_added: row.lines_added,
            lines_deleted: row.lines_deleted,
        }));

        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(data));
        res.json(data);
    } catch (error) {
        console.error('Error fetching org timeseries:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/organization/summary - [新增] 提供组织在指定时间范围内的汇总数据
app.get('/api/v1/organization/summary', async (req, res) => {
    // 默认30天，允许通过查询参数更改，例如 /summary?range=7d
    const range = req.query.range || '30d';
    const cacheKey = `org:${ORG_NAME}:summary:range:${range}`;
    const cacheTTL = 60 * 10; // 缓存10分钟

    try {
        const org = await getMonitoredOrg();
        if (!org) {
            return res.status(404).json({ error: 'Monitored organization not found.' });
        }

        // 1. 检查缓存
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            console.log(`Cache hit for summary: ${cacheKey}`);
            return res.json(JSON.parse(cachedData));
        }
        console.log(`Cache miss for summary: ${cacheKey}. Querying DB...`);

        // 2. 计算日期范围
        const { startDateStr, days } = parseRange(range);

        // 3. 从数据库查询并聚合数据
        const summaryResult = await pool.query(
            `SELECT 
                COALESCE(SUM(new_prs), 0) as new_prs,
                COALESCE(SUM(closed_merged_prs), 0) as closed_merged_prs,
                COALESCE(SUM(new_issues), 0) as new_issues,
                COALESCE(SUM(new_commits), 0) as new_commits,
                COALESCE(SUM(lines_added), 0) as lines_added,
                COALESCE(SUM(lines_deleted), 0) as lines_deleted,
                -- 为了调试和验证，可以返回统计了多少天的数据
                COUNT(*) as days_counted 
             FROM activity_snapshots
             WHERE org_id = $1 AND snapshot_date >= $2`,
            [org.id, startDateStr]
        );

        // 4. 统计唯一活跃贡献者数量（而非每日数量的总和）
        const contributorCountResult = await pool.query(
            `SELECT COUNT(DISTINCT cda.contributor_id) as unique_contributors
             FROM contributor_daily_activities cda
             JOIN contributors c ON cda.contributor_id = c.id
             WHERE cda.org_id = $1 AND cda.snapshot_date >= $2
               AND ${HUMAN_CONTRIBUTOR_SQL}`,
            [org.id, startDateStr]
        );

        // 将 bigint (string) 转换为 number
        const summaryData = {
            new_prs: parseInt(summaryResult.rows[0].new_prs, 10),
            closed_merged_prs: parseInt(summaryResult.rows[0].closed_merged_prs, 10),
            new_issues: parseInt(summaryResult.rows[0].new_issues, 10),
            new_commits: parseInt(summaryResult.rows[0].new_commits, 10),
            lines_added: parseInt(summaryResult.rows[0].lines_added, 10),
            lines_deleted: parseInt(summaryResult.rows[0].lines_deleted, 10),
            active_contributors: parseInt(contributorCountResult.rows[0].unique_contributors, 10),
            days_counted: parseInt(summaryResult.rows[0].days_counted, 10),
            range_days: days, // 在响应中包含请求的范围
        };

        // 4. 存入缓存并返回
        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(summaryData));
        console.log(`Summary data stored in cache for ${cacheKey}.`);

        res.json(summaryData);

    } catch (error) {
        console.error(`Error fetching summary data for organization:`, error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/sig/:sigId/timeseries - New route for SIG timeseries
app.get('/api/v1/sig/:sigId/timeseries', async (req, res) => {
    const { sigId } = req.params;
    const range = req.query.range || '30d'; // Default to 30 days
    const cacheKey = `sig:${sigId}:range:${range}`;
    const cacheTTL = 60 * 10; // 10 minutes

    try {
        // 1. Check if SIG is monitored
        const sigResult = await pool.query('SELECT id, name FROM special_interest_groups WHERE id = $1', [sigId]);
        if (sigResult.rows.length === 0) {
            return res.status(404).json({ error: 'Monitored SIG not found.' });
        }
        const sigName = sigResult.rows[0].name;

        // 2. Caching Logic: Check Redis
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            console.log(`Cache hit for ${cacheKey}`);
            return res.json(JSON.parse(cachedData));
        }
        console.log(`Cache miss for ${cacheKey}. Querying DB...`);

        // 3. Query Database
        let days;
        if (range.endsWith('d')) {
            days = parseInt(range.slice(0, -1), 10);
        } else {
            days = 30; // Fallback
        }

        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        const startDateStr = formatDate(startDate);

        const dataResult = await pool.query(
            `SELECT snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors, new_commits, lines_added, lines_deleted
             FROM sig_snapshots
             WHERE sig_id = $1 AND snapshot_date >= $2
             ORDER BY snapshot_date ASC`,
            [sigId, startDateStr]
        );

        const timeseriesData = dataResult.rows.map(row => ({
            date: formatDate(row.snapshot_date),
            new_prs: row.new_prs,
            closed_merged_prs: row.closed_merged_prs,
            new_issues: row.new_issues,
            closed_issues: row.closed_issues,
            active_contributors: row.active_contributors,
            new_commits: row.new_commits,
            lines_added: row.lines_added,
            lines_deleted: row.lines_deleted,
        }));

        // 4. Store in Redis and return
        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(timeseriesData));
        console.log(`Data stored in cache for ${cacheKey}.`);

        res.json(timeseriesData);

    } catch (error) {
        console.error(`Error fetching timeseries data for SIG ${sigName}:`, error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/sig/:sigId/timeseries/commits - 只返回Commit相关数据
app.get('/api/v1/sig/:sigId/timeseries/commits', async (req, res) => {
    const { sigId } = req.params;
    const range = req.query.range || '30d';
    const cacheKey = `sig:${sigId}:commits:range:${range}`;
    const cacheTTL = 60 * 10; // 10 minutes

    try {
        const sigResult = await pool.query('SELECT id, name FROM special_interest_groups WHERE id = $1', [sigId]);
        if (sigResult.rows.length === 0) {
            return res.status(404).json({ error: 'Monitored SIG not found.' });
        }

        // 检查缓存
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            return res.json(JSON.parse(cachedData));
        }

        const { startDateStr } = parseRange(range);

        const dataResult = await pool.query(
            `SELECT snapshot_date, new_commits, lines_added, lines_deleted
             FROM sig_snapshots
             WHERE sig_id = $1 AND snapshot_date >= $2
             ORDER BY snapshot_date ASC`,
            [sigId, startDateStr]
        );

        const responseData = dataResult.rows.map(row => ({
            date: formatDate(row.snapshot_date),
            new_commits: row.new_commits,
            lines_added: row.lines_added,
            lines_deleted: row.lines_deleted,
        }));

        // 存入缓存
        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(responseData));

        res.json(responseData);
    } catch (error) {
        console.error(`Error fetching commit timeseries for SIG ${sigId}:`, error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/sig/:sigId/timeseries/api - 只返回API相关数据
app.get('/api/v1/sig/:sigId/timeseries/api', async (req, res) => {
    const { sigId } = req.params;
    const range = req.query.range || '30d';
    const cacheKey = `sig:${sigId}:api:range:${range}`;
    const cacheTTL = 60 * 10; // 10 minutes

    try {
        const sigResult = await pool.query('SELECT id, name FROM special_interest_groups WHERE id = $1', [sigId]);
        if (sigResult.rows.length === 0) {
            return res.status(404).json({ error: 'Monitored SIG not found.' });
        }

        // 检查缓存
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            return res.json(JSON.parse(cachedData));
        }

        const { startDateStr } = parseRange(range);

        const dataResult = await pool.query(
            `SELECT snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors
             FROM sig_snapshots
             WHERE sig_id = $1 AND snapshot_date >= $2
             ORDER BY snapshot_date ASC`,
            [sigId, startDateStr]
        );

        const responseData = dataResult.rows.map(row => ({
            date: formatDate(row.snapshot_date),
            new_prs: row.new_prs,
            closed_merged_prs: row.closed_merged_prs,
            new_issues: row.new_issues,
            closed_issues: row.closed_issues,
            active_contributors: row.active_contributors,
        }));

        // 存入缓存
        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(responseData));

        res.json(responseData);
    } catch (error) {
        console.error(`Error fetching API timeseries for SIG ${sigId}:`, error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/organization/latest-activity - Now for the single monitored org
app.get('/api/v1/organization/latest-activity', async (req, res) => {
    const { type } = req.query; // 'prs' or 'issues'

    // Parse pagination parameters
    const page = parseInt(req.query.page) || 1;
    const per_page = parseInt(req.query.per_page) || 10;

    // GitHub Search API limits per_page to 100
    const limit = Math.min(per_page, 100);

    try {
        const org = await getMonitoredOrg();
        if (!org) {
            return res.status(404).json({ error: 'Monitored organization not found.' });
        }

        let query;
        if (type === 'prs') {
            // Search for open Pull Requests, sorted by creation date descending
            query = `org:${org.name} is:pr is:open sort:created-desc`;
        } else if (type === 'issues') {
            // Search for open Issues (excluding PRs), sorted by creation date descending
            query = `org:${org.name} is:issue is:open -is:pr sort:created-desc`;
        } else {
            return res.status(400).json({ error: 'Invalid activity type. Must be "prs" or "issues".' });
        }

        const searchResults = await githubRest('/search/issues', {
            q: query,
            per_page: limit,
            page: page,
        });

        const activities = searchResults.items.map(item => ({
            id: item.id,
            title: item.title,
            url: item.html_url,
            repo: item.repository_url.split('/').pop(),
            author: item.user.login,
            created_at: item.created_at,
            state: item.state,
        }));

        // Return the activities and the total count for pagination
        res.json({
            activities: activities,
            total_count: searchResults.total_count,
            page: page,
            per_page: limit,
        });

    } catch (error) {
        console.error(`Error fetching latest activity for organization:`, error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/sig/:sigId/summary - 提供单个SIG在指定时间范围内的汇总数据
app.get('/api/v1/sig/:sigId/summary', async (req, res) => {
    const { sigId } = req.params;
    const range = req.query.range || '30d'; // 默认30天
    const cacheKey = `sig:${sigId}:summary:range:${range}`;
    const cacheTTL = 60 * 10; // 缓存10分钟

    try {
        // 1. 验证 SIG 是否存在
        const sigResult = await pool.query('SELECT id FROM special_interest_groups WHERE id = $1', [sigId]);
        if (sigResult.rows.length === 0) {
            return res.status(404).json({ error: 'Monitored SIG not found.' });
        }

        // 2. 检查缓存
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            console.log(`Cache hit for SIG summary: ${cacheKey}`);
            return res.json(JSON.parse(cachedData));
        }
        console.log(`Cache miss for SIG summary: ${cacheKey}. Querying DB...`);

        // 3. 计算日期范围
        const days = parseInt(range.slice(0, -1), 10) || 30;
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        const startDateStr = formatDate(startDate);

        // 4. 从 sig_snapshots 表查询并聚合数据
        const summaryResult = await pool.query(
            `SELECT 
                COALESCE(SUM(new_prs), 0) as new_prs,
                COALESCE(SUM(closed_merged_prs), 0) as closed_merged_prs,
                COALESCE(SUM(new_issues), 0) as new_issues,
                COALESCE(SUM(closed_issues), 0) as closed_issues,
                COALESCE(SUM(new_commits), 0) as new_commits,
                COALESCE(SUM(lines_added), 0) as lines_added,
                COALESCE(SUM(lines_deleted), 0) as lines_deleted,
                COUNT(*) as days_counted
             FROM sig_snapshots
             WHERE sig_id = $1 AND snapshot_date >= $2`,
            [sigId, startDateStr]
        );

        // 转换数据格式
        const summaryData = {
            new_prs: parseInt(summaryResult.rows[0].new_prs, 10),
            closed_merged_prs: parseInt(summaryResult.rows[0].closed_merged_prs, 10),
            new_issues: parseInt(summaryResult.rows[0].new_issues, 10),
            closed_issues: parseInt(summaryResult.rows[0].closed_issues, 10),
            new_commits: parseInt(summaryResult.rows[0].new_commits, 10),
            lines_added: parseInt(summaryResult.rows[0].lines_added, 10),
            lines_deleted: parseInt(summaryResult.rows[0].lines_deleted, 10),
            days_counted: parseInt(summaryResult.rows[0].days_counted, 10),
            range_days: days,
        };

        // 5. 存入缓存并返回
        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(summaryData));
        console.log(`SIG summary data stored in cache for ${cacheKey}.`);

        res.json(summaryData);

    } catch (error) {
        console.error(`Error fetching summary data for SIG ${sigId}:`, error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Data Aggregation Helper Functions ---

/**
 * Get the start of the week (Monday) for a given date
 */
function getWeekStart(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust when day is Sunday
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
}

/**
 * Initialize metric object with zero values
 */
function initMetrics() {
    return {
        new_prs: 0,
        closed_merged_prs: 0,
        new_issues: 0,
        closed_issues: 0,
        active_contributors: 0,
        new_commits: 0,
        lines_added: 0,
        lines_deleted: 0
    };
}

/**
 * Aggregate metrics from source to target
 */
function aggregateMetrics(target, source) {
    target.new_prs += source.new_prs || 0;
    target.closed_merged_prs += source.closed_merged_prs || 0;
    target.new_issues += source.new_issues || 0;
    target.closed_issues += source.closed_issues || 0;
    target.active_contributors += source.active_contributors || 0;
    target.new_commits += source.new_commits || 0;
    target.lines_added += source.lines_added || 0;
    target.lines_deleted += source.lines_deleted || 0;
}

/**
 * Aggregate daily data by week
 */
function aggregateByWeek(dailyData) {
    const weekMap = new Map();
    dailyData.forEach(item => {
        const date = new Date(item.date);
        const weekStart = getWeekStart(date);
        const weekKey = formatDate(weekStart);

        if (!weekMap.has(weekKey)) {
            weekMap.set(weekKey, { date: weekKey, ...initMetrics() });
        }
        const week = weekMap.get(weekKey);
        aggregateMetrics(week, item);
    });
    return Array.from(weekMap.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Aggregate daily data by month
 */
function aggregateByMonth(dailyData) {
    const monthMap = new Map();
    dailyData.forEach(item => {
        const monthKey = item.date.substring(0, 7); // YYYY-MM
        if (!monthMap.has(monthKey)) {
            monthMap.set(monthKey, { date: monthKey, ...initMetrics() });
        }
        const month = monthMap.get(monthKey);
        aggregateMetrics(month, item);
    });
    return Array.from(monthMap.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// --- New API Routes ---

// GET /api/v1/organization/timeseries/aggregated
app.get('/api/v1/organization/timeseries/aggregated', async (req, res) => {
    const range = req.query.range || '30d';
    const granularity = req.query.granularity || 'day'; // day, week, month
    const cacheKey = `org:${ORG_NAME}:aggregated:${granularity}:${range}`;
    const cacheTTL = 60 * 10; // 10 minutes

    try {
        const org = await getMonitoredOrg();
        if (!org) {
            return res.status(404).json({ error: 'Monitored organization not found.' });
        }

        // Check cache
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            console.log(`Cache hit for ${cacheKey}`);
            return res.json(JSON.parse(cachedData));
        }
        console.log(`Cache miss for ${cacheKey}. Querying DB...`);

        // Calculate date range
        let days;
        if (range.endsWith('d')) {
            days = parseInt(range.slice(0, -1), 10);
        } else {
            days = 30; // Fallback
        }

        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        const startDateStr = formatDate(startDate);

        // Query database for daily data
        const dataResult = await pool.query(
            `SELECT 
                snapshot_date, 
                new_prs, 
                closed_merged_prs, 
                new_issues, 
                closed_issues, 
                active_contributors, 
                new_repos,
                new_commits,
                lines_added,
                lines_deleted
             FROM activity_snapshots
             WHERE org_id = $1 AND snapshot_date >= $2
             ORDER BY snapshot_date ASC`,
            [org.id, startDateStr]
        );

        let timeseriesData = dataResult.rows.map(row => ({
            date: formatDate(row.snapshot_date),
            new_prs: row.new_prs,
            closed_merged_prs: row.closed_merged_prs,
            new_issues: row.new_issues,
            closed_issues: row.closed_issues,
            active_contributors: row.active_contributors,
            new_repos: row.new_repos,
            new_commits: row.new_commits,
            lines_added: row.lines_added,
            lines_deleted: row.lines_deleted
        }));

        // Apply aggregation based on granularity
        if (granularity === 'week') {
            timeseriesData = aggregateByWeek(timeseriesData);
        } else if (granularity === 'month') {
            timeseriesData = aggregateByMonth(timeseriesData);
        }

        // Cache the result
        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(timeseriesData));

        res.json(timeseriesData);
    } catch (error) {
        console.error(`Error fetching aggregated timeseries:`, error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/sig/:sigId/timeseries/aggregated
app.get('/api/v1/sig/:sigId/timeseries/aggregated', async (req, res) => {
    const { sigId } = req.params;
    const range = req.query.range || '30d';
    const granularity = req.query.granularity || 'day';
    const cacheKey = `sig:${sigId}:aggregated:${granularity}:${range}`;
    const cacheTTL = 60 * 10;

    try {
        const sigResult = await pool.query('SELECT id, name FROM special_interest_groups WHERE id = $1', [sigId]);
        if (sigResult.rows.length === 0) {
            return res.status(404).json({ error: 'Monitored SIG not found.' });
        }

        // Check cache
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            console.log(`Cache hit for ${cacheKey}`);
            return res.json(JSON.parse(cachedData));
        }
        console.log(`Cache miss for ${cacheKey}. Querying DB...`);

        const { startDateStr } = parseRange(range);

        const dataResult = await pool.query(
            `SELECT snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, 
                    active_contributors, new_commits, lines_added, lines_deleted
             FROM sig_snapshots
             WHERE sig_id = $1 AND snapshot_date >= $2
             ORDER BY snapshot_date ASC`,
            [sigId, startDateStr]
        );

        let timeseriesData = dataResult.rows.map(row => ({
            date: formatDate(row.snapshot_date),
            new_prs: row.new_prs,
            closed_merged_prs: row.closed_merged_prs,
            new_issues: row.new_issues,
            closed_issues: row.closed_issues,
            active_contributors: row.active_contributors,
            new_commits: row.new_commits,
            lines_added: row.lines_added,
            lines_deleted: row.lines_deleted
        }));

        // Apply aggregation
        if (granularity === 'week') {
            timeseriesData = aggregateByWeek(timeseriesData);
        } else if (granularity === 'month') {
            timeseriesData = aggregateByMonth(timeseriesData);
        }

        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(timeseriesData));

        res.json(timeseriesData);
    } catch (error) {
        console.error(`Error fetching aggregated SIG timeseries:`, error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/sigs/compare - Compare multiple SIGs
app.get('/api/v1/sigs/compare', async (req, res) => {
    const sigIdsParam = req.query.sigIds || '';
    const sigIds = sigIdsParam.split(',').filter(id => id.trim());
    const range = req.query.range || '30d';
    const granularity = req.query.granularity || 'day';
    const cacheKey = `sigs:compare:${sigIds.join('-')}:${granularity}:${range}`;
    const cacheTTL = 60 * 10;

    try {
        if (sigIds.length === 0) {
            return res.status(400).json({ error: 'At least one SIG ID is required' });
        }

        // Check cache
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            console.log(`Cache hit for ${cacheKey}`);
            return res.json(JSON.parse(cachedData));
        }
        console.log(`Cache miss for ${cacheKey}. Querying DB...`);

        const { startDateStr } = parseRange(range);

        // Fetch data for each SIG
        const sigDataPromises = sigIds.map(async (sigId) => {
            const sigResult = await pool.query(
                'SELECT id, name FROM special_interest_groups WHERE id = $1',
                [sigId]
            );

            if (sigResult.rows.length === 0) {
                return null;
            }

            const sig = sigResult.rows[0];

            const dataResult = await pool.query(
                `SELECT snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, 
                        active_contributors, new_commits, lines_added, lines_deleted
                 FROM sig_snapshots
                 WHERE sig_id = $1 AND snapshot_date >= $2
                 ORDER BY snapshot_date ASC`,
                [sigId, startDateStr]
            );

            let timeseriesData = dataResult.rows.map(row => ({
                date: formatDate(row.snapshot_date),
                new_prs: row.new_prs,
                closed_merged_prs: row.closed_merged_prs,
                new_issues: row.new_issues,
                closed_issues: row.closed_issues,
                active_contributors: row.active_contributors,
                new_commits: row.new_commits,
                lines_added: row.lines_added,
                lines_deleted: row.lines_deleted
            }));

            // Apply aggregation
            if (granularity === 'week') {
                timeseriesData = aggregateByWeek(timeseriesData);
            } else if (granularity === 'month') {
                timeseriesData = aggregateByMonth(timeseriesData);
            }

            return {
                id: sig.id,
                name: sig.name,
                timeseries: timeseriesData
            };
        });

        const sigsData = (await Promise.all(sigDataPromises)).filter(sig => sig !== null);

        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(sigsData));

        res.json(sigsData);
    } catch (error) {
        console.error(`Error comparing SIGs:`, error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/organization/growth-analysis - Growth analysis for organization
app.get('/api/v1/organization/growth-analysis', async (req, res) => {
    const range = req.query.range || '30d';
    const cacheKey = `org:${ORG_NAME}:growth:${range}`;
    const cacheTTL = 60 * 10;

    try {
        const org = await getMonitoredOrg();
        if (!org) {
            return res.status(404).json({ error: 'Monitored organization not found.' });
        }

        // Check cache
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            console.log(`Cache hit for ${cacheKey}`);
            return res.json(JSON.parse(cachedData));
        }
        console.log(`Cache miss for ${cacheKey}. Querying DB...`);

        const { startDateStr, days } = parseRange(range);

        // Calculate current period
        const currentEndDate = new Date();
        currentEndDate.setHours(0, 0, 0, 0);
        const currentStartDate = new Date(currentEndDate);
        currentStartDate.setDate(currentEndDate.getDate() - days);

        // Calculate previous period
        const previousEndDate = new Date(currentStartDate);
        previousEndDate.setDate(previousEndDate.getDate() - 1);
        const previousStartDate = new Date(previousEndDate);
        previousStartDate.setDate(previousEndDate.getDate() - days);

        // Query current period
        const currentResult = await pool.query(
            `SELECT 
                COALESCE(SUM(new_prs), 0) as new_prs,
                COALESCE(SUM(closed_merged_prs), 0) as closed_merged_prs,
                COALESCE(SUM(new_issues), 0) as new_issues,
                COALESCE(SUM(closed_issues), 0) as closed_issues,
                COALESCE(SUM(new_commits), 0) as new_commits,
                COALESCE(SUM(lines_added), 0) as lines_added,
                COALESCE(SUM(lines_deleted), 0) as lines_deleted
             FROM activity_snapshots
             WHERE org_id = $1 AND snapshot_date >= $2 AND snapshot_date <= $3`,
            [org.id, formatDate(currentStartDate), formatDate(currentEndDate)]
        );

        // Query previous period
        const previousResult = await pool.query(
            `SELECT 
                COALESCE(SUM(new_prs), 0) as new_prs,
                COALESCE(SUM(closed_merged_prs), 0) as closed_merged_prs,
                COALESCE(SUM(new_issues), 0) as new_issues,
                COALESCE(SUM(closed_issues), 0) as closed_issues,
                COALESCE(SUM(new_commits), 0) as new_commits,
                COALESCE(SUM(lines_added), 0) as lines_added,
                COALESCE(SUM(lines_deleted), 0) as lines_deleted
             FROM activity_snapshots
             WHERE org_id = $1 AND snapshot_date >= $2 AND snapshot_date <= $3`,
            [org.id, formatDate(previousStartDate), formatDate(previousEndDate)]
        );

        const current = currentResult.rows[0];
        const previous = previousResult.rows[0];

        // Calculate growth rates
        const calculateGrowth = (curr, prev) => {
            if (prev === 0) return curr > 0 ? 100 : 0;
            return ((curr - prev) / prev * 100).toFixed(2);
        };

        const growth = {
            prs: parseFloat(calculateGrowth(parseInt(current.new_prs), parseInt(previous.new_prs))),
            issues: parseFloat(calculateGrowth(parseInt(current.new_issues), parseInt(previous.new_issues))),
            commits: parseFloat(calculateGrowth(parseInt(current.new_commits), parseInt(previous.new_commits))),
            lines_added: parseFloat(calculateGrowth(parseInt(current.lines_added), parseInt(previous.lines_added))),
            lines_deleted: parseFloat(calculateGrowth(parseInt(current.lines_deleted), parseInt(previous.lines_deleted)))
        };

        // Convert bigint to number for JSON
        const formatMetrics = (data) => ({
            new_prs: parseInt(data.new_prs),
            closed_merged_prs: parseInt(data.closed_merged_prs),
            new_issues: parseInt(data.new_issues),
            closed_issues: parseInt(data.closed_issues),
            new_commits: parseInt(data.new_commits),
            lines_added: parseInt(data.lines_added),
            lines_deleted: parseInt(data.lines_deleted)
        });

        const responseData = {
            period: {
                current: {
                    start: formatDate(currentStartDate),
                    end: formatDate(currentEndDate),
                    metrics: formatMetrics(current)
                },
                previous: {
                    start: formatDate(previousStartDate),
                    end: formatDate(previousEndDate),
                    metrics: formatMetrics(previous)
                }
            },
            growth: growth
        };

        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(responseData));

        res.json(responseData);
    } catch (error) {
        console.error(`Error fetching growth analysis:`, error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/sig/:sigId/growth-analysis - Growth analysis for SIG
app.get('/api/v1/sig/:sigId/growth-analysis', async (req, res) => {
    const { sigId } = req.params;
    const range = req.query.range || '30d';
    const cacheKey = `sig:${sigId}:growth:${range}`;
    const cacheTTL = 60 * 10;

    try {
        const sigResult = await pool.query('SELECT id, name FROM special_interest_groups WHERE id = $1', [sigId]);
        if (sigResult.rows.length === 0) {
            return res.status(404).json({ error: 'Monitored SIG not found.' });
        }

        // Check cache
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            console.log(`Cache hit for ${cacheKey}`);
            return res.json(JSON.parse(cachedData));
        }
        console.log(`Cache miss for ${cacheKey}. Querying DB...`);

        const { startDateStr, days } = parseRange(range);

        // Calculate periods
        const currentEndDate = new Date();
        currentEndDate.setHours(0, 0, 0, 0);
        const currentStartDate = new Date(currentEndDate);
        currentStartDate.setDate(currentEndDate.getDate() - days);

        const previousEndDate = new Date(currentStartDate);
        previousEndDate.setDate(previousEndDate.getDate() - 1);
        const previousStartDate = new Date(previousEndDate);
        previousStartDate.setDate(previousEndDate.getDate() - days);

        // Query current period
        const currentResult = await pool.query(
            `SELECT 
                COALESCE(SUM(new_prs), 0) as new_prs,
                COALESCE(SUM(closed_merged_prs), 0) as closed_merged_prs,
                COALESCE(SUM(new_issues), 0) as new_issues,
                COALESCE(SUM(closed_issues), 0) as closed_issues,
                COALESCE(SUM(new_commits), 0) as new_commits,
                COALESCE(SUM(lines_added), 0) as lines_added,
                COALESCE(SUM(lines_deleted), 0) as lines_deleted
             FROM sig_snapshots
             WHERE sig_id = $1 AND snapshot_date >= $2 AND snapshot_date <= $3`,
            [sigId, formatDate(currentStartDate), formatDate(currentEndDate)]
        );

        // Query previous period
        const previousResult = await pool.query(
            `SELECT 
                COALESCE(SUM(new_prs), 0) as new_prs,
                COALESCE(SUM(closed_merged_prs), 0) as closed_merged_prs,
                COALESCE(SUM(new_issues), 0) as new_issues,
                COALESCE(SUM(closed_issues), 0) as closed_issues,
                COALESCE(SUM(new_commits), 0) as new_commits,
                COALESCE(SUM(lines_added), 0) as lines_added,
                COALESCE(SUM(lines_deleted), 0) as lines_deleted
             FROM sig_snapshots
             WHERE sig_id = $1 AND snapshot_date >= $2 AND snapshot_date <= $3`,
            [sigId, formatDate(previousStartDate), formatDate(previousEndDate)]
        );

        const current = currentResult.rows[0];
        const previous = previousResult.rows[0];

        // Calculate growth rates
        const calculateGrowth = (curr, prev) => {
            if (prev === 0) return curr > 0 ? 100 : 0;
            return ((curr - prev) / prev * 100).toFixed(2);
        };

        const growth = {
            prs: parseFloat(calculateGrowth(parseInt(current.new_prs), parseInt(previous.new_prs))),
            issues: parseFloat(calculateGrowth(parseInt(current.new_issues), parseInt(previous.new_issues))),
            commits: parseFloat(calculateGrowth(parseInt(current.new_commits), parseInt(previous.new_commits))),
            lines_added: parseFloat(calculateGrowth(parseInt(current.lines_added), parseInt(previous.lines_added))),
            lines_deleted: parseFloat(calculateGrowth(parseInt(current.lines_deleted), parseInt(previous.lines_deleted)))
        };

        const formatMetrics = (data) => ({
            new_prs: parseInt(data.new_prs),
            closed_merged_prs: parseInt(data.closed_merged_prs),
            new_issues: parseInt(data.new_issues),
            closed_issues: parseInt(data.closed_issues),
            new_commits: parseInt(data.new_commits),
            lines_added: parseInt(data.lines_added),
            lines_deleted: parseInt(data.lines_deleted)
        });

        const responseData = {
            sig: sigResult.rows[0],
            period: {
                current: {
                    start: formatDate(currentStartDate),
                    end: formatDate(currentEndDate),
                    metrics: formatMetrics(current)
                },
                previous: {
                    start: formatDate(previousStartDate),
                    end: formatDate(previousEndDate),
                    metrics: formatMetrics(previous)
                }
            },
            growth: growth
        };

        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(responseData));

        res.json(responseData);
    } catch (error) {
        console.error(`Error fetching SIG growth analysis:`, error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/export/csv - Export data to CSV
app.get('/api/v1/export/csv', async (req, res) => {
    const type = req.query.type || 'org'; // org, sig, comparison
    const range = req.query.range || '30d';
    const sigIds = req.query.sigIds ? req.query.sigIds.split(',') : [];
    const granularity = req.query.granularity || 'day';

    try {
        let data = [];
        let filename = 'report.csv';

        if (type === 'org') {
            const org = await getMonitoredOrg();
            if (!org) {
                return res.status(404).json({ error: 'Organization not found' });
            }

            const { startDateStr, days } = parseRange(range);
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - days);

            const result = await pool.query(
                `SELECT snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues,
                        active_contributors, new_commits, lines_added, lines_deleted
                 FROM activity_snapshots
                 WHERE org_id = $1 AND snapshot_date >= $2
                 ORDER BY snapshot_date ASC`,
                [org.id, formatDate(startDate)]
            );

            data = result.rows.map(row => ({
                date: formatDate(row.snapshot_date),
                new_prs: row.new_prs,
                closed_merged_prs: row.closed_merged_prs,
                new_issues: row.new_issues,
                closed_issues: row.closed_issues,
                active_contributors: row.active_contributors,
                new_commits: row.new_commits,
                lines_added: row.lines_added,
                lines_deleted: row.lines_deleted
            }));

            // Apply aggregation if needed
            if (granularity === 'week') {
                data = aggregateByWeek(data);
            } else if (granularity === 'month') {
                data = aggregateByMonth(data);
            }

            filename = `organization_report_${range}_${granularity}.csv`;

        } else if (type === 'sig' && sigIds.length > 0) {
            const sigId = sigIds[0];
            const sigResult = await pool.query('SELECT id, name FROM special_interest_groups WHERE id = $1', [sigId]);
            if (sigResult.rows.length === 0) {
                return res.status(404).json({ error: 'SIG not found' });
            }

            const { startDateStr, days } = parseRange(range);
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - days);

            const result = await pool.query(
                `SELECT snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues,
                        active_contributors, new_commits, lines_added, lines_deleted
                 FROM sig_snapshots
                 WHERE sig_id = $1 AND snapshot_date >= $2
                 ORDER BY snapshot_date ASC`,
                [sigId, formatDate(startDate)]
            );

            data = result.rows.map(row => ({
                date: formatDate(row.snapshot_date),
                new_prs: row.new_prs,
                closed_merged_prs: row.closed_merged_prs,
                new_issues: row.new_issues,
                closed_issues: row.closed_issues,
                active_contributors: row.active_contributors,
                new_commits: row.new_commits,
                lines_added: row.lines_added,
                lines_deleted: row.lines_deleted
            }));

            if (granularity === 'week') {
                data = aggregateByWeek(data);
            } else if (granularity === 'month') {
                data = aggregateByMonth(data);
            }

            filename = `sig_${sigResult.rows[0].name}_report_${range}_${granularity}.csv`;

        } else if (type === 'comparison' && sigIds.length > 0) {
            // Export comparison data with SIG names
            const { startDateStr, days } = parseRange(range);
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - days);

            for (const sigId of sigIds) {
                const sigResult = await pool.query('SELECT id, name FROM special_interest_groups WHERE id = $1', [sigId]);
                if (sigResult.rows.length === 0) continue;

                const result = await pool.query(
                    `SELECT snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues,
                            active_contributors, new_commits, lines_added, lines_deleted
                     FROM sig_snapshots
                     WHERE sig_id = $1 AND snapshot_date >= $2
                     ORDER BY snapshot_date ASC`,
                    [sigId, formatDate(startDate)]
                );

                result.rows.forEach(row => {
                    data.push({
                        sig_name: sigResult.rows[0].name,
                        date: formatDate(row.snapshot_date),
                        new_prs: row.new_prs,
                        closed_merged_prs: row.closed_merged_prs,
                        new_issues: row.new_issues,
                        closed_issues: row.closed_issues,
                        active_contributors: row.active_contributors,
                        new_commits: row.new_commits,
                        lines_added: row.lines_added,
                        lines_deleted: row.lines_deleted
                    });
                });
            }

            filename = `sig_comparison_report_${range}.csv`;
        }

        if (data.length === 0) {
            return res.status(404).json({ error: 'No data available for export' });
        }

        // Convert to CSV
        const parser = new Parser();
        const csv = parser.parse(data);

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csv);

    } catch (error) {
        console.error('Error exporting CSV:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/export/excel - Export data to Excel
app.get('/api/v1/export/excel', async (req, res) => {
    const type = req.query.type || 'org';
    const range = req.query.range || '30d';
    const sigIds = req.query.sigIds ? req.query.sigIds.split(',') : [];
    const granularity = req.query.granularity || 'day';

    try {
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'OSS Dashboard';
        workbook.created = new Date();

        let filename = 'report.xlsx';

        if (type === 'org') {
            const org = await getMonitoredOrg();
            if (!org) {
                return res.status(404).json({ error: 'Organization not found' });
            }

            const { startDateStr, days } = parseRange(range);
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - days);

            // Summary Sheet
            const summarySheet = workbook.addWorksheet('Summary');
            summarySheet.columns = [
                { header: 'Metric', key: 'metric', width: 30 },
                { header: 'Value', key: 'value', width: 15 }
            ];

            const summaryResult = await pool.query(
                `SELECT 
                    COALESCE(SUM(new_prs), 0) as new_prs,
                    COALESCE(SUM(closed_merged_prs), 0) as closed_merged_prs,
                    COALESCE(SUM(new_issues), 0) as new_issues,
                    COALESCE(SUM(closed_issues), 0) as closed_issues,
                    COALESCE(SUM(new_commits), 0) as new_commits,
                    COALESCE(SUM(lines_added), 0) as lines_added,
                    COALESCE(SUM(lines_deleted), 0) as lines_deleted
                 FROM activity_snapshots
                 WHERE org_id = $1 AND snapshot_date >= $2`,
                [org.id, formatDate(startDate)]
            );

            const summary = summaryResult.rows[0];
            summarySheet.addRows([
                { metric: 'Organization', value: org.name },
                { metric: 'Time Range', value: range },
                { metric: 'Granularity', value: granularity },
                { metric: '', value: '' },
                { metric: 'New PRs', value: parseInt(summary.new_prs) },
                { metric: 'Closed/Merged PRs', value: parseInt(summary.closed_merged_prs) },
                { metric: 'New Issues', value: parseInt(summary.new_issues) },
                { metric: 'Closed Issues', value: parseInt(summary.closed_issues) },
                { metric: 'New Commits', value: parseInt(summary.new_commits) },
                { metric: 'Lines Added', value: parseInt(summary.lines_added) },
                { metric: 'Lines Deleted', value: parseInt(summary.lines_deleted) }
            ]);

            // Timeseries Sheet
            const timeseriesSheet = workbook.addWorksheet('Timeseries');
            timeseriesSheet.columns = [
                { header: 'Date', key: 'date', width: 15 },
                { header: 'New PRs', key: 'new_prs', width: 12 },
                { header: 'Closed PRs', key: 'closed_merged_prs', width: 12 },
                { header: 'New Issues', key: 'new_issues', width: 12 },
                { header: 'Closed Issues', key: 'closed_issues', width: 12 },
                { header: 'Contributors', key: 'active_contributors', width: 12 },
                { header: 'Commits', key: 'new_commits', width: 12 },
                { header: 'Lines Added', key: 'lines_added', width: 15 },
                { header: 'Lines Deleted', key: 'lines_deleted', width: 15 }
            ];

            const dataResult = await pool.query(
                `SELECT snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues,
                        active_contributors, new_commits, lines_added, lines_deleted
                 FROM activity_snapshots
                 WHERE org_id = $1 AND snapshot_date >= $2
                 ORDER BY snapshot_date ASC`,
                [org.id, formatDate(startDate)]
            );

            let data = dataResult.rows.map(row => ({
                date: formatDate(row.snapshot_date),
                new_prs: row.new_prs,
                closed_merged_prs: row.closed_merged_prs,
                new_issues: row.new_issues,
                closed_issues: row.closed_issues,
                active_contributors: row.active_contributors,
                new_commits: row.new_commits,
                lines_added: row.lines_added,
                lines_deleted: row.lines_deleted
            }));

            if (granularity === 'week') {
                data = aggregateByWeek(data);
            } else if (granularity === 'month') {
                data = aggregateByMonth(data);
            }

            timeseriesSheet.addRows(data);

            // Style headers
            [summarySheet, timeseriesSheet].forEach(sheet => {
                sheet.getRow(1).font = { bold: true };
                sheet.getRow(1).fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FF4472C4' }
                };
                sheet.getRow(1).font = { color: { argb: 'FFFFFFFF' }, bold: true };
            });

            filename = `organization_report_${range}_${granularity}.xlsx`;

        } else if (type === 'comparison' && sigIds.length > 0) {
            // Create a sheet for each SIG
            const { startDateStr, days } = parseRange(range);
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - days);

            for (const sigId of sigIds) {
                const sigResult = await pool.query('SELECT id, name FROM special_interest_groups WHERE id = $1', [sigId]);
                if (sigResult.rows.length === 0) continue;

                const sig = sigResult.rows[0];
                const sheet = workbook.addWorksheet(sig.name.substring(0, 31)); // Excel sheet name limit

                sheet.columns = [
                    { header: 'Date', key: 'date', width: 15 },
                    { header: 'New PRs', key: 'new_prs', width: 12 },
                    { header: 'Closed PRs', key: 'closed_merged_prs', width: 12 },
                    { header: 'New Issues', key: 'new_issues', width: 12 },
                    { header: 'Closed Issues', key: 'closed_issues', width: 12 },
                    { header: 'Contributors', key: 'active_contributors', width: 12 },
                    { header: 'Commits', key: 'new_commits', width: 12 },
                    { header: 'Lines Added', key: 'lines_added', width: 15 },
                    { header: 'Lines Deleted', key: 'lines_deleted', width: 15 }
                ];

                const dataResult = await pool.query(
                    `SELECT snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues,
                            active_contributors, new_commits, lines_added, lines_deleted
                     FROM sig_snapshots
                     WHERE sig_id = $1 AND snapshot_date >= $2
                     ORDER BY snapshot_date ASC`,
                    [sigId, formatDate(startDate)]
                );

                let data = dataResult.rows.map(row => ({
                    date: formatDate(row.snapshot_date),
                    new_prs: row.new_prs,
                    closed_merged_prs: row.closed_merged_prs,
                    new_issues: row.new_issues,
                    closed_issues: row.closed_issues,
                    active_contributors: row.active_contributors,
                    new_commits: row.new_commits,
                    lines_added: row.lines_added,
                    lines_deleted: row.lines_deleted
                }));

                if (granularity === 'week') {
                    data = aggregateByWeek(data);
                } else if (granularity === 'month') {
                    data = aggregateByMonth(data);
                }

                sheet.addRows(data);

                // Style headers
                sheet.getRow(1).font = { bold: true };
                sheet.getRow(1).fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FF4472C4' }
                };
                sheet.getRow(1).font = { color: { argb: 'FFFFFFFF' }, bold: true };
            }

            filename = `sig_comparison_report_${range}.xlsx`;
        }

        // Generate buffer and send
        const buffer = await workbook.xlsx.writeBuffer();

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buffer);

    } catch (error) {
        console.error('Error exporting Excel:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST /api/v1/export/pdf - Export data to PDF (中文版)
app.post('/api/v1/export/pdf', async (req, res) => {
    try {
        const { type, range, sigIds, summary, growthData, sigData, contributors, timeseries } = req.body;

        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const buffers = [];

        // 注册中文字体 (SimHei 黑体)
        const chineseFontPath = path.join(__dirname, 'fonts', 'simhei.ttf');
        doc.registerFont('SimHei', chineseFontPath);
        doc.font('SimHei');

        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => {
            const pdfData = Buffer.concat(buffers);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="report_${Date.now()}.pdf"`);
            res.send(pdfData);
        });

        // 确定时间范围描述
        const rangeLabel = {
            '7d': '7天', '30d': '30天', '90d': '90天',
            '180d': '180天', '365d': '1年', 'all': '全部'
        }[range] || range;

        // === 第一页：概览 ===
        doc.fontSize(24).text('开源社区活动报告', { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(12).fillColor('#666666').text(`生成时间: ${new Date().toLocaleString('zh-CN')}`, { align: 'center' });
        doc.text(`统计范围: ${rangeLabel}`, { align: 'center' });
        doc.moveDown(2);

        // 概览统计
        doc.fillColor('#000000').fontSize(16).text('概览统计', { underline: true });
        doc.moveDown();

        if (summary) {
            doc.fontSize(11);
            const summaryItems = [
                ['新 Pull Requests', summary.new_prs || 0],
                ['已合并 PRs', summary.closed_merged_prs || 0],
                ['新 Issues', summary.new_issues || 0],
                ['新 Commits', summary.new_commits || 0],
                ['新增代码行', (summary.lines_added || 0).toLocaleString()],
                ['删除代码行', (summary.lines_deleted || 0).toLocaleString()],
                ['活跃贡献者', summary.active_contributors || 0]
            ];

            summaryItems.forEach(([label, value]) => {
                doc.text(`${label}: ${value}`);
            });
            doc.moveDown(1.5);
        }

        // 增长分析
        if (growthData && growthData.growth) {
            doc.fontSize(16).text('增长分析', { underline: true });
            doc.moveDown();
            doc.fontSize(11);

            const formatGrowth = (val) => val > 0 ? `+${val}%` : `${val}%`;
            doc.text(`PR 增长: ${formatGrowth(growthData.growth.prs)}`);
            doc.text(`Issue 增长: ${formatGrowth(growthData.growth.issues)}`);
            doc.text(`Commit 增长: ${formatGrowth(growthData.growth.commits)}`);
            doc.text(`代码增长: ${formatGrowth(growthData.growth.lines_added)}`);
            doc.moveDown(1.5);
        }

        // 周期对比
        if (growthData && growthData.period) {
            doc.fontSize(16).text('周期对比', { underline: true });
            doc.moveDown();
            doc.fontSize(11);

            doc.text(`当前周期: ${growthData.period.current.start} 至 ${growthData.period.current.end}`);
            if (growthData.period.current.metrics) {
                const curr = growthData.period.current.metrics;
                doc.text(`  PRs: ${curr.new_prs}, Issues: ${curr.new_issues}, Commits: ${curr.new_commits}`);
            }
            doc.moveDown(0.5);

            doc.text(`上一周期: ${growthData.period.previous.start} 至 ${growthData.period.previous.end}`);
            if (growthData.period.previous.metrics) {
                const prev = growthData.period.previous.metrics;
                doc.text(`  PRs: ${prev.new_prs}, Issues: ${prev.new_issues}, Commits: ${prev.new_commits}`);
            }
            doc.moveDown(1.5);
        }

        // === SIG 排行榜 ===
        if (sigData && sigData.length > 0) {
            doc.fontSize(14).text('SIG 活动排行', { underline: true });
            doc.moveDown(0.5);
            doc.fontSize(10);

            // 使用表格布局
            const sigTableTop = doc.y;
            const sigColWidths = [40, 180, 60, 60, 60]; // 排名, 名称, PRs, Issues, Commits
            const sigHeaders = ['排名', 'SIG名称', 'PRs', 'Issues', 'Commits'];

            // 表头
            let xPos = 50;
            sigHeaders.forEach((header, i) => {
                doc.text(header, xPos, sigTableTop, { width: sigColWidths[i], align: i === 0 ? 'left' : (i === 1 ? 'left' : 'right') });
                xPos += sigColWidths[i];
            });
            doc.moveTo(50, sigTableTop + 15).lineTo(450, sigTableTop + 15).stroke();
            doc.y = sigTableTop + 20;

            // 数据行
            sigData.slice(0, 10).forEach((sig, index) => {
                const rowY = doc.y;
                xPos = 50;
                const rowData = [
                    `${index + 1}`,
                    (sig.name || '').substring(0, 25),
                    `${sig.prs || 0}`,
                    `${sig.issues || 0}`,
                    `${sig.commits || 0}`
                ];
                rowData.forEach((cell, i) => {
                    doc.text(cell, xPos, rowY, { width: sigColWidths[i], align: i === 0 ? 'left' : (i === 1 ? 'left' : 'right') });
                    xPos += sigColWidths[i];
                });
                doc.y = rowY + 14;
            });
            doc.moveDown(1.5);
        }

        // === 贡献者排行榜 ===
        if (contributors && contributors.length > 0) {
            doc.addPage();
            doc.font('SimHei');
            doc.fontSize(14).text('贡献者排行榜 TOP 20', { underline: true });
            doc.moveDown(0.5);
            doc.fontSize(10);

            const contribTableTop = doc.y;
            const contribColWidths = [40, 140, 50, 50, 60, 60]; // 排名, 用户名, PRs, Issues, Commits, 总活动
            const contribHeaders = ['排名', '贡献者', 'PRs', 'Issues', 'Commits', '总活动'];

            // 表头
            let xPos = 50;
            contribHeaders.forEach((header, i) => {
                doc.text(header, xPos, contribTableTop, { width: contribColWidths[i], align: i <= 1 ? 'left' : 'right' });
                xPos += contribColWidths[i];
            });
            doc.moveTo(50, contribTableTop + 15).lineTo(450, contribTableTop + 15).stroke();
            doc.y = contribTableTop + 20;

            contributors.slice(0, 20).forEach((c, index) => {
                const rowY = doc.y;
                xPos = 50;
                const rowData = [
                    `${index + 1}`,
                    (c.github_username || '').substring(0, 18),
                    `${c.stats?.prs_total || 0}`,
                    `${c.stats?.issues_total || 0}`,
                    `${c.stats?.commits_count || 0}`,
                    `${c.stats?.total_activities || 0}`
                ];
                rowData.forEach((cell, i) => {
                    doc.text(cell, xPos, rowY, { width: contribColWidths[i], align: i <= 1 ? 'left' : 'right' });
                    xPos += contribColWidths[i];
                });
                doc.y = rowY + 14;
            });
        }

        // === 趋势数据（可选）===
        if (timeseries && timeseries.length > 0 && timeseries.length <= 31) {
            doc.addPage();
            doc.font('SimHei');
            doc.fontSize(14).text('每日趋势数据', { underline: true });
            doc.moveDown(0.5);
            doc.fontSize(9);

            const tsTableTop = doc.y;
            const tsColWidths = [75, 50, 50, 55, 70, 70];
            const tsHeaders = ['日期', 'PRs', 'Issues', 'Commits', '新增行', '删除行'];

            let xPos = 50;
            tsHeaders.forEach((header, i) => {
                doc.text(header, xPos, tsTableTop, { width: tsColWidths[i], align: i === 0 ? 'left' : 'right' });
                xPos += tsColWidths[i];
            });
            doc.moveTo(50, tsTableTop + 12).lineTo(420, tsTableTop + 12).stroke();
            doc.y = tsTableTop + 16;

            timeseries.forEach(row => {
                const rowY = doc.y;
                xPos = 50;
                const rowData = [
                    row.date || '',
                    `${row.new_prs || 0}`,
                    `${row.new_issues || 0}`,
                    `${row.new_commits || 0}`,
                    `${(row.lines_added || 0).toLocaleString()}`,
                    `${(row.lines_deleted || 0).toLocaleString()}`
                ];
                rowData.forEach((cell, i) => {
                    doc.text(cell, xPos, rowY, { width: tsColWidths[i], align: i === 0 ? 'left' : 'right' });
                    xPos += tsColWidths[i];
                });
                doc.y = rowY + 12;
            });
        }

        doc.end();

    } catch (error) {
        console.error('Error exporting PDF:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Day Detail API Routes ---

// GET /api/v1/organization/day/:date - Get detailed activity for a specific date
app.get('/api/v1/organization/day/:date', async (req, res) => {
    const { date } = req.params;
    const cacheKey = `org:day:${date}`;
    const cacheTTL = 60 * 30; // 30 minutes

    try {
        // Check cache
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            console.log(`Cache hit for ${cacheKey}`);
            return res.json(JSON.parse(cachedData));
        }

        const org = await getMonitoredOrg();
        if (!org) {
            return res.status(404).json({ error: 'Organization not found' });
        }

        // Get organization summary for this date
        const dailySummaryResult = await pool.query(
            `SELECT new_prs, closed_merged_prs, new_issues, closed_issues, 
                    active_contributors, new_commits, lines_added, lines_deleted
             FROM activity_snapshots
             WHERE org_id = $1 AND snapshot_date = $2`,
            [org.id, date]
        );

        // Get repo-level breakdown for this date
        const repoBreakdownResult = await pool.query(
            `SELECT r.name as repo_name, r.id as repo_id, 
                    rs.new_prs, rs.closed_merged_prs, rs.new_issues, rs.closed_issues,
                    rs.new_commits, rs.active_contributors
             FROM repo_snapshots rs
             JOIN repositories r ON rs.repo_id = r.id
             WHERE r.org_id = $1 AND rs.snapshot_date = $2
               AND (rs.new_prs > 0 OR rs.new_issues > 0 OR rs.new_commits > 0)
             ORDER BY (rs.new_prs + rs.new_issues + rs.new_commits) DESC`,
            [org.id, date]
        );

        // Get contributors active on this date
        const contributorsResult = await pool.query(
            `SELECT c.github_username, c.avatar_url,
                    cda.prs_opened, cda.prs_closed, cda.issues_opened, cda.issues_closed, cda.commits_count
             FROM contributor_daily_activities cda
             JOIN contributors c ON cda.contributor_id = c.id
             JOIN organizations o ON cda.org_id = o.id
             WHERE o.id = $1 AND cda.snapshot_date = $2
               AND ${HUMAN_CONTRIBUTOR_SQL}
               AND (cda.prs_opened > 0 OR cda.prs_closed > 0 OR cda.issues_opened > 0 OR cda.issues_closed > 0 OR cda.commits_count > 0)
             ORDER BY (cda.prs_opened + cda.prs_closed + cda.issues_opened + cda.issues_closed + cda.commits_count) DESC
             LIMIT 50`,
            [org.id, date]
        );

        const contributorCountResult = await pool.query(
            `SELECT COUNT(DISTINCT cda.contributor_id) as active_contributors
             FROM contributor_daily_activities cda
             JOIN contributors c ON cda.contributor_id = c.id
             WHERE cda.org_id = $1 AND cda.snapshot_date = $2
               AND ${HUMAN_CONTRIBUTOR_SQL}
               AND (cda.prs_opened > 0 OR cda.prs_closed > 0 OR cda.issues_opened > 0 OR cda.issues_closed > 0 OR cda.commits_count > 0)`,
            [org.id, date]
        );

        const responseData = {
            date,
            summary: dailySummaryResult.rows[0] ? {
                ...dailySummaryResult.rows[0],
                active_contributors: parseInt(contributorCountResult.rows[0]?.active_contributors || 0, 10),
            } : {
                new_prs: 0, closed_merged_prs: 0, new_issues: 0, closed_issues: 0,
                active_contributors: 0, new_commits: 0, lines_added: 0, lines_deleted: 0
            },
            repos: repoBreakdownResult.rows.map(r => ({
                name: r.repo_name,
                id: r.repo_id,
                prs: { opened: r.new_prs, closed: r.closed_merged_prs },
                issues: { opened: r.new_issues, closed: r.closed_issues },
                commits: r.new_commits
            })),
            contributors: contributorsResult.rows.map(c => ({
                username: c.github_username,
                avatar_url: c.avatar_url,
                prs: { opened: c.prs_opened, closed: c.prs_closed },
                issues: { opened: c.issues_opened, closed: c.issues_closed },
                commits: c.commits_count
            }))
        };

        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(responseData));

        res.json(responseData);
    } catch (error) {
        console.error(`Error fetching day ${date} details:`, error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/sig/:sigId/contributors - Get contributors for a specific SIG
app.get('/api/v1/sig/:sigId/contributors', async (req, res) => {
    const { sigId } = req.params;
    const range = req.query.range || '30d';
    const cacheKey = `sig:${sigId}:contributors:${range}`;
    const cacheTTL = 60 * 10;

    try {
        // Check cache
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            return res.json(JSON.parse(cachedData));
        }

        const { startDateStr } = parseRange(range);

        // Get SIG info
        const sigResult = await pool.query('SELECT name FROM special_interest_groups WHERE id = $1', [sigId]);
        if (sigResult.rows.length === 0) {
            return res.status(404).json({ error: 'SIG not found' });
        }

        // Get contributors active in this SIG's repos
        const contributorsResult = await pool.query(
            `SELECT c.github_username, c.avatar_url,
                    SUM(cra.prs_opened) as prs_opened,
                    SUM(cra.prs_closed) as prs_closed,
                    SUM(cra.issues_opened) as issues_opened,
                    SUM(cra.issues_closed) as issues_closed
             FROM contributor_repo_activities cra
             JOIN contributors c ON cra.contributor_id = c.id
             JOIN repositories r ON cra.repo_id = r.id
             WHERE r.sig_id = $1 AND cra.snapshot_date >= $2
               AND ${HUMAN_CONTRIBUTOR_SQL}
             GROUP BY c.id, c.github_username, c.avatar_url
             HAVING SUM(cra.prs_opened + cra.issues_opened) > 0
             ORDER BY SUM(cra.prs_opened + cra.issues_opened) DESC
             LIMIT 50`,
            [sigId, startDateStr]
        );

        const responseData = {
            sig: {
                id: sigId,
                name: sigResult.rows[0].name
            },
            contributors: contributorsResult.rows.map(c => ({
                username: c.github_username,
                avatar_url: c.avatar_url,
                prs: { opened: parseInt(c.prs_opened), closed: parseInt(c.prs_closed) },
                issues: { opened: parseInt(c.issues_opened), closed: parseInt(c.issues_closed) },
                // Use only opened count to match chart metrics
                total: parseInt(c.prs_opened) + parseInt(c.issues_opened)
            }))
        };

        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(responseData));

        res.json(responseData);
    } catch (error) {
        console.error(`Error fetching SIG ${sigId} contributors:`, error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Contributor API Routes ---

// GET /api/v1/contributors/leaderboard - 贡献者排行榜
app.get('/api/v1/contributors/leaderboard', async (req, res) => {
    const range = req.query.range || '30d';
    const metric = req.query.metric || 'total'; // total, prs, issues, commits
    const limit = parseInt(req.query.limit) || 50;
    const cacheKey = `contributors:leaderboard:${range}:${metric}:${limit}`;
    const cacheTTL = 60 * 10;

    try {
        // Check cache
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            console.log(`Cache hit for ${cacheKey}`);
            return res.json(JSON.parse(cachedData));
        }

        const { startDateStr } = parseRange(range);

        let orderBy = 'total_activities';
        if (metric === 'prs') orderBy = 'prs_total';
        else if (metric === 'issues') orderBy = 'issues_total';
        else if (metric === 'commits') orderBy = 'commits_count';

        const query = `
            SELECT 
                c.github_username,
                c.avatar_url,
                c.first_seen_date,
                c.last_seen_date,
                COALESCE(SUM(cda.prs_opened), 0) as prs_opened,
                COALESCE(SUM(cda.prs_closed), 0) as prs_closed,
                COALESCE(SUM(cda.prs_opened + cda.prs_closed), 0) as prs_total,
                COALESCE(SUM(cda.issues_opened), 0) as issues_opened,
                COALESCE(SUM(cda.issues_closed), 0) as issues_closed,
                COALESCE(SUM(cda.issues_opened + cda.issues_closed), 0) as issues_total,
                COALESCE(SUM(cda.commits_count), 0) as commits_count,
                COALESCE(SUM(cda.prs_opened + cda.prs_closed + cda.issues_opened + cda.issues_closed + cda.commits_count), 0) as total_activities,
                COUNT(DISTINCT cda.snapshot_date) as active_days
            FROM contributors c
            JOIN contributor_daily_activities cda ON c.id = cda.contributor_id
            WHERE cda.snapshot_date >= $1
              AND ${HUMAN_CONTRIBUTOR_SQL}
            GROUP BY c.id, c.github_username, c.avatar_url, c.first_seen_date, c.last_seen_date
            HAVING SUM(cda.prs_opened + cda.prs_closed + cda.issues_opened + cda.issues_closed + cda.commits_count) > 0
            ORDER BY ${orderBy} DESC
            LIMIT $2
        `;

        const result = await pool.query(query, [startDateStr, limit]);

        const responseData = result.rows.map(row => ({
            username: row.github_username,
            avatar_url: row.avatar_url,
            first_seen: formatDate(row.first_seen_date),
            last_seen: formatDate(row.last_seen_date),
            stats: {
                prs_opened: parseInt(row.prs_opened),
                prs_closed: parseInt(row.prs_closed),
                prs_total: parseInt(row.prs_total),
                issues_opened: parseInt(row.issues_opened),
                issues_closed: parseInt(row.issues_closed),
                issues_total: parseInt(row.issues_total),
                commits_count: parseInt(row.commits_count),
                total_activities: parseInt(row.total_activities),
                active_days: parseInt(row.active_days)
            }
        }));

        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(responseData));

        res.json(responseData);
    } catch (error) {
        console.error('Error fetching contributor leaderboard:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/contributors/stats - 贡献者统计概览
app.get('/api/v1/contributors/stats', async (req, res) => {
    const range = req.query.range || '30d';
    const cacheKey = `contributors:stats:${range}`;
    const cacheTTL = 60 * 10;

    try {
        // Check cache
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            return res.json(JSON.parse(cachedData));
        }

        const { startDateStr } = parseRange(range);

        // 总贡献者数（去重）
        const uniqueContributorsResult = await pool.query(
            `SELECT COUNT(DISTINCT cda.contributor_id) as count
             FROM contributor_daily_activities cda
             JOIN contributors c ON cda.contributor_id = c.id
             WHERE cda.snapshot_date >= $1
               AND ${HUMAN_CONTRIBUTOR_SQL}`,
            [startDateStr]
        );

        // 新贡献者数（首次出现在该时间范围内）
        const newContributorsResult = await pool.query(
            `SELECT COUNT(*) as count
             FROM contributors
             WHERE first_seen_date >= $1
               AND ${buildHumanContributorSqlCondition('contributors.github_username')}`,
            [startDateStr]
        );

        // 最活跃的一天
        const mostActiveDayResult = await pool.query(
            `SELECT cda.snapshot_date, COUNT(DISTINCT cda.contributor_id) as contributor_count
             FROM contributor_daily_activities cda
             JOIN contributors c ON cda.contributor_id = c.id
             WHERE cda.snapshot_date >= $1
               AND ${HUMAN_CONTRIBUTOR_SQL}
             GROUP BY cda.snapshot_date
             ORDER BY contributor_count DESC
             LIMIT 1`,
            [startDateStr]
        );

        const responseData = {
            unique_contributors: parseInt(uniqueContributorsResult.rows[0].count),
            new_contributors: parseInt(newContributorsResult.rows[0].count),
            most_active_day: mostActiveDayResult.rows[0] ? {
                date: formatDate(mostActiveDayResult.rows[0].snapshot_date),
                contributor_count: parseInt(mostActiveDayResult.rows[0].contributor_count)
            } : null
        };

        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(responseData));

        res.json(responseData);
    } catch (error) {
        console.error('Error fetching contributor stats:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/contributors/:username - 贡献者详情
app.get('/api/v1/contributors/:username', async (req, res) => {
    const { username } = req.params;
    const range = req.query.range || '30d';
    const cacheKey = `contributors:${username}:${range}`;
    const cacheTTL = 60 * 10;

    try {
        if (isBotContributor(username)) {
            return res.status(404).json({ error: 'Contributor not found' });
        }

        // Check cache
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            return res.json(JSON.parse(cachedData));
        }

        // 获取贡献者基本信息
        const contributorResult = await pool.query(
            `SELECT * FROM contributors WHERE github_username = $1`,
            [username]
        );

        if (contributorResult.rows.length === 0) {
            return res.status(404).json({ error: 'Contributor not found' });
        }

        const contributor = contributorResult.rows[0];

        // 获取活动历史
        const { startDateStr } = parseRange(range);

        const activitiesResult = await pool.query(
            `SELECT snapshot_date, prs_opened, prs_closed, issues_opened, issues_closed, commits_count
             FROM contributor_daily_activities
             WHERE contributor_id = $1 AND snapshot_date >= $2
             ORDER BY snapshot_date ASC`,
            [contributor.id, startDateStr]
        );

        // 获取活跃仓库
        const reposResult = await pool.query(
            `SELECT r.name, r.id,
                    SUM(cra.prs_opened + cra.prs_closed + cra.issues_opened + cra.issues_closed) as total_activities
             FROM contributor_repo_activities cra
             JOIN repositories r ON cra.repo_id = r.id
             WHERE cra.contributor_id = $1 AND cra.snapshot_date >= $2
             GROUP BY r.id, r.name
             ORDER BY total_activities DESC`,
            [contributor.id, startDateStr]
        );

        const responseData = {
            contributor: {
                username: contributor.github_username,
                avatar_url: contributor.avatar_url,
                github_id: contributor.github_id,
                first_seen: formatDate(contributor.first_seen_date),
                last_seen: formatDate(contributor.last_seen_date)
            },
            activities: activitiesResult.rows.map(row => ({
                date: formatDate(row.snapshot_date),
                prs_opened: row.prs_opened,
                prs_closed: row.prs_closed,
                issues_opened: row.issues_opened,
                issues_closed: row.issues_closed,
                commits_count: row.commits_count
            })),
            active_repos: reposResult.rows.map(row => ({
                name: row.name,
                id: row.id,
                total_activities: parseInt(row.total_activities)
            }))
        };

        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(responseData));

        res.json(responseData);
    } catch (error) {
        console.error(`Error fetching contributor ${username}:`, error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Server Start ---
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);

    // Ensure repo storage path exists
    try {
        await fs.mkdir(REPO_STORAGE_PATH, { recursive: true });
    } catch (e) {
        console.error('Error creating repo storage path:', e.message);
    }

    if (ENABLE_STARTUP_CACHE_FLUSH) {
        try {
            await redisClient.flushAll();
            console.log('Redis cache cleared on startup.');
        } catch (e) {
            console.error('Failed to clear Redis cache:', e.message);
        }
    } else {
        console.log('Skipping Redis cache flush on startup. Set ENABLE_STARTUP_CACHE_FLUSH=true to enable it.');
    }

    if (ENABLE_STARTUP_BACKFILL) {
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const startDate = new Date(today);
            startDate.setDate(today.getDate() - STARTUP_BACKFILL_DAYS);

            console.log('========================================');
            console.log('开始数据采集任务');
            console.log('========================================');
            console.log(`📅 采集范围: ${formatDate(startDate)} 到 ${formatDate(today)} (${STARTUP_BACKFILL_DAYS + 1} 天)`);
            console.log('========================================\n');

            await runBackfillJob(STARTUP_BACKFILL_DAYS);
        } catch (e) {
            console.error('Startup backfill error:', e.message);
        }
    } else {
        console.log('Skipping startup backfill. Set ENABLE_STARTUP_BACKFILL=true to enable it.');
    }
});
