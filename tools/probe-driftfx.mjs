/**
 * ARE THE NEW DRIFT EFFECTS ACTUALLY ON SCREEN?
 *
 * Two new things: a kick on entry (a rearward throw plus an expanding ground
 * front) and a flame aura that thickens while the slide is held. Both are
 * particle emitters, and the failure mode for a particle emitter is that it
 * runs, spends pool slots, and is invisible -- behind the car, under the road,
 * at a colour the bloom eats, or at a size that never reaches a pixel.
 *
 * So this measures TWO independent things and requires both:
 *
 *   1. the emitters run      -- spawnCount per frame, read off the live system
 *   2. the screen changes    -- the fraction of pixels that differ between a
 *                              cruising frame and a drifting one, in the band
 *                              around the car
 *
 * (1) alone is the trap: an emitter that spawns into the wrong place passes it
 * every time. (2) alone is noisy, because the world is moving anyway -- which
 * is why the comparison is against a CRUISING frame at speed rather than a
 * still one, so the road is already flowing in both.
 *
 *   node tools/probe-driftfx.mjs
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { PNG } from 'pngjs'

const ROOT = new URL('../dist/', import.meta.url).pathname
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg',
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
const page = await (await browser.newContext({ viewport: { width: 1000, height: 620 } })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error' && !/api\/leaderboard/.test(m.text())) errors.push(m.text()) })

await page.goto(url, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(2500)
await page.evaluate(() => { window.__GAME__.maxSubSteps = 400; window.__GAME__.startRace() })

const sim = () => page.evaluate(() => {
  const g = window.__GAME__
  const s = g.race?.state
  const r = s?.racers?.[g.localId]
  return {
    p: s?.phase ?? '-', t: +(s?.time ?? 0).toFixed(1),
    v: +Math.hypot(r?.vel?.x ?? 0, r?.vel?.z ?? 0).toFixed(1),
    side: r?.driftSide ?? 0, tier: r?.driftTier ?? -2,
    charge: +(r?.driftCharge ?? 0).toFixed(2),
    // The live emitter count, straight off the particle system.
    spawns: g.vfx?.spawnCount ?? -1,
  }
})

const shot = async () => PNG.sync.read(await page.screenshot())

/**
 * WHY THIS IS A STATISTIC AND NOT A FRAME DIFF.
 *
 * The obvious measurement -- how many pixels changed between a cruising frame
 * and a drifting one -- was tried first and is worthless here. Under
 * SwiftShader this renderer runs near 1fps, so the camera travels forty metres
 * between two frames and 88% of the image differs from driving alone. A gate
 * asking for "more than the cruise floor" was asking for more than 88%, which
 * nothing can clear, and it failed a working effect.
 *
 * So the measure is a SCALAR that camera motion does not move: how much of the
 * band around the car is lit. Driving fast changes WHICH pixels are bright;
 * setting fire to the car changes HOW MANY. The aura is additive and drift-hued,
 * so it raises both the lit fraction and the mean luminance of that band whether
 * or not the world behind it has moved on.
 */
function litStats(png) {
  const w = png.width, h = png.height
  const x0 = Math.floor(w * 0.20), x1 = Math.floor(w * 0.80)
  const y0 = Math.floor(h * 0.42), y1 = Math.floor(h * 0.96)
  let lit = 0, tot = 0, sum = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2]
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
      sum += lum
      tot++
      if (lum > 110) lit++
    }
  }
  return { lit: +(lit / tot).toFixed(4), meanLum: +(sum / tot).toFixed(1) }
}

/**
 * Fraction of pixels differing between two frames of a FROZEN world.
 *
 * Only meaningful because the camera and the car are not moving -- see the note
 * on the measurement below. On live frames this number is ~0.88 from motion
 * alone and says nothing.
 */
function diffFrac(a, b, thr = 24) {
  const w = a.width, h = a.height
  const x0 = Math.floor(w * 0.20), x1 = Math.floor(w * 0.80)
  const y0 = Math.floor(h * 0.42), y1 = Math.floor(h * 0.96)
  let n = 0, tot = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4
      const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) +
                Math.abs(a.data[i + 2] - b.data[i + 2])
      tot++
      if (d > thr) n++
    }
  }
  return +(n / tot).toFixed(4)
}

/**
 * Of the pixels that changed, how many got brighter and how many darker.
 *
 * The drift signature does both at once and they mean different things: the
 * aura, the sparks and the shock front ADD light, while the tyre smoke COVERS
 * lit road. A single mean hides one behind the other -- measured, the smoke
 * wins on area and the frame reads darker overall even though the aura is
 * plainly there.
 */
function brightSplit(a, b, thr = 18) {
  const w = a.width, h = a.height
  const x0 = Math.floor(w * 0.20), x1 = Math.floor(w * 0.80)
  const y0 = Math.floor(h * 0.42), y1 = Math.floor(h * 0.96)
  let up = 0, down = 0, tot = 0
  const lum = (p, i) => 0.2126 * p.data[i] + 0.7152 * p.data[i + 1] + 0.0722 * p.data[i + 2]
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4
      const d = lum(a, i) - lum(b, i)
      tot++
      if (d > thr) up++
      else if (d < -thr) down++
    }
  }
  return { brighter: +(up / tot).toFixed(4), darker: +(down / tot).toFixed(4) }
}

