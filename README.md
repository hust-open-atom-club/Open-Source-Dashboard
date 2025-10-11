# OSS 社区活动仪表板 (OSS Community Dashboard)

本项目是根据用户需求开发的“OSS 社区活动仪表板”项目的 Phase 1 原型。它旨在持续监控预定义的 GitHub 组织，抓取关键活动指标，并提供一个安全、缓存的 API 供前端展示历史数据趋势。

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
│   ├── schema.sql            # PostgreSQL 表结构定义
│   └── seed.sql              # 初始组织数据填充脚本
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

#### 2.2. 运行迁移脚本

使用 `psql` 或任何 PostgreSQL 客户端运行 `db/schema.sql` 文件来创建所需的表：

\`\`\`bash
# 假设您已连接到数据库
psql -d oss_dashboard -f db/schema.sql
\`\`\`

#### 2.3. 填充初始数据

运行 `db/seed.sql` 文件来插入初始要监控的组织数据：

\`\`\`bash
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
*   您需要一个 **GitHub Personal Access Token** 并将其设置为 `GITHUB_TOKEN`。该 Token 必须具有访问组织和仓库的权限（例如 `read:org` 和 `repo` 范围）才能成功抓取数据。
*   请确保 `DB_` 和 `REDIS_` 相关的配置与您的本地服务一致。

#### 3.2. 安装依赖并启动

\`\`\`bash
# 仍在 oss-dashboard/backend 目录
npm install
npm start # 或者使用 node server.js
\`\`\`

后端服务将启动在 `http://localhost:3000` (或您配置的端口)。启动时，它会立即运行一次数据抓取任务，并随后每 5 分钟运行一次（为方便测试）。

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

## 核心功能实现说明

### 1. 数据抓取 (Cron Job)

*   **文件:** \`backend/server.js\`
*   **实现:** 使用 `node-cron` 调度，每 5 分钟运行一次 `runDailyIngestionJob` 函数。
*   **数据源:** 使用 **GitHub REST API** (`/orgs/:org/repos`, `/search/issues`) 来获取过去 24 小时内的新增 PR、合并 PR、新增 Issue、关闭 Issue、活跃贡献者和新增仓库数量。

### 2. API 接口

*   **文件:** \`backend/server.js\`
*   **安全性 (Gated Access):** 所有 API 接口都会首先查询 `organizations` 表。如果请求的组织名不在表中，将返回 `403 Forbidden`，严格限制了数据访问范围。
*   **时间序列数据 (`/timeseries`):**
    *   返回历史活动趋势数据。
    *   使用 Redis 实现了 1 小时的缓存，以提高响应速度。
*   **最新活动列表 (`/latest-activity`):**
    *   **支持分页。** 实时调用 GitHub REST API (`/search/issues`)，支持通过 `page` 和 `per_page` 参数进行分页。
    *   返回结果包含活动列表、总结果数 (`total_count`)、当前页码和每页数量，以便前端实现完整的翻页功能。

### 3. 前端可视化

*   **文件:** \`frontend/src/App.jsx\`
*   **数据流:** 页面加载时，首先调用 `/organizations` 接口填充下拉菜单。选择组织后，同时调用 `/timeseries` 和 `/latest-activity` 接口获取数据。
*   **可视化:**
    *   使用 **ECharts** 库展示了历史趋势图。
    *   **新增** 列表组件，展示实时获取的最新 Pull Request 和 Issue 的详细信息，并**支持翻页**。

