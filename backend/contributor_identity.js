async function mergeContributorIdentities(client, sourceContributorId, targetContributorId) {
    if (sourceContributorId === targetContributorId) return;

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
