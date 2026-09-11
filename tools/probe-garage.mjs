/**
 * GARAGE PHOTOGRAPHS + PREVIEW PROBE.
 *
 * `tools/smoke.mjs` walks past the garage on its way to a race and takes one
 * frame of it; `tools/probe-shots.mjs` photographs the road. Neither can answer
 * the questions the live vehicle preview raises, all of which are about a
 * screen nobody is racing on:
 *
 *   - does the preview render at all, on this viewport, with a real WebGL
 *     context, and does it look like the rest of the garage;
 *   - does changing the chassis or the pilot change what is in the box;
 *   - does a swipe that starts ON the preview rotate it while a swipe that
 *     starts on a LIST still scrolls the list (the gesture the two surfaces
 *     fight over on a phone);
 *   - is the second WebGL context actually gone once the garage is not the
 *     screen you are looking at.
 *
 *   node tools/probe-garage.mjs [--mobile] [--landscape] [--reduced-motion]
 *
 * Viewports match probe-shots.mjs: default desktop 1440x810, `--mobile` is a
 * 412x892 PORTRAIT phone and `--landscape` is 915x412, both with a real coarse
 * pointer (hasTouch/isMobile) so the touch layout is what gets photographed.
 *
 * NEVER WAIT ON THE WALL CLOCK. Under SwiftShader this page runs at 1-5 fps.
 * `waitFrames(n)` waits on the preview's own frame counter, which is the only
 * clock that means anything here.
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { extname, join } from 'node:path'

const LANDSCAPE = process.argv.includes('--landscape')
const MOBILE = LANDSCAPE || process.argv.includes('--mobile')
const REDUCED = process.argv.includes('--reduced-motion')
/**
 * --nowebgl: THE FALLBACK.
 *
 * The front end has to still work when a second WebGL context cannot be had --
 * an old driver, a browser at its context limit, a machine with the GPU
 * blocklisted. Refusing every context AFTER the first one puts the page in
 * exactly that state through the shipping path: the game keeps the context it
 * booted with, the preview's factory returns null, and the garage should lay
 * out the way it did before this feature existed with nothing broken in it.
 */
const NOWEBGL = process.argv.includes('--nowebgl')
const VIEWPORT = LANDSCAPE
  ? { width: 915, height: 412 }
  : MOBILE ? { width: 412, height: 892 } : { width: 1440, height: 810 }
const KIND = LANDSCAPE ? 'mobilels' : MOBILE ? 'mobile' : 'desktop'
const TAG = KIND + (REDUCED ? '-rm' : '')
const OUT = join('shots', 'garage')
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }
const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  const path = join('dist', url === '/' ? 'index.html' : url.slice(1))
  if (!existsSync(path)) { res.writeHead(404); res.end('nope'); return }
  res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' })
  res.end(readFileSync(path))
})
await new Promise((r) => server.listen(4179, r))

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist'],
})
const ctx = await browser.newContext({
  viewport: VIEWPORT,
  hasTouch: MOBILE,
  isMobile: MOBILE,
  deviceScaleFactor: 1,
  reducedMotion: REDUCED ? 'reduce' : 'no-preference',
})
const page = await ctx.newPage()

const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message)))

if (NOWEBGL) {
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext
    let seen = 0
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      if (/webgl/.test(String(type)) && seen++ > 0) return null
      return orig.call(this, type, ...rest)
    }
  })
}

await page.addInitScript(() => {
  // Count contexts honestly: patch getContext before anything runs so every
  // WebGL context this page creates is visible to the probe, and a released
  // one (forceContextLoss) reports itself lost.
  const orig = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = orig.call(this, type, ...rest)
    if (ctx && /webgl/.test(String(type))) this.__sgctx = ctx
    return ctx
  }
})

