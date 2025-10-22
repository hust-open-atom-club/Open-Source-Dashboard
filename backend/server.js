require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const Redis = require('redis');
const cron = require('node-cron');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_API_BASE = 'https://api.github.com';

// --- Database (PostgreSQL) Configuration ---
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

pool.on('error', (err, client) => {
    console.error('Unexpected error on idle client', err);
    process.exit(-1);
});

// --- Cache (Redis) Configuration ---
const redisClient = Redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));

async function connectRedis() {
    try {
        await redisClient.connect();
        console.log('Redis connected successfully.');
    } catch (e) {
        console.error('Failed to connect to Redis:', e.message);
    }
}

connectRedis();

// --- Middleware ---
app.use(express.json());
// Allow CORS from the frontend development server (e.g., http://localhost:5173)
app.use(require('cors')({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: 'GET',
}));

// --- GitHub API Utility ---

/**
 * Executes a REST API call against the GitHub API.
 */
async function githubRest(endpoint, params = {}) {
    if (!GITHUB_TOKEN) {
        throw new Error("GITHUB_TOKEN is not set in environment variables. Cannot fetch real data.");
    }
    try {
        const response = await axios.get(`${GITHUB_API_BASE}${endpoint}`, {
            params: params,
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json',
                'X-GitHub-Api-Version': '2022-11-28',
            }
        });
        return response.data;
    } catch (error) {
        console.error(`GitHub REST API Error on ${endpoint}:`, error.response ? error.response.data : error.message);
        // Throw a more specific error for rate limiting
        if (error.response && error.response.status === 403 && error.response.data.message.includes('rate limit')) {
            throw new Error("GitHub API Rate Limit Exceeded.");
        }
        throw new Error(`GitHub API request failed for ${endpoint}: ${error.message}`);
    }
}

// --- Data Ingestion Service (Cron Job & Backfill) ---

/**
 * Fetches aggregated activity metrics for a given repository for a specific 24-hour period.
 * @param {string} orgName The organization name.
 * @param {string} repoName The repository name.
 * @param {Date} targetDate The date for which the snapshot is being taken (e.g., Oct 11).
 * @returns {Promise<object>} The aggregated metrics.
 */
async function fetchRepoActivityMetrics(orgName, repoName, targetDate) {
    // Calculate the 24-hour window ending at the targetDate's midnight.
    const endDate = new Date(targetDate);
    endDate.setHours(0, 0, 0, 0); // Midnight of the target date
    
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 1); // 24 hours before midnight

    const endISO = endDate.toISOString();
    const startISO = startDate.toISOString();

    let newPrs = 0;
    let closedMergedPrs = 0;
    let newIssues = 0;
    let closedIssues = 0;
    let activeContributors = new Set();

    // The query string for the specific repository
    const repoQuery = `repo:${orgName}/${repoName}`;

    // 1. Fetch Issues and PRs created within the window
    // We explicitly add 'is:pr' and 'is:issue -is:pr' to ensure correct counting
    const createdPrsPromise = githubRest('/search/issues', {
        q: `${repoQuery} is:pr created:${startISO}..${endISO}`,
        per_page: 100,
    });
    
    const createdIssuesPromise = githubRest('/search/issues', {
        q: `${repoQuery} is:issue -is:pr created:${startISO}..${endISO}`,
        per_page: 100,
    });
    
    // 2. Fetch Issues and PRs closed within the window
    const closedPrsPromise = githubRest('/search/issues', {
        q: `${repoQuery} is:pr is:closed closed:${startISO}..${endISO}`,
        per_page: 100,
    });
    
    const closedIssuesPromise = githubRest('/search/issues', {
        q: `${repoQuery} is:issue -is:pr is:closed closed:${startISO}..${endISO}`,
        per_page: 100,
    });
    
    const [createdPrs, createdIssues, closedPrs, closedIssuesData] = await Promise.all([
        createdPrsPromise, createdIssuesPromise, closedPrsPromise, closedIssuesPromise
    ]);

    // Aggregate created items
    newPrs = createdPrs.total_count;
    createdPrs.items.forEach(item => activeContributors.add(item.user.login));
    
    newIssues = createdIssues.total_count;
    createdIssues.items.forEach(item => activeContributors.add(item.user.login));

    // Aggregate closed items
    closedMergedPrs = closedPrs.total_count;
    closedPrs.items.forEach(item => activeContributors.add(item.user.login));
    
    closedIssues = closedIssuesData.total_count;
    closedIssuesData.items.forEach(item => activeContributors.add(item.user.login));
    
    return {
        new_prs: newPrs,
        closed_merged_prs: closedMergedPrs,
        new_issues: newIssues,
        closed_issues: closedIssues,
        active_contributors: activeContributors.size,
    };
}

