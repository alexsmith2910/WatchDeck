import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/bin/cli.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  shims: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
})
