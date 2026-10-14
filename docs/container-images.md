# 容器镜像

[返回项目首页](../README.md) · [快速开始](getting-started.md) · [运行与维护](operations.md)

项目沿用前后端独立容器的架构，复用 `backend/Dockerfile` 和 `frontend/Dockerfile`，发布两个 `linux/amd64` 镜像：

- 后端：`ghcr.io/hust-open-atom-club/open-source-dashboard/backend`
- 前端：`ghcr.io/hust-open-atom-club/open-source-dashboard/frontend`

每次成功发布为两个镜像添加相同的 `sha-<main 完整提交 SHA>` 和 `latest` 标签。镜像的 OCI `revision` 标签也记录这个 SHA。`latest` 表示最近一次成功发布的版本，并不随 `main` 的每次提交自动更新；SHA 标签标识源码版本，重新构建同一提交时基础镜像仍可能变化，需要严格固定镜像内容时使用 registry digest。

## 手动发布

1. 先将此工作流合并到默认分支 `main`，GitHub Actions 才会显示手动运行入口。
2. 打开仓库 **Actions → Publish GHCR image → Run workflow**，推荐选择 `main`。
3. 等待前后端构建和推送全部成功，在运行摘要中查看实际发布的 SHA 和镜像标签。

工作流只有 `workflow_dispatch` 触发器；push、PR、tag 和定时任务都不会触发镜像发布。无论从哪个 ref 手动触发，本工作流都显式检出执行 checkout 时最新的 `refs/heads/main`，两个 Docker 构建使用同一份检出的工作目录，标签取自 `git rev-parse HEAD`，不使用触发事件的 SHA。因此，尚未合并到 `main` 的应用或 Dockerfile 改动不会被打包。

所有发布共用一个并发组，不会取消正在执行的发布。两个镜像都构建成功后，先推送两个 SHA 标签，再更新两个 `latest` 标签。Registry 不提供跨镜像事务：若推送阶段失败，部分标签可能已更新，排查后重新手动运行即可；部署时优先使用一次完整成功运行中的相同 SHA 标签。

认证仅使用 GitHub 自动提供的 `GITHUB_TOKEN`，权限为 `contents: read` 和 `packages: write`，无需新增仓库 secret 或发布 PAT。所有 Actions 固定到官方发行版本的完整 commit SHA。不要向构建步骤传入运行时 GitHub PAT、数据库密码或 `.env`；这些信息只应在部署时配置。

首次发布还需要仓库/组织允许 Actions 写入 Packages。GHCR 新包默认可能是私有的，公开仓库不保证镜像可匿名拉取；如需公开拉取，由包管理员检查包的可见性。若同名包已存在，需确认该包的 **Manage Actions access** 已授予本仓库写入权限。工作流不会修改这些设置。

## 使用预构建镜像部署

仍需检出仓库中的 Compose 和 `db/` 文件，PostgreSQL 初始化及迁移通过宿主机挂载这些 SQL 文件完成，应用镜像不内置数据库或 Redis。

先按[快速开始](getting-started.md)复制 `.env.docker.example` 为 `.env`，填写运行时的 `GITHUB_TOKEN` 和 `POSTGRES_PASSWORD`。此处的 `GITHUB_TOKEN` 是供后端采集 GitHub 数据的 PAT，与 Actions 自动提供、仅用于发布的同名 token 用途不同。

在 `.env` 中添加两个镜像共用的版本，推荐使用成功运行摘要中的完整提交 SHA：

```env
IMAGE_TAG=sha-<完整的 main 提交 SHA>
```

同时检出对应的源码提交，以便 `db/`、Compose 配置与镜像版本一致。若只是体验最新已发布版本，可设置 `IMAGE_TAG=latest`。Fork 可通过 `GHCR_IMAGE_PREFIX=ghcr.io/<小写 owner>/<小写 repo>` 指向自己的包。

在仓库根目录执行：

```bash
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml pull backend frontend
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d --no-build
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml ps
```

若包为私有，先用对包有读取权限的账户按 [GHCR 文档](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)登录；不要把凭据提交到仓库。`--no-build` 防止回退到本地构建，拉取失败时先解决权限或标签问题。

覆盖文件只指定前后端镜像，继续使用原 Compose 的数据库健康检查、迁移、Redis、数据卷和运行时环境变量。前端 nginx 监听容器内 `80`，将 `/api/` 转发到同一 Compose 网络中的 `backend:3000`；后端监听容器内 `3000`。宿主机默认访问：

- 前端：`http://localhost:8080`，可通过 `.env` 的 `FRONTEND_PORT` 调整
- 后端：`http://localhost:3000`，可通过 `.env` 的 `BACKEND_PORT` 调整

首次历史回填、数据库备份与升级仍按现有[运行与维护](operations.md)步骤操作。正式升级前先备份数据库并验证迁移；镜像更新本身不会替你备份或回填数据。

## 本地构建验证

在仓库根目录执行，无需登录 GHCR，也不会推送：

```bash
docker build --platform linux/amd64 -f backend/Dockerfile -t osd-backend:local .
docker build --platform linux/amd64 -f frontend/Dockerfile -t osd-frontend:local .
```

后端镜像安装锁定的生产 npm 依赖；前端镜像执行 `npm ci` 和 Vite 生产构建，再由 nginx 提供静态文件。根目录 `.dockerignore` 排除本地 `.env*`、依赖、构建产物、缓存仓库及导出文件。
