const axios = require('axios');

const DEFAULT_ORG_NAME = 'hust-open-atom-club';
const DEFAULT_PROPERTY_NAME = 'osd_sig';
const UNTRACKED_VALUE = 'untracked';

const SIG_DEFINITIONS = Object.freeze({
    hustmirror: '镜像站运维 SIG',
    'linux-kernel': 'Linux内核SIG',
    r2: 'R² SIG',
    hctt: 'HCTT SIG',
    pwnhustcollege: 'pwn.hust.college SIG',
    infrastructure: '数字基础设施维护 SIG',
    llmagent: 'Agent SIG',
    openharmony: 'OpenHarmony SIG',
    rtthread: 'RT-thread SIG',
});

function getNextPageUrl(linkHeader) {
    if (!linkHeader) {
        return null;
    }

    for (const part of linkHeader.split(',')) {
        const match = part.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
        if (match && match[2] === 'next') {
            return match[1];
        }
    }

    return null;
}

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

function validatePropertyDefinition(definition, propertyName) {
    if (!definition || definition.property_name !== propertyName) {
        throw new Error(`GitHub Custom Property ${propertyName} was not found.`);
    }
    if (definition.value_type !== 'single_select') {
        throw new Error(`GitHub Custom Property ${propertyName} must be single_select.`);
    }
    if (!Array.isArray(definition.allowed_values)) {
        throw new Error(`GitHub Custom Property ${propertyName} has no allowed_values array.`);
    }

    const supportedValues = new Set([UNTRACKED_VALUE, ...Object.keys(SIG_DEFINITIONS)]);
    const unknownValues = definition.allowed_values.filter((value) => !supportedValues.has(value));
    if (unknownValues.length > 0) {
        throw new Error(`Unsupported ${propertyName} value(s): ${unknownValues.join(', ')}`);
    }
    if (!definition.allowed_values.includes(UNTRACKED_VALUE)) {
        throw new Error(`GitHub Custom Property ${propertyName} must allow ${UNTRACKED_VALUE}.`);
    }
}

function normalizeAssignments(rows, propertyName) {
    const supportedValues = new Set([UNTRACKED_VALUE, ...Object.keys(SIG_DEFINITIONS)]);
    const seenNames = new Set();
    const seenRepositoryIds = new Set();
    const assignments = [];

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

        const rawRepositoryId = row?.repository_id;
        const repositoryIdIsValid =
            (typeof rawRepositoryId === 'number' && Number.isSafeInteger(rawRepositoryId) && rawRepositoryId > 0)
            || (typeof rawRepositoryId === 'string' && /^[1-9]\d*$/.test(rawRepositoryId));
        if (!repositoryIdIsValid) {
            throw new Error(`GitHub returned an invalid repository_id for ${repositoryName}.`);
        }
        const repositoryId = BigInt(rawRepositoryId).toString();
        if (seenRepositoryIds.has(repositoryId)) {
            throw new Error(`GitHub returned duplicate repository_id ${repositoryId}.`);
        }
        seenRepositoryIds.add(repositoryId);

        const propertyMatches = Array.isArray(row.properties)
            ? row.properties.filter((property) => property.property_name === propertyName)
            : [];
        if (propertyMatches.length !== 1) {
            throw new Error(`Repository ${repositoryName} must have exactly one ${propertyName} value.`);
        }

        const propertyValue = propertyMatches[0].value;
        if (typeof propertyValue !== 'string' || !supportedValues.has(propertyValue)) {
            throw new Error(`Repository ${repositoryName} has unsupported ${propertyName} value: ${String(propertyValue)}`);
        }

        assignments.push({
            repositoryId,
            repositoryName,
            propertyValue,
            sigSlug: propertyValue === UNTRACKED_VALUE ? null : propertyValue,
        });
    }

    assignments.sort((left, right) => left.repositoryName.localeCompare(right.repositoryName));
    return assignments;
}

function reserveTemporaryRepositoryName(repository, reservedNames) {
    const identity = repository.github_id === null
        ? `db-${repository.id}`
        : `github-${repository.github_id}`;

    for (let attempt = 0; ; attempt += 1) {
        const suffix = `~osd-history-${identity}${attempt === 0 ? '' : `-${attempt}`}`;
        const candidate = `${repository.name.slice(0, 255 - suffix.length)}${suffix}`;
        const normalizedCandidate = candidate.toLowerCase();
        if (!reservedNames.has(normalizedCandidate)) {
            reservedNames.add(normalizedCandidate);
            return candidate;
        }
    }
}

