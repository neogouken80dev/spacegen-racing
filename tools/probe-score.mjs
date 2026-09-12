/**
 * DOES THE SCORE ACTUALLY MOVE ON SCREEN?
 *
 * tests/score.test.ts proves the arithmetic. That is a completely separate
 * claim from "a number reached the player", and the gap between them is where
 * the whole feature can quietly not exist: a scorer wired to the wrong event
 * list, a HUD never told to become visible, a widget mounted into a container
 * that is display:none, a counter that chases a target nothing updates.
 *
 * The audio system shipped with exactly that failure a day ago -- correct
 * planner, correct tests, and an empty array handed to it every frame. Silence
 * and a motionless counter are both invisible to every other gate this repo
 * has: no console error, no visual diff, no determinism change. So this probe
 * DRIVES A REAL DRIFT with the keyboard and reads the DOM back.
 *
 * IT WAITS ON SIM TIME, NEVER WALL CLOCK. Under SwiftShader this renderer runs
 * below 1fps, so ten seconds of wall clock is about one second of race -- all
 * of it countdown, where a score of zero is the correct answer and a wall-clock
 * gate would "fail" a working build.
 *
 *   node tools/probe-score.mjs
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
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

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist'],
})
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

await page.goto(url, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(2500)

// Raise the sub-step ceiling so sim time advances usefully per rendered frame.
await page.evaluate(() => { if (window.__GAME__) window.__GAME__.maxSubSteps = 400 })
await page.evaluate(() => { window.__GAME__ && window.__GAME__.startRace() })

const sim = () => page.evaluate(() => {
  const g = window.__GAME__
  const s = g && g.race && g.race.state
  if (!s) return { p: 'none', t: 0, v: 0, tier: -2, side: 0 }
  const r = s.racers[g.localId]
  return {
    p: s.phase, t: s.time, v: Math.hypot(r.vel.x, r.vel.z),
    tier: r.driftTier, side: r.driftSide,
  }
})

/** The score widget, as the player sees it. */
const readHud = () => page.evaluate(() => {
  const root = document.querySelector('.sg-score')
  if (!root) return { missing: true }
  const val = document.querySelector('.sg-score__value')
  const combo = document.querySelector('.sg-score__combo')
  const rate = document.querySelector('.sg-score__rate')
  const cs = getComputedStyle(root)
  const b = root.getBoundingClientRect()
  return {
    missing: false,
    hidden: root.hidden,
    display: cs.display,
    opacity: +cs.opacity,
    // A widget can be "not hidden" and still be zero pixels, or parked off
    // screen, or inside a display:none ancestor. Only the rect proves it is on
    // the glass.
    w: Math.round(b.width), h: Math.round(b.height),
    top: +(b.y / 720).toFixed(3),
    text: val ? val.textContent : null,
    value: val ? parseInt((val.textContent || '0').replace(/\D/g, ''), 10) : -1,
    comboShown: combo ? !combo.hidden : false,
    rateShown: rate ? !rate.hidden : false,
    rung: root.dataset.rung ?? null,
    hot: root.dataset.hot ?? null,
    // THE AWARD RECEIPTS ARE THE ONLY PROOF EVENTS ARRIVE.
    //
    // Drift-hold accrual reads driftSide/driftTime straight off the racer, so
    // the counter climbs during a slide even if the event list handed to the
    // scorer is EMPTY -- which is precisely how the audio system shipped
    // broken. The first version of this probe passed a deliberate sabotage that
    // cut events entirely, because a rising number was all it looked at. Only
    // driftStart, driftRelease, chain, knock, lap and finish produce a popup,
    // so a visible popup is the thing that cannot happen without events.
    pops: Array.from(document.querySelectorAll('.sg-score__pop'))
      .filter((e) => !e.hidden)
      .map((e) => e.textContent),
  }
})

// Wait for the lights, on SIM phase rather than a timer.
for (let i = 0; i < 240; i++) {
  if ((await sim()).p === 'racing') break
  await page.waitForTimeout(500)
}
const atStart = await readHud()

// Get up to speed, then hold a slide -- the same keys the cheer harness uses.
await page.keyboard.down('KeyW')
for (let i = 0; i < 240; i++) {
  const s = await sim()
  if (s.p === 'racing' && s.v > 30) break
  await page.waitForTimeout(400)
}
const beforeDrift = await readHud()

await page.keyboard.down('KeyD')
await page.keyboard.down('ShiftLeft')

// Hold the slide until the SIM says enough race has passed, sampling the HUD.
const samples = []
let sawCombo = false
let sawRate = false
let sawHot = false
const popsSeen = new Set()
let shotTaken = false
let peak = 0
const t0 = (await sim()).t
for (let i = 0; i < 400; i++) {
  const s = await sim()
  const h = await readHud()
  samples.push({ t: +s.t.toFixed(2), tier: s.tier, side: s.side, v: h.value, combo: h.comboShown })
  if (h.comboShown) sawCombo = true
  if (h.rateShown) sawRate = true
  if (h.hot === '1') sawHot = true
  for (const p of h.pops || []) if (p) popsSeen.add(p.split('  ')[0])
  if (h.value > peak) peak = h.value
  if (s.t - t0 > 22) break
  // One frame of the widget at full tilt, for a human to look at. Taken while
  // a combo is live rather than at rest, because at rest it is one grey zero.
  if (h.comboShown && h.value > 800 && !shotTaken) {
    shotTaken = true
    await page.screenshot({ path: new URL('../shots/score-hud.png', import.meta.url).pathname })
  }
  await page.waitForTimeout(150)
}
await page.keyboard.up('ShiftLeft')
await page.keyboard.up('KeyD')
await page.keyboard.up('KeyW')

const simSeconds = +((await sim()).t - t0).toFixed(1)
const driftFrames = samples.filter((s) => s.side !== 0).length

console.log('at start   :', JSON.stringify(atStart))
console.log('before drift:', JSON.stringify(beforeDrift))
console.log(`raced ${simSeconds}s of sim, ${driftFrames}/${samples.length} samples sliding`)
console.log('peak score :', peak, ' combo shown:', sawCombo, ' rate shown:', sawRate, ' hot:', sawHot)
console.log('award kinds seen:', [...popsSeen].join(', ') || '(none)')

if (atStart.missing) errors.push('the score widget is not in the DOM at all')
else {
  if (atStart.w === 0 || atStart.h === 0) errors.push('the score widget has no box on screen')
  if (atStart.display === 'none') errors.push('the score widget is display:none during a race')
  if (atStart.top > 0.3) errors.push(`the score sits at ${atStart.top} of the viewport, not near the top`)
}
if (simSeconds < 8) {
  errors.push(`only ${simSeconds}s of race ran -- the sample proves nothing either way`)
} else {
  if (peak <= 0) errors.push('the score never moved off zero during a whole race')
  if (driftFrames === 0) errors.push('never actually drifted -- the drive script did not work')
  else {
    if (!sawCombo) errors.push('drifted, but the combo chip never appeared')
    if (!sawRate) errors.push('drifted, but the live per-second rate never appeared')
    if (!sawHot) errors.push('drifted, but the counter never entered its hot state')
    // The one that actually proves the wiring. See the note in readHud.
    if (popsSeen.size === 0) {
      errors.push(
        'the counter moved but NO award ever landed -- drift-hold reads the ' +
        'racer directly, so this is what a severed event list looks like',
      )
    }
  }
}

console.log(`\nerrors: ${errors.length}`, errors.slice(0, 5))
await browser.close()
server.close()
process.exit(errors.length ? 1 : 0)
