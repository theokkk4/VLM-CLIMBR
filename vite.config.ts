import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const API_PORT = Number(process.env.CLIMBR_API_PORT ?? 8787)

export default defineConfig({
  plugins: [react()],
  // The app reads no VITE_ variables. The API key lives in the project's .env,
  // which the server rewrites when a key is connected; keeping Vite's env lookup
  // elsewhere stops that write from restarting the dev server mid-session.
  envDir: 'node_modules/.vite-env',
  server: {
    port: 5173,
    proxy: {
      '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: true },
    },
  },
  // Pre-bundle what the lazy PDF export pulls in, so opening it for the first
  // time never triggers a full-page reload mid-demo.
  optimizeDeps: {
    include: ['jspdf', 'framer-motion', 'lucide-react'],
  },
  build: {
    chunkSizeWarningLimit: 1600,
  },
})
