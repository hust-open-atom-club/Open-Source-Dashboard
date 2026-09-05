const { isBotContributor } = require('./contributor_filters');
const { persistRepoApiStats: defaultPersistRepoApiStats } = require('./contributor_api_stats');

function recordContributorActivities(contributorStats, items, metric) {
    for (const item of items) {
        const username = item.user.login;
        if (isBotContributor(username)) continue;

        if (!contributorStats.has(username)) {
            contributorStats.set(username, {
                username,
                avatar_url: item.user.avatar_url,
                github_id: item.user.id,
                prs_opened: 0,
                prs_closed: 0,
                issues_opened: 0,
                issues_closed: 0,
            });
        }
        contributorStats.get(username)[metric]++;
    }
}

async function collectAndPersistRepoApiStats({
    githubRest,
    pool,
    orgName,
    repoId,
    repoName,
    snapshotDate,
    persistRepoApiStats = defaultPersistRepoApiStats,
}) {
    const repoQuery = `repo:${orgName}/${repoName}`;

    // Keep these requests sequential because GitHub's Search API has a low rate limit
    // and githubRest applies the delay and pagination policy between requests.
    const createdPrs = await githubRest('/search/issues', {
        q: `${repoQuery} is:pr created:${snapshotDate}`,
        per_page: 100,
    });
    const createdIssues = await githubRest('/search/issues', {
        q: `${repoQuery} is:issue -is:pr created:${snapshotDate}`,
        per_page: 100,
    });
    const closedPrs = await githubRest('/search/issues', {
        q: `${repoQuery} is:pr is:closed closed:${snapshotDate}`,
        per_page: 100,
    });
    const closedIssues = await githubRest('/search/issues', {
        q: `${repoQuery} is:issue -is:pr is:closed closed:${snapshotDate}`,
        per_page: 100,
    });

    const contributorStats = new Map();
    recordContributorActivities(contributorStats, createdPrs.items, 'prs_opened');
    recordContributorActivities(contributorStats, closedPrs.items, 'prs_closed');
    recordContributorActivities(contributorStats, createdIssues.items, 'issues_opened');
    recordContributorActivities(contributorStats, closedIssues.items, 'issues_closed');

    const apiMetrics = {
        new_prs: createdPrs.total_count,
        closed_merged_prs: closedPrs.total_count,
        new_issues: createdIssues.total_count,
        closed_issues: closedIssues.total_count,
        active_contributors: contributorStats.size,
    };
    const contributorDetails = Array.from(contributorStats.values());

    const persistenceResult = await persistRepoApiStats({
        pool,
        orgName,
        repoId,
        snapshotDate,
        apiMetrics,
        contributorDetails,
    });

    return {
        ...persistenceResult,
        apiMetrics,
        contributorDetails,
    };
}

module.exports = {
    collectAndPersistRepoApiStats,
};
