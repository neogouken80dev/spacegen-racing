/**
 * "DOES THE HUD GET OUT OF THE WAY ON A TABLET?"
 *
 * The report: on a tablet the speedometer cluster overlaps the touch controls
 * and the item slots are hidden in a corner. The cause was that the compact
 * HUD was gated on a phone-sized viewport, and a tablet is neither narrow nor
 * short -- so it got the desktop instruments WITH the thumb pads drawn over
 * them.
 *
 * This measures the thing the report is actually about: OVERLAP. It reads the
 * on-screen rectangles of the instrument clusters and of the touch controls
 * and reports their intersection area. A layout that is merely "different" is
 * not the goal; a layout where nothing the player needs to read sits under
 * something the player needs to press is.
 *
 *   node tools/probe-tablet.mjs [--phone|--desktop]
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

const MODE = process.argv.includes('--phone') ? 'phone'
  : process.argv.includes('--desktop') ? 'desktop' : 'tablet'
// A real iPad in landscape: wide enough and tall enough to miss BOTH phone
// breakpoints, which is exactly how it ended up with the desktop layout.
const VP = MODE === 'phone' ? { width: 844, height: 390 }
  : MODE === 'desktop' ? { width: 1440, height: 810 }
    : { width: 1180, height: 820 }
const TOUCH = MODE !== 'desktop'

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist'],
})
const page = await (await browser.newContext({
  viewport: VP, hasTouch: TOUCH, isMobile: TOUCH, deviceScaleFactor: 1,
})).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(url, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(2200)
await page.evaluate(() => { if (window.__GAME__) window.__GAME__.maxSubSteps = 400 })

const act = async (loc) => (TOUCH ? loc.tap({ timeout: 8000 }) : loc.click({ timeout: 8000 }))
const clickText = async (pats) => {
  for (const p of pats) {
    const el = page.locator(`text=${p}`).first()
    if (await el.count() && await el.isVisible().catch(() => false)) {
      await act(el).catch(() => {}); return
    }
  }
}
await clickText(['PLAY NOW', 'PLAY'])
await page.waitForTimeout(1200)
await page.waitForSelector('.sg-screen--track .sg-card--track', { state: 'visible', timeout: 20000 })
await act(page.locator('.sg-screen--track .sg-btn--start').first())
await page.waitForSelector('.sg-screen--garage .sg-btn--start', { state: 'visible', timeout: 20000 })
await page.waitForTimeout(500)
await clickText(['START RACE', 'START'])
await page.waitForTimeout(3000)

// Force a touch scheme on the tablet/phone runs, the way a player would.
if (TOUCH) {
  await page.evaluate(() => { window.__GAME__.input.setScheme('stick') })
  await page.waitForTimeout(600)
}

const report = await page.evaluate(() => {
  const R = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const b = el.getBoundingClientRect()
    if (b.width < 1 || b.height < 1) return null
    return { x: b.x, y: b.y, w: b.width, h: b.height }
  }
  const over = (a, b) => {
    if (!a || !b) return 0
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
    return w > 0 && h > 0 ? w * h : 0
  }
  // The real control classes (src/game/touchControls.ts builds `sgtc-*`).
  // The first version of this probe guessed `sgt-` and found zero elements,
  // then cheerfully reported zero overlap -- a probe that measures nothing
  // passes everything, which is worse than failing.
  // VISIBLE CONTROLS ONLY.
  //
  // `.sgtc-zone` is the stick's INPUT AREA -- 614x525 of transparent nothing
  // covering the whole lower-left quadrant, so a thumb can land anywhere in
  // it. Counting it as an obstruction makes every possible HUD layout fail,
  // and it is not what the report is about: the complaint is that the
  // instruments are drawn UNDER the controls, which is about ink, not about
  // hit-testing. The HUD takes no pointer events, so sharing space with a
  // zone costs nothing.
  const VISIBLE = '.sgtc-pad, .sgtc-btn, .sgtc-knob, .sgtc-base, .sgtc-tiltbar'
  const vis = (el) => {
    const st = getComputedStyle(el)
    if (st.display === 'none' || st.visibility === 'hidden' || +st.opacity <= 0.05) return false
    // A zone is transparent; a control is not.
    return true
  }
  const rects = (sel) => [...document.querySelectorAll(sel)]
    .filter(vis)
    .map((el) => ({ cls: el.className, b: el.getBoundingClientRect() }))
    .filter((r) => r.b.width > 20 && r.b.height > 20)
    .map((r) => ({ cls: r.cls, x: r.b.x, y: r.b.y, w: r.b.width, h: r.b.height }))
  const pads = rects(VISIBLE)
  const zones = rects('.sgtc-zone')
  const gauge = R('.sg-hud__gauge')
  const items = R('.sg-hud__items')
  const band = R('.sg-hud__band')
  const sum = (r) => pads.reduce((a, p) => a + over(r, p), 0)
  return {
    compact: document.documentElement.classList.contains('sg-compact'),
    scheme: window.__GAME__?.input?.scheme,
    vw: innerWidth, vh: innerHeight,
    padCount: pads.length,
    zoneCount: zones.length,
    gauge, items, band,
    pads: pads.map((b) => ({
      cls: String(b.cls).slice(0, 28),
      x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h),
      fx: +((b.x + b.w / 2) / innerWidth).toFixed(2),
      fy: +((b.y + b.h / 2) / innerHeight).toFixed(2),
    })),
    gaugeOverlapPx: Math.round(sum(gauge)),
    itemsOverlapPx: Math.round(sum(items)),
    // Where the item slots sit, as a fraction of the viewport.
    itemsCentre: items ? {
      x: +((items.x + items.w / 2) / innerWidth).toFixed(3),
      y: +((items.y + items.h / 2) / innerHeight).toFixed(3),
    } : null,
    gaugeCentre: gauge ? {
      x: +((gauge.x + gauge.w / 2) / innerWidth).toFixed(3),
      y: +((gauge.y + gauge.h / 2) / innerHeight).toFixed(3),
    } : null,
  }
})

await mkdir(new URL('../shots/', import.meta.url).pathname, { recursive: true })
await page.screenshot({ path: new URL(`../shots/hud-${MODE}.png`, import.meta.url).pathname })

console.log(`\n=== HUD LAYOUT (${MODE}, ${VP.width}x${VP.height}) ===`)
console.log(JSON.stringify(report, null, 2))
const fail = []
if (TOUCH && !report.compact) fail.push('compact layout is NOT active on a touch device')
if (!TOUCH && report.compact) fail.push('compact layout is active on desktop')
if (TOUCH && report.padCount < 2) fail.push(`only ${report.padCount} touch pads found`)
if (TOUCH && report.gaugeOverlapPx > 0) {
  fail.push(`the speed cluster overlaps the controls by ${report.gaugeOverlapPx}px^2`)
}
if (TOUCH && report.itemsOverlapPx > 0) {
  fail.push(`the item slots overlap the controls by ${report.itemsOverlapPx}px^2`)
}
if (errors.length) fail.push(`${errors.length} page errors: ${errors[0]}`)
console.log(fail.length ? `\nFAILED:\n  ${fail.join('\n  ')}` : '\nHUD LAYOUT PASSED')
await browser.close(); server.close()
process.exit(fail.length ? 1 : 0)
