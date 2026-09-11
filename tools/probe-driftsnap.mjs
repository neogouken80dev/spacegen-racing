/**
 * PHOTOGRAPH THE DRIFT SNAP, IN A REAL BROWSER — AND PROVE IT IS NOT A BOOST.
 *
 * The sibling of tools/probe-sparkshots.mjs, and it exists for the same reason:
 * "it should work" is not a result, and the specific claim being made here is a
 * claim about what a player can tell apart AT A GLANCE. That is falsifiable
 * only by putting the three events side by side in the same framing, at the
 * same speed, on the same corner, and looking at them.
 *
 *   entry-a   drift ENTRY, 45 ms in: the first crack.
 *   entry-b   the same entry 115 ms in: the second beat.
 *   entry-c   the same entry 320 ms in: back to sustain. If this looks like
 *             entry-a then the accent is not an accent, it is a level change.
 *   tier1     the tier-0 -> 1 landing.
 *   tier3     the tier-2 -> 3 landing, the loudest transition in the game.
 *   hold      a tier-2 slide with NO transition anywhere near it: the sustain
 *             the accents have to stand out from.
 *   boost     the release. THE CONTROL. The whole brief is that this and the
 *             rows above must not read as the same event.
 *
 * NOTHING HERE FAKES A DRIFT. The rail pins the car's POSITION, heading and
 * velocity onto the racing line -- so the camera settles and every row is
 * photographed on the same stretch of road rather than wherever the car
 * happened to slide to -- and then holds the drift button down. driftSide,
 * driftCharge, driftTier, the tier events and the release boost are all the
 * sim's own, produced by its own drift code from a real stick input.
 *
 * THE SHUTTER stops VFX time, not the game, exactly as the spark probe does:
 * Chromium under SwiftShader delivers one to five frames a second here and a
 * drift crack is 200 ms long, so waiting on wall-clock time photographs the
 * aftermath every time. Wait on SIM time; freeze the particles; keep drawing.
 *
 *   node tools/probe-driftsnap.mjs [--track=rustfall] [--rm]
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { extname, join } from 'node:path'

/** Identical to tools/smoke.mjs and tools/probe-sparkshots.mjs, deliberately:
 *  these numbers are only worth anything next to the ones already recorded. */
function analyse(path) {
  const out = execFileSync('python3', ['-c', `
import sys
import numpy as np
from PIL import Image
a = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(np.int16)
H, W, _ = a.shape
mn = a.min(axis=2)
lum = 0.299*a[:,:,0] + 0.587*a[:,:,1] + 0.114*a[:,:,2]
def pc(m): return round(float(np.mean(m))*100.0, 3)
def grad(L):
    return round(float((np.abs(np.diff(L,axis=0)).mean()+np.abs(np.diff(L,axis=1)).mean())*0.5), 2)
x0,x1,y0,y1 = int(W*0.25), int(W*0.75), int(H*0.55), H
print(pc(mn>=250), pc(mn[y0:y1,x0:x1]>=250), grad(lum[y0:y1,x0:x1]), round(float(lum.mean()),1))
`, path]).toString().trim().split(' ')
  return { blownPct: +out[0], roadBlownPct: +out[1], roadGradient: +out[2], meanLum: +out[3] }
}

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const trackId = arg('track', 'rustfall')
const RM = process.argv.includes('--rm')
const OUT = join('shots', 'drift')
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }
const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  const path = join('dist', url === '/' ? 'index.html' : url.slice(1))
  if (!existsSync(path)) { res.writeHead(404); res.end('nope'); return }
  res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' })
  res.end(readFileSync(path))
})
await new Promise((r) => server.listen(4181, r))

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const ctx = await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1 })
const page = await ctx.newPage()
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(String(e)))

await page.goto('http://localhost:4181/', { waitUntil: 'networkidle' })
await page.evaluate(() => { if (window.__GAME__) window.__GAME__.maxSubSteps = 400 })

