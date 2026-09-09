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
  .replace(/navigator\.serviceWorker\.register\([^)]*\)/g, 'Promise.reject()')
  .trim()

// The service worker cannot register from the artifact origin, so the call is
// replaced with a rejected promise the existing .catch() swallows.
//
// Two things were wrong here and both were silent. It matched ONE exact
// spelling of the call, so a minifier changing the quotes or the registration
// growing an options argument would stop it matching. And it only searched the
// BODY, while vite-plugin-singlefile inlines the module script into the HEAD --
// so it has in fact never matched, and every artifact built by this script has
// shipped still trying to register a worker. Harmless, because the call is
// already wrapped in a catch, but it was not doing the job it claimed.
//
// Now: search both halves, and fail the build loudly if neither matched, so the
// next time the shape changes it is a build error rather than a silent no-op.
const SW_CALL = /navigator\.serviceWorker\.register\([^)]*\)/g
const swHits = (head.match(SW_CALL)?.length ?? 0) + (body.match(SW_CALL)?.length ?? 0)
if (swHits === 0) {
  throw new Error('build-artifact: no serviceWorker.register call found -- the guard is stale, check src/main.ts')
}
const cleanBody = body.replace(SW_CALL, 'Promise.reject()').trim()

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
