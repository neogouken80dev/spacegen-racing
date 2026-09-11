/**
 * "WHAT DOES THE SKY ACTUALLY LOOK LIKE, AND WHAT DOES IT COST?"
 *
 * Two questions, and the second is the one that decides whether the first
 * matters: the dome has NO DEPTH TEST, so it shades every pixel in the frame
 * before anything else draws. A moon is cheap. Lensing an entire starfield on
 * every one of those pixels is not obviously cheap, and the device floor is an
 * iPhone 12 at 60fps.
 *
 * So this photographs each track's sky from a camera pointed at it, and times
 * the dome in isolation by drawing it at a known resolution with everything
 * else hidden.
 *
 *   node tools/probe-sky.mjs [--track=<id>] [--tier=high|medium|low] [--shots]
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

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1]
const TRACK = arg('track', 'rustfall')
const TIER = arg('tier', 'high')
// `aimed` puts the body dead centre, which answers "does it render"; `level`
// puts the HORIZON at frame centre and looks along the body's azimuth, which
// is the only framing that answers "would a player see it while racing".
const FRAME = arg('frame', 'aimed')
// Which attraction to point at. The default preferred the fleet whenever a
// track had one, so every Rustfall and Aetherion frame was a photograph of
// the ships and the gas giant behind the camera went unlooked-at for a whole
// pass of tuning. Name the target.
const TARGET = arg('target', 'auto')
const NAMES = {
  rustfall: 'Rustfall', cryostatic: 'Cryostatic',
  aetherion: 'Aetherion', hollowchoir: 'Hollow',
}

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
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
await page.goto(url, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(2200)
await page.evaluate(() => { if (window.__GAME__) window.__GAME__.maxSubSteps = 400 })

const clickText = async (pats) => {
  for (const p of pats) {
    const el = page.locator(`text=${p}`).first()
    if (await el.count() && await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 8000 }).catch(() => {}); return true
    }
  }
  return false
}
await clickText(['PLAY NOW', 'PLAY'])
await page.waitForTimeout(1200)
await page.waitForSelector('.sg-screen--track .sg-card--track', { state: 'visible', timeout: 20000 })
const card = page.locator('.sg-screen--track .sg-card--track')
  .filter({ hasText: NAMES[TRACK] ?? 'Rustfall' }).first()
if (await card.count()) { await card.click({ timeout: 8000 }).catch(() => {}) }
await page.waitForTimeout(1400)
await page.locator('.sg-screen--track .sg-btn--start').first().click()
await page.waitForSelector('.sg-screen--garage .sg-btn--start', { state: 'visible', timeout: 20000 })
await page.waitForTimeout(500)
await clickText(['START RACE', 'START'])
await page.waitForTimeout(3200)

// Pin the tier: the adaptive scaler drops to `low` under SwiftShader, and the
// low tier compiles a different sky.
await page.evaluate((t) => {
  const g = window.__GAME__
  g.qualityCooldown = 1e9
  if (g.tier !== t) g.setTier(t)
}, TIER)
await page.waitForTimeout(2500)

const info = await page.evaluate(() => {
  const g = window.__GAME__
  const sky = g.scene.getObjectByName('sky')
  return {
    tier: g.tier,
    trackId: g.race?.state?.trackId ?? g.track?.def?.id,
    found: !!sky,
    defines: sky ? Object.keys(sky.material.defines ?? {}) : [],
    uniforms: sky ? Object.keys(sky.material.uniforms ?? {}).filter((k) => /Body|Ring|Belt|Ship|Hole|Disc|Cel|Band/.test(k)) : [],
  }
})

/**
 * Point the camera AT the declared celestial direction, so the shot is of the
 * sky rather than of whatever the racing line happened to be facing.
 */
