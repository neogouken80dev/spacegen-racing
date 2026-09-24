/**
 * "DOES THE SHOCKFRONT ACTUALLY BEND THE PICTURE?"
 *
 * The scene already drew a dark sphere with a chromatic rim for an explosion.
 * It reads as a lens and it refracts nothing at all: geometry cannot sample
 * the pixels behind it. The composite can, because by the time it runs the
 * scene is a texture -- so the fronts are published in world space and bent in
 * screen space.
 *
 * That is a claim about pixels, so this checks pixels. The whole field is
 * frozen so the two frames differ by one thing, a front is held open in front
 * of the camera, and the two images are differenced RADIALLY around the blast
 * centre: a refraction moves pixels sideways in a ring at the front's edge,
 * which is a very specific signature and not something a flash or a light can
 * fake.
 *
 *   node tools/probe-blast.mjs
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { join, extname } from 'node:path'
// pngjs, not node-canvas. This probe was written against `canvas`, which is
// not a dependency of this repo (package.json has pngjs, and every other
// probe decodes with it), so it died on its first import and the blast lens
// had no pixel check at all. All it ever needed was the RGBA of a PNG.
import { PNG } from 'pngjs'

const ROOT = new URL('../dist/', import.meta.url).pathname
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
}
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0])
    if (p === '/' || p.endsWith('/')) p += 'index.html'
    const buf = await readFile(join(ROOT, p))
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' })
    res.end(buf)
  } catch { res.writeHead(404); res.end('nf') }
})
await new Promise((r) => server.listen(0, r))
const url = `http://127.0.0.1:${server.address().port}/`

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist'],
})
const page = await (await browser.newContext({
  viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1,
})).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(url, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(2200)
await page.evaluate(() => { if (window.__GAME__) window.__GAME__.maxSubSteps = 400 })

const clickText = async (pats) => {
  for (const p of pats) {
    const el = page.locator(`text=${p}`).first()
    if (await el.count() && await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 8000 }).catch(() => {}); return
    }
  }
}
await clickText(['PLAY NOW', 'PLAY'])
await page.waitForTimeout(1200)
await page.waitForSelector('.sg-screen--track .sg-card--track', { state: 'visible', timeout: 20000 })
await page.locator('.sg-screen--track .sg-btn--start').first().click()
await page.waitForSelector('.sg-screen--garage .sg-btn--start', { state: 'visible', timeout: 20000 })
await page.waitForTimeout(500)
await clickText(['START RACE', 'START'])
await page.waitForTimeout(3500)

// Freeze the whole field so two captures differ by the blast and nothing
// else -- installed while the grid is still counting down (see below), and
// holding the countdown clock too, so the start lights cannot change and no
// car ever launches into a neighbour.
await page.evaluate(() => {
  const g = window.__GAME__
  const race = g.race
  const snaps = race.state.racers.map((r) => ({
    pos: { ...r.pos }, vel: { ...r.vel }, fwd: { ...r.fwd }, up: { ...r.up },
    yaw: r.yaw, splineS: r.splineS, altitude: r.altitude,
  }))
  const phase = race.state.phase, countdown = race.state.countdown
  const orig = race.step.bind(race)
  race.step = function () {
    orig()
    race.state.phase = phase
    race.state.countdown = countdown
    race.state.racers.forEach((r, i) => {
      const s = snaps[i]
      Object.assign(r.pos, s.pos); Object.assign(r.vel, s.vel)
      Object.assign(r.fwd, s.fwd); Object.assign(r.up, s.up)
      r.yaw = s.yaw; r.yawRate = 0; r.splineS = s.splineS; r.altitude = s.altitude
      r.driftSide = 0; r.spinTime = 0; r.stunTime = 0; r.boostMag = 0
    })
  }
})

/**
 * PIN THE QUALITY TIER FIRST.
 *
 * Chromium under SwiftShader runs this at 4-5 fps, so the adaptive scaler --
 * correctly -- steps the game down to `low`, and `low` has no post-processing
 * chain at all. `g.post` is then null and there is nothing to measure. The
 * first version of this probe hit that only sometimes, because whether the
 * step-down had fired yet depended on how long the navigation took, which is
 * the worst kind of flake: a probe that reports different things about
 * identical code.
 */
