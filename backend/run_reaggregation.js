/**
 * Re-aggregation Script
 *
 * Usage: node run_reaggregation.js [--flush-cache]
 * Example: node run_reaggregation.js
 * Example: node run_reaggregation.js --flush-cache
 */

// A one-time script to re-aggregate all historical data from the corrected raw snapshots.
require('dotenv').config();
const { Pool } = require('pg');
const Redis = require('redis');

const ORG_NAME = 'hust-open-atom-club';
const SHOULD_FLUSH_CACHE = process.argv.includes('--flush-cache');

// --- DB and Redis Connections (from index.js) ---
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});
const redisClient = Redis.createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redisClient.on('error', (err) => console.error('Redis Client Error', err));

const formatDate = (date) => {
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
};

// --- Aggregation Functions (Copied directly from index.js) ---

async function aggregateSigSnapshot(sigId, targetDate) {
    const targetDateStr = formatDate(targetDate);
    const aggregateResult = await pool.query(
        `SELECT COALESCE(SUM(rs.new_commits), 0) as new_commits,
                COALESCE(SUM(rs.lines_added), 0) as lines_added,
                COALESCE(SUM(rs.lines_deleted), 0) as lines_deleted
         FROM repo_snapshots rs
         JOIN repositories r ON rs.repo_id = r.id
         WHERE r.sig_id = $1 AND rs.snapshot_date = $2`,
        [sigId, targetDateStr]
    );
    const agg = aggregateResult.rows[0];

    // 只更新 Git 相关字段，保留已有的 API 字段
    await pool.query(
        `UPDATE sig_snapshots
         SET new_commits = $1, lines_added = $2, lines_deleted = $3
         WHERE sig_id = $4 AND snapshot_date = $5`,
        [parseInt(agg.new_commits) || 0, parseInt(agg.lines_added) || 0, parseInt(agg.lines_deleted) || 0, sigId, targetDateStr]
    );
    console.log(`  ✅ Re-aggregated SIG [${sigId}] for ${targetDateStr}`);
}

async function aggregateOrganizationSnapshot(orgId, targetDate) {
    const targetDateStr = formatDate(targetDate);
    const orgAggregationResult = await pool.query(
        `SELECT COALESCE(SUM(ss.new_commits), 0) as new_commits,
                COALESCE(SUM(ss.lines_added), 0) as lines_added,
                COALESCE(SUM(ss.lines_deleted), 0) as lines_deleted
         FROM sig_snapshots ss
         JOIN special_interest_groups sig ON ss.sig_id = sig.id
         WHERE sig.org_id = $1 AND ss.snapshot_date = $2`,
        [orgId, targetDateStr]
    );
    const orgAgg = orgAggregationResult.rows[0];

    await pool.query(
        `UPDATE activity_snapshots
         SET new_commits = $1, lines_added = $2, lines_deleted = $3
         WHERE org_id = $4 AND snapshot_date = $5`,
        [parseInt(orgAgg.new_commits) || 0, parseInt(orgAgg.lines_added) || 0, parseInt(orgAgg.lines_deleted) || 0, orgId, targetDateStr]
    );
    console.log(`  ✅ Re-aggregated Organization for ${targetDateStr}`);
}


// --- Main Re-aggregation Logic ---
async function runFullReaggregation(days = 30) {
    console.log('--- [START] Full Data Re-aggregation Script ---');

    const orgResult = await pool.query("SELECT id FROM organizations WHERE name = $1", [ORG_NAME]);
    const org = orgResult.rows[0];
    const sigsResult = await pool.query('SELECT id FROM special_interest_groups WHERE org_id = $1', [org.id]);
    const sigs = sigsResult.rows;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = days; i >= 1; i--) {
        const targetDate = new Date(today);
        targetDate.setDate(today.getDate() - i);
        const targetDateStr = formatDate(targetDate);
        console.log(`\n--- Re-aggregating for date: ${targetDateStr} ---`);

        // 1. Re-aggregate all SIGs for the day
        for (const sig of sigs) {
            await aggregateSigSnapshot(sig.id, targetDate);
        }

        // 2. Re-aggregate the whole organization for the day
        await aggregateOrganizationSnapshot(org.id, targetDate);
    }

    if (SHOULD_FLUSH_CACHE) {
        console.log('\n--- Clearing Redis Cache ---');
        await redisClient.connect();
        await redisClient.flushAll();
        console.log('✅ Redis cache cleared.');
        await redisClient.quit();
    } else {
        console.log('\nSkipping Redis cache flush. Pass --flush-cache to enable it.');
    }

    console.log('\n--- [FINISH] Re-aggregation Complete ---');
    await pool.end();
}

runFullReaggregation(365).catch(console.error);