const aimed = await page.evaluate(([LEVEL, TARGET]) => {
  const g = window.__GAME__
  const sky = g.scene.getObjectByName('sky')
  const u = sky?.material?.uniforms
  const of = {
    hole: u?.uHoleDir?.value,
    ships: u?.uShipDir?.value,
    body: u?.uBodyDir?.value && u.uBodyDir.value[0],
  }
  const pick = TARGET === 'auto' ? (of.hole ?? of.ships ?? of.body) : of[TARGET]
  if (!pick) return null
  const cam = g.chase.camera
  // STUB THE RIG. The first version of this probe set the camera from an
  // interval and the chase camera simply re-aimed it on the next frame --
  // every shot came out as the ordinary racing view, and the probe reported
  // success because it never checked where the camera ended up. The rig has to
  // be taken out of the loop, not argued with.
  g.chase.update = () => {}
  g.chase.updateCinematic = () => {}
  const V = cam.position.constructor
  const tgt = new V(pick.x, pick.y, pick.z).normalize()
  // Level framing: keep the azimuth, drop the elevation. A body at y = 0.06
  // then lands just above the middle of the frame instead of at its centre,
  // which is where the eye actually is during a race.
  if (LEVEL) {
    const h = Math.hypot(tgt.x, tgt.z) || 1
    tgt.set(tgt.x / h, 0, tgt.z / h)
  }
  // ABOVE THE CAR, not at the world origin. The origin is inside the ice
  // cavern on one track and inside the drum on another, and a shot from in
  // there is a photograph of the inside of a wall -- which is exactly what the
  // first pass of this probe produced, and it reported no errors while doing
  // it because nothing it checked was about what was in the frame.
  const r = g.race.state.racers[0]
  cam.position.set(r.pos.x, r.pos.y + 26, r.pos.z)
  cam.up.set(0, 1, 0)
  cam.lookAt(tgt.clone().multiplyScalar(400))
  cam.updateMatrixWorld(true)
  return { x: +tgt.x.toFixed(3), y: +tgt.y.toFixed(3), z: +tgt.z.toFixed(3) }
}, [FRAME === 'level', TARGET])
await page.waitForTimeout(1600)

await mkdir(new URL('../shots/', import.meta.url).pathname, { recursive: true })
const SUFFIX = (FRAME === 'level' ? '-level' : '') + (TARGET === 'auto' ? '' : `-${TARGET}`)
await page.screenshot({ path: new URL(`../shots/sky-${TRACK}-${TIER}${SUFFIX}.png`, import.meta.url).pathname })
// Prove the camera actually ended up looking where it was told, rather than
// trusting it: this is the exact check whose absence produced a folder of
// screenshots of the road.
const aim = await page.evaluate(() => {
  const cam = window.__GAME__.chase.camera
  cam.updateMatrixWorld(true)
  const f = new (cam.position.constructor)(0, 0, -1).applyQuaternion(cam.quaternion)
  return { x: +f.x.toFixed(3), y: +f.y.toFixed(3), z: +f.z.toFixed(3) }
})
const dot = aimed ? aimed.x * aim.x + aimed.y * aim.y + aimed.z * aim.z : 1
console.log('aim wanted', JSON.stringify(aimed), 'got', JSON.stringify(aim),
  'dot', dot.toFixed(3))
// 0.90 rather than 0.97: on a GRAVITY track the rig's own up is not world +Y,
// and the lookAt here uses +Y, so the roll differs by up to ~20 degrees. The
// shot is still of the sky, which is what this is guarding.
if (aimed && dot < 0.90) errors.push(`camera did not aim at the sky (dot ${dot.toFixed(3)})`)

/**
 * DOES THE FEATURE CHANGE THE PICTURE?
 *
 * Coverage says a feature is geometrically inside the viewport. It does not
 * say a player can see it: the ring covered 23% of the frame and was still
 * invisible, because alpha, colour and the sky behind it decide that and
 * geometry does not. So photograph the frame with the feature on, zero the
 * one uniform that carries it, photograph again, and diff. Pixels that did
 * not move are pixels the feature is not in.
 */
