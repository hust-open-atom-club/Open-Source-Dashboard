const {
    acquireContributorWriteLocks,
    deleteEmptyContributorRepoActivities,
    rebuildContributorDailyActivities,
    rebuildRepoActiveContributorCount,
} = require('./contributor_daily_aggregation');
const { upsertContributor } = require('./contributor_identity');

async function persistRepoCommitStats({
    pool,
    repoId,
    snapshotDate,
    commitStats,
    updateOnly = false,
}) {
    const authorStats = commitStats.authorStats || {};
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

        await acquireContributorWriteLocks(client, orgId, snapshotDate);

        const snapshotResult = updateOnly
            ? await client.query(
                `UPDATE repo_snapshots
                 SET new_commits = $1,
                     lines_added = $2,
                     lines_deleted = $3,
                     created_at = NOW()
                 WHERE repo_id = $4 AND snapshot_date = $5
                 RETURNING id`,
                [
                    commitStats.new_commits,
                    commitStats.lines_added,
                    commitStats.lines_deleted,
                    repoId,
                    snapshotDate,
                ]
            )
            : await client.query(
                `INSERT INTO repo_snapshots
                 (repo_id, snapshot_date, new_commits, lines_added, lines_deleted)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (repo_id, snapshot_date) DO UPDATE
                 SET new_commits = EXCLUDED.new_commits,
                     lines_added = EXCLUDED.lines_added,
                     lines_deleted = EXCLUDED.lines_deleted,
                     created_at = NOW()
                 RETURNING id`,
                [
                    repoId,
                    snapshotDate,
                    commitStats.new_commits,
                    commitStats.lines_added,
                    commitStats.lines_deleted,
                ]
            );

        if (updateOnly && snapshotResult.rows.length === 0) {
            await client.query('COMMIT');
            return { stored: false, snapshotId: null };
        }

        const previousAuthorsResult = await client.query(
            `SELECT contributor_id
             FROM contributor_repo_activities
             WHERE repo_id = $1
               AND snapshot_date = $2`,
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

        // Remove facts that became empty after rewritten history dropped an author.
        // Keeping these rows would make contributor endpoints count activity by existence.
        await deleteEmptyContributorRepoActivities(client, repoId, snapshotDate);

        if (affectedContributorIds.size > 0) {
            await rebuildContributorDailyActivities(
                client,
                orgId,
                snapshotDate,
                Array.from(affectedContributorIds)
            );
        }
        await rebuildRepoActiveContributorCount(client, repoId, snapshotDate);

        await client.query('COMMIT');
        return {
            stored: true,
            snapshotId: snapshotResult.rows[0]?.id || null,
        };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    persistRepoCommitStats,
};
