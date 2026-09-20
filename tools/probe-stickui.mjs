/**
 * THE TWO STEERING DIALS AND THE TRY PAD, DRIVEN THE WAY A PLAYER DRIVES THEM.
 *
 *   npx tsx tools/probe-stickui.mjs            phone landscape (844x390)
 *   npx tsx tools/probe-stickui.mjs --portrait phone portrait  (390x844)
 *   npx tsx tools/probe-stickui.mjs --tablet   iPad landscape  (1180x820)
 *
 * TSX, NOT NODE, AND IT WILL NOT RUN UNDER NODE. Same trap as probe-netcode
 * and probe-migrate: this imports a real `.ts` module whose own imports carry
 * no extensions, so plain node dies with ERR_MODULE_NOT_FOUND naming a path
 * that obviously exists. It stays .mjs so it is not dragged under `tsc
 * --noEmit` and made to grow twenty type annotations of pure ceremony; the
 * typed probe in this pair is probe-stick.ts.
 *
 * IT IMPORTS THE MAPPING BECAUSE IT USED TO TRANSCRIBE IT. The numbers this
 * checks the try pad against were typed in by hand from a run of probe-stick,
 * under a comment claiming they came from `stickSteerFrom`. They did not, and
 * when the mapping changed they stayed behind and the probe reported the
 * CORRECT pad as broken -- five red lines, all of them the instrument. An
 * instrument that measures the thing next to the thing it claims to measure
 * is worse than no instrument.
 *
 * steering.test.ts proves the MAPPING: the rim lock, the overtravel band, what
 * each dial does to the curve, that a resting thumb steers nothing. None of
 * that touches a button. This opens the real settings panel in a real browser
 * at a real viewport, taps the real steppers, DRAGS THE REAL TRY PAD, and
 * checks three things a unit test structurally cannot:
 *
 *   1. The rows are on screen when the player is on the stick and gone when
 *      they are not. A settings row that only appears for one control is a
 *      row that is easy to ship permanently hidden -- or permanently visible
 *      to a keyboard player who has no pad at all.
 *   2. The try pad reports the same lock the mapping does. It is the one piece
 *      of this work whose whole job is to be trustworthy: a try pad that
 *      disagrees with the car teaches a feel the car does not have. So the
 *      probe pushes a thumb an exact number of px and compares what the pad
 *      says against what stickSteerFrom says, THROUGH THE PAGE.
 *   3. The choice survives a reload, which is the half of a settings system
 *      that is easy to ship broken and impossible to notice in a unit test.
 *
 * It also photographs the section at each form factor, because "does the
 * 184px try pad fit on a landscape phone" is not a question anything but an
 * eye can answer.
 */
import { chromium } from 'playwright'
// tsx resolves the extensionless .ts import; plain JS in this file, though
// -- see the header. No annotations, no `type` imports.
import { stickSteerFrom } from '../src/game/touchControls'
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

const MODE = process.argv.includes('--tablet') ? 'tablet'
  : process.argv.includes('--portrait') ? 'portrait' : 'landscape'
const VP = MODE === 'tablet' ? { width: 1180, height: 820 }
  : MODE === 'portrait' ? { width: 390, height: 844 }
    : { width: 844, height: 390 }

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist'],
})
const ctx = await browser.newContext({
  viewport: VP, hasTouch: true, isMobile: true, deviceScaleFactor: 1,
})
const page = await ctx.newPage()
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message)))

await mkdir(new URL('../shots/', import.meta.url).pathname, { recursive: true })
const shot = (n) => page.screenshot({
  path: new URL(`../shots/stickui-${MODE}-${n}.png`, import.meta.url).pathname,
})

const fail = []
const check = (ok, msg) => { if (!ok) fail.push(msg); return ok }

