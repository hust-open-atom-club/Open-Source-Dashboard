async function mergeContributorIdentities(client, sourceContributorId, targetContributorId) {
    if (sourceContributorId === targetContributorId) return;

    // Older rows may contain commit metrics only at the organization/day level.
    // Capture values with no repository attribution before deleting the source
    // identity so the repository-derived rebuild cannot erase them.
    const legacyDailyResult = await client.query(
        `SELECT cda.org_id,
                cda.snapshot_date,
                COALESCE(SUM(cda.commits_count), 0)::integer AS commits_count,
                COALESCE(SUM(cda.lines_added), 0)::integer AS lines_added,
                COALESCE(SUM(cda.lines_deleted), 0)::integer AS lines_deleted
         FROM contributor_daily_activities cda
         WHERE cda.contributor_id = ANY($1::int[])
           AND (COALESCE(cda.commits_count, 0) <> 0
             OR COALESCE(cda.lines_added, 0) <> 0
             OR COALESCE(cda.lines_deleted, 0) <> 0)
           AND NOT EXISTS (
               SELECT 1
               FROM contributor_repo_activities activity
               JOIN repositories repo ON repo.id = activity.repo_id
               WHERE activity.contributor_id = cda.contributor_id
                 AND activity.snapshot_date = cda.snapshot_date
                 AND repo.org_id = cda.org_id
                 AND (activity.commits_count <> 0
                   OR activity.lines_added <> 0
                   OR activity.lines_deleted <> 0)
           )
         GROUP BY cda.org_id, cda.snapshot_date`,
        [[sourceContributorId, targetContributorId]]
    );

    await client.query(
        `INSERT INTO contributor_repo_activities
         (contributor_id, repo_id, snapshot_date, prs_opened, prs_closed,
          issues_opened, issues_closed, commits_count, lines_added, lines_deleted)
         SELECT $1, repo_id, snapshot_date, prs_opened, prs_closed,
                issues_opened, issues_closed, commits_count, lines_added, lines_deleted
         FROM contributor_repo_activities
         WHERE contributor_id = $2
         ON CONFLICT (contributor_id, repo_id, snapshot_date) DO UPDATE
         SET prs_opened = COALESCE(contributor_repo_activities.prs_opened, 0) + COALESCE(EXCLUDED.prs_opened, 0),
             prs_closed = COALESCE(contributor_repo_activities.prs_closed, 0) + COALESCE(EXCLUDED.prs_closed, 0),
             issues_opened = COALESCE(contributor_repo_activities.issues_opened, 0) + COALESCE(EXCLUDED.issues_opened, 0),
             issues_closed = COALESCE(contributor_repo_activities.issues_closed, 0) + COALESCE(EXCLUDED.issues_closed, 0),
             commits_count = COALESCE(contributor_repo_activities.commits_count, 0) + COALESCE(EXCLUDED.commits_count, 0),
             lines_added = COALESCE(contributor_repo_activities.lines_added, 0) + COALESCE(EXCLUDED.lines_added, 0),
             lines_deleted = COALESCE(contributor_repo_activities.lines_deleted, 0) + COALESCE(EXCLUDED.lines_deleted, 0)`,
        [targetContributorId, sourceContributorId]
    );

    await client.query(
        'DELETE FROM contributor_repo_activities WHERE contributor_id = $1',
        [sourceContributorId]
    );

    // The merged target now contains every repository/date pair previously owned
    // by either identity. Rebuild all of those snapshot counts, not only the date
    // currently being ingested by the caller.
    await client.query(
        `UPDATE repo_snapshots AS snapshot
         SET active_contributors = (
             SELECT COUNT(DISTINCT activity.contributor_id)::integer
             FROM contributor_repo_activities activity
             WHERE activity.repo_id = snapshot.repo_id
               AND activity.snapshot_date = snapshot.snapshot_date
               AND (activity.prs_opened <> 0 OR activity.prs_closed <> 0
                 OR activity.issues_opened <> 0 OR activity.issues_closed <> 0
                 OR activity.commits_count <> 0 OR activity.lines_added <> 0
                 OR activity.lines_deleted <> 0)
         )
         WHERE (snapshot.repo_id, snapshot.snapshot_date) IN (
             SELECT repo_id, snapshot_date
             FROM contributor_repo_activities
             WHERE contributor_id = $1
         )`,
        [targetContributorId]
    );

    await client.query(
        `UPDATE sig_snapshots AS snapshot
         SET active_contributors = (
             SELECT COALESCE(SUM(repo_snapshot.active_contributors), 0)::integer
             FROM repo_snapshots repo_snapshot
             JOIN repositories repo ON repo.id = repo_snapshot.repo_id
             WHERE repo.sig_id = snapshot.sig_id
               AND repo_snapshot.snapshot_date = snapshot.snapshot_date
         )
         WHERE (snapshot.sig_id, snapshot.snapshot_date) IN (
             SELECT DISTINCT repo.sig_id, activity.snapshot_date
             FROM contributor_repo_activities activity
             JOIN repositories repo ON repo.id = activity.repo_id
             WHERE activity.contributor_id = $1
               AND repo.sig_id IS NOT NULL
         )`,
        [targetContributorId]
    );

    await client.query(
        `UPDATE activity_snapshots AS snapshot
         SET active_contributors = (
             SELECT COALESCE(SUM(sig_snapshot.active_contributors), 0)::integer
             FROM sig_snapshots sig_snapshot
             JOIN special_interest_groups sig ON sig.id = sig_snapshot.sig_id
             WHERE sig.org_id = snapshot.org_id
               AND sig_snapshot.snapshot_date = snapshot.snapshot_date
         )
         WHERE (snapshot.org_id, snapshot.snapshot_date) IN (
             SELECT DISTINCT repo.org_id, activity.snapshot_date
             FROM contributor_repo_activities activity
             JOIN repositories repo ON repo.id = activity.repo_id
             WHERE activity.contributor_id = $1
               AND repo.sig_id IS NOT NULL
         )`,
        [targetContributorId]
    );

    // Daily rows are derived data. Rebuild every date and organization for the
    // merged identity so overlapping source/target facts do not double-count repos.
    await client.query(
        'DELETE FROM contributor_daily_activities WHERE contributor_id = ANY($1::int[])',
        [[targetContributorId, sourceContributorId]]
    );
    await client.query(
        `INSERT INTO contributor_daily_activities
         (contributor_id, org_id, snapshot_date, prs_opened, prs_closed,
          issues_opened, issues_closed, commits_count, lines_added,
          lines_deleted, active_repos_count)
         SELECT $1, r.org_id, cra.snapshot_date,
                COALESCE(SUM(cra.prs_opened), 0),
                COALESCE(SUM(cra.prs_closed), 0),
                COALESCE(SUM(cra.issues_opened), 0),
                COALESCE(SUM(cra.issues_closed), 0),
                COALESCE(SUM(cra.commits_count), 0),
                COALESCE(SUM(cra.lines_added), 0),
                COALESCE(SUM(cra.lines_deleted), 0),
                COUNT(DISTINCT cra.repo_id)
         FROM contributor_repo_activities cra
         JOIN repositories r ON r.id = cra.repo_id
         WHERE cra.contributor_id = $1
           AND r.sig_id IS NOT NULL
           AND (cra.prs_opened <> 0 OR cra.prs_closed <> 0
             OR cra.issues_opened <> 0 OR cra.issues_closed <> 0
             OR cra.commits_count <> 0 OR cra.lines_added <> 0
             OR cra.lines_deleted <> 0)
         GROUP BY r.org_id, cra.snapshot_date`,
        [targetContributorId]
    );

    if (legacyDailyResult.rows.length > 0) {
        const legacyDailyMetrics = legacyDailyResult.rows.map((row) => {
            const snapshotDate = row.snapshot_date instanceof Date
                ? [
                    row.snapshot_date.getFullYear(),
                    String(row.snapshot_date.getMonth() + 1).padStart(2, '0'),
                    String(row.snapshot_date.getDate()).padStart(2, '0'),
                ].join('-')
                : String(row.snapshot_date).slice(0, 10);

            return {
                org_id: row.org_id,
                snapshot_date: snapshotDate,
                commits_count: Number(row.commits_count) || 0,
                lines_added: Number(row.lines_added) || 0,
                lines_deleted: Number(row.lines_deleted) || 0,
            };
        });

        await client.query(
            `INSERT INTO contributor_daily_activities
             (contributor_id, org_id, snapshot_date, prs_opened, prs_closed,
              issues_opened, issues_closed, commits_count, lines_added,
              lines_deleted, active_repos_count)
             SELECT $1, legacy.org_id, legacy.snapshot_date, 0, 0, 0, 0,
                    legacy.commits_count, legacy.lines_added, legacy.lines_deleted, 0
             FROM jsonb_to_recordset($2::jsonb) AS legacy(
                 org_id integer,
                 snapshot_date date,
                 commits_count integer,
                 lines_added integer,
                 lines_deleted integer
             )
             ON CONFLICT (contributor_id, org_id, snapshot_date) DO UPDATE
             SET commits_count = COALESCE(contributor_daily_activities.commits_count, 0)
                                     + EXCLUDED.commits_count,
                 lines_added = COALESCE(contributor_daily_activities.lines_added, 0)
                                   + EXCLUDED.lines_added,
                 lines_deleted = COALESCE(contributor_daily_activities.lines_deleted, 0)
                                     + EXCLUDED.lines_deleted`,
            [targetContributorId, JSON.stringify(legacyDailyMetrics)]
        );
    }

    await client.query(
        `UPDATE contributors AS target
         SET avatar_url = COALESCE(target.avatar_url, source.avatar_url),
             name = COALESCE(target.name, source.name),
             email = COALESCE(target.email, source.email),
             first_seen_date = LEAST(target.first_seen_date, source.first_seen_date),
             last_seen_date = GREATEST(target.last_seen_date, source.last_seen_date),
             updated_at = NOW()
         FROM contributors AS source
         WHERE target.id = $1 AND source.id = $2`,
        [targetContributorId, sourceContributorId]
    );
    await client.query('DELETE FROM contributors WHERE id = $1', [sourceContributorId]);
}