/**
 * Stores the activity snapshot for a specific date for a repository.
 */
async function fetchAndStoreRepoActivity(orgName, repoId, repoName, targetDate) {
    const targetDateStr = targetDate.toISOString().split('T')[0]; // YYYY-MM-DD

    console.log(`Fetching data for repo ${repoName} on ${targetDateStr}`);

    let metrics;
    try {
        metrics = await fetchRepoActivityMetrics(orgName, repoName, targetDate);
    } catch (error) {
        console.error(`Failed to fetch metrics for repo ${repoName} on ${targetDateStr}. Storing zero values. Error: ${error.message}`);
        metrics = {
            new_prs: 0,
            closed_merged_prs: 0,
            new_issues: 0,
            closed_issues: 0,
            active_contributors: 0,
        };
    }

    try {
        const result = await pool.query(
            `INSERT INTO repo_snapshots (repo_id, snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (repo_id, snapshot_date) DO UPDATE
             SET new_prs = EXCLUDED.new_prs,
                 closed_merged_prs = EXCLUDED.closed_merged_prs,
                 new_issues = EXCLUDED.new_issues,
                 closed_issues = EXCLUDED.closed_issues,
                 active_contributors = EXCLUDED.active_contributors,
                 created_at = NOW()
             RETURNING *`,
            [repoId, targetDateStr, metrics.new_prs, metrics.closed_merged_prs, metrics.new_issues, metrics.closed_issues, metrics.active_contributors]
        );
        return result.rows[0];
    } catch (error) {
        console.error(`Error storing data for repo ${repoName} on ${targetDateStr}:`, error.message);
        throw error;
    }
}

/**
 * Runs the daily ingestion job for the current day.
 */
async function runDailyIngestionJob() {
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Set to midnight for consistency
    
    console.log('--- Starting Daily Data Ingestion Job ---');
    try {
        // 1. Get the single monitored organization (hust-open-atom-club)
        const orgsResult = await pool.query("SELECT id, name FROM organizations WHERE name = 'hust-open-atom-club'");
        const org = orgsResult.rows[0];

        if (!org) {
            console.log('Monitored organization not found. Skipping job.');
            return;
        }

        // 2. Get all monitored repositories for this organization
        const reposResult = await pool.query('SELECT id, name FROM repositories WHERE org_id = $1', [org.id]);
        const repositories = reposResult.rows;

        if (repositories.length === 0) {
            console.log('No repositories configured to monitor. Skipping job.');
            return;
        }
        
        // 3. Process each repository in parallel
        const ingestionPromises = repositories.map(repo => 
            fetchAndStoreRepoActivity(org.name, repo.id, repo.name, today)
        );
        
        const snapshots = await Promise.all(ingestionPromises);

        let totalNewPrs = 0, totalClosedMergedPrs = 0, totalNewIssues = 0, totalClosedIssues = 0, totalActiveContributors = new Set();
        
        for (const snapshot of snapshots) {
            totalNewPrs += snapshot.new_prs;
            totalClosedMergedPrs += snapshot.closed_merged_prs;
            totalNewIssues += snapshot.new_issues;
            totalClosedIssues += snapshot.closed_issues;
            // NOTE: Active contributors are counted per repo, and aggregated here. This is an approximation.
            // For now, we'll just sum the number for demonstration.
            totalActiveContributors.add(snapshot.active_contributors);
        }
        
        // 4. Store Organization-level snapshot (sum of all repo activities)
        const orgMetrics = {
            new_prs: totalNewPrs,
            closed_merged_prs: totalClosedMergedPrs,
            new_issues: totalNewIssues,
            closed_issues: totalClosedIssues,
            active_contributors: totalActiveContributors.size > 0 ? totalActiveContributors.values().next().value : 0, // Placeholder
            new_repos: 0, // Not tracked at this level anymore
        };
        
        const todayDateStr = today.toISOString().split('T')[0];
        await pool.query(
            `INSERT INTO activity_snapshots (org_id, snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors, new_repos)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (org_id, snapshot_date) DO UPDATE
             SET new_prs = EXCLUDED.new_prs,
                 closed_merged_prs = EXCLUDED.closed_merged_prs,
                 new_issues = EXCLUDED.new_issues,
                 closed_issues = EXCLUDED.closed_issues,
                 active_contributors = EXCLUDED.active_contributors,
                 new_repos = EXCLUDED.new_repos,
                 created_at = NOW()`,
            [org.id, todayDateStr, orgMetrics.new_prs, orgMetrics.closed_merged_prs, orgMetrics.new_issues, orgMetrics.closed_issues, orgMetrics.active_contributors, orgMetrics.new_repos]
        );
        console.log(`Successfully stored organization snapshot for ${org.name} on ${todayDateStr}.`);


        console.log('--- Daily Data Ingestion Job Finished Successfully ---');

    } catch (error) {
        console.error('CRON Job Failed:', error.message);
    }
}

