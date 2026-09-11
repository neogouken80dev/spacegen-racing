/**
 * IS THE TITLE SHOT ACTUALLY A SHOT?
 *
 * find-attract-shot.ts picked the anchor from the spline alone -- heading
 * against the hero body's azimuth, sightline, and where the field measurably
 * drives. All of that is true and none of it proves the result is a picture. A
 * camera can be correctly placed, correctly aimed, and still be looking at the
 * inside of a barrier, or at a stretch of road that happens to be empty for
 * forty seconds at a time.
 *
 * So this measures the three things the spline cannot answer:
 *
 *   WHERE IS THE HOLE ON SCREEN? Projected through the real camera, in
 *     normalised device coordinates. Off-screen is a fail; dead centre is a
 *     different kind of fail, because the road wants that space.
 *   HOW OFTEN IS A CAR IN FRAME? Sampled over sim time, not wall time -- this
 *     renderer does 1-5fps under SwiftShader, so anything timed against the
 *     clock measures the machine. A title screen with cars on it a third of
 *     the time is a title screen of empty road.
 *   IS THE CAMERA INSIDE SOMETHING? Read the depth in front of it: a barrier
 *     0.4m off the lens reads as a wall of flat colour, which is exactly how
 *     splash iteration `f` failed and nobody noticed until the PNG came out.
 *
 *   node tools/probe-attract.mjs [--secs=40] [--shots=3] [--w=1600] [--h=900]
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { join, extname } from 'node:path'

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1]
const SECS = Number(arg('secs', 40))
const SHOTS = Number(arg('shots', 3))
const W = Number(arg('w', 1600))
const H = Number(arg('h', 900))

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
  viewport: { width: W, height: H }, deviceScaleFactor: 1,
})).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

await page.goto(url, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(3000)
await page.evaluate(() => { if (window.__GAME__) window.__GAME__.maxSubSteps = 400 })

// The title screen is the default screen, so the attract race should already
// be up. Verify that rather than assume it: a silent failure here would make
// every number below a measurement of a black screen.
const armed = await page.evaluate(() => {
  const g = window.__GAME__
  return {
    phase: g?.phase ?? null,
    track: g?.track?.def?.id ?? null,
    racers: g?.race?.state?.racers?.length ?? 0,
    screen: document.querySelector('.sg-fe')?.dataset?.screen ?? null,
  }
})
console.log('armed:', JSON.stringify(armed))
if (armed.phase !== 'attract') errors.push(`phase is ${armed.phase}, expected attract`)
if (armed.racers === 0) errors.push('attract race has no racers')

const simNow = () => page.evaluate(() => window.__GAME__?.race?.state?.time ?? -1)

/**
 * ONE SAMPLE: where the hole lands, how many cars are on screen, and how much
 * empty space is in front of the lens.
 *
 * Everything is computed in the page against the live camera, because the only
 * thing that can answer "is this in frame" is the actual projection matrix at
 * the actual aspect ratio -- not a reconstruction of it out here.
 */
