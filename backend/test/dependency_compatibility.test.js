const test = require('node:test');
const assert = require('node:assert/strict');

const cron = require('node-cron');
const ExcelJS = require('exceljs');

const PRODUCTION_CRON_EXPRESSION = '0 */6 * * *';

test('node-cron supports the production schedule lifecycle', async () => {
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
