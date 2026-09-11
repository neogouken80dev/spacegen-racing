/**
 * THE BOOST WARP, IN A REAL BROWSER.
 *
 * Two questions a headless run cannot settle, and one it can but should not be
 * trusted on alone:
 *
 *  1. Does the car actually hold its on-screen size through a boost dolly? The
 *     size is measured the way tools/smoke.mjs measures it -- the chassis box
 *     projected through the LIVE camera matrices -- so it is the geometry the
 *     GPU is about to rasterise, not a re-derivation of it.
 *  2. Does the picture read as a warp? That one is answered by photographs, so
 *     every scenario is shot with the effect and shot again with it forced to
 *     zero, from the same place on the same road.
 *  3. Is the camera-to-car distance flat while driving? Sampled per frame over
 *     a stretch of real driving, not over a teleport.
 *
 *   node tools/probe-warp.mjs [--track=rustfall]
 *
 * EVERYTHING WAITS ON SIM TIME. Under SwiftShader this page runs at 1-5 fps and
 * main.ts clamps a frame to 0.25s of simulation, so a wall-clock wait is
 * somewhere between a quarter of what it looks like and a single step.
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const trackId = arg('track', 'rustfall')
const OUT = join('shots', 'warp')
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
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist'],
})
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
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
  // SwiftShader has long since dropped to `low`, which builds no composer at
  // all -- a probe that measured that would conclude the warp did nothing.
  if (g.tier === 'low' || g.tier === 'medium') g.setTier('high')
  g.qualityCooldown = 1e9
  g.frameTimes.length = 0
})
await page.waitForTimeout(2500)

const simT = () => page.evaluate(() => window.__GAME__?.race?.state?.time ?? 0)
async function waitSim(seconds, capMs = 90000) {
  const start = await simT()
  const t0 = Date.now()
  while (Date.now() - t0 < capMs) {
    if ((await simT()) - start >= seconds) return
    await page.waitForTimeout(120)
  }
}

/**
 * The state that matters, read from the live objects. `size` is the car's
 * projected box in pixels of frame HEIGHT, so it is comparable across frames
 * regardless of what the aspect framing is doing.
 */
const probe = () => page.evaluate(() => {
  const g = window.__GAME__
  const cam = g.chase.camera
  const st = g.race.state
  // THE RENDER VIEW, not the live racer. The camera is placed against the
  // interpolated copy, and at 65 m/s the live racer is up to a whole sim step
  // -- 1.08m -- away from it, which is most of a metre of pure measurement
  // error in a number whose whole point is being flat to a fraction of one.
  const v = g.renderRacers[g.localId].view
  const r = v
  cam.updateMatrixWorld()
  const mv = cam.matrixWorldInverse.elements
  const pr = cam.projectionMatrix.elements
  const cy = Math.cos(v.yaw), sy = Math.sin(v.yaw)
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
  const post = g.post
  const u = post && post.compositeMat ? post.compositeMat.uniforms : null
  return {
    t: st.time,
    dist: Math.hypot(cam.position.x - r.pos.x, cam.position.y - r.pos.y, cam.position.z - r.pos.z),
    // The along-the-road part of that, which is the thing the lock pins.
    ground: Math.hypot(cam.position.x - r.pos.x, cam.position.z - r.pos.z),
    height: cam.position.y - r.pos.y,
    fov: cam.fov,
    dolly: g.chase.dollyLevel,
    uWarp: u ? u.uWarp.value : null,
    uScreen: u ? u.uScreen.value : null,
    speed: Math.hypot(r.vel.x, r.vel.z),
    boostMag: st.racers[g.localId].boostMag,
    boostSource: st.racers[g.localId].boostSource,
    // Width and height of the car in pixels, and their product -- an AREA, so
    // it moves as the square of any size change and is the more sensitive test.
    w: (x1 - x0) * W, h: (y1 - y0) * H,
    rect: [Math.round(x0 * W), Math.round(y0 * H), Math.round(x1 * W), Math.round(y1 * H)],
  }
})

const shot = (n) => page.screenshot({ path: join(OUT, `${trackId}-${n}.png`) })
const stats = (v) => {
  const s = [...v].sort((a, b) => a - b)
  const mean = v.reduce((a, b) => a + b, 0) / v.length
  return {
    min: s[0], max: s[s.length - 1], mean,
    sd: Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length),
  }
}
const f2 = (x) => (x === null || x === undefined ? 'n/a' : x.toFixed(2))

