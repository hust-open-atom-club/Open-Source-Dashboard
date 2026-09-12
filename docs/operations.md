# 运行与维护

[文档首页](README.md) · [快速开始](getting-started.md) · [架构与数据口径](architecture.md) · [API 参考](api.md)

本页命令会影响数据库、缓存或运行中的服务。生产环境操作前应先确认目标环境、备份数据，并在恢复出的副本上演练高风险步骤。

## 常用命令

Docker Compose：

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f backend
docker compose restart backend
docker compose down
```

后端：

```bash
cd backend
npm start
npm test
npm run sync-repository-sigs
```

前端：

```bash
cd frontend
npm run dev
npm run lint
npm run build
npm run preview
```

## 数据库迁移

Docker Compose 中的 `migrate` 服务会按文件名顺序执行 `db/migrations/` 下的迁移。迁移失败时后端不会启动，应先查看：

```bash
docker compose logs migrate
```

本机或手动迁移已有数据库时，按顺序执行：

```bash
psql -d oss_dashboard -f db/migrations/001_github_custom_property_sigs.sql
psql -d oss_dashboard -f db/migrations/002_repository_organization_membership.sql
psql -d oss_dashboard -f db/migrations/003_organization_ingestion_freshness.sql
```

生产数据库迁移前：

1. 备份数据库，并使用 `pg_restore -l` 或等价方式确认备份可读取。
2. 在恢复出的副本上执行迁移和应用验证。
3. 确认目标数据库身份后再维护生产环境。

不要在已有生产数据库上重新执行完整的 `db/schema.sql` 代替迁移。

## 仓库与 SIG 同步

以 GitHub 当前仓库列表和 `osd_sig` Custom Property 刷新仓库范围：

```bash
cd backend
npm run sync-repository-sigs
```

Docker Compose：

```bash
docker compose exec backend npm run sync-repository-sigs
```

项目的 npm 命令会调用同步脚本的 `--flush-cache` 选项；只有检测到归属变化时才清空 Redis。同步会处理仓库新增、重命名、移出组织、转移和 SIG 归属变化。远端数据未完整分页取得时任务会失败，不会用部分列表覆盖当前状态。

## 历史回填

回填最近 N 天：

```bash
cd backend
node run_graphql_backfill.js 30
```

回填后显式清空 Redis：

```bash
node run_graphql_backfill.js 30 --flush-cache
```

针对日期或区间回填：

```bash
node backfill_date_range.js --date 2026-09-01
node backfill_date_range.js --start-date 2026-09-01 --end-date 2026-09-07
```

该脚本也支持 `--flush-cache`。`--reset-existing` 会重置目标范围内的已有数据，只应在确认范围和备份后使用。

只回填单个仓库：

```bash
node backfill_single_repo.js repository-name
```

关联组织的仓库需在仓库名后传入 GitHub owner（默认为仪表盘组织）：

```bash
node backfill_single_repo.js rustsbi rustsbi
```

脚本接收仓库名称，不包含 `owner/` 前缀，默认回填最近 30 天，并写入该仓库的 Commit、PR 和 Issue 快照。它不会完整更新 SIG 和组织级聚合：随后运行 `run_reaggregation.js` 只能同步 Commit 与代码行，不能同步 PR 和 Issue。

如果修复涉及 PR 或 Issue，并要求仓库、SIG 和组织数据保持一致，应改用覆盖相同日期的 `backfill_date_range.js`。该脚本会处理全部受跟踪仓库，并重建目标日期的全部上层指标。以上命令在容器中执行时，在命令前加 `docker compose exec backend`。

## 重新聚合

已有 SIG 和组织快照行存在、但其中的 Git 聚合字段需要重新计算时：

```bash
cd backend
node run_reaggregation.js
```

需要同时清空 Redis：

```bash
node run_reaggregation.js --flush-cache
```

当前脚本重算最近 365 天中 SIG 和组织级的 Commit、增加行数与删除行数，不重新请求 GitHub，也不重算 PR、Issue 字段。它只 `UPDATE` 已存在的快照行，不会为缺失日期插入新行。

因此，它只适合底层仓库快照正确、上层快照行已经存在，但 Git 指标需要修复的场景。如果 SIG 或组织快照缺少某些日期，应使用 `backfill_date_range.js` 覆盖缺失范围，由完整回填流程重新写入全部聚合字段。

## 启动时维护开关

根目录 `.env` 提供启动时缓存和回填开关。示例配置默认关闭这些高影响操作：

```env
ENABLE_STARTUP_CACHE_FLUSH=false
ENABLE_STARTUP_BACKFILL=false
STARTUP_BACKFILL_DAYS=30
```

只有明确需要时才启用，并在部署完成后恢复为 `false`，避免每次重启重复执行。

## 定时采集与新鲜度

后端定时任务默认每 6 小时执行一次采集。只有定时采集完整成功后，系统才更新组织的 `last_updated_at`。

手动回填、针对日期修复和重聚合不会推进该时间戳。它们修复的是数据内容，不代表最新一轮生产采集已经成功。

如果页面显示：

- `fresh`：最近成功采集距当前时间不超过 12 小时。
- `stale`：最近成功采集已超过 12 小时。
- `missing`：尚未记录成功采集时间。

## 故障排查

### 页面可访问但没有数据

```bash
docker compose ps
docker compose logs migrate
docker compose logs backend
curl http://localhost:3000/api/v1/organization/summary
```

确认迁移完成、GitHub Token 可用，并检查是否已经执行首次历史回填。也可以直接确认聚合表是否有数据：

```bash
psql -d oss_dashboard -c "SELECT COUNT(*) FROM activity_snapshots;"
```

### 贡献者为空或数量偏少

先确认贡献者表已创建：

```bash
psql -d oss_dashboard -c "\dt contributors"
```

再确认 Commit 能关联到 GitHub 用户。无法关联用户的 Commit 仍计入活动量，但不会生成贡献者身份；Bot 账号也不会计入人类贡献者指标。

### GitHub API 限流或采集失败

检查后端日志中的 GraphQL `errors`、REST 响应体和速率限制信息。等待额度恢复后重试；只修复少数日期时优先使用定点回填，或缩短回填范围，例如 `node run_graphql_backfill.js 7`。HTTP 200 只代表请求传输成功，不能替代响应内容与实际落库结果的验证。

### 数据状态长期为 stale 或 missing

检查定时任务是否运行、最近一轮采集是否完整成功，以及数据库中的新鲜度记录。仅执行手动回填不会更新成功采集时间。

## 安全边界

- 不要提交 GitHub Token、数据库密码、`.env` 或备份文件。
- GitHub Token 使用满足读取仓库和 Custom Properties 所需的最小权限。
- PostgreSQL 和 Redis 不应直接暴露到公网。
- 生产部署或修复后，应检查服务日志、API 响应内容、数据库状态和页面结果；不要只依据进程存在、退出码为 0 或 HTTP 200 判断成功。
