import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Vite config files run in Node, not the browser, so `import.meta.env` is not
// available here — env vars must be read via `loadEnv`. This block (the dev
// server proxy) is only ever consulted by `vite dev`/`vite serve`; Vite does
// not invoke `server.proxy` during `vite build`, so no extra guard is needed.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const devProxyTarget = env.VITE_DEV_PROXY_TARGET || 'http://localhost:3000'

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      proxy: {
        '/api': {
          target: devProxyTarget,
          changeOrigin: true
        },
        '/templates': {
          target: devProxyTarget,
          changeOrigin: true
        }
      }
    },
    // Vitest reads this same config; `environment: 'jsdom'` gives
    // `window`/`window.location` for code under test (e.g.
    // `src/services/api.js`'s relative-path URL validation), which the
    // default 'node' environment does not provide.
    test: {
      environment: 'jsdom'
    }
  }
})