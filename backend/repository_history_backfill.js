const { findMissingRepositorySnapshots } = require('./repository_snapshot_coverage');
const { validateBatch, publishSnapshotBatch } = require('./snapshot_batch');

// Bound each automatic run; newest gaps (real recent activity) are repaired
// first. Successful dates disappear from the next scan, including after restart.
async function repairMissingRepositoryHistory({ pool, orgId, orgName, fetchCommits, fetchApi,
    afterCommit = async () => {}, maxDates = 31, onPublished = async () => {} }) {
    if (!Number.isInteger(maxDates) || maxDates < 1 || maxDates > 366) throw new Error('Invalid history repair date limit');
    const client = await pool.connect();
    let generation, missing;
    try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const org = (await client.query('SELECT snapshot_generation FROM organizations WHERE id = $1 AND name = $2', [orgId, orgName])).rows[0];
        if (!org) throw new Error('Organization not found');
        generation = String(org.snapshot_generation);
        missing = await findMissingRepositorySnapshots(client, orgId);
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally { client.release(); }
    const dates = [...new Set(missing.map(row => row.snapshot_date))].sort().reverse().slice(0, maxDates);
    let published = 0;
    for (let index = 0; index < dates.length;) {
        const newest = Date.parse(dates[index]);
        const chunk = [];
        while (index < dates.length && chunk.length < 7 && newest - Date.parse(dates[index]) <= 6 * 86400000) {
            chunk.push(dates[index++]);
        }
        chunk.sort();
        const selected = missing.filter(row => chunk.includes(row.snapshot_date));
        const repositories = [...new Map(selected.map(row => [row.repo_id,
            { id: row.repo_id, name: row.name, sig_id: row.sig_id }])).values()];
        const histories = new Map();
        // Never clip at github_created_at or assume pre-creation zeros. Query
        // history so imported commits survive; explicit zeros require success.
        for (const repo of repositories) {
            const first = new Date(`${chunk[0]}T00:00:00`);
            const last = new Date(`${chunk.at(-1)}T00:00:00`);
            histories.set(repo.id, { commits: await fetchCommits(repo, first, last), api: await fetchApi(repo, first, last) });
        }
        const batches = chunk.map(snapshotDate => {
            const repos = repositories.filter(repo => selected.some(row => row.repo_id === repo.id && row.snapshot_date === snapshotDate));
            const entries = repos.map(repo => {
                const history = histories.get(repo.id);
                const contributors = history.api.contributorDetailsMap.get(snapshotDate);
                if (!contributors) throw new Error('Missing contributor history facts');
                return { repoId: repo.id, commitStats: history.commits.get(snapshotDate),
                    apiMetrics: history.api.statsMap.get(snapshotDate), contributorDetails: Array.from(contributors.values()) };
            });
            validateBatch(repos, entries, snapshotDate);
            return { snapshotDate, repositories: repos, entries };
        });
        for (const batch of batches) {
            await publishSnapshotBatch({ pool, orgId, orgName, ...batch, partial: true,
                expectedGeneration: generation, afterCommit });
            generation = String(BigInt(generation) + 1n);
            published += 1;
            await onPublished(batch.snapshotDate);
        }
    }
    return { publishedDates: published, remainingDates: new Set(missing.map(row => row.snapshot_date)).size - published };
}

module.exports = { repairMissingRepositoryHistory };
