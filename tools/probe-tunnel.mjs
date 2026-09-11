/**
 * "IS THE TUNNEL VISION ACTUALLY STRONGER ON SCREEN?"
 *
 * probe-camfeel.ts reproduces the composite's arithmetic; that proves the
 * shader WOULD do it if the value arrived. This proves the whole chain, in
 * pixels, by photographing the SAME FRAME twice with only the dial changed and
 * diffing the two.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT TOOK TO MAKE THIS MEASURE ANYTHING, because two earlier versions of
 * it printed confident nonsense:
 *
 *  1. The race was left running between captures, so each frame was a
 *     different stretch of road. Centre luminance swung 50..137 on scene
 *     content alone -- several times the effect -- and the ratio came out
 *     BACKWARDS.
 *  2. Freezing the PLAYER was not enough: the other seven cars drove out of
 *     frame between shots, taking their headlights and boost plumes with them.
 *     Two "identical" frames differed by an entire pack of vehicles.
 *  3. addDolly raises the camera half too, which pulls the rig in and opens
 *     the lens -- reframing the shot. That is switched off here, which is only
 *     possible because the two halves are separate now.
 *
 * So: every racer is pinned, and the two captures are taken seconds apart in a
 * scene that cannot change. A pixel that differs, differs because of the dial.
 * ---------------------------------------------------------------------------
 *
 *   node tools/probe-tunnel.mjs
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

// --- freeze the WHOLE field -------------------------------------------------
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

async function shoot(name, dial) {
  await page.evaluate((d) => {
    const g = window.__GAME__
    g.chase.applySettings({ tunnel: d, boost: 0 })
    if (g.__k) clearInterval(g.__k)
    g.__k = setInterval(() => g.chase.addDolly(0.30), 4)
  }, dial)
  await page.waitForTimeout(1600)
  const uWarp = await page.evaluate(() => window.__GAME__.post.compositeMat.uniforms.uWarp.value)
  const path = new URL(`../shots/tunnel-${name}.png`, import.meta.url).pathname
  await page.screenshot({ path })
  return { path, uWarp }
}

const off = await shoot('off', 0)
const on = await shoot('max', 2.5)
await page.evaluate(() => { const g = window.__GAME__; if (g.__k) clearInterval(g.__k) })

// --- compare ----------------------------------------------------------------
async function lumGrid(path) {
  const img = await loadImage(path)
  const c = createCanvas(img.width, img.height)
  const ctx = c.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const d = ctx.getImageData(0, 0, img.width, img.height).data
  const cx = img.width / 2, cy = img.height / 2
  const maxR = Math.hypot(cx, cy)
  // Five concentric rings.
  const rings = [0, 0, 0, 0, 0], n = [0, 0, 0, 0, 0]
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const i = (y * img.width + x) * 4
      const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
      const r = Math.hypot(x - cx, y - cy) / maxR
      const k = Math.min(4, Math.floor(r * 5))
      rings[k] += lum; n[k]++
    }
  }
  return rings.map((v, i) => v / n[i])
}

const a = await lumGrid(off.path)
const b = await lumGrid(on.path)

console.log('\n=== TUNNEL VISION, MEASURED IN PIXELS ==========================')
console.log('  Same frozen frame, photographed twice. Only the dial changed.')
console.log(`  uWarp reaching the shader: ${off.uWarp.toFixed(3)} off, ${on.uWarp.toFixed(3)} at max.\n`)
console.log('  ring (centre -> edge)    dial 0    dial 250%    change')
for (let i = 0; i < 5; i++) {
  const pct = (b[i] / Math.max(1e-6, a[i]) - 1) * 100
  console.log(
    `  ${['0.0-0.2', '0.2-0.4', '0.4-0.6', '0.6-0.8', '0.8-1.0'][i]}                 `
    + `${a[i].toFixed(1).padStart(6)}    ${b[i].toFixed(1).padStart(6)}     `
    + `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`,
  )
}
console.log('\n  A tunnel darkens the outer rings much more than the inner ones.')
console.log(`  page errors: ${errors.length}`)
await browser.close(); server.close()
