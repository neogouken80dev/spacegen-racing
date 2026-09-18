/**
 * THE CHAMPIONSHIP PODIUM, PHOTOGRAPHED — and the round card on the way there.
 *
 * Two features, one harness, because they are two halves of the same thing:
 * the round card is what a circuit race opens with and the podium is what the
 * circuit closes with, and both are invisible in a unit test.
 *
 * WHAT THIS MEASURES RATHER THAN ASSERTS BY EYE
 *
 *   1. THE ROUND CARD IS ABSENT IN SINGLE-RACE MODE. Not "present and empty":
 *      the element must be hidden, because a stray caption over the racing
 *      line is the exact failure ui/cheer.ts spends a paragraph avoiding.
 *   2. ...and present, with the right round number and the right circuit name,
 *      in circuit mode. Read off the DOM, not off a screenshot.
 *   3. ...and gone again once the race is live, within ROUND_FADE.
 *   4. THE PODIUM'S COST. The renderer's own draw-call and triangle counters,
 *      taken on a real frame, against the same counters taken on a racing
 *      frame of the same circuit. The claim being tested is that the reward
 *      is not the most expensive frame in the game.
 *   5. FRAME COST. renderer frame time over a window of real frames, with the
 *      podium up and with a race up, on the same machine in the same run --
 *      the only comparison a software renderer can make honestly.
 *   6. THE CAST. Three steps, the right three drivers, an EMPTY seat in each
 *      parked car (the pilot is on the step), and the card naming all three.
 *   7. REDUCED MOTION. The camera must not move inside a beat and the beats
 *      must still cut.
 *   8. THE SKIP. Disabled inside the guard, live after it, and it leaves.
 *   9. THE CARD IS NOT ON THE CHAMPION'S FACE. Per beat, the winner's head is
 *      projected through the LIVE camera and its screen box is intersected
 *      with the standings card's own rect. The shipped podium put the panel
 *      directly over the gold head on two beats and nothing noticed, because
 *      the only overlap being measured was card-against-card. A subject the UI
 *      is sitting on is invisible to every numeric gate that does not know
 *      where the subject is, so the scene publishes it (PodiumStage.champHead)
 *      and this reads it.
 *  10. THE PILOT FIGURES STAND ON THE STEPS. `PodiumStats.soleGap` is the gap
 *      between the built figure's lowest point and the step top; the placement
 *      is deliberately not fudged to hide a non-zero one.
 *
 * HOW IT GETS THERE. Racing eight rounds through the shipping path takes about
 * forty minutes of real time and under SwiftShader a great deal more, so the
 * circuit save is WRITTEN to localStorage with seven rounds already banked and
 * round 8 is driven for real -- through startRace, the sim, the ceremony,
 * scoreCircuitRound and into the podium. Everything this probe is about is
 * downstream of that last round.
 *
 * NEEDS dist/: run `npx vite build` first.
 *
 *   node tools/probe-podium.mjs [--mobile] [--landscape] [--reduced]
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
  '.mp3': 'audio/mpeg',
}
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0])
    if (p === '/api/leaderboard') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ rows: [], rank: 0 }))
      return
    }
    if (p === '/' || p.endsWith('/')) p += 'index.html'
    const buf = await readFile(join(ROOT, p))
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' })
    res.end(buf)
  } catch { res.writeHead(404); res.end('nf') }
})
await new Promise((r) => server.listen(0, r))
const url = `http://127.0.0.1:${server.address().port}/`

const LANDSCAPE = process.argv.includes('--landscape')
const MOBILE = LANDSCAPE || process.argv.includes('--mobile')
const REDUCED = process.argv.includes('--reduced')
/**
 * Force a quality tier before the round is raced, so the podium is BUILT at it.
 *
 * Without this the probe measures whatever detectTier() guesses for a headless
 * Chromium (medium: no deviceMemory, so it assumes 4GB), and the budget claim
 * is about the floor device, which is `low`.
 */
const TIER = (process.argv.find((a) => a.startsWith('--tier=')) || '').split('=')[1] || ''
const VIEWPORT = LANDSCAPE ? { width: 915, height: 412 }
  : MOBILE ? { width: 412, height: 915 } : { width: 1440, height: 810 }
const KIND = (LANDSCAPE ? 'mobilels' : MOBILE ? 'mobile' : 'desktop')
  + (REDUCED ? '-calm' : '') + (TIER ? '-' + TIER : '')
const OUT = new URL('../shots/podium/', import.meta.url).pathname
await mkdir(OUT, { recursive: true })

