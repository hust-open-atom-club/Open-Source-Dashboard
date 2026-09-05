const assert = require('node:assert/strict');
const test = require('node:test');

const { persistRepoCommitStats } = require('../commit_author_stats');

function buildCommitStats(authorStats = {}, overrides = {}) {
    return {
        new_commits: 2,
        lines_added: 15,
        lines_deleted: 4,
        authorStats,
        ...overrides,
    };
}

function createDatabaseDouble({
    failOn,
    existingContributorId,
    nullIdOccupantId,
    legacyDailyRows = [],
} = {}) {
    const queries = [];
    let released = false;

    const client = {
        async query(sql, params = []) {
            const text = sql.trim();
            queries.push({ sql: text, params });

            if (failOn && text.includes(failOn)) {
                throw new Error('database write failed');
            }
            if (text.startsWith('SELECT org_id')) {
                return { rows: [{ org_id: 7 }] };
            }
            if (text.startsWith('SELECT contributor_id')) {
                return { rows: [{ contributor_id: 41 }] };
            }
            if (text.startsWith('SELECT cda.org_id')) {
                return { rows: legacyDailyRows };
            }
            if (text.startsWith('INSERT INTO repo_snapshots')) {
                return { rows: [{ id: 99 }], rowCount: 1 };
            }
            if (text.startsWith('UPDATE repo_snapshots') && text.includes('SET new_commits')) {
                return { rows: [], rowCount: 0 };
            }
            if (text.startsWith('SELECT id') && text.includes('github_username = $1 AND github_id IS NULL')) {
                return { rows: nullIdOccupantId ? [{ id: nullIdOccupantId }] : [] };
            }
            if (text.startsWith('SELECT id') && text.includes('WHERE github_id = $1')) {
                return { rows: existingContributorId ? [{ id: existingContributorId }] : [] };
            }
            if (text.startsWith('UPDATE contributors') && text.includes('WHERE github_id = $2')) {
                return { rows: existingContributorId ? [{ id: existingContributorId }] : [] };
            }
            if (text.startsWith('INSERT INTO contributors')) {
                return { rows: [{ id: 42 }] };
            }
            return { rows: [], rowCount: 1 };
        },
        release() {
            released = true;
        },
    };

    return {
        pool: { connect: async () => client },
        queries,
        wasReleased: () => released,
    };
}

