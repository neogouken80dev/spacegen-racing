/**
 * Real-browser smoke test. Loads the built game in Chromium with WebGL, drives
 * it through title -> track -> garage -> race, and asserts it actually renders
 * and simulates. A clean typecheck proves nothing about whether it runs.
 *
 *   node tools/smoke.mjs [--mobile] [--track=<id>] [--reduced-motion]
 *
 * --track drives the real track-select screen -- it picks the circuit by the
 * name on its card, the same way a player does -- and then asserts the sim is
 * running the track that was asked for. Defaults to rustfall.
 *
 *   node tools/smoke.mjs --splits [--mobile] [--track=<id>] [--reduced-motion]
 *
 * --splits closes two real laps through resolveLaps and photographs the
 * top-left lap list, then finishes the race and checks the list leaves with
 * the rest of the position block.
 *
 *   node tools/smoke.mjs --glare [--mobile] [--track=<id>] [--tag=<name>]
 *                        [--attrib|--attrib-min] [--tier=<tier>] [--drift]
 *                        [--chassis=<id>]
 *                        [--glare-intensity=<glare>,<screen>]
 *
 * --drift appends the DRIFT LADDER to the probe: a held slide at each of the
 * four charge tiers, a tier transition firing twice a second, and a tier-3
 * slide cashed in under a full boost. The rail pins driftSide, driftTier,
 * driftCharge, driftInward and a real slide angle, so these rows photograph the
 * drift VFX rather than a car travelling in a straight line with a flag set.
 *
 * --glare swaps the drive script for the READABILITY PROBE: it pins the local
 * racer to the centreline of the worst-lit stretch of the circuit at a fixed
 * speed with a fixed boost, samples several frames per scenario, and reports
 * how much of the frame is clipped to white and how much of the CAR survives.
 * That is the measurement the "bloom erases the track" bug is argued from --
 * "it looks too bright" is not falsifiable, "62% of the car's pixels are pure
 * white" is. --attrib additionally turns each light source off one at a time
 * so the blowout can be attributed instead of guessed at.
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { extname, join } from 'node:path'

/** Decode a PNG with the system python+pillow and summarise its content. */
function analysePng(buf) {
  const tmp = '/tmp/_sg_shot.png'
  execFileSync('/bin/sh', ['-c', `cat > ${tmp}`], { input: buf })
  const out = execFileSync('python3', ['-c', `
from PIL import Image
im = Image.open('${tmp}').convert('RGB').resize((192,108))
px = list(im.getdata())
n = len(px)
nb = sum(1 for p in px if sum(p) > 30)
avg = tuple(sum(p[i] for p in px)//n for i in range(3))
colors = len(set((p[0]>>4,p[1]>>4,p[2]>>4) for p in px))
bright = sum(1 for p in px if sum(p) > 600)
print(f'{nb*100/n:.1f} {avg[0]} {avg[1]} {avg[2]} {colors} {bright*100/n:.1f}')
`]).toString().trim().split(' ')
  return {
    nonBlackPct: +out[0], avgRGB: [+out[1], +out[2], +out[3]],
    distinctColors: +out[4], brightPct: +out[5],
  }
}

/**
 * Readability metrics for one frame.
 *
 * `blownPct` is the number the glare work turns on: the share of pixels where
 * EVERY channel is >= 250, i.e. clipped white carrying no information at all.
 * `brightPct` (sum > 600) is kept for continuity with the older reports, but it
 * counts a perfectly readable sunlit wall as "bright", which is why it never
 * caught this bug.
 *
 * `rect` (pixels, [x0,y0,x1,y1]) is the local car's projected bounding box. A
 * car you can see has edges inside that box; a car that has been erased by its
 * own boost plume is a flat white patch, so `car.gradient` -- mean absolute
 * luminance step between neighbouring pixels -- collapses toward zero at the
 * same time as `car.blownPct` climbs.
 */
function analyseFrame(buf, rect) {
  const tmp = '/tmp/_sg_frame.png'
  execFileSync('/bin/sh', ['-c', `cat > ${tmp}`], { input: buf })
  const out = execFileSync('python3', ['-c', `
import sys, json
import numpy as np
from PIL import Image

a = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(np.int16)
H, W, _ = a.shape
mn = a.min(axis=2)
sm = a.sum(axis=2)
lum = 0.299 * a[:, :, 0] + 0.587 * a[:, :, 1] + 0.114 * a[:, :, 2]

def pc(m):
    return round(float(np.mean(m)) * 100.0, 2)

def grad(L):
    if L.shape[0] < 2 or L.shape[1] < 2:
        return 0.0
    return round(float((np.abs(np.diff(L, axis=0)).mean() + np.abs(np.diff(L, axis=1)).mean()) * 0.5), 2)

res = {
    'w': W, 'h': H,
    'blownPct': pc(mn >= 250),
    'whitePct': pc(mn >= 232),
    'brightPct': pc(sm > 600),
    'nonBlackPct': pc(sm > 30),
    'avgRGB': [int(a[:, :, i].mean()) for i in range(3)],
    'meanLum': round(float(lum.mean()), 1),
    'gradient': grad(lum),
}

# The lower-middle third: the road surface, the racing line and the barriers
# the player actually steers by.
x0, x1, y0, y1 = int(W * 0.25), int(W * 0.75), int(H * 0.55), H
res['roadBlownPct'] = pc(mn[y0:y1, x0:x1] >= 250)
res['roadWhitePct'] = pc(mn[y0:y1, x0:x1] >= 232)
res['roadGradient'] = grad(lum[y0:y1, x0:x1])

if len(sys.argv) > 2 and sys.argv[2]:
    cx0, cy0, cx1, cy1 = [int(v) for v in sys.argv[2].split(',')]
    cx0 = max(0, min(W - 1, cx0)); cx1 = max(cx0 + 1, min(W, cx1))
    cy0 = max(0, min(H - 1, cy0)); cy1 = max(cy0 + 1, min(H, cy1))
    cm, cl = mn[cy0:cy1, cx0:cx1], lum[cy0:cy1, cx0:cx1]
    res['car'] = {
        'rect': [cx0, cy0, cx1, cy1],
        'blownPct': pc(cm >= 250),
        'whitePct': pc(cm >= 232),
        'meanLum': round(float(cl.mean()), 1),
        'std': round(float(cl.std()), 2),
        'gradient': grad(cl),
    }

print(json.dumps(res))
`, tmp, rect ? rect.join(',') : '']).toString().trim()
  return JSON.parse(out)
}

const ROOT = new URL('../dist/', import.meta.url).pathname
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }

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
const port = server.address().port
const url = `http://127.0.0.1:${port}/`

const viewport = process.argv.includes('--mobile')
  ? { width: 844, height: 390 } : { width: 1440, height: 810 }
const label = process.argv.includes('--mobile') ? 'mobile' : 'desktop'

// Emulate the OS "reduce motion" preference for the whole run. The two visual
// intensity controls start lower under it, and "it defaults correctly" is only
// checkable by actually being that user.
const REDUCED = process.argv.includes('--reduced-motion')
const GLARE = process.argv.includes('--glare')
/** Add the drift ladder to the glare probe's scenario list. */
const DRIFT = process.argv.includes('--drift')
/**
 * --ending: the FINISH PROBE.
 *
 * Racing three real laps in a browser running at ~1 fps under SwiftShader is
 * 11 wall minutes of nothing, so this shortcuts to the moment that matters:
 * it shoves the local racer's progress up to just short of the line, lets the
 * sim carry it across for real, and then photographs the ceremony -- the
 * handover out of the chase rig, the orbit while the field is still out, the
 * field coming in, and the transition into the results screen.
 *
 * The shortcut is a write to `totalS` and nothing else. Everything downstream
 * -- resolveLaps firing, the finish event, finishOrder, the camera handover,
 * the HUD swap, the skip guard -- is the shipping code path.
 *
 *   node tools/smoke.mjs --ending [--mobile] [--track=<id>] [--reduced-motion]
 */
const ENDING = process.argv.includes('--ending')
/**
 * --cheer: the ENCOURAGEMENT PROBE. Drives a real drift up the charge ladder
 * with the keyboard and photographs the callout at each rung and at the
 * cash-in, then reads the banner's position back out of the DOM so "it is not
 * over the racing line" is a measurement rather than an opinion.
 */
const CHEER = process.argv.includes('--cheer')
/**
 * --splits: the LAP SPLIT PROBE.
 *
 * The top-left split list only says anything once laps have actually closed,
 * and three real laps under SwiftShader is eleven wall minutes of nothing. So
 * this shortcuts to the state that matters the same way --ending does: it
 * shoves `totalS` to just short of the line and lets the sim carry the racer
 * over for real, so `resolveLaps` -- the shipping path that writes `lapTimes`,
 * `bestLap` and the `lap` event -- is what fills the widget.
 *
 * It ALSO advances the race clock before each crossing, so the laps land in
 * the GDD's 55-75s design band. A probe that photographed eight-second laps
 * would be checking a layout that never occurs: `0:08.31` and `1:04.90` are
 * different numbers of glyphs, and the whole question here is whether a column
 * of real lap times fits in the corner without reaching the road.
 *
 * The two laps are deliberately different, and the SECOND is the quicker, so
 * the run covers the case the widget is easiest to get wrong in: the fastest
 * lap moving out from under a row that had no gap printed on it and now needs
 * one.
 *
 *   node tools/smoke.mjs --splits [--mobile] [--track=<id>] [--reduced-motion]
 */
const SPLITS = process.argv.includes('--splits')
const ATTRIB = process.argv.includes('--attrib') || process.argv.includes('--attrib-min')
const ATTRIB_MIN = process.argv.includes('--attrib-min')
const GLARE_TAG = (process.argv.find((a) => a.startsWith('--tag=')) ?? '').slice(6)
const GLARE_TIER = (process.argv.find((a) => a.startsWith('--tier=')) ?? '').slice(7)
  || (process.argv.includes('--mobile') ? 'medium' : 'high')
const GLARE_INTENSITY = (() => {
  const a = process.argv.find((x) => x.startsWith('--glare-intensity='))
  if (!a) return null
  const [g, s] = a.slice(18).split(',').map(Number)
  return [Number.isFinite(g) ? g : 1, Number.isFinite(s) ? s : 1]
})()

/**
 * Race a different chassis. The local car is Solaire unless this says
 * otherwise, and Solaire is GROUNDED -- which means the default probe can
 * never photograph what a hover skirt or a flight frame does in a slide, and
 * those are two of the three locomotion classes in the game. Applied by
 * setting the garage selection and restarting the race through the same
 * method the START RACE button calls, so the vehicle visual, the input mode
 * and the sim all agree about what is being driven.
 */
const CHASSIS = (process.argv.find((a) => a.startsWith('--chassis=')) ?? '').slice(10)

const TRACK_NAMES = { rustfall: 'Rustfall', cryostatic: 'Cryostatic', aetherion: 'Aetherion Prime', hollowchoir: 'The Hollow Choir' }
const trackId = (process.argv.find((a) => a.startsWith('--track=')) ?? '--track=rustfall').slice(8)
const trackName = TRACK_NAMES[trackId]
if (!trackName) {
  console.log(`unknown --track=${trackId}; expected one of ${Object.keys(TRACK_NAMES).join(', ')}`)
  process.exit(2)
}
// Rustfall keeps the historical shot names so anything already pointing at
// shots/desktop-4-racing.png still resolves; other tracks get a suffix. The new
// track-select frame is 1b rather than a 2, for the same reason: renumbering the
// race frames to make room would have invalidated every existing reference.
const tag = (trackId === 'rustfall' ? label : `${label}-${trackId}`) + (REDUCED ? '-rm' : '')

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist'],
})
const ctx = await browser.newContext({
  viewport,
  hasTouch: label === 'mobile',
  isMobile: label === 'mobile',
  deviceScaleFactor: 1,
  reducedMotion: REDUCED ? 'reduce' : 'no-preference',
})
const page = await ctx.newPage()

const errors = []
const warnings = []
page.on('console', (m) => {
  const t = m.text()
  if (m.type() === 'error') errors.push(t)
  else if (m.type() === 'warning') warnings.push(t)
})
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message)))