const errors = []
const note = (m) => { errors.push(m); console.log('  !! ' + m) }

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
page.on('pageerror', (e) => note('page error: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') note('console: ' + m.text()) })

await page.goto(url, { waitUntil: 'load', timeout: 40000 })
await page.waitForFunction(() => !!window.__GAME__, null, { timeout: 60000 })
await page.waitForTimeout(2200)

await page.evaluate(() => {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k && (k.startsWith('sg.board.') || k.startsWith('sg.records.') || k === 'sg.circuit')) {
        localStorage.removeItem(k)
      }
    }
  } catch { /* blocked */ }
})

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

const phase = () => page.evaluate(() => {
  const g = window.__GAME__
  const st = g.race?.state
  return { p: g.phase, sp: st?.phase ?? '-', t: +(st?.time ?? 0).toFixed(1), podT: +(g.podT ?? -1).toFixed(2) }
})

const readRound = () => page.evaluate(() => {
  const el = document.querySelector('.sg-ctr__round')
  if (!el) return { present: false }
  const cs = getComputedStyle(el)
  return {
    present: true,
    hidden: el.hidden,
    num: el.querySelector('.sg-ctr__roundNum')?.textContent ?? '',
    name: el.querySelector('.sg-ctr__roundName')?.textContent ?? '',
    opacity: +cs.opacity,
    box: el.getBoundingClientRect().toJSON(),
  }
})

const readPodCard = () => page.evaluate(() => {
  const wrap = document.querySelector('.sg-pod')
  if (!wrap) return { present: false }
  const rows = [...document.querySelectorAll('.sg-pod__row')].map((r) => ({
    place: r.querySelector('.sg-pod__place')?.textContent ?? '',
    pilot: r.querySelector('.sg-pod__pilot')?.textContent ?? '',
    chassis: r.querySelector('.sg-pod__chassis')?.textContent ?? '',
    pts: r.querySelector('.sg-pod__pts')?.textContent ?? '',
    you: r.classList.contains('is-you'),
    rail: getComputedStyle(r).borderLeftColor,
  }))
  const skip = document.querySelector('.sg-pod__skip')
  const box = (sel) => {
    const e = document.querySelector(sel)
    if (!e) return null
    const b = e.getBoundingClientRect()
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
  }
  const head = box('.sg-pod__head')
  const rowsBox = box('.sg-pod__rows')
  // THE ONE LAYOUT BUG THAT ACTUALLY HAPPENED: the head and the rows shared a
  // grid row, so on a viewport where the rows were the taller of the two they
  // were drawn straight over the title. Overlap in pixels, not by eye.
  const overlap = head && rowsBox
    ? Math.max(0, Math.min(head.y + head.h, rowsBox.y + rowsBox.h) - Math.max(head.y, rowsBox.y))
      * Math.max(0, Math.min(head.x + head.w, rowsBox.x + rowsBox.w) - Math.max(head.x, rowsBox.x))
    : 0
  return {
    present: true,
    hidden: wrap.hidden,
    rows,
    head,
    rowsBox,
    overlap,
    cardBottom: rowsBox ? rowsBox.y + rowsBox.h : 0,
    viewH: window.innerHeight,
    viewW: window.innerWidth,
    you: document.querySelector('.sg-pod__you')?.textContent ?? '',
    tied: !document.querySelector('.sg-pod__tied')?.hidden,
    skipDisabled: skip ? skip.disabled : null,
    // Everything else in the HUD must be off. A minimap of a torn-down track
    // is the failure this checks for.
    otherVisible: [...document.querySelectorAll('.sg-hud > *')]
      .filter((c) => !c.classList.contains('sg-pod'))
      .filter((c) => getComputedStyle(c).display !== 'none').length,
  }
})

/**
 * The renderer's OWN counters for the SCENE pass, plus the stage's inventory.
 *
 * `renderer.info.render` is reset on every render() call, and with the post
 * chain on, the LAST call of a frame is the composite's fullscreen blit -- so
 * reading it after a normal frame reports "1 draw call, 1 triangle" for every
 * scene in the game, which is what the first version of this probe printed and
 * what would have gone in a report as a cost figure. Issuing one explicit
 * scene render and reading immediately measures the thing being claimed.
 */
