import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { 'bin/cli': 'src/bin/cli.ts' },
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  // Don't wipe dist — the `build` npm script handles targeted cleans so the
  // dashboard output (produced by `build:dashboard`) isn't clobbered.
  clean: false,
  sourcemap: true,
  shims: false,
})