async function reaggregateContributorDailyActivities(client, orgId) {
    const result = await client.query(
        `INSERT INTO contributor_daily_activities (
             contributor_id, org_id, snapshot_date, prs_opened, prs_closed,
             issues_opened, issues_closed, active_repos_count
         )
         SELECT cra.contributor_id,
                $1,
                cra.snapshot_date,
                COALESCE(SUM(cra.prs_opened), 0)::INTEGER,
                COALESCE(SUM(cra.prs_closed), 0)::INTEGER,
                COALESCE(SUM(cra.issues_opened), 0)::INTEGER,
                COALESCE(SUM(cra.issues_closed), 0)::INTEGER,
                COUNT(DISTINCT CASE
                    WHEN cra.prs_opened > 0
                      OR cra.prs_closed > 0
                      OR cra.issues_opened > 0
                      OR cra.issues_closed > 0
                      OR cra.commits_count > 0
                    THEN cra.repo_id
                END)::INTEGER
         FROM contributor_repo_activities cra
         JOIN repositories r ON r.id = cra.repo_id
         WHERE r.org_id = $1
           AND r.sig_id IS NOT NULL
         GROUP BY cra.contributor_id, cra.snapshot_date
         ON CONFLICT (contributor_id, org_id, snapshot_date) DO UPDATE
         SET prs_opened = EXCLUDED.prs_opened,
             prs_closed = EXCLUDED.prs_closed,
             issues_opened = EXCLUDED.issues_opened,
             issues_closed = EXCLUDED.issues_closed,
             active_repos_count = EXCLUDED.active_repos_count`,
        [orgId]
    );

    await client.query(
        `UPDATE contributor_daily_activities cda
         SET prs_opened = 0,
             prs_closed = 0,
             issues_opened = 0,
             issues_closed = 0,
             active_repos_count = 0
         WHERE cda.org_id = $1
           AND NOT EXISTS (
               SELECT 1
               FROM contributor_repo_activities cra
               JOIN repositories r ON r.id = cra.repo_id
               WHERE cra.contributor_id = cda.contributor_id
                 AND cra.snapshot_date = cda.snapshot_date
                 AND r.org_id = cda.org_id
                 AND r.sig_id IS NOT NULL
           )`,
        [orgId]
    );

    // Older data stored commit metrics only in contributor_daily_activities.
    // Preserve those legacy values until a backfill creates repository-level
    // attribution; once any raw attribution exists, rebuild from tracked repos.
    await client.query(
        `WITH attributed AS (
             SELECT cra.contributor_id,
                    cra.snapshot_date,
                    COALESCE(SUM(cra.commits_count) FILTER (WHERE r.sig_id IS NOT NULL), 0)::INTEGER AS commits_count,
                    COALESCE(SUM(cra.lines_added) FILTER (WHERE r.sig_id IS NOT NULL), 0)::INTEGER AS lines_added,
                    COALESCE(SUM(cra.lines_deleted) FILTER (WHERE r.sig_id IS NOT NULL), 0)::INTEGER AS lines_deleted
             FROM contributor_repo_activities cra
             JOIN repositories r ON r.id = cra.repo_id
             WHERE r.org_id = $1
             GROUP BY cra.contributor_id, cra.snapshot_date
             HAVING BOOL_OR(cra.commits_count <> 0 OR cra.lines_added <> 0 OR cra.lines_deleted <> 0)
         )
         UPDATE contributor_daily_activities cda
         SET commits_count = attributed.commits_count,
             lines_added = attributed.lines_added,
             lines_deleted = attributed.lines_deleted
         FROM attributed
         WHERE cda.org_id = $1
           AND cda.contributor_id = attributed.contributor_id
           AND cda.snapshot_date = attributed.snapshot_date`,
        [orgId]
    );

    return result.rowCount || 0;
}

