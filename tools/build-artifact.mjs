/**
 * Convert the single-file Vite build into the shape the Claude Artifact host
 * expects: no doctype/html/head/body wrapper (the host supplies a skeleton),
 * no references to external files (the host blocks them).
 */
import { readFile, writeFile, stat } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'

/**
 * THIS SCRIPT ONLY RESHAPES. IT DOES NOT BUILD.
 *
 * Its input is `dist-single/index.html`, which comes from a SEPARATE vite
 * config (`vite.single.config.ts`) that `npm run build` does not run. That is
 * a trap, and it has already been walked into: a full `vite build`, a green
 * test suite and a clean smoke run all pass while `dist-single/` still holds
 * whatever was there weeks ago -- and this script cheerfully reshapes it and
 * hands back an artifact of the OLD GAME, at almost exactly the same file size.
 * It was published before anyone noticed.
 *
 * So: refuse to run on an input older than the newest source file. The fix is
 * always the same one line, and it is in the error.
 */
const SRC = 'dist-single/index.html'
async function newestSource(dir, acc = { t: 0, f: '' }) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = `${dir}/${e.name}`
    if (e.isDirectory()) await newestSource(p, acc)
    else {
      const m = (await stat(p)).mtimeMs
      if (m > acc.t) { acc.t = m; acc.f = p }
    }
  }
  return acc
}
{
  let built = 0
  try { built = (await stat(SRC)).mtimeMs } catch {
    throw new Error(`${SRC} does not exist.\n  Run: npx vite build --config vite.single.config.ts`)
  }
  const newest = await newestSource('src')
  if (newest.t > built) {
    const age = ((newest.t - built) / 60000).toFixed(0)
    throw new Error(
      `${SRC} is STALE -- ${newest.f} is ${age} minutes newer.\n`
      + '  This script only reshapes; it does not build. Run:\n'
      + '    npx vite build --config vite.single.config.ts',
    )
  }
}

const src = await readFile(SRC, 'utf8')
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
