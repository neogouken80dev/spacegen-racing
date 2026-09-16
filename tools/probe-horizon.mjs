/**
 * "WHY IS THE HORIZON WHITE, AND WHICH LAYER PUT IT THERE?"
 *
 * The report was "on Halcyon Bay the colour bloom of horizon is quite strong
 * and really makes it hard to see with the light bloom". Four layers can each
 * produce that frame and they want four different fixes:
 *
 *   the band     sky.horizonGain / horizonColor, added in the dome shader
 *   the bloom    UnrealBloomPass, if the SKY ITSELF clears its threshold
 *   the sun      the three sun-scatter terms in the dome
 *   the fog      aerial perspective washing everything toward fogColor
 *
 * "It looks too bright" cannot choose between them. This can, because every one
 * of those layers has a live switch and the frame can be re-photographed with
 * it off:
 *
 *   full        the shipped chain
 *   noBloom     post.setIntensity(0, 1)   -- the bloom pass leaves the chain
 *   noBand      uHorizGain = 0            -- the dome's two-stop ramp only
 *   bandX3      uHorizGain x 3            -- THE LEVER'S OWN SELF-TEST. A knob
 *                                            that changes nothing at 0 and
 *                                            nothing at 3x is a knob that is
 *                                            not connected, not a knob that
 *                                            does not matter.
 *   noFog       track.def.fogDensity = 0  -- read fresh every frame by the
 *                                            environment's weather hook
 *
 * and, the measurement that actually identifies a bloom cause rather than
 * merely blaming bloom: THE THRESHOLD SWEEP. UnrealBloomPass's high pass is
 * `smoothstep(threshold - 0.01, threshold + 0.01, luma(scene))`, so raising the
 * threshold past a surface's own scene-linear luminance removes that surface
 * from the bloom completely. Sweeping the threshold and watching where the
 * horizon's glow disappears therefore MEASURES the sky's scene-linear luminance
 * through the bloom's own high pass, in the shipping renderer, with no readback
 * and no second implementation of the tone curve to be wrong about.
 *
 * A sky whose glow survives to threshold 2.0 is a sky the shipped threshold of
 * 0.78 was never going to hold back.
 *
 *   node tools/probe-horizon.mjs [--track=halcyon] [--at=0] [--aim=sun]
 *                                [--tier=high] [--sweep] [--shots]
 *   node tools/probe-horizon.mjs --all [--aim=sun]
 *
 * THE CAMERA IS NOT THE RACING CAMERA, and that is deliberate. The first run of
 * this probe photographed the start line from the chase rig and measured a
 * bloom spilling off the boardwalk's white sill under a black gantry -- a real
 * effect, and not the one being reported. `--aim` stubs the rig and looks LEVEL
 * along a chosen azimuth from just above the car, which puts the horizon
 * exactly across the middle of the frame with nothing built in front of it:
 *
 *   sun     along the sun's own azimuth -- the worst case, and on a golden-hour
 *           circuit the shot the player spends the start straight looking at
 *   off90   ninety degrees off it
 *   anti    away from it
 *
 * `chroma` and `detail` are in the report because a horizon can fail two ways.
 * `hot` (display luminance >= 235) catches the frame being erased by light.
 * `detail` -- mean absolute luminance step between horizontally adjacent pixels
 * -- catches the other one, a band that is merely FLAT: nothing clipped, and
 * nothing to see either, which is what a distant board washed toward the fog
 * colour looks like in numbers.
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { PNG } from 'pngjs'

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

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const ALL = process.argv.includes('--all')
const SWEEP = process.argv.includes('--sweep')
const SHOTS = process.argv.includes('--shots')
const AT = Number(arg('at', '0'))
const AIM = arg('aim', 'sun')
const TIER = arg('tier', 'high')
const NAMES = {
  rustfall: 'Elkarim', cryostatic: 'Frosthelm', aetherion: 'Namaresh',
  hollowchoir: 'Centurion Prime', emberfall: 'Ashkar', abyssal: 'Meridian Deep',
  halcyon: 'Halcyon Bay', neonspire: 'Zhen-9',
}
const TRACKS = ALL ? Object.keys(NAMES) : [arg('track', 'halcyon')]

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist'],
})

const OUT = 'shots/horizon'
if (SHOTS) await mkdir(OUT, { recursive: true })

/** sRGB display luminance, 0..255. */
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b