// --- into a race, which is where the gear icon lives -----------------------
const clickText = async (pats) => {
  for (const p of pats) {
    const el = page.locator(`text=${p}`).first()
    if (await el.count() && await el.isVisible().catch(() => false)) {
      await el.tap({ timeout: 8000 }).catch(() => {})
      return p
    }
  }
  return null
}
await page.goto(url, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(2200)
await page.evaluate(() => { if (window.__GAME__) window.__GAME__.maxSubSteps = 400 })
await clickText(['PLAY NOW', 'PLAY'])
await page.waitForTimeout(1200)
await page.waitForSelector('.sg-screen--track .sg-card--track', { state: 'visible', timeout: 20000 })
await page.locator('.sg-screen--track .sg-btn--start').first().tap()
await page.waitForSelector('.sg-screen--garage .sg-btn--start', { state: 'visible', timeout: 20000 })
await page.waitForTimeout(500)
await clickText(['START RACE', 'START'])
await page.waitForTimeout(2500)

const openPanel = async () => {
  const gear = page.locator('button.sg-tools__btn[aria-label="Settings and controls"]').first()
  await gear.tap({ timeout: 8000 })
  await page.waitForSelector('.sgset__dialog', { state: 'visible', timeout: 8000 })
  await page.waitForTimeout(350)
}

// --- the rows follow the live scheme ---------------------------------------
//
// Keyboard first: the game boots into whatever was persisted, and a row that
// is visible to a player with no touch pad at all is the failure mode worth
// checking before anything else.
await page.evaluate(() => { window.__GAME__.input.setScheme('keyboard') })
await openPanel()
const sec = page.locator('.sgset-sec').filter({ hasText: 'Driving' }).first()
check(await sec.count() > 0, 'no Driving section')
const rowOf = (name) => sec.locator('.sgset-row').filter({
  has: page.locator('.sgset-row__k', { hasText: new RegExp(`^${name}$`) }),
}).first()
const gainRow = rowOf('Steering sensitivity')
const throwRow = rowOf('Pad size')
const tryRow = sec.locator('.sgset-try').first()
check(await gainRow.count() > 0, 'no Steering sensitivity row in the DOM at all')
check(!(await gainRow.isVisible()), 'sensitivity row is visible under keyboard')
check(!(await tryRow.isVisible()), 'try pad is visible under keyboard')

for (const [scheme, want] of [['tilt', false], ['buttons', false], ['stick', true]]) {
  await page.evaluate((s) => { window.__GAME__.input.setScheme(s) }, scheme)
  await page.waitForTimeout(200)
  const vis = await gainRow.isVisible()
  check(vis === want, `sensitivity row ${vis ? 'visible' : 'hidden'} under ${scheme}`)
}
check(await throwRow.isVisible(), 'pad size row hidden under stick')
check(await tryRow.isVisible(), 'try pad hidden under stick')

// The Driving section, at this form factor, with the stick selected.
await sec.scrollIntoViewIfNeeded()
await page.waitForTimeout(200)
await shot('driving')

// --- the steppers move the pad ---------------------------------------------
const valOf = (row) => row.locator('.sgset-step__val').first().textContent()
// Stops at an end stop rather than timing out on it: the panel marks a spent
// stepper button aria-disabled, which is exactly what takes it out of the
// dialog's focus order, and Playwright will not tap one. A probe that has to
// count steps to avoid the floor cannot then be used to FIND the floor.
const bump = async (row, dir, n) => {
  const b = row.locator(dir > 0 ? '.sgset-step__btn--up' : '.sgset-step__btn--dn').first()
  for (let i = 0; i < n; i++) {
    if (await b.getAttribute('aria-disabled') === 'true') return i
    await b.tap()
    await page.waitForTimeout(60)
  }
  return n
}
const tune = () => page.evaluate(() => window.__GAME__.input.stickTune)

check((await valOf(gainRow)).trim() === '1.00×', `gain starts at ${await valOf(gainRow)}`)
check((await valOf(throwRow)).trim() === '1.00×', `throw starts at ${await valOf(throwRow)}`)

await bump(gainRow, 1, 4)
await bump(throwRow, 1, 8)
const t1 = await tune()
check(Math.abs(t1.gain - 1.2) < 1e-6, `gain is ${t1.gain} after 4 up, want 1.20`)
check(Math.abs(t1.throw - 1.4) < 1e-6, `throw is ${t1.throw} after 8 up, want 1.40`)
check((await valOf(gainRow)).trim() === '1.20×', `gain reads ${await valOf(gainRow)}`)

// THE GEOMETRY LINE, AND THE TWO DIALS HAVE OPPOSITE JOBS IN IT.
//
// It used to read three ways and the gain dial picked between them, which is
// how this probe reported the defect: below 1.00 the line said full lock was
// "out of reach", and at 1.25 and up it said full lock arrived BEFORE the knob
// pinned. Both were true, and both were a settings row explaining the damage
// it had just done -- gain scaled the pad's output and clamped it, so the
// slider was a handicap with a preference's label.
//
// Gain reshapes the response curve now and moves neither end of the travel, so
// the line is one sentence and the STRONGER check is that gain cannot change
// it at all. Throw is what moves it. Anything else is the old law creeping
// back, and it would be invisible in a unit test of the mapping because the
// mapping would be right -- it is the panel that would be lying.
const geomText = () => tryRow.locator('.sgset-try__geom').first().textContent()
const atThrow14 = await geomText()
check(
  /^Knob stops at 41px of thumb, full lock at 66px\. Ignores a thumb inside 3\.0px\.$/
    .test(atThrow14.trim()),
  `geometry line says "${atThrow14}"`,
)

// End stops: the minus button goes aria-disabled at the floor, which is also
// what takes it out of the dialog's focus order.
const steps = await bump(gainRow, -1, 40)
const t2 = await tune()
check(Math.abs(t2.gain - 0.5) < 1e-6, `gain floor is ${t2.gain}, want 0.50`)
check(steps === 14, `took ${steps} steps from 1.20 to the floor, want 14`)
check(
  await gainRow.locator('.sgset-step__btn--dn').first().getAttribute('aria-disabled') === 'true',
  'minus is still enabled at the gain floor',
)
check((await geomText()).trim() === atThrow14.trim(), `gain floor moved the line: "${await geomText()}"`)
await bump(gainRow, 1, 20)
check(Math.abs((await tune()).gain - 1.4) < 1e-6, `gain ceiling is ${(await tune()).gain}`)
check((await geomText()).trim() === atThrow14.trim(), `gain ceiling moved the line: "${await geomText()}"`)
await bump(gainRow, -1, 8)
check(Math.abs((await tune()).gain - 1) < 1e-6, 'gain does not come back to 1.00')
check((await geomText()).trim() === atThrow14.trim(), `back at 1.00: "${await geomText()}"`)
// And throw DOES move it, so the assertion above is a fact about gain rather
// than a line that never changes.
await bump(throwRow, -1, 8)
check(Math.abs((await tune()).throw - 1) < 1e-6, 'throw does not come back to 1.00')
check(
  /^Knob stops at 29px of thumb, full lock at 47px\. Ignores a thumb inside 3\.0px\.$/
    .test((await geomText()).trim()),
  `at throw 1.00: "${await geomText()}"`,
)
await bump(throwRow, 1, 8)

await shot('stepped')

// --- the try pad agrees with the mapping -----------------------------------
//
// THE ONE MEASUREMENT THIS PROBE EXISTS FOR. Push a thumb an exact number of
// px across the pad and compare the number it prints against the number the
// shipping mapping returns for the same displacement. They are the same
// function, so any disagreement is the wiring: a stale tune, a rect read at
// the wrong moment, an anchor that moved.
const surf = tryRow.locator('.sgset-try__surf').first()
const readLock = () => tryRow.locator('.sgset-try__val').first().textContent()

/**
 * Anchor in the middle of the pad and push (dx, dy). Returns nothing; checks
 * what the pad printed against `want`.
 *
 * The box is re-read every time. Tapping a stepper can scroll the panel, and
 * a stale box puts the press somewhere that is not the pad -- which is how
 * this probe first reported that the pad ignored every push, when what it was
 * actually doing was pressing the row above it.
 */
const push = async (dx, dy, want, label) => {
  await surf.scrollIntoViewIfNeeded()
  await page.waitForTimeout(80)
  const b = await surf.boundingBox()
  if (!check(b !== null, `${label}: try pad has no box`)) return
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + dx, cy + dy, { steps: 6 })
  await page.waitForTimeout(90)
  const got = (await readLock()).replace('−', '-').trim()
  const over = await surf.evaluate((n) => n.style.getPropertyValue('--over'))
  await page.mouse.up()
  await page.waitForTimeout(60)
  check(
    Math.abs(Number(got) - want) < 0.015,
    `${label} (dx ${dx}): pad says ${got}, mapping says ${want.toFixed(2)}`,
  )
  return Number(over)
}

