import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: 'src/dashboard',
  build: {
    outDir: '../../dist/dashboard',
    // Stale hashed assets accumulate but don't break anything (index.html
    // always points at the freshest hash). The npm `build:dashboard` script
    // rimrafs dist/dashboard explicitly so clean builds stay clean.
    emptyOutDir: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api/mx': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
})