await page.goto(url, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(2500)
// Software rendering runs at ~7fps; without a bigger substep cap the fixed
// timestep accumulator throttles the sim to about half real time and the
// countdown never clears inside the test's waits.
await page.evaluate(() => { if (window.__GAME__) window.__GAME__.maxSubSteps = 400 })

await mkdir(new URL('../shots/', import.meta.url).pathname, { recursive: true })
const shot = (n) => page.screenshot({ path: new URL(`../shots/${tag}-${n}.png`, import.meta.url).pathname })

await shot('1-title')

/**
 * Activate a control the way this device would. On the mobile run that means a
 * real touch, not a synthesised mouse click: the front end is built on <button>
 * and `click`, and tapping is the only way to prove the touch path actually
 * reaches it (a stray `touch-action` or an overlaying element would sail past a
 * mouse-driven test).
 */
const activate = async (loc, timeout = 5000) => {
  if (label === 'mobile') await loc.tap({ timeout })
  else await loc.click({ timeout })
}

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
const t1 = await clickText(['PLAY NOW', 'PLAY', 'Play'])
await page.waitForTimeout(1200)

// --- track select --------------------------------------------------------
// Wait for the screen rather than assuming it: if the track step ever stops
// rendering, this is where the smoke test says so.
await page.waitForSelector('.sg-screen--track .sg-card--track', { state: 'visible', timeout: 15000 })
await page.waitForSelector('.sg-trk__svg', { state: 'visible', timeout: 15000 })
const card = page.locator('.sg-screen--track .sg-card--track').filter({ hasText: trackName }).first()
await activate(card)
// Wait for the screen to actually settle before photographing it, rather than
// guessing a timeout. Picking a card starts a 110ms border-colour transition on
// two cards, and under SwiftShader the frame loop is starved hard enough
// straight after a click that those 110ms can take two wall seconds to tick --
// long enough that a fixed 1.6s wait photographed the OLD card still wearing
// the selected border. Poll the thing that matters instead.
await page.waitForFunction(() => {
  const sel = document.querySelector('.sg-card--track.is-sel')
  const other = document.querySelector('.sg-card--track:not(.is-sel)')
  if (!sel || !other) return false
  const cyan = getComputedStyle(document.documentElement).getPropertyValue('--sg-cyan').trim()
  const norm = (c) => c.replace(/\s/g, '')
  const toRgb = (hex) => {
    const n = parseInt(hex.slice(1), 16)
    return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`
  }
  return norm(getComputedStyle(sel).borderTopColor) === toRgb(cyan)
    && norm(getComputedStyle(other).borderTopColor) !== toRgb(cyan)
}, null, { timeout: 20000 })
// Plus the route sweep (900ms), so the frame is the screen at rest.
await page.waitForTimeout(1000)
await shot('1b-track')

// What the screen believes it is showing, read back from the DOM.
const trackUi = await page.evaluate(() => {
  const sel = document.querySelector('.sg-screen--track .sg-card--track.is-sel')
  const name = sel && sel.querySelector('.sg-card__name')
  const detail = document.querySelector('.sg-screen--track .sg-detail__name')
  return {
    selected: name ? name.textContent : null,
    detail: detail ? detail.textContent : null,
    cards: document.querySelectorAll('.sg-screen--track .sg-card--track').length,
    roadPaths: document.querySelectorAll('.sg-trk__road').length,
    surfaceChips: document.querySelectorAll('.sg-chip--surf').length,
    mixSegs: document.querySelectorAll('.sg-trk__seg').length,
    elevPts: (document.querySelector('.sg-trk__elevLine')?.getAttribute('d') ?? '').length,
    featureChips: document.querySelectorAll('.sg-trk__chips:not(.sg-trk__chips--surf) .sg-chip').length,
    lap: (document.querySelectorAll('.sg-fact__v')[1] || {}).textContent ?? null,
    // The accessibility regression this codebase has already shipped once:
    // an entry animation that leaves the resting state invisible.
    mapOpacity: (() => {
      const svg = document.querySelector('.sg-trk__svg')
      return svg ? +getComputedStyle(svg).opacity : null
    })(),
  }
})

// Targeted rather than text-matched: the track screen deliberately carries a
// control hint next to its primary button, and a loose text match picks the
// hint. Read the label back so the assertion still covers what the player sees.
const toGarage = page.locator('.sg-screen--track .sg-btn--start')
const t2 = (await toGarage.textContent()).trim()
await activate(toGarage)
await page.waitForSelector('.sg-screen--garage .sg-btn--start', { state: 'visible', timeout: 15000 })
await page.waitForTimeout(600)
await shot('2-garage')

const t3 = await clickText(['START RACE', 'START', 'RACE', 'Start Race'])
await page.waitForTimeout(1500)
await shot('3-countdown')

/** Live sim snapshot: phase, race clock, local speed. */
const simState = () => page.evaluate(() => {
  const s = window.__GAME__ && window.__GAME__.race && window.__GAME__.race.state
  if (!s) return { p: 'none', t: 0, v: 0 }
  return { p: s.phase, t: s.time, v: Math.hypot(s.racers[0].vel.x, s.racers[0].vel.z) }
})

// ---------------------------------------------------------------------------
// --glare: the readability probe
// ---------------------------------------------------------------------------
if (GLARE) {
  // Wait for the countdown to clear before pinning anything -- the sim ignores
  // input and holds the racers on the grid until then.
  for (let i = 0; i < 120; i++) {
    if ((await simState()).p === 'racing') break
    await page.waitForTimeout(500)
  }

  if (CHASSIS) {
    await page.evaluate((id) => {
      const g = window.__GAME__
      g.selection.chassisId = id
      g.startRace()
    }, CHASSIS)
    await page.waitForTimeout(2000)
    for (let i = 0; i < 120; i++) {
      if ((await simState()).p === 'racing') break
      await page.waitForTimeout(500)
    }
  }

  // PIN THE QUALITY TIER FIRST. Under SwiftShader the page renders at about
  // 1 fps, so the adaptive scaler drops to `low` within seconds -- which builds
  // no composer at all. A probe that measured that would be photographing a
  // frame with no bloom in it and concluding bloom was fine. Force the tier the
  // device under test would actually run, and park the scaler.
  await page.evaluate((t) => {
    const g = window.__GAME__
    g.setTier(t)
    g.qualityCooldown = 1e9
    g.frameTimes.length = 0
  }, GLARE_TIER)
  await page.waitForTimeout(2500)

  // Install the rail. The probe drives the car along the centreline of the
  // brightest stretch of the circuit at an exact speed with an exact boost, so
  // two runs a code change apart are photographing the same moment rather than
  // two different accidents.
  const pinInfo = await page.evaluate(() => {
    const g = window.__GAME__
    const track = g.track
    const race = g.race
    const st = race.state
    const DT = 1 / 60

    // The worst-lit place on the circuit: an emissive boost strip, and on a
    // track that has a blizzard the windiest one, because the fog, the marker
    // chain and the chevrons are all adding light to the same pixels there.
    let bestI = -1
    let bestScore = -1
    for (let i = 0; i < track.samples.length; i++) {
      const smp = track.samples[i]
      if (!smp.boost) continue
      const score = smp.wind * 10 + 1
      if (score > bestScore) { bestScore = score; bestI = i }
    }
    if (bestI < 0) bestI = 0
    const s0 = (bestI / track.samples.length) * track.length

    // drift / driftTier / driftInward / yawOff / tierPulse pin the SLIDE the
    // same way speed and boost pin the straight-line case. Without them the
    // rail zeroed driftSide every step, so the probe could never photograph the
    // drift VFX at all -- which is the one effect set this codebase has already
    // whited the frame out with twice. tierPulse flips the tier 2 <-> 3 on a
    // cadence so the TIER TRANSITION, historically the worst frame in the game,
    // lands inside the sample window instead of only at the moment of entry.
    const P = {
      enabled: false, s: s0, s0, span: 230, speed: 60, boost: 0, charges: 0,
      fireEvery: 0, fireAcc: 0, fireTier: 3,
      drift: 0, driftTier: -1, driftInward: 0.85, yawOff: 0,
      tierPulse: 0, tierAcc: 0, tierFlip: 0,
    }
    window.__PIN__ = P

    const origStep = race.step.bind(race)
    race.step = function () {
      origStep()
      if (!P.enabled) return
      // The rail runs a fixed-length beat of road and then restarts it. Without
      // the wrap each scenario is photographed further down the lap than the
      // one before it, and a difference between two variants is really a
      // difference between two corners.
      P.s += P.speed * DT
      if (P.s - P.s0 > P.span) {
        P.s = P.s0
        // The rail TELEPORTS the car 230 m backwards here, and the VFX trail
        // history has no idea: without this every ribbon in the game is drawn
        // as a 230 m streak from the car to where it used to be, straight down
        // the middle of the road, and every readability number on every drift
        // row is really measuring that streak. Dropping trailReady makes the
        // ribbons re-seed at the new position on the next frame, which is what
        // a respawn would do.
        const vfx = g.vfx
        if (vfx && vfx.rfx) for (const f of vfx.rfx) f.trailReady = false
        // ...and the chase camera has to be told as well, or it spends the
        // next several seconds flying 230 m up the road to catch up and every
        // frame sampled in the meantime is a photograph of the car as a dot on
        // the horizon rather than of the effect being measured.
        if (g.chase && g.chase.reset) g.chase.reset(st.racers[0])
      }
      P.s %= track.length
      const c = track.posAt(P.s)
      const smp = track.at(P.s)
      const r = st.racers[0]
      r.pos.x = c.x; r.pos.y = c.y + 0.55; r.pos.z = c.z
      // A drifting car is CRABBED: the nose is yawed off the direction of
      // travel. Pinning the yaw to the tangent would have measured a drift
      // whose slide angle is zero, and the arc the trails are supposed to
      // paint is exactly that angle.
      r.yaw = Math.atan2(smp.tangent.x, smp.tangent.z) + P.yawOff * (P.drift || 0)
      r.vel.x = smp.tangent.x * P.speed; r.vel.y = 0; r.vel.z = smp.tangent.z * P.speed
      r.grounded = true; r.altitude = 0; r.airTime = 0; r.vertVel = 0
      r.offTrackTime = 0; r.respawnTime = 0; r.spinTime = 0; r.stunTime = 0
      if (P.drift !== 0) {
        if (P.tierPulse > 0) {
          P.tierAcc += DT
          if (P.tierAcc >= P.tierPulse) { P.tierAcc = 0; P.tierFlip ^= 1 }
        }
        const tier = P.tierPulse > 0 ? (P.tierFlip ? P.driftTier : Math.max(0, P.driftTier - 1))
          : P.driftTier
        const tt = (window.__TUNING__ && window.__TUNING__.drift.tierTimes) || [0.7, 1.5, 2.4, 3.2]
        r.driftSide = P.drift
        r.driftTier = tier
        // Park the charge near the TOP of the band: charge01 -> 1 is where
        // every drift channel peaks, so this is the worst case by construction.
        r.driftCharge = tier < 0 ? tt[0] * 0.5
          : tier >= 3 ? tt[3] + 1.2 : tt[tier] + (tt[tier + 1] - tt[tier]) * 0.92
        r.driftInward = P.driftInward
        r.driftTime = 2.0
      } else {
        r.driftSide = 0; r.driftTier = -1; r.driftCharge = 0; r.driftTime = 0
      }
      r.charges = P.charges
      r.lap = 0; r.finished = false
      if (P.boost > 0) {
        r.boostTime = 1.0; r.boostMag = P.boost; r.boostSource = 'drift'
      } else {
        r.boostTime = 0; r.boostMag = 0; r.boostSource = 'none'
      }
      // Park the field far behind: an AI plume wandering into shot would make
      // every sample a different picture.
      const back = track.posAt((P.s - 420 + track.length) % track.length)
      for (let i = 1; i < st.racers.length; i++) {
        const a = st.racers[i]
        a.pos.x = back.x; a.pos.y = back.y + 0.5; a.pos.z = back.z
        a.vel.x = 0; a.vel.y = 0; a.vel.z = 0
        a.boostTime = 0; a.boostMag = 0; a.boostSource = 'none'
        a.driftSide = 0; a.driftTier = -1
        a.lap = 0; a.finished = false
        a.events.length = 0
      }
      st.phase = 'racing'
      if (P.fireEvery > 0) {
        P.fireAcc += DT
        if (P.fireAcc >= P.fireEvery) {
          P.fireAcc = 0
          r.events.push({ t: 'boost', tier: P.fireTier })
        }
      }
    }

    const smp = track.at(s0)
    return {
      trackLength: Math.round(track.length),
      pinS: Math.round(s0),
      wind: smp.wind, boost: smp.boost, surface: smp.surface,
      width: smp.width,
      samples: track.samples.length,
    }
  })

  /**
   * Isolation toggles. Everything is reached through handles that exist at
   * runtime, so attribution needs no debug build: the scene groups come off the
   * Game, the bloom off the PostFx, and the composite's individual terms are
   * neutralised by rewriting the one line of GLSL that scales them and letting
   * three recompile the material.
   */
  await page.evaluate(() => {
    const g = window.__GAME__
    const post = g.post
    const mat = post ? post.compositeMat : null
    const baseFrag = mat ? mat.fragmentShader : ''
    const SHADER = {
      noLines: ['col += lineCol * line * gate * mask * 0.42;', 'col += lineCol * line * gate * mask * 0.0;'],
      noBlur: ['float blur = rush * rush * 0.34;', 'float blur = 0.0;'],
      noCa: ['float ca = (0.0008 + uBoost * 0.0038 + uHit * 0.0080) * (0.15 + r * 1.7) * uScreen;', 'float ca = 0.0;'],
      noVignette: ['col *= mix(1.0, vig, (0.34 + uBoost * 0.24) * uScreen);', ''],
    }
    window.__ISO__ = {
      missed: [],
      glare: 1,
      base: mat && mat.uniforms.uGlareCeil ? {
        ceil: mat.uniforms.uGlareCeil.value,
        lo: mat.uniforms.uGlareKneeLo.value,
        hi: mat.uniforms.uGlareKneeHi.value,
        floor: mat.uniforms.uGlareFloor.value,
      } : null,
      set(name) {
        // Everything back on first, so the toggles never stack.
        if (mat && this.base) {
          mat.uniforms.uGlareCeil.value = this.base.ceil
          mat.uniforms.uGlareKneeLo.value = this.base.lo
          mat.uniforms.uGlareKneeHi.value = this.base.hi
          mat.uniforms.uGlareFloor.value = this.base.floor
        }
        if (post && post.setIntensity) post.setIntensity(window.__ISO__.glare, 1)
        if (g.vfx) {
          g.vfx.group.visible = true
          if (g.vfx.pMesh) g.vfx.pMesh.visible = true
          if (g.vfx.trailMesh) g.vfx.trailMesh.visible = true
        }
        if (g.trackVis) g.trackVis.group.visible = true
        if (g.envVis) g.envVis.group.visible = true
        for (const rr of g.renderRacers) rr.visual.group.visible = true
        if (post && post.bloom) post.bloom.strength = post.__baseStrength ??
          (post.__baseStrength = post.bloom.strength)
        if (mat && mat.fragmentShader !== baseFrag) {
          mat.fragmentShader = baseFrag
          mat.needsUpdate = true
        }
        if (post && post.bloom) post.bloom.threshold = post.__baseThreshold ??
          (post.__baseThreshold = post.bloom.threshold)
        if (name === 'full' || !name) return true
        if (name === 'noBloom') { if (post && post.bloom) post.bloom.strength = 0; return true }
        // SELF-TEST for the glare budget's reconstruction. Open the ceiling,
        // the knee and the floor right up and the composite must reduce to
        // `base + glare` -- i.e. to the frame as it was before any of this
        // existed. If this row does not match the pre-change numbers, the
        // subtraction that recovers `base` from `scene + glare` is wrong and
        // every other row is measuring an artefact.
        if (name === 'glarePassthrough') {
          if (mat && mat.uniforms.uGlareCeil) {
            mat.uniforms.uGlareCeil.value = 1e6
            mat.uniforms.uGlareKneeLo.value = 1e6
            mat.uniforms.uGlareKneeHi.value = 2e6
            mat.uniforms.uGlareFloor.value = 1
            return true
          }
          window.__ISO__.missed.push(name)
          return false
        }
        if (name === 'bloomHalf') { if (post && post.bloom) post.bloom.strength *= 0.5; return true }
        // Where the bloom energy comes from. The composite renders linear, so
        // raising the threshold past 1.0 excludes everything that is not
        // deliberately HDR -- i.e. everything except the particle system.
        if (name === 'thresh1.2') { if (post && post.bloom) post.bloom.threshold = 1.2; return true }
        if (name === 'thresh2.5') { if (post && post.bloom) post.bloom.threshold = 2.5; return true }
        if (name === 'noVfx') { if (g.vfx) g.vfx.group.visible = false; return true }
        // The two halves of the VFX system, separately. Everything the game
        // throws is either an instanced particle quad or a trail ribbon, and
        // "the VFX did it" is not an attribution when one of them is a pooled
        // spray of a thousand sprites and the other is thirty-six strips of
        // geometry laid along the road.
        if (name === 'noParticles') { if (g.vfx && g.vfx.pMesh) g.vfx.pMesh.visible = false; return true }
        if (name === 'noRibbons') { if (g.vfx && g.vfx.trailMesh) g.vfx.trailMesh.visible = false; return true }
        if (name === 'noTrack') { if (g.trackVis) g.trackVis.group.visible = false; return true }
        if (name === 'noEnv') { if (g.envVis) g.envVis.group.visible = false; return true }
        if (name === 'noCars') {
          for (const rr of g.renderRacers) rr.visual.group.visible = false
          return true
        }
        // Every composite effect at once, through the shipping interface.
        if (name === 'noScreen') { if (post) post.setIntensity(1, 0); return true }
        const s = SHADER[name]
        if (s && mat) {
          if (baseFrag.indexOf(s[0]) < 0) { window.__ISO__.missed.push(name); return false }
          mat.fragmentShader = baseFrag.split(s[0]).join(s[1])
          mat.needsUpdate = true
          return true
        }
        return false
      },
    }
  })

  /** Project the local car's bounding box to pixels, for the "is it there" test. */
  const carRect = () => page.evaluate(() => {
    const g = window.__GAME__
    const cam = g.chase.camera
    const rr = g.renderRacers[g.localId]
    const v = rr.view
    cam.updateMatrixWorld()
    const mv = cam.matrixWorldInverse.elements
    const pr = cam.projectionMatrix.elements
    const cy = Math.cos(v.yaw), sy = Math.sin(v.yaw)
    // Generic hover-racer box; the exact chassis differs by a few centimetres
    // and the rect only has to be the same one before and after.
    const hx = 1.15, hy = 0.75, hz = 2.4
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
    for (let i = 0; i < 8; i++) {
      const lx = (i & 1 ? hx : -hx), ly = (i & 2 ? hy : -hy), lz = (i & 4 ? hz : -hz)
      const wx = v.pos.x + lx * cy + lz * sy
      const wy = v.pos.y + hy + ly
      const wz = v.pos.z - lx * sy + lz * cy
      const ex = mv[0] * wx + mv[4] * wy + mv[8] * wz + mv[12]
      const ey = mv[1] * wx + mv[5] * wy + mv[9] * wz + mv[13]
      const ez = mv[2] * wx + mv[6] * wy + mv[10] * wz + mv[14]
      const px = pr[0] * ex + pr[4] * ey + pr[8] * ez + pr[12]
      const py = pr[1] * ex + pr[5] * ey + pr[9] * ez + pr[13]
      const pw = pr[3] * ex + pr[7] * ey + pr[11] * ez + pr[15]
      if (pw <= 0) continue
      const sx = (px / pw) * 0.5 + 0.5
      const sty = 1 - ((py / pw) * 0.5 + 0.5)
      if (sx < x0) x0 = sx
      if (sx > x1) x1 = sx
      if (sty < y0) y0 = sty
      if (sty > y1) y1 = sty
    }
    const cv = document.getElementById('sg-canvas')
    const W = cv.clientWidth, H = cv.clientHeight
    return [Math.round(x0 * W), Math.round(y0 * H), Math.round(x1 * W), Math.round(y1 * H)]
  })

  const setPin = (p) => page.evaluate((q) => Object.assign(window.__PIN__, q), p)
  const setIso = (n) => page.evaluate((q) => window.__ISO__.set(q), n)

  /** Mean and worst-case over N frames, because the particle system is stochastic. */
  const sample = async (name, frames, save) => {
    const rows = []
    for (let i = 0; i < frames; i++) {
      await page.waitForTimeout(360)
      const buf = await page.screenshot()
      const m = analyseFrame(buf, await carRect())
      rows.push(m)
      if (save && i === frames - 1) {
        await writeFile(new URL(`../shots/${save}.png`, import.meta.url).pathname, buf)
      }
    }
    const num = (f) => rows.map(f).filter((v) => typeof v === 'number')
    const mean = (f) => { const a = num(f); return a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null }
    const max = (f) => { const a = num(f); return a.length ? Math.max(...a) : null }
    return {
      name,
      blownPct: mean((r) => r.blownPct), blownMax: max((r) => r.blownPct),
      whitePct: mean((r) => r.whitePct),
      roadBlownPct: mean((r) => r.roadBlownPct), roadBlownMax: max((r) => r.roadBlownPct),
      roadWhitePct: mean((r) => r.roadWhitePct),
      roadGradient: mean((r) => r.roadGradient),
      brightPct: mean((r) => r.brightPct),
      meanLum: mean((r) => r.meanLum),
      gradient: mean((r) => r.gradient),
      carBlownPct: mean((r) => r.car && r.car.blownPct),
      carBlownMax: max((r) => r.car && r.car.blownPct),
      carWhitePct: mean((r) => r.car && r.car.whitePct),
      carGradient: mean((r) => r.car && r.car.gradient),
      carStd: mean((r) => r.car && r.car.std),
    }
  }

  // Speeds are absolute m/s so the scenarios mean the same thing on both
  // circuits. 94 m/s is the 338 km/h in the bug report; boost 0.52 is a
  // tier-3 drift release, the strongest the game hands out.
  // `drift` is spelled out on every row: setPin merges, so a scenario that
  // stays silent about it inherits whatever the row before it left behind.
  const SCENARIOS = [
    { name: 'cruise', pin: { speed: 52, boost: 0, charges: 0, fireEvery: 0, drift: 0, span: 230 } },
    { name: 'mid-boost', pin: { speed: 78, boost: 0.35, charges: 5, fireEvery: 0, drift: 0, span: 230 } },
    { name: 'full-boost', pin: { speed: 94, boost: 0.52, charges: 10, fireEvery: 0, drift: 0, span: 230 } },
    { name: 'worst', pin: { speed: 94, boost: 0.52, charges: 10, fireEvery: 0.55, fireTier: 3, drift: 0, span: 230 } },
  ]
  // --drift: the slide, at each rung of the charge ladder, plus the tier
  // transition on a cadence. Speed 62 m/s is a fast corner rather than a
  // straight-line top end -- nobody drifts at 94 -- and yawOff 0.42 rad is
  // about the slide angle the sim's arc actually produces at full lock.
  if (DRIFT) {
    for (const t of [0, 1, 2, 3]) {
      SCENARIOS.push({
        name: `drift-t${t}`,
        pin: { speed: 62, boost: 0, charges: 0, fireEvery: 0, drift: 1, driftTier: t,
               driftInward: 0.9, yawOff: 0.42, tierPulse: 0, span: 900 },
      })
    }
    SCENARIOS.push({
      name: 'drift-tierup',
      pin: { speed: 62, boost: 0, charges: 0, fireEvery: 0, drift: 1, driftTier: 3,
             driftInward: 0.95, yawOff: 0.42, tierPulse: 0.5, span: 900 },
    })
    // The real worst case: a tier-3 slide cashed in, i.e. the drift VFX and a
    // full boost on the same frame. This is the frame both bugs lived in.
    SCENARIOS.push({
      name: 'drift-boost',
      pin: { speed: 88, boost: 0.52, charges: 10, fireEvery: 0, drift: 1, driftTier: 3,
             driftInward: 0.95, yawOff: 0.34, tierPulse: 0.5, span: 900 },
    })
  }

  // SILENCE THE CALLOUTS FOR THIS PROBE. The rail writes driftTier straight
  // into the racer to pin a slide, and the callout layer reads exactly that
  // transition -- so the tier-pulse scenarios would print white text a third
  // of the way down every sampled frame and fold it into blownPct. This probe
  // measures the RENDERER; the callouts have their own probe (--cheer).
  await page.evaluate(() => {
    const c = window.__GAME__.cheer
    if (c && c.setLevel) c.setLevel('off')
  })

  const tagBase = `${tag}-glare${GLARE_TAG ? '-' + GLARE_TAG : ''}`
  const results = []
  await setPin({ enabled: true, s: pinInfo.pinS, speed: 60, boost: 0, charges: 0 })
  await page.waitForTimeout(2500)

  if (GLARE_INTENSITY) {
    await page.evaluate((v) => {
      const p = window.__GAME__.post
      if (p && p.setIntensity) p.setIntensity(v[0], v[1])
      if (window.__ISO__) window.__ISO__.glare = v[0]
    }, GLARE_INTENSITY)
  }

  for (const sc of SCENARIOS) {
    await setPin({ ...sc.pin, s: pinInfo.pinS })
    await page.waitForTimeout(1500)
    results.push(await sample(sc.name, 5, `${tagBase}-${sc.name}`))
  }

  // Attribution: hold a SUSTAINED full boost -- not the repeating tier-3
  // release, whose 0.2s singularity flash lands inside a sample or not
  // depending on when the (~1fps) software renderer got round to the frame,
  // and swamps every difference being measured with its own variance.
  const attrib = []
  if (ATTRIB) {
    // Sustained, never pulsed -- with --drift that is the held tier-3 slide,
    // for exactly the reason the paragraph above gives about the release flash.
    await setPin((SCENARIOS.find((s) => s.name === 'drift-t3') ?? SCENARIOS[2]).pin)
    const ISO = ATTRIB_MIN
      ? ['full', 'noVfx', 'noParticles', 'noRibbons']
      : ['full', 'glarePassthrough', 'noBloom', 'bloomHalf',
         'thresh1.2', 'thresh2.5', 'noVfx', 'noParticles', 'noRibbons',
         'noTrack', 'noEnv',
         'noCars', 'noScreen', 'noLines', 'noBlur', 'noCa', 'noVignette']
    for (const iso of ISO) {
      const ok = await setIso(iso)
      await setPin({ s: pinInfo.pinS })
      await page.waitForTimeout(1100)
      const r = await sample(iso, 5, `${tagBase}-iso-${iso}`)
      attrib.push({ ...r, applied: ok })
    }
    await setIso('full')
  }

  const post = await page.evaluate(() => {
    const g = window.__GAME__
    const p = g.post
    return {
      tier: g.tier,
      hasPost: !!p,
      bloomStrength: p && p.bloom ? p.bloom.strength : null,
      bloomEnabled: p && p.bloom ? p.bloom.enabled : null,
      uGlare: p && p.compositeMat ? p.compositeMat.uniforms.uGlare.value : null,
      uScreen: p && p.compositeMat ? p.compositeMat.uniforms.uScreen.value : null,
      bloomThreshold: p && p.bloom ? p.bloom.threshold : null,
      bloomRadius: p && p.bloom ? p.bloom.radius : null,
      hasSetIntensity: !!(p && typeof p.setIntensity === 'function'),
      boostIntensity: g.vfx ? +g.vfx.boostIntensity.toFixed(3) : null,
      drawCalls: g.renderer.info.render.calls,
      triangles: g.renderer.info.render.triangles,
      exposure: g.renderer.toneMappingExposure,
      toneMapping: g.renderer.toneMapping,
    }
  })

  const raced = await page.evaluate(() => {
    const r = window.__GAME__.race.state.racers[0]
    return { chassisId: r.chassisId, altitude: +r.altitude.toFixed(2) }
  })
  const report = { label, trackId, viewport, pinInfo, raced, post, results, attrib, errors }
  console.log(`\n=== GLARE ${label.toUpperCase()} ${trackId.toUpperCase()}${GLARE_TAG ? ' [' + GLARE_TAG + ']' : ''} ===`)
  console.log('pin:', JSON.stringify(pinInfo), 'raced:', JSON.stringify(raced))
  console.log('post:', JSON.stringify(post))
  const cols = ['name', 'blownPct', 'blownMax', 'roadBlownPct', 'roadWhitePct', 'roadGradient',
                'carBlownPct', 'carWhitePct', 'carGradient', 'meanLum', 'brightPct']
  const fmt = (r) => cols.map((c) => String(r[c]).padStart(c === 'name' ? 12 : 9)).join(' ')
  console.log(cols.map((c) => c.padStart(c === 'name' ? 12 : 9)).join(' '))
  for (const r of results) console.log(fmt(r))
  if (attrib.length) {
    console.log('\n-- attribution (worst case, one source removed) --')
    for (const r of attrib) console.log(fmt(r), r.applied ? '' : '  NOT APPLIED')
  }
  console.log(`errors: ${errors.length}`)
  for (const e of errors.slice(0, 8)) console.log('  ERR ' + e.slice(0, 300))

  await writeFile(new URL(`../shots/${tagBase}-report.json`, import.meta.url).pathname,
    JSON.stringify(report, null, 2))
  await browser.close()
  server.close()
  process.exit(errors.length ? 1 : 0)
}

// ---------------------------------------------------------------------------
// --cheer: the encouragement probe
//
// Drives a REAL drift with the keyboard, up the charge ladder, and photographs
// the callout at each rung and at the cash-in. The banner's own geometry is
// read back out of the DOM at the same time, because "it is not over the
// racing line" has to be a measurement: the box's centre, as a fraction of the
// viewport, against the band the road occupies.
// ---------------------------------------------------------------------------
if (CHEER) {
  for (let i = 0; i < 240; i++) {
    if ((await simState()).p === 'racing') break
    await page.waitForTimeout(500)
  }

  /** The live callout: its text, its weight class, and where its box sits. */
  const cheerState = () => page.evaluate(() => {
    const root = document.querySelector('.sg-cheer')
    const line = document.querySelector('.sg-cheer__line')
    const wave = document.querySelector('.sg-cheer__wave')
    const st = window.__GAME__.race.state
    const r = st.racers[window.__GAME__.localId]
    const cv = document.getElementById('sg-canvas')
    const W = cv.clientWidth, H = cv.clientHeight
    let box = null
    let fx = null
    if (root && !root.hidden) {
      const b = root.getBoundingClientRect()
      box = {
        cx: +((b.x + b.width / 2) / W).toFixed(3),
        cy: +((b.y + b.height / 2) / H).toFixed(3),
        top: +(b.y / H).toFixed(3),
        bottom: +((b.y + b.height) / H).toFixed(3),
        wFrac: +(b.width / W).toFixed(3),
        opacity: +getComputedStyle(root).opacity,
        fontPx: line ? Math.round(parseFloat(getComputedStyle(line).fontSize)) : null,
        pointerEvents: getComputedStyle(root).pointerEvents,
      }
      // THE PRESENTATION, sampled while it is happening.
      //
      // `lineBox` is the measurement the placement argument actually needs now
      // that the entrance is a transform: the root's rect is a plain layout box
      // that no animation touches, so on its own it would happily certify a
      // stamp that overshoots halfway down the screen. This one includes the
      // line's own transform, so it is where the WORDS are at this instant.
      const cs = getComputedStyle(root)
      const ls = getComputedStyle(line)
      const ws = wave ? getComputedStyle(wave) : null
      const lb = line.getBoundingClientRect()
      fx = {
        beat: root.dataset.beat ?? null,
        amp: cs.getPropertyValue('--amp').trim(),
        dur: cs.getPropertyValue('--dur').trim(),
        wo: cs.getPropertyValue('--wo').trim(),
        lineAnim: ls.animationName,
        lineTransform: ls.transform,
        waveAnim: ws ? ws.animationName : null,
        waveOpacity: ws ? +ws.opacity : null,
        // Three shadows on every rung but the top, five on Singularity -- the
        // extra pair being the chromatic fringe, which nothing below wears.
        shadowParts: (ls.textShadow.match(/rgba?\(/g) || []).length,
        lineBox: {
          cy: +((lb.y + lb.height / 2) / H).toFixed(3),
          top: +(lb.y / H).toFixed(3),
          bottom: +((lb.y + lb.height) / H).toFixed(3),
          wFrac: +(lb.width / W).toFixed(3),
        },
      }
    }
    return {
      hidden: root ? root.hidden : null,
      text: line ? line.textContent : null,
      w: root ? root.dataset.w : null,
      box,
      fx,
      driftTier: r.driftTier,
      driftSide: r.driftSide,
      driftCharge: +r.driftCharge.toFixed(2),
      position: r.position,
    }
  })

  const seen = []
  const watch = async (label, ms) => {
    const t0 = Date.now()
    let best = null
    while (Date.now() - t0 < ms) {
      const c = await cheerState()
      if (!c.hidden && c.box && c.box.opacity > 0.25) {
        seen.push({ label, ...c })
        if (!best) {
          best = c
          await page.screenshot({ path: new URL(`../shots/${tag}-cheer-${label}.png`, import.meta.url).pathname })
        }
      }
      await page.waitForTimeout(120)
    }
    return best
  }

  // Get up to speed, then hold a slide. The ladder is 0.65 / 1.50 / 2.60 /
  // 4.20 seconds of charge, so a long held drift walks every rung.
  await page.keyboard.down('KeyW')
  for (let i = 0; i < 200; i++) {
    const st = await simState()
    if (st.p === 'racing' && st.v > 30) break
    await page.waitForTimeout(400)
  }
  await page.keyboard.down('KeyD')
  await page.keyboard.down('ShiftLeft')
  const rungs = await watch('01-ladder', 22000)
  await page.screenshot({ path: new URL(`../shots/${tag}-cheer-02-holding.png`, import.meta.url).pathname })
  const beforeRelease = await cheerState()
  // Cash it in.
  await page.keyboard.up('ShiftLeft')
  const cash = await watch('03-cash', 9000)
  await page.keyboard.up('KeyD')
  await page.keyboard.up('KeyW')

  // --- the upper rungs ----------------------------------------------------
  // A real keyboard drift under SwiftShader banks a Spark and, on a good run,
  // a Flare: the sim advances at about a quarter of real time, so a 4.2s
  // Singularity hold is 17 wall seconds of not touching a wall, which nobody
  // gets. The rungs above are driven through the SAME decision path -- the
  // driftTier the HUD reads and the driftEnd event the cash-in reads -- pushed
  // from a step wrapper, exactly as the glare rail pushes its boost events.
  await page.evaluate(() => {
    const race = window.__GAME__.race
    const st = race.state
    const P = { tier: -1, fire: -1, acc: 0, every: 2.2, step: 0, forceCash: -1, forceUp: -1 }
    window.__LADDER__ = P
    const orig = race.step.bind(race)
    race.step = function () {
      orig()
      const r0 = st.racers[window.__GAME__.localId]
      // --- the pinned rung, for the posed frames and the Callouts filter -----
      // These two run on EVERY step rather than on the `every` beat, and that
      // is not laziness. `r.events` is a one-shot channel cleared by the next
      // step, and the callouts are decided on RENDER frames -- of which
      // SwiftShader manages about one a second while fifteen sim steps go by.
      // An event pushed on a beat is therefore seen by a render frame roughly
      // one time in fifteen, which made a probe that looked deterministic
      // silently a coin flip. Offered every step, the next render frame always
      // sees it, and cheer.ts's own cooldown and minimum gap are what decide
      // how often a line actually goes up -- which is the behaviour under test.
      if (P.forceCash >= 0) {
        r0.driftSide = 0
        r0.driftTier = -1
        r0.events.push({ t: 'driftEnd', tier: P.forceCash })
        return
      }
      // The other half of the ladder: BANKING a rung rather than cashing it.
      // The line is read off a TRANSITION into the tier, so this cycles out of
      // the slide and back into it. Holding the tier steady is not enough --
      // if the render frame that follows arming already saw the tier, there is
      // no edge for the detector to find and the rung is silently skipped.
      if (P.forceUp >= 0) {
        P.acc += 1 / 60
        if (P.acc > 1.2) P.acc = 0
        const on = P.acc > 0.35
        r0.driftSide = on ? 1 : 0
        r0.driftTier = on ? P.forceUp : -1
        r0.driftCharge = on ? 1.0 : 0
        return
      }
      if (P.every <= 0) return
      P.acc += 1 / 60
      if (P.acc < P.every) return
      P.acc = 0
      const r = st.racers[window.__GAME__.localId]
      // Walk a rung, then cash it in on the next beat, then the rung above.
      if (P.step % 2 === 0) {
        P.tier = Math.min(3, (P.tier + 1))
        r.driftSide = 1
        r.driftTier = P.tier
      } else {
        r.events.push({ t: 'driftEnd', tier: P.tier })
        r.driftSide = 0
        r.driftTier = -1
      }
      P.step++
    }
  })
  const ladder = await watch('05-forced', 34000)
  await page.evaluate(() => { window.__LADDER__.every = 0 })

  // Silence: with nothing happening, nothing may be on screen.
  //
  // "Nothing happening" has to be arranged, not hoped for. The forced ladder
  // leaves the car mid-flight somewhere, and a car still driving can land a
  // ramp four seconds later and earn a line honestly -- which would fail this
  // check for being right. Park it first: stopped, grounded, out of the slide.
  await page.evaluate(() => {
    const g = window.__GAME__
    const r = g.race.state.racers[g.localId]
    r.vel.x = 0; r.vel.y = 0; r.vel.z = 0
    r.grounded = true; r.altitude = 0; r.airTime = 0; r.vertVel = 0
    r.driftSide = 0; r.driftTier = -1; r.driftCharge = 0
    g.cheer.reset()
  })
  await page.waitForTimeout(4000)
  const quiet = await cheerState()

  // --- POSED FRAMES, one per rung ------------------------------------------
  // Under SwiftShader a screenshot takes about a second, so a 420ms entrance
  // can only ever be photographed by luck: every shot above is whatever the
  // poll happened to catch, which is almost always the settle. To actually
  // LOOK at the presentation, this holds a line up, stops the sim writing the
  // fade so it cannot expire mid-capture, and seeks the CSS animations to a
  // chosen millisecond. Two frames per rung -- one mid-entrance, where the
  // stamp is leaning and the shockwave is near its peak, and one at rest.
  // Nothing here changes shipped behaviour; it is the same idea as the glare
  // rail pinning the car so two runs photograph the same moment.
  const poses = []
  /**
   * `kind` picks which half of the drift ladder produces the line. Tier 0 has
   * to come from BANKING a rung: cashing a Spark in is deliberately worth no
   * line at all (cheer.ts cashMinTier), so a cash-driven pose at tier 0 would
   * photograph an empty screen and call it a rung.
   */
  const pose = async (kind, tier, at, name) => {
    await page.evaluate(() => { window.__GAME__.phase = 'racing' })
    // Clear the previous pose's line first. Its hold timer was frozen while
    // the sim was paused for the screenshot, so without this the next pose
    // photographs the LAST rung again and quietly reports it as this one.
    // `reset()` is the shipped between-races wipe, so nothing here is a path
    // the game does not already have.
    await page.evaluate(() => { window.__GAME__.cheer.reset() })
    await page.waitForTimeout(600)
    // Pause the entrance BEFORE it exists. A finished no-fill animation is
    // dropped from getAnimations(), and under SwiftShader the poll that
    // notices the line can easily take longer than the 420ms it runs for --
    // so seeking after the fact photographs an element at rest and reports it
    // as the mid-entrance frame. Parking `animation-play-state` on the two
    // elements first means the animation is born paused at time zero and is
    // still there to be seeked whenever the probe gets around to it.
    await page.evaluate(() => {
      const root = document.querySelector('.sg-cheer')
      for (const el of [root.querySelector('.sg-cheer__line'), root.querySelector('.sg-cheer__wave')]) {
        el.style.animationPlayState = 'paused'
      }
    })
    await page.evaluate(([k, t]) => {
      const P = window.__LADDER__
      P.forceCash = k === 'cash' ? t : -1
      P.forceUp = k === 'up' ? t : -1
      P.every = k === 'up' ? 0.6 : 0.35
      P.acc = 0
      P.step = 0
    }, [kind, tier])
    let up = false
    for (let i = 0; i < 140; i++) {
      const c = await cheerState()
      if (!c.hidden && c.box && c.box.opacity > 0.5) { up = true; break }
      await page.waitForTimeout(150)
    }
    await page.evaluate(() => {
      window.__LADDER__.every = 0
      window.__LADDER__.forceCash = -1
      window.__LADDER__.forceUp = -1
    })
    if (!up) return null
    const posed = await page.evaluate((ms) => {
      const g = window.__GAME__
      g.phase = 'paused'
      const root = document.querySelector('.sg-cheer')
      root.style.setProperty('--k', '1')
      const parts = [root.querySelector('.sg-cheer__line'), root.querySelector('.sg-cheer__wave')]
      const out = []
      for (const el of parts) {
        for (const a of el.getAnimations()) {
          a.pause()
          a.currentTime = ms
          out.push({ name: a.animationName, at: a.currentTime })
        }
      }
      const cv = document.getElementById('sg-canvas')
      const H = cv.clientHeight, W = cv.clientWidth
      const lb = parts[0].getBoundingClientRect()
      const wb = parts[1].getBoundingClientRect()
      return {
        anims: out,
        w: root.dataset.w,
        text: parts[0].textContent,
        words: {
          top: +(lb.y / H).toFixed(3), bottom: +((lb.y + lb.height) / H).toFixed(3),
          wFrac: +(lb.width / W).toFixed(3),
          transform: getComputedStyle(parts[0]).transform,
        },
        wave: {
          top: +(wb.y / H).toFixed(3), bottom: +((wb.y + wb.height) / H).toFixed(3),
          wFrac: +(wb.width / W).toFixed(3),
          opacity: +getComputedStyle(parts[1]).opacity,
          // What the shockwave is actually PAINTED in. Element opacity alone
          // says nothing about how much light lands on the sky: the ink itself
          // is a low-alpha colour, and the product of the two is the number
          // that decides whether this is a wash or a flashbang. Read off the
          // custom property rather than a resolved border/background, because
          // the gradients that use it have no single computed colour.
          ink: getComputedStyle(root).getPropertyValue('--cw').trim(),
        },
      }
    }, at)
    await page.waitForTimeout(500)
    await page.screenshot({ path: new URL(`../shots/${tag}-cheer-${name}.png`, import.meta.url).pathname })
    await page.evaluate(() => {
      const root = document.querySelector('.sg-cheer')
      root.style.removeProperty('--k')
      for (const el of [root.querySelector('.sg-cheer__line'), root.querySelector('.sg-cheer__wave')]) {
        for (const a of el.getAnimations()) a.cancel()
        el.style.removeProperty('animation-play-state')
      }
      window.__GAME__.phase = 'racing'
    })
    await page.waitForTimeout(600)
    poses.push({ kind, tier, at, name, ...posed })
    return posed
  }
  for (const t of [0, 1, 2, 3]) {
    const kind = t === 0 ? 'up' : 'cash'
    await pose(kind, t, 95, `10-tier${t}-stamp`)
    await pose(kind, t, 4000, `11-tier${t}-rest`)
  }

  // --- the control ----------------------------------------------------------
  const openSettings = async () => {
    await activate(page.locator('.sg-tools__btn[aria-label="Settings and controls"]'), 25000)
    await page.waitForSelector('.sgset.is-open', { state: 'visible', timeout: 15000 })
    await page.waitForTimeout(2500)
  }
  const setCallouts = async (step) => {
    await activate(page.locator('.sgset-seg[aria-label="Callouts"] .sgset-seg__btn', { hasText: step }).first(), 20000)
    await page.waitForTimeout(400)
  }

  await openSettings()
  await page.screenshot({ path: new URL(`../shots/${tag}-cheer-04-setting.png`, import.meta.url).pathname })
  const calloutUi = await page.evaluate(() => {
    const seg = document.querySelector('.sgset-seg[aria-label="Callouts"]')
    const on = seg ? seg.querySelector('[aria-checked="true"]') : null
    return {
      present: !!seg,
      steps: seg ? seg.querySelectorAll('.sgset-seg__btn').length : 0,
      checked: on ? on.textContent : null,
      sub: (document.querySelector('.sgset-seg[aria-label="Callouts"]')
        ?.closest('.sgset-row')?.querySelector('.sgset-row__sub')?.textContent ?? '').trim(),
    }
  })

  // --- WHAT "KEY ONLY" NOW MEANS -------------------------------------------
  // The presentation got bigger, so the bar for interrupting with it got
  // higher: a Flare release is the routine corner exit of a competent driver
  // and used to survive this setting, which meant the player who asked for
  // fewer interruptions got the loudest ones on the most ordinary event. Key
  // only now starts at Nova. Both halves are checked -- the tier that must be
  // dropped AND the tier that must still speak -- because a filter that
  // silences everything passes the first half on its own.
  await setCallouts('Key only')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)
  /** Push driftEnd events at one tier and report whether anything spoke. */
  const cashAtTier = async (tier, ms) => {
    // Wipe whatever is still on screen, or the watcher below reports the
    // PREVIOUS line as this tier's answer.
    await page.evaluate(() => { window.__GAME__.cheer.reset() })
    await page.waitForTimeout(600)
    await page.evaluate((t) => {
      const P = window.__LADDER__
      P.forceCash = t
      P.forceUp = -1
      P.acc = 0
      P.every = 0
      P.step = 0
    }, tier)
    const t0 = Date.now()
    let spoke = null
    while (Date.now() - t0 < ms) {
      const c = await cheerState()
      if (!c.hidden && c.box && c.box.opacity > 0.25) { spoke = c; break }
      await page.waitForTimeout(150)
    }
    await page.evaluate(() => { window.__LADDER__.every = 0; window.__LADDER__.forceCash = -1 })
    await page.waitForTimeout(2200)
    return spoke
  }
  const keyFlare = await cashAtTier(1, 12000)
  const keyNova = await cashAtTier(2, 14000)
  if (keyNova) {
    await page.screenshot({ path: new URL(`../shots/${tag}-cheer-06-keyonly.png`, import.meta.url).pathname })
  }

  await openSettings()
  await setCallouts('Off')
  const calloutOff = await page.evaluate(() => {
    const seg = document.querySelector('.sgset-seg[aria-label="Callouts"]')
    const on = seg ? seg.querySelector('[aria-checked="true"]') : null
    let stored = null
    try { stored = JSON.parse(localStorage.getItem('spacegen.settings') || '{}').callouts } catch { stored = null }
    return { checked: on ? on.textContent : null, stored }
  })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)

  const texts = [...new Set(seen.map((r) => r.text))]
  // The presentation ladder, one row per weight class actually photographed.
  const byWeight = {}
  for (const r of seen) {
    if (!r.fx) continue
    const k = r.w
    if (!byWeight[k]) byWeight[k] = { w: k, samples: 0, fontPx: r.box.fontPx, ...r.fx, texts: [] }
    byWeight[k].samples++
    byWeight[k].fontPx = Math.max(byWeight[k].fontPx, r.box.fontPx)
    byWeight[k].maxOpacity = Math.max(byWeight[k].maxOpacity ?? 0, r.box.opacity)
    byWeight[k].shadowParts = Math.max(byWeight[k].shadowParts, r.fx.shadowParts)
    // The furthest down the frame the WORDS ever got, transform included.
    byWeight[k].lineBottom = Math.max(byWeight[k].lineBottom ?? 0, r.fx.lineBox.bottom)
    byWeight[k].lineWidest = Math.max(byWeight[k].lineWidest ?? 0, r.fx.lineBox.wFrac)
    if (!byWeight[k].texts.includes(r.text)) byWeight[k].texts.push(r.text)
  }
  const beats = [...new Set(seen.map((r) => (r.fx ? r.fx.beat : null)))]
  const report = {
    label, trackId, viewport, reduced: REDUCED, seen, texts, byWeight, beats, poses,
    rungs, beforeRelease, cash, ladder, quiet,
    keyOnly: { flare: keyFlare, nova: keyNova }, calloutUi, calloutOff, errors,
  }
  console.log(`\n=== CHEER ${label.toUpperCase()} ${trackId.toUpperCase()}${REDUCED ? ' [reduced-motion]' : ''} ===`)
  console.log('lines seen, in order:')
  const shown = []
  for (const r of seen) {
    const key = r.text + '|' + r.w
    if (shown[shown.length - 1] === key) continue
    shown.push(key)
    console.log(`  "${r.text}"  w=${r.w}  tier=${r.driftTier}  box cy=${r.box.cy} top=${r.box.top} bot=${r.box.bottom} font=${r.box.fontPx}px width=${r.box.wFrac}`)
  }
  console.log('the ladder:')
  for (const k of Object.keys(byWeight).sort()) {
    const b = byWeight[k]
    console.log(`  w=${k} ${String(b.fontPx).padStart(3)}px  peakOpacity=${b.maxOpacity} amp=${b.amp} dur=${b.dur} wo=${b.wo}` +
      `  shadows=${b.shadowParts}  anim=${b.lineAnim}/${b.waveAnim}` +
      `  wordsBottom=${b.lineBottom} widest=${b.lineWidest}`)
  }
  console.log('beats seen:', JSON.stringify(beats))
  console.log('posed frames (mid-entrance @95ms vs at rest):')
  for (const p of poses) {
    console.log(`  ${p.name.padEnd(18)} w=${p.w} "${p.text}"  words ${p.words.top}..${p.words.bottom}` +
      ` (${p.words.wFrac} wide)  wave ${p.wave.top}..${p.wave.bottom} op=${p.wave.opacity} ink=${p.wave.ink}` +
      `  ${p.words.transform === 'none' ? 'transform:none' : p.words.transform}`)
  }
  console.log('key only: flare ->', keyFlare ? `"${keyFlare.text}"` : 'silent',
    '| nova ->', keyNova ? `"${keyNova.text}" w=${keyNova.w}` : 'silent')
  console.log('quiet after 4s:', JSON.stringify({ hidden: quiet.hidden, text: quiet.text }))
  console.log('setting:', JSON.stringify(calloutUi), '->', JSON.stringify(calloutOff))
  console.log(`errors: ${errors.length}`)
  for (const e of errors.slice(0, 8)) console.log('  ERR ' + e.slice(0, 300))

  await writeFile(new URL(`../shots/${tag}-cheer-report.json`, import.meta.url).pathname,
    JSON.stringify(report, null, 2))

  const fail = []
  if (errors.length) fail.push(`${errors.length} console errors`)
  if (!seen.length) fail.push('no callout ever appeared')
  // THE PLACEMENT THE PLAYER ASKED FOR: centred horizontally, about a third of
  // the way down. Measured, not asserted in a comment.
  for (const r of seen) {
    if (Math.abs(r.box.cx - 0.5) > 0.02) fail.push(`"${r.text}" is at cx=${r.box.cx}, not centred`)
    if (r.box.cy < 0.22 || r.box.cy > 0.45) fail.push(`"${r.text}" sits at cy=${r.box.cy}, outside the upper-third band`)
    // It must never reach the lower half, which is where the road is.
    if (r.box.bottom > 0.5) fail.push(`"${r.text}" reaches ${r.box.bottom} down the frame -- into the racing line`)
    if (r.box.wFrac > 0.8) fail.push(`"${r.text}" spans ${r.box.wFrac} of the width`)
    if (r.box.pointerEvents !== 'none') fail.push('the callout layer is not pointer-events:none')
  }
  // Only ONE line at a time: the box is a single element, so this is really a
  // check that nothing stacked a second host in.
  const hosts = await page.evaluate(() => document.querySelectorAll('.sg-cheer').length)
  if (hosts !== 1) fail.push(`${hosts} callout hosts in the DOM`)
  // The escalation has to be visible: at least two different weight classes.
  const weights = [...new Set(seen.map((r) => r.w))]
  if (weights.length < 2) fail.push(`every callout used the same weight class (${weights.join(',')})`)

  // --- THE PRESENTATION -----------------------------------------------------
  // The words themselves, transform and all, must stay out of the road. The
  // root's rect cannot answer this any more: the entrance is a transform on
  // the line, and the root's box is a plain layout box that would happily
  // certify a stamp that overshot halfway down the frame.
  for (const r of seen) {
    if (!r.fx) continue
    if (r.fx.lineBox.bottom > 0.5) {
      fail.push(`"${r.text}" put words at ${r.fx.lineBox.bottom} down the frame -- into the racing line`)
    }
    if (r.fx.lineBox.wFrac > 0.86) fail.push(`"${r.text}" spans ${r.fx.lineBox.wFrac} of the width mid-entrance`)
  }
  // The ladder BUILDS. Every rung photographed must be strictly bigger than
  // the one below it, and must stamp harder and hold longer.
  const rungKeys = Object.keys(byWeight).sort()
  // Custom properties come back in whatever form the engine serialises them
  // to, and Chromium rewrites `240ms` as `.24s` while leaving `285ms` alone.
  // Compare seconds, not digits.
  const num = (v) => {
    const n = parseFloat(v)
    return /ms\s*$/.test(String(v)) ? n / 1000 : n
  }
  for (let i = 1; i < rungKeys.length; i++) {
    const lo = byWeight[rungKeys[i - 1]], hi = byWeight[rungKeys[i]]
    if (!(hi.fontPx > lo.fontPx)) fail.push(`w=${hi.w} is ${hi.fontPx}px, not larger than w=${lo.w} at ${lo.fontPx}px`)
    if (!(num(hi.amp) > num(lo.amp))) fail.push(`w=${hi.w} stamps at amp ${hi.amp}, not harder than w=${lo.w} at ${lo.amp}`)
    if (!(num(hi.dur) > num(lo.dur))) fail.push(`w=${hi.w} settles in ${hi.dur}, not longer than w=${lo.w} at ${lo.dur}`)
  }
  // EVERY rung reaches full strength, in both motion modes. Opacity is the one
  // channel a reduced-motion player has, so a rung that never gets there is a
  // rung they never see -- and the failure this codebase has already shipped
  // once was exactly an element left at opacity 0 by an animation that did not
  // run. (Individual samples are legitimately mid-fade; the peak is the claim.)
  for (const k of rungKeys) {
    const o = byWeight[k].maxOpacity
    if (!(o > 0.9)) fail.push(`w=${k} never got past opacity ${o}`)
  }
  // The shockwave belongs to Nova and Singularity and to nothing below them.
  for (const k of rungKeys) {
    const b = byWeight[k]
    const wo = num(b.wo)
    if (+k >= 2 && !(wo > 0)) fail.push(`w=${k} has no shockwave (--wo ${b.wo})`)
    if (+k < 2 && wo !== 0) fail.push(`w=${k} throws a shockwave (--wo ${b.wo}) below Nova`)
  }
  // Chromatic separation belongs to Singularity and to nothing below it: three
  // shadow colours everywhere else, five at the top.
  for (const k of rungKeys) {
    const parts = byWeight[k].shadowParts
    if (+k === 3 && parts < 5) fail.push(`Singularity has ${parts} shadow colours -- the chromatic fringe is missing`)
    if (+k < 3 && parts > 3) fail.push(`w=${k} has ${parts} shadow colours -- the fringe leaked below Singularity`)
  }
  if (REDUCED) {
    // OPACITY ONLY. No stamp, no shockwave -- and, the half that matters, the
    // words are still there at full size and full opacity, because the resting
    // state of every element is the readable one and the animation was only
    // ever an enhancement over it. This codebase has shipped the other way
    // round once (a panel parked at opacity 0 by an animation that did not run)
    // and this is the assertion that says it did not happen again.
    for (const r of seen) {
      if (!r.fx) continue
      if (r.fx.lineAnim !== 'none') fail.push(`reduced motion still runs "${r.fx.lineAnim}" on the words`)
      if (r.fx.waveAnim !== 'none') fail.push(`reduced motion still runs "${r.fx.waveAnim}" on the shockwave`)
      if (r.fx.lineTransform !== 'none') fail.push(`reduced motion left the words transformed (${r.fx.lineTransform})`)
      if (r.fx.waveOpacity !== 0) fail.push(`reduced motion left the shockwave at opacity ${r.fx.waveOpacity}`)
      if (!(r.box.fontPx > 12)) fail.push(`a reduced-motion callout collapsed to ${r.box.fontPx}px`)
    }
  } else {
    for (const r of seen) {
      if (!r.fx) continue
      if (!/^sg-cheer-in-[ab]$/.test(r.fx.lineAnim)) fail.push(`the words carry animation "${r.fx.lineAnim}"`)
      if (!/^sg-cheer-wave-[ab]$/.test(r.fx.waveAnim)) fail.push(`the shockwave carries animation "${r.fx.waveAnim}"`)
    }
    // The entrance has to RESTART for each line, including one that replaces a
    // line still on screen. The beat attribute is what does that, so it must
    // actually alternate rather than sit on one value.
    if (beats.filter((b) => b !== null).length < 2) {
      fail.push(`the entrance never restarted (beats seen: ${JSON.stringify(beats)})`)
    }
  }
  // --- the posed frames -----------------------------------------------------
  // Every rung has to have been photographed at all, and NOTHING it draws --
  // the words mid-stamp or the shockwave at its widest -- may reach the road.
  if (poses.length !== 8) fail.push(`posed ${poses.length} frames, wanted 8 (four rungs, two each)`)
  const posedRungs = [...new Set(poses.map((p) => p.w))].sort()
  if (posedRungs.join(',') !== '0,1,2,3') fail.push(`posed rungs ${posedRungs.join(',')}, wanted 0,1,2,3`)
  const rest = poses.filter((p) => p.at >= 4000)
  const mid = poses.filter((p) => p.at < 1000)
  /** Effective alpha of the shockwave: element opacity times its ink's own. */
  const inkA = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || '')
    if (!m) return 1
    const v = m[1].split(',').map((s) => parseFloat(s))
    return v.length > 3 ? v[3] : 1
  }
  for (const p of poses) {
    if (p.words.bottom > 0.5) fail.push(`${p.name}: words reach ${p.words.bottom} down the frame`)
    if (p.wave.opacity > 0 && p.wave.bottom > 0.5) {
      fail.push(`${p.name}: the shockwave reaches ${p.wave.bottom} down the frame`)
    }
    // The bloom-blowout lesson, in the 2D layer: a transient effect over the
    // sky is a wash, not a light source. Peak coverage stays a quarter.
    const eff = +(p.wave.opacity * inkA(p.wave.ink)).toFixed(3)
    if (eff > 0.3) fail.push(`${p.name}: the shockwave lands ${eff} alpha on the sky`)
  }
  // AT REST, every rung is the plain readable thing: no transform, no
  // shockwave. This is the state a player sees for the whole hold, and the
  // state a reduced-motion player sees for all of it.
  for (const p of rest) {
    if (p.words.transform !== 'none') fail.push(`${p.name}: the words settle at ${p.words.transform}`)
    if (p.wave.opacity !== 0) fail.push(`${p.name}: the shockwave is still at ${p.wave.opacity} at rest`)
  }
  if (REDUCED) {
    for (const p of poses) {
      if (p.anims.length) fail.push(`${p.name}: reduced motion still has ${p.anims.length} animations running`)
      if (p.words.transform !== 'none') fail.push(`${p.name}: reduced motion transformed the words`)
      if (p.wave.opacity !== 0) fail.push(`${p.name}: reduced motion showed the shockwave`)
    }
  } else {
    // Mid-entrance the words ARE moved -- that is the whole feature -- and
    // Nova and Singularity are throwing a wave while Spark and Flare are not.
    for (const p of mid) {
      if (p.words.transform === 'none') fail.push(`${p.name}: the entrance did not move the words at all`)
      const wantWave = +p.w >= 2
      if (wantWave && !(p.wave.opacity > 0.05)) fail.push(`${p.name}: no shockwave at Nova or above (${p.wave.opacity})`)
      if (!wantWave && p.wave.opacity > 0.01) fail.push(`${p.name}: a shockwave below Nova (${p.wave.opacity})`)
    }
  }

  // --- what "Key only" means now -------------------------------------------
  if (keyFlare) fail.push(`Key only let a Flare release through: "${keyFlare.text}"`)
  if (!keyNova) fail.push('Key only silenced a Nova release -- the filter is not a mute')
  if (keyNova && keyNova.fx && keyNova.fx.lineBox.bottom > 0.5) {
    fail.push(`the Key-only line reached ${keyNova.fx.lineBox.bottom} down the frame`)
  }
  if (!/Nova|Singularity/i.test(calloutUi.sub || '')) {
    fail.push('the Callouts help text does not say where Key only now starts')
  }
  if (!quiet.hidden) fail.push('a callout was still on screen four seconds after the action stopped')
  if (!calloutUi.present) fail.push('no Callouts control in the settings panel')
  if (calloutUi.steps !== 3) fail.push(`the Callouts control has ${calloutUi.steps} steps`)
  if ((calloutOff.checked ?? '').toUpperCase() !== 'OFF') fail.push(`Callouts Off did not check its own button (${calloutOff.checked})`)
  if (calloutOff.stored !== 'off') fail.push(`localStorage kept callouts="${calloutOff.stored}"`)

  console.log(fail.length ? '\nCHEER FAILED: ' + fail.join('; ') : '\nCHEER PASSED')
  await browser.close()
  server.close()
  process.exit(fail.length ? 1 : 0)
}


// ---------------------------------------------------------------------------
// --splits: the lap-split probe
//
// Closes two real laps and reads the top-left list back out of the DOM: what
// each row says, which one is marked fastest and in what colour, and -- the
// measurement the whole placement rests on -- where the BOTTOM of the top-left
// block lands as a fraction of the frame. A column of numbers in the corner is
// only safe while it stays in the corner.
// ---------------------------------------------------------------------------
if (SPLITS) {
  for (let i = 0; i < 240; i++) {
    if ((await simState()).p === 'racing') break
    await page.waitForTimeout(500)
  }

  /** The lap list, the block that contains it, and the sim state behind it. */
  const splitState = () => page.evaluate(() => {
    const cv = document.getElementById('sg-canvas')
    const W = cv.clientWidth, H = cv.clientHeight
    const posWrap = document.querySelector('.sg-hud__pos')
    const frac = (n) => {
      const b = n.getBoundingClientRect()
      return {
        left: +(b.x / W).toFixed(3), top: +(b.y / H).toFixed(3),
        right: +((b.x + b.width) / W).toFixed(3),
        bottom: +((b.y + b.height) / H).toFixed(3),
        h: Math.round(b.height),
      }
    }
    const rows = [...document.querySelectorAll('.sg-splits .sg-split')]
      .filter((n) => !n.hidden)
      .map((n) => ({
        n: n.querySelector('.sg-split__n').textContent,
        t: n.querySelector('.sg-split__t').textContent,
        d: n.querySelector('.sg-split__d').textContent,
        best: n.classList.contains('is-best'),
        live: n.classList.contains('sg-split--live'),
        ink: getComputedStyle(n.querySelector('.sg-split__t')).color,
        rule: getComputedStyle(n).borderLeftColor,
        fontPx: Math.round(parseFloat(getComputedStyle(n).fontSize)),
        ...frac(n),
      }))
    const g = window.__GAME__
    const st = g.race.state
    const r = st.racers[g.localId]
    const hud = document.querySelector('.sg-hud')
    return {
      rows,
      // Everything in the corner, together: the ordinal, the LAP x/3 chip and
      // the list. This is the box that must not reach the road.
      block: posWrap ? { ...frac(posWrap), shown: getComputedStyle(posWrap).display !== 'none' } : null,
      // The neighbour the list grows towards. On the compact layout the item
      // slots move to the middle-left of the same CSS grid, so a taller
      // top-left row PUSHES them down -- which is the grid doing its job right
      // up until it pushes them off the bottom of a 390px-tall phone.
      items: (() => {
        const n = document.querySelector('.sg-hud__items')
        if (!n) return null
        const b = n.getBoundingClientRect()
        return b.width > 0
          ? { ...frac(n), area: getComputedStyle(n).gridArea }
          : null
      })(),
      lapChip: (document.querySelector('.sg-lap__cur') || {}).textContent ?? null,
      lap: r.lap,
      lapTimes: r.lapTimes.map((v) => +v.toFixed(2)),
      bestLap: +r.bestLap.toFixed(2),
      // Full precision as well: the HUD computes its gap from these and then
      // rounds, so an expectation built from the two-decimal copies above can
      // disagree with it by a cent and call a correct widget broken.
      lapTimesRaw: r.lapTimes.slice(),
      bestLapRaw: r.bestLap,
      finished: r.finished,
      time: +st.time.toFixed(2),
      hudCeremony: hud ? hud.classList.contains('is-ceremony') : null,
      gamePhase: g.phase,
    }
  })

  /**
   * Close one lap for real.
   *
   * `hold` seconds are added to the race clock first so the lap that gets
   * recorded is a design-target lap rather than however long the probe has
   * been running. Then `totalS` is put a few metres short of the line and the
   * sim is left to drive over it: resolveLaps, the lap event, bestLap and the
   * HUD's own change detector are all the shipping code path.
   */
  const closeLap = async (hold) => {
    await page.evaluate((h) => {
      const g = window.__GAME__
      const st = g.race.state
      const r = st.racers[g.localId]
      const prev = r.lapTimes.reduce((a, b) => a + b, 0)
      // Where the clock has to be for THIS lap to come out at `h` seconds.
      st.time = prev + h
      r.totalS = (r.lap + 1) * g.track.length - 30
    }, hold)
    await page.keyboard.down('KeyW')
    const want = (await splitState()).lap + 1
    for (let i = 0; i < 200; i++) {
      const s = await splitState()
      if (s.lap >= want || s.finished) break
      await page.waitForTimeout(200)
    }
    await page.keyboard.up('KeyW')
    await page.waitForTimeout(500)
  }

  const start = await splitState()
  await page.screenshot({ path: new URL(`../shots/${tag}-splits-00-lap1.png`, import.meta.url).pathname })

  // Lap 1 the slower of the two, so lap 2 takes the fastest marker off it.
  await closeLap(64.9)
  const afterOne = await splitState()
  await page.waitForTimeout(600)
  await page.screenshot({ path: new URL(`../shots/${tag}-splits-01-one.png`, import.meta.url).pathname })

  await closeLap(61.42)
  const afterTwo = await splitState()
  await page.waitForTimeout(600)
  await page.screenshot({ path: new URL(`../shots/${tag}-splits-02-two.png`, import.meta.url).pathname })

  // The live row has to be a CLOCK, not a label: let sim time pass and read it
  // again. (Under SwiftShader the sim runs at roughly a quarter of real time,
  // so this waits on sim seconds rather than wall seconds.)
  const t0 = (await simState()).t
  await page.keyboard.down('KeyW')
  for (let i = 0; i < 120; i++) {
    if ((await simState()).t - t0 > 3) break
    await page.waitForTimeout(250)
  }
  await page.keyboard.up('KeyW')
  const ticked = await splitState()

  // And the last lap, which finishes the race and hands over to the ceremony.
  await closeLap(63.5)
  for (let i = 0; i < 120; i++) {
    if ((await splitState()).gamePhase === 'ceremony') break
    await page.waitForTimeout(250)
  }
  await page.waitForTimeout(1400)
  const ceremony = await splitState()
  await page.screenshot({ path: new URL(`../shots/${tag}-splits-03-ceremony.png`, import.meta.url).pathname })

  const report = { label, trackId, viewport, reduced: REDUCED, start, afterOne, afterTwo, ticked, ceremony, errors }
  console.log(`\n=== SPLITS ${label.toUpperCase()} ${trackId.toUpperCase()}${REDUCED ? ' [reduced-motion]' : ''} ===`)
  const dump = (name, s) => {
    console.log(`${name}: lap=${s.lap} chip=${s.lapChip} lapTimes=${JSON.stringify(s.lapTimes)} best=${s.bestLap}`)
    for (const r of s.rows) {
      console.log(`   [${r.n}] ${r.t.padEnd(9)} ${r.d.padEnd(7)}` +
        `${r.best ? ' BEST' : '    '}${r.live ? ' live' : '     '}  ink=${r.ink} rule=${r.rule} ${r.fontPx}px`)
    }
    if (s.block) {
      console.log(`   block: left=${s.block.left} top=${s.block.top} right=${s.block.right} ` +
        `bottom=${s.block.bottom} h=${s.block.h}px shown=${s.block.shown}`)
    }
    if (s.items) {
      console.log(`   items: top=${s.items.top} bottom=${s.items.bottom} right=${s.items.right} area=${s.items.area}`)
    }
  }
  dump('start   ', start)
  dump('afterOne', afterOne)
  dump('afterTwo', afterTwo)
  dump('ticked  ', ticked)
  dump('ceremony', ceremony)
  console.log(`errors: ${errors.length}`)
  for (const e of errors.slice(0, 8)) console.log('  ERR ' + e.slice(0, 300))

  await writeFile(new URL(`../shots/${tag}-splits-report.json`, import.meta.url).pathname,
    JSON.stringify(report, null, 2))

  const GREEN = 'rgb(47, 227, 107)'
  const fail = []
  if (errors.length) fail.push(`${errors.length} console errors`)

  // --- before any lap closes -----------------------------------------------
  // One row, the live one, from the green light. A widget that appears a
  // minute into the race is a widget the player never learns to look at.
  if (start.rows.length !== 1) fail.push(`${start.rows.length} rows before lap 1 closed, wanted 1`)
  if (start.rows[0] && !start.rows[0].live) fail.push('the only row before lap 1 is not the live one')
  if (start.rows[0] && start.rows[0].d !== '') fail.push(`the live row printed a gap "${start.rows[0].d}"`)

  // --- one lap down ---------------------------------------------------------
  if (afterOne.lapTimes.length !== 1) fail.push(`sim recorded ${afterOne.lapTimes.length} laps after one crossing`)
  if (afterOne.rows.length !== 2) fail.push(`${afterOne.rows.length} rows after lap 1, wanted 2`)
  const one = afterOne.rows[0]
  if (one) {
    if (one.n !== '1') fail.push(`first row is labelled "${one.n}"`)
    if (!one.best) fail.push('the only completed lap is not marked fastest')
    if (one.ink !== GREEN) fail.push(`the fastest lap's time is ${one.ink}, not the HUD's best-lap green`)
    if (one.rule !== GREEN) fail.push(`the fastest lap's left rule is ${one.rule}`)
    if (one.d !== '') fail.push(`the fastest lap printed a gap to itself ("${one.d}")`)
    if (!/^\d:\d\d\.\d\d$/.test(one.t)) fail.push(`lap 1 reads "${one.t}", not m:ss.cc`)
  }

  // --- two laps down --------------------------------------------------------
  if (afterTwo.rows.length !== 3) fail.push(`${afterTwo.rows.length} rows after lap 2, wanted 3 (two banked + live)`)
  const done = afterTwo.rows.filter((r) => !r.live)
  const live = afterTwo.rows.find((r) => r.live)
  if (done.length !== 2) fail.push(`${done.length} completed rows after lap 2`)
  if (done.map((r) => r.n).join(',') !== '1,2') fail.push(`completed rows are labelled ${done.map((r) => r.n).join(',')}`)
  // Exactly one fastest, and it is the quicker of the two -- i.e. the marker
  // MOVED off lap 1 when lap 2 beat it.
  const bests = done.filter((r) => r.best)
  if (bests.length !== 1) fail.push(`${bests.length} rows marked fastest`)
  if (bests[0] && bests[0].n !== '2') fail.push(`row ${bests[0].n} is marked fastest, but lap 2 was quicker`)
  // ...and the row it moved off now carries the gap it did not have before.
  const slower = done.find((r) => !r.best)
  if (slower) {
    const want = '+' + (afterTwo.lapTimesRaw[0] - afterTwo.bestLapRaw).toFixed(2)
    if (slower.d !== want) fail.push(`lap ${slower.n} shows gap "${slower.d}", the sim says ${want}`)
  }
  if (live) {
    if (live.n !== '3') fail.push(`the live row is labelled "${live.n}" on lap 3`)
    if (live.d !== '') fail.push(`the live row printed a gap "${live.d}"`)
    // Tenths, deliberately -- a hundredths digit ticking in the periphery is
    // movement, and this row sits beside the road the player is watching.
    if (!/^\d:\d\d\.\d$/.test(live.t)) fail.push(`the live row reads "${live.t}", not m:ss.t`)
  }
  // It is a clock: three sim seconds later it says something else.
  const liveBefore = live ? live.t : null
  const liveAfter = (ticked.rows.find((r) => r.live) || {}).t ?? null
  if (liveBefore && liveAfter === liveBefore) fail.push(`the live lap clock is frozen at ${liveBefore}`)
  // And the banked rows did NOT move while it ran.
  const bankedBefore = done.map((r) => r.t).join('|')
  const bankedAfter = ticked.rows.filter((r) => !r.live).map((r) => r.t).join('|')
  if (bankedBefore !== bankedAfter) fail.push(`a banked split changed under the live clock: ${bankedBefore} -> ${bankedAfter}`)

  // --- WHERE IT ALL LANDS ---------------------------------------------------
  // The block is allowed the corner and nothing else. Vertically it must stay
  // inside the top half, well clear of the band the road occupies at chase
  // framing; horizontally it must not reach the centre line, where the car is.
  for (const s of [start, afterOne, afterTwo, ticked]) {
    if (!s.block) { fail.push('no top-left block in the DOM'); continue }
    if (s.block.bottom > 0.45) fail.push(`the top-left block reaches ${s.block.bottom} down the frame`)
    if (s.block.right > 0.42) fail.push(`the top-left block reaches ${s.block.right} across the frame`)
    if (s.block.left > 0.06) fail.push(`the top-left block starts at ${s.block.left}, not against the edge`)
  }
  for (const r of afterTwo.rows) {
    if (r.bottom > 0.45) fail.push(`split row ${r.n} reaches ${r.bottom} down the frame`)
    if (r.right > 0.42) fail.push(`split row ${r.n} reaches ${r.right} across the frame`)
  }
  // ...and it must not have shoved its neighbour off the screen on the way.
  // The list adds height to the grid's top row, and on the compact layout the
  // item slots sit in the row below it on the same edge.
  for (const s of [start, afterTwo]) {
    if (!s.items || !s.block) continue
    if (s.items.top < s.block.bottom) {
      fail.push(`the item slots start at ${s.items.top}, above the split list's ${s.block.bottom}`)
    }
    if (s.items.bottom > 1) fail.push(`the item slots were pushed to ${s.items.bottom} -- off the frame`)
  }

  // --- the ceremony ---------------------------------------------------------
  // The list goes with the position block it hangs off, and for the same
  // reason: the ceremony is a camera shot of the car, the finish card already
  // carries the place and the total, and the results table behind it carries
  // every lap. An orphaned column of numbers in the corner of a cinematic,
  // under a heading that is no longer there, is clutter with no owner.
  if (ceremony.gamePhase !== 'ceremony' && ceremony.gamePhase !== 'results') {
    fail.push(`the race never finished (phase "${ceremony.gamePhase}")`)
  } else if (ceremony.gamePhase === 'ceremony') {
    if (!ceremony.hudCeremony) fail.push('the HUD is not in ceremony mode after the finish')
    if (ceremony.block && ceremony.block.shown) fail.push('the lap splits are still on screen during the ceremony')
    if (ceremony.rows.some((r) => r.h > 0)) fail.push('a split row still has a box during the ceremony')
  }

  console.log(fail.length ? '\nSPLITS FAILED: ' + fail.join('; ') : '\nSPLITS PASSED')
  await browser.close()
  server.close()
  process.exit(fail.length ? 1 : 0)
}


// ---------------------------------------------------------------------------
// --ending: the finish probe
// ---------------------------------------------------------------------------
if (ENDING) {
  for (let i = 0; i < 240; i++) {
    if ((await simState()).p === 'racing') break
    await page.waitForTimeout(500)
  }

  /** Everything about the ending, read straight off the live objects. */
  const cerState = () => page.evaluate(() => {
    const g = window.__GAME__
    const st = g.race && g.race.state
    const cam = g.chase && g.chase.camera
    const r = st && st.racers[g.localId]
    const card = document.querySelector('.sg-fin')
    const num = document.querySelector('.sg-fin__num')
    const ord = document.querySelector('.sg-fin__ord')
    const tm = document.querySelector('.sg-fin__time')
    const fld = document.querySelector('.sg-fin__field')
    const skip = document.querySelector('.sg-fin__skip')
    const hud = document.querySelector('.sg-hud')
    const vis = (n) => {
      if (!n) return null
      const b = n.getBoundingClientRect()
      return b.width > 0 && b.height > 0 && getComputedStyle(n).display !== 'none'
    }
    return {
      gamePhase: g.phase,
      simPhase: st ? st.phase : null,
      cerT: +(g.cerT ?? -1).toFixed(2),
      finished: r ? r.finished : null,
      position: r ? r.position : null,
      // Proof the car did not stop on the line.
      speed: r ? +Math.hypot(r.vel.x, r.vel.z).toFixed(1) : null,
      stillRacing: st ? st.racers.filter((x) => !x.finished).length : null,
      cinematic: g.chase ? !!g.chase.cinematic : null,
      fov: cam ? +cam.fov.toFixed(1) : null,
      // Camera bearing from the car: what the orbit walks.
      az: (cam && r) ? +Math.atan2(cam.position.x - r.pos.x, cam.position.z - r.pos.z).toFixed(3) : null,
      camDist: (cam && r) ? +Math.hypot(cam.position.x - r.pos.x, cam.position.y - r.pos.y, cam.position.z - r.pos.z).toFixed(2) : null,
      camAbove: (cam && r) ? +(cam.position.y - r.pos.y).toFixed(2) : null,
      card: {
        shown: vis(card),
        place: num && ord ? (num.textContent + ord.textContent) : null,
        time: tm ? tm.textContent : null,
        field: fld ? fld.textContent : null,
        skipDisabled: skip ? skip.disabled : null,
      },
      hudCeremony: hud ? hud.classList.contains('is-ceremony') : null,
      // The instruments that describe a car nobody is steering.
      gaugeShown: vis(document.querySelector('.sg-hud__gauge')),
      itemsShown: vis(document.querySelector('.sg-hud__items')),
      mapShown: vis(document.querySelector('.sg-map__canvas')),
      resultsShown: !!document.querySelector('.sg-screen--results')
        && document.querySelector('.sg-fe') !== null
        && !document.querySelector('.sg-fe').classList.contains('is-hidden')
        && document.querySelector('.sg-fe').dataset.screen === 'results',
    }
  })

  /**
   * Shove the local racer to `gap` metres short of the flag. The AI field is
   * left where it is, which is the interesting case: the player finishes with
   * the rest of the grid still out on the circuit.
   */
  const jumpToFinish = (gap) => page.evaluate((g2) => {
    const g = window.__GAME__
    const st = g.race.state
    const line = st.totalLaps * g.track.length
    const r = st.racers[g.localId]
    r.totalS = line - g2
    return { line: Math.round(line), totalS: Math.round(r.totalS) }
  }, gap)

  const jump = await jumpToFinish(40)
  const timeline = []
  const grab = async (name) => {
    const st = await cerState()
    timeline.push({ name, ...st })
    await page.screenshot({ path: new URL(`../shots/${tag}-end-${name}.png`, import.meta.url).pathname })
    return st
  }

  // Cross the line. Hold accelerate so the sim carries the car over for real.
  await page.keyboard.down('KeyW')
  let crossed = null
  for (let i = 0; i < 200; i++) {
    const st = await cerState()
    if (st.gamePhase === 'ceremony') { crossed = st; break }
    await page.waitForTimeout(250)
  }
  await page.keyboard.up('KeyW')

  // The handover, then the orbit, then whatever the field is doing.
  await grab('01-handover')
  await page.waitForTimeout(1400)
  await grab('02-orbit-a')
  await page.waitForTimeout(1800)
  await grab('03-orbit-b')
  await page.waitForTimeout(1800)
  await grab('04-orbit-c')

  // Let it run out on its own (the max-duration cap plus the settle), and
  // watch for the results screen.
  let results = null
  for (let i = 0; i < 200; i++) {
    const st = await cerState()
    if (st.gamePhase === 'results') { results = st; break }
    await page.waitForTimeout(400)
  }
  await grab('05-results')

  const resultRows = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.sg-screen--results .sg-row')]
      .filter((n) => !n.hidden)
      .map((n) => ({
        pos: n.querySelector('.sg-row__p').textContent,
        pilot: n.querySelector('.sg-row__pilot').textContent,
        time: n.querySelector('.sg-row__time').textContent,
        you: n.classList.contains('is-you'),
      }))
    return {
      title: (document.querySelector('.sg-results__title') || {}).textContent ?? null,
      rows,
    }
  })

  // --- SKIP, on all three input methods -----------------------------------
  // The player has to be able to leave the shot from whatever they are holding.
  // Each of these gets its own race, because a skip ends the ceremony.
  /**
   * `ahead` AI cars are sent over the line first, so the player finishes in
   * (ahead + 1)th place. The ceremony has to hold for every finishing
   * position, not only for a win, and the card's rank styling switches on it.
   */
  const toCeremony = async (ahead = 0) => {
    await page.evaluate(() => window.__GAME__.startRace())
    await page.waitForTimeout(1500)
    for (let i = 0; i < 240; i++) {
      if ((await simState()).p === 'racing') break
      await page.waitForTimeout(500)
    }
    if (ahead > 0) {
      await page.evaluate((n) => {
        const g = window.__GAME__
        const st = g.race.state
        const line = st.totalLaps * g.track.length
        let done = 0
        for (const r of st.racers) {
          if (r.id === g.localId || done >= n) continue
          r.totalS = line - 6
          done++
        }
      }, ahead)
      // Let them cross for real, through resolveLaps, before the player does.
      await page.waitForTimeout(2500)
    }
    await jumpToFinish(40)
    await page.keyboard.down('KeyW')
    for (let i = 0; i < 200; i++) {
      if ((await cerState()).gamePhase === 'ceremony') break
      await page.waitForTimeout(250)
    }
    await page.keyboard.up('KeyW')
  }

  // 1. THE ON-SCREEN CONTROL -- a real tap on the mobile run, a click on
  //    desktop -- from a MID-PACK finish, so the card is photographed at a
  //    place that is not first.
  await toCeremony(3)
  // Sampled immediately: the skip control must still be dead inside the guard.
  const skipBefore = await cerState()
  // Then past the card's 620ms entrance, so the frame is the card at rest.
  await page.waitForTimeout(1400)
  const midPack = await cerState()
  await page.screenshot({ path: new URL(`../shots/${tag}-end-07-fourth.png`, import.meta.url).pathname })
  await page.waitForTimeout(1200)
  const skipArmed = await cerState()
  await activate(page.locator('.sg-fin__skip'), 15000).catch(() => {})
  await page.waitForTimeout(1200)
  const skipAfter = await cerState()
  await page.screenshot({ path: new URL(`../shots/${tag}-end-06-skipped.png`, import.meta.url).pathname })

  // 2. THE KEYBOARD. Shift is Drift; the skip is edge-triggered, so a press
  //    that was never released cannot count -- hence a fresh press here.
  await toCeremony()
  await page.waitForTimeout(2200)
  // Held for a while on purpose: under SwiftShader the page renders about
  // once a second, and the skip is read from the input frame the SIM sampled,
  // so a 200ms tap can fall entirely between two rendered frames.
  await page.keyboard.down('ShiftLeft')
  await page.waitForTimeout(2600)
  await page.keyboard.up('ShiftLeft')
  await page.waitForTimeout(1200)
  const skipKeyboard = await cerState()

  // 3. THE GAMEPAD. A standard-mapping pad, polled by the input manager on rAF.
  await page.evaluate(() => {
    window.__PAD2__ = {
      connected: true, index: 0, id: 'smoke pad', mapping: 'standard',
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    }
    navigator.getGamepads = () => [window.__PAD2__]
  })
  await toCeremony()
  await page.waitForTimeout(2200)
  // Button 0 (A / Cross) is Drift on the shipped pad map; 2 (X / Square) is Item.
  await page.evaluate(() => {
    window.__PAD2__.buttons[0].pressed = true
    window.__PAD2__.buttons[0].value = 1
  })
  await page.waitForTimeout(2600)
  await page.evaluate(() => {
    window.__PAD2__.buttons[0].pressed = false
    window.__PAD2__.buttons[0].value = 0
  })
  await page.waitForTimeout(900)
  const skipPad = await cerState()
  await page.evaluate(() => { navigator.getGamepads = () => [] })

  const report = { label, trackId, viewport, reduced: REDUCED, jump, crossed, timeline, results, resultRows, skipBefore, skipArmed, skipAfter, skipKeyboard, skipPad, midPack, errors }
  console.log(`\n=== ENDING ${label.toUpperCase()} ${trackId.toUpperCase()}${REDUCED ? ' [reduced-motion]' : ''} ===`)
  console.log('jump:', JSON.stringify(jump))
  const cols = ['name', 'gamePhase', 'simPhase', 'cerT', 'speed', 'stillRacing', 'cinematic', 'fov', 'az', 'camDist', 'camAbove']
  console.log(cols.map((c) => c.padStart(c === 'name' ? 12 : 11)).join(' '))
  for (const r of timeline) console.log(cols.map((c) => String(r[c]).padStart(c === 'name' ? 12 : 11)).join(' '))
  console.log('card:', JSON.stringify(timeline.map((r) => r.card)))
  console.log('hud:', JSON.stringify(timeline.map((r) => ({ cer: r.hudCeremony, gauge: r.gaugeShown, items: r.itemsShown, map: r.mapShown }))))
  console.log('results:', JSON.stringify(resultRows, null, 2))
  console.log('skip:', JSON.stringify({
    before: { t: skipBefore.cerT, disabled: skipBefore.card.skipDisabled },
    armed: { t: skipArmed.cerT, disabled: skipArmed.card.skipDisabled },
    button: { phase: skipAfter.gamePhase, results: skipAfter.resultsShown },
    keyboard: { phase: skipKeyboard.gamePhase, results: skipKeyboard.resultsShown },
    gamepad: { phase: skipPad.gamePhase, results: skipPad.resultsShown },
  }))
  console.log(`errors: ${errors.length}`)
  for (const e of errors.slice(0, 8)) console.log('  ERR ' + e.slice(0, 300))

  await writeFile(new URL(`../shots/${tag}-ending-report.json`, import.meta.url).pathname,
    JSON.stringify(report, null, 2))

  const fail = []
  if (errors.length) fail.push(`${errors.length} console errors`)
  if (!crossed) fail.push('the local racer never reached the ceremony')
  const moving = timeline.filter((r) => r.gamePhase === 'ceremony')
  if (!moving.length) fail.push('no ceremony frames captured')
  // THE BUG THIS WORK EXISTS TO FIX: the car must not stop on the line.
  for (const r of moving) {
    if (!(r.speed > 8)) fail.push(`${r.name}: finished car is doing ${r.speed} m/s -- it stopped on the line`)
    if (!r.cinematic) fail.push(`${r.name}: the chase rig still owns the camera`)
    if (!r.hudCeremony) fail.push(`${r.name}: HUD is not in ceremony mode`)
    if (r.gaugeShown) fail.push(`${r.name}: the speed/drift gauge is still on screen`)
    if (!r.card.shown) fail.push(`${r.name}: the finish card is not visible`)
  }
  // The orbit has to have MOVED. Two samples ~1.8s apart at 19 deg/s is ~0.6
  // rad; allow for the car turning under it and require a real change.
  const az = moving.map((r) => r.az).filter((v) => typeof v === 'number')
  if (az.length >= 2) {
    let travel = 0
    for (let i = 1; i < az.length; i++) {
      let d = az[i] - az[i - 1]
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      travel += d
    }
    if (REDUCED) {
      if (Math.abs(travel) > 1.6) fail.push(`reduced motion still orbited ${travel.toFixed(2)} rad`)
    } else if (Math.abs(travel) < 0.35) {
      fail.push(`the camera barely moved: ${travel.toFixed(2)} rad over the shot`)
    }
  }
  for (const r of moving) {
    if (!(r.camDist > 6 && r.camDist < 22)) fail.push(`${r.name}: camera is ${r.camDist}m from the car`)
    if (!(r.camAbove > 0.8)) fail.push(`${r.name}: camera is ${r.camAbove}m above the car`)
  }
  if (!results) fail.push('the ceremony never reached the results screen')
  if (!resultRows || resultRows.rows.length !== 8) fail.push(`results listed ${resultRows ? resultRows.rows.length : 0} rows`)
  // Settling the race is the whole reason results are honest; nobody may DNF.
  if (resultRows && resultRows.rows.some((r) => r.time === 'DNF')) fail.push('a racer DNF-ed: the settle loop did not finish the race')
  if (resultRows && !resultRows.rows.some((r) => r.you)) fail.push('the results table does not mark the local racer')
  if (skipBefore.card.skipDisabled !== true) fail.push('the skip control was live before the guard expired')
  // A finish that is not a win: the card must say so, and the ceremony must
  // run exactly as it does for a winner.
  if (midPack.position !== 4) fail.push(`mid-pack finish landed at P${midPack.position}, wanted P4`)
  if (midPack.card.place !== '4th') fail.push(`the card reads "${midPack.card.place}" for a 4th place`)
  if (!midPack.cinematic) fail.push('the finish shot did not start for a mid-pack finish')
  if (!(midPack.speed > 8)) fail.push(`mid-pack finisher is doing ${midPack.speed} m/s -- it stopped on the line`)
  if (skipArmed.card.skipDisabled !== false) fail.push('the skip control never became live')
  if (skipAfter.gamePhase !== 'results') fail.push(`the skip button left the game in "${skipAfter.gamePhase}"`)
  // Desktop only. On the mobile profile the input manager is running a touch
  // scheme, and sample() reads the touch layer rather than the key mask -- a
  // hardware keyboard does not drive a phone-profile race at all, ceremony or
  // not, and that is a whole-game behaviour rather than something the finish
  // sequence gets to change. The touch player's skip is the on-screen control,
  // tapped for real above.
  if (label !== 'mobile' && skipKeyboard.gamePhase !== 'results') {
    fail.push(`keyboard skip left the game in "${skipKeyboard.gamePhase}"`)
  }
  if (skipPad.gamePhase !== 'results') fail.push(`gamepad skip left the game in "${skipPad.gamePhase}"`)

  console.log(fail.length ? '\nENDING FAILED: ' + fail.join('; ') : '\nENDING PASSED')
  await browser.close()
  server.close()
  process.exit(fail.length ? 1 : 0)
}