const clickText = async (labels) => {
  for (const t of labels) {
    const el = page.locator('button, .sg-btn').filter({ hasText: t }).first()
    if (await el.count() && await el.isVisible().catch(() => false)) { await el.click(); return }
  }
}
await clickText(['PLAY NOW', 'PLAY', 'Play'])
await page.waitForSelector('.sg-screen--track .sg-card--track', { state: 'visible', timeout: 20000 })
const NAME = { rustfall: 'Rustfall', cryostatic: 'Cryostatic', aetherion: 'Aetherion Prime', hollowchoir: 'The Hollow Choir' }[trackId] ?? trackId
await page.locator('.sg-screen--track .sg-card--track').filter({ hasText: NAME }).first().click()
await page.waitForTimeout(1400)
await page.locator('.sg-screen--track .sg-btn--start').click()
await page.waitForSelector('.sg-screen--garage .sg-btn--start', { state: 'visible', timeout: 20000 })
await page.locator('.sg-screen--garage .sg-btn--start').click()
await page.waitForTimeout(4000)
await page.evaluate(() => {
  const g = window.__GAME__
  if (g && g.race) { g.race.state.countdown = 0; g.race.state.phase = 'racing' }
})
// PIN THE TIER. Under SwiftShader the adaptive scaler drops to `low` in
// seconds, which builds no composer -- and a drift accent measured with no
// bloom in the frame is a measurement of nothing.
await page.evaluate((rm) => {
  const g = window.__GAME__
  g.setTier('high')
  g.qualityCooldown = 1e9
  g.frameTimes.length = 0
  g.reduceMotion = rm
}, RM)
await page.waitForTimeout(2500)

/** Wait on SIM time. Chromium here runs at 1-5 fps; wall clock means nothing. */
async function waitSim(seconds, capMs = 90000) {
  const now = () => page.evaluate(() => window.__GAME__?.race?.state?.time ?? 0)
  const start = await now()
  const t0 = Date.now()
  while (Date.now() - t0 < capMs) {
    if ((await now()) - start >= seconds) return
    await page.waitForTimeout(120)
  }
}

/**
 * What is alive at the shutter, split the way the DRIFT SNAP has to be judged.
 *
 * `blades` are the accent's own particles and they are identified structurally,
 * not by guessing: a K_SPARK (kind 1) whose life is under 0.24 s is a blade,
 * because nothing else the drift emits is that short -- the scrape stream runs
 * 0.28-0.58 s, the tier ejection 0.36-0.56, the boost plume 0.36-0.68. If this
 * number is zero on an `entry` row then the accent did not fire and the picture
 * is of something else.
 */
