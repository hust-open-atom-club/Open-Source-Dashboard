import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// 本地开发使用 Vite 默认主机、端口与本地 HMR，普通用户无需特权端口即可启动。
// 部署环境需要的域名、协议、端口一律通过下面的环境变量提供，不要写进本文件，
// 否则会强制所有贡献者依赖同一套生产参数。
export default defineConfig(({ mode }) => {
  const {
    VITE_DEV_HOST,
    VITE_DEV_PORT,
    VITE_ALLOWED_HOSTS,
    VITE_HMR_HOST,
    VITE_HMR_PROTOCOL,
    VITE_HMR_CLIENT_PORT,
  } = loadEnv(mode, '.')

  return {
    plugins: [react()],
    server: {
      host: VITE_DEV_HOST || 'localhost',
      port: Number(VITE_DEV_PORT) || 5173,
      allowedHosts: VITE_ALLOWED_HOSTS
        ? VITE_ALLOWED_HOSTS.split(',').filter(Boolean)
        : undefined,
      hmr: VITE_HMR_HOST
        ? {
            host: VITE_HMR_HOST,
            protocol: VITE_HMR_PROTOCOL || 'wss',
            clientPort: Number(VITE_HMR_CLIENT_PORT) || 443,
          }
        : undefined,
      proxy: {
        '/api': {
          target: 'http://localhost:3000',
          changeOrigin: true,
        },
      },
    },
  }
})