const readCost = () => page.evaluate(() => {
  const g = window.__GAME__
  g.renderer.render(g.scene, g.chase.camera)
  const info = g.renderer.info
  const st = g.podiumStage
  return {
    tier: g.tier,
    calls: info.render.calls,
    tris: info.render.triangles,
    programs: info.programs?.length ?? -1,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    stage: st ? { ...st.stats } : null,
    shot: st ? { i: st.frame.shot, label: st.frame.label, u: +st.frame.u.toFixed(2) } : null,
    cam: st ? {
      x: +g.chase.camera.position.x.toFixed(3),
      y: +g.chase.camera.position.y.toFixed(3),
      z: +g.chase.camera.position.z.toFixed(3),
      fov: +g.chase.camera.fov.toFixed(1),
    } : null,
    // THE SUBJECT, IN SCREEN PIXELS. Projected here rather than in node
    // because this is the only place the live camera matrices exist, and they
    // are the ones the frame was actually drawn with -- fov compensated for
    // the viewport's aspect, aim biased for the card, the lot. Done by hand
    // with the two matrices the camera exposes so the probe does not need a
    // three.js import of its own.
    head: st ? (() => {
      const cam = g.chase.camera
      cam.updateMatrixWorld()
      const h = st.champHead
      const vm = cam.matrixWorldInverse.elements
      const pm = cam.projectionMatrix.elements
      const mul = (m, x, y, z, w) => [
        m[0] * x + m[4] * y + m[8] * z + m[12] * w,
        m[1] * x + m[5] * y + m[9] * z + m[13] * w,
        m[2] * x + m[6] * y + m[10] * z + m[14] * w,
        m[3] * x + m[7] * y + m[11] * z + m[15] * w,
      ]
      const v = mul(vm, h.x, h.y, h.z, 1)
      const c = mul(pm, v[0], v[1], v[2], v[3])
      if (!(c[3] > 1e-6)) return null
      const ndcX = c[0] / c[3]
      const ndcY = c[1] / c[3]
      // The head is a ball on top of a figure, so the box is the head's own
      // width either side of the projected point -- generous on purpose: the
      // gate is about the UI sitting on the subject, not about a single pixel.
      const R = 1.15
      const vr = mul(vm, h.x + R, h.y + R, h.z, 1)
      const cr = mul(pm, vr[0], vr[1], vr[2], vr[3])
      const rx = Math.abs(cr[0] / cr[3] - ndcX)
      const ry = Math.abs(cr[1] / cr[3] - ndcY)
      const W = window.innerWidth, H = window.innerHeight
      const px = (n) => (n + 1) * 0.5 * W
      const py = (n) => (1 - n) * 0.5 * H
      return {
        x: Math.round(px(ndcX - rx)),
        y: Math.round(py(ndcY + ry)),
        w: Math.round(px(ndcX + rx) - px(ndcX - rx)),
        h: Math.round(py(ndcY - ry) - py(ndcY + ry)),
        world: [+h.x.toFixed(2), +h.y.toFixed(2), +h.z.toFixed(2)],
      }
    })() : null,
  }
})

/** Overlap of two {x,y,w,h} boxes, in square pixels. */
const hit = (a, b) => (a && b)
  ? Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  : 0

/** Mean frame time over `n` real frames, measured inside the page. */
const frameCost = (n) => page.evaluate((count) => new Promise((resolve) => {
  const ts = []
  let last = performance.now()
  let seen = 0
  const tick = () => {
    const now = performance.now()
    ts.push(now - last)
    last = now
    if (++seen < count) requestAnimationFrame(tick)
    else {
      const sorted = ts.slice(1).sort((a, b) => a - b)
      resolve({
        frames: sorted.length,
        mean: +(sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(1),
        median: +sorted[sorted.length >> 1].toFixed(1),
        p95: +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))].toFixed(1),
      })
    }
  }
  requestAnimationFrame(tick)
}), n)

/** Is the seat empty in every parked car? Walks the live scene graph. */
const readSeats = () => page.evaluate(() => {
  const g = window.__GAME__
  const out = []
  g.scene.traverse((o) => {
    if (o.name && o.name.startsWith('vehicle:')) {
      let pilots = 0
      let visiblePilots = 0
      o.traverse((c) => {
        if (c.name === 'sg_pilot') {
          pilots++
          // Visible only if it AND every ancestor up to the vehicle is visible.
          let v = c.visible
          let p = c.parent
          while (v && p && p !== o.parent) { v = p.visible; p = p.parent }
          if (v) visiblePilots++
        }
      })
      out.push({ chassis: o.name, pilotNodes: pilots, visible: visiblePilots })
    }
  })
  return out
})