async function poolStats() {
  return page.evaluate(() => {
    const v = window.__GAME__.vfx
    if (!v || !v.aMisc) return null
    const t = v.time
    let live = 0, pending = 0, sparks = 0, blades = 0, beads = 0, rings = 0
    let onScreen = 0, bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9
    const cam = window.__GAME__.chase.camera
    cam.updateMatrixWorld()
    const PV = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse)
    for (let i = 0; i < v.pool; i++) {
      const i4 = i * 4
      const life = v.aMisc[i4 + 1]
      if (life <= 0) continue
      const age = t - v.aMisc[i4]
      if (age < 0) { pending++; continue }
      if (age >= life) continue
      live++
      const kind = Math.round(v.aMisc2[i4 + 2])
      if (kind === 1) {
        sparks++
        if (life < 0.24) {
          blades++
          // WHERE ON THE SCREEN, which is the question a pool count cannot
          // answer. "70 blades alive" and "70 blades behind the camera" are
          // the same row otherwise, and this probe spent a long afternoon
          // unable to tell them apart.
          const k = v.aMisc2[i4 + 1]
          const age2 = Math.max(0, age)
          const integ = k > 0.001 ? (1 - Math.exp(-k * age2)) / k : age2
          const gg = 0.5 * v.aMisc2[i4] * age2 * age2
          const i3 = i * 3
          const px = v.aPos[i3] + v.aVel[i3] * integ + v.aAxis[i3] * gg
          const py = v.aPos[i3 + 1] + v.aVel[i3 + 1] * integ + v.aAxis[i3 + 1] * gg
          const pz = v.aPos[i3 + 2] + v.aVel[i3 + 2] * integ + v.aAxis[i3 + 2] * gg
          const e2 = PV.elements
          const w = e2[3] * px + e2[7] * py + e2[11] * pz + e2[15]
          if (w > 0) {
            const nx = (e2[0] * px + e2[4] * py + e2[8] * pz + e2[12]) / w
            const ny = (e2[1] * px + e2[5] * py + e2[9] * pz + e2[13]) / w
            const sx = (nx * 0.5 + 0.5) * 1440
            const sy = (1 - (ny * 0.5 + 0.5)) * 810
            if (sx >= 0 && sx < 1440 && sy >= 0 && sy < 810) {
              onScreen++
              bx0 = Math.min(bx0, sx); bx1 = Math.max(bx1, sx)
              by0 = Math.min(by0, sy); by1 = Math.max(by1, sy)
            }
          }
        }
      }
      else if (kind === 7) beads++
      else if (kind === 2 || kind === 3 || kind === 4) rings++
    }
    const st = window.__GAME__.race.state
    const r0 = st.racers.find((r) => r.isLocal) ?? st.racers[0]
    return {
      live, pending, sparks, blades, beads, rings,
      bladesOnScreen: onScreen,
      bladeBox: onScreen ? [Math.round(bx0), Math.round(by0), Math.round(bx1), Math.round(by1)] : null,
      carPix: (() => {
        const st2 = window.__GAME__.race.state
        const rr = st2.racers.find((x) => x.isLocal) ?? st2.racers[0]
        const e2 = PV.elements
        const w = e2[3] * rr.pos.x + e2[7] * rr.pos.y + e2[11] * rr.pos.z + e2[15]
        if (!(w > 0)) return null
        const nx = (e2[0] * rr.pos.x + e2[4] * rr.pos.y + e2[8] * rr.pos.z + e2[12]) / w
        const ny = (e2[1] * rr.pos.x + e2[5] * rr.pos.y + e2[9] * rr.pos.z + e2[13]) / w
        return [Math.round((nx * 0.5 + 0.5) * 1440), Math.round((1 - (ny * 0.5 + 0.5)) * 810)]
      })(),
      snaps: window.__SNAPLOG__ ? window.__SNAPLOG__.calls : -1,
      snapSpawned: window.__SNAPLOG__ ? window.__SNAPLOG__.spawned : -1,
      snapLast: window.__SNAPLOG__ ? window.__SNAPLOG__.last : null,
      side: r0.driftSide, tier: r0.driftTier,
      charge: +r0.driftCharge.toFixed(2),
      boost: +r0.boostTime.toFixed(2),
      speed: +Math.hypot(r0.vel.x, r0.vel.y, r0.vel.z).toFixed(1),
      reduced: v.reduced, deferred: v.defOn.reduce((a, b) => a + b, 0),
    }
  })
}

const report = []
async function shoot(tag) {
  const st = await poolStats()
  const name = `${trackId}${RM ? '-rm' : ''}-${tag}.png`
  const path = join(OUT, name)
  await page.screenshot({ path })
  const px = analyse(path)
  report.push({ tag, ...st, ...px, shot: name })
  console.log(`${tag.padEnd(9)} ${JSON.stringify(st)}\n          ${JSON.stringify(px)}  -> ${name}`)
}

/**
 * THE RAIL, and the SHUTTER, installed together.
 *
 * The rail is the one tools/smoke.mjs uses for its drift ladder, with the one
 * change that matters: it does NOT pin driftSide / driftTier / driftCharge.
 * smoke.mjs pins those because it wants to photograph a HELD state; this probe
 * wants the TRANSITIONS, and a transition the probe wrote itself is not
 * evidence of anything. So the drift state here is whatever the sim's own
 * drift code makes of a held button and a held stick.
 */