async function fetchRepositorySigAssignments({
    githubToken,
    orgName = DEFAULT_ORG_NAME,
    propertyName = DEFAULT_PROPERTY_NAME,
    httpClient = axios,
}) {
    const headers = githubHeaders(githubToken);
    const encodedOrg = encodeURIComponent(orgName);
    const encodedProperty = encodeURIComponent(propertyName);

    let definitionResponse;
    try {
        definitionResponse = await httpClient.get(
            `https://api.github.com/orgs/${encodedOrg}/properties/schema/${encodedProperty}`,
            { headers, timeout: 30000 }
        );
    } catch (error) {
        throw new Error(`Failed to fetch GitHub Custom Property ${propertyName}: ${error.message}`, { cause: error });
    }
    validatePropertyDefinition(definitionResponse.data, propertyName);

    const rows = [];
    const visitedPages = new Set();
    let nextUrl = `https://api.github.com/orgs/${encodedOrg}/properties/values?per_page=100`;

    while (nextUrl) {
        if (visitedPages.has(nextUrl)) {
            throw new Error(`GitHub Custom Property pagination repeated ${nextUrl}.`);
        }
        visitedPages.add(nextUrl);

        let response;
        try {
            response = await httpClient.get(nextUrl, { headers, timeout: 30000 });
        } catch (error) {
            throw new Error(`Failed to fetch repository Custom Property values: ${error.message}`, { cause: error });
        }
        if (!Array.isArray(response.data)) {
            throw new Error('GitHub repository Custom Property response must be an array.');
        }

        rows.push(...response.data);
        nextUrl = getNextPageUrl(response.headers?.link);
    }

    return normalizeAssignments(rows, propertyName);
}

async function reaggregateAffectedHistoricalSnapshots(client, orgId, affectedSigIds) {
    if (affectedSigIds.length === 0) {
        return { sigSnapshots: 0, organizationSnapshots: 0 };
    }

    const sigResult = await client.query(
        `WITH dates AS (
             SELECT DISTINCT rs.snapshot_date
             FROM repo_snapshots rs
             JOIN repositories r ON r.id = rs.repo_id
             WHERE r.org_id = $1
             UNION
             SELECT DISTINCT ss.snapshot_date
             FROM sig_snapshots ss
             JOIN special_interest_groups sig ON sig.id = ss.sig_id
             WHERE sig.org_id = $1
         ), aggregated AS (
             SELECT sig.id AS sig_id,
                    dates.snapshot_date,
                    COALESCE(SUM(rs.new_prs), 0)::INTEGER AS new_prs,
                    COALESCE(SUM(rs.closed_merged_prs), 0)::INTEGER AS closed_merged_prs,
                    COALESCE(SUM(rs.new_issues), 0)::INTEGER AS new_issues,
                    COALESCE(SUM(rs.closed_issues), 0)::INTEGER AS closed_issues,
                    COALESCE(SUM(rs.active_contributors), 0)::INTEGER AS active_contributors,
                    COALESCE(SUM(rs.new_commits), 0)::INTEGER AS new_commits,
                    COALESCE(SUM(rs.lines_added), 0)::INTEGER AS lines_added,
                    COALESCE(SUM(rs.lines_deleted), 0)::INTEGER AS lines_deleted
             FROM special_interest_groups sig
             CROSS JOIN dates
             LEFT JOIN repositories r ON r.sig_id = sig.id
             LEFT JOIN repo_snapshots rs
                    ON rs.repo_id = r.id
                   AND rs.snapshot_date = dates.snapshot_date
             WHERE sig.org_id = $1
               AND sig.id = ANY($2::INTEGER[])
             GROUP BY sig.id, dates.snapshot_date
         )
         INSERT INTO sig_snapshots (
             sig_id, snapshot_date, new_prs, closed_merged_prs, new_issues,
             closed_issues, active_contributors, new_commits, lines_added, lines_deleted
         )
         SELECT sig_id, snapshot_date, new_prs, closed_merged_prs, new_issues,
                closed_issues, active_contributors, new_commits, lines_added, lines_deleted
         FROM aggregated
         ON CONFLICT (sig_id, snapshot_date) DO UPDATE
         SET new_prs = EXCLUDED.new_prs,
             closed_merged_prs = EXCLUDED.closed_merged_prs,
             new_issues = EXCLUDED.new_issues,
             closed_issues = EXCLUDED.closed_issues,
             active_contributors = EXCLUDED.active_contributors,
             new_commits = EXCLUDED.new_commits,
             lines_added = EXCLUDED.lines_added,
             lines_deleted = EXCLUDED.lines_deleted,
             created_at = NOW()`,
        [orgId, affectedSigIds]
    );

    const organizationResult = await client.query(
        `WITH dates AS (
             SELECT DISTINCT ss.snapshot_date
             FROM sig_snapshots ss
             JOIN special_interest_groups sig ON sig.id = ss.sig_id
             WHERE sig.org_id = $1
         ), aggregated AS (
             SELECT dates.snapshot_date,
                    COALESCE(SUM(ss.new_prs), 0)::INTEGER AS new_prs,
                    COALESCE(SUM(ss.closed_merged_prs), 0)::INTEGER AS closed_merged_prs,
                    COALESCE(SUM(ss.new_issues), 0)::INTEGER AS new_issues,
                    COALESCE(SUM(ss.closed_issues), 0)::INTEGER AS closed_issues,
                    COALESCE(SUM(ss.active_contributors), 0)::INTEGER AS active_contributors,
                    COALESCE(SUM(ss.new_commits), 0)::INTEGER AS new_commits,
                    COALESCE(SUM(ss.lines_added), 0)::INTEGER AS lines_added,
                    COALESCE(SUM(ss.lines_deleted), 0)::INTEGER AS lines_deleted
             FROM dates
             LEFT JOIN special_interest_groups sig ON sig.org_id = $1
             LEFT JOIN sig_snapshots ss
                    ON ss.sig_id = sig.id
                   AND ss.snapshot_date = dates.snapshot_date
             GROUP BY dates.snapshot_date
         )
         INSERT INTO activity_snapshots (
             org_id, snapshot_date, new_prs, closed_merged_prs, new_issues,
             closed_issues, active_contributors, new_repos, new_commits, lines_added, lines_deleted
         )
         SELECT $1, snapshot_date, new_prs, closed_merged_prs, new_issues,
                closed_issues, active_contributors, 0, new_commits, lines_added, lines_deleted
         FROM aggregated
         ON CONFLICT (org_id, snapshot_date) DO UPDATE
         SET new_prs = EXCLUDED.new_prs,
             closed_merged_prs = EXCLUDED.closed_merged_prs,
             new_issues = EXCLUDED.new_issues,
             closed_issues = EXCLUDED.closed_issues,
             active_contributors = EXCLUDED.active_contributors,
             new_commits = EXCLUDED.new_commits,
             lines_added = EXCLUDED.lines_added,
             lines_deleted = EXCLUDED.lines_deleted,
             created_at = NOW()`,
        [orgId]
    );

    return {
        sigSnapshots: sigResult.rowCount || 0,
        organizationSnapshots: organizationResult.rowCount || 0,
    };
}

