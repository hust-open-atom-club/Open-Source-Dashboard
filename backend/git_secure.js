const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs/promises');
const path = require('path');

const execFilePromise = promisify(execFile);

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactSecrets(input) {
    if (input === undefined || input === null) {
        return input;
    }

    let text = String(input);
    const token = process.env.GITHUB_TOKEN;

    if (token) {
        text = text.replace(new RegExp(escapeRegExp(token), 'g'), '[REDACTED_GITHUB_TOKEN]');
    }

    return text
        .replace(/https:\/\/[^@\s]+@github\.com/gi, 'https://[REDACTED]@github.com')
        .replace(/(Authorization:\s*Basic\s+)[A-Za-z0-9+/=]+/gi, '$1[REDACTED]')
        .replace(/(AUTHORIZATION:\s*basic\s+)[A-Za-z0-9+/=]+/gi, '$1[REDACTED]');
}

function buildRepoUrl(orgName, repoName) {
    return `https://github.com/${orgName}/${repoName}.git`;
}

function buildGitEnv() {
    const token = process.env.GITHUB_TOKEN;

    if (!token) {
        throw new Error('GITHUB_TOKEN is not set in environment variables.');
    }

    const basicAuth = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');

    return {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_1: `Authorization: Basic ${basicAuth}`,
    };
}

function renderGitArgs(args) {
    return args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ');
}

async function runGit(args, options = {}) {
    try {
        return await execFilePromise('git', args, {
            env: buildGitEnv(),
            timeout: options.timeout,
            cwd: options.cwd,
            maxBuffer: options.maxBuffer || 1024 * 1024 * 10,
            windowsHide: true,
        });
    } catch (error) {
        const stdout = redactSecrets(error.stdout || '');
        const stderr = redactSecrets(error.stderr || '');
        const sanitized = new Error(
            [
                `Git command failed: git ${renderGitArgs(args)}`,
                stderr || stdout || redactSecrets(error.message),
            ].filter(Boolean).join('\n')
        );

        sanitized.code = error.code;
        sanitized.stdout = stdout;
        sanitized.stderr = stderr;
        throw sanitized;
    }
}

async function ensureCleanOrigin(repoPath, repoUrl) {
    const current = await runGit(['-C', repoPath, 'remote', 'get-url', 'origin'], {
        timeout: 5000,
    }).catch(() => null);

    if (current?.stdout?.trim() === repoUrl) {
        return;
    }

    const remotes = await runGit(['-C', repoPath, 'remote'], {
        timeout: 5000,
    }).catch(() => null);

    const hasOrigin = remotes
        ? remotes.stdout.split(/\r?\n/).some((line) => line.trim() === 'origin')
        : false;

    const args = hasOrigin
        ? ['-C', repoPath, 'remote', 'set-url', 'origin', repoUrl]
        : ['-C', repoPath, 'remote', 'add', 'origin', repoUrl];

    await runGit(args, { timeout: 5000 });
}

async function cloneOrPullRepoSecure({ repoName, repoStoragePath, orgName }) {
    const repoPath = path.join(repoStoragePath, repoName);
    const repoUrl = buildRepoUrl(orgName, repoName);
    const repoExists = await fs.access(repoPath).then(() => true).catch(() => false);

    if (!repoExists) {
        await runGit(['clone', repoUrl, repoPath], { timeout: 120000 });
        return repoPath;
    }

    try {
        await runGit(['-C', repoPath, 'rev-parse', '--git-dir'], { timeout: 5000 });
        await ensureCleanOrigin(repoPath, repoUrl);

        try {
            await runGit(['-C', repoPath, 'pull', '--ff-only'], { timeout: 60000 });
        } catch (pullError) {
            const branchCheck = await runGit(['-C', repoPath, 'branch', '-r'], {
                timeout: 5000,
            }).catch(() => null);

            if (!branchCheck || !branchCheck.stdout.trim()) {
                return repoPath;
            }

            await runGit(['-C', repoPath, 'fetch', 'origin'], { timeout: 60000 });
            await runGit(['-C', repoPath, 'pull', '--ff-only'], { timeout: 60000 });
        }
    } catch (gitError) {
        await fs.rm(repoPath, { recursive: true, force: true });
        await runGit(['clone', repoUrl, repoPath], { timeout: 120000 });
    }

    return repoPath;
}

module.exports = {
    buildGitEnv,
    buildRepoUrl,
    redactSecrets,
    runGit,
    ensureCleanOrigin,
    cloneOrPullRepoSecure,
};
