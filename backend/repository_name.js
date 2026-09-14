// Local repositories retain their short names; external ones use owner/name.
function resolveRepository(repoName, orgName) {
    const parts = repoName.split('/');
    return parts.length === 2
        ? { owner: parts[0], repo: parts[1] }
        : { owner: orgName, repo: repoName };
}

module.exports = { resolveRepository };