/**
 * Pin the podium clock at `t` and wait for a frame that actually shows it.
 *
 * NOT a fixed sleep. `stage.frame` and the renderer's counters are only
 * written inside renderFrame, and this renderer delivers a frame every
 * 0.7-1.6 s -- so a one-second wait after setting the clock sometimes reads
 * the frame drawn BEFORE the write and reports the previous beat. It cost a
 * run of three false failures. Re-pinning on every attempt also stops the
 * clock running away while we wait, which is the other half of the same bug.
 */
const pinBeat = async (t, want, tries = 14) => {
  let c = null
  for (let k = 0; k < tries; k++) {
    await page.evaluate((v) => { window.__GAME__.podT = v }, t)
    await page.waitForTimeout(520)
    c = await readCost()
    if (!want || c.shot?.label === want) return c
  }
  return c
}

const shoot = async (tag) => {
  const name = `${KIND}-${tag}.png`
  await page.screenshot({ path: join(OUT, name) })
  return name
}

/** Wait until the game reaches a phase, on SIM/phase polling not wall clock. */
async function waitPhase(want, capMs = 240000) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < capMs) {
    last = await phase()
    if (last.p === want) return last
    await page.waitForTimeout(350)
  }
  note(`never reached phase "${want}" (stuck at ${last?.p})`)
  return last
}

// ===========================================================================
// PART 1 — a SINGLE race: the round card must not exist on screen
// ===========================================================================
console.log(`\n=== ${KIND} ===`)
console.log('\n--- single race: no round card ---')
await page.evaluate(() => { window.__GAME__.maxSubSteps = 900; window.__GAME__.startRace() })
await page.waitForTimeout(1200)
const singleRound = await readRound()
console.log('  round card hidden   :', singleRound.hidden, JSON.stringify(singleRound.num))
if (!singleRound.hidden) note('the round card is on screen during a single race')
if (singleRound.num) note(`the round card has text in a single race: "${singleRound.num}"`)
await shoot('single-countdown')

// ===========================================================================
// PART 2 — a circuit with seven rounds in the bank, and round 8 driven for real
// ===========================================================================
console.log('\n--- seeding seven rounds, then racing round 8 ---')
await page.evaluate(() => {
  const g = window.__GAME__
  g.frontEnd.show('title')
})
await page.waitForTimeout(500)
// A fresh circuit through the shipping path, so the grid is the real frozen one.
await page.locator('.sg-title__circuit .sg-btn--gold').click()
await page.waitForTimeout(700)

const seeded = await page.evaluate(() => {
  const g = window.__GAME__
  const grid = g.circuit.grid
  const TRACKS = ['rustfall', 'halcyon', 'aetherion', 'cryostatic', 'emberfall', 'abyssal', 'hollowchoir', 'neonspire']
  // Seven rounds. The player (slot 0) takes 2nd every time and entrant 1 wins
  // every time, so going into round 8 the title is still live and the podium
  // has a genuine 1-2-3 that is not simply the grid order.
  const order = [1, 0, 2, 3, 4, 5, 6, 7]
  const rounds = []
  for (let i = 0; i < 7; i++) {
    rounds.push({
      trackId: TRACKS[i],
      finishes: order.map((id, k) => ({
        id, position: k + 1, finished: true, time: 120 + k,
        pilotId: grid[id].pilotId, chassisId: grid[id].chassisId,
      })),
    })
  }
  const save = JSON.parse(localStorage.getItem('sg.circuit'))
  save.rounds = rounds
  localStorage.setItem('sg.circuit', JSON.stringify(save))
  // Re-read it through the shipping loader so nothing here is a special path.
  g.circuit = JSON.parse(JSON.stringify(save)) && (window.__GAME__.circuit = null, null)
  return { grid: grid.map((e) => `${e.pilotId}/${e.chassisId}`) }
})
console.log('  frozen grid         :', seeded.grid.join(', '))

// Reload so loadCircuit() reads the seeded save exactly as it would on a
// returning player's next visit -- no hand-poked in-memory state at all.
await page.reload({ waitUntil: 'load' })
await page.waitForFunction(() => !!window.__GAME__, null, { timeout: 60000 })
await page.waitForTimeout(2200)
await page.evaluate(() => { window.__GAME__.maxSubSteps = 900 })

