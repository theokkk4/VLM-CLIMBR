import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const API_PORT = Number(process.env.CLIMBR_API_PORT ?? 8787)

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: true },
    },
  },
  // Pre-bundle what the lazy 3D view and the PDF export pull in, so opening
  // either for the first time never triggers a full-page reload mid-demo.
  optimizeDeps: {
    include: ['three', '@react-three/fiber', '@react-three/drei', 'three/examples/jsm/loaders/PLYLoader.js', 'jspdf', 'framer-motion', 'lucide-react'],
  },
  build: {
    chunkSizeWarningLimit: 1600,
  },
})
