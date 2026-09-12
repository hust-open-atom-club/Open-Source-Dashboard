const test = require('node:test');
const assert = require('node:assert/strict');

const cron = require('node-cron');
const ExcelJS = require('exceljs');

const {
    DEFAULT_INGESTION_CRON_SCHEDULE,
    INGESTION_CRON_SCHEDULE_ENV_VAR,
    InvalidIngestionCronScheduleError,
    resolveIngestionCronSchedule,
} = require('../cron_schedule');

const PRODUCTION_CRON_EXPRESSION = DEFAULT_INGESTION_CRON_SCHEDULE;

test('node-cron supports the production schedule lifecycle', async () => {
    assert.equal(PRODUCTION_CRON_EXPRESSION, '0 */6 * * *');
    assert.equal(cron.validate(PRODUCTION_CRON_EXPRESSION), true);

    const task = cron.schedule(PRODUCTION_CRON_EXPRESSION, () => {});

    try {
        assert.equal(task.getPattern(), PRODUCTION_CRON_EXPRESSION);
        assert.ok(task.getNextRun() instanceof Date);

        await task.stop();
        assert.equal(task.getStatus(), 'stopped');
    } finally {
        await task.destroy();
    }

    assert.equal(task.getStatus(), 'destroyed');
});

test('the ingestion schedule falls back to every 6 hours when unset', () => {
    assert.equal(resolveIngestionCronSchedule(undefined), PRODUCTION_CRON_EXPRESSION);
    assert.equal(resolveIngestionCronSchedule(null), PRODUCTION_CRON_EXPRESSION);
    assert.equal(resolveIngestionCronSchedule(''), PRODUCTION_CRON_EXPRESSION);
    assert.equal(resolveIngestionCronSchedule('   '), PRODUCTION_CRON_EXPRESSION);
});

test('the ingestion schedule uses a valid configured expression', () => {
    const configured = '*/15 * * * *';

    assert.equal(cron.validate(configured), true);
    assert.equal(resolveIngestionCronSchedule(configured), configured);
    assert.equal(resolveIngestionCronSchedule(`  ${configured}  `), configured);
});

test('an invalid configured expression is rejected with the variable name', () => {
    const configured = 'not a cron expression';

    assert.equal(cron.validate(configured), false);

    assert.throws(
        () => resolveIngestionCronSchedule(configured),
        (error) => {
            assert.ok(error instanceof InvalidIngestionCronScheduleError);
            assert.equal(error.name, 'InvalidIngestionCronScheduleError');
            assert.equal(error.envVar, INGESTION_CRON_SCHEDULE_ENV_VAR);
            assert.equal(error.configuredValue, configured);
            assert.match(error.message, /INGESTION_CRON_SCHEDULE/);
            assert.match(error.message, /not a valid cron expression/);
            return true;
        },
    );
});

test('ExcelJS writes data-bar conditional formatting with the uuid override', async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Metrics');

    worksheet.getCell('A1').value = 10;
    worksheet.getCell('A2').value = 20;
    worksheet.addConditionalFormatting({
        ref: 'A1:A2',
        rules: [
            {
                type: 'dataBar',
                cfvo: [{ type: 'min' }, { type: 'max' }],
                color: { argb: 'FF638EC6' },
                gradient: false,
            },
        ],
    });

    const buffer = await workbook.xlsx.writeBuffer();
    assert.ok(buffer.length > 0);

    const loadedWorkbook = new ExcelJS.Workbook();
    await loadedWorkbook.xlsx.load(buffer);

    const loadedWorksheet = loadedWorkbook.getWorksheet('Metrics');
    assert.equal(loadedWorksheet.getCell('A1').value, 10);
    assert.equal(loadedWorksheet.getCell('A2').value, 20);
    assert.equal(loadedWorksheet.conditionalFormattings.length, 1);
    assert.equal(loadedWorksheet.conditionalFormattings[0].rules[0].type, 'dataBar');
});
