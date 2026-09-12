# 架构与数据口径

[文档首页](README.md) · [快速开始](getting-started.md) · [API 参考](api.md) · [运行与维护](operations.md)

本文说明系统的数据链路、组织层级和统计口径。部署与开发步骤见[快速开始](getting-started.md)。

## 系统组成

| 组件 | 作用 |
|------|------|
| GitHub GraphQL API | 获取默认分支 Commit 历史；历史和定点回填时也获取 PR、Issue 与贡献者活动 |
| GitHub REST API | 获取仓库元数据、Repository Custom Properties，以及定时采集的 PR 和 Issue 数据 |
| Node.js + Express | 数据采集、聚合和 API 服务 |
| PostgreSQL | 保存仓库、活动明细、聚合结果和数据更新时间 |
| Redis | 缓存高频查询结果 |
| React + Vite + ECharts | 仪表板页面和图表展示 |
| Docker Compose + Nginx | 编排服务并提供前端静态资源及 API 代理 |

## 数据链路

```text
GitHub API
    │
    ▼
采集与仓库归属同步
    │
    ▼
PostgreSQL 明细数据
    │
    ▼
日粒度聚合与 Redis 缓存
    │
    ▼
Express API ──► React 仪表板 / 数据导出
```

采集路径会随任务类型变化：

- 定时采集：Commit 使用 GraphQL；PR 和 Issue 使用 REST API，并写入仓库、SIG 和组织快照。
- 全量或日期范围回填：`run_graphql_backfill.js` 和 `backfill_date_range.js` 均通过 GraphQL 获取 Commit、PR 和 Issue，并在完成后重建目标日期的 SIG 和组织聚合。
- 单仓库回填：`backfill_single_repo.js` 的 Commit 使用 GraphQL，PR 和 Issue 使用 REST API；它只写入仓库快照，不完整重建 SIG 和组织聚合。

系统按照以下层级组织数据：

```text
Organization
└── SIG
    └── Repository
        └── Contributor
```

## 仓库范围与 SIG 归属

GitHub Repository Custom Property `osd_sig` 是仓库 SIG 归属的唯一来源。

- 设置为某个 SIG 名称：仓库参与该 SIG 和组织级统计。
- 设置为 `untracked`：保留已有历史数据，但停止后续采集，并从组织和 SIG 聚合中排除。
- 仓库被移出组织或转移后：保留历史数据，但不再计入当前组织仓库范围。
- 仓库重命名时：使用稳定的 GitHub repository ID 识别同一仓库，避免产生重复记录。
- SIG 归属改变后：同步任务会触发历史数据重新归组，使旧数据进入新的 SIG 口径。

后端启动、定时采集和历史回填前都会同步仓库归属。仓库列表和 Custom Properties 会完整分页读取；属性定义不匹配、仓库属性缺失或重复、出现不支持的枚举值，或无法取得完整分页数据时，同步会整体失败，不会把部分结果写入数据库。

### 关联组织跟踪

`associated_org_trackings` 表配置仪表盘组织之外的关联 GitHub 组织（预置 `rustsbi`）。这些组织的仓库通过与仪表盘组织**相同的 `osd_sig` Custom Property** 声明 SIG 归属，与 club 属性同步一起执行：

- 属性值为受支持的 SIG（如 `r2`）：公开仓库归入该 SIG 并参与统计。
- 未设置属性或值为 `untracked`：不跟踪。
- 属性值不受支持、同一仓库出现多个 `osd_sig` 值、或声明仓库不在组织仓库列表中：同步整体失败（fail-closed），不会写入部分结果。
- 私有仓库原则上不跟踪：即使设置了 `osd_sig` 也会跳过（同步结果中会记录跳过名单）。
- 仓库取消声明、转为私有或被移出组织：保留历史数据，但停止采集并从聚合中排除。
- 关联组织仓库在 `repositories` 表中以 `owner_login` 区分；club 内同名 fork（如 `hust-open-atom-club/rustsbi`）与关联组织仓库（`rustsbi/rustsbi`）可共存，唯一约束为 `(org_id, owner_login, name)`。club 组织的 `osd_sig` 同步不会影响关联组织的仓库行，两套来源互不干扰。
- Commit 统计口径与其他仓库完全一致，仅取默认分支。

与 club 组织不同，仪表盘 Token 通常无法读取关联组织的属性定义（schema 需要 org 管理员权限），因此只对属性值本身做白名单校验。关联组织需先在 GitHub 组织设置中定义 `osd_sig` 属性（单选，允许值覆盖仪表盘支持的 SIG 与 `untracked`，并设为公开可见），再为需要跟踪的仓库设置属性值。

## Commit 与贡献者口径

- Commit 数据来自每个仓库的默认分支历史，并按本地日期分桶到统计区间。
- Merge Commit 计入 Commit 总数，但其增加行数和删除行数固定记为 0，避免与合入的普通 Commit 重复计算代码行。
- Bot 提交计入仓库、SIG 和组织的 Commit 与代码行活动统计。
- Bot 账号不计入人类贡献者人数、排行榜等贡献者指标。
- 无法关联 GitHub 用户的 Commit 仍计入活动量，但不会归属到某个贡献者账号。

采集器直接读取 GitHub API，不会 clone 或持久化组织仓库的工作树。

## 活跃状态

仓库或 SIG 在所选时间范围内存在以下任一活动时视为活跃：

- 新增或关闭 PR
- 新增或关闭 Issue
- 新增 Commit

只有代码行变化、但没有上述活动记录时，不单独标记为活跃。

## 时间范围与粒度

API 和前端支持：

- 最近 N 天：使用 `7d`、`30d`、`90d` 等 `<days>d` 格式。
- 全部历史：支持统一范围解析的接口使用 `all`；具体限制见 [API 参考](api.md)。
- 聚合趋势、SIG 对比和导出粒度：`day`、`week` 或 `month`。

最近 N 天按自然日边界计算。不同接口会根据用途返回日粒度明细、区间汇总或增长对比。

## 数据新鲜度

组织汇总接口返回：

- `last_updated_at`：最近一次成功的定时采集完成时间。
- `data_status`：`fresh`、`stale` 或 `missing`。

默认情况下，距离最近成功采集超过 12 小时视为 `stale`；从未记录成功采集时间时为 `missing`。前端会随时间重新计算状态，因此页面长时间打开后也能反映数据过期。

手动回填和重聚合用于修复数据，不会冒充一次新的定时采集完成时间。

## 目录结构

```text
Open-Source-Dashboard/
├── backend/             # Express API、采集、聚合和维护脚本
├── frontend/            # React 仪表板
├── db/                  # schema、seed、视图和迁移
├── docs/                # 使用、架构、API 和运维文档
├── docker-compose.yml   # 本地及部署编排
└── README.md            # 项目概览和最短上手路径
```
