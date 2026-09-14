const axios = require('axios');
const {
    DEFAULT_ORG_NAME,
    DEFAULT_PROPERTY_NAME,
    UNTRACKED_VALUE,
    SIG_DEFINITIONS,
    getNextPageUrl,
    reaggregateAffectedHistoricalSnapshots,
    reaggregateContributorDailyActivities,
} = require('./repository_sig_sync');

/**
 * Associated (related) organization tracking.
 *
 * GitHub organizations outside the dashboard's own organization are
 * configured in the `associated_org_trackings` table (e.g. rustsbi). Their
 * repositories declare SIG membership through the same `osd_sig` GitHub
 * Custom Property used by the dashboard organization: a repository whose
 * property is set to a supported SIG slug (e.g. `r2`) is tracked under that
 * SIG, private repositories are never tracked, and repositories without a
 * declaration (property unset or `untracked`) are not tracked. When a
 * repository drops its declaration or is removed from the organization, it
 * keeps its history but stops being counted. Commit statistics always come
 * from the default branch, exactly like every other tracked repository.
 *
 * Unlike the dashboard organization itself, the sync token usually cannot
 * read the associated organization's Custom Property schema (that requires
 * org admin permissions), so only the property values are validated against
 * the supported SIG set and the sync fails closed on unsupported values.
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

function normalizeRepositoryId(rawRepositoryId, repositoryName) {
    const repositoryIdIsValid =
        (typeof rawRepositoryId === 'number' && Number.isSafeInteger(rawRepositoryId) && rawRepositoryId > 0)
        || (typeof rawRepositoryId === 'string' && /^[1-9]\d*$/.test(rawRepositoryId));
    if (!repositoryIdIsValid) {
        throw new Error(`GitHub returned an invalid repository id for ${repositoryName}.`);
    }
    return BigInt(rawRepositoryId).toString();
}

/**
 * Extract the SIG slug a repository declares through its osd_sig Custom
 * Property value. Returns null when the repository declares nothing usable
 * (property unset or `untracked`); throws on ambiguous or unsupported
 * declarations so a partial state is never written to the database.
 */
function resolveSigSlugFromPropertyValues(repositoryName, properties, propertyName = DEFAULT_PROPERTY_NAME) {
    if (properties === undefined || properties === null || !Array.isArray(properties)) {
        throw new Error(`GitHub returned repository ${repositoryName} without a valid properties list.`);
    }

    const matches = properties.filter((property) => property?.property_name === propertyName);
    if (matches.length === 0) {
        return null;
    }
    if (matches.length > 1) {
        throw new Error(`Associated repository ${repositoryName} declares multiple ${propertyName} values.`);
    }

    const propertyValue = matches[0].value;
    if (typeof propertyValue !== 'string' || propertyValue === '') {
        throw new Error(`Associated repository ${repositoryName} has an invalid ${propertyName} value: ${String(propertyValue)}`);
    }
    if (propertyValue === UNTRACKED_VALUE) {
        return null;
    }
    if (!Object.prototype.hasOwnProperty.call(SIG_DEFINITIONS, propertyValue)) {
        throw new Error(`Associated repository ${repositoryName} declares unsupported ${propertyName} value: ${propertyValue}`);
    }
    return propertyValue;
}

/**
 * Normalize one page-accumulated Custom Property listing of an associated
 * organization. Returns { repositoryId, repositoryName, sigSlug } entries for
 * every repository in the listing, with sigSlug null when the repository
 * declares nothing.
 */
function normalizeAssociatedPropertyRows(rows, propertyName) {
    const seenNames = new Set();
    const seenRepositoryIds = new Set();
    const declarations = [];

    for (const row of rows) {
        const repositoryName = row?.repository_name;
        if (typeof repositoryName !== 'string' || repositoryName.trim() === '') {
            throw new Error('GitHub returned a repository Custom Property row without repository_name.');
        }

        const normalizedName = repositoryName.toLowerCase();
        if (seenNames.has(normalizedName)) {
            throw new Error(`GitHub returned duplicate Custom Property rows for ${repositoryName}.`);
        }
        seenNames.add(normalizedName);

        const repositoryId = normalizeRepositoryId(row?.repository_id, repositoryName);
        if (seenRepositoryIds.has(repositoryId)) {
            throw new Error(`GitHub returned duplicate repository_id ${repositoryId}.`);
        }
        seenRepositoryIds.add(repositoryId);

        const sigSlug = resolveSigSlugFromPropertyValues(repositoryName, row.properties, propertyName);
        declarations.push({ repositoryId, repositoryName, sigSlug });
    }

    return declarations;
}