// ---------------------------------------------------------------------------
// 1. Distance over real driving
// ---------------------------------------------------------------------------
await page.keyboard.down('KeyW')
for (let i = 0; i < 120; i++) {
  const p = await probe()
  if (p.speed > 30) break
  await page.waitForTimeout(400)
}
await shot('1-cruise')

const rows = []
const t0 = await simT()
while ((await simT()) - t0 < 22) {
  rows.push(await probe())
  await page.waitForTimeout(90)
}
await page.keyboard.up('KeyW')

const d = stats(rows.map((r) => r.dist))
const gr = stats(rows.map((r) => r.ground))
const hh = stats(rows.map((r) => r.height))
console.log(`\n=== ${trackId}: 22s of real driving, ${rows.length} samples ===`)
console.log(`  camera->car distance  ${f2(d.min)} .. ${f2(d.max)}  mean ${f2(d.mean)}  sd ${f2(d.sd)}`)
console.log(`  ground distance       ${f2(gr.min)} .. ${f2(gr.max)}  mean ${f2(gr.mean)}  sd ${f2(gr.sd)}`)
console.log(`  height above car      ${f2(hh.min)} .. ${f2(hh.max)}  mean ${f2(hh.mean)}  sd ${f2(hh.sd)}`)
console.log(`  speed                 ${f2(stats(rows.map((r) => r.speed)).min)} .. ${f2(stats(rows.map((r) => r.speed)).max)} m/s`)
console.log(`  warp seen             ${Math.max(...rows.map((r) => r.uWarp ?? 0)).toFixed(3)} peak`)

// ---------------------------------------------------------------------------
// 2. A boost dolly, sampled frame by frame
// ---------------------------------------------------------------------------
/**
 * PER-RENDERED-FRAME SAMPLING, AND THE RIGHT CONTROL.
 *
 * Two things make a wall-clock poll useless here. SwiftShader delivers 1-5
 * frames a second, so a 70ms poll sees the same frame ten times and then jumps
 * over four; and the dolly's 0.26s half-life against a 0.25s frame delta means
 * the impulse is most of the way down after TWO frames, so a poll that misses
 * the peak reports a shot that never happened. So the sample is taken from
 * inside `post.render`, which the game calls exactly once per rendered frame,
 * after the camera has been placed.
 *
 * The CONTROL is the other half. Comparing the car against its own size before
 * the boost is measuring the wrong thing: a boost legitimately widens the FOV
 * from 64 to 86 degrees and everything in the frame, car included, gets smaller
 * -- the dolly exists to stop the car changing size because of the SHOT, not to
 * undo the speed and boost FOV as well (see camera.ts). The camera already
 * carries both halves of that comparison: `pos` is the un-dollied rig position
 * and `fovBase` is the FOV with no shot in it, damped exactly as `fov` is. So
 * the ratio is computed per frame, in the page, off the live rig:
 *
 *   size  = 1 / (d * tan(fov/2))
 *   ratio = (|pos - car| * tan(fovBase/2)) / (|camera.position - car| * tan(fov/2))
 *
 * 1.0 means the shot did not move the car on screen. At 1280x720 the aspect is
 * exactly refAspect, so framedFov() is the identity and the authored angles are
 * the rendered ones.
 */
async function installSampler() {
  await page.evaluate(() => {
    const g = window.__GAME__
    if (g.__sampling) return
    g.__sampling = true
    window.__SAMP__ = []
    const post = g.post
    const orig = post.render.bind(post)
    post.render = function (dt, b, h, sp, w, calm) {
      const c = g.chase
      const car = g.renderRacers[g.localId].view.pos
      const half = (a) => Math.tan(a * 0.5 * Math.PI / 180)
      const dCam = Math.hypot(
        c.camera.position.x - car.x, c.camera.position.y - car.y, c.camera.position.z - car.z)
      const dRig = Math.hypot(c.pos.x - car.x, c.pos.y - car.y, c.pos.z - car.z)
      window.__SAMP__.push({
        dt,
        ratio: (dRig * half(c.fovBase)) / Math.max(1e-6, dCam * half(c.fov)),
        dolly: c.dollyLevel, warp: w ?? 0, fov: c.fov, fovBase: c.fovBase,
        dCam, dRig, boost: b,
      })
      return orig(dt, b, h, sp, w, calm)
    }
  })
}
await installSampler()