async function applyRepositorySigAssignments({ pool, assignments, orgName = DEFAULT_ORG_NAME }) {
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

        const sigIdsBySlug = new Map();
        for (const [slug, name] of Object.entries(SIG_DEFINITIONS)) {
            const sigResult = await client.query(
                `INSERT INTO special_interest_groups (org_id, slug, name)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name
                 RETURNING id`,
                [orgId, slug, name]
            );
            sigIdsBySlug.set(slug, sigResult.rows[0].id);
        }

        const existingResult = await client.query(
            `SELECT r.id, r.github_id, r.name, r.sig_id, sig.slug AS sig_slug
             FROM repositories r
             LEFT JOIN special_interest_groups sig ON sig.id = r.sig_id
             WHERE r.org_id = $1`,
            [orgId]
        );
        const existingByName = new Map();
        const existingByGithubId = new Map();
        for (const repository of existingResult.rows) {
            const normalizedName = repository.name.toLowerCase();
            if (existingByName.has(normalizedName)) {
                throw new Error(`Database contains duplicate repository names ignoring case: ${repository.name}`);
            }
            existingByName.set(normalizedName, repository);
            if (repository.github_id !== null) {
                const githubId = String(repository.github_id);
                if (existingByGithubId.has(githubId)) {
                    throw new Error(`Database contains duplicate GitHub repository ID: ${githubId}`);
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

        const assignmentPlans = assignments.map((assignment) => {
            let existing = existingByGithubId.get(assignment.repositoryId);
            if (!existing) {
                const nameMatch = existingByName.get(assignment.repositoryName.toLowerCase());
                if (nameMatch?.github_id === null) {
                    existing = nameMatch;
                }
            }

            if (existing) {
                matchedRepositoryIds.add(existing.id);
            }

            return { assignment, existing };
        });

        // Vacate names before applying final updates. This supports both rename
        // swaps and a new GitHub repository reusing the name of a deleted one,
        // while retaining the old row and all history under its stable ID.
        const plansByExistingId = new Map(
            assignmentPlans
                .filter((plan) => plan.existing)
                .map((plan) => [plan.existing.id, plan])
        );
        const repositoriesToVacate = new Map();
        for (const plan of assignmentPlans) {
            if (plan.existing && plan.existing.name !== plan.assignment.repositoryName) {
                repositoriesToVacate.set(plan.existing.id, plan.existing);
            }

            const nameOccupant = existingByName.get(plan.assignment.repositoryName.toLowerCase());
            if (nameOccupant && nameOccupant.id !== plan.existing?.id) {
                const occupantPlan = plansByExistingId.get(nameOccupant.id);
                if (occupantPlan && occupantPlan.existing.name === occupantPlan.assignment.repositoryName) {
                    throw new Error(`Multiple repositories would use the name ${plan.assignment.repositoryName}.`);
                }
                repositoriesToVacate.set(nameOccupant.id, nameOccupant);
            }
        }

        const reservedNames = new Set([
            ...existingResult.rows.map((repository) => repository.name.toLowerCase()),
            ...assignments.map((assignment) => assignment.repositoryName.toLowerCase()),
        ]);
        for (const repository of repositoriesToVacate.values()) {
            const temporaryName = reserveTemporaryRepositoryName(repository, reservedNames);
            await client.query('UPDATE repositories SET name = $1 WHERE id = $2', [temporaryName, repository.id]);
        }

        for (const { assignment, existing } of assignmentPlans) {
            const targetSigId = assignment.sigSlug === null ? null : sigIdsBySlug.get(assignment.sigSlug);

            if (!existing) {
                await client.query(
                    `INSERT INTO repositories (org_id, sig_id, github_id, name)
                     VALUES ($1, $2, $3, $4)`,
                    [orgId, targetSigId, assignment.repositoryId, assignment.repositoryName]
                );
                if (targetSigId !== null) {
                    affectedSigIds.add(targetSigId);
                }
                changes.push({ repository: assignment.repositoryName, from: null, to: assignment.sigSlug });
                created += 1;
                continue;
            }

            const mappingChanged = existing.sig_slug !== assignment.sigSlug;
            const nameChanged = existing.name !== assignment.repositoryName;
            const githubIdChanged = existing.github_id === null;
            if (mappingChanged || nameChanged || githubIdChanged) {
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
                if (targetSigId !== null) {
                    affectedSigIds.add(targetSigId);
                }
            }
            if (mappingChanged || nameChanged) {
                changes.push({
                    repository: assignment.repositoryName,
                    ...(nameChanged ? { previousRepository: existing.name } : {}),
                    from: existing.sig_slug,
                    to: assignment.sigSlug,
                });
            }
        }

        for (const repository of existingResult.rows) {
            if (!matchedRepositoryIds.has(repository.id) && repository.sig_id !== null) {
                affectedSigIds.add(repository.sig_id);
                await client.query('UPDATE repositories SET sig_id = NULL WHERE id = $1', [repository.id]);
                changes.push({ repository: repository.name, from: repository.sig_slug, to: null });
                disabled += 1;
                trackingChanged = true;
            }
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
            organization: orgName,
            repositories: assignments.length,
            tracked: assignments.filter((assignment) => assignment.sigSlug !== null).length,
            untracked: assignments.filter((assignment) => assignment.sigSlug === null).length,
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

async function syncRepositorySigsFromGitHub({
    pool,
    githubToken,
    orgName = DEFAULT_ORG_NAME,
    propertyName = DEFAULT_PROPERTY_NAME,
    httpClient = axios,
}) {
    const assignments = await fetchRepositorySigAssignments({
        githubToken,
        orgName,
        propertyName,
        httpClient,
    });

    return applyRepositorySigAssignments({ pool, assignments, orgName });
}

module.exports = {
    DEFAULT_ORG_NAME,
    DEFAULT_PROPERTY_NAME,
    SIG_DEFINITIONS,
    UNTRACKED_VALUE,
    getNextPageUrl,
    normalizeAssignments,
    validatePropertyDefinition,
    fetchRepositorySigAssignments,
    reaggregateContributorDailyActivities,
    reaggregateAffectedHistoricalSnapshots,
    applyRepositorySigAssignments,
    syncRepositorySigsFromGitHub,
};
