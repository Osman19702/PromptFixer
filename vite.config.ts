import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  // The backend reads PORT from .env (dotenv), so the dev proxy must follow the
  // same value. loadEnv with an empty prefix reads every key from the .env
  // files and lets a variable already set in the shell win — the same
  // precedence dotenv gives the server.
  const env = loadEnv(mode, process.cwd(), '')
  const port = env.PORT !== undefined && env.PORT !== '' ? env.PORT : '8787'
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: `http://localhost:${port}`,
          changeOrigin: true,
        },
      },
    },
    build: { outDir: 'dist' },
  }
})
