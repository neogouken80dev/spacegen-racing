/**
 * THE TITLE-SCREEN PLATE, SHOT IN-ENGINE.
 *
 * The brief is "a good representation of the game", and the most honest
 * representation of a game is a frame of it. Everything this needs already
 * exists and is already art-passed -- the celestial skies, the drift ribbons
 * and sparks, the chassis, the track -- so the job here is not to draw
 * anything. It is to put a camera somewhere the chase rig never goes, freeze a
 * moment the race never holds, and take the picture at a resolution the game
 * never runs at.
 *
 * Three things a normal frame will not give you and this has to force:
 *
 *   1. A LOW CAMERA BESIDE THE CAR. The chase rig lives 9m behind and 3.6m up
 *      and re-aims every frame, so it has to be stubbed out, not argued with
 *      -- the same lesson probe-sky.mjs learned.
 *   2. A DRIFT THAT IS ALREADY UNDER WAY. Drift VFX are driven off sim state,
 *      so the state is set directly and the sim is then stepped a few frames
 *      to let the ribbons, sparks and plume BUILD. A drift set on the shutter
 *      frame photographs as a car with nothing coming off it.
 *   3. NO HUD. Explicitly hidden rather than cropped: the brief is a
 *      background plate with no text in it.
 *
 *   node tools/shot-splash.mjs [--track=rustfall] [--w=2560] [--h=1440]
 *                              [--tag=a] [--yaw=...] [--dist=...] [--height=...]
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { join, extname } from 'node:path'

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1]
const num = (k, d) => Number(arg(k, String(d)))
const TRACK = arg('track', 'rustfall')
const W = num('w', 1600)
const H = num('h', 900)
const TAG = arg('tag', 'a')
/** Where the camera sits relative to the car, in the CAR's own frame. */
const SIDE = num('side', 5.2)      // +right of the car
const BACK = num('back', 3.4)      // behind it
const RISE = num('height', 0.62)   // above the road -- deliberately knee-high
const AIMF = num('aim', 22)        // how far ahead of the car it looks
const AIMU = num('aimup', 2.1)     // and how far above that point
const FOV = num('fov', 58)
const SPINS = num('spin', 0)       // extra yaw applied to the car, radians

const NAMES = { rustfall: 'Rustfall', cryostatic: 'Cryostatic', aetherion: 'Aetherion', hollowchoir: 'Hollow' }
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
  viewport: { width: W, height: H }, deviceScaleFactor: 1,
})).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

await page.goto(url, { waitUntil: 'load', timeout: 60000 })
await page.waitForTimeout(2600)
await page.evaluate(() => { if (window.__GAME__) window.__GAME__.maxSubSteps = 400 })

const clickText = async (pats) => {
  for (const p of pats) {
    const el = page.locator(`text=${p}`).first()
    if (await el.count() && await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 10000 }).catch(() => {}); return true
    }
  }
  return false
}
await clickText(['PLAY NOW', 'PLAY'])
await page.waitForTimeout(1400)
await page.waitForSelector('.sg-screen--track .sg-card--track', { state: 'visible', timeout: 25000 })
const card = page.locator('.sg-screen--track .sg-card--track')
  .filter({ hasText: NAMES[TRACK] ?? 'Rustfall' }).first()
if (await card.count()) await card.click({ timeout: 10000 }).catch(() => {})
await page.waitForTimeout(1400)
await page.locator('.sg-screen--track .sg-btn--start').first().click()
await page.waitForSelector('.sg-screen--garage .sg-btn--start', { state: 'visible', timeout: 25000 })
await page.waitForTimeout(600)
await clickText(['START RACE', 'START'])
await page.waitForTimeout(4500)

// Highest quality, and hold it: the adaptive scaler drops tiers under
// SwiftShader and a title plate must not be shot at the low tier.
await page.evaluate(() => {
  const g = window.__GAME__
  g.qualityCooldown = 1e9
  if (g.tier !== 'high') g.setTier('high')
})
await page.waitForTimeout(2600)

/** Wait on SIM time, never the wall clock: this renders at a few fps. */
const simNow = () => page.evaluate(() => window.__GAME__?.race?.state?.time ?? -1)
async function waitSim(sec, capMs = 120000) {
  const t0 = await simNow()
  const w0 = Date.now()
  for (;;) {
    const t = await simNow()
    if (t < 0 || t >= t0 + sec) return t
    if (Date.now() - w0 > capMs) return t
    await page.waitForTimeout(120)
  }
}
/**
 * WAIT FOR A MOMENT WORTH PHOTOGRAPHING, rather than a fixed number of
 * seconds. Two conditions, both measured:
 *
 *   speed   -- a title plate about speed cannot be shot at 10 m/s, which is
 *              what a fixed 6-second wait actually produced (the field is
 *              still accelerating out of the grid).
 *   heading -- the sky's hero body sits at one fixed azimuth, so whether it is
 *              in the picture depends entirely on which way the car happens to
 *              be pointing. Waiting for the car to face it is the difference
 *              between a splash screen with a ringed gas giant in it and one
 *              with a wall.
 */
