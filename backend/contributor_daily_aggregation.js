async function acquireContributorDailyAggregationLock(client, orgId, snapshotDate) {
    // All repository writers for one organization/date use the same transaction-level
    // lock before modifying contributor rows. This prevents deadlocks between writers
    // and ensures the final writer observes every previously committed repo fact.
    await client.query(
        'SELECT pg_advisory_xact_lock($1, hashtext($2::text))',
        [orgId, snapshotDate]
    );
}

async function rebuildContributorDailyActivities(client, orgId, snapshotDate, contributorIds) {
    if (contributorIds.length === 0) return;

    await client.query(
        `INSERT INTO contributor_daily_activities
         (contributor_id, org_id, snapshot_date, prs_opened, prs_closed,
          issues_opened, issues_closed, commits_count, lines_added,
          lines_deleted, active_repos_count)
         SELECT cra.contributor_id, $1, $2,
                COALESCE(SUM(cra.prs_opened), 0),
                COALESCE(SUM(cra.prs_closed), 0),
                COALESCE(SUM(cra.issues_opened), 0),
                COALESCE(SUM(cra.issues_closed), 0),
                COALESCE(SUM(cra.commits_count), 0),
                COALESCE(SUM(cra.lines_added), 0),
                COALESCE(SUM(cra.lines_deleted), 0),
                COUNT(DISTINCT CASE
                    WHEN cra.prs_opened <> 0 OR cra.prs_closed <> 0
                      OR cra.issues_opened <> 0 OR cra.issues_closed <> 0
                      OR cra.commits_count <> 0 OR cra.lines_added <> 0
                      OR cra.lines_deleted <> 0
                    THEN cra.repo_id
                END)
         FROM contributor_repo_activities cra
         JOIN repositories r ON r.id = cra.repo_id
         WHERE r.org_id = $1
           AND r.sig_id IS NOT NULL
           AND cra.snapshot_date = $2
           AND cra.contributor_id = ANY($3::int[])
         GROUP BY cra.contributor_id
         ON CONFLICT (contributor_id, org_id, snapshot_date) DO UPDATE
         SET prs_opened = EXCLUDED.prs_opened,
             prs_closed = EXCLUDED.prs_closed,
             issues_opened = EXCLUDED.issues_opened,
             issues_closed = EXCLUDED.issues_closed,
             commits_count = EXCLUDED.commits_count,
             lines_added = EXCLUDED.lines_added,
             lines_deleted = EXCLUDED.lines_deleted,
             active_repos_count = EXCLUDED.active_repos_count`,
        [orgId, snapshotDate, contributorIds]
    );
}

module.exports = {
    acquireContributorDailyAggregationLock,
    rebuildContributorDailyActivities,
};
