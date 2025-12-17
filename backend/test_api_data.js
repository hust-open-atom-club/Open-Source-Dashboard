/**
 * 测试脚本：检查 API 数据采集是否正常
 */

require('dotenv').config();
const axios = require('axios');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ORG_NAME = 'hust-open-atom-club';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function testRestAPI() {
    console.log('\n=== 测试 REST API ===\n');

    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];
    const last30Days = new Date(today);
    last30Days.setDate(today.getDate() - 30);
    const last30DaysStr = last30Days.toISOString().split('T')[0];

    console.log(`测试日期范围: ${last30DaysStr} 到 ${dateStr}`);

    try {
        // 测试搜索最近 30 天的 PR
        await delay(2000);
        const prResponse = await axios.get('https://api.github.com/search/issues', {
            params: {
                q: `org:${ORG_NAME} is:pr created:>=${last30DaysStr}`,
                per_page: 5
            },
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        console.log(`✓ PR 总数（最近30天）: ${prResponse.data.total_count}`);
        console.log(`  示例 PR:`);
        prResponse.data.items.slice(0, 3).forEach(pr => {
            console.log(`    - ${pr.title} (by ${pr.user.login}, ${pr.created_at.split('T')[0]})`);
        });

        // 测试搜索最近 30 天的 Issue
        await delay(2000);
        const issueResponse = await axios.get('https://api.github.com/search/issues', {
            params: {
                q: `org:${ORG_NAME} is:issue -is:pr created:>=${last30DaysStr}`,
                per_page: 5
            },
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        console.log(`\n✓ Issue 总数（最近30天）: ${issueResponse.data.total_count}`);
        console.log(`  示例 Issue:`);
        issueResponse.data.items.slice(0, 3).forEach(issue => {
            console.log(`    - ${issue.title} (by ${issue.user.login}, ${issue.created_at.split('T')[0]})`);
        });

        // 测试单个仓库
        await delay(2000);
        const repoListResponse = await axios.get(`https://api.github.com/orgs/${ORG_NAME}/repos`, {
            params: { per_page: 5, sort: 'updated' },
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        console.log(`\n✓ 最近更新的仓库:`);
        repoListResponse.data.slice(0, 5).forEach(repo => {
            console.log(`    - ${repo.name} (updated: ${repo.updated_at.split('T')[0]})`);
        });

        if (repoListResponse.data.length > 0) {
            const testRepo = repoListResponse.data[0].name;
            console.log(`\n测试仓库: ${testRepo}`);

            await delay(2000);
            const repoPrResponse = await axios.get('https://api.github.com/search/issues', {
                params: {
                    q: `repo:${ORG_NAME}/${testRepo} is:pr created:>=${last30DaysStr}`,
                    per_page: 3
                },
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });

            console.log(`  - PR 数量: ${repoPrResponse.data.total_count}`);

            await delay(2000);
            const repoIssueResponse = await axios.get('https://api.github.com/search/issues', {
                params: {
                    q: `repo:${ORG_NAME}/${testRepo} is:issue -is:pr created:>=${last30DaysStr}`,
                    per_page: 3
                },
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });

            console.log(`  - Issue 数量: ${repoIssueResponse.data.total_count}`);
        }

    } catch (error) {
        console.error('❌ API 测试失败:', error.message);
        if (error.response) {
            console.error('响应状态:', error.response.status);
            console.error('响应数据:', error.response.data);
        }
    }
}

async function testGraphQLAPI() {
    console.log('\n=== 测试 GraphQL API ===\n');

    const query = `
        query TestQuery($owner: String!, $repo: String!) {
            repository(owner: $owner, name: $repo) {
                name
                pullRequests(first: 5, orderBy: {field: CREATED_AT, direction: DESC}) {
                    totalCount
                    nodes {
                        createdAt
                        title
                        author { 
                            login 
                            avatarUrl 
                            ... on User { databaseId }
                        }
                    }
                }
                issues(first: 5, orderBy: {field: CREATED_AT, direction: DESC}) {
                    totalCount
                    nodes {
                        createdAt
                        title
                        author { 
                            login 
                            avatarUrl 
                            ... on User { databaseId }
                        }
                    }
                }
            }
        }
    `;

    try {
        const repoListResponse = await axios.get(`https://api.github.com/orgs/${ORG_NAME}/repos`, {
            params: { per_page: 1, sort: 'updated' },
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        if (repoListResponse.data.length === 0) {
            console.log('没有找到仓库');
            return;
        }

        const testRepo = repoListResponse.data[0].name;
        console.log(`测试仓库: ${testRepo}\n`);

        await delay(2000);

        const response = await axios.post('https://api.github.com/graphql', {
            query,
            variables: {
                owner: ORG_NAME,
                repo: testRepo
            }
        }, {
            headers: {
                'Authorization': `bearer ${GITHUB_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.data.errors) {
            console.error('❌ GraphQL 错误:', response.data.errors);
            return;
        }

        const repo = response.data.data.repository;
        console.log(`✓ 仓库名: ${repo.name}`);
        console.log(`✓ PR 总数: ${repo.pullRequests.totalCount}`);
        console.log(`✓ Issue 总数: ${repo.issues.totalCount}`);

        if (repo.pullRequests.nodes.length > 0) {
            console.log(`\n最近的 PR:`);
            repo.pullRequests.nodes.forEach(pr => {
                console.log(`  - ${pr.title}`);
                console.log(`    作者: ${pr.author?.login || 'unknown'}`);
                console.log(`    日期: ${pr.createdAt.split('T')[0]}`);
            });
        }

        if (repo.issues.nodes.length > 0) {
            console.log(`\n最近的 Issue:`);
            repo.issues.nodes.forEach(issue => {
                console.log(`  - ${issue.title}`);
                console.log(`    作者: ${issue.author?.login || 'unknown'}`);
                console.log(`    日期: ${issue.createdAt.split('T')[0]}`);
            });
        }

    } catch (error) {
        console.error('❌ GraphQL 测试失败:', error.message);
        if (error.response) {
            console.error('响应数据:', JSON.stringify(error.response.data, null, 2));
        }
    }
}

async function main() {
    console.log('='.repeat(60));
    console.log('GitHub API 数据采集测试');
    console.log('='.repeat(60));
    console.log(`组织: ${ORG_NAME}`);
    console.log(`Token: ${GITHUB_TOKEN ? '已配置' : '❌ 未配置'}`);
    console.log('='.repeat(60));

    if (!GITHUB_TOKEN) {
        console.error('\n❌ 错误: GITHUB_TOKEN 未设置');
        console.error('请在 .env 文件中配置 GITHUB_TOKEN\n');
        return;
    }

    await testRestAPI();
    await testGraphQLAPI();

    console.log('\n='.repeat(60));
    console.log('测试完成');
    console.log('='.repeat(60));
}

main();