test('commit authors are persisted and organization daily totals are rebuilt', async () => {
    const database = createDatabaseDouble();

    const result = await persistRepoCommitStats({
        pool: database.pool,
        repoId: 11,
        snapshotDate: '2026-09-02',
        commitStats: buildCommitStats({
            alice: {
                github_id: 101,
                avatar_url: 'https://example.test/alice',
                commits: 2,
                lines_added: 15,
                lines_deleted: 4,
            },
        }),
    });

    assert.equal(database.queries[0].sql, 'BEGIN');
    assert.equal(database.queries.at(-1).sql, 'COMMIT');
    assert.equal(database.wasReleased(), true);
    assert.deepEqual(result, { stored: true, snapshotId: 99 });

    const snapshotInsert = database.queries.find((query) =>
        query.sql.startsWith('INSERT INTO repo_snapshots')
    );
    assert.deepEqual(snapshotInsert.params, [11, '2026-09-02', 2, 15, 4]);

    const contributorInsert = database.queries.find((query) => query.sql.startsWith('INSERT INTO contributors'));
    assert.deepEqual(contributorInsert.params, [
        'alice',
        101,
        'https://example.test/alice',
        '2026-09-02',
    ]);

    const repoActivityInsert = database.queries.find((query) => query.sql.startsWith('INSERT INTO contributor_repo_activities'));
    assert.deepEqual(repoActivityInsert.params, [42, 11, '2026-09-02', 2, 15, 4]);

    const identityLockQuery = database.queries.find((query) =>
        query.sql.includes("hashtext('osd:contributor-identity')")
    );
    assert.deepEqual(identityLockQuery.params, [7]);
    const dailyLockQuery = database.queries.find((query) =>
        query.sql.includes('hashtext($2::text)')
    );
    assert.deepEqual(dailyLockQuery.params, [7, '2026-09-02']);
    const identityLockIndex = database.queries.indexOf(identityLockQuery);
    const dailyLockIndex = database.queries.indexOf(dailyLockQuery);
    const firstContributorWriteIndex = database.queries.findIndex((query) =>
        query.sql.startsWith('UPDATE contributor_repo_activities') ||
        query.sql.startsWith('UPDATE contributors') ||
        query.sql.startsWith('INSERT INTO contributors')
    );
    assert.ok(identityLockIndex < dailyLockIndex);
    assert.ok(dailyLockIndex < database.queries.indexOf(snapshotInsert));
    assert.ok(database.queries.indexOf(snapshotInsert) < firstContributorWriteIndex);
    assert.ok(dailyLockIndex < firstContributorWriteIndex);

    assert.match(contributorInsert.sql, /first_seen_date = LEAST/);

    const dailyInsert = database.queries.find((query) => query.sql.startsWith('INSERT INTO contributor_daily_activities'));
    assert.deepEqual(dailyInsert.params, [7, '2026-09-02', [41, 42]]);
    assert.match(dailyInsert.sql, /SUM\(cra\.commits_count\)/);
    assert.match(dailyInsert.sql, /r\.sig_id IS NOT NULL/);
    assert.match(dailyInsert.sql, /cra\.commits_count <> 0/);

    const emptyRepoActivityDelete = database.queries.find((query) =>
        query.sql.startsWith('DELETE FROM contributor_repo_activities')
    );
    assert.deepEqual(emptyRepoActivityDelete.params, [11, '2026-09-02']);
    const seenDatesUpdate = database.queries.find((query) =>
        query.sql.startsWith('UPDATE contributors AS contributor')
    );
    assert.deepEqual(seenDatesUpdate.params, [[41, 42]]);
    assert.match(seenDatesUpdate.sql, /MIN\(cra\.snapshot_date\)/);
    assert.match(seenDatesUpdate.sql, /MAX\(cra\.snapshot_date\)/);
    assert.match(seenDatesUpdate.sql, /r\.sig_id IS NOT NULL/);
    assert.ok(database.queries.indexOf(emptyRepoActivityDelete) < database.queries.indexOf(seenDatesUpdate));
    const dailyDelete = database.queries.find((query) =>
        query.sql.startsWith('DELETE FROM contributor_daily_activities')
    );
    assert.deepEqual(dailyDelete.params, [7, '2026-09-02', [41, 42]]);
    assert.ok(database.queries.indexOf(dailyDelete) < database.queries.indexOf(dailyInsert));

    const activeContributorUpdate = database.queries.find((query) =>
        query.sql.startsWith('UPDATE repo_snapshots')
    );
    assert.deepEqual(activeContributorUpdate.params, [11, '2026-09-02']);
    assert.match(activeContributorUpdate.sql, /COUNT\(DISTINCT cra\.contributor_id\)/);
    assert.ok(database.queries.indexOf(dailyInsert) < database.queries.indexOf(activeContributorUpdate));
});

test('commit author persistence rolls back and propagates write failures', async () => {
    const database = createDatabaseDouble({ failOn: 'INSERT INTO contributor_repo_activities' });

    await assert.rejects(
        persistRepoCommitStats({
            pool: database.pool,
            repoId: 11,
            snapshotDate: '2026-09-02',
            commitStats: buildCommitStats({
                alice: {
                    github_id: 101,
                    avatar_url: null,
                    commits: 1,
                    lines_added: 3,
                    lines_deleted: 1,
                },
            }, { new_commits: 1, lines_added: 3, lines_deleted: 1 }),
        }),
        /database write failed/
    );

    assert.equal(database.queries.some((query) => query.sql === 'ROLLBACK'), true);
    assert.equal(database.queries.some((query) => query.sql === 'COMMIT'), false);
    assert.equal(database.queries.some((query) => query.sql.startsWith('INSERT INTO repo_snapshots')), true);
    assert.equal(database.wasReleased(), true);
});

test('update-only correction leaves contributor facts untouched when the snapshot is absent', async () => {
    const database = createDatabaseDouble();

    const result = await persistRepoCommitStats({
        pool: database.pool,
        repoId: 11,
        snapshotDate: '2026-09-02',
        commitStats: buildCommitStats(),
        updateOnly: true,
    });

    assert.deepEqual(result, { stored: false, snapshotId: null });
    assert.equal(database.queries.at(-1).sql, 'COMMIT');
    assert.equal(database.queries.some((query) =>
        query.sql.startsWith('UPDATE contributor_repo_activities')
    ), false);
    assert.equal(database.queries.some((query) =>
        query.sql.startsWith('INSERT INTO contributor_daily_activities')
    ), false);
    assert.equal(database.wasReleased(), true);
});

