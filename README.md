# 开源活动仪表板

一个用于监控和可视化 GitHub Organization 活动的数据仪表板系统。

## 主要功能

### 数据采集与分析

- **双管道数据采集**：Git 提交统计 + GitHub API 数据采集
- **三级数据模型**：仓库 -> SIG -> 组织，支持灵活查询和聚合
- **贡献者追踪**：贡献者统计、排行榜、新贡献者识别

### 数据可视化

- **组织总览卡片**：展示 PR、Issue、Commit、代码行数等活动快照
- **趋势图表**：使用 ECharts 展示多维度活动趋势
- **多 SIG 趋势对比**：支持同时选择多个 SIG 进行对比
- **贡献者排行榜**：展示头像、用户名、活跃天数与贡献统计

### 高级分析能力

- **日 / 周 / 月视图切换**：支持不同粒度的数据聚合查看
- **增长分析报告**：支持多维指标的环比分析
- **数据导出**：支持 CSV、Excel、PDF 三种格式

### 用户体验

- 加载骨架屏、错误边界、Toast 通知
- Redis 缓存加速
- 响应式设计

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Node.js + Express.js |
| 数据库 | PostgreSQL |
| 缓存 | Redis |
| 调度 | node-cron |
| 前端 | React + Vite |
| 可视化 | ECharts |
| Commit 统计 | 本地 Git Clone + `git log` |

## 目录结构

```text
oss-dashboard/
├── backend/                    # Node.js/Express 后端服务
│   ├── server.js               # 主服务器文件
│   ├── run_graphql_backfill.js # 数据回填脚本
│   ├── run_reaggregation.js    # 重聚合脚本
│   └── .env.example            # 环境变量示例
├── frontend/                   # React/Vite 前端应用
│   ├── src/
│   │   ├── App.jsx
│   │   ├── components/
│   │   └── services/
│   └── vite.config.js
├── db/                         # 数据库脚本
│   ├── schema.sql
│   ├── seed.sql
│   ├── contributors_schema.sql
│   └── views.sql
├── repos/                      # 本地 Git 仓库存储目录
└── repos.csv                   # SIG 与仓库映射关系文件
```

## 环境要求

在本地运行前，请先准备以下依赖：

- Node.js 18+
- PostgreSQL
- Redis
- Git

## 快速开始

### 1. 初始化数据库

```bash
createdb oss_dashboard
psql -d oss_dashboard -f db/schema.sql
psql -d oss_dashboard -f db/seed.sql
psql -d oss_dashboard -f db/contributors_schema.sql
```

如需启用可选物化视图：

```bash
psql -d oss_dashboard -f db/views.sql
```

### 2. 配置并启动后端

```bash
cd backend
cp .env.example .env
npm install
npm start
```

需要在 `backend/.env` 中配置数据库、Redis 与 GitHub Token。

默认情况下，后端服务启动时不会自动清空 Redis，也不会自动执行历史数据回填。

如需启用这些启动行为，可在 `backend/.env` 中显式配置：

```env
ENABLE_STARTUP_CACHE_FLUSH=true
ENABLE_STARTUP_BACKFILL=true
STARTUP_BACKFILL_DAYS=30
```

### 3. 启动前端

```bash
cd frontend
npm install
npm run dev
```

启动后可访问 `http://localhost:5173` 查看仪表板。

## 常用命令

### 后端

```bash
cd backend
npm install
npm start
node run_graphql_backfill.js 30
node run_graphql_backfill.js 30 --flush-cache
node run_reaggregation.js
node backfill_single_repo.js <repo-name>
```

### 前端

```bash
cd frontend
npm install
npm run dev
npm run build
npm run preview
npm run lint
```

## API 概览

### 核心接口

