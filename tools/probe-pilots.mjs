/**
 * SIX HEADS, ONE CONTACT SHEET.
 *
 * A pilot is now a build choice, so the six of them have to be distinguishable
 * -- in the garage at full size, and from the chase camera at 40px where a
 * player is picking out a rival. That is a question about silhouettes, and the
 * only way to answer it is to put them side by side at both sizes and look.
 *
 * One browser, six selections, same camera and same yaw for every one, so any
 * difference in the output is the head rather than the turntable having drifted.
 *
 *   node tools/probe-pilots.mjs [--yaw=200] [--chassis=solaire]
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { join, extname } from 'node:path'

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1]
const YAW = Number(arg('yaw', 200))
const CHASSIS = arg('chassis', 'solaire')
const NAMES = ['SOCKET', 'VANGUARD', 'AEGIS', 'ZEPHYR', 'TRIAGE', 'KOAN']

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

const click = async (t) => {
  const el = page.locator('button, .sg-btn').filter({ hasText: t }).first()
  if (await el.count()) { await el.click({ timeout: 8000 }).catch(() => {}); return true }
  return false
}
await click('PLAY')
await page.waitForSelector('.sg-screen--track .sg-card--track', { state: 'visible', timeout: 20000 })
await page.waitForTimeout(600)
await page.locator('.sg-screen--track .sg-btn--start').first().click()
await page.waitForSelector('.sg-screen--garage .sg-btn--start', { state: 'visible', timeout: 20000 })
await page.waitForTimeout(1200)

const target = page.locator(`.sg-screen--garage [data-chassis="${CHASSIS}"]`).first()
if (await target.count()) await target.click({ timeout: 8000 }).catch(() => {})

const frames = () => page.evaluate(() => window.__GARAGE_PREVIEW__?.debug()?.frames ?? -1)
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

const dir = new URL('../shots/pilots/', import.meta.url).pathname
await mkdir(dir, { recursive: true })
const box = page.locator('.sg-prev').first()

for (const name of NAMES) {
  const card = page.locator('.sg-screen--garage .sg-col--pilot .sg-card')
    .filter({ hasText: name }).first()
  if (!(await card.count())) { errors.push(`no pilot card for ${name}`); continue }
  await card.click({ timeout: 8000 }).catch(() => {})
  await waitFrames(3)
  // Same yaw for all six: a contact sheet where the turntable moved between
  // shots compares turntable positions, not heads.
  await page.evaluate((y) => window.__GARAGE_PREVIEW__.setYaw((y * Math.PI) / 180), YAW)
  await waitFrames(3)
  const got = await page.evaluate(() => window.__GARAGE_PREVIEW__?.debug() ?? null)
  await box.screenshot({ path: `${dir}${name.toLowerCase()}.png` })
  console.log(`  ${name.padEnd(9)} pilot=${got?.pilotId ?? '?'}  tris=${got?.tris ?? '?'}  calls=${got?.calls ?? '?'}`)
  if (got && got.pilotId && got.pilotId.toUpperCase() !== name) {
    errors.push(`selected ${got.pilotId}, wanted ${name}`)
  }
}

console.log(`\nwrote ${dir}`)
console.log(`errors: ${errors.length}`, errors.slice(0, 4))
await browser.close()
server.close()
process.exit(errors.length ? 1 : 0)