test('commit authors are resolved by stable GitHub ID across username changes', async () => {
    const database = createDatabaseDouble({ existingContributorId: 73 });

    await persistRepoCommitStats({
        pool: database.pool,
        repoId: 11,
        snapshotDate: '2025-08-01',
        commitStats: buildCommitStats({
            'alice-renamed': {
                github_id: 101,
                avatar_url: 'https://example.test/alice-new',
                commits: 1,
                lines_added: 3,
                lines_deleted: 1,
            },
        }, { new_commits: 1, lines_added: 3, lines_deleted: 1 }),
    });

    const identityUpdate = database.queries.find((query) =>
        query.sql.startsWith('UPDATE contributors') && query.sql.includes('WHERE github_id = $2')
    );
    assert.deepEqual(identityUpdate.params, [
        'alice-renamed',
        101,
        'https://example.test/alice-new',
        '2025-08-01',
    ]);
    assert.match(identityUpdate.sql, /first_seen_date = LEAST/);
    assert.equal(database.queries.some((query) => query.sql.startsWith('INSERT INTO contributors')), false);

    const repoActivityInsert = database.queries.find((query) => query.sql.startsWith('INSERT INTO contributor_repo_activities'));
    assert.deepEqual(repoActivityInsert.params, [73, 11, '2025-08-01', 1, 3, 1]);
});

test('cleared commit authors are removed from repository and daily activity summaries', async () => {
    const database = createDatabaseDouble();

    await persistRepoCommitStats({
        pool: database.pool,
        repoId: 11,
        snapshotDate: '2026-09-02',
        commitStats: buildCommitStats({}, { new_commits: 0, lines_added: 0, lines_deleted: 0 }),
    });

    const repoActivityDelete = database.queries.find((query) =>
        query.sql.startsWith('DELETE FROM contributor_repo_activities')
    );
    assert.deepEqual(repoActivityDelete.params, [11, '2026-09-02']);
    assert.match(repoActivityDelete.sql, /COALESCE\(prs_opened, 0\) = 0/);
    assert.match(repoActivityDelete.sql, /COALESCE\(commits_count, 0\) = 0/);

    const dailyDelete = database.queries.find((query) =>
        query.sql.startsWith('DELETE FROM contributor_daily_activities')
    );
    const dailyInsert = database.queries.find((query) =>
        query.sql.startsWith('INSERT INTO contributor_daily_activities')
    );
    assert.deepEqual(dailyDelete.params, [7, '2026-09-02', [41]]);
    const seenDatesUpdate = database.queries.find((query) =>
        query.sql.startsWith('UPDATE contributors AS contributor')
    );
    assert.deepEqual(seenDatesUpdate.params, [[41]]);
    assert.ok(database.queries.indexOf(dailyDelete) < database.queries.indexOf(dailyInsert));
});

test('recycled GitHub usernames are detached from the old ID before inserting the new identity', async () => {
    const database = createDatabaseDouble();

    await persistRepoCommitStats({
        pool: database.pool,
        repoId: 11,
        snapshotDate: '2026-09-02',
        commitStats: buildCommitStats({
            alice: {
                github_id: 202,
                avatar_url: 'https://example.test/new-alice',
                commits: 1,
                lines_added: 2,
                lines_deleted: 0,
            },
        }, { new_commits: 1, lines_added: 2, lines_deleted: 0 }),
    });

    const recycledUsernameUpdate = database.queries.find((query) =>
        query.sql.includes("github_username = github_username || '~'")
    );
    assert.deepEqual(recycledUsernameUpdate.params, ['alice', 202]);
    assert.match(recycledUsernameUpdate.sql, /github_id <> \$2/);

    const identityUpdate = database.queries.find((query) =>
        query.sql.startsWith('UPDATE contributors') && query.sql.includes('WHERE github_id = $2')
    );
    const contributorInsert = database.queries.find((query) =>
        query.sql.startsWith('INSERT INTO contributors')
    );
    assert.ok(database.queries.indexOf(recycledUsernameUpdate) < database.queries.indexOf(identityUpdate));
    assert.ok(database.queries.indexOf(identityUpdate) < database.queries.indexOf(contributorInsert));
    assert.deepEqual(contributorInsert.params, [
        'alice',
        202,
        'https://example.test/new-alice',
        '2026-09-02',
    ]);
});

