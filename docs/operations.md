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
psql -d oss_dashboard -f db/migrations/004_snapshot_generation.sql
psql -d oss_dashboard -f db/migrations/005_repository_github_created_at.sql
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

### 新仓库与历史覆盖

仓库同步会额外获取 GitHub 仓库元数据并保存 `repositories.github_created_at`。
这个字段表示 GitHub 仓库创建时间，不是本地登记时间，也不是转入俱乐部的时间。
元数据或 Custom Property 列表不完整、仓库 ID 对不上时，同步整体失败，不写入部分列表。

每次日常采集成功发布后，自动检查已有组织快照日期中的仓库缺行，优先补最近的缺口。
单次最多处理 31 个日期，每批最多 7 个日期，只修改缺行仓库；同日缺少多个仓库时一起原子发布。
每个成功日期都会从下次缺口扫描中消失，失败后由后续定时任务继续，不依赖进程内进度。
补历史不推进成功采集时间；补历史失败也不会撤销已经成功的日常采集。

只读一致性检查会单独输出创建前待核实（`pre_creation_unverified`）、创建后缺快照（`missing_after_creation`）和创建时间未知（`unknown_creation_time`）。
创建前待核实不等于漏掉真实贡献，但仍需检查历史后才能判零：导入提交可能早于 GitHub 仓库创建日。
自动补齐不会按创建时间截断 Commit 历史；只有完整采集成功且无活动时才写入零值快照。
存在任一未核实缺行或汇总差异时检查器退出码为 1，不能据此直接删除历史或批量填零。

上线本功能前先应用 `005_repository_github_created_at.sql`；保持现有统计口径和生产环境时区一致。

回填最近 N 天：

```bash
cd backend
node run_graphql_backfill.js 30
```

兼容旧命令中的 `--flush-cache`；现在每次发布后都会失效相关缓存，不再执行全库清空：

```bash
node run_graphql_backfill.js 30 --flush-cache
```

针对日期或区间回填：

```bash
node backfill_date_range.js --date 2026-09-01
node backfill_date_range.js --start-date 2026-09-01 --end-date 2026-09-07
```

`--reset-existing` 现在只忽略保存的进度，不再预先删除数据。旧数据会一直保留到目标日期的新批次成功提交。

只回填单个仓库：

```bash
node backfill_single_repo.js repository-name
```

脚本接收组织内的受跟踪仓库名称，不包含 `owner/` 前缀，默认回填最近 30 天。每个日期会在同一事务内替换该仓库的 Commit、PR、Issue 和贡献者事实，并重建 SIG、组织的全部聚合指标。其他仓库的原始事实保持不变。

完整发布、部分发布和单日重新聚合共用仓库覆盖检查。单仓库回填可以补齐目标仓库自身的缺失行，但其他当前受跟踪仓库必须已有该日期快照（包括显式零值行）。若仍有仓库缺失，会列出缺失仓库并要求完整回填；整个日期的事务回滚，仓库、贡献者、上层汇总和版本号保持原样，也不会失效缓存。

如需重新采集全部受跟踪仓库，应使用 `backfill_date_range.js`。历史回填和单仓库修复都不更新组织的“最近更新时间”；只有完整的日常采集成功发布才更新。以上命令在容器中执行时，在命令前加 `docker compose exec backend`。

## 重新聚合

仅重新采集 Commit、保留已有 PR/Issue 事实，可运行 `node fix_git_stats.js 30`。它同样按日期原子发布并重建全部上层指标；如果底层日期缺失则要求完整回填，不会静默跳过。该操作不更新组织采集完成时间。

底层仓库快照正确、上层聚合需要修复时，显式指定日期：

```bash
cd backend
node run_reaggregation.js --date 2026-09-07
```

只读检查所有保留日期（发现差异时退出码为 1），也可以传入单个日期：

```bash
node check_snapshot_consistency.js
node check_snapshot_consistency.js 2026-09-07
```

重新聚合不请求 GitHub，在一个事务内重建目标日期 SIG 和组织的全部八个可加和指标（含缺失的上层行），提交后自动失效相关缓存，不更新采集完成时间。与完整发布一样，要求当前所有受跟踪且仍属于组织的仓库都有目标日期快照（零活跃也必须有零值行）；缺少任意仓库时拒绝修改，列出缺失仓库并要求完整回填。本地仓库登记时间不代表历史归属，不能用来忽略缺失行。

检查器比较每个 SIG 与其仓库之和，再比较组织与 SIG 之和；它不能证明 GitHub 源数据完整，也不把跨仓库去重贡献人数当作可加和指标。底层数据不完整时应使用完整回填。

## 原子发布与并发

升级时先运行 `004_snapshot_generation.sql`，并停止旧版本后端及旧回填脚本，再启动新版本；旧脚本不遵守版本锁，不能与新版本混跑。Docker Compose 的迁移服务会自动应用此迁移。

日常采集先收齐全部受跟踪仓库（包括零活跃仓库）的数据，然后用一个数据库连接和事务发布仓库、贡献者、SIG、组织快照。采集或提交失败时保留上一批完整数据。回填每次收集最多七天，按日期原子发布；后续日期失败不会撤销之前已提交的完整日期。

发布时锁定组织并校验采集开始时的数据版本与仓库归属。其他任务已发布或归属已变更时，本批次报错并要求重新采集，不覆盖新结果。进度文件记录已提交的日期和版本；旧格式或版本不符的进度会被忽略。每个 API 请求的数据库查询及版本号读取使用同一只读、可重复读事务，避免一次响应混入不同版本；响应完成或连接断开后释放连接。缓存按该事务内的版本隔离，旧请求不会污染新版本缓存。数据库已提交但 Redis 失效失败时会明确报告已提交，不能把它当成数据库回滚。

本地数据库集成测试（只使用专用测试数据库；测试会创建并清理随机 schema）：

```bash
cd backend
SNAPSHOT_TEST_DATABASE_URL=postgres://postgres:password@127.0.0.1:5432/osd_test npm test
```

未提供该变量时只运行普通测试并跳过 PostgreSQL 集成测试；Backend CI 使用独立 PostgreSQL 服务执行全部测试。

## 启动时维护开关

根目录 `.env` 提供启动时缓存和回填开关。示例配置默认关闭这些高影响操作：

```env
ENABLE_STARTUP_CACHE_FLUSH=false
ENABLE_STARTUP_BACKFILL=false
STARTUP_BACKFILL_DAYS=30
```

只有明确需要时才启用，并在部署完成后恢复为 `false`，避免每次重启重复执行。

## 定时采集与新鲜度

后端定时任务默认每 6 小时执行一次采集，需要调整时在根目录 `.env` 中设置 cron 表达式：

```env
INGESTION_CRON_SCHEDULE=0 */6 * * *
```

该变量接收标准 cron 表达式，未设置时按默认值每 6 小时执行。注册任务前会先用 `node-cron` 校验表达式，非法值会打印出错的变量名和原因，进程以非 0 状态退出，不会带着错误的调度继续启动。

只有定时采集完整成功后，系统才更新组织的 `last_updated_at`。

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
