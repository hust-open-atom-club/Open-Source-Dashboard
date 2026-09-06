const axios = require('axios');
const {
    DEFAULT_ORG_NAME,
    SIG_DEFINITIONS,
    getNextPageUrl,
    reaggregateAffectedHistoricalSnapshots,
    reaggregateContributorDailyActivities,
} = require('./repository_sig_sync');

/**
 * Upstream organization tracking.
 *
 * The osd_sig GitHub Custom Property only exists inside the dashboard's own
 * organization (hust-open-atom-club). Repositories of external upstream
 * organizations (e.g. rustsbi) cannot carry that property, so their tracking
 * scope is configured in the upstream_org_trackings table instead:
 * every repository of the configured organization is enumerated and assigned
 * to the configured SIG, and the configured main repository additionally
 * collects commit statistics across ALL branches.
 */

function githubHeaders(githubToken) {
    if (!githubToken) {
        throw new Error('GITHUB_TOKEN is not set in environment variables.');
    }

    return {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    };
}

function normalizeUpstreamRepositories(rows, { includeArchived, includeForks }) {
    const seenNames = new Set();
    const seenRepositoryIds = new Set();
    const assignments = [];

    for (const repository of rows) {
        const repositoryName = repository?.name;
        if (typeof repositoryName !== 'string' || repositoryName.trim() === '') {
            throw new Error('GitHub returned an upstream repository without a name.');
        }

        if (repository.archived && !includeArchived) {
            continue;
        }
        if (repository.fork && !includeForks) {
            continue;
        }

        const normalizedName = repositoryName.toLowerCase();
        if (seenNames.has(normalizedName)) {
            throw new Error(`GitHub returned duplicate upstream repositories named ${repositoryName}.`);
        }
        seenNames.add(normalizedName);

        const rawRepositoryId = repository?.id;
        const repositoryIdIsValid =
            (typeof rawRepositoryId === 'number' && Number.isSafeInteger(rawRepositoryId) && rawRepositoryId > 0)
            || (typeof rawRepositoryId === 'string' && /^[1-9]\d*$/.test(rawRepositoryId));
        if (!repositoryIdIsValid) {
            throw new Error(`GitHub returned an invalid repository id for upstream repository ${repositoryName}.`);
        }
        const repositoryId = BigInt(rawRepositoryId).toString();
        if (seenRepositoryIds.has(repositoryId)) {
            throw new Error(`GitHub returned duplicate upstream repository id ${repositoryId}.`);
        }
        seenRepositoryIds.add(repositoryId);

        assignments.push({ repositoryId, repositoryName });
    }

    assignments.sort((left, right) => left.repositoryName.localeCompare(right.repositoryName));
    return assignments;
}

async function fetchUpstreamOrgRepositories({
    githubToken,
    ownerLogin,
    includeArchived = true,
    includeForks = true,
    httpClient = axios,
}) {
    const headers = githubHeaders(githubToken);
    const encodedOwner = encodeURIComponent(ownerLogin);

    const rows = [];
    const visitedPages = new Set();
    let nextUrl = `https://api.github.com/orgs/${encodedOwner}/repos?per_page=100`;

    while (nextUrl) {
        if (visitedPages.has(nextUrl)) {
            throw new Error(`Upstream repository pagination repeated ${nextUrl}.`);
        }
        visitedPages.add(nextUrl);

        let response;
        try {
            response = await httpClient.get(nextUrl, { headers, timeout: 30000 });
        } catch (error) {
            throw new Error(`Failed to fetch repositories for upstream org ${ownerLogin}: ${error.message}`, { cause: error });
        }
        if (!Array.isArray(response.data)) {
            throw new Error(`Upstream org ${ownerLogin} repositories response must be an array.`);
        }

        rows.push(...response.data);
        nextUrl = getNextPageUrl(response.headers?.link);
    }

    return normalizeUpstreamRepositories(rows, { includeArchived, includeForks });
}

