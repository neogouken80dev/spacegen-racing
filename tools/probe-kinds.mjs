/**
 * EVERY PARTICLE KIND ACTUALLY REACHES A PIXEL.
 *
 * WHY THIS EXISTS. K_SPARK drew nothing at all, for the entire life of the
 * particle shader, on every machine. The spark branch lays its quad out with
 * position.x along `pp` and position.y along `dir`, and `pp` was the wrong
 * one of the two perpendiculars, so the 2x2 had determinant -1, every spark
 * quad wound backwards, and a FrontSide material threw all of them away
 * before rasterisation. Every drift spark, boost spark, wall-impact spark and
 * weapon-hit spark in the game was invisible.
 *
 * Nothing caught it for one reason: every spark gate in this repo counts
 * SPAWNS. probe-driftfx and probe-sparks both ask "did the emitter run",
 * which it always did -- the particles existed, were uploaded, were animated,
 * and were discarded by the rasteriser one stage before anybody was looking.
 * A screenshot would have caught it, and eleven hundred screenshots were
 * taken without anybody noticing a spray of sparks was missing, because you
 * cannot see the absence of a thing you have never seen present.
 *
 * So this probe counts PHOTONS. It renders one burst per kind -- identical in
 * every argument but `kind` -- and reads the framebuffer back. It knows
 * nothing about what a spark should look like. It knows only that sixty
 * particles that light zero pixels are not being drawn, which is the exact
 * failure that hid for this long and the one a spawn counter can never see.
 *
 * Runs against SOURCE through a Vite dev server, not against dist/, because
 * the thing under test is one shader in one module and the app bundle does
 * not expose the pool.
 *
 * AND IT CHECKS THE SHAPE, because photons alone missed the next one. Every
 * smoke puff in the game rendered as a rotated SQUARE: the profile was still
 * at 13.5% of its peak on the edge of the quad and additive blending drew the
 * tile. That lights MORE pixels, not fewer, so the floor above waved it
 * through for as long as the kind existed. The second pass photographs one
 * axis-aligned particle per kind and fails any whose lit pixels fill more
 * than 85% of their bounding box (a disc is 78.5%, a square 100%).
 *
 *   node tools/probe-kinds.mjs [--shots]   (--shots writes shots/kinds/*.png)
 */
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'

/** A kind that lights fewer pixels than this is not drawing. Sixty particles
 *  at a metre a side, thirty metres out, cover something like two thousand;
 *  200 is a floor low enough that no amount of legitimate retuning trips it
 *  and high enough that a culled or degenerate quad cannot pass. */
const FLOOR = 200

const vite = await createServer({
  root: new URL('..', import.meta.url).pathname,
  server: { port: 0, strictPort: false },
  logLevel: 'error',
})
await vite.listen()
const port = vite.httpServer.address().port

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage({ viewport: { width: 700, height: 540 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))

await page.goto(`http://127.0.0.1:${port}/tools/kinds.html`, { waitUntil: 'load' })
await page.waitForFunction(() => window.__KINDS__, null, { timeout: 180000 })
const rows = await page.evaluate(() => window.__KINDS__)
const shape = await page.evaluate(() => window.__SHAPE__)

let bad = 0
console.log('one identical 60-particle burst per kind, 30 m from the lens\n')
for (const r of rows) {
  const ok = r.lit >= FLOOR
  if (!ok) bad++
  console.log(
    `  ${r.name.padEnd(11)} kind ${r.kind}` +
    ` | lit ${String(r.lit).padStart(6)} px` +
    ` | mean ${String(r.mean).padStart(6)}` +
    ` | bbox ${r.box.join('x').padStart(7)}` +
    ` | ${r.view.padEnd(4)}` +
    `  ${ok ? 'draws' : 'DRAWS NOTHING'}`,
  )
}
/**
 * THE SHAPE GATE: a round particle must light a round patch.
 *
 * `fill` is lit pixels over their own bounding box, for ONE axis-aligned
 * particle per kind (see the shape pass in tools/kinds.js). A disc fills pi/4
 * = 0.785 of its box and an annulus less; the quad it is drawn on fills 1.0.
 * Every smoke puff in the game drew its quad -- 13.5% of peak was still left
 * on the edge -- and a spawn counter, a burst of sixty, and a lit-pixel floor
 * all passed it, because none of them can see a CORNER.
 */
const FILL_MAX = 0.85
let square = 0
console.log('\none axis-aligned particle per kind, HDR-bright, ~140 px across\n')
for (const r of shape ?? []) {
  const over = r.judged && r.fill > FILL_MAX
  if (over) square++
  console.log(
    `  ${r.name.padEnd(11)} kind ${r.kind}` +
    ` | lit ${String(r.lit).padStart(6)} px` +
    ` | bbox ${r.box.join('x').padStart(7)}` +
    ` | fill ${r.fill.toFixed(3)}` +
    `  ${!r.judged ? 'not judged (a column)' : over ? 'DRAWS ITS QUAD' : 'disc'}`,
  )
}
if (!shape || shape.length === 0) { console.log('  no shape rows came back'); bad++ }
bad += square
if (process.argv.includes('--shots') && shape) {
  const dir = new URL('../shots/kinds/', import.meta.url).pathname
  mkdirSync(dir, { recursive: true })
  for (const r of shape) {
    writeFileSync(`${dir}${r.kind}-${r.name}.png`, Buffer.from(r.png.split(',')[1], 'base64'))
  }
  console.log(`\n  shape photographs -> shots/kinds/`)
}

for (const e of errors) { console.log(`  page error: ${e}`); bad++ }

await browser.close()
await vite.close()

console.log(bad === 0
  ? '\nKIND PROBE: clean'
  : `\nKIND PROBE: ${bad} failure(s) -- a kind below the ${FLOOR}px floor, or filling more than ${FILL_MAX} of its box`)
process.exit(bad === 0 ? 0 : 1)