| 接口 | 描述 |
|------|------|
| `GET /api/v1/organization/sigs` | 获取所有 SIG 列表 |
| `GET /api/v1/organization/timeseries` | 获取组织时间序列数据 |
| `GET /api/v1/sig/:sigId/timeseries` | 获取 SIG 时间序列数据 |
| `GET /api/v1/organization/latest-activity` | 获取最新活动列表 |

### 分析接口

| 接口 | 描述 |
|------|------|
| `GET /api/v1/organization/timeseries/aggregated` | 获取组织聚合时间序列 |
| `GET /api/v1/sig/:sigId/timeseries/aggregated` | 获取 SIG 聚合时间序列 |
| `GET /api/v1/sigs/compare` | 获取多 SIG 对比数据 |
| `GET /api/v1/organization/growth-analysis` | 获取组织增长分析 |
| `GET /api/v1/sig/:sigId/growth-analysis` | 获取 SIG 增长分析 |

### 贡献者接口

| 接口 | 描述 |
|------|------|
| `GET /api/v1/contributors/leaderboard` | 贡献者排行榜 |
| `GET /api/v1/contributors/stats` | 贡献者统计概览 |
| `GET /api/v1/contributors/:username` | 贡献者详情 |

### 导出接口

| 接口 | 描述 |
|------|------|
| `GET /api/v1/export/csv` | 导出 CSV |
| `GET /api/v1/export/excel` | 导出 Excel |
| `POST /api/v1/export/pdf` | 导出 PDF |

## 数据更新说明

- **自动更新**：后端服务默认每 6 小时自动采集一次新数据
- **手动回填**：使用 `backend/run_graphql_backfill.js`
- **重聚合**：使用 `backend/run_reaggregation.js`

注意：

- 默认情况下，服务启动时不会自动触发历史数据回填
- 如需在启动时自动回填，可通过环境变量 `ENABLE_STARTUP_BACKFILL=true` 显式开启
- 可通过 `STARTUP_BACKFILL_DAYS` 控制启动回填天数，默认值为 `30`
- 默认情况下，服务启动时不会自动清空 Redis
- 如需在启动时清空 Redis，可通过环境变量 `ENABLE_STARTUP_CACHE_FLUSH=true` 显式开启
- 默认情况下，`backend/run_graphql_backfill.js` 在回填结束后不会自动清空 Redis
- 如需在回填完成后清空 Redis，可显式传入 `--flush-cache`
- 示例：`node run_graphql_backfill.js 30 --flush-cache`
- 数据回填可能持续较长时间，取决于仓库数量与 GitHub API 限流情况
- 在共享环境中操作缓存和回填脚本前，建议先确认影响范围

## 故障排查

### 前端没有数据显示

1. 检查数据库中是否已有聚合数据：

```bash
psql -d oss_dashboard -c "SELECT COUNT(*) FROM activity_snapshots;"
```

2. 检查后端与 Redis 是否正常连接
3. 硬刷新浏览器：`Ctrl+Shift+R`

### 贡献者数据为空

1. 确认贡献者相关表已创建：

```bash
psql -d oss_dashboard -c "\dt contributors"
```

2. 运行回填脚本：

```bash
cd backend
node run_graphql_backfill.js 30
```

如需在回填结束后同步清空 Redis，可改用：

```bash
cd backend
node run_graphql_backfill.js 30 --flush-cache
```

### 遇到 GitHub API 限流

- 等待额度恢复后重试
- 适当减少回填天数，例如：

```bash
cd backend
node run_graphql_backfill.js 7
```

## 安全与配置

- 不要提交任何密钥、Token、数据库密码或本地 `.env` 文件
- 建议通过环境变量管理 `GITHUB_TOKEN`、数据库连接和 Redis 配置
- 如果在服务器或共享环境中部署，请限制 Redis 和数据库访问范围
- 运行回填、重聚合、导出等脚本前，建议先确认目标环境与数据影响范围

## 备注

- 当前 README 主要面向快速了解项目与本地启动
- 更细的运行机制、数据链路和维护说明可以在后续单独拆分到专门文档
