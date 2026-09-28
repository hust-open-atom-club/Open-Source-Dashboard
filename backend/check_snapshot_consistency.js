require('dotenv').config();
const { Pool } = require('pg');
const { validateDate } = require('./snapshot_batch');
const { checkSnapshotConsistency } = require('./snapshot_hierarchy');
const { findMissingRepositorySnapshots } = require('./repository_snapshot_coverage');

async function main(args = process.argv.slice(2)) {
    if (args.length > 1) throw new Error('Usage: node check_snapshot_consistency.js [YYYY-MM-DD]');
    const date = args[0] || null;
    if (date) validateDate(date);
    const pool = new Pool({ user: process.env.DB_USER, host: process.env.DB_HOST,
        database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: process.env.DB_PORT });
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const { rows } = await client.query('SELECT id FROM organizations WHERE name = $1', ['hust-open-atom-club']);
        if (!rows.length) throw new Error('Organization not found');
        const coverage = await client.query(`SELECT COUNT(DISTINCT snapshot_date)::integer AS days FROM (
            SELECT rs.snapshot_date FROM repo_snapshots rs JOIN repositories r ON r.id = rs.repo_id
            WHERE r.org_id = $1 AND r.sig_id IS NOT NULL
            UNION SELECT ss.snapshot_date FROM sig_snapshots ss
            JOIN special_interest_groups sig ON sig.id = ss.sig_id WHERE sig.org_id = $1
            UNION SELECT snapshot_date FROM activity_snapshots WHERE org_id = $1
        ) dates WHERE $2::date IS NULL OR snapshot_date = $2`, [rows[0].id, date]);
        if (!coverage.rows[0].days) throw new Error('No snapshots found in the requested scope');
        const differences = await checkSnapshotConsistency(client, rows[0].id, date);
        const missing = await findMissingRepositorySnapshots(client, rows[0].id, date);
        const repositoryCoverage = Object.fromEntries(['pre_creation_unverified', 'missing_after_creation', 'unknown_creation_time']
            .map(reason => [reason, missing.filter(row => row.reason === reason).length]));
        console.log(JSON.stringify({ date: date || 'all', checked_dates: coverage.rows[0].days, differences,
            repository_coverage: repositoryCoverage, missing_repository_samples: missing.slice(0, 20) }, null, 2));
        await client.query('COMMIT');
        if (differences.length || missing.length) process.exitCode = 1;
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        if (client) client.release();
        await pool.end();
    }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
