const { buildHumanContributorSqlCondition } = require('./contributor_filters');

const HUMAN_CONTRIBUTOR_SQL = buildHumanContributorSqlCondition('c.github_username');

const REPOSITORY_INSIGHTS_SQL = `
    WITH eligible_repositories AS (
        SELECT
            r.id,
            r.name,
            sig.id AS sig_id,
            sig.name AS sig_name
        FROM repositories r
        JOIN special_interest_groups sig ON sig.id = r.sig_id
        WHERE r.org_id = $1
          AND r.is_in_organization = TRUE
          AND r.sig_id IS NOT NULL
    ),
    snapshot_totals AS (
        SELECT
            rs.repo_id,
            COALESCE(SUM(rs.new_prs), 0) AS new_prs,
            COALESCE(SUM(rs.closed_merged_prs), 0) AS closed_merged_prs,
            COALESCE(SUM(rs.new_issues), 0) AS new_issues,
            COALESCE(SUM(rs.closed_issues), 0) AS closed_issues,
            COALESCE(SUM(rs.new_commits), 0) AS new_commits,
            COALESCE(SUM(rs.lines_added), 0) AS lines_added,
            COALESCE(SUM(rs.lines_deleted), 0) AS lines_deleted,
            MAX(rs.snapshot_date) FILTER (
                WHERE rs.new_prs <> 0
                   OR rs.closed_merged_prs <> 0
                   OR rs.new_issues <> 0
                   OR rs.closed_issues <> 0
                   OR rs.new_commits <> 0
            ) AS last_active_date
        FROM repo_snapshots rs
        JOIN eligible_repositories er ON er.id = rs.repo_id
        WHERE rs.snapshot_date >= $2
        GROUP BY rs.repo_id
    ),
    contributor_totals AS (
        SELECT
            cra.repo_id,
            COUNT(DISTINCT cra.contributor_id) AS active_contributors
        FROM contributor_repo_activities cra
        JOIN eligible_repositories er ON er.id = cra.repo_id
        JOIN contributors c ON c.id = cra.contributor_id
        WHERE cra.snapshot_date >= $2
          AND ${HUMAN_CONTRIBUTOR_SQL}
          AND (
              cra.prs_opened <> 0
              OR cra.prs_closed <> 0
              OR cra.issues_opened <> 0
              OR cra.issues_closed <> 0
              OR cra.commits_count <> 0
              OR cra.lines_added <> 0
              OR cra.lines_deleted <> 0
          )
        GROUP BY cra.repo_id
    )
    SELECT
        er.id,
        er.name,
        er.sig_id,
        er.sig_name,
        COALESCE(st.new_prs, 0) AS new_prs,
        COALESCE(st.closed_merged_prs, 0) AS closed_merged_prs,
        COALESCE(st.new_issues, 0) AS new_issues,
        COALESCE(st.closed_issues, 0) AS closed_issues,
        COALESCE(st.new_commits, 0) AS new_commits,
        COALESCE(st.lines_added, 0) AS lines_added,
        COALESCE(st.lines_deleted, 0) AS lines_deleted,
        COALESCE(ct.active_contributors, 0) AS active_contributors,
        st.last_active_date
    FROM eligible_repositories er
    LEFT JOIN snapshot_totals st ON st.repo_id = er.id
    LEFT JOIN contributor_totals ct ON ct.repo_id = er.id
    ORDER BY er.name ASC`;

function toInteger(value) {
    return Number.parseInt(value, 10) || 0;
}

function formatSnapshotDate(value) {
    if (!value) {
        return null;
    }

    if (typeof value === 'string') {
        return value.slice(0, 10);
    }

    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function mapRepositoryInsightRow(row, organizationName) {
    const metrics = {
        new_prs: toInteger(row.new_prs),
        closed_merged_prs: toInteger(row.closed_merged_prs),
        new_issues: toInteger(row.new_issues),
        closed_issues: toInteger(row.closed_issues),
        new_commits: toInteger(row.new_commits),
        active_contributors: toInteger(row.active_contributors),
        lines_added: toInteger(row.lines_added),
        lines_deleted: toInteger(row.lines_deleted),
    };

    return {
        id: toInteger(row.id),
        name: row.name,
        url: `https://github.com/${row.name.includes('/')
            ? row.name.split('/').map(encodeURIComponent).join('/')
            : `${organizationName}/${encodeURIComponent(row.name)}`}`,
        sig: {
            id: toInteger(row.sig_id),
            name: row.sig_name,
        },
        ...metrics,
        is_active: metrics.new_prs > 0
            || metrics.closed_merged_prs > 0
            || metrics.new_issues > 0
            || metrics.closed_issues > 0
            || metrics.new_commits > 0,
        last_active_date: formatSnapshotDate(row.last_active_date),
    };
}

function mapRepositoryInsightRows(rows, organizationName) {
    return rows.map((row) => mapRepositoryInsightRow(row, organizationName));
}

async function invalidateRepositoryInsightCache(redisClient, organizationName) {
    const pattern = `org:${organizationName}:repositories:range:*`;
    const cacheKeys = [];

    for await (const key of redisClient.scanIterator({
        MATCH: pattern,
        COUNT: 100,
    })) {
        cacheKeys.push(key);
    }

    if (cacheKeys.length > 0) {
        await redisClient.del(cacheKeys);
    }

    return cacheKeys.length;
}

module.exports = {
    REPOSITORY_INSIGHTS_SQL,
    invalidateRepositoryInsightCache,
    mapRepositoryInsightRow,
    mapRepositoryInsightRows,
};