/**
 * Wait for SIM time, not wall time.
 *
 * Under SwiftShader the page renders at roughly 1 fps, and the loop clamps a
 * frame to 0.25s of simulation (the standard spiral-of-death guard, and correct
 * game behaviour -- a backgrounded tab must not fast-forward the race). The net
 * effect is that the sim advances about a quarter of a second per wall second,
 * so every fixed page.waitForTimeout in a drive script silently becomes a
 * quarter of the input it looks like. Holding a key "for 9 seconds" was really
 * holding it for 2, which is not long enough to bank a drift tier and left the
 * car still inside the rocket-start bog at the final sample.
 */
async function waitSim(seconds, capMs = 90000) {
  const start = (await simState()).t
  const t0 = Date.now()
  while (Date.now() - t0 < capMs) {
    const st = await simState()
    if (st.t - start >= seconds) return st
    await page.waitForTimeout(250)
  }
  return await simState()
}

// Drive: hold accelerate, steer, drift.
await page.keyboard.down('KeyW')
for (let i = 0; i < 120; i++) {
  const st = await simState()
  if (st.p === 'racing' && st.v > 25) break
  await page.waitForTimeout(500)
}
await shot('4-racing')
// Hold a drift long enough to reach a high charge tier. tierTimes[3] is ~3.2s
// of charge, so 5 seconds of SIM time is a comfortable margin.
await page.keyboard.down('KeyD')
await page.keyboard.down('ShiftLeft')
await waitSim(5)
await shot('5-drifting')
await page.keyboard.up('ShiftLeft')
await waitSim(1)
await shot('6-boost')
await page.keyboard.up('KeyD')
await waitSim(4)
await shot('7-racing2')
await page.keyboard.up('KeyW')

