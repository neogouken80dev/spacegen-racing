import { defineConfig, type Plugin } from 'vite'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Stamp the service worker's cache name with this build's id.
 *
 * `public/sw.js` is copied verbatim by Vite -- it is not bundled and not
 * content-hashed -- so without this the cache name is a constant, the activate
 * handler evicts nothing, and every build ever shipped accumulates in one
 * cache. See the header comment in public/sw.js for what that cost.
 */
function stampServiceWorker(): Plugin {
  const build = Date.now().toString(36)
  return {
    name: 'sg-stamp-sw',
    apply: 'build',
    // closeBundle, and on disk. Files in public/ are COPIED by Vite rather than
    // bundled, so they never appear in rollup's `bundle` object -- a
    // generateBundle hook looking for bundle['sw.js'] finds nothing and stamps
    // nothing, silently. Which is exactly the failure this plugin exists to
    // prevent, so it is worth having got wrong once.
    closeBundle() {
      const file = resolve(__dirname, 'dist', 'sw.js')
      if (!existsSync(file)) return
      const src = readFileSync(file, 'utf8')
      if (!src.includes('__SW_BUILD__')) {
        this.warn('sw.js has no __SW_BUILD__ token; the cache name is not versioned')
        return
      }
      writeFileSync(file, src.replace(/__SW_BUILD__/g, build))
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [stampServiceWorker()],
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'] },
      },
    },
  },
  server: { host: true, port: 5173 },
})
