const { rebuildContributorDailyActivities } = require('./contributor_daily_aggregation');

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
            const contributorResult = await client.query(
                `INSERT INTO contributors
                 (github_username, github_id, avatar_url, first_seen_date, last_seen_date)
                 VALUES ($1, $2, $3, $4, $4)
                 ON CONFLICT (github_username) DO UPDATE
                 SET last_seen_date = GREATEST(contributors.last_seen_date, EXCLUDED.last_seen_date),
                     avatar_url = COALESCE(EXCLUDED.avatar_url, contributors.avatar_url),
                     github_id = COALESCE(contributors.github_id, EXCLUDED.github_id),
                     updated_at = NOW()
                 RETURNING id`,
                [username, stats.github_id, stats.avatar_url, snapshotDate]
            );
            const contributorId = contributorResult.rows[0].id;
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
