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
 * @param {string} endpoint The GitHub REST API endpoint (e.g., /orgs/ORG/repos).
 * @param {object} params Query parameters.
 * @returns {Promise<object>} The data object from the GitHub response.
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

// --- Data Ingestion Service (Cron Job) ---

/**
 * Fetches aggregated activity metrics for a given organization in the last 24 hours.
 * NOTE: This is a simplified aggregation. A full, accurate count requires iterating through
 * all repositories and potentially multiple pages of events/issues/PRs.
 * We focus on the core logic structure.
 */
async function fetchOrgActivityMetrics(orgName) {
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - 1);
    const sinceISO = sinceDate.toISOString();

    let newPrs = 0;
    let closedMergedPrs = 0;
    let newIssues = 0;
    let closedIssues = 0;
    let activeContributors = new Set();
    let newRepos = 0;

    // 1. Fetch Repositories and filter for new ones
    // NOTE: GitHub API only allows filtering by 'pushed_at', 'updated_at', 'created_at' on the list endpoint.
    // We fetch all and filter locally for simplicity, but pagination is a real concern here.
    const repos = await githubRest(`/orgs/${orgName}/repos`, { type: 'public', per_page: 100 });
    
    for (const repo of repos) {
        const repoCreatedAt = new Date(repo.created_at);
        if (repoCreatedAt > sinceDate) {
            newRepos++;
        }
    }

    // 2. Fetch Issues and PRs (Issues API includes PRs)
    // Filter by state and time.
    const issuesAndPrs = await githubRest(`/search/issues`, {
        q: `org:${orgName} created:>${sinceISO}`,
        per_page: 100, // Max 100 results for search API
    });

    for (const item of issuesAndPrs.items) {
        const isPr = item.pull_request;
        const author = item.user.login;
        activeContributors.add(author);

        if (isPr) {
            newPrs++;
            // Check for closed/merged status
            if (item.state === 'closed' && new Date(item.closed_at) > sinceDate) {
                // We cannot easily distinguish merged from closed (unmerged) from the search API result alone.
                // For simplicity, we count all closed PRs in the last 24h as 'closed/merged'.
                closedMergedPrs++;
            }
        } else {
            newIssues++;
            if (item.state === 'closed' && new Date(item.closed_at) > sinceDate) {
                closedIssues++;
            }
        }
    }
    
    // 3. Fetch Closed/Merged PRs (separate search for closed items)
    const closedItems = await githubRest(`/search/issues`, {
        q: `org:${orgName} is:closed closed:>${sinceISO}`,
        per_page: 100,
    });

    // Re-aggregate closed/merged counts from the closed search results
    closedMergedPrs = 0;
    closedIssues = 0;
    
    for (const item of closedItems.items) {
        const isPr = item.pull_request;
        const author = item.user.login;
        activeContributors.add(author); // Add contributors from closed items too

        if (isPr) {
            closedMergedPrs++;
        } else {
            closedIssues++;
        }
    }
    
    // NOTE: The 'new' counts (newPrs, newIssues) are from the first search (created:>${sinceISO}).
    // The 'closed' counts (closedMergedPrs, closedIssues) are from the second search (closed:>${sinceISO}).
    // This is the most practical way to get the required metrics with minimal API calls.

    return {
        new_prs: newPrs,
        closed_merged_prs: closedMergedPrs,
        new_issues: newIssues,
        closed_issues: closedIssues,
        active_contributors: activeContributors.size,
        new_repos: newRepos,
    };
}

async function fetchAndStoreActivity(orgName, orgId) {
    const today = new Date();
    const todayDate = today.toISOString().split('T')[0]; // YYYY-MM-DD

    console.log(`Fetching data for ${orgName} for date ${todayDate}`);

    let metrics;
    try {
        metrics = await fetchOrgActivityMetrics(orgName);
    } catch (error) {
        console.error(`Failed to fetch metrics for ${orgName}. Storing zero values. Error: ${error.message}`);
        metrics = {
            new_prs: 0,
            closed_merged_prs: 0,
            new_issues: 0,
            closed_issues: 0,
            active_contributors: 0,
            new_repos: 0,
        };
    }

    try {
        const result = await pool.query(
            `INSERT INTO activity_snapshots (org_id, snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors, new_repos)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (org_id, snapshot_date) DO UPDATE
             SET new_prs = EXCLUDED.new_prs,
                 closed_merged_prs = EXCLUDED.closed_merged_prs,
                 new_issues = EXCLUDED.new_issues,
                 closed_issues = EXCLUDED.closed_issues,
                 active_contributors = EXCLUDED.active_contributors,
                 new_repos = EXCLUDED.new_repos,
                 created_at = NOW()
             RETURNING *`,
            [orgId, todayDate, metrics.new_prs, metrics.closed_merged_prs, metrics.new_issues, metrics.closed_issues, metrics.active_contributors, metrics.new_repos]
        );
        console.log(`Successfully stored snapshot for ${orgName} on ${todayDate}. Metrics: ${JSON.stringify(metrics)}`);
        return result.rows[0];
    } catch (error) {
        console.error(`Error storing data for ${orgName}:`, error.message);
        throw error;
    }
}

