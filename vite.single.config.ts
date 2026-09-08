import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

/** Produces one self-contained HTML file with all JS and CSS inlined, for
 *  hosts that block external asset loading. */
export default defineConfig({
  base: './',
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    target: 'es2022',
    outDir: 'dist-single',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})
