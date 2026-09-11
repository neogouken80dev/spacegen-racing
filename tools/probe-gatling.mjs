/**
 * WHERE DO THE ROUNDS ACTUALLY GO?
 *
 * The Pulse Gatling was reported as "shooting into the ground directly in
 * front of the vehicle". That is a claim about pixels and about world
 * positions, and nothing in this repo was in a position to check either: the
 * weapon is AI-driven, so a smoke lap may never fire it, and when it does fire
 * the burst lasts three seconds somewhere off camera.
 *
 * So: hand the LOCAL racer the gatling, pull the trigger, freeze nothing, and
 * photograph the burst from the chase camera. Then read the sim directly and
 * report where every live round is RELATIVE TO THE ROAD SURFACE UNDER IT --
 * because "in the ground" is not a thing a screenshot can be trusted to show
 * at 4fps under SwiftShader, and it is exactly a thing an altitude can.
 *
 *   node tools/probe-gatling.mjs [--track=rustfall] [--shots]
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { join, extname } from 'node:path'

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1]
const TRACK = arg('track', 'rustfall')
const NAMES = { rustfall: 'Rustfall', cryostatic: 'Cryostatic', aetherion: 'Aetherion', hollowchoir: 'Hollow' }

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
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

await page.goto(url, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(2200)
await page.evaluate(() => { if (window.__GAME__) window.__GAME__.maxSubSteps = 400 })

const clickText = async (pats) => {
  for (const p of pats) {
    const el = page.locator(`text=${p}`).first()
    if (await el.count() && await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 8000 }).catch(() => {}); return true
    }
  }
  return false
}
await clickText(['PLAY NOW', 'PLAY'])
await page.waitForTimeout(1200)
await page.waitForSelector('.sg-screen--track .sg-card--track', { state: 'visible', timeout: 20000 })
const card = page.locator('.sg-screen--track .sg-card--track')
  .filter({ hasText: NAMES[TRACK] ?? 'Rustfall' }).first()
if (await card.count()) await card.click({ timeout: 8000 }).catch(() => {})
await page.waitForTimeout(1200)
await page.locator('.sg-screen--track .sg-btn--start').first().click()
await page.waitForSelector('.sg-screen--garage .sg-btn--start', { state: 'visible', timeout: 20000 })
await page.waitForTimeout(500)
await clickText(['START RACE', 'START'])
await page.waitForTimeout(4000)

/** Wait on SIM time. This renderer runs at 4-5 fps; a wall-clock wait here
 *  measures the machine, not the burst. */
const simNow = () => page.evaluate(() => window.__GAME__?.race?.state?.time ?? -1)
async function waitSim(sec, capMs = 90000) {
  const t0 = await simNow()
  const w0 = Date.now()
  for (;;) {
    const t = await simNow()
    if (t < 0 || t >= t0 + sec) return t
    if (Date.now() - w0 > capMs) return t
    await page.waitForTimeout(100)
  }
}

// Hand the local racer the weapon and hold the trigger down.
const armed = await page.evaluate(() => {
  const g = window.__GAME__
  const r = g.race?.state?.racers?.[g.localId ?? 0]
  if (!r) return null
  r.item = 'laserGatling'
  r.itemCharges = 1
  r.rouletteTime = 0
  r.gatlingTime = 3.0
  r.gatlingCooldown = 0
  return { id: r.id, item: r.item, gatlingTime: r.gatlingTime }
})
console.log('armed:', JSON.stringify(armed))
if (!armed) errors.push('could not reach the local racer')

const dir = new URL('../shots/', import.meta.url).pathname
await mkdir(dir, { recursive: true })

/**
 * ROUND ALTITUDE OVER THE ROAD UNDER IT.
 *
 * The whole report was "it fires into the deck", so this is the measurement
 * that settles it: for every live round, project onto the spline and compare
 * its height against the surface at that point. Negative is inside the road.
 */
const sample = async (label) => {
  const r = await page.evaluate(() => {
    const g = window.__GAME__
    const st = g.race?.state
    const track = g.track
    if (!st || !track) return null
    const out = []
    for (const p of st.projectiles) {
      if (!p.alive || p.kind !== 'bullet') continue
      const s = track.project(p.pos, p.splineS)
      const c = track.surfacePoint(s.s, s.lateral)
      const n = s.sample.normal ?? { x: 0, y: 1, z: 0 }
      const alt = (p.pos.x - c.x) * n.x + (p.pos.y - c.y) * n.y + (p.pos.z - c.z) * n.z
      out.push(+alt.toFixed(2))
    }
    return { n: out.length, alts: out }
  })
  console.log(`  ${label}: ${r ? `${r.n} rounds alive, altitudes [${r.alts.join(', ')}]` : 'no state'}`)
  return r
}

let worst = Infinity
let seen = 0
for (let i = 0; i < 6; i++) {
  await waitSim(0.25)
  const r = await sample(`t+${(i * 0.25).toFixed(2)}s`)
  if (r) {
    seen += r.n
    for (const a of r.alts) worst = Math.min(worst, a)
  }
  if (i === 1 || i === 3) {
    await page.screenshot({ path: `${dir}gatling-${TRACK}-${i}.png` })
  }
  // Keep the trigger held for the whole burst.
  await page.evaluate(() => {
    const g = window.__GAME__
    const r = g.race?.state?.racers?.[g.localId ?? 0]
    if (r && r.gatlingTime < 0.4) r.gatlingTime = 2.0
  })
}

console.log(`\nrounds observed: ${seen}   lowest altitude over the road: ${worst === Infinity ? 'n/a' : worst.toFixed(2)}m`)
if (seen === 0) errors.push('the gatling fired nothing at all')
// PROJ_RIDE is 1.2, so a round riding the surface correctly sits near there.
// Anything at or below zero is inside the deck, which is the reported bug.
else if (worst <= 0.2) errors.push(`a round was ${worst.toFixed(2)}m over the road -- in the deck`)

console.log(`errors: ${errors.length}`, errors.slice(0, 4))
await browser.close()
server.close()
process.exit(errors.length ? 1 : 0)
