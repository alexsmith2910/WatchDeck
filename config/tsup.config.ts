import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { 'bin/cli': 'src/bin/cli.ts' },
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  shims: false,
})