/**
 * Fire a boost the way the game does -- by raising boostMag from a non-drift
 * source, which is exactly what applyBoost does on a strip -- and read every
 * rendered frame from the impulse onward. `screen` pins the player's
 * Speed-effects value; `rm` pins reduced motion.
 */
async function boostRun(label, { screen = 1, rm = false, effect = true } = {}) {
  await page.evaluate(([sc, r]) => {
    const g = window.__GAME__
    g.reduceMotion = r
    if (g.post) g.post.setIntensity(1, sc)
  }, [screen, rm])
  await page.keyboard.down('KeyW')
  // Back to pace AND back to no boost: `boostMag` is a step function, so a
  // grant that lands while the previous one is still up is not a rise and the
  // camera correctly ignores it. A run that fired into a live boost would
  // measure nothing and look like a broken effect.
  for (let i = 0; i < 90; i++) {
    const p = await probe()
    if (p.speed > 40 && p.dolly < 0.01 && p.boostMag === 0) break
    await page.waitForTimeout(400)
  }
  await page.evaluate(() => { window.__SAMP__.length = 0 })
  if (effect) {
    await page.evaluate(() => {
      const g = window.__GAME__
      const r = g.race.state.racers[g.localId]
      r.boostMag = Math.max(r.boostMag, window.__TUNING__.boost.padMag)
      r.boostTime = Math.max(r.boostTime, window.__TUNING__.boost.padDuration)
      r.boostSource = 'pad'
    })
  }
  const t1 = await simT()
  let shotAt = false
  while ((await simT()) - t1 < 2.4) {
    if (!shotAt) {
      const p = await probe()
      if (p.dolly > 0.2 || !effect) { await shot(`2-${label}`); shotAt = true }
    }
    await page.waitForTimeout(60)
  }
  if (!shotAt) await shot(`2-${label}`)
  await page.keyboard.up('KeyW')

  const seq = await page.evaluate(() => window.__SAMP__.slice())
  const ratios = seq.map((p) => p.ratio)
  const worst = Math.max(...ratios.map((v) => Math.abs(v - 1))) * 100
  console.log(
    `  ${label.padEnd(24)} frames ${String(seq.length).padStart(3)}  `
    + `mean dt ${(seq.reduce((a, b) => a + b.dt, 0) / seq.length).toFixed(3)}s  `
    + `size ${Math.min(...ratios).toFixed(4)}..${Math.max(...ratios).toFixed(4)}  `
    + `worst ${worst.toFixed(2)}%  peak dolly ${Math.max(...seq.map((p) => p.dolly)).toFixed(3)}  `
    + `peak uWarp ${Math.max(...seq.map((p) => p.warp)).toFixed(3)}  `
    + `FOV ${f2(Math.min(...seq.map((p) => p.fovBase)))}->${f2(Math.max(...seq.map((p) => p.fov)))}  `
    + `pull-in ${f2(Math.max(...seq.map((p) => p.dRig - p.dCam)))}m`,
  )
  return seq
}

console.log(`\n=== boost dolly: car size against its own pre-impulse size ===`)
await boostRun('no-boost-control', { effect: false })
await boostRun('boost-full-fx', {})
await boostRun('boost-screen-off', { screen: 0 })
await boostRun('boost-reduced-motion', { rm: true })
await page.evaluate(() => {
  const g = window.__GAME__
  g.reduceMotion = false
  if (g.post) g.post.setIntensity(1, 1)
})

// ---------------------------------------------------------------------------
// 2b. THE FRAMING CHANGE, photographed.
//
// The distance lock is not a bug fix with no picture attached: pinning the rig
// at 9m where it used to sit at 17-21m makes the car noticeably bigger at
// racing speed. That is the whole point and it is also the thing most likely
// to be objected to, so it gets a photograph rather than a paragraph. Both
// shots are taken at full throttle on the same stretch of road, with the
// camera given 2.5s of SIM time to settle after each switch.
// ---------------------------------------------------------------------------
/**
 * The straightest wide stretch on the circuit, so an A/B of two camera rigs is
 * not really an A/B of two corners. Found once, used for both shots.
 */