const cline = await page.locator('.sg-title__cline').textContent()
console.log('  title line          :', JSON.stringify(cline))
if (!/Round 8 of 8/.test(cline || '')) note(`the title does not offer round 8: "${cline}"`)
await page.locator('.sg-title__circuit .sg-btn--gold').click()
await page.waitForTimeout(700)
const garageHead = await page.locator('.sg-screen--garage .sg-head__title').textContent()
console.log('  garage head         :', JSON.stringify(garageHead))
await page.locator('.sg-screen--garage .sg-btn--start').click()
await page.waitForTimeout(1400)
// AFTER Start, not before: the front end's onStart handler applies its own
// remembered quality selection, so a tier set in the garage is overwritten on
// the way into the race.
if (TIER) {
  await page.evaluate((t) => { window.__GAME__.setTier(t) }, TIER)
  await page.waitForTimeout(600)
}

// --- THE ROUND CARD -------------------------------------------------------
const r8 = await readRound()
console.log('  round card          :', JSON.stringify(r8.num), '/', JSON.stringify(r8.name),
  '| hidden', r8.hidden, '| opacity', r8.opacity)
if (r8.hidden) note('the round card is hidden during a circuit countdown')
if (!/ROUND 8 OF 8/.test(r8.num)) note(`the round card reads "${r8.num}"`)
if (!/ZHEN-9/i.test(r8.name)) note(`the round card names "${r8.name}", expected Zhen-9`)
if (r8.opacity < 0.95) note(`the round card is at opacity ${r8.opacity} during the countdown`)
await shoot('round-card')

// The AI drives; a probe cannot steer.
await page.evaluate(() => {
  const g = window.__GAME__
  const st = g.race.state
  st.totalLaps = 1
  const r = st.racers[g.localId]
  if (r) r.isAI = true
})

// --- and it goes away once the race is live -------------------------------
// POLLED LONG ENOUGH TO ACTUALLY GET THERE. SwiftShader delivers well under a
// frame a second here and the game clamps a frame to 0.25 s of simulation, so
// reaching 2.4 s of race time takes tens of wall seconds. The first version of
// this loop gave it twelve and reported "never observed the race running",
// which is a probe measuring nothing and passing.
let liveRound = null
let raceCost = null
let raceFrames = null
for (let i = 0; i < 150; i++) {
  const p = await phase()
  if (p.p !== 'racing') break
  if (p.sp === 'racing' && p.t > 2.4) {
    liveRound = await readRound()
    // A RACING FRAME'S COST, taken here because this is the only moment it
    // exists: by the time the podium is up the world has been torn down and
    // the counters read a single cleared frame.
    raceCost = await readCost()
    raceFrames = await frameCost(30)
    break
  }
  await page.waitForTimeout(400)
}
if (liveRound) {
  console.log('  card 2.4s into race :', 'hidden', liveRound.hidden, '| opacity', liveRound.opacity)
  // FADING, not yet gone. The card runs out over ROUND_FADE seconds of HUD
  // time and the HUD clamps its own dt to 0.1 s a frame, so on a renderer
  // delivering under a frame a second the fade takes twenty wall seconds while
  // 2.4 s of SIM time arrives in fifteen. Asserting "gone by now" here would be
  // asserting a property of SwiftShader. What is checked is that it has STARTED
  // to go; that it finishes is checked after the flag, below, where the only
  // correct answer is hidden.
  if (!liveRound.hidden && liveRound.opacity >= 1) {
    note('the round card has not begun to fade once the race is live')
  }
  console.log('  RACING frame        :', raceCost.calls, 'draw calls,',
    raceCost.tris.toLocaleString(), 'triangles |', JSON.stringify(raceFrames))
} else {
  note('never observed the race running to check the round card faded')
}

// --- to the flag ---------------------------------------------------------
// STEPPED, NOT WAITED OUT. game/main.ts clamps a rendered frame to 0.25 s of
// simulation, so on a software renderer at well under a frame a second one lap
// of Zhen-9 is five wall minutes -- long enough that the first version of this
// probe timed out before the podium existed and reported it missing. Driving
// the sim to the flag directly leaves every path this probe is actually about
// -- the ceremony, finishRace, scoreCircuitRound, beginPodium -- exactly as
// shipped; only the waiting is skipped.
const stepped = await page.evaluate(() => {
  const g = window.__GAME__
  const race = g.race
  if (!race) return -1
  const idle = {
    steer: 0, throttle: 0, brake: 0, drift: false,
    item: false, itemBack: false, lift: false, lookBack: false,
  }
  let n = 0
  while (race.state.phase !== 'finished' && n < 60 * 400) {
    race.setInput(g.localId, idle)
    race.step()
    n++
  }
  return n
})
console.log('  stepped to the flag :', stepped, 'sim steps')