async function applyUpstreamOrgRepositories({
    pool,
    assignments,
    ownerLogin,
    sigSlug,
    mainRepoName = null,
    orgName = DEFAULT_ORG_NAME,
}) {
    const sigName = SIG_DEFINITIONS[sigSlug];
    if (!sigName) {
        throw new Error(`Unsupported upstream SIG slug: ${sigSlug}`);
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const orgResult = await client.query(
            `INSERT INTO organizations (name)
             VALUES ($1)
             ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
             RETURNING id`,
            [orgName]
        );
        const orgId = orgResult.rows[0].id;

        const sigResult = await client.query(
            `INSERT INTO special_interest_groups (org_id, slug, name)
             VALUES ($1, $2, $3)
             ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name
             RETURNING id`,
            [orgId, sigSlug, sigName]
        );
        const targetSigId = sigResult.rows[0].id;

        const existingResult = await client.query(
            `SELECT id, github_id, name, sig_id, track_all_branches
             FROM repositories
             WHERE org_id = $1 AND owner_login = $2`,
            [orgId, ownerLogin]
        );

        const existingByGithubId = new Map();
        for (const repository of existingResult.rows) {
            if (repository.github_id !== null) {
                const githubId = String(repository.github_id);
                if (existingByGithubId.has(githubId)) {
                    throw new Error(`Database contains duplicate upstream repository ID ${githubId} for ${ownerLogin}.`);
                }
                existingByGithubId.set(githubId, repository);
            }
        }

        const affectedSigIds = new Set();
        const matchedRepositoryIds = new Set();
        const changes = [];
        let created = 0;
        let disabled = 0;
        let trackingChanged = false;

        for (const assignment of assignments) {
            const shouldTrackAllBranches = mainRepoName !== null
                && assignment.repositoryName.toLowerCase() === mainRepoName.toLowerCase();

            const existing = existingByGithubId.get(assignment.repositoryId);
            if (existing) {
                matchedRepositoryIds.add(existing.id);

                const mappingChanged = existing.sig_id !== targetSigId;
                const nameChanged = existing.name !== assignment.repositoryName;
                const branchScopeChanged = existing.track_all_branches !== shouldTrackAllBranches;
                if (mappingChanged || nameChanged || branchScopeChanged) {
                    await client.query(
                        `UPDATE repositories
                         SET name = $1, sig_id = $2, github_id = $3, track_all_branches = $4
                         WHERE id = $5`,
                        [assignment.repositoryName, targetSigId, assignment.repositoryId, shouldTrackAllBranches, existing.id]
                    );
                }
                if (mappingChanged) {
                    if ((existing.sig_id === null) !== (targetSigId === null)) {
                        trackingChanged = true;
                    }
                    if (existing.sig_id !== null) {
                        affectedSigIds.add(existing.sig_id);
                    }
                    affectedSigIds.add(targetSigId);
                }
                if (mappingChanged || branchScopeChanged) {
                    changes.push({
                        repository: assignment.repositoryName,
                        from: existing.sig_id,
                        to: targetSigId,
                        ...(branchScopeChanged ? { trackAllBranches: shouldTrackAllBranches } : {}),
                    });
                }
                continue;
            }

            await client.query(
                `INSERT INTO repositories (org_id, sig_id, github_id, name, owner_login, track_all_branches, is_in_organization)
                 VALUES ($1, $2, $3, $4, $5, $6, FALSE)`,
                [orgId, targetSigId, assignment.repositoryId, assignment.repositoryName, ownerLogin, shouldTrackAllBranches]
            );
            affectedSigIds.add(targetSigId);
            trackingChanged = true;
            created += 1;
            changes.push({
                repository: assignment.repositoryName,
                from: null,
                to: sigSlug,
                ...(shouldTrackAllBranches ? { trackAllBranches: true } : {}),
            });
        }

        // Repositories that disappeared from the upstream org listing keep
        // their history but stop being tracked, mirroring the club-org policy.
        for (const repository of existingResult.rows) {
            if (matchedRepositoryIds.has(repository.id) || repository.sig_id === null) {
                continue;
            }

            affectedSigIds.add(repository.sig_id);
            trackingChanged = true;
            await client.query(
                'UPDATE repositories SET sig_id = NULL WHERE id = $1',
                [repository.id]
            );
            changes.push({ repository: repository.name, from: repository.sig_id, to: null, isInOrganization: false });
            disabled += 1;
        }

        const reaggregation = await reaggregateAffectedHistoricalSnapshots(
            client,
            orgId,
            [...affectedSigIds]
        );
        reaggregation.contributorDailyActivities = trackingChanged
            ? await reaggregateContributorDailyActivities(client, orgId)
            : 0;

        await client.query('COMMIT');

        return {
            ownerLogin,
            sigSlug,
            repositories: assignments.length,
            tracked: assignments.length,
            created,
            disabled,
            changes,
            affectedSigIds: [...affectedSigIds],
            reaggregation,
        };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function loadUpstreamOrgTrackings(pool) {
    const result = await pool.query(
        `SELECT owner_login, sig_slug, main_repo_name, include_archived, include_forks
         FROM upstream_org_trackings
         WHERE enabled
         ORDER BY owner_login`
    );
    return result.rows;
}

/**
 * Synchronize every enabled upstream organization configured in
 * upstream_org_trackings. Called alongside the club-org osd_sig sync.
 */
async function syncUpstreamOrgRepositories({
    pool,
    githubToken,
    orgName = DEFAULT_ORG_NAME,
    httpClient = axios,
}) {
    const configurations = await loadUpstreamOrgTrackings(pool);

    const results = [];
    for (const configuration of configurations) {
        const assignments = await fetchUpstreamOrgRepositories({
            githubToken,
            ownerLogin: configuration.owner_login,
            includeArchived: configuration.include_archived,
            includeForks: configuration.include_forks,
            httpClient,
        });

        results.push(await applyUpstreamOrgRepositories({
            pool,
            assignments,
            ownerLogin: configuration.owner_login,
            sigSlug: configuration.sig_slug,
            mainRepoName: configuration.main_repo_name,
            orgName,
        }));
    }

    return {
        configurations: results.length,
        repositories: results.reduce((total, result) => total + result.repositories, 0),
        created: results.reduce((total, result) => total + result.created, 0),
        disabled: results.reduce((total, result) => total + result.disabled, 0),
        changes: results.flatMap((result) => result.changes),
        perOwner: results,
    };
}

module.exports = {
    normalizeUpstreamRepositories,
    fetchUpstreamOrgRepositories,
    applyUpstreamOrgRepositories,
    syncUpstreamOrgRepositories,
};
