/**
 * SECTION PHOTOGRAPHS.
 *
 * `tools/smoke.mjs` photographs the first few seconds of a race, which is the
 * right thing for "does the game boot and render", and the wrong thing for
 * "does the road I just moved still have ground under it". A node moved at 55%
 * of the lap is not in any smoke shot, and a hole in the world is not visible
 * in a number.
 *
 * So: teleport the local racer to a list of arc-length positions, let the sim
 * settle at each one, and photograph. Everything except the teleport is the
 * shipping path -- the same Track, the same environment mesh, the same camera.
 *
 *   node tools/probe-shots.mjs --track=cryostatic --at=1550,1600,1650 [--mobile]
 *
 * PHONES ARE TWO DIFFERENT LAYOUT PROBLEMS. `--mobile` is a 412x915 PORTRAIT
 * frame; `--landscape` is the same phone turned over, 915x412, which is how the
 * game is actually played and where the vertical budget for the bottom HUD band
 * collapses to almost nothing. `--landscape` implies `--mobile`. Both emulate a
 * real coarse pointer (hasTouch/isMobile), so the on-screen touch controls and
 * the compact HUD are in the photograph rather than the desktop layout wearing
 * a phone-sized window.
 *
 * TIMED HAZARDS NEED A THIRD AXIS. Aetherion's causeway looks completely
 * different at four points of one 3.2 s beat -- both halves solid, one half
 * flashing, one half gone, back to solid -- and "teleport there and wait 1.2 s"
 * lands on whichever of those the wall clock happened to hand over. `--u=` sets
 * the race time so a NAMED span sits at a named fraction of its own cycle,
 * which is the same number `bridgeSolid` and the shaders both read, so the
 * photograph is of a state the sim can name.
 *
 *   node tools/probe-shots.mjs --track=aetherion --at=700 --u=0.50,0.62,0.80
 *   node tools/probe-shots.mjs --track=aetherion --at=700 --u=0.62 --lat=-8
 *
 * `--lat=` parks the car off the centreline, which for a half-span hazard is
 * the whole question: the shot that matters is the one taken from the surviving
 * lane looking at the half that is going.
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { extname, join } from 'node:path'

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const trackId = arg('track', 'rustfall')
const positions = arg('at', '0').split(',').map(Number)
/** Cycle fractions to photograph each position at, or [null] for "whenever". */
const cycles = process.argv.some((a) => a.startsWith('--u='))
  ? arg('u', '0').split(',').map(Number)
  : [null]
const LAT = Number(arg('lat', '0'))
const LANDSCAPE = process.argv.includes('--landscape')
const MOBILE = LANDSCAPE || process.argv.includes('--mobile')
const VIEWPORT = LANDSCAPE
  ? { width: 915, height: 412 }
  : MOBILE ? { width: 412, height: 915 } : { width: 1440, height: 810 }
const KIND = LANDSCAPE ? 'mobilels' : MOBILE ? 'mobile' : 'desktop'
const OUT = join('shots', 'sections')
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }
const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  const path = join('dist', url === '/' ? 'index.html' : url.slice(1))
  if (!existsSync(path)) { res.writeHead(404); res.end('nope'); return }
  res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' })
  res.end(readFileSync(path))
})
await new Promise((r) => server.listen(4178, r))

