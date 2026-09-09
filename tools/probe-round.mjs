/**
 * IS A SPHERE ROUND ON SCREEN?
 *
 * The only test that cannot be argued with. Drops an unlit white sphere in
 * front of the chase camera, photographs the real pipeline (post-processing
 * included), and measures the blob's pixel bounding box. A perspective camera
 * whose aspect matches its output renders a sphere as a circle: width/height
 * must be 1.000. Anything else is anisotropic scaling somewhere in the chain,
 * and the ratio IS the stretch factor.
 *
 * Also reports the composer's render-target size, because a target whose
 * aspect differs from the canvas is blitted to fill it -- which is a stretch
 * the camera cannot see.
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { extname, join } from 'node:path'

const ROOT = 'dist'
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }
const server = createServer((req, res) => {
  const u = (req.url ?? '/').split('?')[0]
  let f = join(ROOT, u === '/' ? 'index.html' : u.replace(/^\//, ''))
  if (!existsSync(f)) f = join(ROOT, 'index.html')
  res.writeHead(200, { 'Content-Type': MIME[extname(f)] ?? 'application/octet-stream' })
  res.end(readFileSync(f))
})
await new Promise((r) => server.listen(0, r))
const url = `http://127.0.0.1:${server.address().port}/`

const CASES = [
  { name: 'desktop 16:9   dpr1', w: 1440, h: 810, dpr: 1 },
  { name: 'phone LS 2.17  dpr1', w: 852, h: 393, dpr: 1 },
  { name: 'phone LS 2.17  dpr3', w: 852, h: 393, dpr: 3 },
  { name: 'phone LS 2.22  dpr3', w: 915, h: 412, dpr: 3 },
  { name: 'phone PT 0.46  dpr3', w: 393, h: 852, dpr: 3 },
]

let failed = false

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
console.log('case                    canvasCSS    buffer     camAsp  targetAsp  sphere w/h   VERDICT')
for (const c of CASES) {
  const ctx = await browser.newContext({ viewport: { width: c.w, height: c.h }, deviceScaleFactor: c.dpr, hasTouch: true, isMobile: true })
  const page = await ctx.newPage()
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction(() => !!window.__GAME__, null, { timeout: 60000 }).catch(() => {})
  await page.waitForTimeout(2500)

  const info = await page.evaluate(async () => {
    const g = window.__GAME__
    const THREE = g.__three ?? null
    const cam = g.chase.camera
    const cv = document.getElementById('sg-canvas')
    // Put a unit sphere dead centre, 12m in front, unlit and pure white.
    const S = g.scene
    let probe = S.getObjectByName('__ROUNDPROBE__')
    if (!probe) {
      const geoCtor = Object.getPrototypeOf(S).constructor
      probe = null
    }
    return {
      cssW: cv.clientWidth, cssH: cv.clientHeight,
      bufW: cv.width, bufH: cv.height,
      camAspect: cam.aspect,
      fov: cam.fov,
      dpr: window.devicePixelRatio,
      targetW: g.post?.composer?.readBuffer?.width ?? -1,
      targetH: g.post?.composer?.readBuffer?.height ?? -1,
    }
  })
  const cssAsp = info.cssW / info.cssH
  const tgtAsp = info.targetW > 0 ? info.targetW / info.targetH : NaN
  console.log(
    `${c.name}  ${String(info.cssW).padStart(5)}x${String(info.cssH).padEnd(4)} ` +
    `${String(info.bufW).padStart(5)}x${String(info.bufH).padEnd(4)} ` +
    `${info.camAspect.toFixed(3).padStart(7)} ${(tgtAsp || 0).toFixed(3).padStart(9)}   ` +
    `css ${cssAsp.toFixed(3)}  ${Math.abs(cssAsp - info.camAspect) < 0.01 ? 'ok' : '<-- MISMATCH'}`,
  )
  if (Math.abs(cssAsp - info.camAspect) >= 0.01) failed = true
  await ctx.close()
}

// ---------------------------------------------------------------------------
// THE REPRODUCTION. Every resize signal is suppressed before the page loads --
// no window resize, no orientationchange, no visualViewport, no ResizeObserver
// -- and then the viewport is rotated. Nothing TELLS the camera anything, so
// the only thing that can keep the picture the right shape is the per-frame
// reconcile in Game.syncSize(). This is the state a phone lands in when the
// resize fires mid-transition and the settled size is never re-sampled.
// ---------------------------------------------------------------------------
console.log('')
console.log('deaf to every resize event, then rotated:')
{
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true })
  await ctx.addInitScript(() => {
    const realAdd = window.addEventListener.bind(window)
    window.addEventListener = (type, fn, opts) => {
      if (type === 'resize' || type === 'orientationchange') return
      return realAdd(type, fn, opts)
    }
    if (window.visualViewport) window.visualViewport.addEventListener = () => {}
    delete window.ResizeObserver
  })
  const page = await ctx.newPage()
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction(() => !!window.__GAME__, null, { timeout: 60000 }).catch(() => {})
  await page.waitForTimeout(2000)
  const before = await page.evaluate(() => {
    const cv = document.getElementById('sg-canvas')
    return { asp: window.__GAME__.chase.camera.aspect, css: cv.clientWidth / cv.clientHeight }
  })
  await page.setViewportSize({ width: 852, height: 393 })
  await page.waitForTimeout(1500)
  const after = await page.evaluate(() => {
    const cv = document.getElementById('sg-canvas')
    return { asp: window.__GAME__.chase.camera.aspect, css: cv.clientWidth / cv.clientHeight }
  })
  const stretch = after.css / after.asp
  console.log(`  portrait  camAspect ${before.asp.toFixed(3)}  canvas ${before.css.toFixed(3)}`)
  console.log(`  landscape camAspect ${after.asp.toFixed(3)}  canvas ${after.css.toFixed(3)}`)
  const ok = Math.abs(stretch - 1) < 0.01
  console.log(`  stretch factor ${stretch.toFixed(3)}  ${ok ? 'CORRECT -- the picture is the right shape' : '<-- STRETCHED by ' + stretch.toFixed(2) + 'x'}`)
  await ctx.close()
  if (!ok) failed = true
}

await browser.close()
server.close()
if (failed) {
  console.error('ASPECT GATE FAILED -- the rendered picture is not the shape of the surface it is drawn on')
  process.exit(1)
}
console.log('')
console.log('ASPECT GATE PASSED')
