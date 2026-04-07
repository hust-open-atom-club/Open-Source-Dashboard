/**
 * Date Range Backfill Script
 *
 * 用法:
 *   node backfill_date_range.js --date YYYY-MM-DD
 *   node backfill_date_range.js --start-date YYYY-MM-DD --end-date YYYY-MM-DD
 *
 * 可选参数:
 *   --flush-cache    回填结束后清空 Redis 缓存
 *   --reset-existing 先删除目标日期范围内的旧数据，再执行回填
 *   --help           显示帮助信息
 */

require('dotenv').config();
const { Pool } = require('pg');
const path = require('path');
const {
    runGraphQLBackfillForRange,
    formatDate,
    getScopedProgressFile,
} = require('./run_graphql_backfill');

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

function printUsage() {
    console.log(`
Date range backfill usage:

  node backfill_date_range.js --date 2026-03-12
  node backfill_date_range.js --start-date 2026-03-12 --end-date 2026-03-14
  node backfill_date_range.js --date 2026-03-12 --flush-cache
  node backfill_date_range.js --start-date 2026-03-12 --end-date 2026-03-14 --reset-existing

Options:
  --date         Backfill a single day
  --start-date   Range start date in YYYY-MM-DD
  --end-date     Range end date in YYYY-MM-DD
  --flush-cache  Flush Redis after the backfill finishes
  --reset-existing
                 Delete existing rows in the target date range before backfill
  --help         Show this help message
`);
}

function parseDateLiteral(value, flagName) {
    if (!value) {
        throw new Error(`${flagName} requires a value in YYYY-MM-DD format.`);
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error(`${flagName} must use YYYY-MM-DD format.`);
    }

    const [year, month, day] = value.split('-').map(Number);
    const parsedDate = new Date(year, month - 1, day);

    if (formatDate(parsedDate) !== value) {
        throw new Error(`${flagName} is not a valid calendar date.`);
    }

    return parsedDate;
}

async function resetExistingData(startDate, endDate) {
    const startDateStr = formatDate(startDate);
    const endDateStr = formatDate(endDate);
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const deleteTargets = [
            'contributor_repo_activities',
            'contributor_daily_activities',
            'repo_snapshots',
            'sig_snapshots',
            'activity_snapshots',
        ];

        for (const tableName of deleteTargets) {
            const result = await client.query(
                `DELETE FROM ${tableName} WHERE snapshot_date BETWEEN $1 AND $2`,
                [startDateStr, endDateStr]
            );
            console.log(`Reset ${tableName}: deleted ${result.rowCount} rows for ${startDateStr} to ${endDateStr}`);
        }

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function main() {
    const args = process.argv.slice(2);
    let singleDateArg = null;
    let startDateArg = null;
    let endDateArg = null;
    let flushCache = false;
    let resetExisting = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--help') {
            printUsage();
            return;
        }

        if (arg === '--flush-cache') {
            flushCache = true;
            continue;
        }

        if (arg === '--reset-existing') {
            resetExisting = true;
            continue;
        }

        if (arg === '--date') {
            singleDateArg = args[++i];
            continue;
        }

        if (arg === '--start-date') {
            startDateArg = args[++i];
            continue;
        }

        if (arg === '--end-date') {
            endDateArg = args[++i];
            continue;
        }

        throw new Error(`Unknown argument: ${arg}`);
    }

    if (singleDateArg && (startDateArg || endDateArg)) {
        throw new Error('Use either --date or --start-date/--end-date, not both.');
    }

    if (!singleDateArg && (!startDateArg || !endDateArg)) {
        throw new Error('You must provide either --date or both --start-date and --end-date.');
    }

    const startDate = singleDateArg
        ? parseDateLiteral(singleDateArg, '--date')
        : parseDateLiteral(startDateArg, '--start-date');
    const endDate = singleDateArg
        ? parseDateLiteral(singleDateArg, '--date')
        : parseDateLiteral(endDateArg, '--end-date');

    if (startDate > endDate) {
        throw new Error('--start-date cannot be later than --end-date.');
    }

    const progressFile = getScopedProgressFile(startDate, endDate);
    const description = startDate.getTime() === endDate.getTime()
        ? `date ${formatDate(startDate)}`
        : `date range ${formatDate(startDate)} to ${formatDate(endDate)}`;

    console.log(`Using progress file: ${path.basename(progressFile)}`);

    try {
        if (resetExisting) {
            await resetExistingData(startDate, endDate);
        }

        await runGraphQLBackfillForRange({
            startDate,
            endDate,
            progressFile,
            description,
            flushCache,
        });
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