// ===========================================================================
// PART 3 — THE PODIUM
// ===========================================================================
console.log('\n--- the podium ---')
await waitPhase('podium', 200000)
await page.waitForTimeout(600)

// The round card's other half: by the time the flag has fallen it must be gone.
const afterFlagRound = await readRound()
console.log('  round card after flag:', 'hidden', afterFlagRound.hidden)
if (!afterFlagRound.hidden) note('the round card survived the finish')

// PINNED INSIDE THE GUARD. One frame here is most of a second, so "read the
// card right after the phase changed" lands wherever the renderer felt like
// it -- and the guard is 0.7 s. Pinning the clock tests the rule.
await pinBeat(0.2, 'reveal')
const cost0 = await readCost()
console.log('  quality tier        :', cost0.tier)
console.log('  stage               :', JSON.stringify(cost0.stage))
console.log('  PODIUM frame        :', cost0.calls, 'draw calls,',
  cost0.tris.toLocaleString(), 'triangles')
if (!cost0.stage) note('the podium stage is not on the game object')
if (cost0.stage && cost0.stage.cars !== 3) note(`${cost0.stage.cars} cars on the podium`)
if (cost0.stage && cost0.stage.pilots !== 3) note(`${cost0.stage.pilots} pilots on the podium`)
// THE FIGURES STAND ON THE STEPS. A pilot figure is originated at its soles
// (see the contract note in game/podium.ts), so a figure placed at the step's
// top surface touches it. 2 cm of tolerance for a rig whose lowest point is a
// rounded sole; anything more is a hover or a sinking, and the placement no
// longer hides it behind a hand-fitted lift the way PILOT_LIFT did.
if (cost0.stage && Math.abs(cost0.stage.soleGap) > 0.02) {
  note(`the pilot figures are ${cost0.stage.soleGap > 0 ? 'hovering' : 'sunk'} `
    + `${Math.abs(cost0.stage.soleGap).toFixed(2)}m: the figure is not originated at its soles`)
}
if (cost0.stage) {
  console.log('  figure              :',
    `soles ${cost0.stage.soleGap.toFixed(3)}m from the step`,
    `| face at y=${cost0.stage.faceY}`,
    `| head (hop apex) y=${cost0.stage.headY}`)
}
if (raceCost && cost0.calls > raceCost.calls) {
  note(`the podium costs MORE draw calls than a racing frame (${cost0.calls} vs ${raceCost.calls})`)
}
if (raceCost && cost0.tris > raceCost.tris) {
  note(`the podium costs MORE triangles than a racing frame (${cost0.tris} vs ${raceCost.tris})`)
}

const seats = await readSeats()
console.log('  parked cars         :', JSON.stringify(seats))
if (seats.length !== 3) note(`${seats.length} vehicles in the podium scene, expected 3`)
for (const s of seats) {
  if (s.visible !== 0) note(`${s.chassis} still has a pilot in the seat`)
}

const card = await readPodCard()
console.log('  card rows           :')
for (const r of card.rows) {
  console.log(`    ${r.place.padStart(4)}  ${r.pilot.padEnd(9)} ${r.chassis.padEnd(15)} `
    + `${r.pts.padStart(8)}  ${r.you ? 'YOU' : ''}   rail ${r.rail}`)
}
console.log('  your line           :', JSON.stringify(card.you))
console.log('  tied banner         :', card.tied)
console.log('  other HUD visible   :', card.otherVisible)
console.log('  card boxes          : head', JSON.stringify(card.head),
  '| rows', JSON.stringify(card.rowsBox), '| overlap', card.overlap, 'px2')