const framed = await (async () => {
  for (let i = 0; i < 300; i++) {
    const st = await page.evaluate(() => {
      const g = window.__GAME__
      // THE SUBJECT IS AN AI CAR. The local racer is player-controlled and
      // this harness sends no input, so it rolls off the line and stops --
      // measured at 10 m/s on the first attempt and 0 on the second. The AI
      // cars are actually racing.
      const st0 = g.race?.state
      const r = st0?.racers?.find((x) => x.isAI && !x.finished && x.spinTime <= 0)
      const sky = g.scene?.getObjectByName?.('sky')
      const u = sky?.material?.uniforms
      const b = u?.uBodyDir?.value?.[0] ?? u?.uHoleDir?.value ?? u?.uShipDir?.value
      if (!r || !b) return null
      const h = Math.hypot(b.x, b.z) || 1
      const bx = b.x / h, bz = b.z / h
      const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw)
      return {
        speed: Math.hypot(r.vel.x, r.vel.z),
        align: fx * bx + fz * bz,
        t: g.race.state.time,
        id: r.id,
      }
    })
    if (!st) return null
    // Relaxed from 0.80 after a run that searched 28s of race and never met
    // it: the hero body sits at ONE azimuth and a lap only points at it for a
    // fraction of its length. 0.70 is about 45 degrees, which still puts the
    // body inside a 60-degree-FOV frame.
    if (st.speed > 35 && st.align > 0.70) return st
    await waitSim(0.2)
  }
  return null
})()
console.log('framed:', JSON.stringify(framed))
if (!framed) errors.push('never found a fast frame pointed at the sky body')

const staged = await page.evaluate(({ SIDE, BACK, RISE, AIMF, AIMU, FOV, SPINS }) => {
  const g = window.__GAME__
  const st = g.race.state
  const r = st.racers.find((x) => x.isAI && !x.finished && x.spinTime <= 0)
  if (!r) return null
  window.__SPLASH_ID__ = r.id

  // No HUD, no touch controls, no countdown: a background plate carries no UI.
  for (const sel of ['.sg-hud', '.sg-touch', '.sg-tools', '.sg-fe']) {
    for (const el of document.querySelectorAll(sel)) el.style.display = 'none'
  }

  /**
   * A DRIFT THAT IS ALREADY RUNNING. The VFX read sim state, and ribbons,
   * sparks and the plume all BUILD over time -- so this sets the state and the
   * caller then steps the sim before the shutter. Tier 3 is the Singularity,
   * the brightest the ladder goes.
   */
  r.driftSide = 1
  r.driftCharge = 1
  r.driftTier = 2
  r.driftTime = 2.2
  if (SPINS) r.yaw += SPINS

  /**
   * NO BOOST. The first attempt set boostTime and boostMag to get "speed" into
   * the picture and got the opposite: the tunnel-vision warp and the dolly
   * zoom drove the composite to a radial whiteout with a car somewhere inside
   * it. Speed here comes from the drift -- ribbons, sparks, the plume and a
   * car visibly sideways -- which is what the brief actually asked for.
   *
   * The camera's warp and dolly are state, not a per-frame value, so stubbing
   * chase.update does not clear them. Zeroed explicitly.
   */
  r.boostTime = 0
  r.boostMag = 0
  r.boostSource = 'none'
  g.chase.warp = 0
  g.chase.dolly = 0
  g.chase.shake = 0
  if (g.vfx) g.vfx.boostIntensity = 0

  // STUB THE RIG, do not argue with it: it re-aims every frame.
  g.chase.update = () => {}
  g.chase.updateCinematic = () => {}

  const cam = g.chase.camera
  cam.fov = FOV
  cam.updateProjectionMatrix()

  const V = cam.position.constructor
  const up = g.track?.def?.hasGravity ? r.up : { x: 0, y: 1, z: 0 }
  const f = new V(Math.sin(r.yaw), 0, Math.cos(r.yaw)).normalize()
  // right = forward x up, the convention the whole repo shares.
  const rt = new V().crossVectors(f, new V(up.x, up.y, up.z)).normalize()

  cam.position.set(
    r.pos.x + rt.x * SIDE - f.x * BACK + up.x * RISE,
    r.pos.y + rt.y * SIDE - f.y * BACK + up.y * RISE,
    r.pos.z + rt.z * SIDE - f.z * BACK + up.z * RISE,
  )
  cam.up.set(up.x, up.y, up.z)
  cam.lookAt(
    r.pos.x + f.x * AIMF + up.x * AIMU,
    r.pos.y + f.y * AIMF + up.y * AIMU,
    r.pos.z + f.z * AIMF + up.z * AIMU,
  )
  cam.updateMatrixWorld(true)
  return { x: +r.pos.x.toFixed(1), z: +r.pos.z.toFixed(1), speed: +Math.hypot(r.vel.x, r.vel.z).toFixed(1) }
}, { SIDE, BACK, RISE, AIMF, AIMU, FOV, SPINS })
console.log('staged:', JSON.stringify(staged))
if (!staged) errors.push('could not reach the local racer')