async function runDailyIngestionJob() {
    console.log('--- Starting Daily Data Ingestion Job ---');
    try {
        const orgsResult = await pool.query('SELECT id, name FROM organizations');
        const organizations = orgsResult.rows;

        if (organizations.length === 0) {
            console.log('No organizations configured to monitor. Skipping job.');
            return;
        }

        for (const org of organizations) {
            await fetchAndStoreActivity(org.name, org.id);
        }

        console.log('--- Daily Data Ingestion Job Finished Successfully ---');

    } catch (error) {
        console.error('CRON Job Failed:', error.message);
    }
}

// Schedule the job to run once every 24 hours (e.g., at 00:00 UTC)
// For testing in the sandbox, we'll schedule it to run every 5 minutes initially,
// but the final configuration should be daily.
// cron.schedule('0 0 * * *', runDailyIngestionJob); // Daily at midnight
cron.schedule('*/5 * * * *', runDailyIngestionJob); // Every 5 minutes for testing

// --- API Routes ---

// Helper function for security check
async function checkMonitoredOrg(orgName) {
    const orgResult = await pool.query('SELECT id FROM organizations WHERE name = $1', [orgName]);
    if (orgResult.rows.length === 0) {
        return false;
    }
    return true;
}

// GET /api/v1/organizations
app.get('/api/v1/organizations', async (req, res) => {
    try {
        const result = await pool.query('SELECT name FROM organizations ORDER BY name');
        const orgNames = result.rows.map(row => row.name);
        res.json(orgNames);
    } catch (error) {
        console.error('Error fetching organizations:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/organizations/{orgName}/timeseries
app.get('/api/v1/organizations/:orgName/timeseries', async (req, res) => {
    const { orgName } = req.params;
    const range = req.query.range || '30d'; // Default to 30 days
    const cacheKey = `org:${orgName}:range:${range}`;
    const cacheTTL = 60 * 60 * 1; // 1 hour

    try {
        // 1. Security Check: Check if organization is monitored
        if (!(await checkMonitoredOrg(orgName))) {
            return res.status(403).json({ error: `Organization "${orgName}" is not a monitored entity.` });
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

        const orgIdResult = await pool.query('SELECT id FROM organizations WHERE name = $1', [orgName]);
        const orgId = orgIdResult.rows[0].id;

        const dataResult = await pool.query(
            `SELECT snapshot_date, new_prs, closed_merged_prs, new_issues, closed_issues, active_contributors, new_repos
             FROM activity_snapshots
             WHERE org_id = $1 AND snapshot_date >= $2
             ORDER BY snapshot_date ASC`,
            [orgId, startDateStr]
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
        console.error(`Error fetching timeseries data for ${orgName}:`, error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET /api/v1/organizations/{orgName}/latest-activity
app.get('/api/v1/organizations/:orgName/latest-activity', async (req, res) => {
    const { orgName } = req.params;
    const { type } = req.query; // 'prs' or 'issues'
    
    // Parse pagination parameters
    const page = parseInt(req.query.page) || 1;
    const per_page = parseInt(req.query.per_page) || 10;
    
    // GitHub Search API limits per_page to 100
    const limit = Math.min(per_page, 100);

    try {
        // 1. Security Check: Check if organization is monitored
        if (!(await checkMonitoredOrg(orgName))) {
            return res.status(403).json({ error: `Organization "${orgName}" is not a monitored entity.` });
        }

        let query;
        if (type === 'prs') {
            // Search for open Pull Requests, sorted by creation date descending
            query = `org:${orgName} is:pr is:open sort:created-desc`;
        } else if (type === 'issues') {
            // Search for open Issues (excluding PRs), sorted by creation date descending
            query = `org:${orgName} is:issue is:open -is:pr sort:created-desc`;
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
        console.error(`Error fetching latest activity for ${orgName}:`, error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


// --- Server Start ---
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    // Run the job immediately once on startup for initial data population
    runDailyIngestionJob();
});
