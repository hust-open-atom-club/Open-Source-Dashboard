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
    upsertContributor,
};