/**
 * Runs a backfill job for the last N days.
 */
async function runBackfillJob(days = 7) {
    console.log(`--- Starting Backfill Job for the last ${days} days ---`);
    try {
        const orgsResult = await pool.query("SELECT id, name FROM organizations WHERE name = 'hust-open-atom-club'");
        const org = orgsResult.rows[0];

        if (!org) {
            console.log('Monitored organization not found. Skipping backfill.');
            return;
        }

        const reposResult = await pool.query('SELECT id, name FROM repositories WHERE org_id = $1', [org.id]);
        const repositories = reposResult.rows;

        if (repositories.length === 0) {
            console.log('No repositories configured to monitor. Skipping backfill.');
            return;
        }

        // Get today's date (midnight)
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        for (let i = days; i >= 1; i--) {
            const targetDate = new Date(today);
            targetDate.setDate(today.getDate() - i); // Calculate date i days ago
            const targetDateStr = targetDate.toISOString().split('T')[0];

            // Check if all repo data already exists for this date
            const repoCheckResult = await pool.query(
                'SELECT COUNT(*) FROM repo_snapshots WHERE snapshot_date = $1',
                [targetDateStr]
            );
            
            let totalNewPrs = 0, totalClosedMergedPrs = 0, totalNewIssues = 0, totalClosedIssues = 0, totalActiveContributors = new Set();
            
            // If data is missing, fetch and store for each repo in parallel
            if (parseInt(repoCheckResult.rows[0].count) < repositories.length) {
                console.log(`Backfilling data for ${targetDateStr}.`);
                
                const backfillPromises = repositories.map(repo => 
                    fetchAndStoreRepoActivity(org.name, repo.id, repo.name, targetDate)
                );
                
                const snapshots = await Promise.all(backfillPromises);
                
                for (const snapshot of snapshots) {
                    totalNewPrs += snapshot.new_prs;
                    totalClosedMergedPrs += snapshot.closed_merged_prs;
                    totalNewIssues += snapshot.new_issues;
                    totalClosedIssues += snapshot.closed_issues;
                    totalActiveContributors.add(snapshot.active_contributors);
                }
            } else {
                console.log(`Repo data for ${targetDateStr} already complete. Aggregating...`);
                // If data exists, just aggregate from repo_snapshots to create org_snapshot
                const aggregateResult = await pool.query(
                    `SELECT SUM(new_prs) as new_prs,
                            SUM(closed_merged_prs) as closed_merged_prs,
                            SUM(new_issues) as new_issues,
                            SUM(closed_issues) as closed_issues,
                            SUM(active_contributors) as active_contributors
                     FROM repo_snapshots WHERE snapshot_date = $1`,
                    [targetDateStr]
                );
                const agg = aggregateResult.rows[0];
                totalNewPrs = parseInt(agg.new_prs);
                totalClosedMergedPrs = parseInt(agg.closed_merged_prs);
                totalNewIssues = parseInt(agg.new_issues);
                totalClosedIssues = parseInt(agg.closed_issues);
                totalActiveContributors.add(parseInt(agg.active_contributors));
            }
            
            // Store Organization-level snapshot (sum of all repo activities)
            const orgMetrics = {
                new_prs: totalNewPrs,
                closed_merged_prs: totalClosedMergedPrs,
                new_issues: totalNewIssues,
                closed_issues: totalClosedIssues,
                active_contributors: totalActiveContributors.size > 0 ? totalActiveContributors.values().next().value : 0, // Placeholder
                new_repos: 0,
            };
            
            await pool.query(
                `INSERT INTO activity_snapshots (org_id, snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors, new_repos)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (org_id, snapshot_date) DO UPDATE
                 SET new_prs = EXCLUDED.new_prs,
                     closed_merged_prs = EXCLUDED.closed_merged_prs,
                     new_issues = EXCLUDED.new_issues,
                     closed_issues = EXCLUDED.closed_issues,
                     active_contributors = EXCLUDED.active_contributors,
                     new_repos = EXCLUDED.new_repos,
                     created_at = NOW()`,
                [org.id, targetDateStr, orgMetrics.new_prs, orgMetrics.closed_merged_prs, orgMetrics.new_issues, orgMetrics.closed_issues, orgMetrics.active_contributors, orgMetrics.new_repos]
            );
            console.log(`Stored organization snapshot for ${org.name} on ${targetDateStr}.`);
        }

        console.log('--- Backfill Job Finished Successfully ---');

    } catch (error) {
        console.error('Backfill Job Failed:', error.message);
    }
}

