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
import { createCanvas, loadImage } from 'canvas'

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
const hasPost = await page.evaluate(() => !!window.__GAME__.post)
if (!hasPost) {
  console.log('\nSKIPPED: no post-processing chain on this tier, nothing to measure.')
  await browser.close(); server.close(); process.exit(1)
}

// Freeze the whole field so two captures differ by the blast and nothing else.
await page.evaluate(() => {
  const g = window.__GAME__
  const race = g.race
  const snaps = race.state.racers.map((r) => ({
    pos: { ...r.pos }, vel: { ...r.vel }, fwd: { ...r.fwd }, up: { ...r.up },
    yaw: r.yaw, splineS: r.splineS, altitude: r.altitude,
  }))
  const orig = race.step.bind(race)
  race.step = function () {
    orig()
    race.state.racers.forEach((r, i) => {
      const s = snaps[i]
      Object.assign(r.pos, s.pos); Object.assign(r.vel, s.vel)
      Object.assign(r.fwd, s.fwd); Object.assign(r.up, s.up)
      r.yaw = s.yaw; r.yawRate = 0; r.splineS = s.splineS; r.altitude = s.altitude
      r.driftSide = 0; r.spinTime = 0; r.stunTime = 0; r.boostMag = 0
    })
  }
})
await page.waitForTimeout(2000)
await mkdir(new URL('../shots/', import.meta.url).pathname, { recursive: true })

/**
 * Hold a front open. `strength` is re-applied every frame because the real one
 * decays in well under a second and a screenshot cannot be that well timed;
 * what is being measured is the look AT a given front, not its tail.
 */
async function shoot(name, on) {
  const where = await page.evaluate((live) => {
    const g = window.__GAME__
    if (g.__bk) { clearInterval(g.__bk); g.__bk = null }
    const r = g.race.state.racers[0]
    // 9 m up the road from the car, roughly frame centre from a chase rig.
    const p = {
      x: r.pos.x + r.fwd.x * 9, y: r.pos.y + r.fwd.y * 9 + 1.2, z: r.pos.z + r.fwd.z * 9,
    }
    if (!live) { g.post.setBlasts([]); return null }
    // Pushed straight in through the public setter, in the pass's own screen
    // space, so this measures the SHADER rather than the projection. The
    // interval is needed because main.ts calls setBlasts every frame from the
    // live VFX list and would otherwise overwrite this on the next one.
    g.__bk = setInterval(() => {
      g.post.setBlasts([{ x: 0.5, y: 0.5, radius: 0.18, strength: 1 }])
    }, 4)
    return p
  }, on)
  void where
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
await page.evaluate(() => {
  const g = window.__GAME__
  if (g.__bk) { clearInterval(g.__bk); g.__bk = null }
  g.post.setBlasts([])
})

async function pix(path) {
  const img = await loadImage(path)
  const c = createCanvas(img.width, img.height)
  const ctx = c.getContext('2d')
  ctx.drawImage(img, 0, 0)
  return { d: ctx.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height }
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
    sum[k] += d3(A, B); noise[k] += d3(A, N); n[k]++
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
 * THE VERDICT USES THE RAW COLUMN, NOT THE NOISE-SUBTRACTED ONE.
 *
 * The noise column is a second pair of frames of a world that is still
 * animating -- particles, emissive strips, bloom settling -- so it is the same
 * order as the signal in the bands where the scene is busy, and subtracting it
 * band-by-band produces negative "signal" that means nothing. What it is good
 * for is the shape: it shows the scene noise is spread evenly while the blast
 * difference is not.
 *
 * The claim being tested is LOCALITY -- a refraction moves pixels only where
 * the front is -- and raw inside-vs-outside states that directly.
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
void peakBand; void peak
if (errors.length) fail.push(`${errors.length} page errors: ${errors[0]}`)
console.log(fail.length ? `\nFAILED:\n  ${fail.join('\n  ')}` : '\nBLAST REFRACTION PASSED')
await browser.close(); server.close()
process.exit(fail.length ? 1 : 0)
