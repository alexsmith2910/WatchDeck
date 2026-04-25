/**
 * Library build for the mountable dashboard component.
 *
 *   - Entry:  src/dashboard/lib-entry.ts
 *   - Output: dist/dashboard-mount/index.{js,css}
 *   - React + react-dom + react-router-dom are externalised — the host app
 *     supplies them. Everything else (HeroUI, recharts, iconify, etc.) is
 *     bundled to keep the install footprint and version pinning simple.
 *
 * Consumed via the `"./dashboard"` subpath in package.json `exports`.
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist/dashboard-mount',
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: true,
    lib: {
      entry: 'src/dashboard/lib-entry.ts',
      formats: ['es'],
      fileName: () => 'index.js',
      cssFileName: 'styles',
    },
    rollupOptions: {
      external: [
        'react',
        'react/jsx-runtime',
        'react-dom',
        'react-dom/client',
        'react-router-dom',
      ],
    },
  },
})