const STRAIGHT = await page.evaluate(() => {
  const t = window.__GAME__.track
  const N = t.samples.length
  const L = t.length
  let best = 0, bestScore = -1e9
  for (let i = 0; i < N; i++) {
    let turn = 0
    for (let k = 0; k < 24; k++) {
      const a = t.samples[(i + k) % N].tangent
      const b = t.samples[(i + k + 1) % N].tangent
      turn += Math.abs(Math.atan2(a.x * b.z - a.z * b.x, a.x * b.x + a.z * b.z))
    }
    const score = -turn * 40 + t.samples[i].width
    if (score > bestScore) { bestScore = score; best = i }
  }
  return (best / N) * L
})

/**
 * Teleport to that straight at racing speed, hold throttle, and give the rig
 * two seconds of SIM time to reach its steady state -- 16 half-lives of
 * posHalfLife, so whatever lag the settings ask for is fully developed -- then
 * photograph. Same road, same speed, two rigs.
 */
async function framingShot(label, lock, dGain, hGain) {
  await page.evaluate(([l, d, h, s0]) => {
    const C = window.__TUNING__.camera
    C.distanceLock = l; C.distanceSpeedGain = d; C.heightSpeedGain = h
    const g = window.__GAME__
    const st = g.race.state
    const me = st.racers[g.localId]
    const smp = g.track.at(s0)
    const pt = g.track.surfacePoint(s0, 0)
    me.pos.x = pt.x; me.pos.y = pt.y + 1.2; me.pos.z = pt.z
    me.splineS = s0; me.totalS = s0; me.lateral = 0
    me.yaw = Math.atan2(smp.tangent.x, smp.tangent.z)
    me.vel.x = smp.tangent.x * 55; me.vel.y = smp.tangent.y * 55; me.vel.z = smp.tangent.z * 55
    me.fwd.x = smp.tangent.x; me.fwd.y = smp.tangent.y; me.fwd.z = smp.tangent.z
    me.up.x = smp.normal.x; me.up.y = smp.normal.y; me.up.z = smp.normal.z
    me.vertVel = 0; me.driftSide = 0; me.spinTime = 0; me.respawnTime = 0
    me.boostMag = 0; me.boostTime = 0; me.boostSource = 'none'
    for (const r of st.racers) if (r !== me) r.pos.y = -900
    g.chase.reset(g.renderRacers[g.localId].view)
  }, [lock, dGain, hGain, STRAIGHT])
  await page.keyboard.down('KeyW')
  await waitSim(2.0)
  const p = await probe()
  await shot(`2b-${label}`)
  console.log(
    `  ${label.padEnd(24)} dist ${f2(p.dist)}m  ground ${f2(p.ground)}m  height ${f2(p.height)}m  `
    + `speed ${f2(p.speed)} m/s  car on screen ${Math.round(p.w)}x${Math.round(p.h)} px`,
  )
}
console.log('\n=== the framing the lock buys, at full throttle ===')
await framingShot('before-lag', 0, 0.14, 0.06)
await framingShot('after-locked', 1, 0, 0)
await page.keyboard.up('KeyW')

// ---------------------------------------------------------------------------
// 3. Paired photographs: the same road, with and without the warp
// ---------------------------------------------------------------------------
/**
 * Freeze the sim and hold the effect at a fixed level, so the pair differ in
 * the effect and in nothing else. maxSubSteps = 0 stops the accumulator without
 * pausing the render loop, which is how tools/probe-shots.mjs holds a frame.
 */
async function pairShot(name, warpLevel) {
  await page.evaluate(([w]) => {
    const g = window.__GAME__
    g.maxSubSteps = 0
    const post = g.post
    if (post && post.compositeMat) {
      // Pin the uniform directly: the camera's impulse decays and a photograph
      // has to be of a stated level, not of whatever the decay had reached.
      post.compositeMat.uniforms.uWarp.value = w
      post.__pin = w
    }
    // ...and hold it there against the next render's write. Wraps whatever is
    // already there, which by now includes the per-frame sampler.
    if (!g.__warpPinned) {
      const orig = post.render.bind(post)
      post.render = function (dt, b, h, s, w, calm) { orig(dt, b, h, s, post.__pin, calm) }
      g.__warpPinned = true
    }
  }, [warpLevel])
  await page.waitForTimeout(2200)
  await shot(name)
}

