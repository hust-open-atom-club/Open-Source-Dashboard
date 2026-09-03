const {
    acquireContributorDailyAggregationLock,
    rebuildContributorDailyActivities,
} = require('./contributor_daily_aggregation');
const { upsertContributor } = require('./contributor_identity');

async function storeCommitAuthorStats({ pool, repoId, snapshotDate, authorStats = {} }) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const repoResult = await client.query(
            'SELECT org_id FROM repositories WHERE id = $1 AND sig_id IS NOT NULL',
            [repoId]
        );
        if (repoResult.rows.length === 0) {
            throw new Error(`Tracked repository ${repoId} not found.`);
        }
        const orgId = repoResult.rows[0].org_id;

        await acquireContributorDailyAggregationLock(client, orgId, snapshotDate);

        const previousAuthorsResult = await client.query(
            `SELECT contributor_id
             FROM contributor_repo_activities
             WHERE repo_id = $1
               AND snapshot_date = $2
               AND (commits_count <> 0 OR lines_added <> 0 OR lines_deleted <> 0)`,
            [repoId, snapshotDate]
        );
        const affectedContributorIds = new Set(
            previousAuthorsResult.rows.map((row) => row.contributor_id)
        );

        // Clear old commit facts first so reruns cannot retain authors removed by rewritten history.
        await client.query(
            `UPDATE contributor_repo_activities
             SET commits_count = 0,
                 lines_added = 0,
                 lines_deleted = 0
             WHERE repo_id = $1 AND snapshot_date = $2`,
            [repoId, snapshotDate]
        );

        for (const [username, stats] of Object.entries(authorStats)) {
            const contributorId = await upsertContributor(client, {
                username,
                githubId: stats.github_id,
                avatarUrl: stats.avatar_url,
                snapshotDate,
            });
            affectedContributorIds.add(contributorId);

            await client.query(
                `INSERT INTO contributor_repo_activities
                 (contributor_id, repo_id, snapshot_date, commits_count, lines_added, lines_deleted)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (contributor_id, repo_id, snapshot_date) DO UPDATE
                 SET commits_count = EXCLUDED.commits_count,
                     lines_added = EXCLUDED.lines_added,
                     lines_deleted = EXCLUDED.lines_deleted`,
                [
                    contributorId,
                    repoId,
                    snapshotDate,
                    stats.commits,
                    stats.lines_added,
                    stats.lines_deleted,
                ]
            );
        }

        if (affectedContributorIds.size > 0) {
            await rebuildContributorDailyActivities(
                client,
                orgId,
                snapshotDate,
                Array.from(affectedContributorIds)
            );
        }

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    storeCommitAuthorStats,
};