if (card.overlap > 0) note(`the standings rows overlap the title by ${card.overlap}px2`)
// HOW FAR DOWN only matters while the card is a BAND across the top. On a
// viewport wide enough for the rail it is a column, and a column is allowed to
// be tall -- what it may not do is reach across the frame, which is the check
// below and, per beat, the champion gate further down.
const RAILED = card.rowsBox && card.rowsBox.x + card.rowsBox.w < card.viewW * 0.45
console.log('  card layout         :', RAILED ? 'rail (left column)' : 'stacked (top band)')
if (!RAILED && card.cardBottom > card.viewH * 0.42) {
  note(`the card reaches ${Math.round(100 * card.cardBottom / card.viewH)}% down the frame`)
}
if (RAILED && card.cardBottom > card.viewH * 0.78) {
  note(`the card rail reaches ${Math.round(100 * card.cardBottom / card.viewH)}% down the frame`)
}
if (card.hidden) note('the podium card is hidden during the podium')
if (card.rows.length !== 3) note(`${card.rows.length} rows on the podium card`)
if (card.otherVisible !== 0) note(`${card.otherVisible} other HUD blocks are on screen over the podium`)
if (!card.you) note('the podium card does not say where the player finished')
// THE SKIP GUARD, TESTED AS A RULE RATHER THAN AS A RACE. One frame here is
// most of a second and the guard is 0.7 s, so "look at the button shortly
// after the podium opened" measures the renderer, not the rule. This drives
// the shipping per-frame step with dt = 0 at two pinned clock values.
const guard = await page.evaluate(() => {
  const g = window.__GAME__
  const btn = document.querySelector('.sg-pod__skip')
  g.podT = 0.1
  g.stepPodium(0)
  const early = btn.disabled
  g.podT = 1.2
  g.stepPodium(0)
  const late = btn.disabled
  return { early, late }
})
console.log('  skip guard          : at 0.1s disabled =', guard.early,
  '| at 1.2s disabled =', guard.late)
if (guard.early !== true) note('the skip is live inside the guard')
if (guard.late !== false) note('the skip never arms after the guard')

// --- the beats, photographed ---------------------------------------------
// Sampled on the podium's own clock, not the wall clock: SwiftShader delivers
// one to five frames a second and a waitForTimeout would land anywhere.
// WHERE EACH BEAT IS SAMPLED IS PART OF THE TEST. Each of these is the moment
// that beat is MAKING ITS POINT, not an arbitrary point inside it: the reveal
// once the crane has cleared the cars, the champion mid-arc, the cars beat a
// third of the way in where all three chassis still sit under all three
// numbers, the wide once it has opened the sky, the hold at its closest.
const BEATS = [
  ['reveal', 2.4], ['champion', 4.8], ['cars', 7.7], ['wide', 11.6], ['hold', 15.6],
]
const seen = []
for (const [want, at] of BEATS) {
  const c = await pinBeat(at, want)
  const nm = await shoot(`beat-${c.shot?.label ?? want}`)
  seen.push({ want, got: c.shot?.label, u: c.shot?.u, cam: c.cam, calls: c.calls, tris: c.tris, shot: nm, head: c.head })
  console.log(`  t=${String(at).padStart(5)}s  beat ${String(c.shot?.label).padEnd(9)} u=${c.shot?.u}`
    + `  cam(${c.cam?.x}, ${c.cam?.y}, ${c.cam?.z}) fov ${c.cam?.fov}`
    + `  ${String(c.calls).padStart(3)} calls ${String(c.tris).padStart(7)} tris  -> ${nm}`)
  if (c.shot?.label !== want) note(`at t=${at}s the camera is on "${c.shot?.label}", expected "${want}"`)
}

// --- THE CARD IS NOT PARKED ON THE WINNER -------------------------------
//
// The gate the shipped podium did not have. `card.overlap` measures the card
// against ITSELF, which catches a layout inversion and nothing else; what
// actually went wrong was the panel landing on the champion's head, and no
// amount of card-versus-card arithmetic can see that. So: project the winner's
// head through the live camera (PodiumStage.champHead, which is measured off
// the built figure and includes the apex of its hop) and intersect that box
// with the card's own.
//
// MEASURED AT THE HEAD, NOT AT THE FIGURE. A standings panel across a pair of
// boots is a composition note; across a face it is the bug.
console.log('  card vs champion    :')
for (const b of seen) {
  const rows = card.rowsBox
  const head = b.head
  if (!head) { note(`no champion projection on beat "${b.got}"`); continue }
  const onRows = hit(head, rows)
  const onHead = hit(head, card.head)
  const area = Math.max(1, head.w * head.h)
  const pct = Math.round((100 * (onRows + onHead)) / area)
  console.log(`    ${String(b.got).padEnd(9)} head ${JSON.stringify(head)}`
    + `  rows ${onRows}px2  title ${onHead}px2  = ${pct}% of the head`)
  // A little of the TITLE over the subject is survivable -- it is spaced
  // display type with no panel behind it -- but the rows are an opaque block
  // and any of that on a face is the shipped bug coming back.
  if (onRows > 0) {
    note(`the standings rows sit on the champion's head on beat "${b.got}" (${onRows}px2)`)
  }
  if (pct > 25) {
    note(`the card covers ${pct}% of the champion's head on beat "${b.got}"`)
  }
  // ...and the winner has to be IN the picture at all on the two beats that
  // are about them. A head projected off-screen is a framing regression that
  // the overlap check would otherwise report as a clean pass.
  if (b.got === 'champion' || b.got === 'hold') {
    const inFrame = head.x + head.w > 0 && head.x < card.viewW
      && head.y + head.h > 0 && head.y < card.viewH
    if (!inFrame) note(`the champion is outside the frame on beat "${b.got}"`)
  }
}