// ---------------------------------------------------------------------------
// Settings dialog + the visual-intensity controls
//
// Three things here, none of which a static read of the source can settle.
//
// 1. The dialog is VISIBLE AT REST. This panel has already shipped once at
//    opacity 0 -- an entry animation with `both` fill-mode, which meant every
//    reduced-motion user got a scrim and nothing behind it. The resting
//    opacity is read back off the live element, not assumed.
// 2. The Glare control is really CONNECTED. The segment is pressed the way a
//    player presses it (a real tap on the mobile run, a click on desktop) and
//    the renderer's own uniform is read back on the other side.
// 3. The choice SURVIVES A QUALITY REBUILD. The adaptive scaler tears the post
//    chain down and builds a new one mid-race; a new chain starts at the tuned
//    look, so something has to put the player's choice back on it.
// ---------------------------------------------------------------------------

// Pin a tier that actually has a post chain: under SwiftShader the scaler has
// long since dropped to `low`, which builds no composer, and a probe that
// measured that would conclude the control did nothing.
await page.evaluate(() => {
  const g = window.__GAME__
  if (g.tier === 'low') g.setTier('medium')
  g.qualityCooldown = 1e9
  g.frameTimes.length = 0
})
await page.waitForTimeout(1200)

// A fake pad, installed before the dialog opens because the panel decides
// whether to start its poller from `typeof navigator.getGamepads`. There is no
// real controller in a headless browser and "the pad reaches the new control"
// is exactly the claim that needs testing rather than asserting.
await page.evaluate(() => {
  window.__PAD__ = {
    connected: true, index: 0, id: 'smoke pad', mapping: 'standard',
    axes: [0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
  }
  navigator.getGamepads = () => [window.__PAD__]
})
/** Hold a standard-mapping button for long enough that the 60ms poller sees it. */
const padPress = async (index) => {
  await page.evaluate((i) => { window.__PAD__.buttons[i].pressed = true }, index)
  await page.waitForTimeout(200)
  await page.evaluate((i) => { window.__PAD__.buttons[i].pressed = false }, index)
  await page.waitForTimeout(300)
}
const PAD = { down: 13, right: 15, left: 14, a: 0, b: 1 }
const focusInfo = () => page.evaluate(() => {
  const a = document.activeElement
  if (!a) return null
  // Text alone does not identify a control here: two different strips can both
  // be sitting on a step called "Minimal". Qualify it with what owns it.
  const seg = a.closest ? a.closest('.sgset-seg') : null
  const owner = seg ? seg.getAttribute('aria-label') : (a.className || a.tagName)
  return { cls: a.className, text: (a.textContent || '').trim().slice(0, 20), key: owner + '|' + (a.textContent || '').trim().slice(0, 20) }
})

await activate(page.locator('.sg-tools__btn[aria-label="Settings and controls"]'), 25000)
await page.waitForSelector('.sgset.is-open', { state: 'visible', timeout: 15000 })
// The canvas behind is running at ~1fps under SwiftShader; give the compositor
// room to raster the dialog before photographing it.
await page.waitForTimeout(4000)
await shot('8-settings')

/** Both segments' checked labels, plus what the renderer is actually holding. */
const readFx = () => page.evaluate(() => {
  const g = window.__GAME__
  const p = g.post
  const mat = p ? p.compositeMat : null
  const checked = (label) => {
    const b = document.querySelector(`.sgset-seg[aria-label="${label}"] [aria-checked="true"]`)
    return b ? b.textContent : null
  }
  const dlg = document.querySelector('.sgset__dialog')
  return {
    glareLabel: checked('Glare'),
    screenLabel: checked('Speed effects'),
    uGlare: mat ? +mat.uniforms.uGlare.value.toFixed(3) : null,
    uScreen: mat ? +mat.uniforms.uScreen.value.toFixed(3) : null,
    bloomEnabled: p && p.bloom ? p.bloom.enabled : null,
    tier: g.tier,
    dialogOpacity: dlg ? +getComputedStyle(dlg).opacity : null,
    dialogRect: dlg ? (() => { const r = dlg.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] })() : null,
    // What is actually on top at the middle of the dialog: proof nothing is
    // painting over the panel, which is how it went invisible last time.
    onTop: (() => {
      const r = dlg && dlg.getBoundingClientRect()
      if (!r) return null
      const n = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return n ? (n.className || n.tagName) : null
    })(),
    steps: document.querySelectorAll('.sgset-seg[aria-label="Glare"] .sgset-seg__btn').length,
    // Smallest tap target on either strip, in CSS pixels.
    minTarget: (() => {
      const b = document.querySelectorAll('.sgset-row--stack .sgset-seg__btn')
      let w = 1e9, h = 1e9
      for (const n of b) {
        const r = n.getBoundingClientRect()
        w = Math.min(w, r.width); h = Math.min(h, r.height)
      }
      return b.length ? [Math.round(w), Math.round(h)] : null
    })(),
    stored: (() => {
      try { return JSON.parse(localStorage.getItem('spacegen.settings') || '{}') } catch { return null }
    })(),
  }
})