/** Mean of a stat over several frames, so one unlucky frame decides nothing. */
async function sampleLit(shotFn, n, waitMs) {
  let lit = 0, lum = 0
  for (let i = 0; i < n; i++) {
    const s = litStats(await shotFn())
    lit += s.lit; lum += s.meanLum
    if (i < n - 1) await new Promise((r) => setTimeout(r, waitMs))
  }
  return { lit: +(lit / n).toFixed(4), meanLum: +(lum / n).toFixed(1) }
}

for (let i = 0; i < 240; i++) {
  const s = await sim()
  if (s.p === 'racing' && s.v > 34) break
  await page.waitForTimeout(400)
}

/**
 * THE MEASUREMENT, AFTER TWO THAT DID NOT WORK.
 *
 * First attempt: diff a cruising frame against a drifting one. Worthless --
 * at ~1fps under SwiftShader the camera moves forty metres between frames, so
 * 88% of the image differs from driving alone and no threshold can clear that.
 *
 * Second attempt: compare how LIT the band around the car is, cruising versus
 * drifting, on the reasoning that a statistic survives camera motion. It does
 * -- but it measures WHERE THE CAR IS. The car cruises down a lit straight and
 * drifts into a darker corner, so a working aura read as 0.0268 lit against
 * 0.0291 cruising and the gate failed a correct effect. Something other than
 * the variable under test was moving, which is the failure this repo has
 * written up more than any other.
 *
 * What actually isolates it: FREEZE THE WORLD AND SWITCH ONLY THE EFFECT OFF.
 * Stopping the sim (maxSubSteps = 0) leaves the renderer running with a static
 * camera and a static car. Clearing the racer's driftSide then stops the aura
 * emitting -- the sim is not stepping, so nothing puts it back -- and the live
 * particles die inside their own ~0.6s lifetimes. Two frames, same world, same
 * camera, same car, differing by exactly the drift effects. That difference is
 * the thing being measured, and nothing else is free to move.
 */
await page.keyboard.down('KeyW')
await page.waitForTimeout(1800)
const cruiseSpawns = (await sim()).spawns

await page.keyboard.down('KeyD')
await page.keyboard.down('ShiftLeft')
await page.waitForTimeout(200)
const entrySim = await sim()

let peakSpawns = 0
let peakCharge = 0
let held = 0
for (let i = 0; i < 34; i++) {
  const s = await sim()
  if (s.side !== 0) {
    held++
    if (s.spawns > peakSpawns) peakSpawns = s.spawns
    if (s.charge > peakCharge) peakCharge = s.charge
  }
  await page.waitForTimeout(220)
}
const holdSim = await sim()

// --- freeze, shoot, kill the effect, shoot again -------------------------
await page.evaluate(() => { window.__GAME__.maxSubSteps = 0 })
await page.waitForTimeout(900)          // let the camera settle on the frozen car
const withFx = await shot()
await page.screenshot({ path: new URL('../shots/drift-aura.png', import.meta.url).pathname })
const litOn = litStats(withFx)

await page.evaluate(() => {
  const g = window.__GAME__
  const r = g.race.state.racers[g.localId]
  r.driftSide = 0
  r.driftTier = -1
  r.driftCharge = 0
})
await page.waitForTimeout(2200)         // every drift particle outlives 0.6s
const withoutFx = await shot()
const litOff = litStats(withoutFx)
const isolated = diffFrac(withFx, withoutFx)
const split = brightSplit(withFx, withoutFx)
const brighter = split.brighter

await page.keyboard.up('ShiftLeft')
await page.keyboard.up('KeyD')
await page.keyboard.up('KeyW')

console.log('cruise   :', JSON.stringify({ spawns: cruiseSpawns }))
console.log('entry    :', JSON.stringify({ side: entrySim.side }))
console.log('held     :', JSON.stringify({ tier: holdSim.tier, peakSpawns, peakCharge, heldSamples: held }))
console.log('frozen   :', JSON.stringify({ isolatedDiff: isolated, ...split }))

if (entrySim.side === 0 && held === 0) errors.push('never entered a drift -- nothing was measured')
else {
  // 1. The emitters run. The particle system's own counter; not arguable.
  if (peakSpawns <= cruiseSpawns * 1.4) {
    errors.push(`drifting spawned ${peakSpawns} particles a frame against ${cruiseSpawns} cruising -- the emitters are barely running`)
  }
  // 2. And they reach the screen. Frozen world, effect the only variable.
  if (isolated < 0.01) {
    errors.push(`switching the drift effects off changed ${isolated} of the band on a frozen frame -- they are not visible`)
  }
  // 3. And some of that difference is LIGHT, not just smoke.
  //
  //    Mean luminance was the first thing tried here and it is the wrong
  //    statistic: the drift signature is mostly tyre smoke, which is large and
  //    deliberately OCCLUDING, so with the effects on the band measured DARKER
  //    (21 against 32.7) and a "must be brighter" gate failed a working aura.
  //    Smoke covering lit road is what smoke is for.
  //
  //    Splitting the difference into pixels that got brighter and pixels that
  //    got darker separates the two: the smoke is the darkened share, the aura
  //    and the sparks are the brightened one, and both must be non-trivial.
  if (brighter < 0.01) {
    errors.push(`only ${brighter} of the band got BRIGHTER with the effects on -- there is smoke but no aura`)
  }
  if (peakCharge <= 0) errors.push('the drift never charged, so the aura was never asked to build')
}

console.log(`\nerrors: ${errors.length}`, errors.slice(0, 5))
await browser.close()
server.close()
process.exit(errors.length ? 1 : 0)