await page.goto('http://localhost:4179/', { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(2500)
await page.evaluate(() => { if (window.__GAME__) window.__GAME__.maxSubSteps = 400 })

const shot = (n) => page.screenshot({ path: join(OUT, `${TAG}-${n}.png`) })
const activate = async (loc) => { if (MOBILE) await loc.tap({ timeout: 8000 }); else await loc.click({ timeout: 8000 }) }

// --- walk the front end to the garage -------------------------------------
const clickText = async (labels) => {
  for (const t of labels) {
    const el = page.locator('button, .sg-btn').filter({ hasText: t }).first()
    if (await el.count() && await el.isVisible().catch(() => false)) { await activate(el); return t }
  }
  return null
}
await clickText(['PLAY NOW', 'PLAY', 'Play'])
await page.waitForSelector('.sg-screen--track .sg-card--track', { state: 'visible', timeout: 20000 })
await page.waitForTimeout(600)
await activate(page.locator('.sg-screen--track .sg-btn--start'))
await page.waitForSelector('.sg-screen--garage .sg-btn--start', { state: 'visible', timeout: 20000 })

/**
 * Wait on the PREVIEW's own frame counter, never on the clock: this renderer
 * delivers between one and five frames a second, so a wall-clock wait is a
 * coin toss about how many times the turntable has been advanced.
 */
const frames = () => page.evaluate(() => window.__GARAGE_PREVIEW__?.debug()?.frames ?? -1)
async function waitFrames(n, capMs = 60000) {
  const start = await frames()
  if (start < 0) return false
  const t0 = Date.now()
  while (Date.now() - t0 < capMs) {
    if ((await frames()) - start >= n) return true
    await page.waitForTimeout(100)
  }
  return false
}

const debug = () => page.evaluate(() => window.__GARAGE_PREVIEW__?.debug() ?? null)
/** Live count of WebGL contexts the page is holding, from the page itself. */
const contexts = () => page.evaluate(() => {
  let n = 0
  for (const c of document.querySelectorAll('canvas')) {
    // A context this page still owns keeps its canvas non-zero and answers.
    const gl = c.__sgctx
    if (gl && !gl.isContextLost()) n++
  }
  return n
})

if (NOWEBGL) {
  await page.waitForTimeout(2000)
  await shot('1-garage-nowebgl')
  const fb = await page.evaluate(() => {
    const box = document.querySelector('.sg-prev')
    const detail = document.querySelector('.sg-screen--garage .sg-detail')
    return {
      dbg: window.__GARAGE_PREVIEW__ ? window.__GARAGE_PREVIEW__.debug() : null,
      previewHidden: box ? box.hasAttribute('hidden') : null,
      previewBox: box ? box.getBoundingClientRect().height : null,
      canvases: document.querySelectorAll('.sg-prev__canvas').length,
      // The thing that must survive: the panel the preview was put on top of.
      statRows: document.querySelectorAll('.sg-screen--garage .sg-stat').length,
      detailH: detail ? Math.round(detail.getBoundingClientRect().height) : null,
      startBtn: !!document.querySelector('.sg-screen--garage .sg-btn--start'),
    }
  })
  console.log('no-webgl fallback:', JSON.stringify(fb))
  const bad = []
  if (!fb.dbg || fb.dbg.failed !== true) bad.push('the preview did not latch failed')
  if (fb.previewHidden !== true) bad.push('the empty preview box is still in the layout')
  if (fb.canvases !== 0) bad.push('a dead canvas was left in the DOM')
  if (fb.statRows !== 6) bad.push(`stat bars did not survive (${fb.statRows} of 6)`)
  if (!fb.startBtn) bad.push('START RACE is gone')
  if (bad.length) { console.log('FAIL: ' + bad.join('; ')); errors.push(...bad) }
  else console.log('fallback OK: garage lays out as it did before the preview existed')
  console.log(`\nconsole errors: ${errors.length}`)
  if (errors.length) console.log(errors.slice(0, 6).join('\n'))
  await browser.close()
  server.close()
  process.exit(errors.length ? 1 : 0)
}

await waitFrames(3)
await page.waitForTimeout(400)
await shot('1-garage')
console.log('preview:', JSON.stringify(await debug()))

// WHAT THE SECOND CONTEXT COSTS. Absolute milliseconds under SwiftShader mean
// nothing -- this renderer is two orders of magnitude off a phone GPU -- but
// the draw calls, the triangle count, the LOD level and the size of the buffer
// they are being pushed into are the same numbers a real device would see, and
// they are what the budget is actually spent on.
const cost = async (label) => {
  await waitFrames(10)
  const d = await debug()
  console.log(`cost ${label}: lod=${d.lod} calls=${d.calls} tris=${d.tris}`
    + ` buffer=${d.bw}x${d.bh} render=${d.ms.toFixed(1)}ms(swiftshader)`)
  return d
}
await cost('medium')
await page.evaluate(() => document.querySelector('.sg-seg__grp button').click())
await cost('low')
await page.evaluate(() => document.querySelectorAll('.sg-seg__grp button')[2].click())
await cost('high')
await page.evaluate(() => document.querySelectorAll('.sg-seg__grp button')[1].click())
await waitFrames(3)

// --- selection wiring -----------------------------------------------------
const pick = async (col, name) => {
  const card = page.locator(`.sg-screen--garage .sg-col--${col} .sg-card`).filter({ hasText: name }).first()
  await activate(card)
  await waitFrames(2)
}
await pick('chassis', 'Vector-7')
await pick('pilot', 'KOAN')
await waitFrames(3)
await shot('2-vector7-null')
console.log('after swap:', JSON.stringify(await debug()))

await pick('chassis', 'Bulwark')
await pick('pilot', 'ZEPHYR')
await waitFrames(3)
await shot('3-bulwark-halo9')

// --- turntable ------------------------------------------------------------
const y0 = (await debug())?.yaw ?? 0
await waitFrames(14)
const y1 = (await debug())?.yaw ?? 0
console.log(`auto-rotate: yaw ${y0.toFixed(3)} -> ${y1.toFixed(3)} (delta ${(y1 - y0).toFixed(3)} rad)`)

// --- the gesture question -------------------------------------------------
// A swipe that starts on the PREVIEW must rotate it; a swipe that starts on a
// LIST must scroll the list. Both measured on the real touch viewport, through
// real touch events, because a mouse drag proves nothing about either.
const box = await page.locator('.sg-prev').boundingBox()
const listSel = '.sg-screen--garage .sg-col--pilot .sg-list'
const listBox = await page.locator(listSel).boundingBox()
const scrollTop = () => page.$eval(listSel, (e) => e.scrollTop)
const scrollable = await page.$eval(listSel, (e) => e.scrollHeight - e.clientHeight)

let dragged = null
if (box) {
  const cx = box.x + box.width * 0.5
  const cy = box.y + box.height * 0.5
  const before = (await debug())?.yaw ?? 0
  if (MOBILE) {
    await page.touchscreen.tap(cx, cy) // wake, then a real drag below
    await page.evaluate(async ([x, y]) => {
      // Playwright's touchscreen has no drag; dispatch a real touch sequence.
      const el = document.elementFromPoint(x, y)
      const mk = (type, px) => {
        const t = new Touch({ identifier: 7, target: el, clientX: px, clientY: y })
        return new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], targetTouches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true })
      }
      el.dispatchEvent(mk('touchstart', x))
      for (let i = 1; i <= 8; i++) { el.dispatchEvent(mk('touchmove', x + i * 12)); await new Promise((r) => setTimeout(r, 16)) }
      el.dispatchEvent(mk('touchend', x + 96))
    }, [cx, cy])
    // Pointer events are what the preview listens to; synthesise them too so
    // this measures the shipping handler and not a touch shim.
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    for (let i = 1; i <= 8; i++) await page.mouse.move(cx + i * 12, cy)
    await page.mouse.up()
  } else {
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) await page.mouse.move(cx + i * 14, cy)
    await page.mouse.up()
  }
  const after = (await debug())?.yaw ?? 0
  dragged = after - before
  console.log(`drag on preview: yaw ${before.toFixed(3)} -> ${after.toFixed(3)} (delta ${dragged.toFixed(3)} rad)`)
  await shot('4-dragged')
}