/** Press one step of one strip, the way a player would. */
const pressFx = async (label, step) => {
  await activate(page.locator(`.sgset-seg[aria-label="${label}"] .sgset-seg__btn`, { hasText: step }).first(), 25000)
  await page.waitForTimeout(400)
}

const fx = { atRest: await readFx() }
await pressFx('Glare', 'OFF')
fx.glareOff = await readFx()
await pressFx('Speed effects', 'MINIMAL')
fx.screenMinimal = await readFx()

// Force the rebuild the adaptive scaler would have done, and look again.
await page.evaluate(() => {
  const g = window.__GAME__
  g.setTier(g.tier === 'high' ? 'medium' : 'high')
})
await page.waitForTimeout(1200)
fx.afterRebuild = await readFx()

// And the keyboard path to the same control: focus it, then arrow along it.
await page.evaluate(() => {
  document.querySelector('.sgset-seg[aria-label="Glare"] [aria-checked="true"]').focus()
})
await page.keyboard.press('ArrowLeft')
await page.waitForTimeout(400)
fx.afterArrowLeft = await readFx()

// --- the pad ---------------------------------------------------------------
// D-pad down walks the dialog, right/left work the control under focus, A
// presses it, B closes. Nothing here touches the mouse or the keyboard.
const pad = { start: await focusInfo() }
await padPress(PAD.down)
pad.afterDown = await focusInfo()
// Park focus on the Glare strip and step it with the pad alone.
await page.evaluate(() => {
  document.querySelector('.sgset-seg[aria-label="Glare"] [aria-checked="true"]').focus()
})
await padPress(PAD.right)
pad.afterRight = await readFx()
await padPress(PAD.left)
pad.afterLeft = await readFx()
// A on a focused step selects it, the same as a tap.
await page.evaluate(() => {
  const b = document.querySelectorAll('.sgset-seg[aria-label="Speed effects"] .sgset-seg__btn')
  b[b.length - 1].focus()
})
await padPress(PAD.a)
pad.afterA = await readFx()
// B is the pad's Escape.
await padPress(PAD.b)
await page.waitForTimeout(400)
pad.closed = await page.evaluate(() => !document.querySelector('.sgset.is-open'))

