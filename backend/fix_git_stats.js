// A one-time script to correct historical git stats without re-running API calls.
const fs = require('fs/promises');
const path = require('path');
const {
    cloneOrPullRepoSecure,
    redactSecrets,
    runGit,
} = require('./git_secure');

require('dotenv').config();
const { Pool } = require('pg');

const REPO_STORAGE_PATH = path.join(__dirname, '..', 'repos');
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
        await fs.mkdir(repoPath, { recursive: true }).catch(() => {});
        return repoPath;
    }
}

/**
 * 修复版的 getCommitStats 函数 (从主程序复制最新的健壮版本)
 */
async function getCommitStats(repoName, targetDate) {
    // ... 将您在 index.js 中修复好的、最健壮的 getCommitStats 函数完整地复制到这里 ...
    // 为了完整性，我在这里重新粘贴一次
    const repoPath = await cloneOrPullRepo(repoName);
    const startDate = new Date(targetDate);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(targetDate);
    endDate.setDate(endDate.getDate() + 1);
    endDate.setHours(0, 0, 0, 0);
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
            return { new_commits: 0, lines_added: 0, lines_deleted: 0 };
        }
        const lines = stdout.trim().split('\n');
        let newCommits = 0;
        let linesAdded = 0;
        let linesDeleted = 0;
        for (const line of lines) {
            if (line.startsWith('COMMIT_SEPARATOR')) {
                newCommits++;
            } else {
                const parts = line.split('\t');
                if (parts.length === 3) {
                    const isInsertionsValid = !isNaN(parseInt(parts[0], 10)) || parts[0] === '-';
                    const isDeletionsValid = !isNaN(parseInt(parts[1], 10)) || parts[1] === '-';
                    if (isInsertionsValid && isDeletionsValid) {
                        const insertions = parseInt(parts[0], 10);
                        const deletions = parseInt(parts[1], 10);
                        if (!isNaN(insertions)) linesAdded += insertions;
                        if (!isNaN(deletions)) linesDeleted += deletions;
                    }
                }
            }
        }
        return { new_commits: newCommits, lines_added: linesAdded, lines_deleted: linesDeleted };
    } catch (error) {
        console.error(`Git command failed for ${repoName}\n${redactSecrets(error.message)}`);
        return { new_commits: 0, lines_added: 0, lines_deleted: 0 };
    }
}


async function runPromisesWithConcurrency(tasks, concurrency) {
    // 这个函数直接从 index.js 复制过来，无需修改
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


// --- 核心修复逻辑 ---

/**
 * 针对单个仓库和单个日期，重新计算 Git 数据并更新到数据库
 */
async function correctStatsForRepo(repo, targetDate) {
    const targetDateStr = formatDate(targetDate);
    // 为了日志清晰，将日志移到这里
    console.log(`  - Processing repo [${repo.name}] on ${targetDateStr}...`);

    // 1. 重新计算正确的 Git 统计数据
    // await 的结果会安全地赋值给这个函数作用域内的局部变量
    const stats = await getCommitStats(repo.name, targetDate);

    // 2. 使用 UPDATE 查询，只覆盖 Git 相关的字段
    // 这里的 stats 变量绝对不会被其他并发任务污染
    const result = await pool.query(
        `UPDATE repo_snapshots
         SET new_commits = $1, lines_added = $2, lines_deleted = $3
         WHERE repo_id = $4 AND snapshot_date = $5`,
        [stats.new_commits, stats.lines_added, stats.lines_deleted, repo.id, targetDateStr]
    );

    if (result.rowCount > 0) {
        console.log(`    ✅ Updated [${repo.name}]: commits=${stats.new_commits}, lines=+${stats.lines_added}/-${stats.lines_deleted}`);
    } else {
        console.warn(`    ⚠️ No existing record found for [${repo.name}] on ${targetDateStr}. This is OK if the repo had no API activity on that day.`);
    }
}

/**
 * 主修复函数
 * @param {number} daysToFix 要修复过去多少天的数据
 */
async function runGitStatsCorrection(daysToFix = 30) {
    console.log('--- [START] Git Stats Correction Script ---');
    console.log(`This will recalculate and update commit/line stats for the last ${daysToFix} days.`);

    // 获取所有需要监控的仓库
    const orgResult = await pool.query("SELECT id FROM organizations WHERE name = $1", [ORG_NAME]);
    const org = orgResult.rows[0];
    if (!org) {
        throw new Error('Monitored organization not found in DB.');
    }
    const reposResult = await pool.query('SELECT id, name FROM repositories WHERE org_id = $1', [org.id]);
    const repositories = reposResult.rows;
    console.log(`Found ${repositories.length} repositories to process.`);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = daysToFix; i >= 1; i--) { // 从最远的一天开始，修复到昨天
        const targetDate = new Date(today);
        targetDate.setDate(today.getDate() - i);
        const targetDateStr = formatDate(targetDate);

        console.log(`\n--- Processing date: ${targetDateStr} ---`);

        // 为当天的所有仓库创建修复任务
        const tasks = repositories.map(repo => () => correctStatsForRepo(repo, targetDate));
        
        // 并发执行
        await runPromisesWithConcurrency(tasks, 5); // 使用 5 个并发
    }
    
    // 注意：修复完成后，还需要手动重新聚合 SIG 和 Organization 的数据
    // 但为了让工程量最小化，我们可以依赖下一次的定时任务来自动完成聚合。
    // 定时任务会采集昨天的数据并触发聚合，可以顺带把更早的数据也重新聚合一遍。
    // 如果希望立即看到效果，需要额外编写聚合代码。
    // 这里我们选择最简单的方式：等待下一次定时任务。

    console.log('\n--- [FINISH] Git Stats Correction Script ---');
    console.log('Repo-level git stats have been corrected.');
    console.log('SIG and Organization level stats will be fully corrected after the next scheduled job runs.');
    await pool.end(); // 关闭数据库连接
}

// --- 运行脚本 ---
runGitStatsCorrection(30).catch(err => {
    console.error('An error occurred during the correction script:', err);
    pool.end();
});