let listMoved = null
if (listBox && scrollable > 4) {
  await page.$eval(listSel, (e) => { e.scrollTop = 0 })
  const cx = listBox.x + listBox.width * 0.5
  const cy = listBox.y + listBox.height * 0.72
  if (MOBILE) {
    // A real finger swipe up the list, via CDP touch input so the browser's own
    // scrolling machinery is what decides whether the list moves.
    const cdp = await ctx.newCDPSession(page)
    const pt = (y) => [{ x: cx, y, radiusX: 12, radiusY: 12, force: 1 }]
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(cy) })
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(cy - i * 9) })
      await page.waitForTimeout(16)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await page.waitForTimeout(700)
  } else {
    await page.mouse.move(cx, cy)
    await page.mouse.wheel(0, 120)
    await page.waitForTimeout(400)
  }
  listMoved = await scrollTop()
  console.log(`list scroll after swipe: scrollTop=${listMoved} (scrollable=${scrollable}px)`)
} else {
  console.log(`list scroll: nothing to scroll (overflow ${scrollable}px)`)
}

const yawAfterList = (await debug())?.yaw ?? 0
await shot('5-after-list-swipe')

// --- context lifecycle ----------------------------------------------------
const ctxInGarage = await contexts()
await activate(page.locator('.sg-screen--garage .sg-btn--start'))
await page.waitForTimeout(2500)
const ctxInRace = await contexts()
const liveAfterLeave = (await debug())?.live ?? null
console.log(`webgl contexts: garage=${ctxInGarage} racing=${ctxInRace}  preview live after leaving=${liveAfterLeave}`)
await shot('6-racing')

// Back to the garage: the context must come back, exactly one of it. Then walk
// garage -> track -> garage five more times. A preview that built a context per
// visit and never handed one back would look completely correct in every frame
// above and kill a phone after five races, so the count is what is checked.
await page.evaluate(() => window.__GAME__.frontEnd?.show?.('garage'))
await page.waitForTimeout(1500)
const ctxBack = await contexts()
for (let i = 0; i < 5; i++) {
  await page.evaluate(() => window.__GAME__.frontEnd?.show?.('track'))
  await page.waitForTimeout(300)
  await page.evaluate(() => window.__GAME__.frontEnd?.show?.('garage'))
  await page.waitForTimeout(300)
}
await waitFrames(2)
const ctxCycled = await contexts()
console.log(`webgl contexts after returning to garage: ${ctxBack}`
  + `, after five more round trips: ${ctxCycled}`)
if (ctxCycled !== 2) {
  console.log(`FAIL: expected exactly 2 live contexts (game + preview), got ${ctxCycled}`)
  errors.push('webgl context leak across garage visits')
}

console.log(`\nconsole errors: ${errors.length}`)
if (errors.length) console.log(errors.slice(0, 6).join('\n'))
await browser.close()
server.close()
process.exit(errors.length ? 1 : 0)
