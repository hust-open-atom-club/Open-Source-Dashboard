require('dotenv').config();

const { Pool } = require('pg');
const Redis = require('redis');
const {
    DEFAULT_ORG_NAME,
    DEFAULT_PROPERTY_NAME,
    syncRepositorySigsFromGitHub,
} = require('./repository_sig_sync');
const { syncUpstreamOrgRepositories } = require('./upstream_repository_sync');

async function main() {
    const pool = new Pool({
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT,
    });

    let redisClient;
    try {
        const result = await syncRepositorySigsFromGitHub({
            pool,
            githubToken: process.env.GITHUB_TOKEN,
            orgName: process.env.GITHUB_ORG || DEFAULT_ORG_NAME,
            propertyName: process.env.GITHUB_SIG_PROPERTY || DEFAULT_PROPERTY_NAME,
        });

        const upstreamResult = await syncUpstreamOrgRepositories({
            pool,
            githubToken: process.env.GITHUB_TOKEN,
            orgName: process.env.GITHUB_ORG || DEFAULT_ORG_NAME,
        });

        console.log(JSON.stringify({
            ...result,
            upstream: upstreamResult,
        }, null, 2));

        if ((result.changes.length > 0 || upstreamResult.changes.length > 0) && process.argv.includes('--flush-cache')) {
            redisClient = Redis.createClient({
                url: process.env.REDIS_URL || 'redis://localhost:6379',
            });
            redisClient.on('error', (error) => console.error('Redis Client Error:', error.message));
            await redisClient.connect();
            await redisClient.flushAll();
            console.log('Redis cache cleared after repository SIG changes.');
        }
    } finally {
        if (redisClient?.isOpen) {
            await redisClient.quit();
        }
        await pool.end();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`Repository SIG synchronization failed: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { main };
