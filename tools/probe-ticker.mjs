/**
 * "WHERE IS THE DRIFT TICKER, AND WHAT IS IT SITTING ON?"
 *
 * The report: the drift scoring block covers the horizon. The horizon is the
 * thing a driver steers by, so this is a placement bug with a measurable
 * failure condition rather than a matter of taste -- and the fix has a
 * measurable failure condition of its own, because the band the block would
 * move INTO is already occupied on every viewport:
 *
 *   .sg-hud__pos     position + lap, top left (top strip on a phone)
 *   .sg-hud__items   item slots
 *   .sg-tools        brightness + pause, centred on the VIEWPORT
 *   .sg-hud__wind    the crosswind strip, directly under the tools
 *   .sg-hud__map     minimap + clock, top right
 *   .sg-total        the running score, right column
 *
 * So this reports two numbers per viewport and both have to be right:
 *
 *   clearance   the gap, in fractions of viewport height, between the BOTTOM
 *               of the moment block and the horizon row. Positive means the
 *               horizon is below the block, i.e. visible.
 *   overlap     intersection area with each widget above, in px^2. Anything
 *               non-zero is the bug this move would introduce.
 *
 * THE HORIZON ROW IS PROJECTED, NOT GUESSED: the direction level with the
 * camera and infinitely far away is the horizon by definition, and on a banked
 * or climbing circuit no fixed fraction of the frame is.
 *
 * THE DRIFT IS REAL. The block only exists while something is worth points, so
 * the probe pins a held tier-3 slide onto the local racer inside the sim's own
 * step -- the same rail tools/smoke.mjs --drift uses -- and lets the shipping
 * Scorer and ScoreHud do the rest. Setting `data-on` by hand would measure a
 * box with no number in it, and the number is most of the height.
 *
 *   node tools/probe-ticker.mjs [--track=halcyon] [--shots]
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { join, extname } from 'node:path'

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

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const SHOTS = process.argv.includes('--shots')
const TRACK = arg('track', 'halcyon')
const TAG = arg('tag', 'now')
const NAMES = {
  rustfall: 'Elkarim', cryostatic: 'Frosthelm', aetherion: 'Namaresh',
  hollowchoir: 'Centurion Prime', emberfall: 'Ashkar', abyssal: 'Meridian Deep',
  halcyon: 'Halcyon Bay', neonspire: 'Zhen-9',
}

/** The three layouts the HUD actually has to survive. */
const VIEWPORTS = [
  { name: 'desktop  ', width: 1440, height: 810, mobile: false },
  { name: 'phone-port', width: 412, height: 915, mobile: true },
  { name: 'phone-land', width: 915, height: 412, mobile: true },
]

/** Everything already living in the top band, plus the block being moved. */
const WIDGETS = [
  '.sg-moment', '.sg-score', '.sg-cheer', '.sg-hud__pos', '.sg-hud__items',
  '.sg-tools', '.sg-hud__wind', '.sg-hud__map', '.sg-total', '.sg-hud__gauge',
]

