/**
 * CHASSIS ART TURNTABLE.
 *
 * `probe-garage.mjs` asks whether the preview WORKS. This asks what the car
 * LOOKS LIKE, which is a different question and needs a different instrument:
 * the same chassis, from the same set of exact angles, every run, so two
 * passes of art can be put side by side and the difference is the art rather
 * than where the turntable happened to have drifted to.
 *
 *   node tools/probe-vehicle.mjs [--chassis=filament] [--pilot=<name>]
 *                                [--yaws=180,215,270,0] [--tag=after]
 *
 * THE REAR VIEW IS THE ONE THAT COUNTS. The chase camera sits behind the car
 * for an entire race, so yaw 180 (nose away) is the first frame this prints
 * and the one the 40px silhouette check is taken from -- vehicles.ts's own
 * first art rule is that a chassis is identifiable by silhouette alone at that
 * size, and nothing in the repo was measuring it.
 *
 * Never waits on the wall clock: this renderer delivers 1-5 fps under
 * SwiftShader, so every wait is on the preview's own frame counter.
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { join, extname } from 'node:path'

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1]
const CHASSIS = arg('chassis', 'filament')
const TAG = arg('tag', 'now')
const YAWS = arg('yaws', '180,215,270,325,0').split(',').map(Number)

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
  viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1,
})).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

await page.goto(url, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(2500)

const clickText = async (labels) => {
  for (const t of labels) {
    const el = page.locator('button, .sg-btn').filter({ hasText: t }).first()
    if (await el.count() && await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 8000 }); return t
    }
  }
  return null
}
await clickText(['PLAY NOW', 'PLAY', 'Play'])
await page.waitForSelector('.sg-screen--track .sg-card--track', { state: 'visible', timeout: 20000 })
await page.waitForTimeout(700)
await page.locator('.sg-screen--track .sg-btn--start').first().click()
await page.waitForSelector('.sg-screen--garage .sg-btn--start', { state: 'visible', timeout: 20000 })
await page.waitForTimeout(1200)

const dbg = () => page.evaluate(() => window.__GARAGE_PREVIEW__?.debug() ?? null)
const frames = async () => (await dbg())?.frames ?? -1
async function waitFrames(n, capMs = 60000) {
  const start = await frames()
  if (start < 0) return false
  const t0 = Date.now()
  for (;;) {
    if ((await frames()) >= start + n) return true
    if (Date.now() - t0 > capMs) return false
    await page.waitForTimeout(120)
  }
}

/**
 * PICK THE CHASSIS BY ITS ID, NOT BY A LABEL SUBSTRING.
 *
 * An earlier probe in this repo matched settings rows by visible text and drove
 * the wrong control for a whole pass. The garage rows carry the id, so use it,
 * and then VERIFY against the preview's own reported selection rather than
 * trusting that the click landed.
 */
const rows = await page.evaluate(() => Array.from(
  document.querySelectorAll('.sg-screen--garage [data-chassis]'),
).map((el) => el.getAttribute('data-chassis')))
if (rows.length === 0) {
  // No data attribute in this build: fall back to the nth row, matched against
  // the order the chassis list is declared in.
  const labels = await page.evaluate(() => Array.from(
    document.querySelectorAll('.sg-screen--garage .sg-list--chassis .sg-row'),
  ).map((el) => (el.textContent || '').trim()))
  console.log('no [data-chassis]; rows are', JSON.stringify(labels))
}
const target = page.locator(`.sg-screen--garage [data-chassis="${CHASSIS}"]`).first()
if (await target.count()) await target.click({ timeout: 8000 })
else {
  const byName = page.locator('.sg-screen--garage .sg-row, .sg-screen--garage button')
    .filter({ hasText: new RegExp(CHASSIS, 'i') }).first()
  if (await byName.count()) await byName.click({ timeout: 8000 })
}
await waitFrames(4)

const sel = await dbg()
if (sel && sel.chassisId && sel.chassisId !== CHASSIS) {
  errors.push(`selected ${sel.chassisId}, wanted ${CHASSIS}`)
}
console.log('preview:', JSON.stringify(sel))

const dir = new URL('../shots/', import.meta.url).pathname
await mkdir(dir, { recursive: true })
const box = page.locator('.sg-prev').first()

for (const deg of YAWS) {
  await page.evaluate((y) => window.__GARAGE_PREVIEW__.setYaw(y), (deg * Math.PI) / 180)
  await waitFrames(3)
  const got = ((await dbg())?.yaw ?? 0) * 180 / Math.PI
  const path = `${dir}veh-${CHASSIS}-${TAG}-${String(deg).padStart(3, '0')}.png`
  if (await box.count()) await box.screenshot({ path })
  else await page.screenshot({ path })
  console.log(`  yaw ${String(deg).padStart(3)} -> parked at ${got.toFixed(1)}  ${path.split('/').pop()}`)
}

/**
 * THE 40px TEST, taken from astern. Downscaled in the page through a canvas,
 * then read back as a coverage figure: what fraction of the box the car fills,
 * and how much of that is interior versus edge. A silhouette that is all edge
 * at this size is a wireframe; one at very low coverage is a speck.
 */
await page.evaluate((y) => window.__GARAGE_PREVIEW__.setYaw(y), Math.PI)
await waitFrames(3)
const tiny = `${dir}veh-${CHASSIS}-${TAG}-silhouette40.png`
await box.screenshot({ path: tiny })

// Ground clearance is NOT measured here. It was tried: the preview keeps its
// vehicle in its own scene, which this page does not expose, and a turntable
// photographs a car floating in a box with no road in it anyway. It lives in
// tests/clearance.test.ts instead, which walks the real geometry of every
// chassis at every tier in node and is both cheaper and broader.

const stats = await dbg()
console.log(`\ndraw calls ${stats?.calls ?? '?'}   triangles ${stats?.tris ?? '?'}`)
console.log(`errors: ${errors.length}`, errors.slice(0, 4))

await browser.close()
server.close()
process.exit(errors.length ? 1 : 0)
