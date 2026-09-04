const { filterBotContributors } = require('./contributor_filters');
const {
    acquireContributorWriteLocks,
    deleteEmptyContributorRepoActivities,
    rebuildContributorDailyActivities,
    rebuildContributorSeenDates,
    rebuildRepoActiveContributorCount,
} = require('./contributor_daily_aggregation');
const { upsertContributor } = require('./contributor_identity');

async function reconcileContributorActivities({
    client,
    orgId,
    repoId,
    snapshotDate,
    humanContributorDetails,
}) {
    const previousContributorsResult = await client.query(
        `SELECT contributor_id
         FROM contributor_repo_activities
         WHERE repo_id = $1
           AND snapshot_date = $2`,
        [repoId, snapshotDate]
    );
    const affectedContributorIds = new Set(
        previousContributorsResult.rows.map((row) => row.contributor_id)
    );

    await client.query(
        `UPDATE contributor_repo_activities
         SET prs_opened = 0,
             prs_closed = 0,
             issues_opened = 0,
             issues_closed = 0
         WHERE repo_id = $1 AND snapshot_date = $2`,
        [repoId, snapshotDate]
    );

    for (const contributor of humanContributorDetails) {
        try {
            const contributorId = await upsertContributor(client, {
                username: contributor.username,
                githubId: contributor.github_id,
                avatarUrl: contributor.avatar_url,
                snapshotDate,
            });
            affectedContributorIds.add(contributorId);

            await client.query(
                `INSERT INTO contributor_repo_activities
                 (contributor_id, repo_id, snapshot_date, prs_opened, prs_closed, issues_opened, issues_closed)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (contributor_id, repo_id, snapshot_date) DO UPDATE
                 SET prs_opened = EXCLUDED.prs_opened,
                     prs_closed = EXCLUDED.prs_closed,
                     issues_opened = EXCLUDED.issues_opened,
                     issues_closed = EXCLUDED.issues_closed`,
                [
                    contributorId,
                    repoId,
                    snapshotDate,
                    contributor.prs_opened,
                    contributor.prs_closed,
                    contributor.issues_opened,
                    contributor.issues_closed,
                ]
            );
        } catch (error) {
            throw new Error(`Error storing contributor ${contributor.username}: ${error.message}`);
        }
    }

    await deleteEmptyContributorRepoActivities(client, repoId, snapshotDate);
    await rebuildContributorSeenDates(
        client,
        Array.from(affectedContributorIds)
    );
    await rebuildContributorDailyActivities(
        client,
        orgId,
        snapshotDate,
        Array.from(affectedContributorIds)
    );
    await rebuildRepoActiveContributorCount(client, repoId, snapshotDate);
}

async function runContributorTransaction({
    pool,
    orgName,
    repoId,
    snapshotDate,
    contributorDetails,
    apiMetrics = null,
}) {
    const humanContributorDetails = filterBotContributors(contributorDetails);
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const orgResult = await client.query(
            'SELECT id FROM organizations WHERE name = $1',
            [orgName]
        );
        if (orgResult.rows.length === 0) {
            throw new Error('Organization not found');
        }
        const orgId = orgResult.rows[0].id;
        await acquireContributorWriteLocks(client, orgId, snapshotDate);

        let snapshotId = null;
        if (apiMetrics) {
            const snapshotResult = await client.query(
                `INSERT INTO repo_snapshots
                 (repo_id, snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (repo_id, snapshot_date) DO UPDATE
                 SET new_prs = EXCLUDED.new_prs,
                     closed_merged_prs = EXCLUDED.closed_merged_prs,
                     new_issues = EXCLUDED.new_issues,
                     closed_issues = EXCLUDED.closed_issues,
                     created_at = NOW()
                 RETURNING id`,
                [
                    repoId,
                    snapshotDate,
                    apiMetrics.new_prs,
                    apiMetrics.closed_merged_prs,
                    apiMetrics.new_issues,
                    apiMetrics.closed_issues,
                ]
            );
            snapshotId = snapshotResult.rows[0].id;
        }

        await reconcileContributorActivities({
            client,
            orgId,
            repoId,
            snapshotDate,
            humanContributorDetails,
        });

        await client.query('COMMIT');
        return {
            snapshotId,
            storedContributorCount: humanContributorDetails.length,
        };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function storeContributorActivities(options) {
    const result = await runContributorTransaction(options);
    return result.storedContributorCount;
}

async function persistRepoApiStats(options) {
    if (!options.apiMetrics) {
        throw new Error('apiMetrics is required');
    }
    return runContributorTransaction(options);
}

module.exports = {
    persistRepoApiStats,
    storeContributorActivities,
};