// ...and the keyboard closes it too, after a reopen.
await activate(page.locator('.sg-tools__btn[aria-label="Settings and controls"]'), 25000)
await page.waitForSelector('.sgset.is-open', { state: 'visible', timeout: 15000 })
await page.waitForTimeout(800)
await page.keyboard.press('Escape')
await page.waitForTimeout(500)
const fxClosed = await page.evaluate(() => ({
  open: !!document.querySelector('.sgset.is-open'),
  phase: window.__GAME__.phase,
}))

// Pull live state out of the running game.
const diag = await page.evaluate(() => {
  const g = window.__GAME__
  if (!g) return { ok: false, reason: 'no __GAME__' }
  const race = g.race
  const st = race && race.state
  const canvas = document.getElementById('sg-canvas')
  return {
    ok: true,
    hasRace: !!st,
    phase: st ? st.phase : null,
    time: st ? +st.time.toFixed(2) : null,
    racers: st ? st.racers.length : 0,
    localSpeed: st ? +Math.hypot(st.racers[0].vel.x, st.racers[0].vel.z).toFixed(2) : null,
    localS: st ? +st.racers[0].totalS.toFixed(1) : null,
    localPos: st ? st.racers[0].position : null,
    anyMoved: st ? st.racers.some((r) => r.totalS > 20) : false,
    drawCalls: g.renderer ? g.renderer.info.render.calls : null,
    triangles: g.renderer ? g.renderer.info.render.triangles : null,
    // renderer.info.render describes the LAST thing drawn, and with a post
    // chain that is the composite's single fullscreen quad -- which is why the
    // two numbers above have always read 1 and 1. Draw the scene once directly
    // to get the figures that actually describe the world. One extra frame, at
    // teardown, off the clock. The VFX pool and every ribbon are drawn whether
    // or not anything is happening (nothing here is frustum-culled and the
    // instance counts are fixed), so this is the same count a drifting frame
    // would report.
    scene: (() => {
      try {
        g.renderer.render(g.scene, g.chase.camera)
        return {
          calls: g.renderer.info.render.calls,
          tris: g.renderer.info.render.triangles,
        }
      } catch { return null }
    })(),
    programs: g.renderer ? g.renderer.info.programs.length : null,
    // What the VFX pass believes about the OS reduced-motion preference. It
    // reads matchMedia itself (the Game's own flag never reaches it), and
    // "the strobe guard is wired to the right signal" is not something a
    // static read of the source can settle -- only being that user can.
    vfxReduced: g.vfx ? g.vfx.reduced : null,
    fps: g.fps ? +g.fps.toFixed(1) : null,
    tier: g.tier,
    // Private in TypeScript, present at runtime -- same as `race` and `tier`
    // above. This is the assertion the --track flag exists for: the sim must be
    // running the circuit the menu was asked for, not the default.
    trackId: g.track && g.track.def ? g.track.def.id : null,
    canvasW: canvas ? canvas.width : 0,
    canvasH: canvas ? canvas.height : 0,
  }
})