const AB = arg('ab', '')
if (AB) {
  const knob = { ring: ['uRingAxis', 'w'], belt: ['uBeltOpt', 'w'], all: ['uCelGain', null] }[AB]
  if (!knob) throw new Error(`unknown --ab=${AB}`)
  const dir = new URL('../shots/', import.meta.url).pathname
  await page.screenshot({ path: `${dir}ab-${TRACK}-${AB}-on.png` })
  const had = await page.evaluate(([n, f]) => {
    const u = window.__GAME__.scene.getObjectByName('sky').material.uniforms[n]
    if (!u) return null
    const was = f ? u.value[f] : u.value
    if (f) u.value[f] = 0; else u.value = 0
    return was
  }, knob)
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${dir}ab-${TRACK}-${AB}-off.png` })
  await page.evaluate(([n, f, was]) => {
    const u = window.__GAME__.scene.getObjectByName('sky').material.uniforms[n]
    if (f) u.value[f] = was; else u.value = was
  }, [...knob, had])
  console.log(`\n--- A/B ${AB}: shots/ab-${TRACK}-${AB}-{on,off}.png (knob ${knob[0]} was ${had}) ---`)
}

/**
 * IS THE ATTRACTION ACTUALLY IN THE PICTURE?
 *
 * Reading a screenshot answers this for a moon, which is a filled disc you
 * cannot miss. It does not answer it for a RING or a BELT: those are thin,
 * low-contrast and easy to mistake for haze, and twice now a pass of tuning
 * was spent on a ring that was not in the frame at all -- once because the
 * axis had it edge-on, once because the annulus was simply wider than the
 * viewport. Both times the screenshot looked plausible.
 *
 * So: walk a grid of view directions through the REAL camera, run the SAME
 * intersection tests the shader runs against the REAL uniforms, and report
 * what fraction of the frame each feature covers and where its bounding box
 * sits in NDC. A feature at 0% coverage is not subtle, it is absent.
 */
const inFrame = await page.evaluate(() => {
  const g = window.__GAME__
  const sky = g.scene.getObjectByName('sky')
  const u = sky?.material?.uniforms
  // `in`, not truthiness: three.js defines are set to the EMPTY STRING, which
  // is falsy, so `def.SG_RING && ...` skipped every ring and belt test and the
  // first run of this check reported a clean frame by testing nothing.
  const rawDef = sky?.material?.defines ?? {}
  const def = Object.fromEntries(Object.keys(rawDef).map((k) => [k, true]))
  if (!u) return null
  const cam = g.chase.camera
  cam.updateMatrixWorld(true)
  const V3 = cam.position.constructor
  const tanY = Math.tan((cam.fov * Math.PI) / 360)
  const e = cam.matrixWorld.elements
  // Camera basis straight out of the world matrix: right, up, forward.
  const R = new V3(e[0], e[1], e[2]), U = new V3(e[4], e[5], e[6])
  const F = new V3(-e[8], -e[9], -e[10])

  const sub = (a, b) => new V3(a.x - b.x, a.y - b.y, a.z - b.z)
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z
  const mul = (a, k) => new V3(a.x * k, a.y * k, a.z * k)

  const B = u.uBodyDir ? new V3(...['x', 'y', 'z'].map((k) => u.uBodyDir.value[0][k])).normalize() : null
  const sinR = u.uBodyOpt ? u.uBodyOpt.value[0].w : 0

  const NX = 240, NY = 135
  const sun = new V3(u.uSunDir.value.x, u.uSunDir.value.y, u.uSunDir.value.z)
  const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
  const alpha = { ring: 0, belt: 0 }
  // A coarse occupancy grid per feature, printed as ASCII. Coverage and a
  // bounding box do not say WHERE in the frame a thing is -- an annulus and a
  // blob can report the same box -- and "where" is the whole question when a
  // feature is measurably painting and still not visible in the screenshot.
  const GX = 40, GY = 18
  const grid = {}
  const paint = (name, ix, iy, a) => {
    const gr = grid[name] ??= new Float64Array(GX * GY)
    gr[((iy * GY / NY) | 0) * GX + ((ix * GX / NX) | 0)] += a
  }
  const acc = {}
  const hit = (name, nx, ny) => {
    const a = acc[name] ??= { n: 0, x0: 9, x1: -9, y0: 9, y1: -9 }
    a.n++; a.x0 = Math.min(a.x0, nx); a.x1 = Math.max(a.x1, nx)
    a.y0 = Math.min(a.y0, ny); a.y1 = Math.max(a.y1, ny)
  }
  const total = NX * NY
  for (let iy = 0; iy < NY; iy++) {
    const ny = ((iy + 0.5) / NY) * 2 - 1
    for (let ix = 0; ix < NX; ix++) {
      const nx = ((ix + 0.5) / NX) * 2 - 1
      const d = new V3(
        F.x + R.x * nx * tanY * cam.aspect + U.x * ny * tanY,
        F.y + R.y * nx * tanY * cam.aspect + U.y * ny * tanY,
        F.z + R.z * nx * tanY * cam.aspect + U.z * ny * tanY,
      ).normalize()

      if (B && dot(d, B) > u.uBodyDir.value[0].w) { hit('body', nx, ny); paint('body', ix, iy, 1) }

      if (def.SG_RING && B && u.uRingAxis) {
        const A = new V3(u.uRingAxis.value.x, u.uRingAxis.value.y, u.uRingAxis.value.z).normalize()
        const den = dot(d, A), num = dot(B, A)
        if (Math.abs(den) > 1e-4) {
          const k = num / den
          if (k > 0) {
            const rr = sub(mul(d, k), B).length() / Math.max(sinR, 1e-5)
            const inR = u.uRingSpan.value.x, outR = u.uRingSpan.value.y
            if (rr > inR && rr < outR) {
              hit('ring', nx, ny)
              // The shader's OWN alpha, not just the geometric test: gap,
              // taper, edge-on foreshortening and the horizon fade all
              // multiply into it, and any one of them at zero is a ring that
              // passes the geometry and paints nothing.
              const gg = (rr - inR) / Math.max(outR - inR, 1e-3)
              const gap = sstep(0.02, 0.09, Math.abs(gg - 0.42))
              const fine = 0.72 + 0.28 * Math.sin(gg * 46)
              const edge = sstep(0, 0.06, gg) * (1 - sstep(0.94, 1, gg))
              const open = Math.min(1, Math.max(0.12, Math.abs(den) * 3.4))
              const cf = sstep(-0.012, 0.062, d.y) * (1 - 0.92 * Math.pow(Math.max(dot(d, sun), 0), 24))
              const ra = u.uRingAxis.value.w * gap * fine * edge * open * cf
              alpha.ring += ra
              paint('ring', ix, iy, ra)
            }
          }
        }
      }

      if (def.SG_BELT && u.uBeltAxis) {
        const A = new V3(u.uBeltAxis.value.x, u.uBeltAxis.value.y, u.uBeltAxis.value.z).normalize()
        const ca = dot(d, A)
        const band = 1 - sstep(0, u.uBeltOpt.value.x, Math.abs(ca - u.uBeltAxis.value.w))
        if (band > 0.001) {
          hit('belt', nx, ny)
          const cf = sstep(-0.012, 0.062, d.y) * (1 - 0.92 * Math.pow(Math.max(dot(d, sun), 0), 24))
          const ba = band * u.uBeltOpt.value.w * cf
          alpha.belt += ba
          paint('belt', ix, iy, ba)
        }
      }

      if (def.SG_SHIPS && u.uShipDir) {
        const S = new V3(u.uShipDir.value.x, u.uShipDir.value.y, u.uShipDir.value.z).normalize()
        if (Math.acos(Math.min(1, dot(d, S))) < u.uShipDir.value.w) hit('fleet', nx, ny)
      }

      if (def.SG_HOLE && u.uHoleDir) {
        const H = new V3(u.uHoleDir.value.x, u.uHoleDir.value.y, u.uHoleDir.value.z).normalize()
        if (Math.acos(Math.min(1, dot(d, H))) < u.uHoleDir.value.w * u.uHoleOpt.value.y) hit('disc', nx, ny)
      }
    }
  }
  const out = {}
  for (const [k, a] of Object.entries(acc)) {
    out[k] = {
      cover: +((a.n / total) * 100).toFixed(1),
      ndc: [a.x0, a.y0, a.x1, a.y1].map((v) => +v.toFixed(2)),
    }
  }
  out.ring && (out.ring.meanAlpha = +(alpha.ring / (out.ring.cover / 100 * total)).toFixed(3))
  out.belt && (out.belt.meanAlpha = +(alpha.belt / (out.belt.cover / 100 * total)).toFixed(3))
  const cells = (NX / GX) * (NY / GY)
  const maps = {}
  for (const [k, gr] of Object.entries(grid)) {
    // Row 0 of the grid is ny = -1, the BOTTOM of the frame, so print it last.
    // Unflipped, the first read of this map put the ring above the planet when
    // it was actually below it, and the tuning that followed chased the wrong
    // half of the sky.
    maps[k] = Array.from({ length: GY }, (_, j) => Array.from({ length: GX }, (_, i) =>
      ' .:-=+*#@'[Math.min(8, Math.round((gr[(GY - 1 - j) * GX + i] / cells) * 10))]).join(''))
  }
  return { maps, fovY: +cam.fov.toFixed(1), fovX: +(2 * Math.atan(tanY * cam.aspect) * 180 / Math.PI).toFixed(1), features: out }
})
if (inFrame) {
  console.log(`\n--- in frame (fov ${inFrame.fovX} x ${inFrame.fovY} deg) ---`)
  for (const [k, v] of Object.entries(inFrame.features)) {
    const al = v.meanAlpha === undefined ? '' : `   mean alpha ${v.meanAlpha}`
    console.log(`  ${k.padEnd(6)} ${String(v.cover).padStart(5)}% of frame   ndc [${v.ndc.join(', ')}]${al}`)
  }
  for (const [k, rows] of Object.entries(inFrame.maps ?? {})) {
    console.log(`  ${k}:`)
    for (const r of rows) console.log(`    |${r}|`)
  }
  for (const want of ['ring', 'belt']) {
    const f = inFrame.features[want]
    if (f && f.cover < 0.2) errors.push(`${want} is declared but covers ${f.cover}% of the frame`)
    else if (f && f.meanAlpha < 0.08) {
      // Not an error on its own: a belt is a great circle and a given view
      // azimuth can legitimately catch it below the eye line. It IS an error
      // for a ring, which orbits the body this shot is pointed at.
      const msg = `${want} covers ${f.cover}% of this view but paints at mean alpha ${f.meanAlpha}`
      if (want === 'ring') errors.push(msg); else console.log(`  NOTE: ${msg}`)
    }
  }
}

/**
 * REDUCED MOTION MUST FREEZE THE DRIFT.
 *
 * The celestial clock is accumulated in environment.ts rather than taken from
 * the race clock, precisely so this works -- and a thing that is only correct
 * because of a design decision nobody re-checks is a thing that breaks.
 */
const rm = await page.evaluate(async () => {
  const g = window.__GAME__
  const sky = g.scene.getObjectByName('sky')
  const u = sky?.material?.uniforms?.uCelTime
  if (!u) return null
  const read = () => u.value
  // WAIT ON FRAMES, NOT ON A CLOCK. This check used to sleep 900ms and read
  // the delta, and on the slowest track it reported a celestial clock frozen
  // solid -- the sky was fine and requestAnimationFrame had simply not fired
  // once in the window, because the block before this one hammers the GPU
  // synchronously and starves the loop. A wall-clock wait measures the
  // machine; a frame wait measures the thing under test.
  const wait = (n) => new Promise((res) => {
    let left = n
    const step = () => (--left <= 0 ? res() : requestAnimationFrame(step))
    requestAnimationFrame(step)
  })
  g.reduceMotion = false
  await wait(20)
  const a = read(); await wait(20); const b = read()
  g.reduceMotion = true
  await wait(20)
  const c = read(); await wait(20); const d = read()
  g.reduceMotion = false
  // If the clock did not move, say WHY rather than just that it did not: a
  // hand-driven update isolates "the game never calls this" from "the call
  // happens and the clock is gated off", and the uniform identity check
  // isolates "the closure is writing a uniform the material no longer uses",
  // which is what a tier change can leave behind.
  let why = null
  if (b - a <= 0.05) {
    const before = read()
    g.envVis?.update(0.25, performance.now() / 1000, g.chase.camera.position, {
      push: 0, right: { x: 1, y: 0, z: 0 }, reduceMotion: false,
    })
    // Count the game's OWN calls into the environment over a window, and the
    // dt it hands over. A clock that moves when driven by hand and not when
    // the game runs is either never called or called with dt 0, and those are
    // different bugs.
    const seen = { calls: 0, dt: 0, raf: 0 }
    const counts = {}
    const restore = []
    // Instrument the whole per-frame visual chain in the order main.ts calls
    // it. The step that stops being called is the step after the one that
    // throws, and a chain of counts says which without guessing.
    for (const name of ['entityVis', 'vfx', 'trackVis', 'envVis']) {
      const o = g[name]
      if (!o || typeof o.update !== 'function') { counts[name] = 'absent'; continue }
      const real = o.update.bind(o)
      counts[name] = 0
      restore.push(() => { o.update = real })
      o.update = (...a) => { counts[name]++; return real(...a) }
    }
    const ev = g.envVis
    const realEv = ev.update
    ev.update = (dt2, ...rest) => { seen.calls++; seen.dt += dt2; return realEv(dt2, ...rest) }
    let stop = false
    const tick = () => { seen.raf++; if (!stop) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    await wait(24)
    stop = true
    for (const f of restore) f()
    why = {
      gameCalls: seen.calls,
      rafFrames: seen.raf,
      chain: counts,
      // The guard on the whole per-frame visual block in main.ts. If this is
      // false nothing in it runs -- entity visuals, track visuals and the sky
      // clock all stop together -- and the sky is not the bug.
      guard: {
        hasRace: !!g.race,
        renderRacers: g.renderRacers?.length ?? -1,
        simRacers: g.race?.state?.racers?.length ?? -1,
        phase: g.phase ?? null,
        simPhase: g.race?.state?.phase ?? null,
      },
      gameDt: +seen.dt.toFixed(3),
      handDriven: +(read() - before).toFixed(4),
      gameReduceMotion: !!g.reduceMotion,
      hasEnvVis: !!g.envVis,
      sameUniformObject: g.scene.getObjectByName('sky').material.uniforms.uCelTime === u,
    }
  }
  return { moving: +(b - a).toFixed(4), frozen: +(d - c).toFixed(4), why }
})
if (rm) {
  console.log(`\n--- reduced motion ---`)
  console.log(`  clock advance, motion on:  ${rm.moving}`)
  console.log(`  clock advance, motion off: ${rm.frozen}`)
  if (rm.why) console.log('  why:', JSON.stringify(rm.why))
  if (rm.moving <= 0.05) errors.push('the celestial clock never advanced at all')
  if (rm.frozen > 0.02) errors.push(`reduced motion did not freeze the sky (${rm.frozen})`)
}

/**
 * WHAT THE CELESTIAL LAYER COSTS, per pixel of sky.
 *
 * The dome has NO DEPTH TEST and renders first, so it shades every pixel in
 * the frame before anything else draws -- which makes it the one place in this
 * renderer where a few extra instructions are multiplied by the entire
 * viewport. Lensing in particular is an acos and a normalize on every one of
 * those pixels.
 *
 * Measured as a DIRECT A/B on the same dome, same scene, same frame: render
 * the sky alone N times with the shipped material, then N times with a clone
 * whose celestial defines have been stripped, and difference the two. That is
 * the only comparison that isolates the layer -- comparing two tracks compares
 * two scenes, and comparing uCelGain 0 against 1 compares nothing at all,
 * because a zeroed gain still executes every instruction.
 */
const cost = await page.evaluate(async () => {
  const g = window.__GAME__
  const THREE_ = g.chase.camera.constructor
  void THREE_
  const sky = g.scene.getObjectByName('sky')
  if (!sky) return null
  const r = g.renderer
  const cam = g.chase.camera

  // Sky alone: everything else off, so the number is the dome and nothing else.
  const hidden = []
  g.scene.traverse((o) => {
    if (o !== sky && o !== g.scene && o.visible && o.type !== 'Group') {
      hidden.push(o); o.visible = false
    }
  })

  const time = async (mat) => {
    const was = sky.material
    sky.material = mat
    // Warm up: first draw with a new program compiles it.
    for (let i = 0; i < 12; i++) { r.render(g.scene, cam); r.getContext().finish?.() }
    await new Promise((res) => setTimeout(res, 80))
    const N = 40
    const t0 = performance.now()
    // finish() after EVERY render: WebGL is asynchronous and a bare loop of
    // draw calls measures command submission, not execution.
    for (let i = 0; i < N; i++) { r.render(g.scene, cam); r.getContext().finish?.() }
    const ms = (performance.now() - t0) / N
    sky.material = was
    return ms
  }

  const full = sky.material
  const bare = full.clone()
  bare.defines = Object.fromEntries(
    Object.entries(full.defines ?? {}).filter(([k]) => !/^SG_(BODIES|RING|BELT|SHIPS|HOLE|RICH|LENS|DISC)$/.test(k)),
  )
  bare.uniforms = full.uniforms
  bare.needsUpdate = true

  // WARM BOTH PROGRAMS BEFORE TIMING EITHER.
  //
  // The first measurement of this had the bare material at 39.5ms against the
  // full one at 0.17ms -- a shader COMPILE sitting inside the timed window,
  // and a number that says the layer costs negative forty milliseconds. Warm
  // each program to completion first, then interleave the measurements so a
  // drift in the driver's state shows up as disagreement between the two
  // readings of the same material rather than as a result.
  await time(full); await time(bare)
  const withCel = await time(full)
  const without = await time(bare)
  const again = await time(full)
  bare.dispose()
  for (const o of hidden) o.visible = true
  return {
    withCelMs: +withCel.toFixed(3),
    withoutMs: +without.toFixed(3),
    repeatMs: +again.toFixed(3),
    pixels: r.domElement.width * r.domElement.height,
  }
})

if (cost) {
  const d = cost.withCelMs - cost.withoutMs
  const noise = Math.abs(cost.repeatMs - cost.withCelMs)
  console.log(`\n--- dome cost, ${cost.pixels} px, sky alone ---`)
  console.log(`  with celestial   ${cost.withCelMs.toFixed(3)} ms`)
  console.log(`  without          ${cost.withoutMs.toFixed(3)} ms`)
  console.log(`  repeat (noise)   ${cost.repeatMs.toFixed(3)} ms  -> +/-${noise.toFixed(3)}`)
  console.log(`  CELESTIAL COSTS  ${d >= 0 ? '+' : ''}${d.toFixed(3)} ms/frame`)
  /**
   * AND HOW MUCH TO BELIEVE IT.
   *
   * This container renders through SwiftShader, in software, on the CPU. Two
   * things follow and both are visible in the numbers above: 0.07 ms to shade
   * 921,600 pixels is not possible in software, so finish() is not forcing
   * execution and what is being timed is largely command submission; and the
   * repeat reading of the SAME material disagrees with the first by about as
   * much as the celestial layer appears to cost.
   *
   * So this is a SANITY CHECK, not a budget. What it can honestly say is that
   * the ordering is stable and the layer is not catastrophic. What bounds the
   * real cost is structural, not measured here:
   *   - every subject is behind its own #ifdef, so a track compiles only what
   *     it declares;
   *   - the tier gating is compile-time, so Low never runs lensing, the belt
   *     or the ring at all, and SG_RICH keeps banding, mottling and the photon
   *     ring off everything below High;
   *   - the body loop rejects on one dot product, which is the branch ~99% of
   *     sky pixels take.
   * A real budget needs a real GPU, and that means Vince's machine.
   */
  if (noise >= Math.abs(d)) {
    console.log('  ^ WITHIN THE NOISE FLOOR. Software rendering; see the note in this probe.')
  }
}

console.log(`\n=== SKY: ${TRACK} @ ${TIER} ===`)
console.log(JSON.stringify(info, null, 2))
console.log('errors:', errors.length, errors.slice(0, 2))
await browser.close(); server.close()
process.exit(errors.length ? 1 : 0)
