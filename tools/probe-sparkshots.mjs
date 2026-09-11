/**
 * PHOTOGRAPH THE IMPACT SPARKS, IN A REAL BROWSER.
 *
 * "It should work" is not a result here. This drives the shipping build in
 * Chromium and puts the car into three states the sparks are supposed to
 * answer to, photographing each one and, at the shutter, counting what is
 * actually alive in the particle pool -- because a screenshot with no sparks
 * in it and a screenshot of an effect that is merely off-camera look the same.
 *
 *   graze  -- a scripted player holding full throttle on a line biased hard
 *             into the outside barrier, which is the sustained low-force case
 *             ("rubbing produces a trickle"). The steering is the same
 *             controller tools/probe-wallgraze.ts uses.
 *   slam   -- the car pointed 40 degrees into the barrier at 60 m/s: the
 *             high-force case, and the one the no-threshold curve has to turn
 *             into a burst rather than a scaled-up trickle.
 *   pack   -- eight cars packed into two lanes so the car-to-car `bump` path
 *             fires for real, which is the perf case that was flagged.
 *   linger -- the frame AFTER a slam, with the sim frozen: what is left on the
 *             road once the impact itself is over.
 *
 *   node tools/probe-sparkshots.mjs [--track=rustfall] [--rm]
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { extname, join } from 'node:path'

/**
 * The GLARE BUDGET numbers, computed exactly as tools/smoke.mjs computes them.
 *
 * "It looks too bright" is not falsifiable and this codebase has twice shipped
 * additive VFX that erased the road. `blownPct` is the share of pixels clipped
 * to white in every channel; `roadBlownPct` is the same over the lower-middle
 * third -- the road, the racing line and the barriers the player steers by --
 * and `roadGradient` is the mean luminance step between neighbouring pixels
 * there, which collapses toward zero when the road has been replaced by a flat
 * white patch.
 */
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
const OUT = join('shots', 'sparks')
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }
const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  const path = join('dist', url === '/' ? 'index.html' : url.slice(1))
  if (!existsSync(path)) { res.writeHead(404); res.end('nope'); return }
  res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' })
  res.end(readFileSync(path))
})
await new Promise((r) => server.listen(4179, r))

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const ctx = await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1 })
const page = await ctx.newPage()
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(String(e)))

await page.goto('http://localhost:4179/', { waitUntil: 'networkidle' })
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
// The tier has to be PINNED. Under SwiftShader the adaptive scaler drops to
// `low` within seconds, which builds no composer, and a probe that measured
// that would be photographing a frame with no bloom in it.
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
 * What is ACTUALLY in the pool at the shutter.
 *
 * Contact particles are identified the way the headless probe identifies them:
 * a particle whose birth is in the FUTURE is a bounce leg or a settled marble,
 * because nothing else in this file writes a delayed birth. `hues` counts
 * distinct 30-degree hue buckets among live BEADS, which is the whole claim of
 * "randomised colouring" reduced to a number.
 *
 * KIND 7 IS THE IMPACT PARTICLE NOW. It used to be kind 1 (K_SPARK, a
 * velocity-stretched streak) and is now kind 7 (K_BEAD, a round marble) --
 * this counter was silently reporting `sparks: 2` on a frame with a hundred
 * beads in it until it was told. `sparks` is kept and now means what it says:
 * the DRIFT's struck sparks and the weapon/boost streaks, which are a
 * different channel and deliberately still streaks.
 *
 * `nearBeads` is the one that catches the failure this effect actually has:
 * beads within 6 m of the lens, each of which covers a large solid angle. A
 * frame with thirty of those is a flat additive wash whatever `blownPct` says.
 */