await page.evaluate(() => {
  const g = window.__GAME__
  g.qualityCooldown = 1e9
  if (g.tier !== 'high') g.setTier('high')
})
await page.waitForTimeout(2500)
/**
 * NOTHING BUT THE CANVAS MAY CHANGE BETWEEN THE THREE FRAMES.
 *
 * They were taken during the start countdown with the HUD showing and the
 * countdown still running -- photographed, they read "1", "GO!" and "GO!"
 * with the gantry lights gone green -- so the digits and the start lights
 * changed under the lens between every pair, and that, not the front, was
 * what the columns measured: the probe PASSED on the countdown digits.
 * Waiting for the race instead is worse, because by then the grid has
 * launched and the freeze holds cars in contact, bumping every step. So the
 * DOM (digits, banners, position label) is hidden -- the composite is what
 * is under test and only the canvas draws it -- and the freeze above holds
 * the countdown clock where it is, lights and all.
 */
await page.addStyleTag({
  content: 'body * { visibility: hidden !important } canvas { visibility: visible !important }',
})
const hasPost = await page.evaluate(() => !!window.__GAME__.post)
if (!hasPost) {
  console.log('\nSKIPPED: no post-processing chain on this tier, nothing to measure.')
  await browser.close(); server.close(); process.exit(1)
}
await page.waitForTimeout(2000)
await mkdir(new URL('../shots/', import.meta.url).pathname, { recursive: true })

/**
 * Hold a front open. `strength` is re-applied every frame because the real one
 * decays in well under a second and a screenshot cannot be that well timed;
 * what is being measured is the look AT a given front, not its tail.
 */
async function shoot(name, on) {
  await page.evaluate((live) => {
    const g = window.__GAME__
    // Pushed in through the public setter, in the pass's own screen space, so
    // this measures the SHADER rather than the projection.
    //
    // APPENDED TO main.ts's OWN CALL, NOT RACED AGAINST IT. This used to set
    // the front from a 4 ms interval "because main.ts calls setBlasts every
    // frame and would otherwise overwrite this" -- but main.ts calls it
    // IMMEDIATELY before post.render, in the same task, so the interval
    // could never land between the two: the front was overwritten before
    // every single draw, and no frame this probe ever photographed had one
    // in it. Wrapping the setter puts it into the list main.ts hands over.
    if (!g.post.__probeSet) {
      const set = g.post.setBlasts.bind(g.post)
      g.post.__probeSet = set
      g.post.setBlasts = (list) => set(window.__PROBE_BLAST__ ? list.concat([window.__PROBE_BLAST__]) : list)
    }
    window.__PROBE_BLAST__ = live ? { x: 0.5, y: 0.5, radius: 0.18, strength: 1 } : null
  }, on)
  await page.waitForTimeout(1400)
  const path = new URL(`../shots/blast-${name}.png`, import.meta.url).pathname
  await page.screenshot({ path })
  return path
}

const off = await shoot('off', false)
// The SAME case again: the world keeps animating even with the cars frozen --
// particles, emissive strips, bloom settling -- so a difference smaller than
// the gap between these two is not a result.
const off2 = await shoot('off2', false)
const on = await shoot('on', true)
await page.evaluate(() => { window.__PROBE_BLAST__ = null })

async function pix(path) {
  const png = PNG.sync.read(await readFile(path))
  return { d: png.data, w: png.width, h: png.height }
}
const A = await pix(off)
const N = await pix(off2)
const B = await pix(on)

