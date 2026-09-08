/**
 * Convert the single-file Vite build into the shape the Claude Artifact host
 * expects: no doctype/html/head/body wrapper (the host supplies a skeleton),
 * no references to external files (the host blocks them).
 */
import { readFile, writeFile } from 'node:fs/promises'

const src = await readFile('dist-single/index.html', 'utf8')
const head = /<head>([\s\S]*?)<\/head>/.exec(src)?.[1] ?? ''
const body = /<body>([\s\S]*?)<\/body>/.exec(src)?.[1] ?? ''
if (!head || !body) throw new Error('could not parse the single-file build')

const cleanHead = head
  .replace(/<meta charset[^>]*>/g, '')
  .replace(/<meta name="viewport"[^>]*>/g, '')
  .replace(/<link[^>]*>/g, '')
  .replace(/<title>[\s\S]*?<\/title>/g, '')
  .trim()

// The service worker cannot register from the artifact origin.
const cleanBody = body.replace("navigator.serviceWorker.register('./sw.js')", 'Promise.reject()').trim()

const out = [
  '<title>SpaceGen Racing</title>',
  `<style>
  /* The artifact skeleton sets a 14px system font on an off-white ground;
     the game owns the whole viewport, so reclaim it explicitly. */
  html, body { margin: 0; padding: 0; height: 100%; width: 100%;
    background: #05070c; overflow: hidden; overscroll-behavior: none;
    touch-action: none; -webkit-tap-highlight-color: transparent; }
</style>`,
  cleanHead,
  cleanBody,
].join('\n')

await writeFile('dist-single/artifact.html', out)
const kb = (out.length / 1024).toFixed(0)
if (out.length > 15 * 1024 * 1024) throw new Error(`artifact is ${kb}KB, over the 16MB cap`)
if (!/id="app"/.test(out)) throw new Error('app mount point missing')
if (!/<script/.test(out)) throw new Error('bundle script missing')
console.log(`dist-single/artifact.html  ${kb} KB`)