// At throw 1.40 the rim is 40.6px of thumb and full lock is 65.8px. Every
// number below is ASKED of stickSteerFrom at that tune -- see the header for
// what happened the one time they were typed in instead.
const T14 = { gain: 1, throw: 1.4 }
const want = (dx) => stickSteerFrom(dx, T14)
await push(0, 0, want(0), 'anchor')
await push(20, 0, want(20), '20px right')
await push(-20, 0, want(-20), '20px left')
await push(41, 0, want(41), 'at the rim')
await push(80, 0, want(80), 'past the band')
// THE BUG ITSELF, THROUGH THE PAGE. A thumb dragged far past the edge must
// still read full lock and no more, and the anchor must not have followed it.
// Clamped into the viewport because a press outside it is not a press; even
// clamped this is three times the whole 66px travel.
{
  const b = await surf.boundingBox()
  const far = Math.floor(Math.min(240, VP.width - (b.x + b.width / 2) - 12))
  await push(far, 0, want(far), 'dragged out of the pad entirely')
  check(want(far) === 1, `the far push is not at full lock: ${want(far)}`)
}
// And dy must not touch the steering, however far off-axis the push is.
await push(41, 45, want(41), 'rim, 45px off-axis')
await push(41, -45, want(41), 'rim, 45px off-axis the other way')