// Difference by radius from the blast centre, in bands. A refraction ring
// shows up as a spike in ONE band and nothing outside it.
const cx = A.w / 2, cy = A.h / 2
const R = 0.18 * A.w   // the radius that was pushed in, in pixels
const BANDS = 6
const sum = new Array(BANDS).fill(0), n = new Array(BANDS).fill(0)
const noise = new Array(BANDS).fill(0)
for (let y = 0; y < A.h; y += 2) {
  for (let x = 0; x < A.w; x += 2) {
    const i = (y * A.w + x) * 4
    const d3 = (P, Q) => Math.abs(P.d[i] - Q.d[i]) + Math.abs(P.d[i + 1] - Q.d[i + 1])
      + Math.abs(P.d[i + 2] - Q.d[i + 2])
    const t = Math.hypot(x - cx, y - cy) / R
    const k = t < 1 ? Math.min(BANDS - 2, Math.floor(t * (BANDS - 1))) : BANDS - 1
    // ADJACENT PAIRS: the front is judged off2 -> on and the noise off -> off2,
    // the same 1.4 s apart. Judging off -> on put twice the world's own drift
    // in the blast column as in the noise column, which reads as signal.
    sum[k] += d3(N, B); noise[k] += d3(A, N); n[k]++
  }
}
console.log('\n=== BLAST REFRACTION, MEASURED IN PIXELS =======================')
console.log('  Same frozen frame, one front pushed in at screen centre,')
console.log('  radius 0.18 of frame width. Mean |RGB| difference by band:\n')
const labels = ['0.00-0.20 (core)', '0.20-0.40', '0.40-0.60', '0.60-0.80',
  '0.80-1.00 (rim)', 'outside the front']
let peak = 0, peakBand = -1
console.log('  band                  blast   noise   signal')
for (let k = 0; k < BANDS; k++) {
  const v = sum[k] / Math.max(1, n[k])
  const nz = noise[k] / Math.max(1, n[k])
  const sig = v - nz
  if (k < BANDS - 1 && sig > peak) { peak = sig; peakBand = k }
  console.log(
    `  ${labels[k].padEnd(20)} ${v.toFixed(1).padStart(6)}  ${nz.toFixed(1).padStart(6)}`
    + `  ${sig.toFixed(1).padStart(7)}`,
  )
}
/**
 * THE VERDICT: LOCALITY ON THE RAW COLUMN, AND A SIGNAL ABOVE THE NOISE.
 *
 * The raw inside-vs-outside test states the claim directly -- a refraction
 * moves pixels only where the front is -- but on its own it cannot tell a
 * front from anything else that animates in the middle of the frame. With
 * the front never actually reaching a draw (see shoot()), it passed HEAD's
 * build on a signal of 0.4: the raw inside column was the gantry and the
 * grid animating, and the noise column said so. Now that the world is
 * frozen, DOM and countdown included, the noise column is small and the
 * noise-subtracted peak means what it says, so it has to clear a floor too.
 */
const rawIn = Math.max(
  sum[0] / Math.max(1, n[0]),
  sum[1] / Math.max(1, n[1]),
  sum[2] / Math.max(1, n[2]),
)
const outside = sum[BANDS - 1] / Math.max(1, n[BANDS - 1])
console.log(`\n  peak inside the front: band ${peakBand} at ${peak.toFixed(2)}`)
console.log(`  outside the front:     ${outside.toFixed(2)}`)
console.log(`  raw inside the front:  ${rawIn.toFixed(1)}`)
console.log(`  raw outside:           ${outside.toFixed(1)}`)
console.log('\n  NOTE: the displacement peaks at the half-radius by construction')
console.log('  (sin^2), but this metric is colour CHANGE, which is displacement')
console.log('  times local contrast -- and the middle of the frame holds the car')
console.log('  and the road markings. A flat profile here would be the surprise.')
const fail = []
if (rawIn < 8) fail.push(`the front barely changed the picture (${rawIn.toFixed(2)})`)
if (rawIn < outside * 3) {
  fail.push(`not local to the front: inside ${rawIn.toFixed(2)} vs outside `
    + `${outside.toFixed(2)} -- a refraction must not move the whole frame`)
}
if (peak < 4) {
  fail.push(`no band inside the front changed more than the frozen world does on its own `
    + `(best signal ${peak.toFixed(2)} in band ${peakBand}) -- the front is not in the picture`)
}
if (errors.length) fail.push(`${errors.length} page errors: ${errors[0]}`)
console.log(fail.length ? `\nFAILED:\n  ${fail.join('\n  ')}` : '\nBLAST REFRACTION PASSED')
await browser.close(); server.close()
process.exit(fail.length ? 1 : 0)