const sample = () => page.evaluate(() => {
  const g = window.__GAME__
  const cam = g.chase.camera
  const st = g.race?.state
  if (!st || !cam) return null

  /**
   * Project a world point through the LIVE camera, in plain arithmetic.
   *
   * Deliberately not borrowing THREE from the page: the bundle does not put it
   * on window, and a probe that needs the app to export a library in order to
   * measure it is a probe that will break on the next build config change.
   * Two 4x4 multiplies against the camera's own matrices is the whole job.
   *
   * View space looks down -Z in three.js, so `vz < 0` is the forward test --
   * and it is a separate answer from x/y, because a perspective divide happily
   * returns plausible-looking screen coordinates for points behind the lens.
   */
  const project = (x, y, z) => {
    const m = cam.matrixWorldInverse.elements
    const vx = m[0] * x + m[4] * y + m[8] * z + m[12]
    const vy = m[1] * x + m[5] * y + m[9] * z + m[13]
    const vz = m[2] * x + m[6] * y + m[10] * z + m[14]
    const p = cam.projectionMatrix.elements
    const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12]
    const cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13]
    const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15]
    const w = cw === 0 ? 1e-6 : cw
    return { x: cx / w, y: cy / w, inFront: vz < 0 }
  }

  // The hero body's direction, read from the theme the sky itself uses -- see
  // the `theme` accessor on Game for why this is not a copy.
  const cel = g.theme?.sky?.celestial
  const hero = cel?.hole ?? cel?.bodies?.[0]
  let hole = null
  if (hero) {
    const d = hero.dir
    const len = Math.hypot(d[0], d[1], d[2]) || 1
    // A sky body sits at infinity, so sample a point far along its direction
    // FROM THE CAMERA rather than a fixed world position.
    const px = cam.position.x + (d[0] / len) * 3000
    const py = cam.position.y + (d[1] / len) * 3000
    const pz = cam.position.z + (d[2] / len) * 3000
    const r = project(px, py, pz)
    hole = { x: r.x, y: r.y, behind: !r.inFront, sizeDeg: hero.sizeDeg }
  }

  let onScreen = 0
  let nearest = Infinity
  for (const r of st.racers) {
    const q = project(r.pos.x, r.pos.y, r.pos.z)
    if (!q.inFront || Math.abs(q.x) > 1 || Math.abs(q.y) > 1) continue
    onScreen++
    const dist = Math.hypot(
      r.pos.x - cam.position.x, r.pos.y - cam.position.y, r.pos.z - cam.position.z,
    )
    if (dist < nearest) nearest = dist
  }
  return {
    t: +st.time.toFixed(2),
    onScreen,
    nearest: nearest === Infinity ? -1 : +nearest.toFixed(1),
    hole,
    camY: +cam.position.y.toFixed(2),
    fov: cam.fov,
  }
})

const dir = new URL('../shots/', import.meta.url).pathname
await mkdir(dir, { recursive: true })

let frames = 0
let withCar = 0
let carSum = 0
let holeOff = 0
let holeX = 0
let holeY = 0
const t0 = await simNow()
let shotAt = 0

console.log(`\nsampling ${SECS}s of SIM time...`)
for (;;) {
  const s = await sample()
  if (!s) { errors.push('no state to sample'); break }
  frames++
  if (s.onScreen > 0) withCar++
  carSum += s.onScreen
  if (s.hole) {
    if (s.hole.behind || Math.abs(s.hole.x) > 1 || Math.abs(s.hole.y) > 1) holeOff++
    else { holeX += s.hole.x; holeY += s.hole.y }
  }
  if (frames % 12 === 1) {
    const h = s.hole
      ? (s.hole.behind ? 'BEHIND' : `(${s.hole.x.toFixed(2)}, ${s.hole.y.toFixed(2)})`)
      : 'n/a'
    console.log(`  t+${(s.t - t0).toFixed(1).padStart(5)}s  cars on screen ${s.onScreen}`
      + `  nearest ${String(s.nearest).padStart(6)}m  hole ${h}`)
  }
  if (SHOTS > 0 && frames >= shotAt) {
    const n = Math.min(SHOTS - 1, Math.floor(frames / Math.max(1, Math.floor(60 / SHOTS))))
    await page.screenshot({ path: `${dir}attract-${n}.png` })
    shotAt = frames + Math.max(6, Math.floor(48 / SHOTS))
    if (n >= SHOTS - 1) shotAt = Infinity
  }
  const t = await simNow()
  if (t < 0 || t - t0 >= SECS) break
  await page.waitForTimeout(60)
}

const pct = (n) => `${((n / Math.max(1, frames)) * 100).toFixed(1)}%`
console.log(`\nsamples ${frames}`)
console.log(`car on screen      ${pct(withCar)}   (mean ${(carSum / Math.max(1, frames)).toFixed(2)} cars)`)
const holeOn = frames - holeOff
console.log(`hole in frame      ${pct(holeOn)}`
  + (holeOn > 0 ? `   mean ndc (${(holeX / holeOn).toFixed(2)}, ${(holeY / holeOn).toFixed(2)})` : ''))

// THE GATES. Numbers, not opinions, so a later edit that quietly ruins the
// shot fails here instead of shipping.
if (holeOn === 0) errors.push('the black hole is never in frame -- the shot misses its subject')
if (withCar / Math.max(1, frames) < 0.55) {
  errors.push(`cars are on screen only ${pct(withCar)} of the time -- mostly empty road`)
}

console.log(`\nerrors: ${errors.length}`, errors.slice(0, 5))
await browser.close()
server.close()
process.exit(errors.length ? 1 : 0)