// Park on the same straight at racing speed with a boost running, settle the
// rig, and only then freeze: a still taken wherever the car happened to crash
// is a still of a stationary car, and the whole subject here is speed.
await page.evaluate(([s0]) => {
  const g = window.__GAME__
  const st = g.race.state
  const me = st.racers[g.localId]
  const smp = g.track.at(s0)
  const pt = g.track.surfacePoint(s0, 0)
  me.pos.x = pt.x; me.pos.y = pt.y + 1.2; me.pos.z = pt.z
  me.splineS = s0; me.totalS = s0; me.lateral = 0
  me.yaw = Math.atan2(smp.tangent.x, smp.tangent.z)
  me.vel.x = smp.tangent.x * 62; me.vel.y = smp.tangent.y * 62; me.vel.z = smp.tangent.z * 62
  me.fwd.x = smp.tangent.x; me.fwd.y = smp.tangent.y; me.fwd.z = smp.tangent.z
  me.up.x = smp.normal.x; me.up.y = smp.normal.y; me.up.z = smp.normal.z
  me.vertVel = 0; me.driftSide = 0; me.spinTime = 0; me.respawnTime = 0
  for (const r of st.racers) if (r !== me) r.pos.y = -900
  g.chase.reset(g.renderRacers[g.localId].view)
}, [STRAIGHT])
await page.keyboard.down('KeyW')
await waitSim(1.6)
const pinInfo = await page.evaluate(() => {
  const g = window.__GAME__
  const r = g.race.state.racers[g.localId]
  r.boostMag = window.__TUNING__.boost.padMag
  r.boostTime = 9
  r.boostSource = 'pad'
  return { speed: Math.hypot(r.vel.x, r.vel.z), s: r.splineS }
})
await waitSim(0.8)
await page.keyboard.up('KeyW')
console.log(`\n=== paired stills, sim frozen at ${pinInfo.speed.toFixed(1)} m/s, s=${pinInfo.s.toFixed(0)} ===`)
await pairShot('3-warp-000', 0)
await pairShot('3-warp-050', 0.5)
await pairShot('3-warp-100', 1)
// ...and the same full-strength warp with the player's Speed-effects control
// at Off. If these two differ by anything, the control does not cover the warp.
await page.evaluate(() => window.__GAME__.post.setIntensity(1, 0))
await pairShot('3-warp-100-screen-off', 1)
await pairShot('3-warp-000-screen-off', 0)
// THE NOISE FLOOR. The sim is frozen but the particle system is not -- it runs
// on render time -- so two shots of the "same" frame are never bit-identical.
// Without this control, "screen off still differs by 1.3 mean levels" cannot be
// told apart from "screen off leaks the warp".
await pairShot('3-warp-000-screen-off-repeat', 0)
await page.evaluate(() => window.__GAME__.post.setIntensity(1, 1))

// REDUCED MOTION, at a sustained boost with no punch. The punch is already
// proven dead by the boost run above (peak dolly 0.000); what these two settle
// is the OTHER channel -- the streak escalation that keys off uBoost, which the
// toggle has no other way of reaching.
await page.evaluate(() => { window.__GAME__.reduceMotion = false })
await pairShot('4-boost-normal', 0)
await page.evaluate(() => { window.__GAME__.reduceMotion = true })
await pairShot('4-boost-reducedmotion', 0)
await pairShot('4-boost-reducedmotion-repeat', 0)
await page.evaluate(() => { window.__GAME__.reduceMotion = false })
await page.evaluate(() => window.__GAME__.post.setIntensity(1, 1))

console.log(`  wrote ${OUT}/${trackId}-3-warp-{000,050,100}.png`)
if (errors.length) console.log('\nconsole errors:\n  ' + errors.slice(0, 6).join('\n  '))
else console.log('\nno console errors')
writeFileSync(join(OUT, `${trackId}-rows.json`), JSON.stringify(rows, null, 1))

await browser.close()
server.close()