/**
 * The top-left stack, on an ORDINARY race with no laps closed yet.
 *
 * The dedicated probe (--splits) covers what the list says; this covers the
 * thing every run should notice: that the widget is on screen from the green
 * light rather than appearing a minute in, and that it stays in its corner.
 */
const topLeft = await page.evaluate(() => {
  const cv = document.getElementById('sg-canvas')
  const W = cv.clientWidth, H = cv.clientHeight
  const wrap = document.querySelector('.sg-hud__pos')
  const rows = [...document.querySelectorAll('.sg-splits .sg-split')].filter((n) => !n.hidden)
  const b = wrap ? wrap.getBoundingClientRect() : null
  return {
    rows: rows.length,
    live: rows.filter((n) => n.classList.contains('sg-split--live')).length,
    text: rows.map((n) => n.textContent.trim()),
    right: b ? +((b.x + b.width) / W).toFixed(3) : null,
    bottom: b ? +((b.y + b.height) / H).toFixed(3) : null,
  }
})

// Analyse the actual composited screenshot. Reading back the WebGL drawing
// buffer with drawImage always returns black here because the renderer is
// created without preserveDrawingBuffer, so that check was a false negative.
const shotBuf = await page.screenshot()
const pixels = analysePng(shotBuf)

console.log(`\n=== ${label.toUpperCase()} ${trackId.toUpperCase()} (${viewport.width}x${viewport.height}) ===`)
console.log('clicked:', t1, '->', trackName, '->', t2, '->', t3)
console.log('trackUi:', JSON.stringify(trackUi))
console.log('fx:', JSON.stringify(fx, null, 2))
console.log('pad:', JSON.stringify(pad, null, 2))
console.log('fxClosed:', JSON.stringify(fxClosed))
console.log('diag:', JSON.stringify(diag, null, 2))
console.log('topLeft:', JSON.stringify(topLeft))
console.log('pixels:', JSON.stringify(pixels))
console.log(`errors: ${errors.length}`)
for (const e of errors.slice(0, 12)) console.log('  ERR ' + e.slice(0, 400))
console.log(`warnings: ${warnings.length}`)
for (const w of warnings.slice(0, 5)) console.log('  WARN ' + w.slice(0, 200))

