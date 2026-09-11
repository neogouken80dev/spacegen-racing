/**
 * THE CAMERA CONTROLS, DRIVEN THE WAY A PLAYER DRIVES THEM.
 *
 * camera.test.ts proves the MODEL: the defaults reproduce the authored rig,
 * junk cannot produce a broken frame, each dial moves the thing it names. None
 * of that touches a single button. This opens the real settings panel in a
 * real browser, taps the real steppers, and checks that the real camera moved
 * -- and that the choice survives a reload, which is the half of a settings
 * system that is easy to ship broken and impossible to notice in a unit test.
 *
 *   node tools/probe-camui.mjs [--mobile]
 *
 * The camera position is read off `window.__GAME__` rather than inferred from
 * pixels: under SwiftShader this runs at about 4 fps, and "the picture looks
 * further away" is not a measurement.
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

const MOBILE = process.argv.includes('--mobile')
const label = MOBILE ? 'mobile' : 'desktop'
const viewport = MOBILE ? { width: 844, height: 390 } : { width: 1440, height: 810 }

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist'],
})
const ctx = await browser.newContext({
  viewport, hasTouch: MOBILE, isMobile: MOBILE, deviceScaleFactor: 1,
})
const page = await ctx.newPage()
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message)))

await mkdir(new URL('../shots/', import.meta.url).pathname, { recursive: true })
const shot = (n) => page.screenshot({
  path: new URL(`../shots/camui-${label}-${n}.png`, import.meta.url).pathname,
})
const activate = async (loc, timeout = 6000) =>
  (MOBILE ? loc.tap({ timeout }) : loc.click({ timeout }))

await page.goto(url, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(2200)
await page.evaluate(() => { if (window.__GAME__) window.__GAME__.maxSubSteps = 400 })

const fail = []
const check = (ok, msg) => { if (!ok) fail.push(msg) }

// --- get into a race -------------------------------------------------------
//
// The tools bar -- and so the settings gear -- is hidden on the front end, so
// this has to drive the real flow to reach it. That is the right place to test
// from anyway: adjusting a chase camera is something you do while looking at
// the thing it is chasing, and opening the panel mid-race pauses it, which is
// the path a player actually takes.
const clickText = async (patterns) => {
  for (const p of patterns) {
    const el = page.locator(`text=${p}`).first()
    if (await el.count() && await el.isVisible().catch(() => false)) {
      await activate(el).catch(() => {})
      return p
    }
  }
  return null
}
await clickText(['PLAY NOW', 'PLAY', 'Play'])
await page.waitForTimeout(1200)
await page.waitForSelector('.sg-screen--track .sg-card--track', { state: 'visible', timeout: 20000 })
await activate(page.locator('.sg-screen--track .sg-btn--start'))
await page.waitForSelector('.sg-screen--garage .sg-btn--start', { state: 'visible', timeout: 20000 })
await page.waitForTimeout(500)
await clickText(['START RACE', 'START', 'RACE', 'Start Race'])
await page.waitForTimeout(2500)

// --- open settings ---------------------------------------------------------
// By its own aria-label. NOT a loose "settings" match: that also hits the
// dialog's own Settings TAB, which is in the DOM from boot and invisible until
// the dialog opens -- which is exactly what the first version of this probe
// spent its timeout clicking.
const GEAR = 'button.sg-tools__btn[aria-label="Settings and controls"]'
const gear = page.locator(GEAR).first()
check(await gear.count() > 0, 'no settings gear in the tools bar')
await activate(gear)
await page.waitForSelector('.sgset__dialog', { state: 'visible', timeout: 8000 })
await page.waitForTimeout(400)

// --- the section exists ----------------------------------------------------
const sec = page.locator('.sgset-sec').filter({ hasText: 'Camera' }).first()
check(await sec.count() > 0, 'no Camera section in the settings panel')
// MATCH THE LABEL, NOT THE ROW TEXT.
//
// `filter({ hasText })` matches anywhere in the row, DESCRIPTION INCLUDED. The
// Impact shake row's copy says "see Boost effect below", so a substring match
// for "Boost effect" found the shake row first and this probe spent a run
// cheerfully driving the wrong control and reporting on it. Anchor on the
// label element, exactly.
const rowOf = (name) => sec.locator('.sgset-row').filter({
  has: page.locator('.sgset-row__k', { hasText: new RegExp(`^${name}$`) }),
}).first()
const NAMES = [
  'Distance', 'Height', 'Angle', 'Tracking buffer', 'Impact shake',
  'Boost camera kick', 'Tunnel vision',
]
for (const n of NAMES) check(await rowOf(n).count() > 0, `no "${n}" row`)

const valueOf = async (n) => (await rowOf(n).locator('.sgset-step__val').first().textContent())?.trim()
const plus = (n) => rowOf(n).locator('.sgset-step__btn--up').first()
const minus = (n) => rowOf(n).locator('.sgset-step__btn--dn').first()

const before = {}
for (const n of NAMES) before[n] = await valueOf(n)

// Scroll the section into view so the shot shows it, then photograph.
await sec.scrollIntoViewIfNeeded().catch(() => {})
await page.waitForTimeout(250)
await shot('1-panel')

// --- THE CONTROLS ACTUALLY MOVE THE CAMERA --------------------------------
const rig = () => page.evaluate(() => {
  const g = window.__GAME__
  const c = g && g.chase
  return c ? { ...c.settings } : null
})
const r0 = await rig()
check(r0 !== null, 'window.__GAME__.chase is not reachable')

// Distance: five taps on +, which at 0.5m a tap is 2.5m.
for (let i = 0; i < 5; i++) { await activate(plus('Distance')); await page.waitForTimeout(60) }
const r1 = await rig()
check(
  r1 && Math.abs(r1.distance - (r0.distance + 2.5)) < 1e-6,
  `five taps on Distance + gave ${r1 && r1.distance} from ${r0 && r0.distance}`,
)
check((await valueOf('Distance')) !== before.Distance, 'the Distance readout did not change')

// The camera kick down to Off -- the control the original report is about --
// and the tunnel left alone, which is the whole point of splitting them.
for (let i = 0; i < 40; i++) { await activate(minus('Boost camera kick')).catch(() => {}) }
const r2 = await rig()
check(r2 && r2.boost === 0, `Boost camera kick would not reach 0 (got ${r2 && r2.boost})`)
check((await valueOf('Boost camera kick')) === 'Off', 'a zeroed kick dial must read "Off"')
check(
  r2 && r2.tunnel === r0.tunnel,
  `zeroing the camera kick must NOT touch the tunnel (got ${r2 && r2.tunnel})`,
)
// At an end stop the button is aria-disabled, which also takes it out of the
// gamepad walk -- assert the state rather than trusting it.
check(
  await minus('Boost camera kick').getAttribute('aria-disabled') === 'true',
  'the minus button must report itself disabled at the bottom stop',
)
// And the tunnel has real travel left ABOVE its default -- a dial whose
// default is its maximum is what started this.
for (let i = 0; i < 4; i++) { await activate(plus('Tunnel vision')).catch(() => {}) }
const r2b = await rig()
check(
  r2b && r2b.tunnel > r0.tunnel,
  `the tunnel dial must have headroom above its default (got ${r2b && r2b.tunnel})`,
)
for (let i = 0; i < 4; i++) { await activate(minus('Tunnel vision')).catch(() => {}) }

await shot('2-changed')

// --- it survives a reload --------------------------------------------------
const stored = await page.evaluate(() => localStorage.getItem('spacegen.settings'))
const parsed = JSON.parse(stored || '{}')
check(!!parsed.camera, 'nothing was persisted under `camera`')
check(parsed.camera && parsed.camera.boost === 0, 'the boost choice was not persisted')
// Only the keys that moved: a player who never touches a row must keep
// following the authored default when it is retuned.
check(
  parsed.camera && !('height' in parsed.camera) && !('angle' in parsed.camera),
  `untouched rows were persisted too: ${JSON.stringify(parsed.camera)}`,
)

await page.reload({ waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(2200)
await page.evaluate(() => { if (window.__GAME__) window.__GAME__.maxSubSteps = 400 })
await clickText(['PLAY NOW', 'PLAY', 'Play'])
await page.waitForTimeout(1200)
await page.waitForSelector('.sg-screen--track .sg-card--track', { state: 'visible', timeout: 20000 })
await activate(page.locator('.sg-screen--track .sg-btn--start'))
await page.waitForSelector('.sg-screen--garage .sg-btn--start', { state: 'visible', timeout: 20000 })
await page.waitForTimeout(500)
await clickText(['START RACE', 'START', 'RACE', 'Start Race'])
await page.waitForTimeout(2500)
const r3 = await rig()
check(
  r3 && Math.abs(r3.distance - r1.distance) < 1e-6 && r3.boost === 0,
  `the rig did not survive a reload: ${JSON.stringify(r3)}`,
)

// --- reset -----------------------------------------------------------------
await activate(page.locator(GEAR).first())
await page.waitForSelector('.sgset__dialog', { state: 'visible', timeout: 8000 })
await page.waitForTimeout(400)
const reset = page.locator('button[aria-label="Reset camera to defaults"]').first()
check(await reset.count() > 0, 'no reset control')
check(
  await reset.getAttribute('aria-disabled') !== 'true',
  'the reset must be live once something has been changed',
)
await activate(reset)
await page.waitForTimeout(250)
const r4 = await rig()
// AGAINST THE RIG AS IT BOOTED, not against literals. The first version of
// this check hardcoded `boost === 1` and failed the moment the default moved
// to 1.5 -- reporting a broken reset when the reset was perfect. A probe that
// re-states the values it is testing will do that every single time they are
// retuned, which is precisely when you least want a false alarm.
check(
  r4 && JSON.stringify(r4) === JSON.stringify(r0),
  `reset did not restore the boot rig:\n    was   ${JSON.stringify(r0)}\n    after ${JSON.stringify(r4)}`,
)
check(
  await reset.getAttribute('aria-disabled') === 'true',
  'the reset must go dead once everything is back to stock',
)

// --- the rows fit the viewport --------------------------------------------
const overflow = await page.evaluate(() => {
  const out = []
  for (const r of document.querySelectorAll('.sgset-sec')) {
    if (!/Camera/.test(r.querySelector('.sgset-sec__title')?.textContent || '')) continue
    for (const row of r.querySelectorAll('.sgset-row')) {
      const b = row.getBoundingClientRect()
      const g = row.querySelector('.sgset-step')
      if (!g) continue
      const gb = g.getBoundingClientRect()
      if (gb.right > b.right + 1 || gb.width < 60) {
        out.push(`${row.textContent.slice(0, 22)}: grp ${gb.width.toFixed(0)}px`)
      }
    }
  }
  return out
})
check(overflow.length === 0, `stepper overflows its row: ${overflow.join('; ')}`)

await shot('3-reset')

console.log(`\n=== CAMERA UI (${label}, ${viewport.width}x${viewport.height}) ===`)
console.log('defaults ', JSON.stringify(r0))
console.log('changed  ', JSON.stringify(r1))
console.log('boost off', JSON.stringify(r2))
console.log('reloaded ', JSON.stringify(r3))
console.log('reset    ', JSON.stringify(r4))
console.log('stored   ', stored)
console.log('errors   ', errors.length, errors.slice(0, 3))
if (errors.length) fail.push(`${errors.length} console errors`)
console.log(fail.length ? `\nFAILED:\n  ${fail.join('\n  ')}` : '\nCAMERA UI PASSED')
await browser.close(); server.close()
process.exit(fail.length ? 1 : 0)
