/**
 * Builds the design benches under tools/bench/ into a standalone static site.
 *
 * Separate from the game's own config on purpose: the benches must never end up
 * in a shipping build, and rooting them here keeps them out of the app's module
 * graph entirely. Output goes to tools/bench/dist/, which is gitignored.
 *
 *   npx vite build --config tools/bench/vite.bench.config.ts
 */
import { defineConfig } from 'vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: here,
  base: './',
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: { input: { scorehud: resolve(here, 'scorehud.html') } },
  },
})