test('a null-ID username occupant is merged before an ID-backed identity is renamed', async () => {
    const database = createDatabaseDouble({
        existingContributorId: 73,
        nullIdOccupantId: 42,
        legacyDailyRows: [{
            org_id: 7,
            snapshot_date: new Date(2025, 2, 4),
            commits_count: '3',
            lines_added: '10',
            lines_deleted: '2',
        }],
    });

    await persistRepoCommitStats({
        pool: database.pool,
        repoId: 11,
        snapshotDate: '2026-09-02',
        commitStats: buildCommitStats({
            alice: {
                github_id: 101,
                avatar_url: 'https://example.test/alice',
                commits: 1,
                lines_added: 2,
                lines_deleted: 0,
            },
        }, { new_commits: 1, lines_added: 2, lines_deleted: 0 }),
    });

    const repoFactsMerge = database.queries.find((query) =>
        query.sql.startsWith('INSERT INTO contributor_repo_activities') &&
        query.sql.includes('SELECT $1, repo_id')
    );
    assert.deepEqual(repoFactsMerge.params, [73, 42]);
    assert.match(repoFactsMerge.sql, /COALESCE\(contributor_repo_activities\.commits_count, 0\)/);

    const legacyDailyCapture = database.queries.find((query) =>
        query.sql.startsWith('SELECT cda.org_id')
    );
    assert.deepEqual(legacyDailyCapture.params, [[42, 73]]);
    assert.match(legacyDailyCapture.sql, /NOT EXISTS/);
    assert.match(legacyDailyCapture.sql, /activity\.commits_count <> 0/);
    assert.ok(database.queries.indexOf(legacyDailyCapture) < database.queries.indexOf(repoFactsMerge));

    const historicalRepoCounts = database.queries.find((query) =>
        query.sql.startsWith('UPDATE repo_snapshots AS snapshot')
    );
    assert.deepEqual(historicalRepoCounts.params, [73]);
    assert.match(historicalRepoCounts.sql, /COUNT\(DISTINCT activity\.contributor_id\)/);
    assert.match(historicalRepoCounts.sql, /WHERE contributor_id = \$1/);

    const historicalSigCounts = database.queries.find((query) =>
        query.sql.startsWith('UPDATE sig_snapshots AS snapshot')
    );
    assert.deepEqual(historicalSigCounts.params, [73]);
    assert.match(historicalSigCounts.sql, /SUM\(repo_snapshot\.active_contributors\)/);
    assert.match(historicalSigCounts.sql, /repo\.sig_id IS NOT NULL/);
    const historicalOrgCounts = database.queries.find((query) =>
        query.sql.startsWith('UPDATE activity_snapshots AS snapshot')
    );
    assert.deepEqual(historicalOrgCounts.params, [73]);
    assert.match(historicalOrgCounts.sql, /SUM\(sig_snapshot\.active_contributors\)/);
    assert.match(historicalOrgCounts.sql, /repo\.sig_id IS NOT NULL/);
    assert.ok(database.queries.indexOf(historicalRepoCounts) < database.queries.indexOf(historicalSigCounts));
    assert.ok(database.queries.indexOf(historicalSigCounts) < database.queries.indexOf(historicalOrgCounts));

    const dailyDelete = database.queries.find((query) =>
        query.sql.startsWith('DELETE FROM contributor_daily_activities') &&
        query.sql.includes('ANY($1::int[])')
    );
    assert.deepEqual(dailyDelete.params, [[73, 42]]);
    const allDailyRebuild = database.queries.find((query) =>
        query.sql.startsWith('INSERT INTO contributor_daily_activities') &&
        query.params.length === 1
    );
    assert.deepEqual(allDailyRebuild.params, [73]);
    assert.match(allDailyRebuild.sql, /COUNT\(DISTINCT cra\.repo_id\)/);

    const legacyDailyRestore = database.queries.find((query) =>
        query.sql.startsWith('INSERT INTO contributor_daily_activities') &&
        query.sql.includes('jsonb_to_recordset')
    );
    assert.deepEqual(legacyDailyRestore.params, [73, JSON.stringify([{
        org_id: 7,
        snapshot_date: '2025-03-04',
        commits_count: 3,
        lines_added: 10,
        lines_deleted: 2,
    }])]);
    assert.match(
        legacyDailyRestore.sql,
        /commits_count = COALESCE\(contributor_daily_activities\.commits_count, 0\)/
    );
    assert.ok(database.queries.indexOf(allDailyRebuild) < database.queries.indexOf(legacyDailyRestore));

    const sourceDelete = database.queries.find((query) =>
        query.sql === 'DELETE FROM contributors WHERE id = $1'
    );
    assert.deepEqual(sourceDelete.params, [42]);
    const identityRename = database.queries.find((query) =>
        query.sql.startsWith('UPDATE contributors') && query.sql.includes('WHERE github_id = $2')
    );
    assert.ok(database.queries.indexOf(sourceDelete) < database.queries.indexOf(identityRename));
});
