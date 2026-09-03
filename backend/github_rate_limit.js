const MAX_RATE_LIMIT_RETRIES = 1;
const MAX_RATE_LIMIT_WAIT_MS = 65 * 60 * 1000;

function getPrimaryRateLimitWaitMs(error, now = Date.now()) {
    if (error.response?.status !== 403) {
        return null;
    }

    const headers = error.response.headers || {};
    const remaining = Number.parseInt(headers['x-ratelimit-remaining'], 10);
    const resetTime = Number.parseInt(headers['x-ratelimit-reset'], 10);
    if (remaining !== 0 || !Number.isFinite(resetTime)) {
        return null;
    }

    const waitTime = Math.max(0, resetTime * 1000 - now + 5000);
    return waitTime <= MAX_RATE_LIMIT_WAIT_MS ? waitTime : null;
}

module.exports = {
    MAX_RATE_LIMIT_RETRIES,
    getPrimaryRateLimitWaitMs,
};