// A held drag, photographed mid-gesture at the strain. 52px of a 40.6-to-65.8
// band is 0.45 of the way across it.
{
  await surf.scrollIntoViewIfNeeded()
  await page.waitForTimeout(80)
  const b = await surf.boundingBox()
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 52, cy + 12, { steps: 8 })
  await page.waitForTimeout(150)
  await shot('strained')
  const over = await surf.evaluate((n) => n.style.getPropertyValue('--over'))
  check(Number(over) > 0.4 && Number(over) < 0.5, `strain is ${over} at 52px, want ~0.45`)
  check(await surf.evaluate((n) => n.classList.contains('is-over')), 'no is-over class past the rim')
  await page.mouse.up()
}

// --- it survives a reload --------------------------------------------------
await page.locator('.sgset__close').first().tap()
await page.waitForTimeout(300)
await page.reload({ waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(2600)
const after = await page.evaluate(() => window.__GAME__.input.stickTune)
check(Math.abs(after.gain - 1) < 1e-6, `gain after reload is ${after.gain}, want 1.00`)
check(Math.abs(after.throw - 1.4) < 1e-6, `throw after reload is ${after.throw}, want 1.40`)
// And a value the panel never wrote, because it was on the default, must NOT
// be in the record -- that is what lets a later retune of the default reach a
// player who never touched the dial.
const raw = await page.evaluate(() => localStorage.getItem('sgr.input.v1'))
check(!/stickGain/.test(raw), 'an untouched gain was written to storage anyway')
check(/stickThrow/.test(raw), 'a moved throw was not written to storage')

// --- report ----------------------------------------------------------------
console.log(`\nSTICK SETTINGS — ${MODE} ${VP.width}x${VP.height}`)
console.log(`  shots/stickui-${MODE}-{driving,stepped,strained}.png`)
console.log(`  stored: ${raw}`)
if (errors.length) console.log('  page errors:\n    ' + errors.join('\n    '))
if (fail.length) {
  console.log('\n  FAIL')
  for (const f of fail) console.log('    - ' + f)
} else {
  console.log('\n  PASS — rows follow the scheme, the pad agrees with the mapping,')
  console.log('         the anchor holds off the panel, the choice survives a reload.')
}
console.log('')

await browser.close()
server.close()
process.exit(fail.length || errors.length ? 1 : 0)