async function poolStats() {
  return page.evaluate(() => {
    const v = window.__GAME__.vfx
    if (!v || !v.aMisc) return null
    const t = v.time
    const cam = window.__GAME__.camera ?? window.__GAME__.chase?.camera
    const cp = cam ? cam.position : null
    let live = 0, pending = 0, sparks = 0, beads = 0, embers = 0, nearBeads = 0
    let beadArea = 0
    const hue = new Set()
    for (let i = 0; i < v.pool; i++) {
      const i4 = i * 4, i3 = i * 3
      const life = v.aMisc[i4 + 1]
      if (life <= 0) continue
      const age = t - v.aMisc[i4]
      if (age < 0) { pending++; continue }
      if (age >= life) continue
      live++
      const kind = Math.round(v.aMisc2[i4 + 2])
      if (kind === 1) sparks++
      else if (kind === 7) {
        beads++
        // The delayed-birth marbles are the ones that landed; a settled one
        // has zero growth headroom left and drifts at 5% of its impact speed.
        if (v.aMisc[i4 + 3] < 0) embers++
        const r = v.aCol[i3], g = v.aCol[i3 + 1], b = v.aCol[i3 + 2]
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
        if (mx > 0.05 && mx - mn > mx * 0.10) {
          let h = 0
          if (mx === r) h = ((g - b) / (mx - mn)) / 6
          else if (mx === g) h = (2 + (b - r) / (mx - mn)) / 6
          else h = (4 + (r - g) / (mx - mn)) / 6
          hue.add(Math.floor(((h % 1) + 1) % 1 * 12))
        }
        if (cp) {
          // Position at this instant: the same analytic drag + gravity arc the
          // vertex shader integrates, so this is where the quad actually is.
          const k = v.aMisc2[i4 + 1]
          const integ = k > 0.001 ? (1 - Math.exp(-k * age)) / k : age
          const gg = 0.5 * v.aMisc2[i4] * age * age
          const px = v.aPos[i3] + v.aVel[i3] * integ + v.aAxis[i3] * gg
          const py = v.aPos[i3 + 1] + v.aVel[i3 + 1] * integ + v.aAxis[i3 + 1] * gg
          const pz = v.aPos[i3 + 2] + v.aVel[i3 + 2] * integ + v.aAxis[i3 + 2] * gg
          const d = Math.hypot(px - cp.x, py - cp.y, pz - cp.z)
          const size = v.aMisc[i4 + 2] + v.aMisc[i4 + 3] * age
          if (d < 6) nearBeads++
          if (d > 0.2) beadArea += (size / d) * (size / d)
        }
      }
    }
    const r0 = window.__GAME__.race.state.racers.find((r) => r.isLocal) ?? window.__GAME__.race.state.racers[0]
    return {
      live, pending, sparks, beads, embers, nearBeads,
      beadSteradian: +beadArea.toFixed(3), hueBuckets: hue.size,
      wallTime: +r0.wallTime.toFixed(3),
      speed: +Math.hypot(r0.vel.x, r0.vel.y, r0.vel.z).toFixed(1),
      reduced: v.reduced, tokens: Math.round(v.slotTokens),
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
  console.log(`${tag.padEnd(11)} ${JSON.stringify(st)}\n            ${JSON.stringify(px)}  -> ${name}`)
}

/**
 * The SAME frame with the particle mesh hidden, so the sparks' contribution to
 * the glare budget is a subtraction rather than an assertion. Only meaningful
 * while the clock is stopped -- otherwise the two frames are different moments.
 */
async function shootBaseline(tag) {
  await page.evaluate(() => { window.__GAME__.vfx.pMesh.visible = false })
  await page.waitForTimeout(1200)
  const name = `${trackId}${RM ? '-rm' : ''}-${tag}-noparticles.png`
  const path = join(OUT, name)
  await page.screenshot({ path })
  await page.evaluate(() => { window.__GAME__.vfx.pMesh.visible = true })
  await page.waitForTimeout(1200)
  const px = analyse(path)
  console.log(`${(tag + '/base').padEnd(11)} ${JSON.stringify(px)}  -> ${name}`)
  return px
}

/**
 * THE RAIL.
 *
 * A contact lasts one to three sim steps and this renderer delivers one to
 * five frames a second, so "drive into the wall and screenshot" photographs
 * the aftermath -- the first attempt at this probe caught the car back on the
 * racing line with the impact already over and `wallTime` back at 0. The rail
 * re-arms the state every sim step instead, exactly as the readability probe
 * in tools/smoke.mjs pins speed and boost, so the moment being photographed is
 * a moment the sim can be held in rather than one the shutter has to catch.
 *
 * Nothing here fakes a spark: the sim runs its own collision code, computes
 * its own `severity` and pushes its own `wall`/`bump` events. The rail only
 * decides where the car is when it does.
 */
await page.evaluate(() => {
  const g = window.__GAME__
  const race = g.race
  const track = g.track
  const st = race.state
  const r = st.racers.find((x) => x.isLocal) ?? st.racers[0]
  const P = { mode: 'off', s: 0, closing: 0, speed: 45, drift: false, inset: 0 }
  window.__RAIL__ = P
  const orig = race.step.bind(race)
  race.step = function () {
    const M = P.mode
    if (M === 'wall') {
      const smp = track.at(P.s)
      // Just inside the barrier, pointed into it. `severity` is the rate the
      // car closes on the barrier LINE, so the angle is what sets the force:
      // the sim measures it, this only supplies it.
      // `inset` backs the car off the barrier line without moving it out of
      // frame. The settle before the one-shot needs the camera alongside the
      // wall AND the token bucket full, and at inset 0 the car is still in
      // contact every frame -- which spends tokens, so the "single slam" was
      // photographed on a bucket holding 31 of 880 and measured as an effect
      // that was not there. Nothing else uses it; the slam rows still run at 0.
      const lat = -(smp.width - 1.4 - (P.inset || 0))
      const p = track.surfacePoint(P.s, lat)
      r.pos.x = p.x; r.pos.y = p.y + 0.55; r.pos.z = p.z
      r.splineS = P.s; r.totalS = P.s; r.lateral = lat
      const tanYaw = Math.atan2(smp.tangent.x, smp.tangent.z)
      const ang = Math.asin(Math.max(-0.98, Math.min(0.98, P.closing / P.speed)))
      // -right is the side `lat` is negative on; STEER/right conventions do not
      // enter into it, the yaw is built from the tangent and the sign of lat.
      r.yaw = tanYaw + ang
      r.fwd.x = Math.sin(r.yaw); r.fwd.y = 0; r.fwd.z = Math.cos(r.yaw)
      r.up.x = smp.normal.x; r.up.y = smp.normal.y; r.up.z = smp.normal.z
      r.vel.x = r.fwd.x * P.speed; r.vel.y = 0; r.vel.z = r.fwd.z * P.speed
      r.grounded = true; r.altitude = 0; r.airTime = 0; r.vertVel = 0
      r.offTrackTime = 0; r.respawnTime = 0; r.spinTime = 0; r.stunTime = 0
      r.driftSide = 0; r.driftTier = -1; r.driftCharge = 0
      r.boostTime = 0
      race.setInput(0, { steer: 0, throttle: 1, brake: 0, drift: false, item: false, itemBack: false, lift: false, lookBack: false })
    }
    orig()
    if (M === 'wall' && P.reseat) {
      P.reseat = false
      // The rail TELEPORTS, and the trail ribbons have no idea: without this
      // every shot carries a several-hundred-metre white streak from the car to
      // wherever it used to be, straight through the effect being photographed.
      // Same fix tools/smoke.mjs applies for the same reason.
      const v = g.vfx
      if (v && v.rfx) for (const f of v.rfx) f.trailReady = false
      if (g.chase && g.chase.reset) g.chase.reset(r)
    }
  }
})

async function rail(mode, s, closing, speed) {
  await page.evaluate(([m, sv, c, sp]) => {
    const g = window.__GAME__
    const P = window.__RAIL__
    const st = g.race.state
    const r = st.racers.find((x) => x.isLocal) ?? st.racers[0]
    P.mode = m; P.s = sv; P.closing = c; P.speed = sp; P.reseat = true
    for (const o of st.racers) if (o !== r) o.pos.y = -900
  }, [mode, s, closing, speed])
}


// A stretch of Rustfall with a plain (non-bounce) barrier, found by asking the
// track rather than by picking a number that looked right.
const wallS = await page.evaluate(() => {
  const t = window.__GAME__.track
  // A STRAIGHT with a plain barrier. On a corner the rail's fixed yaw offset
  // fights the road and the camera never settles behind the car, so the
  // photograph is of the car from the side with the impact facing away.
  let best = -1, bestK = 1e9
  for (let i = 60; i < t.samples.length - 60; i++) {
    const smp = t.samples[i]
    // NOT a boost strip. Those are the brightest stretches on the circuit and
    // photographing a spark against one measures the strip, not the spark.
    if (smp.bounce || smp.open || smp.boost || smp.width < 9) continue
    const s = (i / t.samples.length) * t.length
    const k = Math.abs(t.curvatureAt(s, 40))
    if (k < bestK) { bestK = k; best = s }
  }
  return best < 0 ? 300 : best
})
console.log(`wall rail at s=${wallS.toFixed(0)}m`)

// ---------------------------------------------------------------------------
// 1. RUB. Barely closing on the barrier: the "no threshold" case, which has to
//    produce a visible trickle rather than nothing.
// ---------------------------------------------------------------------------
await rail('wall', wallS, 1.2, 50)
await waitSim(2.0)
await shoot('rub')

// ---------------------------------------------------------------------------
// 2. SCRAPE. A real graze, a third of full force.
// ---------------------------------------------------------------------------
await rail('wall', wallS, 7, 50)
await waitSim(1.5)
await shoot('scrape')

// ---------------------------------------------------------------------------
// 3. SLAM. Square-ish into the barrier at speed: full force, every frame.
// ---------------------------------------------------------------------------
await rail('wall', wallS, 24, 55)
await waitSim(1.5)
await shoot('slam')
await waitSim(1.0)
await shoot('slam2')

// ---------------------------------------------------------------------------
// 3b. ONE SLAM, PHOTOGRAPHED MID-FLIGHT.
//
// The rail above holds the car at full closing speed for a second and a half,
// which no player can do -- `severity` is a RATE of closing, so a real slam is
// one to three frames -- and it drains the spark budget to zero and then runs
// at the refill rate. That is the right thing to measure for perf and the
// wrong thing to photograph: it is a picture of the throttle, not of an
// impact. So: let the budget refill, arm ONE contact, and stop the clock a
// fixed 0.13 s later.
//
// THE SHUTTER stops VFX time, not the game. Passing dt = 0 into the VFX pass
// freezes every particle exactly where it is while the renderer keeps drawing,
// which is the only way to photograph a 0.3 s burst on a renderer that
// delivers between one and five frames a second. Nothing is faked: the sim
// ran its own collision and pushed its own event; only the clock is held.
// ---------------------------------------------------------------------------
await page.evaluate(() => {
  window.__RAIL__.mode = 'off'
  const g = window.__GAME__
  const v = g.vfx
  const orig = v.update.bind(v)
  // `hits` is how many contact FRAMES to let through before the clock stops. A
  // real slam is two to four frames of closing, not one, so freezing on the
  // first event photographs a quarter of the impact.
  window.__SHUT__ = { armed: false, since: -1, at: 0.05, hits: 0, want: 3, primed: false }
  //
  // THE SHUTTER IS CLAMPED, and it was not always: accumulating the real frame
  // dt gives a shutter whose precision is one FRAME (250 ms under SwiftShader),
  // so "freeze 50 ms after the impact" really froze a quarter of a second
  // after it, with the burst already spread down the road. Passing the
  // REMAINDER through advances the VFX clock by exactly `at` and then stops.
  //
  // AND IT PRIMES ONE UPDATE FIRST, which is the whole difference between a
  // photograph of a burst and a photograph of the instant before one.
  //
  // The events are consumed by the FIRST vfx.update after the sim step that
  // pushed them, and the particles are born during that update -- at its END,
  // with `age` exactly 0. A shutter that spends its whole offset on that same
  // update therefore freezes the clock at the moment of birth every time,
  // whatever the offset says: every fan is still a single point, every arc is
  // still at the wall. Measured, this drew a 35-streak blade fan as a 17-pixel
  // asterisk on the car and a full slam as a handful of beads at the barrier,
  // and both were read as "the effect is too small" before the rig was.
  //
  // So: one update at a single sim step's worth (which consumes the events and
  // creates the burst), and only THEN the offset.
  v.update = function (dt, st, cam, id) {
    const S = window.__SHUT__
    if (S.since >= 0) {
      if (!S.primed) { S.primed = true; return orig(1 / 60, st, cam, id) }
      const rem = S.at - S.since
      if (rem <= 0) return orig(0, st, cam, id)
      const step = Math.min(dt, rem)
      S.since += step
      return orig(step, st, cam, id)
    }
    return orig(dt, st, cam, id)
  }
  const race = g.race
  const prev = race.step
  race.step = function () {
    prev.call(race)
    const S = window.__SHUT__
    if (!S.armed || S.since >= 0) return
    const r = race.state.racers.find((x) => x.isLocal) ?? race.state.racers[0]
    for (const e of r.events) {
      if (e.t === 'wall' || e.t === 'bump') {
        S.hits++
        S.force = +e.force.toFixed(2)
        if (S.hits >= S.want) {
          S.since = 0
          S.primed = false
          window.__RAIL__.mode = 'off'
          g.maxSubSteps = 0
        }
        return
      }
    }
  }
})
// Settle FIRST, then hit. The chase camera is a real chase camera: it takes a
// second or two to swing in behind a teleported car, and freezing the sim on
// the very first contact frame photographs the impact from wherever the camera
// happened to be mid-swing. So the rail runs alongside the barrier at almost
// no closing speed -- which costs the budget nothing and lets it refill -- and
// only then is the angle opened up and the shutter armed.
//
// AND THE BUDGET HAS TO BE FULL WHEN THE SHUTTER OPENS. The first version of
// this settle ran alongside the barrier at 0.3 m/s of closing, which is a
// contact, which spends tokens -- and photographed a "single slam" that had
// been handed an EMPTY bucket by the 1.5 s sustained rail two scenarios
// earlier. The picture was four beads and it was a picture of the throttle
// again, one level down. Zero closing, four seconds, and the token count is
// printed so a starved burst can never be mistaken for a quiet effect.
await page.evaluate(() => { window.__RAIL__.inset = 3.2 })
await rail('wall', wallS, 0.0, 52)
await waitSim(4.0)
await page.evaluate(() => { window.__RAIL__.inset = 0 })
const armTokens = await page.evaluate(() => Math.round(window.__GAME__.vfx.slotTokens))
console.log(`slot tokens at arm: ${armTokens} / ${await page.evaluate(() => window.__GAME__.vfx.slotBucket)}`)
await page.evaluate(() => {
  window.__SHUT__.armed = true
  window.__RAIL__.closing = 26
  window.__RAIL__.speed = 58
})
for (let i = 0; i < 120; i++) {
  const done = await page.evaluate(() => window.__SHUT__.since >= window.__SHUT__.at)
  if (done) break
  await page.waitForTimeout(200)
}
const hitInfo = await page.evaluate(() => ({ f: window.__SHUT__.force, n: window.__SHUT__.hits }))
console.log(`one-shot slam: ${hitInfo.n} contact frames, sim reported wall force ${hitInfo.f} m/s`)
await shoot('oneslam')
await shootBaseline('oneslam')
// The SAME burst, later. The clock is already stopped, so advancing it is the
// only thing that moves: this is one impact photographed three times.
for (const [at, tag] of [[0.28, 'onemid'], [0.85, 'onesettled']]) {
  await page.evaluate((v) => { window.__SHUT__.at = v }, at)
  for (let i = 0; i < 120; i++) {
    const done = await page.evaluate(() => window.__SHUT__.since >= window.__SHUT__.at)
    if (done) break
    await page.waitForTimeout(200)
  }
  await shoot(tag)
}
await page.evaluate(() => { window.__SHUT__.since = -1; window.__SHUT__.primed = false; window.__SHUT__.armed = false; window.__SHUT__.hits = 0; window.__GAME__.maxSubSteps = 400 })

// ---------------------------------------------------------------------------
// 4. LINGER. Release the rail and FREEZE: what is left on the road afterwards.
// ---------------------------------------------------------------------------
await page.evaluate(() => {
  window.__RAIL__.mode = 'off'
  window.__GAME__.maxSubSteps = 0
})
await page.waitForTimeout(1200)
await shoot('linger')
await page.evaluate(() => { window.__GAME__.maxSubSteps = 400 })

// ---------------------------------------------------------------------------
// 5. PACK. Eight cars in two lanes, closing every frame, so `bump` fires for
//    real -- the perf case that was flagged.
// ---------------------------------------------------------------------------
await page.evaluate((s0) => {
  const g = window.__GAME__
  const track = g.track
  const st = g.race.state
  const race = g.race
  const P = window.__RAIL__
  P.mode = 'off'
  const r = st.racers.find((x) => x.isLocal) ?? st.racers[0]
  const smp = track.at(s0)
  const tanYaw = Math.atan2(smp.tangent.x, smp.tangent.z)
  const place = () => {
    st.racers.forEach((o, i) => {
      const lane = (i % 2 ? 1 : -1) * 1.05
      const row = Math.floor(i / 2)
      const s = s0 + row * 4.2
      const sp = track.surfacePoint(s, lane)
      o.pos.x = sp.x; o.pos.y = sp.y + 0.55; o.pos.z = sp.z
      o.splineS = s; o.totalS = s; o.lateral = lane
      o.yaw = tanYaw; o.fwd.x = Math.sin(tanYaw); o.fwd.y = 0; o.fwd.z = Math.cos(tanYaw)
      o.up.x = smp.normal.x; o.up.y = smp.normal.y; o.up.z = smp.normal.z
      const side = lane > 0 ? -1 : 1
      o.vel.x = smp.tangent.x * 55 + smp.right.x * side * 5
      o.vel.z = smp.tangent.z * 55 + smp.right.z * side * 5
      o.vel.y = 0
      o.grounded = true; o.altitude = 0; o.airTime = 0; o.vertVel = 0
      o.offTrackTime = 0; o.respawnTime = 0; o.spinTime = 0; o.stunTime = 0
      o.finished = false; o.driftSide = 0; o.driftTier = -1
      race.setInput(o.id ?? 0, { steer: 0, throttle: 1, brake: 0, drift: false, item: false, itemBack: false, lift: false, lookBack: false })
    })
  }
  window.__PACK__ = place
  const prev = race.step
  race.step = function () { if (window.__PACKON__) place(); prev.call(race) }
  window.__PACKON__ = true
  place()
  if (g.chase && g.chase.reset) g.chase.reset(r)
}, wallS + 90)
await waitSim(1.2)
await shoot('pack')
await waitSim(0.8)
await shoot('pack2')

console.log(`console errors: ${errors.length}`)
if (errors.length) console.log(errors.slice(0, 6).join('\n'))
await browser.close()
server.close()
process.exit(0)