/**
 * Normalize one page-accumulated repository listing of an associated
 * organization into a id -> { repositoryName, private } map used to skip
 * private repositories and cross-check the property listing.
 */
function normalizeAssociatedRepositoryListing(rows) {
    const repositoriesById = new Map();
    const seenNames = new Set();

    for (const repository of rows) {
        const repositoryName = repository?.name;
        if (typeof repositoryName !== 'string' || repositoryName.trim() === '') {
            throw new Error('GitHub returned an associated repository without a name.');
        }

        const normalizedName = repositoryName.toLowerCase();
        if (seenNames.has(normalizedName)) {
            throw new Error(`GitHub returned duplicate associated repositories named ${repositoryName}.`);
        }
        seenNames.add(normalizedName);

        const repositoryId = normalizeRepositoryId(repository?.id, repositoryName);
        if (repositoriesById.has(repositoryId)) {
            throw new Error(`GitHub returned duplicate associated repository id ${repositoryId}.`);
        }

        if (typeof repository?.private !== 'boolean') {
            throw new Error(`GitHub returned associated repository ${repositoryName} without a privacy flag.`);
        }

        repositoriesById.set(repositoryId, { repositoryName, private: repository.private });
    }

    return repositoriesById;
}

async function fetchAllPages({ startUrl, httpClient, headers, describeFailure }) {
    const rows = [];
    const visitedPages = new Set();
    let nextUrl = startUrl;

    while (nextUrl) {
        if (visitedPages.has(nextUrl)) {
            throw new Error(`Associated organization pagination repeated ${nextUrl}.`);
        }
        visitedPages.add(nextUrl);

        let response;
        try {
            response = await httpClient.get(nextUrl, { headers, timeout: 30000 });
        } catch (error) {
            throw new Error(`${describeFailure}: ${error.message}`, { cause: error });
        }
        if (!Array.isArray(response.data)) {
            throw new Error(`${describeFailure}: response must be an array.`);
        }

        rows.push(...response.data);
        nextUrl = getNextPageUrl(response.headers?.link);
    }

    return rows;
}

/**
 * Read an associated organization's repository listings and keep only the
 * repositories that declare a supported SIG through the osd_sig Custom
 * Property. Private repositories are never tracked.
 */
async function fetchAssociatedOrgRepositoryAssignments({
    githubToken,
    ownerLogin,
    propertyName = DEFAULT_PROPERTY_NAME,
    httpClient = axios,
}) {
    const headers = githubHeaders(githubToken);
    const encodedOwner = encodeURIComponent(ownerLogin);
    const encodedProperty = encodeURIComponent(propertyName);

    const propertyRows = await fetchAllPages({
        startUrl: `https://api.github.com/orgs/${encodedOwner}/properties/values?per_page=100`,
        httpClient,
        headers,
        describeFailure: `Failed to fetch ${propertyName} Custom Property values for associated org ${ownerLogin}`,
    });
    const declarations = normalizeAssociatedPropertyRows(propertyRows, propertyName);

    const repositoryRows = await fetchAllPages({
        startUrl: `https://api.github.com/orgs/${encodedOwner}/repos?per_page=100`,
        httpClient,
        headers,
        describeFailure: `Failed to fetch repositories for associated org ${ownerLogin}`,
    });
    const listingById = normalizeAssociatedRepositoryListing(repositoryRows);

    const assignments = [];
    const skippedPrivate = [];
    for (const declaration of declarations) {
        if (declaration.sigSlug === null) {
            continue;
        }

        const listed = listingById.get(declaration.repositoryId);
        if (!listed) {
            throw new Error(
                `Associated repository ${ownerLogin}/${declaration.repositoryName} declares ${propertyName}=${declaration.sigSlug} but is missing from the organization repository listing.`
            );
        }
        if (listed.private) {
            skippedPrivate.push(declaration.repositoryName);
            continue;
        }

        assignments.push({
            repositoryId: declaration.repositoryId,
            repositoryName: declaration.repositoryName,
            sigSlug: declaration.sigSlug,
        });
    }

    assignments.sort((left, right) => left.repositoryName.localeCompare(right.repositoryName));
    skippedPrivate.sort((left, right) => left.localeCompare(right));
    return { assignments, skippedPrivate };
}