async function upsertContributor(client, {
    username,
    githubId,
    avatarUrl,
    snapshotDate,
}) {
    if (githubId !== null && githubId !== undefined) {
        // GitHub may recycle a login after its previous owner renames or deletes their
        // account. Preserve that old identity under an impossible GitHub login so the
        // incoming numeric ID can claim the current username without losing history.
        await client.query(
            `UPDATE contributors
             SET github_username = github_username || '~' || github_id::text,
                 updated_at = NOW()
             WHERE github_username = $1
               AND github_id IS NOT NULL
               AND github_id <> $2`,
            [username, githubId]
        );

        const nullIdOccupant = await client.query(
            `SELECT id
             FROM contributors
             WHERE github_username = $1 AND github_id IS NULL
             FOR UPDATE`,
            [username]
        );
        const existingIdIdentity = await client.query(
            `SELECT id
             FROM contributors
             WHERE github_id = $1
             FOR UPDATE`,
            [githubId]
        );

        if (nullIdOccupant.rows.length > 0 && existingIdIdentity.rows.length > 0) {
            await mergeContributorIdentities(
                client,
                nullIdOccupant.rows[0].id,
                existingIdIdentity.rows[0].id
            );
        }

        const existingById = await client.query(
            `UPDATE contributors
             SET github_username = $1,
                 avatar_url = COALESCE($3, contributors.avatar_url),
                 first_seen_date = LEAST(contributors.first_seen_date, $4),
                 last_seen_date = GREATEST(contributors.last_seen_date, $4),
                 updated_at = NOW()
             WHERE github_id = $2
             RETURNING id`,
            [username, githubId, avatarUrl, snapshotDate]
        );

        if (existingById.rows.length > 0) {
            return existingById.rows[0].id;
        }
    }

    const contributorResult = await client.query(
        `INSERT INTO contributors
         (github_username, github_id, avatar_url, first_seen_date, last_seen_date)
         VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (github_username) DO UPDATE
         SET first_seen_date = LEAST(contributors.first_seen_date, EXCLUDED.first_seen_date),
             last_seen_date = GREATEST(contributors.last_seen_date, EXCLUDED.last_seen_date),
             avatar_url = COALESCE(EXCLUDED.avatar_url, contributors.avatar_url),
             github_id = COALESCE(contributors.github_id, EXCLUDED.github_id),
             updated_at = NOW()
         WHERE contributors.github_id IS NULL
            OR EXCLUDED.github_id IS NULL
            OR contributors.github_id = EXCLUDED.github_id
         RETURNING id`,
        [username, githubId, avatarUrl, snapshotDate]
    );

    if (contributorResult.rows.length === 0) {
        throw new Error(`Contributor identity conflict for ${username}.`);
    }

    return contributorResult.rows[0].id;
}

module.exports = {
    mergeContributorIdentities,
    upsertContributor,
};
