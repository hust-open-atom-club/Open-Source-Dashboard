const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const {
    parseBackfillArgs,
    parseDateLiteral,
} = require('../backfill_date_range_args');

function dateParts(date) {
    return [date.getFullYear(), date.getMonth() + 1, date.getDate()];
}

test('parses a single date', () => {
    const options = parseBackfillArgs(['--date', '2026-03-12']);

    assert.deepEqual(dateParts(options.startDate), [2026, 3, 12]);
    assert.deepEqual(dateParts(options.endDate), [2026, 3, 12]);
    assert.equal(options.flushCache, false);
    assert.equal(options.resetExisting, false);
});

test('parses a date range with optional flags', () => {
    const options = parseBackfillArgs([
        '--start-date', '2026-03-12',
        '--end-date', '2026-03-14',
        '--flush-cache',
        '--reset-existing',
    ]);

    assert.deepEqual(dateParts(options.startDate), [2026, 3, 12]);
    assert.deepEqual(dateParts(options.endDate), [2026, 3, 14]);
    assert.equal(options.flushCache, true);
    assert.equal(options.resetExisting, true);
});

test('accepts optional flags with a single date', () => {
    const options = parseBackfillArgs([
        '--flush-cache',
        '--date', '2026-03-12',
        '--reset-existing',
    ]);

    assert.equal(options.flushCache, true);
    assert.equal(options.resetExisting, true);
});

test('returns help without requiring date arguments', () => {
    assert.deepEqual(parseBackfillArgs(['--help']), { help: true });
});

test('rejects missing parameter values', () => {
    assert.throws(
        () => parseBackfillArgs(['--date']),
        /--date requires a value/
    );
    assert.throws(
        () => parseBackfillArgs(['--start-date', '--end-date', '2026-03-14']),
        /--start-date requires a value/
    );
    assert.throws(
        () => parseBackfillArgs(['--start-date', '2026-03-12', '--end-date']),
        /--end-date requires a value/
    );
});

test('rejects unknown arguments', () => {
    assert.throws(
        () => parseBackfillArgs(['--date', '2026-03-12', '--unknown']),
        /Unknown argument: --unknown/
    );
});

test('rejects mixing a single date with a range', () => {
    assert.throws(
        () => parseBackfillArgs([
            '--date', '2026-03-12',
            '--start-date', '2026-03-12',
            '--end-date', '2026-03-14',
        ]),
        /Use either --date or --start-date\/--end-date, not both/
    );
});

test('requires a complete date selection', () => {
    assert.throws(
        () => parseBackfillArgs([]),
        /provide either --date or both --start-date and --end-date/
    );
    assert.throws(
        () => parseBackfillArgs(['--start-date', '2026-03-12']),
        /provide either --date or both --start-date and --end-date/
    );
});

test('rejects malformed and invalid calendar dates', () => {
    assert.throws(
        () => parseDateLiteral('2026/03/12', '--date'),
        /must use YYYY-MM-DD format/
    );
    assert.throws(
        () => parseDateLiteral('2026-02-29', '--date'),
        /is not a valid calendar date/
    );
});

test('rejects a range whose start is later than its end', () => {
    assert.throws(
        () => parseBackfillArgs([
            '--start-date', '2026-03-15',
            '--end-date', '2026-03-14',
        ]),
        /--start-date cannot be later than --end-date/
    );
});

test('importing the parser has no database or process side effects', () => {
    const backendDirectory = path.resolve(__dirname, '..');
    const result = spawnSync(
        process.execPath,
        [
            '-e',
            "require('./backfill_date_range_args'); if (process.exitCode !== undefined) throw new Error('process.exitCode changed')",
        ],
        {
            cwd: backendDirectory,
            encoding: 'utf8',
            timeout: 2000,
            env: {
                ...process.env,
                DB_HOST: 'parser-import-must-not-connect.invalid',
            },
        }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
});
