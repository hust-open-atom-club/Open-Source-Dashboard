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
    fetchCommitHistoryViaGraphQL,
    fetchCommitsViaGraphQL,
} = require('./github_commit_history');
const {
    isBotContributor,
    buildHumanContributorSqlCondition,
} = require('./contributor_filters');
const {
    DEFAULT_PROPERTY_NAME,
    syncRepositorySigsFromGitHub,
} = require('./repository_sig_sync');
const {
    MAX_RATE_LIMIT_RETRIES,
    getPrimaryRateLimitWaitMs,
} = require('./github_rate_limit');
const { collectRepoApiStats } = require('./repo_api_ingestion');
const { collectSnapshotBatch, publishSnapshotBatch, readSnapshotGeneration, invalidateSnapshotCaches } = require('./snapshot_batch');
const { backfillSnapshotDates } = require('./snapshot_backfill');
const { installSnapshotCache } = require('./snapshot_cache');
const { repairMissingRepositoryHistory } = require('./repository_history_backfill');
const {
    REPOSITORY_INSIGHTS_SQL,
    mapRepositoryInsightRows,
} = require('./repository_insights');
const {
    buildOrganizationSummaryCacheKey,
    normalizeTimestamp,
    withDataFreshness,
} = require('./data_freshness');
const {
    buildComparisonPeriods,
    calculateGrowthMetrics,
    formatGrowthMetrics,
    hasCompletePeriodDates,
} = require('./growth_analysis');
const {
    INGESTION_CRON_SCHEDULE_ENV_VAR,
    resolveIngestionCronSchedule,
} = require('./cron_schedule');

const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_API_BASE = 'https://api.github.com';
const ORG_NAME = 'hust-open-atom-club';
const HUMAN_CONTRIBUTOR_SQL = buildHumanContributorSqlCondition('c.github_username');
const TRACKED_CONTRIBUTOR_ACTIVITY_SQL = `EXISTS (
    SELECT 1
    FROM contributor_repo_activities tracked_cra
    JOIN repositories tracked_repo ON tracked_repo.id = tracked_cra.repo_id
    WHERE tracked_cra.contributor_id = cda.contributor_id
      AND tracked_cra.snapshot_date = cda.snapshot_date
      AND tracked_repo.org_id = cda.org_id
      AND tracked_repo.sig_id IS NOT NULL
)`;
const REPOSITORY_ATTRIBUTED_COMMITS_SQL = `EXISTS (
    SELECT 1
    FROM contributor_repo_activities attributed_cra
    JOIN repositories attributed_repo ON attributed_repo.id = attributed_cra.repo_id
    WHERE attributed_cra.contributor_id = cda.contributor_id
      AND attributed_cra.snapshot_date = cda.snapshot_date
      AND attributed_repo.org_id = cda.org_id
      AND (
          attributed_cra.commits_count <> 0
          OR attributed_cra.lines_added <> 0
          OR attributed_cra.lines_deleted <> 0
      )
)`;
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

const redisConnectionPromise = connectRedis();

