const BOT_CONTRIBUTOR_USERNAMES = [
    'copilot-swe-agent',
    'dependabot',
    'dependabot-preview',
    'github-actions',
    'github-actions[bot]',
    'renovate',
    'renovate[bot]',
];

function normalizeUsername(username) {
    return String(username || '').trim().toLowerCase();
}

function isBotContributor(username) {
    const normalized = normalizeUsername(username);

    if (!normalized) {
        return false;
    }

    if (normalized.endsWith('[bot]')) {
        return true;
    }

    return BOT_CONTRIBUTOR_USERNAMES.includes(normalized);
}

function filterBotContributors(contributors) {
    return contributors.filter((contributor) => !isBotContributor(contributor?.username));
}

function buildHumanContributorSqlCondition(columnName = 'c.github_username') {
    const literals = BOT_CONTRIBUTOR_USERNAMES
        .map((username) => `'${username.replace(/'/g, "''")}'`)
        .join(', ');

    return `LOWER(${columnName}) NOT LIKE '%[bot]' AND LOWER(${columnName}) NOT IN (${literals})`;
}

module.exports = {
    BOT_CONTRIBUTOR_USERNAMES,
    isBotContributor,
    filterBotContributors,
    buildHumanContributorSqlCondition,
};
