/**
 * Date Range Backfill Script
 *
 * 用法:
 *   node backfill_date_range.js --date YYYY-MM-DD
 *   node backfill_date_range.js --start-date YYYY-MM-DD --end-date YYYY-MM-DD
 *
 * 可选参数:
 *   --flush-cache    兼容旧命令；每次发布后自动失效相关缓存
 *   --reset-existing 忽略已保存进度；旧数据保留到原子发布完成
 *   --help           显示帮助信息
 */

const path = require('path');
const { parseBackfillArgs } = require('./backfill_date_range_args');

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
  --flush-cache  Compatibility flag; relevant caches are always invalidated after publication
  --reset-existing
                 Ignore saved progress; preserve existing rows until atomic replacement
  --help         Show this help message
`);
}

// Existing snapshots remain visible until their replacements commit.

async function main() {
    const options = parseBackfillArgs(process.argv.slice(2));
    if (options.help) {
        printUsage();
        return;
    }

    const { startDate, endDate, flushCache, resetExisting } = options;
    require('dotenv').config();
    const {
        runGraphQLBackfillForRange,
        formatDate,
        getScopedProgressFile,
    } = require('./run_graphql_backfill');

    const progressFile = getScopedProgressFile(startDate, endDate);
    const description = startDate.getTime() === endDate.getTime()
        ? `date ${formatDate(startDate)}`
        : `date range ${formatDate(startDate)} to ${formatDate(endDate)}`;

    console.log(`Using progress file: ${path.basename(progressFile)}`);

    if (resetExisting) {
        console.log('Ignoring saved progress; existing data will be replaced atomically after collection.');
    }

    await runGraphQLBackfillForRange({
        startDate,
        endDate,
        progressFile,
        description,
        flushCache,
        resetProgress: resetExisting,
    });
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
