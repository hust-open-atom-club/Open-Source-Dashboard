# 华中科技大学开放原子开源俱乐部活动仪表板 (HUST-OpenAtom-Club Dashboard)

本项目是根据用户需求重构的仪表板，旨在专注于监控 **华中科技大学开放原子开源俱乐部 (`hust-open-atom-club`)** 的活动，并提供组织总览和重点仓库的精细化统计。

**核心技术栈:**
*   **后端:** Node.js (Express.js)
*   **数据库:** PostgreSQL
*   **缓存:** Redis
*   **调度:** `node-cron`
*   **前端:** React (Vite)
*   **可视化:** ECharts

## 目录结构

\`\`\`
oss-dashboard/
├── backend/                  # Node.js/Express 后端服务
│   ├── node_modules/
│   ├── package.json          # 后端依赖
│   ├── server.js             # 主服务器文件，包含 API 和 Cron Job 逻辑
│   └── .env.example          # 环境变量示例文件
├── frontend/                 # React/Vite 前端应用
│   ├── node_modules/
│   ├── package.json          # 前端依赖
│   ├── src/
│   │   ├── App.jsx           # 主应用组件，包含数据流、ECharts 逻辑和最新活动列表
│   │   ├── index.css         # 基础样式
│   │   └── main.jsx
│   └── vite.config.js
├── db/                       # 数据库脚本
│   ├── schema.sql            # PostgreSQL 表结构定义 (包含仓库表)
│   └── seed.sql              # 初始组织和重点仓库数据填充脚本
└── README.md
\`\`\`

## 部署与运行指南

### 1. 环境准备

您需要安装并运行以下服务：
1.  **Node.js** (v18+)
2.  **PostgreSQL** 数据库服务
3.  **Redis** 缓存服务

### 2. 数据库设置

#### 2.1. 创建数据库

在您的 PostgreSQL 实例中创建一个新的数据库，例如 `oss_dashboard`。

#### 2.2. 运行迁移脚本 (重要：需要清空旧数据并重新创建表)

由于项目进行了重构，新增了 `repositories` 和 `repo_snapshots` 表，您需要重新运行 `db/schema.sql` 和 `db/seed.sql`。

**如果您有旧数据，请先清空数据库或删除旧表。**

\`\`\`bash
# 运行 schema.sql 创建新的表结构
psql -d oss_dashboard -f db/schema.sql

# 运行 seed.sql 填充新的组织和重点仓库数据
psql -d oss_dashboard -f db/seed.sql
\`\`\`

### 3. 后端配置与运行

#### 3.1. 配置环境变量

进入 `backend` 目录，并将 `.env.example` 复制为 `.env` 文件，并根据您的环境进行修改。

\`\`\`bash
cd oss-dashboard/backend
cp .env.example .env
# 编辑 .env 文件
\`\`\`

**注意:**
*   您需要一个 **GitHub Personal Access Token** (`GITHUB_TOKEN`)。该 Token 必须具有访问 `hust-open-atom-club` 组织和其仓库的权限。
*   请确保 `DB_` 和 `REDIS_` 相关的配置与您的本地服务一致。

#### 3.2. 安装依赖并启动

\`\`\`bash
# 仍在 oss-dashboard/backend 目录
npm install
npm start # 或者使用 node server.js
\`\`\`

**启动提示:** 后端服务启动时，如果发现数据库中没有数据，将自动触发 **7 天的历史数据回填**。请耐心等待回填完成（取决于 GitHub API 速率限制）。

### 4. 前端配置与运行

#### 4.1. 安装依赖

\`\`\`bash
cd ../frontend
npm install
\`\`\`

#### 4.2. 启动开发服务器

\`\`\`bash
npm run dev
\`\`\`

前端应用将启动在 `http://localhost:5173` (或 Vite 提示的端口)。

## 核心功能实现说明 (重构后)

### 1. 数据抓取 (仓库级别)

*   **文件:** \`backend/server.js\`
*   **精细化统计:** 数据抓取逻辑已重构为针对 `hust-open-atom-club` 组织下的 **每个重点仓库** 进行统计。
*   **数据存储:** 数据分别存储在 `repo_snapshots` (仓库级别) 和 `activity_snapshots` (组织聚合级别)。
*   **加强回填:** 服务器启动时，如果发现仓库数据缺失，将自动运行回填任务，抓取过去 **7 天** 的数据。

### 2. API 接口 (重构后)

*   **文件:** \`backend/server.js\`
*   **获取重点仓库列表:** \`GET /api/v1/organization/repos\` (返回所有重点仓库的 ID、名称和描述)
*   **获取仓库时间序列:** \`GET /api/v1/repository/:repoId/timeseries\` (返回单个仓库的历史趋势数据，支持 1 小时 Redis 缓存)
*   **获取组织总览时间序列:** \`GET /api/v1/organization/timeseries\` (返回所有仓库聚合后的组织历史趋势数据，支持 1 小时 Redis 缓存)
*   **获取最新活动列表:** \`GET /api/v1/organization/latest-activity\` (返回组织范围内的最新 PR/Issue 列表，支持分页)

### 3. 前端可视化 (重构后)

*   **文件:** \`frontend/src/App.jsx\`
*   **UI 简化:** 移除了组织选择器，直接聚焦于 `hust-open-atom-club`。
*   **仓库趋势图:** 新增了仓库选择器，用户可以选择一个重点仓库，下方会展示该仓库的活动趋势图。
*   **组织最新活动:** 页面底部仍然展示组织范围内的最新 PR 和 Issue 列表，并支持分页。
*   **数据卡片:** 顶部的活动快照卡片现在展示的是当前所选仓库的最新数据。