await page.evaluate(() => {
  const g = window.__GAME__
  const race = g.race
  const track = g.track
  const st = race.state
  const DT = 1 / 60
  const r = st.racers.find((x) => x.isLocal) ?? st.racers[0]

  // A long, wide, un-boosted stretch: a boost strip is the brightest road in
  // the game and photographing an accent against one measures the strip.
  let s0 = 200
  {
    let best = -1, bestK = 1e9
    for (let i = 60; i < track.samples.length - 60; i++) {
      const smp = track.samples[i]
      if (smp.boost || smp.open || smp.width < 10) continue
      const s = (i / track.samples.length) * track.length
      const k = Math.abs(track.curvatureAt(s, 40))
      if (k < bestK) { bestK = k; best = s }
    }
    if (best >= 0) s0 = best
  }

  const P = { on: false, s0, steer: 0, drift: false }
  window.__RAIL__ = P
  window.__SHUT__ = { armed: null, since: -1, at: 0.05, prevTier: -1, fired: '', primed: false }

  const orig = race.step.bind(race)
  race.step = function () {
    if (P.on) {
      race.setInput(r.id ?? 0, {
        steer: P.steer, throttle: 1, brake: 0, drift: P.drift,
        item: false, itemBack: false, lift: false, lookBack: false,
      })
    }
    orig()
    if (!P.on) return
    // THE CAR IS NOT PINNED. An earlier version of this rail teleported it
    // onto the spline every step to keep every row on the same metre of road,
    // and it cost more than it bought: the chase camera never settled, the
    // interpolated render pose lagged a step behind the pinned one, and the
    // accent was photographed from wherever the camera happened to be. The
    // sim's own drift physics puts the car somewhere slightly different on
    // every row, which is a smaller price than photographing the wrong thing.
    // Only the FIELD is moved, because an AI plume in shot changes the frame.
    r.lap = 0; r.finished = false
    st.phase = 'racing'
    const back = track.posAt((r.splineS - 420 + track.length) % track.length)
    for (const a of st.racers) {
      if (a === r) continue
      a.pos.x = back.x; a.pos.y = back.y - 900; a.pos.z = back.z
      a.vel.x = 0; a.vel.y = 0; a.vel.z = 0
      a.driftSide = 0; a.driftTier = -1
      a.boostTime = 0; a.lap = 0; a.finished = false
      a.events.length = 0
    }

    // ---- the shutter ------------------------------------------------------
    const S = window.__SHUT__
    if (S.armed === null || S.since >= 0) { S.prevTier = r.driftTier; return }
    let hit = false
    for (const e of r.events) {
      if (S.armed === 'entry' && e.t === 'driftStart') hit = true
      if (S.armed === 'boost' && e.t === 'boost') hit = true
    }
    if (S.armed === 'tier1' && r.driftTier === 1 && S.prevTier === 0) hit = true
    if (S.armed === 'tier3' && r.driftTier === 3 && S.prevTier === 2) hit = true
    S.prevTier = r.driftTier
    if (hit) { S.since = 0; S.primed = false; S.fired = S.armed; g.maxSubSteps = 0 }
  }

  // The VFX clock, wrapped. Passing dt = 0 freezes every particle exactly
  // where it is while the renderer keeps drawing -- the only way to photograph
  // a 200 ms accent on a renderer delivering between one and five frames a
  // second. Nothing is faked: the sim ran and pushed its own events.
  //
  // AND IT IS CLAMPED, WHICH THE FIRST VERSION WAS NOT. Accumulating the real
  // frame dt and comparing it against `at` gives a shutter whose PRECISION is
  // one frame -- 250 ms here -- so a request to freeze 45 ms into a 130 ms
  // accent froze 250 ms after it, with every blade already dead. The pool
  // counter said `blades: 0` on the row whose whole purpose was to photograph
  // blades. Passing the REMAINDER through instead makes the VFX clock advance
  // by exactly `at` and then stop, whatever the frame rate.
  // THE ACCENT, INSTRUMENTED. `blades: 0` on a row whose whole purpose is to
  // photograph blades has two possible causes -- the accent did not fire, or
  // the counter cannot see it -- and they need telling apart before anything
  // is tuned. This counts the calls and records the last one's arguments, so
  // "it fired with tier 0 at beat 1 and there are still no blades" and "it
  // never fired" are different lines in the log instead of the same one.
  const v = g.vfx
  window.__SNAPLOG__ = { calls: 0, last: null, spawned: 0 }
  const snapOrig = v.driftSnap
  v.driftSnap = function (fx, tier, entry, beat) {
    const L = window.__SNAPLOG__
    L.calls++
    const before = this.spawnCount
    const out = snapOrig.call(this, fx, tier, entry, beat)
    L.spawned += this.spawnCount - before
    L.last = { tier, entry, beat, q: this.qScale, spawned: this.spawnCount - before }
    return out
  }
  const vOrig = v.update.bind(v)
  v.update = function (dt, s, cam, id) {
    const S = window.__SHUT__
    if (S.since >= 0) {
      if (!S.primed) { S.primed = true; return vOrig(1 / 60, s, cam, id) }
      const rem = S.at - S.since
      if (rem <= 0) return vOrig(0, s, cam, id)
      const step = Math.min(dt, rem)
      S.since += step
      return vOrig(step, s, cam, id)
    }
    return vOrig(dt, s, cam, id)
  }
})

