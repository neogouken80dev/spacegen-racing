/**
 * IS THE PICTURE THE RIGHT SHAPE?
 *
 * Reports, for a range of phone-landscape viewports, the three numbers that
 * must agree or the image is stretched:
 *   canvas CSS size      what the browser paints the buffer into
 *   canvas buffer size   what three.js renders at
 *   camera.aspect        the shape three.js THINKS it is rendering
 * A mismatch between the last two is a skew, and its magnitude is the ratio.
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

const VIEWPORTS = [
  { name: 'iPhone 15 Pro landscape', width: 852, height: 393 },
  { name: 'Pixel 8 landscape      ', width: 892, height: 412 },
  { name: 'S23 Ultra landscape    ', width: 915, height: 412 },
  { name: 'very wide 21:9         ', width: 1008, height: 432 },
  { name: 'portrait               ', width: 393, height: 852 },
  { name: 'desktop 16:9           ', width: 1440, height: 810 },
]

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
console.log('viewport                      cssW x cssH   bufW x bufH   camAspect  cssAspect  SKEW')
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction(() => !!window.__GAME__, null, { timeout: 60000 }).catch(() => {})
  await page.waitForTimeout(2500)
  const m = await page.evaluate(() => {
    const c = document.getElementById('sg-canvas')
    const g = window.__GAME__
    const cam = g?.chase?.camera
    return {
      cssW: c ? c.clientWidth : -1, cssH: c ? c.clientHeight : -1,
      bufW: c ? c.width : -1, bufH: c ? c.height : -1,
      dpr: window.devicePixelRatio,
      camAspect: cam ? cam.aspect : -1,
      fov: cam ? cam.fov : -1,
    }
  })
  const cssAspect = m.cssW / Math.max(1, m.cssH)
  const skew = m.camAspect > 0 ? cssAspect / m.camAspect : NaN
  console.log(
    `${vp.name} ${String(m.cssW).padStart(5)} x${String(m.cssH).padStart(4)} ` +
    `${String(m.bufW).padStart(6)} x${String(m.bufH).padStart(4)} ` +
    `${m.camAspect.toFixed(3).padStart(9)} ${cssAspect.toFixed(3).padStart(10)}  ` +
    `${skew.toFixed(3)}${Math.abs(skew - 1) > 0.02 ? '  <-- STRETCHED' : ''}`,
  )
  await ctx.close()
}
await browser.close()
server.close()
