// A script to backfill historical data for a single, newly added repository.
require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');
const {
    fetchCommitHistoryViaGraphQL,
} = require('./github_commit_history');
const {
    isBotContributor,
} = require('./contributor_filters');

const ORG_NAME = 'hust-open-atom-club';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_API_BASE = 'https://api.github.com';

// --- 完整的数据库配置 ---
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

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

// --- Data Ingestion Service (Cron Job & Backfill) ---

/**
 * [PIPELINE 1] Fetches commit history via GraphQL and stores it.
 * This process is completely independent of the API fetching process.
 */
async function storeRepoCommitStats(repoId, repoName, targetDate, commitStats) {
    const targetDateStr = formatDate(targetDate);
    const authorCount = Object.keys(commitStats.authorStats).length;
    console.log(`[GraphQL Commit Pipeline] ${repoName}@${targetDateStr}: commits=${commitStats.new_commits}, lines=+${commitStats.lines_added}/-${commitStats.lines_deleted}, authors=${authorCount}`);

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
        console.log(`[GraphQL Commit Pipeline] ${repoName}@${targetDateStr}: ✅ 已存储到数据库 (id=${result.rows[0].id})`);
    } catch (error) {
        console.error(`[GraphQL Commit Pipeline] Error storing commit data for repo ${repoName}:`, error.message);
        // We throw here because a DB error is more critical.
        throw error;
    }
}

/**
 * [PIPELINE 2] Fetches ONLY API-related stats (PRs, Issues) and stores them.
 * This process is completely independent of the commit-history process.
 */
async function fetchAndStoreRepoApiStats(repoId, repoName, targetDate) {
    const targetDateStr = formatDate(targetDate);
    let apiMetrics;
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
        [...createdPrs.items, ...createdIssues.items, ...closedPrs.items, ...closedIssues.items].forEach((item) => {
            if (!isBotContributor(item.user.login)) {
                activeContributors.add(item.user.login);
            }
        });

        apiMetrics = {
            new_prs: createdPrs.total_count,
            closed_merged_prs: closedPrs.total_count,
            new_issues: createdIssues.total_count,
            closed_issues: closedIssues.total_count,
            active_contributors: activeContributors.size,
        };

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
    } catch (error) {
        console.error(`[API Pipeline] Error storing API data for repo ${repoName}:`, error.message);
        throw error;
    }
}

// --- 主回填逻辑 ---
async function backfillSingleRepository(repoName, days = 30) {
    console.log(`--- [START] Backfill for single repository: [${repoName}] for the last ${days} days ---`);

    // 1. 从数据库获取 repo_id
    const repoResult = await pool.query('SELECT id FROM repositories WHERE name = $1', [repoName]);
    if (repoResult.rows.length === 0) {
        throw new Error(`Repository "${repoName}" not found in the database. Please add it first.`);
    }
    const repoId = repoResult.rows[0].id;
    console.log(`Found repository in DB with ID: ${repoId}`);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const startDate = new Date(today);
    startDate.setDate(today.getDate() - days);
    const endDate = new Date(today);
    endDate.setDate(today.getDate() - 1);

    console.log(`Fetching commit history through GraphQL for ${formatDate(startDate)} to ${formatDate(endDate)}...`);
    const commitStatsMap = await fetchCommitHistoryViaGraphQL(repoName, startDate, endDate);

    for (let i = days; i >= 1; i--) {
        const targetDate = new Date(today);
        targetDate.setDate(today.getDate() - i);
        const targetDateStr = formatDate(targetDate);

        console.log(`\n--- Backfilling [${repoName}] for date: ${targetDateStr} ---`);
        
        // 2. 通过 GraphQL 采集并存储 commit 数据
        // (fetchAndStoreRepoCommitStats 是您主程序中的函数)
        await storeRepoCommitStats(repoId, repoName, targetDate, commitStatsMap.get(targetDateStr));

        // 3. 采集并存储 API 数据
        // (fetchAndStoreRepoApiStats 是您主程序中的函数)
        await fetchAndStoreRepoApiStats(repoId, repoName, targetDate);
    }

    console.log(`\n--- [FINISH] Backfill for [${repoName}] complete! ---`);
    console.log('Next step: Run the re-aggregation script to update SIG and Org totals.');
    await pool.end();
}

// --- 脚本入口 ---
const repoToBackfill = process.argv[2];
if (!repoToBackfill) {
    console.error('ERROR: Please provide a repository name as a command-line argument.');
    console.error('Usage: node backfill_single_repo.js <repository-name>');
    process.exit(1);
}

backfillSingleRepository(repoToBackfill).catch(err => {
    console.error('An error occurred during the backfill script:', err);
    pool.end();
});