/**
 * THE SETTLE, and it is not optional.
 *
 * Turning the rail on TELEPORTS the car onto the racing line, and the chase
 * camera is a real chase camera: it takes a second or two to swing in behind a
 * car that has moved. Arming on the very next sim step -- which is what the
 * first version of this probe did -- photographs the entry crack from wherever
 * the camera happened to be mid-swing, and the first `entry-a` off this rig
 * was the car three quarters out of frame with the accent behind it. The
 * accent was fine. The photograph was worthless, which is the failure mode
 * this whole file exists to avoid.
 *
 * It also runs long enough for the previous row's release BOOST to expire
 * (tier 3 pays ~3.8 s), so a "drift" row is never really a picture of a boost.
 */
async function settle() {
  await page.evaluate(() => {
    const g = window.__GAME__
    g.maxSubSteps = 400
    const P = window.__RAIL__
    P.on = true; P.drift = false; P.steer = 0
    const S = window.__SHUT__
    S.armed = null; S.since = -1; S.primed = false; S.prevTier = -1
    if (window.__SNAPLOG__) { window.__SNAPLOG__.calls = 0; window.__SNAPLOG__.spawned = 0; window.__SNAPLOG__.last = null }
    const r = g.race.state.racers.find((x) => x.isLocal) ?? g.race.state.racers[0]
    r.boostTime = 0; r.boostMag = 0; r.boostSource = 'none'
  })
  await waitSim(2.6)
}

/** Arm on an event, run the sim until it lands, then hold `at` seconds. */
async function catchEvent(what, at) {
  await page.evaluate(([w, a]) => {
    const S = window.__SHUT__
    const P = window.__RAIL__
    P.drift = true; P.steer = 0.85
    S.armed = w; S.since = -1; S.primed = false; S.at = a; S.fired = ''
    S.prevTier = -1
  }, [what, at])
  for (let i = 0; i < 260; i++) {
    const done = await page.evaluate(() => window.__SHUT__.since >= window.__SHUT__.at)
    if (done) return true
    await page.waitForTimeout(200)
  }
  return false
}

/** Mean absolute difference, and the share of the frame that moved at all. */
function diff(a, b, out) {
  const r = execFileSync('python3', ['-c', `
import sys
import numpy as np
from PIL import Image
A = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(np.int16)
B = np.asarray(Image.open(sys.argv[2]).convert('RGB')).astype(np.int16)
D = np.abs(A - B)
m = D.max(axis=2)
Image.fromarray(np.clip(D * 4, 0, 255).astype(np.uint8)).save(sys.argv[3])
print(round(float(m.mean()), 3), round(float(np.mean(m > 8)) * 100.0, 3), int(m.max()))
`, a, b, out]).toString().trim().split(' ')
  return { meanDelta: +r[0], movedPct: +r[1], peakDelta: +r[2] }
}

/** Advance the frozen clock of a burst already caught: the SAME event, later. */
async function hold(at) {
  await page.evaluate((v) => { window.__SHUT__.at = v }, at)
  for (let i = 0; i < 120; i++) {
    const done = await page.evaluate(() => window.__SHUT__.since >= window.__SHUT__.at)
    if (done) return
    await page.waitForTimeout(200)
  }
}

