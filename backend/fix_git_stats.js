// A one-time script to correct historical commit stats without re-running PR/Issue API calls.
const {
    fetchCommitHistoryViaGraphQL,
} = require('./github_commit_history');

require('dotenv').config();
const { Pool } = require('pg');
const {
    DEFAULT_PROPERTY_NAME,
    syncRepositorySigsFromGitHub,
} = require('./repository_sig_sync');
const { storeCommitAuthorStats } = require('./commit_author_stats');

const ORG_NAME = 'hust-open-atom-club'; // 确保与主程序一致

// --- 数据库连接 (从主程序复制) ---
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
    process.exit(-1);
});

// --- 必要的工具函数 (从主程序复制) ---

const formatDate = (date) => {
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
};

async function runPromisesWithConcurrency(tasks, concurrency) {
    const results = [];
    const failures = [];
    let currentIndex = 0;
    const worker = async () => {
        while (currentIndex < tasks.length) {
            const taskIndex = currentIndex++;
            const task = tasks[taskIndex];
            try {
                results[taskIndex] = await task();
            } catch (error) {
                results[taskIndex] = error;
                failures.push(error);
                console.error(`Task at index ${taskIndex} failed:`, error.message);
            }
        }
    };
    const workers = Array(concurrency).fill(null).map(() => worker());
    await Promise.all(workers);

    if (failures.length > 0) {
        throw new AggregateError(failures, `${failures.length} commit-history task(s) failed.`);
    }

    return results;
}


// --- 核心修复逻辑 ---

/**
 * 针对单个仓库和单个日期，通过 GraphQL 重新计算 commit 数据并更新到数据库
 */
async function correctStatsForRepo(repo, targetDate, stats) {
    const targetDateStr = formatDate(targetDate);
    // 为了日志清晰，将日志移到这里
    console.log(`  - Processing repo [${repo.name}] on ${targetDateStr}...`);

    // 使用 UPDATE 查询，只覆盖 commit 相关的字段
    // 这里的 stats 变量绝对不会被其他并发任务污染
    const result = await pool.query(
        `UPDATE repo_snapshots
         SET new_commits = $1, lines_added = $2, lines_deleted = $3
         WHERE repo_id = $4 AND snapshot_date = $5`,
        [stats.new_commits, stats.lines_added, stats.lines_deleted, repo.id, targetDateStr]
    );

    if (result.rowCount > 0) {
        await storeCommitAuthorStats({
            pool,
            repoId: repo.id,
            snapshotDate: targetDateStr,
            authorStats: stats.authorStats,
        });
        console.log(`    ✅ Updated [${repo.name}]: commits=${stats.new_commits}, lines=+${stats.lines_added}/-${stats.lines_deleted}`);
    } else {
        console.warn(`    ⚠️ No existing record found for [${repo.name}] on ${targetDateStr}. This is OK if the repo had no API activity on that day.`);
    }
}

/**
 * 主修复函数
 * @param {number} daysToFix 要修复过去多少天的数据
 */
async function runCommitStatsCorrection(daysToFix = 30) {
    console.log('--- [START] GraphQL Commit Stats Correction Script ---');
    console.log(`This will recalculate and update commit/line stats for the last ${daysToFix} days.`);

    await syncRepositorySigsFromGitHub({
        pool,
        githubToken: process.env.GITHUB_TOKEN,
        orgName: ORG_NAME,
        propertyName: process.env.GITHUB_SIG_PROPERTY || DEFAULT_PROPERTY_NAME,
    });

    // 获取所有需要监控的仓库
    const orgResult = await pool.query("SELECT id FROM organizations WHERE name = $1", [ORG_NAME]);
    const org = orgResult.rows[0];
    if (!org) {
        throw new Error('Monitored organization not found in DB.');
    }
    const reposResult = await pool.query('SELECT id, name FROM repositories WHERE org_id = $1 AND sig_id IS NOT NULL', [org.id]);
    const repositories = reposResult.rows;
    console.log(`Found ${repositories.length} repositories to process.`);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const startDate = new Date(today);
    startDate.setDate(today.getDate() - daysToFix);
    const endDate = new Date(today);
    endDate.setDate(today.getDate() - 1);

    const tasks = repositories.map(repo => async () => {
        console.log(`\n--- Fetching ${repo.name}: ${formatDate(startDate)} to ${formatDate(endDate)} ---`);
        const statsMap = await fetchCommitHistoryViaGraphQL(repo.name, startDate, endDate);

        for (let i = daysToFix; i >= 1; i--) {
            const targetDate = new Date(today);
            targetDate.setDate(today.getDate() - i);
            await correctStatsForRepo(repo, targetDate, statsMap.get(formatDate(targetDate)));
        }
    });

    await runPromisesWithConcurrency(tasks, 5);
    
    // 注意：修复完成后，还需要手动重新聚合 SIG 和 Organization 的数据
    // 但为了让工程量最小化，我们可以依赖下一次的定时任务来自动完成聚合。
    // 定时任务会采集昨天的数据并触发聚合，可以顺带把更早的数据也重新聚合一遍。
    // 如果希望立即看到效果，需要额外编写聚合代码。
    // 这里我们选择最简单的方式：等待下一次定时任务。

    console.log('\n--- [FINISH] GraphQL Commit Stats Correction Script ---');
    console.log('Repo-level commit stats have been corrected.');
    console.log('SIG and Organization level stats will be fully corrected after the next scheduled job runs.');
    await pool.end(); // 关闭数据库连接
}

// --- 运行脚本 ---
runCommitStatsCorrection(30).catch(err => {
    console.error('An error occurred during the correction script:', err);
    pool.end();
});
