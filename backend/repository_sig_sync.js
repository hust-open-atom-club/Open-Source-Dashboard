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
            repositoryName,
            propertyValue,
            sigSlug: propertyValue === UNTRACKED_VALUE ? null : propertyValue,
        });
    }

    assignments.sort((left, right) => left.repositoryName.localeCompare(right.repositoryName));
    return assignments;
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
            `SELECT r.id, r.name, r.sig_id, sig.slug AS sig_slug
             FROM repositories r
             LEFT JOIN special_interest_groups sig ON sig.id = r.sig_id
             WHERE r.org_id = $1`,
            [orgId]
        );
        const existingByName = new Map();
        for (const repository of existingResult.rows) {
            const normalizedName = repository.name.toLowerCase();
            if (existingByName.has(normalizedName)) {
                throw new Error(`Database contains duplicate repository names ignoring case: ${repository.name}`);
            }
            existingByName.set(normalizedName, repository);
        }

        const remoteNames = new Set(assignments.map((assignment) => assignment.repositoryName.toLowerCase()));
        const affectedSigIds = new Set();
        const changes = [];
        let created = 0;
        let disabled = 0;

        for (const repository of existingResult.rows) {
            if (!remoteNames.has(repository.name.toLowerCase()) && repository.sig_id !== null) {
                affectedSigIds.add(repository.sig_id);
                await client.query('UPDATE repositories SET sig_id = NULL WHERE id = $1', [repository.id]);
                changes.push({ repository: repository.name, from: repository.sig_slug, to: null });
                disabled += 1;
            }
        }

        for (const assignment of assignments) {
            const existing = existingByName.get(assignment.repositoryName.toLowerCase());
            const targetSigId = assignment.sigSlug === null ? null : sigIdsBySlug.get(assignment.sigSlug);

            if (!existing) {
                await client.query(
                    `INSERT INTO repositories (org_id, sig_id, name)
                     VALUES ($1, $2, $3)`,
                    [orgId, targetSigId, assignment.repositoryName]
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
            if (mappingChanged || nameChanged) {
                await client.query(
                    `UPDATE repositories
                     SET name = $1, sig_id = $2
                     WHERE id = $3`,
                    [assignment.repositoryName, targetSigId, existing.id]
                );
            }
            if (mappingChanged) {
                if (existing.sig_id !== null) {
                    affectedSigIds.add(existing.sig_id);
                }
                if (targetSigId !== null) {
                    affectedSigIds.add(targetSigId);
                }
                changes.push({
                    repository: assignment.repositoryName,
                    from: existing.sig_slug,
                    to: assignment.sigSlug,
                });
            }
        }

        const reaggregation = await reaggregateAffectedHistoricalSnapshots(
            client,
            orgId,
            [...affectedSigIds]
        );

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
    reaggregateAffectedHistoricalSnapshots,
    applyRepositorySigAssignments,
    syncRepositorySigsFromGitHub,
};