// Camera positions must differ between beats -- that is what makes them angles.
for (let i = 1; i < seen.length; i++) {
  const a = seen[i - 1].cam, b = seen[i].cam
  if (!a || !b) continue
  const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
  if (d < 2) note(`beats "${seen[i - 1].got}" and "${seen[i].got}" are ${d.toFixed(2)}m apart`)
}

// BACK TO THE START OF THE SHOT LIST BEFORE ANYTHING SLOW.
// `podT` keeps advancing on every frame, so a 40-frame measurement taken from
// the last beat walks the clock past PODIUM_DURATION and the phase auto-
// advances underneath the probe -- which is how the first run of this file
// ended up clicking a skip button that had already been taken off screen.
await pinBeat(1.5, 'reveal')
const podFrames = await frameCost(40)
console.log('  PODIUM frame times  :', JSON.stringify(podFrames))
console.log('  RACING frame times  :', JSON.stringify(raceFrames))
const stillUp = await phase()
if (stillUp.p !== 'podium') note(`the podium ended early: now in "${stillUp.p}"`)

// --- reduced motion: no movement inside a beat ---------------------------
if (REDUCED) {
  const a = (await pinBeat(1.0, 'reveal')).cam
  const b = (await pinBeat(3.1, 'reveal')).cam
  const moved = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
  console.log(`  calm: camera moved ${moved.toFixed(4)}m inside beat 1`)
  if (moved > 0.01) note(`reduced motion still flies the camera ${moved.toFixed(3)}m inside one beat`)
  // ...and the cut between beats survives.
  const c = (await pinBeat(4.2, 'champion')).cam
  const cut = Math.hypot(c.x - b.x, c.y - b.y, c.z - b.z)
  console.log(`  calm: cut to beat 2 is ${cut.toFixed(2)}m`)
  if (cut < 3) note('reduced motion lost the cut between beats')
}

// --- it ends on its own -------------------------------------------------
// A celebration a hands-off player never leaves is as bad as one they cannot.
{
  const left = await page.evaluate(() => {
    const g = window.__GAME__
    g.podT = 99
    g.stepPodium(0)
    return g.phase
  })
  console.log('  auto-advance        : phase after the shot list runs out =', left)
  if (left !== 'results') note(`the podium did not end itself (phase "${left}")`)
  // ...and then back onto it for the skip test below.
  await page.evaluate(() => { window.__GAME__.beginPodium() })
  await page.waitForTimeout(900)
  const back = await phase()
  if (back.p !== 'podium') note(`could not re-enter the podium for the skip test ("${back.p}")`)
}

// --- the skip ------------------------------------------------------------
await pinBeat(2.0, 'reveal')
const armed = await readPodCard()
console.log('  skip after the guard:', armed.skipDisabled === false ? 'live' : 'still disabled')
if (armed.skipDisabled !== false) note('the skip never arms')
await page.locator('.sg-pod__skip').click()
await page.waitForTimeout(1400)
const after = await phase()
console.log('  after pressing skip :', after.p)
if (after.p !== 'results') note(`pressing the skip left the game in "${after.p}"`)
const gone = await page.evaluate(() => ({
  stage: !!window.__GAME__.podiumStage,
  card: document.querySelector('.sg-pod')?.hidden,
  hud: getComputedStyle(document.querySelector('.sg-hud')).display,
}))
console.log('  torn down           :', JSON.stringify(gone))
if (gone.stage) note('the podium stage survived the skip')
if (gone.card !== true) note('the podium card is still up on the results screen')
await shoot('after-skip-results')

// ---------------------------------------------------------------------------
console.log('')
if (errors.length) {
  console.log(`PODIUM PROBE: ${errors.length} problem(s)`)
  for (const e of errors) console.log('  - ' + e)
} else {
  console.log('PODIUM PROBE: clean')
}
await browser.close()
server.close()
process.exit(errors.length ? 1 : 0)