const browser = await chromium.launch({
  // Same pinned build tools/smoke.mjs uses; the sandbox has no browser download.
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
// A context rather than a bare page: `hasTouch` is what makes the game's own
// coarse-pointer detection fire, and without it a phone-sized window still gets
// the keyboard layout with no touch controls in the shot.
const ctx = await browser.newContext({
  viewport: VIEWPORT,
  hasTouch: MOBILE,
  isMobile: MOBILE,
  deviceScaleFactor: 1,
})
const page = await ctx.newPage()

/**
 * `--tiltprompt` reproduces the iOS pre-permission state.
 *
 * Headless Chromium exposes DeviceOrientationEvent but never fires one, so the
 * real code path here is: arm the sensor -> nothing arrives in 1.5 s -> fall
 * back to the floating stick. That is a legitimate state, but it is NOT the one
 * the tilt hint lives in. On iOS the sensor is behind
 * DeviceOrientationEvent.requestPermission(), which must be called from inside a
 * user gesture, so the game stays on the tilt scheme with tilt inactive and the
 * hint up until the player taps it. Stubbing requestPermission to reject the way
 * Safari does outside a gesture puts the build in exactly that state, through
 * the shipping code path, rather than by poking dataset attributes.
 */
if (process.argv.includes('--tiltprompt')) {
  await page.addInitScript(() => {
    const D = window.DeviceOrientationEvent
    if (D) D.requestPermission = () => Promise.reject(new Error('requires a user gesture'))
  })
}
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(String(e)))

await page.goto('http://localhost:4178/', { waitUntil: 'networkidle' })
await page.evaluate(() => { if (window.__GAME__) window.__GAME__.maxSubSteps = 400 })

// Front end: PLAY -> pick the track -> garage -> start. Same selectors as
// tools/smoke.mjs, because this has to walk the shipping front end too.
const clickText = async (labels) => {
  for (const t of labels) {
    const el = page.locator('button, .sg-btn').filter({ hasText: t }).first()
    if (await el.count() && await el.isVisible().catch(() => false)) { await el.click(); return }
  }
}
await clickText(['PLAY NOW', 'PLAY', 'Play'])
await page.waitForSelector('.sg-screen--track .sg-card--track', { state: 'visible', timeout: 20000 })
const NAME = { rustfall: 'Rustfall', cryostatic: 'Cryostatic', aetherion: 'Aetherion Prime' }[trackId] ?? trackId
await page.locator('.sg-screen--track .sg-card--track').filter({ hasText: NAME }).first().click()
await page.waitForTimeout(1400)
await page.locator('.sg-screen--track .sg-btn--start').click()
await page.waitForSelector('.sg-screen--garage .sg-btn--start', { state: 'visible', timeout: 20000 })
await page.locator('.sg-screen--garage .sg-btn--start').click()
await page.waitForTimeout(4000)

// Countdown out of the way.
await page.evaluate(() => {
  const g = window.__GAME__
  if (g && g.race) { g.race.state.countdown = 0; g.race.state.phase = 'racing' }
})

/**
 * Wait on SIM time, never on the clock.
 *
 * Under SwiftShader the page runs at 1-5 fps and `game/main.ts` clamps a frame
 * to 0.25 s of simulation, so a wall-clock `waitForTimeout(900)` can be a
 * single sim step -- the car has not landed, the camera has not caught up, and
 * the photograph is of a settling frame rather than a settled one.
 */
async function waitSim(seconds, capMs = 60000) {
  const now = () => page.evaluate(() => window.__GAME__?.race?.state?.time ?? 0)
  const start = await now()
  const t0 = Date.now()
  while (Date.now() - t0 < capMs) {
    if ((await now()) - start >= seconds) return
    await page.waitForTimeout(120)
  }
}
await waitSim(0.5)

const report = []
for (const s of positions) {
  // ONE teleport and ONE settle per position, then the cycle values are shot
  // against a FROZEN sim. Four photographs of one hazard are only comparable if
  // the camera is in the same place in all four, and re-settling between them
  // put it somewhere different each time -- the settle runs on wall-clock
  // frames and this renderer delivers between one and five of them a second.
  const info = await page.evaluate(([sAt, lat]) => {
    const g = window.__GAME__
    const track = g.track
    const st = g.race.state
    const me = st.racers.find((r) => r.isLocal) ?? st.racers[0]
    const smp = track.at(sAt)
    const p = track.surfacePoint(sAt, lat)
    me.pos.x = p.x; me.pos.y = p.y + 1.2; me.pos.z = p.z
    me.splineS = sAt; me.totalS = sAt; me.lateral = lat
    me.yaw = Math.atan2(smp.tangent.x, smp.tangent.z)
    me.vel.x = smp.tangent.x * 18; me.vel.z = smp.tangent.z * 18
    me.vertVel = 0; me.driftSide = 0; me.spinTime = 0; me.respawnTime = 0
    // THE SURFACE BASIS, WHICH IS NOT OPTIONAL ON A GRAVITY TRACK. `yaw` is the
    // whole orientation only where the road is level; on Aetherion the camera
    // builds its frame from `fwd` and `up`, and a teleport that left those alone
    // put the car at the causeway with the start straight's basis still on it.
    // Every shot came out yawed off the road -- far enough that the centreline
    // 60 m ahead projected outside the frame -- while the report said the
    // teleport had worked, because the teleport HAD worked and the camera had
    // not. Set the basis with the position.
    me.fwd.x = smp.tangent.x; me.fwd.y = smp.tangent.y; me.fwd.z = smp.tangent.z
    me.up.x = smp.normal.x; me.up.y = smp.normal.y; me.up.z = smp.normal.z
    me.vel.y = smp.tangent.y * 18
    // Park the rest of the field elsewhere so they do not obscure the road.
    for (const r of st.racers) if (r !== me) { r.pos.y = -900 }
    if (g.camera && g.camera.reset) g.camera.reset(me)
    return {
      surface: smp.surface, width: smp.width, y: p.y, open: smp.open,
      bridge: smp.bridge, side: smp.bridgeSide,
    }
  }, [s, LAT])
  await waitSim(1.2)
 for (const u of cycles) {
  // The cycle position LAST, so it is not walked on by the settle. Everything
  // that reads the beat -- the sim's fall test and all three shaders -- is a
  // pure function of race time, so setting it is the whole of the control.
  //
  // maxSubSteps = 0 FREEZES the sim without pausing the game: the render loop
  // still runs and still hands `state.time` to every theme hook, but the
  // accumulator loop that would advance it never executes. Without this the
  // 0.25 s frame clamp walks the beat by up to a quarter of a cycle between
  // setting the time and the shutter, which is the difference between
  // photographing a flash and photographing a hole.
  if (u !== null) {
    await page.evaluate(([sAt, uWant]) => {
      window.__GAME__.maxSubSteps = 0
      const g = window.__GAME__
      const track = g.track
      // The span this shot is ABOUT: the one under the car, or failing that the
      // next one ahead. A shot taken from the approach is still a shot of a
      // span, and its cycle position is the thing being named.
      let ph = track.at(sAt).bridge
      if (ph < 0) {
        let best = Infinity
        for (const b of track.bridges) {
          let d = (b.s0 - sAt) % track.length
          if (d < 0) d += track.length
          if (d < best) { best = d; ph = b.phase }
        }
      }
      if (ph < 0) return
      const P = 3.2
      // Solve fract(t / P + phase) == uWant for a t a few periods in, so
      // nothing upstream is still in its first-frame state.
      g.race.state.time = P * (40 + (((uWant - ph) % 1) + 1) % 1)
    }, [s, u])
    // Wall clock here on purpose: the sim is frozen, so waitSim would never
    // return. Long enough for several frames at software-renderer speed.
    await page.waitForTimeout(1400)
  }
  const after = await page.evaluate(() => {
    const g = window.__GAME__
    const me = g.race.state.racers.find((r) => r.isLocal) ?? g.race.state.racers[0]
    // WHERE THE ROAD ACTUALLY IS ON SCREEN. The chase camera is a real chase
    // camera -- it lags, it swings, and after a teleport it settles wherever the
    // car ends up pointing -- so "teleported to the causeway" is not the same
    // claim as "photographed the causeway". This reports the screen x of the
    // centreline 60 m ahead, as a fraction of the frame: 0.5 is dead centre and
    // anything outside 0..1 means the road is off the side of the picture and
    // the shot is of something else.
    const cam = g.chase?.camera
    let ahead = null
    if (cam) {
      const w = g.track.surfacePoint(me.splineS + 60, 0)
      const V = Object.getPrototypeOf(cam.position).constructor
      const v = new V(w.x, w.y, w.z).project(cam)
      ahead = { x: v.x * 0.5 + 0.5, y: -v.y * 0.5 + 0.5, front: v.z < 1 }
    }
    return {
      y: me.pos.y, alt: me.altitude, grounded: me.grounded, s: me.splineS,
      off: me.offTrackTime, respawn: me.respawnTime, t: g.race.state.time, ahead,
    }
  })
  const tag = (u === null ? '' : `-u${String(Math.round(u * 100)).padStart(2, '0')}`)
    + (LAT === 0 ? '' : `-lat${LAT > 0 ? 'p' : 'm'}${String(Math.abs(Math.round(LAT))).padStart(2, '0')}`)
  const name = `${KIND}-${trackId}-s${String(Math.round(s)).padStart(4, '0')}${tag}.png`
  await page.screenshot({ path: join(OUT, name) })
  report.push({ s, u, ...info, ...after, shot: name })
  await page.evaluate(() => { window.__GAME__.maxSubSteps = 400 })
  const aim = after.ahead
    ? `road60 at ${(after.ahead.x * 100).toFixed(0)}%,${(after.ahead.y * 100).toFixed(0)}% ${after.ahead.front ? '' : 'BEHIND '}`
    : ''
  console.log(`s=${s}m lat=${LAT} u=${u ?? '-'}  surface=${info.surface} w=${info.width.toFixed(1)} roadY=${info.y.toFixed(1)}` +
    ` open=${info.open} bridge=${info.bridge?.toFixed?.(2)} side=${info.side}` +
    `  -> settled s=${after.s.toFixed(0)} alt=${after.alt.toFixed(2)} grounded=${after.grounded}` +
    ` ${aim} ${name}`)
 }
}
console.log(`console errors: ${errors.length}`)
if (errors.length) console.log(errors.slice(0, 5).join('\n'))
await browser.close()
server.close()
process.exit(errors.length ? 1 : 0)