async function synchronizeRepositoryMetadata() {
    const result = await syncRepositorySigsFromGitHub({
        pool,
        githubToken: GITHUB_TOKEN,
        orgName: ORG_NAME,
        propertyName: process.env.GITHUB_SIG_PROPERTY || DEFAULT_PROPERTY_NAME,
    });

    console.log(
        `[Repository SIG Sync] ${result.repositories} repositories: ` +
        `${result.tracked} tracked, ${result.untracked} untracked, ${result.changes.length} changed.`
    );

    if (result.changes.length > 0 && redisClient.isOpen) {
        const org = await getMonitoredOrg();
        if (org) await invalidateSnapshotCaches(redisClient, pool, org.id, ORG_NAME);
        console.log('[Repository SIG Sync] Redis cache cleared after historical re-aggregation.');
    }

    return result;
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
            if (response.data.incomplete_results) {
                throw new Error('GitHub returned incomplete search results');
            }
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
async function githubGraphQL(query, variables = {}, retryCount = 0) {
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
        const waitTime = getPrimaryRateLimitWaitMs(error);
        if (waitTime !== null && retryCount < MAX_RATE_LIMIT_RETRIES) {
            console.warn(`GraphQL primary rate limit exhausted. Waiting ${Math.ceil(waitTime / 1000)} seconds...`);
            await delay(waitTime);
            return githubGraphQL(query, variables, retryCount + 1);
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
 * @returns {Promise<{statsMap: Map<string, object>, contributorDetailsMap: Map<string, Map>}>}
 */
async function fetchRepoStatsViaGraphQL(repoName, startDate, endDate, graphQLClient = githubGraphQL) {
    return require('./github_repo_history').fetchRepoStatsViaGraphQL(repoName, startDate, endDate, graphQLClient, ORG_NAME);
}
// Collection performs no snapshot writes. Publish one complete organization/day.
async function runDailyIngestionJob() {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - 1);
    targetDate.setHours(0, 0, 0, 0);
    const snapshotDate = formatDate(targetDate);
    try {
        await synchronizeRepositoryMetadata();
        const org = await getMonitoredOrg();
        if (!org) return;
        const { rows: repositories } = await pool.query(
            'SELECT id, name, sig_id FROM repositories WHERE org_id = $1 AND sig_id IS NOT NULL AND is_in_organization = TRUE ORDER BY id', [org.id]);
        if (!repositories.length) return;
        const expectedGeneration = await readSnapshotGeneration(pool, org.id);
        const entries = await collectSnapshotBatch({ repositories, snapshotDate,
            collectCommits: repo => fetchCommitsViaGraphQL(repo.name, targetDate, githubGraphQL, ORG_NAME),
            collectApi: repo => collectRepoApiStats({ githubRest, orgName: ORG_NAME, repoName: repo.name, snapshotDate }),
        });
        await publishSnapshotBatch({ pool, orgId: org.id, orgName: ORG_NAME, snapshotDate,
            repositories, entries, expectedGeneration, markFresh: true,
            afterCommit: () => invalidateSnapshotCaches(redisClient, pool, org.id, ORG_NAME),
        });
        console.log('Daily snapshot published:', snapshotDate);
        // Historical repair is independent of today's freshness. A failed
        // repair never undoes or mislabels the successfully published daily job.
        try {
            const repair = await repairMissingRepositoryHistory({ pool, orgId: org.id, orgName: ORG_NAME,
                fetchCommits: (repo, first, last) => fetchCommitHistoryViaGraphQL(repo.name, first, last, githubGraphQL, ORG_NAME),
                fetchApi: (repo, first, last) => fetchRepoStatsViaGraphQL(repo.name, first, last),
                afterCommit: () => invalidateSnapshotCaches(redisClient, pool, org.id, ORG_NAME),
            });
            console.log('Repository history coverage repair:', repair);
        } catch (error) {
            console.error('Daily snapshot committed; repository history repair failed:', error.message);
        }
    } catch (error) {
        console.error('Daily ingestion failed:', error);
    }
}

async function runBackfillJob(days = 7) {
    await synchronizeRepositoryMetadata();
    const org = await getMonitoredOrg();
    if (!org) return;
    const { rows: repositories } = await pool.query(
        'SELECT id, name, sig_id FROM repositories WHERE org_id = $1 AND sig_id IS NOT NULL AND is_in_organization = TRUE ORDER BY id', [org.id]);
    if (!repositories.length) return;
    const existing = await pool.query('SELECT snapshot_date FROM activity_snapshots WHERE org_id = $1', [org.id]);
    const completed = new Set(existing.rows.map(row => formatDate(new Date(row.snapshot_date))));
    const dates = [];
    for (let i = days; i >= 1; i--) {
        const date = new Date();
        date.setHours(0, 0, 0, 0);
        date.setDate(date.getDate() - i);
        if (!completed.has(formatDate(date))) dates.push(date);
    }
    await backfillSnapshotDates({ pool, orgId: org.id, orgName: ORG_NAME, repositories, dates,
        fetchCommits: (repo, start, end) => fetchCommitHistoryViaGraphQL(repo.name, start, end, githubGraphQL, ORG_NAME),
        fetchApi: (repo, start, end) => fetchRepoStatsViaGraphQL(repo.name, start, end),
        afterCommit: () => invalidateSnapshotCaches(redisClient, pool, org.id, ORG_NAME),
    });
}

// Data collection runs on a configurable cron schedule and defaults to every 6 hours.
// Validate before registering so a bad value fails startup instead of leaving the
// service running with an unusable schedule.
let ingestionCronSchedule;
try {
    ingestionCronSchedule = resolveIngestionCronSchedule(process.env[INGESTION_CRON_SCHEDULE_ENV_VAR]);
} catch (error) {
    console.error(`[Startup] Invalid data collection schedule: ${error.message}`);
    process.exit(1);
}

cron.schedule(ingestionCronSchedule, runDailyIngestionJob);
console.log(`[Startup] Data collection scheduled with cron expression "${ingestionCronSchedule}".`);

// --- API Routes ---
installSnapshotCache(app, redisClient, pool, ORG_NAME);

// Helper function for security check (now simplified for single org)
async function getMonitoredOrg() {
    const orgResult = await pool.query(
        "SELECT id, name, last_ingestion_completed_at FROM organizations WHERE name = $1",
        [ORG_NAME],
    );
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

// GET /api/v1/organization/repositories - Repository-level activity in a selected range
app.get('/api/v1/organization/repositories', async (req, res) => {
    const range = req.query.range || '30d';
    const cacheKey = `org:${ORG_NAME}:repositories:range:${range}`;
    const cacheTTL = 60 * 10;

    try {
        const org = await getMonitoredOrg();
        if (!org) {
            return res.status(404).json({ error: 'Monitored organization not found.' });
        }

        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            return res.json(JSON.parse(cachedData));
        }

        const { startDateStr } = parseRange(range);
        const result = await pool.query(REPOSITORY_INSIGHTS_SQL, [org.id, startDateStr]);
        const repositories = mapRepositoryInsightRows(result.rows, ORG_NAME);
        const responseData = {
            range,
            repositories,
        };

        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(responseData));
        res.json(responseData);
    } catch (error) {
        console.error('Error fetching repository insights:', error.message);
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
    const cacheTTL = 60 * 10; // 缓存10分钟

    try {
        const org = await getMonitoredOrg();
        if (!org) {
            return res.status(404).json({ error: 'Monitored organization not found.' });
        }
        const cacheKey = buildOrganizationSummaryCacheKey(
            ORG_NAME,
            range,
            org.last_ingestion_completed_at,
        );

        // 1. 检查缓存
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            console.log(`Cache hit for summary: ${cacheKey}`);
            return res.json(withDataFreshness(JSON.parse(cachedData)));
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
                (SELECT COUNT(*) FROM repositories
                 WHERE org_id = $1 AND is_in_organization = TRUE) as organization_repositories,
                (SELECT COUNT(*) FROM repositories
                 WHERE org_id = $1 AND is_in_organization = TRUE AND sig_id IS NOT NULL) as tracked_repositories,
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
               AND ${HUMAN_CONTRIBUTOR_SQL}
               AND ${TRACKED_CONTRIBUTOR_ACTIVITY_SQL}`,
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
            organization_repositories: parseInt(summaryResult.rows[0].organization_repositories, 10),
            tracked_repositories: parseInt(summaryResult.rows[0].tracked_repositories, 10),
            active_contributors: parseInt(contributorCountResult.rows[0].unique_contributors, 10),
            days_counted: parseInt(summaryResult.rows[0].days_counted, 10),
            range_days: days, // 在响应中包含请求的范围
            last_updated_at: normalizeTimestamp(org.last_ingestion_completed_at),
        };

        // 4. 存入缓存并返回
        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(summaryData));
        console.log(`Summary data stored in cache for ${cacheKey}.`);

        res.json(withDataFreshness(summaryData));

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
    const cacheTTL = 60 * 10;

    try {
        const org = await getMonitoredOrg();
        if (!org) {
            return res.status(404).json({ error: 'Monitored organization not found.' });
        }

        const boundsResult = await pool.query(
            `SELECT MIN(snapshot_date) AS first_snapshot_date,
                    MAX(snapshot_date) AS latest_snapshot_date,
                    COALESCE(
                        ARRAY_AGG(snapshot_date::TEXT ORDER BY snapshot_date),
                        ARRAY[]::TEXT[]
                    ) AS snapshot_dates
             FROM activity_snapshots
             WHERE org_id = $1`,
            [org.id]
        );
        const bounds = boundsResult.rows[0];
        const periods = buildComparisonPeriods(
            range,
            bounds.first_snapshot_date ? formatDate(bounds.first_snapshot_date) : null,
            bounds.latest_snapshot_date ? formatDate(bounds.latest_snapshot_date) : null,
            bounds.snapshot_dates,
        );
        const cacheKey = `org:${ORG_NAME}:growth:v3:${range}:window:${periods.current.start || 'missing'}:${periods.current.end || 'missing'}:coverage:${bounds.snapshot_dates.length}`;

        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            console.log(`Cache hit for ${cacheKey}`);
            return res.json(JSON.parse(cachedData));
        }
        console.log(`Cache miss for ${cacheKey}. Querying DB...`);

        let current = null;
        if (hasCompletePeriodDates(periods.current)) {
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
                [org.id, periods.current.start, periods.current.end]
            );
            current = formatGrowthMetrics(currentResult.rows[0]);
        }
        let previous = null;
        let growth = null;

        if (periods.comparison_available) {
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
                [org.id, periods.previous.start, periods.previous.end]
            );
            previous = formatGrowthMetrics(previousResult.rows[0]);
            growth = calculateGrowthMetrics(current, previous);
        }

        const responseData = {
            comparison_available: periods.comparison_available,
            comparison_unavailable_reason: periods.reason,
            period: {
                current: {
                    ...periods.current,
                    metrics: current,
                },
                previous: periods.previous ? {
                    ...periods.previous,
                    metrics: previous,
                } : null,
            },
            growth,
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
    const cacheTTL = 60 * 10;

    try {
        const sigResult = await pool.query('SELECT id, name, org_id FROM special_interest_groups WHERE id = $1', [sigId]);
        if (sigResult.rows.length === 0) {
            return res.status(404).json({ error: 'Monitored SIG not found.' });
        }

        const boundsResult = await pool.query(
            `SELECT
                (SELECT MIN(snapshot_date) FROM sig_snapshots WHERE sig_id = $2) AS first_snapshot_date,
                MAX(snapshot_date) AS latest_snapshot_date,
                (SELECT COALESCE(
                    ARRAY_AGG(snapshot_date::TEXT ORDER BY snapshot_date),
                    ARRAY[]::TEXT[]
                 ) FROM sig_snapshots WHERE sig_id = $2) AS snapshot_dates
             FROM activity_snapshots
             WHERE org_id = $1`,
            [sigResult.rows[0].org_id, sigId]
        );
        const bounds = boundsResult.rows[0];
        const periods = buildComparisonPeriods(
            range,
            bounds.first_snapshot_date ? formatDate(bounds.first_snapshot_date) : null,
            bounds.latest_snapshot_date ? formatDate(bounds.latest_snapshot_date) : null,
            bounds.snapshot_dates,
        );
        const cacheKey = `sig:${sigId}:growth:v3:${range}:window:${periods.current.start || 'missing'}:${periods.current.end || 'missing'}:coverage:${bounds.snapshot_dates.length}`;

        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            console.log(`Cache hit for ${cacheKey}`);
            return res.json(JSON.parse(cachedData));
        }
        console.log(`Cache miss for ${cacheKey}. Querying DB...`);

        let current = null;
        if (hasCompletePeriodDates(periods.current)) {
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
                [sigId, periods.current.start, periods.current.end]
            );
            current = formatGrowthMetrics(currentResult.rows[0]);
        }
        let previous = null;
        let growth = null;

        if (periods.comparison_available) {
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
                [sigId, periods.previous.start, periods.previous.end]
            );
            previous = formatGrowthMetrics(previousResult.rows[0]);
            growth = calculateGrowthMetrics(current, previous);
        }

        const responseData = {
            sig: {
                id: sigResult.rows[0].id,
                name: sigResult.rows[0].name,
            },
            comparison_available: periods.comparison_available,
            comparison_unavailable_reason: periods.reason,
            period: {
                current: {
                    ...periods.current,
                    metrics: current,
                },
                previous: periods.previous ? {
                    ...periods.previous,
                    metrics: previous,
                } : null,
            },
            growth,
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

            if (!hasCompletePeriodDates(growthData.period.current)) {
                doc.text(growthData.comparison_unavailable_reason === 'incomplete_current_period'
                    ? '当前周期数据不完整，暂不展示指标或环比'
                    : '暂无数据，无法进行周期对比');
            } else {
                doc.text(`当前周期: ${growthData.period.current.start} 至 ${growthData.period.current.end}`);
                if (growthData.period.current.metrics) {
                    const curr = growthData.period.current.metrics;
                    doc.text(`  PRs: ${curr.new_prs}, Issues: ${curr.new_issues}, Commits: ${curr.new_commits}`);
                }
                doc.moveDown(0.5);

                if (growthData.period.previous) {
                    doc.text(`上一周期: ${growthData.period.previous.start} 至 ${growthData.period.previous.end}`);
                } else if (growthData.comparison_unavailable_reason === 'unbounded_range') {
                    doc.text('全部时间范围不提供环比');
                } else if (growthData.comparison_unavailable_reason === 'insufficient_history') {
                    doc.text('历史数据不足，暂不提供周期环比');
                } else {
                    doc.text('暂无数据，无法进行周期对比');
                }
                if (growthData.period.previous?.metrics) {
                    const prev = growthData.period.previous.metrics;
                    doc.text(`  PRs: ${prev.new_prs}, Issues: ${prev.new_issues}, Commits: ${prev.new_commits}`);
                }
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
               AND r.sig_id IS NOT NULL
               AND (rs.new_prs > 0 OR rs.new_issues > 0 OR rs.new_commits > 0)
             ORDER BY (rs.new_prs + rs.new_issues + rs.new_commits) DESC`,
            [org.id, date]
        );

        // Get contributors active on this date
        const contributorsResult = await pool.query(
            `SELECT c.github_username, c.avatar_url,
                    cda.prs_opened, cda.prs_closed, cda.issues_opened, cda.issues_closed,
                    CASE WHEN ${REPOSITORY_ATTRIBUTED_COMMITS_SQL}
                         THEN cda.commits_count ELSE 0 END AS commits_count
             FROM contributor_daily_activities cda
             JOIN contributors c ON cda.contributor_id = c.id
             JOIN organizations o ON cda.org_id = o.id
             WHERE o.id = $1 AND cda.snapshot_date = $2
               AND ${HUMAN_CONTRIBUTOR_SQL}
               AND ${TRACKED_CONTRIBUTOR_ACTIVITY_SQL}
               AND (cda.prs_opened > 0 OR cda.prs_closed > 0 OR cda.issues_opened > 0 OR cda.issues_closed > 0
                    OR CASE WHEN ${REPOSITORY_ATTRIBUTED_COMMITS_SQL}
                            THEN cda.commits_count ELSE 0 END > 0)
             ORDER BY (cda.prs_opened + cda.prs_closed + cda.issues_opened + cda.issues_closed
                    + CASE WHEN ${REPOSITORY_ATTRIBUTED_COMMITS_SQL}
                           THEN cda.commits_count ELSE 0 END) DESC
             LIMIT 50`,
            [org.id, date]
        );

        const contributorCountResult = await pool.query(
            `SELECT COUNT(DISTINCT cda.contributor_id) as active_contributors
             FROM contributor_daily_activities cda
             JOIN contributors c ON cda.contributor_id = c.id
             WHERE cda.org_id = $1 AND cda.snapshot_date = $2
               AND ${HUMAN_CONTRIBUTOR_SQL}
               AND ${TRACKED_CONTRIBUTOR_ACTIVITY_SQL}
               AND (cda.prs_opened > 0 OR cda.prs_closed > 0 OR cda.issues_opened > 0 OR cda.issues_closed > 0
                    OR CASE WHEN ${REPOSITORY_ATTRIBUTED_COMMITS_SQL}
                            THEN cda.commits_count ELSE 0 END > 0)`,
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
                COALESCE(SUM(CASE WHEN ${REPOSITORY_ATTRIBUTED_COMMITS_SQL}
                                  THEN cda.commits_count ELSE 0 END), 0) as commits_count,
                COALESCE(SUM(cda.prs_opened + cda.prs_closed + cda.issues_opened + cda.issues_closed
                    + CASE WHEN ${REPOSITORY_ATTRIBUTED_COMMITS_SQL}
                           THEN cda.commits_count ELSE 0 END), 0) as total_activities,
                COUNT(DISTINCT cda.snapshot_date) as active_days
            FROM contributors c
            JOIN contributor_daily_activities cda ON c.id = cda.contributor_id
            WHERE cda.snapshot_date >= $1
              AND ${HUMAN_CONTRIBUTOR_SQL}
              AND ${TRACKED_CONTRIBUTOR_ACTIVITY_SQL}
            GROUP BY c.id, c.github_username, c.avatar_url, c.first_seen_date, c.last_seen_date
            HAVING SUM(cda.prs_opened + cda.prs_closed + cda.issues_opened + cda.issues_closed
                + CASE WHEN ${REPOSITORY_ATTRIBUTED_COMMITS_SQL}
                       THEN cda.commits_count ELSE 0 END) > 0
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
               AND ${HUMAN_CONTRIBUTOR_SQL}
               AND ${TRACKED_CONTRIBUTOR_ACTIVITY_SQL}`,
            [startDateStr]
        );

        // 新贡献者数（首次出现在该时间范围内）
        const newContributorsResult = await pool.query(
            `SELECT COUNT(*) as count
             FROM contributors
             WHERE first_seen_date >= $1
               AND ${buildHumanContributorSqlCondition('contributors.github_username')}
               AND EXISTS (
                   SELECT 1
                   FROM contributor_repo_activities tracked_cra
                   JOIN repositories tracked_repo ON tracked_repo.id = tracked_cra.repo_id
                   WHERE tracked_cra.contributor_id = contributors.id
                     AND tracked_cra.snapshot_date >= $1
                     AND tracked_repo.sig_id IS NOT NULL
               )`,
            [startDateStr]
        );

        // 最活跃的一天
        const mostActiveDayResult = await pool.query(
            `SELECT cda.snapshot_date, COUNT(DISTINCT cda.contributor_id) as contributor_count
             FROM contributor_daily_activities cda
             JOIN contributors c ON cda.contributor_id = c.id
             WHERE cda.snapshot_date >= $1
               AND ${HUMAN_CONTRIBUTOR_SQL}
               AND ${TRACKED_CONTRIBUTOR_ACTIVITY_SQL}
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
            `SELECT cda.snapshot_date, cda.prs_opened, cda.prs_closed,
                    cda.issues_opened, cda.issues_closed,
                    CASE WHEN ${REPOSITORY_ATTRIBUTED_COMMITS_SQL}
                         THEN cda.commits_count ELSE 0 END AS commits_count
             FROM contributor_daily_activities cda
             WHERE cda.contributor_id = $1 AND cda.snapshot_date >= $2
               AND EXISTS (
                   SELECT 1
                   FROM contributor_repo_activities tracked_cra
                   JOIN repositories tracked_repo ON tracked_repo.id = tracked_cra.repo_id
                   WHERE tracked_cra.contributor_id = cda.contributor_id
                     AND tracked_cra.snapshot_date = cda.snapshot_date
                     AND tracked_repo.sig_id IS NOT NULL
               )
             ORDER BY cda.snapshot_date ASC`,
            [contributor.id, startDateStr]
        );

        // 获取活跃仓库
        const reposResult = await pool.query(
            `SELECT r.name, r.id,
                    SUM(COALESCE(cra.prs_opened, 0)
                      + COALESCE(cra.prs_closed, 0)
                      + COALESCE(cra.issues_opened, 0)
                      + COALESCE(cra.issues_closed, 0)
                      + COALESCE(cra.commits_count, 0)) as total_activities
             FROM contributor_repo_activities cra
             JOIN repositories r ON cra.repo_id = r.id
             WHERE cra.contributor_id = $1 AND cra.snapshot_date >= $2
               AND r.sig_id IS NOT NULL
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

    await redisConnectionPromise;

    try {
        await synchronizeRepositoryMetadata();
    } catch (e) {
        console.error('Repository SIG synchronization failed on startup:', e.message);
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