await writeFile(new URL(`../shots/${tag}-report.json`, import.meta.url).pathname,
  JSON.stringify({ trackUi, fx, pad, fxClosed, diag, topLeft, pixels, errors, warnings }, null, 2))

await browser.close()
server.close()

const fail = []
if (errors.length) fail.push(`${errors.length} console errors`)
if (trackUi.cards < 2) fail.push(`track screen listed ${trackUi.cards} circuits`)
if (trackUi.selected !== trackName) fail.push(`track card shows "${trackUi.selected}", wanted "${trackName}"`)
if (trackUi.detail !== trackName) fail.push(`briefing shows "${trackUi.detail}", wanted "${trackName}"`)
if (!(trackUi.roadPaths > 0)) fail.push('route map drew no road')
if (!(trackUi.surfaceChips > 0)) fail.push('route map has no surface legend')
if (!(trackUi.mixSegs > 0)) fail.push('surface mix bar is empty')
if (!(trackUi.elevPts > 0)) fail.push('elevation profile drew nothing')
// The settings dialog once shipped invisible at rest. Prove this one is not.
if (!(trackUi.mapOpacity > 0.9)) fail.push(`route map settles at opacity ${trackUi.mapOpacity}`)
// --- settings dialog + visual intensity ------------------------------------
// The same regression the route map is guarded against, on the panel that
// actually shipped it.
if (!(fx.atRest.dialogOpacity > 0.9)) fail.push(`settings dialog settles at opacity ${fx.atRest.dialogOpacity}`)
if (fx.atRest.steps !== 4) fail.push(`glare control has ${fx.atRest.steps} steps, wanted 4`)
const lvl = (v) => (v ?? '').toUpperCase()
// Untouched, the two controls follow the reduced-motion preference. That is a
// DEFAULT, not a lock -- the presses below move them anyway.
const wantGlare = REDUCED ? 'SOFTER' : 'FULL'
const wantScreen = REDUCED ? 'MINIMAL' : 'FULL'
const wantUGlare = REDUCED ? 0.6 : 1
const wantUScreen = REDUCED ? 0.35 : 1
if (lvl(fx.atRest.glareLabel) !== wantGlare) fail.push(`glare starts at "${fx.atRest.glareLabel}", wanted ${wantGlare}`)
if (lvl(fx.atRest.screenLabel) !== wantScreen) fail.push(`speed effects start at "${fx.atRest.screenLabel}", wanted ${wantScreen}`)
if (fx.atRest.uScreen !== wantUScreen) fail.push(`speed effects start left uScreen at ${fx.atRest.uScreen}`)
// Nothing chosen yet, so nothing about them is in the record.
if (fx.atRest.stored?.glare !== undefined || fx.atRest.stored?.screenFx !== undefined) {
  fail.push('an unchosen level was written to localStorage')
}
if (fx.atRest.uGlare !== wantUGlare) fail.push(`glare starts left uGlare at ${fx.atRest.uGlare}`)
// The whole point of the control: Off must be no bloom energy, not a dimmer.
if (fx.glareOff.uGlare !== 0) fail.push(`glare OFF left uGlare at ${fx.glareOff.uGlare}`)
if (fx.glareOff.bloomEnabled !== false) fail.push('glare OFF left the bloom pass enabled')
if (lvl(fx.glareOff.glareLabel) !== 'OFF') fail.push(`glare Off did not check its own button (${fx.glareOff.glareLabel})`)
if (fx.screenMinimal.uScreen !== 0.35) fail.push(`speed effects MINIMAL left uScreen at ${fx.screenMinimal.uScreen}`)
if (fx.screenMinimal.uGlare !== 0) fail.push('the two controls are not independent')
// Persisted, and only what was actually chosen.
if (fx.screenMinimal.stored?.glare !== 'off') fail.push(`localStorage kept glare="${fx.screenMinimal.stored?.glare}"`)
if (fx.screenMinimal.stored?.screenFx !== 'low') fail.push(`localStorage kept screenFx="${fx.screenMinimal.stored?.screenFx}"`)
// Survives the chain being torn down and rebuilt under it.
if (fx.afterRebuild.uGlare !== 0 || fx.afterRebuild.bloomEnabled !== false) {
  fail.push(`quality rebuild handed the glare back (uGlare ${fx.afterRebuild.uGlare}, bloom ${fx.afterRebuild.bloomEnabled})`)
}
if (fx.afterRebuild.uScreen !== 0.35) fail.push(`quality rebuild reset uScreen to ${fx.afterRebuild.uScreen}`)
// Keyboard reaches it: one press left of OFF is MINIMAL.
if (lvl(fx.afterArrowLeft.glareLabel) !== 'MINIMAL') fail.push(`arrow key left glare at "${fx.afterArrowLeft.glareLabel}"`)
if (fx.afterArrowLeft.uGlare !== 0.35) fail.push(`arrow key left uGlare at ${fx.afterArrowLeft.uGlare}`)
// Four targets on one strip must still be pressable with a thumb.
if (fx.atRest.minTarget && fx.atRest.minTarget[0] < 44) fail.push(`narrowest step is ${fx.atRest.minTarget[0]}px wide`)
if (fx.atRest.minTarget && fx.atRest.minTarget[1] < 26) fail.push(`shortest step is ${fx.atRest.minTarget[1]}px tall`)
// The pad, which is the input the panel had no path for until now.
if (!pad.afterDown || pad.afterDown.key === (pad.start && pad.start.key)) {
  fail.push(`pad down did not move focus (${JSON.stringify(pad.afterDown)})`)
}
if (lvl(pad.afterRight.glareLabel) !== 'OFF') fail.push(`pad right left glare at "${pad.afterRight.glareLabel}"`)
if (lvl(pad.afterLeft.glareLabel) !== 'MINIMAL') fail.push(`pad left left glare at "${pad.afterLeft.glareLabel}"`)
if (lvl(pad.afterA.screenLabel) !== 'OFF') fail.push(`pad A left speed effects at "${pad.afterA.screenLabel}"`)
if (pad.afterA.uScreen !== 0) fail.push(`pad A left uScreen at ${pad.afterA.uScreen}`)
if (!pad.closed) fail.push('pad B did not close the settings dialog')
if (fxClosed.open) fail.push('Escape did not close the settings dialog')
if (fxClosed.phase !== 'racing') fail.push(`closing settings left the game in "${fxClosed.phase}"`)
if (!diag.ok || !diag.hasRace) fail.push('race never started')
if (diag.trackId !== trackId) fail.push(`raced ${diag.trackId}, asked for ${trackId}`)
if (!diag.anyMoved) fail.push('no racer moved')
// Progress, not instantaneous speed: the drive script deliberately ends with a
// hard drift into a wall, so the car is legitimately slow at the final sample.
if (diag.localS !== null && diag.localS < 80) fail.push(`local racer only covered ${diag.localS}m - input may not be reaching the sim`)
// --- the lap-split list, on an ordinary race -------------------------------
// No lap has closed yet at this point, so the list is exactly the live row:
// present from the green light, in the corner, and nowhere near the road.
if (topLeft.rows !== 1) fail.push(`${topLeft.rows} split rows before any lap closed, wanted 1`)
if (topLeft.live !== 1) fail.push('the lap in progress has no row in the split list')
if (topLeft.bottom !== null && topLeft.bottom > 0.45) {
  fail.push(`the top-left block reaches ${topLeft.bottom} down the frame`)
}
if (topLeft.right !== null && topLeft.right > 0.42) {
  fail.push(`the top-left block reaches ${topLeft.right} across the frame`)
}
if (pixels && pixels.nonBlackPct < 20) fail.push(`canvas looks blank (${pixels.nonBlackPct}% non-black)`)
if (fail.length) { console.log('\nSMOKE FAILED: ' + fail.join('; ')); process.exit(1) }
console.log('\nSMOKE PASSED')