/**
 * LET THE EFFECTS BUILD, then re-pin the camera. The sim keeps running while
 * the ribbons and plume fill in, which moves the car -- so the rig is placed
 * again on the frame before the shutter rather than once at the start.
 */
for (let i = 0; i < 5; i++) {
  await waitSim(0.12)
  await page.evaluate(({ SIDE, BACK, RISE, AIMF, AIMU }) => {
    const g = window.__GAME__
    const r = g.race.state.racers[window.__SPLASH_ID__ ?? 0]
    if (!r) return
    r.driftSide = 1; r.driftCharge = 1; r.driftTier = 2; r.driftTime = 2.2
    r.boostTime = 0; r.boostMag = 0; r.boostSource = 'none'
    g.chase.warp = 0; g.chase.dolly = 0; g.chase.shake = 0
    if (g.vfx) g.vfx.boostIntensity = 0
    const cam = g.chase.camera
    const V = cam.position.constructor
    const up = g.track?.def?.hasGravity ? r.up : { x: 0, y: 1, z: 0 }
    const f = new V(Math.sin(r.yaw), 0, Math.cos(r.yaw)).normalize()
    const rt = new V().crossVectors(f, new V(up.x, up.y, up.z)).normalize()
    cam.position.set(
      r.pos.x + rt.x * SIDE - f.x * BACK + up.x * RISE,
      r.pos.y + rt.y * SIDE - f.y * BACK + up.y * RISE,
      r.pos.z + rt.z * SIDE - f.z * BACK + up.z * RISE,
    )
    cam.up.set(up.x, up.y, up.z)
    cam.lookAt(
      r.pos.x + f.x * AIMF + up.x * AIMU,
      r.pos.y + f.y * AIMF + up.y * AIMU,
      r.pos.z + f.z * AIMF + up.z * AIMU,
    )
    cam.updateMatrixWorld(true)
  }, { SIDE, BACK, RISE, AIMF, AIMU })
}

/**
 * FREEZE BEFORE THE SHUTTER.
 *
 * The camera was being placed correctly and the car was still ending up a
 * speck in the middle distance, because the sim keeps running while
 * page.screenshot() encodes -- and at 56 m/s a car covers thirty metres in the
 * time that takes. The rig was pinned to where the car HAD been.
 *
 * Stopping the sim rather than the renderer: the last frame still draws, the
 * ribbons and sparks that were built above stay exactly where they were, and
 * nothing moves between the camera being placed and the picture being taken.
 */
await page.evaluate(() => {
  const g = window.__GAME__
  g.race.step = () => {}
  if (g.vfx) g.vfx.update = () => {}
})
await page.waitForTimeout(400)

// Place the rig one last time, now that nothing can move afterwards.
await page.evaluate(({ SIDE, BACK, RISE, AIMF, AIMU, FOV }) => {
  const g = window.__GAME__
  const r = g.race.state.racers[window.__SPLASH_ID__ ?? 0]
  if (!r) return
  const cam = g.chase.camera
  cam.fov = FOV
  cam.updateProjectionMatrix()
  const V = cam.position.constructor
  const up = g.track?.def?.hasGravity ? r.up : { x: 0, y: 1, z: 0 }
  const f = new V(Math.sin(r.yaw), 0, Math.cos(r.yaw)).normalize()
  const rt = new V().crossVectors(f, new V(up.x, up.y, up.z)).normalize()
  cam.position.set(
    r.pos.x + rt.x * SIDE - f.x * BACK + up.x * RISE,
    r.pos.y + rt.y * SIDE - f.y * BACK + up.y * RISE,
    r.pos.z + rt.z * SIDE - f.z * BACK + up.z * RISE,
  )
  cam.up.set(up.x, up.y, up.z)
  cam.lookAt(
    r.pos.x + f.x * AIMF + up.x * AIMU,
    r.pos.y + f.y * AIMF + up.y * AIMU,
    r.pos.z + f.z * AIMF + up.z * AIMU,
  )
  cam.updateMatrixWorld(true)
}, { SIDE, BACK, RISE, AIMF, AIMU, FOV })
await page.waitForTimeout(900)

await mkdir(new URL('../shots/', import.meta.url).pathname, { recursive: true })
const out = new URL(`../shots/splash-${TRACK}-${TAG}-${W}x${H}.png`, import.meta.url).pathname
await page.screenshot({ path: out })
console.log('wrote', out.split('/').pop())
console.log(`errors: ${errors.length}`, errors.slice(0, 3))

await browser.close()
server.close()
process.exit(0)
