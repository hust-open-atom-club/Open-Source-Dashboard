import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import process from 'node:process'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'DEV_SERVER_')
  const hmr = {
    ...(env.DEV_SERVER_HMR_HOST && { host: env.DEV_SERVER_HMR_HOST }),
    ...(env.DEV_SERVER_HMR_PROTOCOL && { protocol: env.DEV_SERVER_HMR_PROTOCOL }),
    ...(env.DEV_SERVER_HMR_CLIENT_PORT && { clientPort: Number(env.DEV_SERVER_HMR_CLIENT_PORT) }),
  }

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      ...(env.DEV_SERVER_ALLOWED_HOST && { allowedHosts: [env.DEV_SERVER_ALLOWED_HOST] }),
      ...(Object.keys(hmr).length && { hmr }),
      proxy: {
        '/api': {
          target: 'http://localhost:3000',
          changeOrigin: true,
        },
      },
    },
  }
})
