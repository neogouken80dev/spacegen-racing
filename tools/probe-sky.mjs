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
const aimed = await page.evaluate(() => {
  const g = window.__GAME__
  const sky = g.scene.getObjectByName('sky')
  const u = sky?.material?.uniforms
  const pick = u?.uHoleDir?.value ?? u?.uShipDir?.value
    ?? (u?.uBodyDir?.value && u.uBodyDir.value[0])
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
})
await page.waitForTimeout(1600)

await mkdir(new URL('../shots/', import.meta.url).pathname, { recursive: true })
await page.screenshot({ path: new URL(`../shots/sky-${TRACK}-${TIER}.png`, import.meta.url).pathname })
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
    Object.entries(full.defines ?? {}).filter(([k]) => !/^SG_(BODIES|RING|BELT|SHIPS|HOLE|RICH)$/.test(k)),
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
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  g.reduceMotion = false
  await wait(900)
  const a = read(); await wait(900); const b = read()
  g.reduceMotion = true
  await wait(900)
  const c = read(); await wait(900); const d = read()
  g.reduceMotion = false
  return { moving: +(b - a).toFixed(4), frozen: +(d - c).toFixed(4) }
})
if (rm) {
  console.log(`\n--- reduced motion ---`)
  console.log(`  clock advance, motion on:  ${rm.moving}`)
  console.log(`  clock advance, motion off: ${rm.frozen}`)
  if (rm.moving <= 0.05) errors.push('the celestial clock never advanced at all')
  if (rm.frozen > 0.02) errors.push(`reduced motion did not freeze the sky (${rm.frozen})`)
}

console.log(`\n=== SKY: ${TRACK} @ ${TIER} ===`)
console.log(JSON.stringify(info, null, 2))
console.log('errors:', errors.length, errors.slice(0, 2))
await browser.close(); server.close()
process.exit(errors.length ? 1 : 0)
