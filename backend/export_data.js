require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { Parser } = require('json2csv');
const ExcelJS = require('exceljs');

const ORG_NAME = 'hust-open-atom-club';
const OUTPUT_DIR = path.join(__dirname, 'exports'); // 导出的文件将存放在这个文件夹

// --- 数据库连接 (使用您项目中的完整配置) ---
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

const formatDate = (date) => date.toISOString().split('T')[0];

/**
 * 从数据库获取用于导出的扁平化数据
 * @param {number} days - 要导出过去多少天的数据
 */
async function fetchDataForExport(days = 30) {
    console.log(`Fetching data for the last ${days} days...`);
    const today = new Date();
    const startDate = new Date();
    startDate.setDate(today.getDate() - days);

    // 这个查询将组织数据和所有SIG的数据连接在一起，方便处理
    const query = `
        SELECT 
            ss.snapshot_date AS date,
            sig.name AS sig_name,
            ss.new_prs,
            ss.closed_merged_prs,
            ss.new_issues,
            ss.closed_issues,
            ss.active_contributors,
            ss.new_commits,
            ss.lines_added,
            ss.lines_deleted,
            aso.new_prs AS org_total_new_prs,
            aso.new_commits AS org_total_new_commits
        FROM sig_snapshots ss
        JOIN special_interest_groups sig ON ss.sig_id = sig.id
        LEFT JOIN activity_snapshots aso ON ss.snapshot_date = aso.snapshot_date AND sig.org_id = aso.org_id
        WHERE ss.snapshot_date >= $1
        ORDER BY ss.snapshot_date, sig.name;
    `;
    
    const result = await pool.query(query, [formatDate(startDate)]);
    // 将日期对象格式化为 'YYYY-MM-DD' 字符串
    return result.rows.map(row => ({
        ...row,
        date: formatDate(new Date(row.date))
    }));
}

/**
 * 将数据导出为 CSV 文件
 * @param {Array<Object>} data - 从数据库获取的数据
 */
function exportToCsv(data) {
    const json2csvParser = new Parser();
    const csv = json2csvParser.parse(data);
    
    const filePath = path.join(OUTPUT_DIR, 'dashboard_export.csv');
    fs.writeFileSync(filePath, csv);
    console.log(`✅ Successfully exported data to: ${filePath}`);
}

/**
 * 将数据导出为 JSON 文件
 * @param {Array<Object>} data - 从数据库获取的数据
 */
function exportToJson(data) {
    const filePath = path.join(OUTPUT_DIR, 'dashboard_export.json');
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`✅ Successfully exported data to: ${filePath}`);
}

/**
 * 将数据导出为 Excel (.xlsx) 文件，每个SIG一个工作表
 * @param {Array<Object>} data - 从数据库获取的数据
 */
async function exportToExcel(data) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Dashboard Export Script';
    workbook.created = new Date();

    // 1. 创建组织总览工作表
    const orgSheet = workbook.addWorksheet('Organization Overview');
    const orgData = {};
    data.forEach(row => {
        if (!orgData[row.date]) {
            orgData[row.date] = {
                date: row.date,
                org_total_new_prs: row.org_total_new_prs,
                org_total_new_commits: row.org_total_new_commits
                // 您可以在这里添加更多组织级别的总览指标
            };
        }
    });
    orgSheet.columns = [
        { header: 'Date', key: 'date', width: 15 },
        { header: 'Total New PRs', key: 'org_total_new_prs', width: 20 },
        { header: 'Total New Commits', key: 'org_total_new_commits', width: 20 },
    ];
    orgSheet.addRows(Object.values(orgData));


    // 2. 为每个SIG创建独立的工作表
    const sigNames = [...new Set(data.map(row => row.sig_name))];
    const sigColumns = [
        { header: 'Date', key: 'date', width: 15 },
        { header: 'New PRs', key: 'new_prs', width: 15 },
        { header: 'Merged PRs', key: 'closed_merged_prs', width: 15 },
        { header: 'New Issues', key: 'new_issues', width: 15 },
        { header: 'Closed Issues', key: 'closed_issues', width: 15 },
        { header: 'Commits', key: 'new_commits', width: 15 },
        { header: 'Lines Added', key: 'lines_added', width: 15 },
        { header: 'Lines Deleted', key: 'lines_deleted', width: 15 },
        { header: 'Contributors', key: 'active_contributors', width: 15 },
    ];
    
    for (const sigName of sigNames) {
        const sheet = workbook.addWorksheet(sigName);
        sheet.columns = sigColumns;
        const sigData = data.filter(row => row.sig_name === sigName);
        sheet.addRows(sigData);
    }
    
    const filePath = path.join(OUTPUT_DIR, 'dashboard_export.xlsx');
    await workbook.xlsx.writeFile(filePath);
    console.log(`✅ Successfully exported data to: ${filePath}`);
}


/**
 * 主函数
 */
async function main() {
    console.log('--- [START] Data Export ---');
    
    // 确保输出目录存在
    if (!fs.existsSync(OUTPUT_DIR)){
        fs.mkdirSync(OUTPUT_DIR);
    }

    const data = await fetchDataForExport(30); // 默认导出最近30天

    if (data.length === 0) {
        console.warn('No data found for the specified period. Nothing to export.');
        return;
    }

    exportToCsv(data);
    exportToJson(data);
    await exportToExcel(data);

    console.log('\n--- [FINISH] Export Complete ---');
    await pool.end();
}

main().catch(err => {
    console.error('An error occurred during the export script:', err);
    pool.end();
});