async function applyAssociatedOrgRepositories({
    pool,
    assignments,
    ownerLogin,
    orgName = DEFAULT_ORG_NAME,
}) {
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

        // SIG rows are maintained by seed.sql and the club-org sync; upsert the
        // ones referenced by this organization's assignments so the associated
        // org sync also works standalone.
        const sigIdsBySlug = new Map();
        for (const sigSlug of new Set(assignments.map((assignment) => assignment.sigSlug))) {
            const sigResult = await client.query(
                `INSERT INTO special_interest_groups (org_id, slug, name)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name
                 RETURNING id`,
                [orgId, sigSlug, SIG_DEFINITIONS[sigSlug]]
            );
            sigIdsBySlug.set(sigSlug, sigResult.rows[0].id);
        }

        const existingResult = await client.query(
            `SELECT r.id, r.github_id, r.name, r.sig_id, sig.slug AS sig_slug
             FROM repositories r
             LEFT JOIN special_interest_groups sig ON sig.id = r.sig_id
             WHERE r.org_id = $1 AND r.owner_login = $2`,
            [orgId, ownerLogin]
        );

        const existingByGithubId = new Map();
        for (const repository of existingResult.rows) {
            if (repository.github_id !== null) {
                const githubId = String(repository.github_id);
                if (existingByGithubId.has(githubId)) {
                    throw new Error(`Database contains duplicate associated repository ID ${githubId} for ${ownerLogin}.`);
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
            const targetSigId = sigIdsBySlug.get(assignment.sigSlug);
            const existing = existingByGithubId.get(assignment.repositoryId);
            if (existing) {
                matchedRepositoryIds.add(existing.id);

                const mappingChanged = existing.sig_id !== targetSigId;
                const nameChanged = existing.name !== assignment.repositoryName;
                if (mappingChanged || nameChanged) {
                    await client.query(
                        `UPDATE repositories
                         SET name = $1, sig_id = $2, github_id = $3
                         WHERE id = $4`,
                        [assignment.repositoryName, targetSigId, assignment.repositoryId, existing.id]
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
                    changes.push({ repository: assignment.repositoryName, from: existing.sig_slug, to: assignment.sigSlug });
                }
                continue;
            }

            await client.query(
                `INSERT INTO repositories (org_id, sig_id, github_id, name, owner_login, is_in_organization)
                 VALUES ($1, $2, $3, $4, $5, FALSE)`,
                [orgId, targetSigId, assignment.repositoryId, assignment.repositoryName, ownerLogin]
            );
            affectedSigIds.add(targetSigId);
            trackingChanged = true;
            created += 1;
            changes.push({ repository: assignment.repositoryName, from: null, to: assignment.sigSlug });
        }

        // Repositories that disappeared from the associated org listing,
        // dropped their osd_sig declaration, or turned private keep their
        // history but stop being tracked, mirroring the club-org policy.
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
            changes.push({ repository: repository.name, from: repository.sig_slug, to: null, isInOrganization: false });
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

async function loadAssociatedOrgTrackings(pool) {
    const result = await pool.query(
        `SELECT owner_login
         FROM associated_org_trackings
         WHERE enabled
         ORDER BY owner_login`
    );
    return result.rows;
}

/**
 * Synchronize every enabled associated organization configured in
 * associated_org_trackings: public repositories declaring a supported SIG
 * through the osd_sig Custom Property are tracked under that SIG. Called
 * alongside the club-org osd_sig sync.
 */
async function syncAssociatedOrgRepositories({
    pool,
    githubToken,
    orgName = DEFAULT_ORG_NAME,
    propertyName = DEFAULT_PROPERTY_NAME,
    httpClient = axios,
}) {
    const configurations = await loadAssociatedOrgTrackings(pool);

    const results = [];
    for (const configuration of configurations) {
        const { assignments, skippedPrivate } = await fetchAssociatedOrgRepositoryAssignments({
            githubToken,
            ownerLogin: configuration.owner_login,
            propertyName,
            httpClient,
        });

        const result = await applyAssociatedOrgRepositories({
            pool,
            assignments,
            ownerLogin: configuration.owner_login,
            orgName,
        });
        result.skippedPrivate = skippedPrivate;
        results.push(result);
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
    resolveSigSlugFromPropertyValues,
    normalizeAssociatedPropertyRows,
    normalizeAssociatedRepositoryListing,
    fetchAssociatedOrgRepositoryAssignments,
    applyAssociatedOrgRepositories,
    syncAssociatedOrgRepositories,
};