const OUT = 'shots/ticker'
if (SHOTS) await mkdir(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist'],
})

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    hasTouch: vp.mobile, isMobile: vp.mobile, deviceScaleFactor: 1,
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(url, { waitUntil: 'load', timeout: 60000 })
  await page.waitForTimeout(2000)
  await page.evaluate(() => { if (window.__GAME__) window.__GAME__.maxSubSteps = 400 })

  const clickText = async (labels) => {
    for (const t of labels) {
      const el = page.locator('button, .sg-btn').filter({ hasText: t }).first()
      if (await el.count() && await el.isVisible().catch(() => false)) { await el.click(); return }
    }
  }
  await clickText(['PLAY NOW', 'PLAY', 'Play'])
  await page.waitForSelector('.sg-screen--track .sg-card--track', { state: 'visible', timeout: 30000 })
  await page.locator('.sg-screen--track .sg-card--track').filter({ hasText: NAMES[TRACK] ?? TRACK }).first().click()
  await page.waitForTimeout(1200)
  await page.locator('.sg-screen--track .sg-btn--start').click()
  await page.waitForSelector('.sg-screen--garage .sg-btn--start', { state: 'visible', timeout: 30000 })
  await page.locator('.sg-screen--garage .sg-btn--start').click()
  await page.waitForTimeout(4000)

  /**
   * PIN A HELD TIER-3 SLIDE inside the sim's own step, so the shipping Scorer
   * pays it and the shipping ScoreHud turns itself on with a real event name
   * and a real six-figure number in it.
   */
  await page.evaluate(() => {
    const g = window.__GAME__
    const st = g.race.state
    st.countdown = 0
    st.phase = 'racing'
    const orig = g.race.step.bind(g.race)
    g.race.step = function () {
      orig()
      const r = st.racers.find((x) => x.isLocal) ?? st.racers[0]
      const tt = (window.__TUNING__ && window.__TUNING__.drift.tierTimes) || [0.7, 1.5, 2.4, 3.2]
      r.driftSide = 1
      r.driftTier = 3
      r.driftCharge = tt[3] + 1.2
      r.driftInward = 0.9
      r.driftTime = 2.0
      r.grounded = true; r.altitude = 0; r.airTime = 0
      r.offTrackTime = 0; r.respawnTime = 0; r.spinTime = 0; r.stunTime = 0
    }
  })
  // Sim time, not wall clock: the panel needs a few seconds of paid drift
  // before the counter has anything to show, and this renderer delivers about
  // one frame a second.
  const waitSim = async (seconds, capMs = 90000) => {
    const now = () => page.evaluate(() => window.__GAME__?.race?.state?.time ?? 0)
    const start = await now()
    const t0 = Date.now()
    while (Date.now() - t0 < capMs) {
      if ((await now()) - start >= seconds) return
      await page.waitForTimeout(150)
    }
  }
  await waitSim(4)

  const out = await page.evaluate((sels) => {
    const g = window.__GAME__
    // THE CROSSWIND STRIP HAS TO BE IN THE REPORT EVEN WHERE THERE IS NO WIND.
    // It is `hidden = true` until a track has crosswind, so on Halcyon (no
    // authored wind at all) it measures 0x0 -- and it is the one widget the
    // block is being moved TOWARD. Un-hide it for the read and put it back, so
    // the floor is argued from where it WOULD be rather than from its absence.
    const wind = document.querySelector('.sg-hud__wind')
    const windWasHidden = wind ? wind.hidden : false
    if (wind) wind.hidden = false
    const cam = g.chase.camera
    const m = cam.matrixWorld.elements
    const fx = -m[8], fz = -m[10]
    const L = Math.hypot(fx, fz) || 1
    const v = cam.position.clone()
    v.x += (fx / L) * 1e6
    v.z += (fz / L) * 1e6
    v.project(cam)
    const H = window.innerHeight
    const rects = {}
    for (const s of sels) {
      const el = document.querySelector(s)
      if (!el) { rects[s] = null; continue }
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      rects[s] = {
        x: r.x, y: r.y, w: r.width, h: r.height,
        shown: cs.visibility !== 'hidden' && cs.display !== 'none' && !el.hidden
          && parseFloat(cs.opacity || '1') > 0.02,
        on: el.dataset ? el.dataset.on : undefined,
      }
    }
    if (wind) wind.hidden = windWasHidden
    return {
      horizonY: ((1 - v.y) / 2) * H,
      W: window.innerWidth, H,
      // The class goes on <html>, not on .sg-hud -- compact.ts toggles
      // `document.documentElement`. Asking the wrong element reported
      // compact=false on a 915x412 phone, which is the layout this whole probe
      // exists to check.
      compact: document.documentElement.classList.contains('sg-compact'),
      rects,
    }
  }, WIDGETS)

  if (SHOTS) {
    await page.screenshot({ path: join(OUT, `${TAG}-${vp.name.trim()}.png`) })
  }

  const M = out.rects['.sg-moment']
  const inter = (a, b) => {
    if (!a || !b || !a.shown || !b.shown) return 0
    const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
    const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
    return Math.round(w * h)
  }
  console.log(`\n=== ${vp.name} ${out.W}x${out.H} compact=${out.compact} track=${TRACK} ===`)
  console.log(`    horizon row ${out.horizonY.toFixed(0)} (${(out.horizonY / out.H * 100).toFixed(1)}% of height)`)
  for (const s of WIDGETS) {
    const r = out.rects[s]
    if (!r) { console.log(`    ${s.padEnd(16)} absent`); continue }
    console.log(`    ${s.padEnd(16)} y ${(r.y / out.H).toFixed(3)}-${((r.y + r.h) / out.H).toFixed(3)}  `
      + `x ${(r.x / out.W).toFixed(3)}-${((r.x + r.w) / out.W).toFixed(3)}  `
      + `${r.shown ? 'shown' : 'hidden'}${r.on !== undefined ? ` on=${r.on}` : ''}`)
  }
  if (M && M.shown) {
    const bottom = M.y + M.h
    console.log(`    clearance to horizon: ${((out.horizonY - bottom) / out.H * 100).toFixed(1)}% of height`
      + ` (block bottom ${(bottom / out.H * 100).toFixed(1)}%, horizon ${(out.horizonY / out.H * 100).toFixed(1)}%)`)
    // OVERLAP IS TESTED ON THE PAINTED CHILDREN, NOT ON .sg-moment.
    // The container is `width: min(92vw, 980px)` with its children centred in
    // it, so its box spans nearly the whole screen and intersects the minimap
    // on any phone while nothing is actually drawn there. Measuring the
    // container reported a collision that a screenshot does not show.
    const hits = []
    for (const s of WIDGETS) {
      if (s === '.sg-moment' || s === '.sg-score' || s === '.sg-cheer') continue
      for (const child of ['.sg-score', '.sg-cheer']) {
        const a = inter(out.rects[child], out.rects[s])
        if (a > 0) hits.push(`${child} x ${s} ${a}px^2`)
      }
    }
    console.log(`    overlap: ${hits.length ? hits.join(', ') : 'none'}`)
  } else {
    console.log('    .sg-moment NOT VISIBLE -- the drift rail did not light the panel, numbers below are meaningless')
  }
  if (errors.length) console.log('    page errors:', errors.slice(0, 3))
  await ctx.close()
}

await browser.close()
server.close()
