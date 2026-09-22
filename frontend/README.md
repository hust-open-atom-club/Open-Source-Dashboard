# 前端开发指南

本目录是开源活动仪表板的 React + Vite 前端。项目概况、完整的后端与数据库初始化步骤见[根目录 README](../README.md)和[快速开始](../docs/getting-started.md)。

## 本机开发

需要 Node.js `^20.19.0 || >=22.12.0` 和 npm。先按[本机开发步骤](../docs/getting-started.md#本机开发)启动 PostgreSQL、Redis 与后端；后端默认监听 `http://localhost:3000`。然后在仓库根目录执行：

```bash
cd frontend
npm ci
npm run dev
```

当前 `vite.config.js` 使用 Vite 默认主机与端口，成功启动后本机可访问 `http://localhost:5173`（以终端输出为准）。如需在远程或容器环境中指定主机、端口、允许的 Host 或 HMR 参数，通过环境变量提供，不要写进配置文件：

| 环境变量 | 作用 |
|------|------|
| `VITE_DEV_HOST` | 开发服务器监听主机，默认 `localhost` |
| `VITE_DEV_PORT` | 开发服务器端口，默认 `5173` |
| `VITE_ALLOWED_HOSTS` | 允许的 Host，逗号分隔；默认仅放行 localhost 与本机 IP |
| `VITE_HMR_HOST` | HMR 主机；不设置时使用本地 HMR |
| `VITE_HMR_PROTOCOL` | HMR 协议，随 `VITE_HMR_HOST` 生效，默认 `wss` |
| `VITE_HMR_CLIENT_PORT` | HMR 客户端端口，随 `VITE_HMR_HOST` 生效，默认 `443` |

例如在容器内监听全部网卡：

```bash
VITE_DEV_HOST=0.0.0.0 npm run dev
```

前端使用相对路径 `/api/v1` 请求后端；Vite 将 `/api` 请求代理到 `http://localhost:3000`。如果后端未启动，页面仍可能打开，但数据请求会失败。

## 检查与预览

以下命令均在 `frontend/` 目录执行：

| 命令 | 用途 |
|------|------|
| `npm run dev` | 启动 Vite 开发服务器，修改页面时用于本机调试 |
| `npm run lint` | 使用 ESLint 检查前端代码 |
| `npm run build` | 将生产静态资源构建到 `dist/` |
| `npm run preview` | 本机预览已有的 `dist/` 构建结果；先运行 `npm run build` |

```bash
npm run lint
npm run build
npm run preview
```

`preview` 默认使用 `http://localhost:4173`（以终端输出为准），并沿用 `/api` 代理设置；查看实时数据仍需本机后端运行。

## Docker Compose 与本机开发

如果只想启动完整应用，请按[根目录快速开始](../README.md#快速开始)在仓库根目录运行 Docker Compose。其默认前端地址是 `http://localhost:8080`，由容器中的 Nginx 提供构建产物并将 `/api` 转发给后端容器。上述 `npm run dev`/`preview` 是本机开发与预览方式，不使用 Compose 的前端服务；两种方式的端口与代理目标不同。