const PN = (n) => join(OUT, `${trackId}${RM ? '-rm' : ''}-${n}.png`)
const ab = []

/**
 * THE ISOLATION, and it is a better one than stubbing the accent out.
 *
 * With the sim frozen, `hold()` advances ONLY the VFX clock -- same car, same
 * camera, same road, same sustained channels, one burst, two moments. So the
 * difference between the 45 ms frame and the 350 ms frame is exactly the
 * transient, and nothing else can have moved. Stubbing driftSnap out and
 * re-running instead compares two frames taken at two different places on the
 * track, which measures the corner as much as the accent.
 */
async function shootBurst(what, tag, early, late) {
  await settle()
  const ok = await catchEvent(what, early)
  console.log(`${tag} caught: ${ok}`)
  await shoot(`${tag}-a`)
  await hold(late)
  await shoot(`${tag}-c`)
  ab.push({ row: tag, ...diff(PN(`${tag}-a`), PN(`${tag}-c`), PN(`${tag}-delta`)) })
}

// ---------------------------------------------------------------------------
// 1. ENTRY: the crack, the echo, and what is left once it has gone.
// ---------------------------------------------------------------------------
await settle()
let ok = await catchEvent('entry', 0.045)
console.log(`entry caught: ${ok}`)
await shoot('entry-a')
await hold(0.115)
await shoot('entry-b')
await hold(0.350)
await shoot('entry-c')
ab.push({ row: 'entry', ...diff(PN('entry-a'), PN('entry-c'), PN('entry-delta')) })

// ---------------------------------------------------------------------------
// 2. THE TIER LANDINGS. Same slide, held: the sim walks its own ladder.
// ---------------------------------------------------------------------------
await shootBurst('tier1', 'tier1', 0.05, 0.40)
await shootBurst('tier3', 'tier3', 0.05, 0.40)

// ---------------------------------------------------------------------------
// 3. THE SUSTAIN. A held slide with no transition inside half a second of it.
//    2.1 s of held drift lands between the tier-1 and tier-2 boundaries
//    (tierTimes 0.65 / 1.50 / 2.60), so the nearest transition is 0.6 s away.
//    If this and `entry-a` look the same, the accent is not an accent.
// ---------------------------------------------------------------------------
await settle()
await page.evaluate(() => {
  const R = window.__RAIL__
  R.drift = true; R.steer = 0.85
  window.__SHUT__.armed = null
})
await waitSim(2.1)
await page.evaluate(() => { window.__GAME__.maxSubSteps = 0 })
await page.waitForTimeout(1500)
await shoot('hold')
await page.evaluate(() => { window.__GAME__.maxSubSteps = 400 })

// ---------------------------------------------------------------------------
// 4. THE CONTROL: a drift RELEASE, which is a boost. The claim under test is
//    that rows 1-2 and this row are not the same picture.
// ---------------------------------------------------------------------------
await settle()
await page.evaluate(() => {
  const R = window.__RAIL__
  R.drift = true; R.steer = 0.85
})
await waitSim(3.2)
await page.evaluate(() => {
  const S = window.__SHUT__
  S.armed = 'boost'; S.since = -1; S.primed = false; S.at = 0.06
  window.__RAIL__.drift = false
})
for (let i = 0; i < 200; i++) {
  const done = await page.evaluate(() => window.__SHUT__.since >= window.__SHUT__.at)
  if (done) break
  await page.waitForTimeout(200)
}
await shoot('boost-a')
await hold(0.40)
await shoot('boost-c')
ab.push({ row: 'boost', ...diff(PN('boost-a'), PN('boost-c'), PN('boost-delta')) })

for (const row of ab) console.log(`transient ${row.row.padEnd(8)} ${JSON.stringify(row)}`)

writeFileSync(join(OUT, `${trackId}${RM ? '-rm' : ''}-report.json`), JSON.stringify({ report, ab }, null, 2))
console.log(`console errors: ${errors.length}`)
if (errors.length) console.log(errors.slice(0, 6).join('\n'))
await browser.close()
server.close()
process.exit(0)
