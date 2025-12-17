# 开源活动仪表板

一个专门用于监控和可视化Github Organization活动的数据仪表板系统。

## 主要功能

### 数据采集与分析
- **双管道数据采集**：Git 提交统计 + GitHub API 数据采集
- **三级数据模型**：仓库 → SIG → 组织，支持灵活的查询和聚合
- **贡献者追踪**：独立贡献者统计、排行榜、新贡献者识别

### 数据可视化
- **组织总览卡片**：展示最新活动快照（PR、Issue、Commit、代码行数等）
- **趋势图表**：使用 ECharts 展示多维度活动趋势
- **多 SIG 趋势对比**：可同时选择多个 SIG 进行趋势对比
- **贡献者排行榜**：头像、用户名、活跃天数、贡献统计

### 高级分析功能
- **日/周/月视图切换**：支持不同粒度的数据聚合查看
- **增长分析报告**：环比增长率分析，多维度指标对比
- **数据导出**：支持 CSV、Excel、PDF 三种格式导出

### 用户体验
- 加载骨架屏、错误边界、Toast 通知
- Redis 缓存加速（10分钟 TTL）
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

```
oss-dashboard/
├── backend/                  # Node.js/Express 后端服务
│   ├── server.js             # 主服务器文件
│   ├── run_graphql_backfill.js  # 数据回填脚本
│   └── .env.example          # 环境变量示例
├── frontend/                 # React/Vite 前端应用
│   ├── src/
│   │   ├── App.jsx           # 主应用组件
│   │   ├── components/       # UI 组件
│   │   └── services/         # API 服务层
│   └── vite.config.js
├── db/                       # 数据库脚本
│   ├── schema.sql            # 核心表结构定义
│   ├── seed.sql              # SIG 和仓库初始数据
│   ├── contributors_schema.sql  # 贡献者表结构
│   └── views.sql             # 物化视图（可选）
├── repos/                    # 本地 Git 仓库存储目录
└── repos.csv                 # SIG 与仓库映射关系文件
```

## 部署指南

### 1. 环境准备

需要安装并运行以下服务：
- **Node.js** (v18+)
- **PostgreSQL** 数据库服务
- **Redis** 缓存服务
- **Git** 命令行工具

### 2. 数据库初始化

```bash
# 创建数据库
createdb oss_dashboard

# 初始化核心表结构
psql -d oss_dashboard -f db/schema.sql

# 填充 SIG 和仓库数据
psql -d oss_dashboard -f db/seed.sql

# 创建贡献者相关表
psql -d oss_dashboard -f db/contributors_schema.sql

# (可选) 创建物化视图以提升性能
psql -d oss_dashboard -f db/views.sql
```

### 3. 后端配置与启动

```bash
cd backend

# 复制并编辑环境变量
cp .env.example .env
# 编辑 .env 文件，配置：
# - GITHUB_TOKEN: GitHub Personal Access Token
# - DB_* : PostgreSQL 连接信息
# - REDIS_* : Redis 连接信息

# 安装依赖
npm install

# 启动服务
npm start
```

> **注意**: 首次启动会自动触发历史数据回填，由于 API 延迟机制，回填过程会较慢（2-4小时）。

### 4. 数据回填（可选）

如需手动回填历史数据：

```bash
cd backend

# 回填最近 30 天的数据（包含贡献者数据）
node run_graphql_backfill.js 30

# 也可以指定其他天数
node run_graphql_backfill.js 7    # 7天
node run_graphql_backfill.js 60   # 60天
```

### 5. 前端启动

```bash
cd frontend

# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

访问 http://localhost:5173 查看仪表板。

## API 接口

### 核心接口

| 接口 | 描述 |
|------|------|
| `GET /api/v1/organization/sigs` | 获取所有 SIG 列表 |
| `GET /api/v1/organization/timeseries` | 组织时间序列数据 |
| `GET /api/v1/sig/:sigId/timeseries` | SIG 时间序列数据 |
| `GET /api/v1/organization/latest-activity` | 最新活动列表（分页） |

### 高级分析接口

| 接口 | 描述 |
|------|------|
| `GET /api/v1/organization/timeseries/aggregated` | 组织聚合时间序列（支持日/周/月粒度） |
| `GET /api/v1/sig/:sigId/timeseries/aggregated` | SIG 聚合时间序列 |
| `GET /api/v1/sigs/compare` | 多 SIG 对比数据 |
| `GET /api/v1/organization/growth-analysis` | 组织增长分析 |
| `GET /api/v1/sig/:sigId/growth-analysis` | SIG 增长分析 |

### 贡献者接口

| 接口 | 描述 |
|------|------|
| `GET /api/v1/contributors/leaderboard` | 贡献者排行榜 |
| `GET /api/v1/contributors/stats` | 贡献者统计概览 |
| `GET /api/v1/contributors/:username` | 贡献者详情 |

### 导出接口

| 接口 | 描述 |
|------|------|
| `GET /api/v1/export/csv` | CSV 导出 |
| `GET /api/v1/export/excel` | Excel 导出 |
| `POST /api/v1/export/pdf` | PDF 导出 |

## 故障排查

### 前端无数据显示

1. **检查数据库是否有数据**：
   ```bash
   psql -d oss_dashboard -c "SELECT COUNT(*) FROM activity_snapshots;"
   ```

2. **清除 Redis 缓存**：
   ```bash
   redis-cli FLUSHALL
   ```

3. **硬刷新浏览器**：`Ctrl+Shift+R`

### 贡献者数据为空

1. 确认贡献者表已创建：
   ```bash
   psql -d oss_dashboard -c "\dt contributors"
   ```

2. 运行数据回填：
   ```bash
   node run_graphql_backfill.js 30
   ```

### API 限流问题

如遇到 "Rate limit exceeded" 错误：
- 等待 1 小时后重试
- 或减少回填天数：`node run_graphql_backfill.js 7`

## 数据更新机制

- **自动更新**：后端服务每 6 小时自动采集新数据
- **手动回填**：使用 `run_graphql_backfill.js` 脚本
