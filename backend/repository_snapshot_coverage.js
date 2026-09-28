// Report only retained organization dates, never synthesize a retention window
// from local registration timestamps. Missing pre-creation rows need a history
// check too: imported commits can predate the GitHub repository itself.
const COVERAGE_SQL = `WITH dates AS (
    SELECT snapshot_date FROM activity_snapshots WHERE org_id = $1
    UNION SELECT rs.snapshot_date FROM repo_snapshots rs JOIN repositories r ON r.id = rs.repo_id
          WHERE r.org_id = $1 AND r.sig_id IS NOT NULL
    UNION SELECT ss.snapshot_date FROM sig_snapshots ss JOIN special_interest_groups s ON s.id = ss.sig_id
          WHERE s.org_id = $1
)
SELECT r.id AS repo_id, r.name, r.sig_id, r.github_created_at,
       d.snapshot_date::text AS snapshot_date,
       CASE WHEN r.github_created_at IS NULL THEN 'unknown_creation_time'
            WHEN d.snapshot_date < r.github_created_at::date THEN 'pre_creation_unverified'
            ELSE 'missing_after_creation' END AS reason
FROM dates d CROSS JOIN repositories r
LEFT JOIN repo_snapshots rs ON rs.repo_id = r.id AND rs.snapshot_date = d.snapshot_date
WHERE r.org_id = $1 AND r.sig_id IS NOT NULL AND r.is_in_organization = TRUE
  AND rs.id IS NULL AND ($2::date IS NULL OR d.snapshot_date = $2)`;

async function findMissingRepositorySnapshots(client, orgId, snapshotDate = null) {
    return (await client.query(`${COVERAGE_SQL} ORDER BY d.snapshot_date DESC, r.id`, [orgId, snapshotDate])).rows;
}

module.exports = { findMissingRepositorySnapshots };
