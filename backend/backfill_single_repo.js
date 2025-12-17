// A script to backfill historical data for a single, newly added repository.
require('dotenv').config();
const { Pool } = require('pg');
// 复制所有需要的工具函数
const { exec } = require('child_process');
const { promisify } = require('util');
const execPromise = promisify(exec);
const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');

const ORG_NAME = 'hust-open-atom-club';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_API_BASE = 'https://api.github.com';
const REPO_STORAGE_PATH = path.join(__dirname, '..', 'repos');

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

// --- Git Commit Statistics Service ---

/**
 * Clones or pulls a repository and returns the path.
 */
async function cloneOrPullRepo(repoName) {
    const repoPath = path.join(REPO_STORAGE_PATH, repoName);
    const repoUrl = `https://${GITHUB_TOKEN}@github.com/${ORG_NAME}/${repoName}.git`;

    try {
        // 检查仓库目录是否存在
        const repoExists = await fs.access(repoPath).then(() => true).catch(() => false);

        if (repoExists) {
            // 仓库存在，尝试 pull
            try {
                // 先检查是否是有效的 git 仓库
                await execPromise(`git -C "${repoPath}" rev-parse --git-dir`, { timeout: 5000 });

                // 尝试 pull，如果失败可能是空仓库或分支问题
                try {
                    await execPromise(`git -C "${repoPath}" pull --ff-only`, { timeout: 60000 });
                } catch (pullError) {
                    // 如果 pull 失败，检查是否是空仓库或分支问题
                    const branchCheck = await execPromise(`git -C "${repoPath}" branch -r`, { timeout: 5000 }).catch(() => null);
                    if (!branchCheck || !branchCheck.stdout.trim()) {
                        console.warn(`${repoName}: 仓库为空或没有远程分支，跳过`);
                        // 返回路径但标记为无效
                        return repoPath;
                    }
                    // 尝试 fetch 然后 pull
                    console.warn(`${repoName}: Pull failed, trying fetch...`);
                    await execPromise(`git -C "${repoPath}" fetch origin`, { timeout: 60000 });
                    await execPromise(`git -C "${repoPath}" pull --ff-only`, { timeout: 60000 });
                }
            } catch (gitError) {
                // 如果不是有效的 git 仓库，删除并重新克隆
                console.warn(`${repoName}: not availabe, trying re-clone...`);
                await fs.rm(repoPath, { recursive: true, force: true });
                await execPromise(`git clone ${repoUrl} ${repoPath}`, { timeout: 120000 });
            }
        } else {
            // 仓库不存在，克隆
            console.log(`Cloning repo: ${repoName}`);
            try {
                await execPromise(`git clone ${repoUrl} ${repoPath}`, { timeout: 120000 });
            } catch (cloneError) {
                // 克隆失败可能是仓库不存在或为空
                console.error(`${repoName}: cloning failed: ${cloneError.message}`);
                // 创建一个空目录，后续 git log 会返回空结果
                await fs.mkdir(repoPath, { recursive: true });
                return repoPath;
            }
        }
    } catch (error) {
        console.error(`${repoName}: operate failed: ${error.message}`);
        // 确保目录存在，即使 git 操作失败
        await fs.mkdir(repoPath, { recursive: true }).catch(() => { });
        return repoPath;
    }

    return repoPath;
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

    const command = `git -C "${repoPath}" log --since="${startISO}" --until="${endISO}" --pretty=format:"COMMIT_SEPARATOR%an" --numstat`;

    try {
        const { stdout } = await execPromise(command, { maxBuffer: 1024 * 1024 * 10 });
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
        console.error(`Git command failed for ${repoName}:`, error.message);
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
 * [PIPELINE 2] Fetches ONLY API-related stats (PRs, Issues) and stores them.
 * This process is completely independent of the Git stats process.
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
        [...createdPrs.items, ...createdIssues.items, ...closedPrs.items, ...closedIssues.items].forEach(item => activeContributors.add(item.user.login));

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

    for (let i = days; i >= 1; i--) {
        const targetDate = new Date(today);
        targetDate.setDate(today.getDate() - i);
        const targetDateStr = formatDate(targetDate);

        console.log(`\n--- Backfilling [${repoName}] for date: ${targetDateStr} ---`);
        
        // 2. 采集并存储 Git 数据
        // (fetchAndStoreRepoCommitStats 是您主程序中的函数)
        await fetchAndStoreRepoCommitStats(repoId, repoName, targetDate);

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