/**
 * Summarise one horizontal band of a frame.
 *
 * Everything here is in DISPLAY values, after the tone curve, because that is
 * what the player is looking at. The scene-linear side of the question is
 * answered by the threshold sweep instead.
 */
function band(png, y0, y1) {
  const { width: W, height: H, data } = png
  const a = Math.max(0, Math.min(H - 1, Math.round(y0)))
  const b = Math.max(a + 1, Math.min(H, Math.round(y1)))
  let sum = 0, hot = 0, chroma = 0, detail = 0, n = 0, dn = 0
  for (let y = a; y < b; y++) {
    let prev = -1
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const r = data[i], g = data[i + 1], bl = data[i + 2]
      const L = luma(r, g, bl)
      sum += L; n++
      if (L >= 235) hot++
      chroma += Math.max(r, g, bl) - Math.min(r, g, bl)
      if (prev >= 0) { detail += Math.abs(L - prev); dn++ }
      prev = L
    }
  }
  return {
    mean: sum / n,
    hot: (hot * 100) / n,
    chroma: chroma / n,
    detail: dn ? detail / dn : 0,
  }
}

const rows = []
for (const trackId of TRACKS) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1,
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(url, { waitUntil: 'load', timeout: 60000 })
  await page.waitForTimeout(2000)
  await page.evaluate(() => { if (window.__GAME__) window.__GAME__.maxSubSteps = 400 })

  const clickText = async (labels) => {
    for (const t of labels) {
      const el = page.locator('button, .sg-btn').filter({ hasText: t }).first()
      if (await el.count() && await el.isVisible().catch(() => false)) { await el.click(); return }
    }
  }
  await clickText(['PLAY NOW', 'PLAY', 'Play'])
  await page.waitForSelector('.sg-screen--track .sg-card--track', { state: 'visible', timeout: 30000 })
  await page.locator('.sg-screen--track .sg-card--track').filter({ hasText: NAMES[trackId] ?? trackId }).first().click()
  await page.waitForTimeout(1200)
  await page.locator('.sg-screen--track .sg-btn--start').click()
  await page.waitForSelector('.sg-screen--garage .sg-btn--start', { state: 'visible', timeout: 30000 })
  await page.locator('.sg-screen--garage .sg-btn--start').click()
  await page.waitForTimeout(4000)
  await page.evaluate(() => {
    const g = window.__GAME__
    if (g && g.race) { g.race.state.countdown = 0; g.race.state.phase = 'racing' }
  })

  // PIN THE TIER BEFORE ANYTHING IS MEASURED. Under SwiftShader this renders at
  // about 1 fps and the adaptive scaler drops to `low` within seconds, which
  // builds no composer at all -- a probe that measured that would photograph a
  // frame with no bloom in it and report that bloom was innocent. The first run
  // of this probe did exactly that: it reported threshold 0.72 / strength 0.82,
  // which is the MEDIUM tier, not the high tier a desktop player gets.
  await page.evaluate((t) => {
    const g = window.__GAME__
    g.setTier(t)
    g.qualityCooldown = 1e9
    g.frameTimes.length = 0
  }, TIER)
  await page.waitForTimeout(2500)

  /** Park the car at `AT` and clear the field. Same rig as probe-shots. */
  await page.evaluate((sAt) => {
    const g = window.__GAME__
    const st = g.race.state
    const me = st.racers.find((r) => r.isLocal) ?? st.racers[0]
    const smp = g.track.at(sAt)
    const p = g.track.surfacePoint(sAt, 0)
    me.pos.x = p.x; me.pos.y = p.y + 1.2; me.pos.z = p.z
    me.splineS = sAt; me.totalS = sAt; me.lateral = 0
    me.yaw = Math.atan2(smp.tangent.x, smp.tangent.z)
    me.vel.x = smp.tangent.x * 18; me.vel.z = smp.tangent.z * 18
    me.vel.y = smp.tangent.y * 18
    me.vertVel = 0; me.driftSide = 0; me.spinTime = 0; me.respawnTime = 0
    me.fwd.x = smp.tangent.x; me.fwd.y = smp.tangent.y; me.fwd.z = smp.tangent.z
    me.up.x = smp.normal.x; me.up.y = smp.normal.y; me.up.z = smp.normal.z
    for (const r of st.racers) if (r !== me) r.pos.y = -900
    if (g.camera && g.camera.reset) g.camera.reset(me)
  }, AT)
  await page.waitForTimeout(2500)

  /**
   * FREEZE, AND THE FIRST VERSION OF THIS PROBE DID NOT.
   *
   * `maxSubSteps = 0` stops the accumulator advancing the sim while the render
   * loop keeps running, so every condition below photographs the SAME frame
   * with one layer switched off. Without it the car kept driving at 18 m/s
   * between conditions and the report was incoherent -- removing the horizon
   * band came out BRIGHTER than leaving it on, which is arithmetically
   * impossible and was simply a different piece of coastline.
   */
  await page.evaluate(() => { window.__GAME__.maxSubSteps = 0 })
  await page.waitForTimeout(1500)

  /**
   * AIM THE CAMERA, and take the chase rig out of the loop rather than arguing
   * with it -- it re-solves its pose every frame and would have this back on
   * the road before the shutter. (probe-sky.mjs learned this the same way.)
   */
  const aimed = await page.evaluate(([mode]) => {
    const g = window.__GAME__
    g.chase.update = () => {}
    g.chase.updateCinematic = () => {}
    const cam = g.chase.camera
    const V = cam.position.constructor
    const sd = g.track.def.sunDirection
    let ax = sd[0], az = sd[2]
    const h = Math.hypot(ax, az) || 1
    ax /= h; az /= h
    if (mode === 'anti') { ax = -ax; az = -az }
    if (mode === 'off90') { const t = ax; ax = -az; az = t }
    const r = g.race.state.racers.find((x) => x.isLocal) ?? g.race.state.racers[0]
    // Just above the car, at about the chase rig's own eye height -- high
    // enough to clear the barriers, low enough that this is still the picture
    // a player is looking at rather than a map.
    cam.position.set(r.pos.x, r.pos.y + 6, r.pos.z)
    cam.up.set(0, 1, 0)
    // LEVEL. Looking exactly along the ground plane puts the true horizon
    // across the middle of the frame by construction, so the bands below need
    // no projection and cannot be knocked off by a banked road.
    cam.lookAt(cam.position.x + ax * 1000, cam.position.y, cam.position.z + az * 1000)
    cam.updateMatrixWorld(true)
    return { ax: +ax.toFixed(3), az: +az.toFixed(3) }
  }, [AIM])
  await page.waitForTimeout(3000)

  /**
   * THE LEVERS.
   *
   * Each one is the real knob the shipped code reads, not a copy: the fog
   * density is the TrackDef field the environment's weather hook re-reads every
   * frame, so writing anything else would be silently overwritten a frame later.
   */
  const setup = await page.evaluate(() => {
    const g = window.__GAME__
    // Re-resolved on every call rather than captured: setTier() rebuilds the
    // world, and a lever holding the uniforms of a disposed sky writes into
    // nothing while reporting success.
    const sky = () => {
      const s = g.scene.getObjectByName('sky')
      return s ? s.material.uniforms : null
    }
    window.__HZ__ = {
      bandGain: sky() ? sky().uHorizGain.value : -1,
      fogDensity: g.track.def.fogDensity,
      threshold: g.post && g.post.bloom ? g.post.bloom.threshold : -1,
      strength: g.post && g.post.bloom ? g.post.bloom.strength : -1,
      set(o) {
        const u = sky()
        if (o.glare !== undefined && g.post) g.post.setIntensity(o.glare, 1)
        if (o.band !== undefined && u) u.uHorizGain.value = o.band
        if (o.fog !== undefined) g.track.def.fogDensity = o.fog
        if (o.threshold !== undefined && g.post && g.post.bloom) {
          g.post.bloom.threshold = o.threshold
        }
      },
    }
    return {
      bandGain: window.__HZ__.bandGain,
      fogDensity: window.__HZ__.fogDensity,
      threshold: window.__HZ__.threshold,
      strength: window.__HZ__.strength,
      tier: g.tier,
    }
  })

  const shoot = async (tag) => {
    const buf = await page.screenshot({ type: 'png' })
    if (SHOTS) await writeFile(join(OUT, `${trackId}-${AIM}-${tag}.png`), buf)
    return PNG.sync.read(buf)
  }

  const H = 720
  // Looking level, so the horizon is the middle row by construction.
  const BANDS = {
    sky: [H * 0.26, H * 0.47],
    line: [H * 0.47, H * 0.53],
    ground: [H * 0.53, H * 0.72],
  }

  /**
   * THREE SHOTS, NOT ONE, and the spread is reported.
   *
   * A frozen sim is not a frozen picture: the dome's strata drift on `uTime`
   * and the motes fall. `spread` is the largest deviation of sky.mean across
   * the three, and it is the error bar -- a difference between two conditions
   * smaller than it means nothing.
   */
  const measure = async (tag) => {
    const shots = []
    for (let i = 0; i < 3; i++) {
      const png = await shoot(i === 0 ? tag : `${tag}-${i}`)
      const one = {}
      for (const [k, [a, b]] of Object.entries(BANDS)) one[k] = band(png, a, b)
      shots.push(one)
      if (i < 2) await page.waitForTimeout(1200)
    }
    const out = { track: trackId, cond: tag }
    for (const k of Object.keys(BANDS)) {
      out[k] = {}
      for (const f of Object.keys(shots[0][k])) {
        out[k][f] = shots.reduce((s, x) => s + x[k][f], 0) / shots.length
      }
    }
    out.spread = Math.max(...shots.map((s) => Math.abs(s.sky.mean - out.sky.mean)))
    return out
  }

  const apply = async (o) => {
    await page.evaluate((q) => window.__HZ__.set(q), o)
    await page.waitForTimeout(1300)
  }

  const base = { glare: 1, band: setup.bandGain, fog: setup.fogDensity, threshold: setup.threshold }
  const CONDS = [
    ['full', {}],
    ['noBloom', { glare: 0 }],
    ['noBand', { band: 0 }],
    ['bandX3', { band: setup.bandGain * 3 }],
    ['noFog', { fog: 0 }],
    ['noBandNoBloom', { glare: 0, band: 0 }],
  ]
  for (const [tag, o] of CONDS) {
    await apply({ ...base, ...o })
    rows.push(await measure(tag))
  }
  if (SWEEP) {
    // Brackets the sky from BELOW as well as above. Above the shipped 0.78 the
    // sweep says how much of the frame's bloom the sky was feeding; below it,
    // how much margin a fix actually bought -- a sky sitting at 0.74 would look
    // fixed at 0.78 and light straight back up on the medium tier, whose gate
    // is 0.72.
    for (const t of [0.50, 0.62, 0.72, 0.78, 0.9, 1.05, 1.25, 1.5, 2.0]) {
      await apply({ ...base, threshold: t })
      const r = await measure(`thr${t}`)
      rows.push(r)
    }
  }
  // THE SAME CONDITION, LAST. `full` and `fullB` are the identical shipped
  // chain photographed at the two ends of the run; if they disagree by more
  // than the per-condition spread, nothing between them is comparable either.
  await apply(base)
  rows.push(await measure('fullB'))

  console.log(`\n=== ${trackId} (${NAMES[trackId]}) @ ${AT}m  aim=${AIM} (${aimed.ax}, ${aimed.az}) tier=${setup.tier} ===`)
  console.log(`    bloom threshold ${setup.threshold}  strength ${setup.strength}  `
    + `horizonGain ${setup.bandGain}  fogDensity ${setup.fogDensity}`)
  console.log('    cond            sky.mean  +-  sky.hot sky.chr | line.mean line.hot | grd.mean grd.chr grd.detail')
  for (const r of rows.filter((x) => x.track === trackId)) {
    console.log(`    ${r.cond.padEnd(15)} `
      + `${r.sky.mean.toFixed(1).padStart(7)} ${r.spread.toFixed(1).padStart(4)} ${r.sky.hot.toFixed(1).padStart(7)} ${r.sky.chroma.toFixed(1).padStart(7)} | `
      + `${r.line.mean.toFixed(1).padStart(8)} ${r.line.hot.toFixed(1).padStart(8)} | `
      + `${r.ground.mean.toFixed(1).padStart(7)} ${r.ground.chroma.toFixed(1).padStart(7)} ${r.ground.detail.toFixed(2).padStart(9)}`)
  }

  /**
   * THE INSTRUMENT'S OWN SELF-TESTS.
   *
   * 1. Both layers only ever ADD light, so taking either away can only lower
   *    the sky's mean and taking both away must be the lowest of the three. A
   *    run that violates that is not reporting a surprising renderer, it is
   *    reporting that the frame moved between shots -- which is how the first
   *    version of this probe failed.
   * 2. The band lever must MOVE the picture in both directions. A `noBand` that
   *    reads the same as `full` proves nothing on its own: it is equally
   *    consistent with "the band does not matter" and with "the uniform write
   *    went to a disposed material". bandX3 separates those two.
   */
  const pick = (c) => rows.find((r) => r.track === trackId && r.cond === c)
  const [f, nb, nl, nn, x3, fb] = ['full', 'noBand', 'noBloom', 'noBandNoBloom', 'bandX3', 'fullB'].map(pick)
  if (f && nb && nl && nn && x3 && fb) {
    const mono = nn.sky.mean <= nb.sky.mean + 1.5 && nn.sky.mean <= nl.sky.mean + 1.5
      && nb.sky.mean <= f.sky.mean + 1.5 && nl.sky.mean <= f.sky.mean + 1.5
    console.log(`    self-test monotonic (removing light can only darken): ${mono ? 'PASS' : 'FAIL -- frame moved between shots'}`)
    console.log(`    self-test repeatable (full vs fullB): ${Math.abs(f.sky.mean - fb.sky.mean).toFixed(2)} (spread ${f.spread.toFixed(2)}/${fb.spread.toFixed(2)})`)
    console.log(`    self-test band lever connected (bandX3 - noBand): ${(x3.sky.mean - nb.sky.mean).toFixed(2)} sky, `
      + `${(x3.line.mean - nb.line.mean).toFixed(2)} line -- ${x3.sky.mean - nb.sky.mean > 2 || x3.line.mean - nb.line.mean > 2 ? 'CONNECTED' : 'NOT CONNECTED, band numbers are meaningless'}`)
  }
  if (errors.length) console.log('    page errors:', errors.slice(0, 3))
  await ctx.close()
}

if (ALL) {
  console.log('\n=== ALL TRACKS, sky band ===')
  console.log('    track           full.mean full.hot | noBloom.mean  bloom lift | band lift')
  for (const t of TRACKS) {
    const f = rows.find((r) => r.track === t && r.cond === 'full')
    const n = rows.find((r) => r.track === t && r.cond === 'noBloom')
    const b = rows.find((r) => r.track === t && r.cond === 'noBand')
    if (!f || !n || !b) continue
    console.log(`    ${t.padEnd(15)} ${f.sky.mean.toFixed(1).padStart(9)} ${f.sky.hot.toFixed(1).padStart(8)} | `
      + `${n.sky.mean.toFixed(1).padStart(12)} ${(f.sky.mean - n.sky.mean).toFixed(1).padStart(11)} | `
      + `${(f.sky.mean - b.sky.mean).toFixed(1).padStart(9)}`)
  }
}

await browser.close()
server.close()