// Schedule the job to run once every 24 hours (e.g., at 00:00 UTC)
// cron.schedule('0 0 * * *', runDailyIngestionJob); // Daily at midnight
cron.schedule('*/5 * * * *', runDailyIngestionJob); // Every 5 minutes for testing

// --- API Routes ---

// Helper function for security check (now simplified for single org)
async function getMonitoredOrg() {
    const orgResult = await pool.query("SELECT id, name FROM organizations WHERE name = 'hust-open-atom-club'");
    return orgResult.rows[0];
}

// GET /api/v1/organization/repos - New route to get all monitored repos
app.get('/api/v1/organization/repos', async (req, res) => {
    try {
        const org = await getMonitoredOrg();
        if (!org) {
            return res.status(404).json({ error: 'Monitored organization not found.' });
        }
        
        const reposResult = await pool.query('SELECT id, name, description FROM repositories WHERE org_id = $1 ORDER BY name', [org.id]);
        // Simplified response to return only the array of repositories
        res.json(reposResult.rows);
    } catch (error) {
        console.error('Error fetching repositories:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/repository/:repoId/timeseries - New route for repository timeseries
app.get('/api/v1/repository/:repoId/timeseries', async (req, res) => {
    const { repoId } = req.params;
    const range = req.query.range || '30d'; // Default to 30 days
    const cacheKey = `repo:${repoId}:range:${range}`;
    const cacheTTL = 60 * 60 * 1; // 1 hour

    try {
        // 1. Check if repository is monitored
        const repoResult = await pool.query('SELECT id, name FROM repositories WHERE id = $1', [repoId]);
        if (repoResult.rows.length === 0) {
            return res.status(404).json({ error: 'Monitored repository not found.' });
        }
        const repoName = repoResult.rows[0].name;

        // 2. Caching Logic: Check Redis
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            console.log(`Cache hit for ${cacheKey}`);
            return res.json(JSON.parse(cachedData));
        }
        console.log(`Cache miss for ${cacheKey}. Querying DB...`);

        // 3. Query Database
        let days;
        if (range.endsWith('d')) {
            days = parseInt(range.slice(0, -1), 10);
        } else {
            days = 30; // Fallback
        }

        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        const startDateStr = startDate.toISOString().split('T')[0];

        const dataResult = await pool.query(
            `SELECT snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors
             FROM repo_snapshots
             WHERE repo_id = $1 AND snapshot_date >= $2
             ORDER BY snapshot_date ASC`,
            [repoId, startDateStr]
        );

        const timeseriesData = dataResult.rows.map(row => ({
            date: row.snapshot_date.toISOString().split('T')[0],
            new_prs: row.new_prs,
            closed_merged_prs: row.closed_merged_prs,
            new_issues: row.new_issues,
            closed_issues: row.closed_issues,
            active_contributors: row.active_contributors,
        }));

        // 4. Store in Redis and return
        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(timeseriesData));
        console.log(`Data stored in cache for ${cacheKey}.`);

        res.json(timeseriesData);

    } catch (error) {
        console.error(`Error fetching timeseries data for repository ${repoName}:`, error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/organization/timeseries - Now for the single monitored org
app.get('/api/v1/organization/timeseries', async (req, res) => {
    const range = req.query.range || '30d'; // Default to 30 days
    const cacheKey = `org:hust-open-atom-club:range:${range}`;
    const cacheTTL = 60 * 60 * 1; // 1 hour

    try {
        const org = await getMonitoredOrg();
        if (!org) {
            return res.status(404).json({ error: 'Monitored organization not found.' });
        }

        // 2. Caching Logic: Check Redis
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            console.log(`Cache hit for ${cacheKey}`);
            return res.json(JSON.parse(cachedData));
        }
        console.log(`Cache miss for ${cacheKey}. Querying DB...`);

        // 3. Query Database
        let days;
        if (range.endsWith('d')) {
            days = parseInt(range.slice(0, -1), 10);
        } else {
            days = 30; // Fallback
        }

        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        const startDateStr = startDate.toISOString().split('T')[0];

        const dataResult = await pool.query(
            `SELECT snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors, new_repos
             FROM activity_snapshots
             WHERE org_id = $1 AND snapshot_date >= $2
             ORDER BY snapshot_date ASC`,
            [org.id, startDateStr]
        );

        const timeseriesData = dataResult.rows.map(row => ({
            date: row.snapshot_date.toISOString().split('T')[0],
            new_prs: row.new_prs,
            closed_merged_prs: row.closed_merged_prs,
            new_issues: row.new_issues,
            closed_issues: row.closed_issues,
            active_contributors: row.active_contributors,
            new_repos: row.new_repos,
        }));

        // 4. Store in Redis and return
        await redisClient.setEx(cacheKey, cacheTTL, JSON.stringify(timeseriesData));
        console.log(`Data stored in cache for ${cacheKey}.`);

        res.json(timeseriesData);

    } catch (error) {
        console.error(`Error fetching timeseries data for organization:`, error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/organization/latest-activity - Now for the single monitored org
app.get('/api/v1/organization/latest-activity', async (req, res) => {
    const { type } = req.query; // 'prs' or 'issues'
    
    // Parse pagination parameters
    const page = parseInt(req.query.page) || 1;
    const per_page = parseInt(req.query.per_page) || 10;
    
    // GitHub Search API limits per_page to 100
    const limit = Math.min(per_page, 100);

    try {
        const org = await getMonitoredOrg();
        if (!org) {
            return res.status(404).json({ error: 'Monitored organization not found.' });
        }

        let query;
        if (type === 'prs') {
            // Search for open Pull Requests, sorted by creation date descending
            query = `org:${org.name} is:pr is:open sort:created-desc`;
        } else if (type === 'issues') {
            // Search for open Issues (excluding PRs), sorted by creation date descending
            query = `org:${org.name} is:issue is:open -is:pr sort:created-desc`;
        } else {
            return res.status(400).json({ error: 'Invalid activity type. Must be "prs" or "issues".' });
        }

        const searchResults = await githubRest('/search/issues', {
            q: query,
            per_page: limit,
            page: page,
        });

        const activities = searchResults.items.map(item => ({
            id: item.id,
            title: item.title,
            url: item.html_url,
            repo: item.repository_url.split('/').pop(),
            author: item.user.login,
            created_at: item.created_at,
            state: item.state,
        }));

        // Return the activities and the total count for pagination
        res.json({
            activities: activities,
            total_count: searchResults.total_count,
            page: page,
            per_page: limit,
        });

    } catch (error) {
        console.error(`Error fetching latest activity for organization:`, error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


// --- Server Start ---
app.listen(PORT, async () => {
    console.log(`Server running on http://localhost:${PORT}`);
    
    // Check if any data exists for any repo
    try {
        const checkResult = await pool.query('SELECT COUNT(*) FROM repo_snapshots');
        if (parseInt(checkResult.rows[0].count) === 0) {
            // If no data exists, run backfill for 7 days
            await runBackfillJob(7);
        }
    } catch (e) {
        console.error('Error checking for existing data. Skipping backfill:', e.message);
    }

    // Run the job immediately once on startup for initial data population
    runDailyIngestionJob();
});
