/**
 * DOES ANY SOUND ACTUALLY COME OUT?
 *
 * tests/audio.test.ts proves the planner decides correctly. That is a
 * completely separate claim from "a signal reached the output", and the gap
 * between them is where every real audio bug lives: a context that never
 * resumed, a bus wired to nothing, a gain left at zero, a node graph that
 * throws on the first trigger.
 *
 * None of that is observable by listening -- this runs headless. So instead of
 * a speaker, the probe ends the chain in an AnalyserNode and reads the peak
 * sample. A number above the noise floor is proof a signal existed; zero is
 * proof one did not, whatever the planner believed.
 *
 * It also checks the two failure modes that are silent by design and therefore
 * impossible to notice in a screenshot: a context that stays suspended because
 * no gesture reached it, and the mute switch not actually muting.
 *
 *   node tools/probe-audio.mjs
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'

const ROOT = new URL('../dist/', import.meta.url).pathname
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
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
  // autoplay-policy is the whole reason this probe can run unattended: without
  // it the context stays suspended forever and every measurement reads zero for
  // a reason that has nothing to do with the code under test.
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist',
         '--autoplay-policy=no-user-gesture-required'],
})
const page = await (await browser.newContext({
  viewport: { width: 1280, height: 720 },
})).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

await page.goto(url, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(2500)

/**
 * Measure the peak the game's own audio graph produces.
 *
 * Deliberately measures the REAL system rather than building a parallel one:
 * the analyser is spliced onto the live master bus, so what is measured is what
 * a player would hear, including every gain stage between the trigger and the
 * output.
 */
const measure = await page.evaluate(async () => {
  const g = window.__GAME__
  const audio = g?.audio
  if (!audio) return { err: 'no audio system on the game' }
  if (!audio.available) return { err: 'audio unavailable -- no context could be built' }

  // Reach the stage's context and master through the graph it built.
  const stage = audio.stage
  if (!stage) return { err: 'no stage' }
  const ctx = stage.ctx
  const master = stage.master
  if (!ctx || !master) return { err: 'stage does not expose ctx/master for probing' }

  audio.unlock()
  await new Promise((r) => setTimeout(r, 250))
  const state0 = ctx.state

  const an = ctx.createAnalyser()
  an.fftSize = 2048
  master.connect(an)
  const buf = new Float32Array(an.fftSize)

  const peakOver = async (ms) => {
    let peak = 0
    const until = performance.now() + ms
    while (performance.now() < until) {
      an.getFloatTimeDomainData(buf)
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i])
        if (v > peak) peak = v
      }
      await new Promise((r) => setTimeout(r, 8))
    }
    return peak
  }

  const silence = await peakOver(120)

  audio.setVolumes({ master: 1, sfx: 1, muted: false })
  audio.cue('countdownGo')
  const oneShot = await peakOver(400)

  audio.cue('boost3')
  const boost = await peakOver(500)

  // And the mute switch, which is the one control whose failure is silent in
  // the other direction -- a mute that does not mute is only discovered by a
  // player in a quiet room.
  audio.setVolumes({ muted: true })
  await new Promise((r) => setTimeout(r, 120))
  audio.cue('countdownGo')
  const muted = await peakOver(400)
  audio.setVolumes({ muted: false })

  return {
    state0, after: ctx.state, sampleRate: ctx.sampleRate,
    silence: +silence.toFixed(5),
    oneShot: +oneShot.toFixed(5),
    boost: +boost.toFixed(5),
    muted: +muted.toFixed(5),
  }
})

console.log(JSON.stringify(measure, null, 2))

/**
 * DO RACE EVENTS ACTUALLY REACH THE AUDIO SYSTEM?
 *
 * The measurement above proves a signal comes out when something calls `cue()`.
 * It says nothing about the path that matters in play, and that path was broken:
 * main.ts handed the planner `eventCarry`, which the sub-step write-back drains
 * to zero length BEFORE the audio call runs. Every boost, hit, lap and pickup in
 * a real race arrived as an empty list. Nothing threw, nothing logged, the game
 * was simply mute for everything except the engines -- which is exactly the
 * failure mode a screenshot cannot show and a unit test with a correctly-shaped
 * fixture cannot reach.
 *
 * So: wrap the real call, run a real race, and count the events it is handed.
 */
const wired = await page.evaluate(async () => {
  const g = window.__GAME__
  if (!g?.audio) return { err: 'no audio system' }
  let calls = 0
  let framesWithEvents = 0
  let events = 0
  let holes = 0
  const orig = g.audio.race.bind(g.audio)
  g.audio.race = (state, evs, ...rest) => {
    calls++
    let n = 0
    for (let i = 0; i < state.racers.length; i++) {
      const slot = evs[i]
      if (slot === undefined) { holes++; continue }
      n += slot.length
    }
    if (n > 0) framesWithEvents++
    events += n
    return orig(state, evs, ...rest)
  }
  // WAIT ON SIM TIME, NEVER WALL CLOCK. This renderer runs at under 1fps under
  // SwiftShader and the loop clamps its sub-steps, so twelve seconds of wall
  // clock bought about one second of race -- all of it countdown, during which
  // zero events is the CORRECT answer. The first version of this gate failed on
  // exactly that and would have sent me hunting a bug that was already fixed.
  // maxSubSteps is raised for the same reason the attract probe raises it.
  g.maxSubSteps = 400
  const start = g.race?.state?.time ?? 0
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
    const t = g.race?.state?.time ?? 0
    if (t - start > 25) break
  }
  return { calls, framesWithEvents, events, holes, simSeconds: +((g.race?.state?.time ?? 0) - start).toFixed(1) }
})

console.log('\nrace wiring:', JSON.stringify(wired))
if (wired.err) errors.push(wired.err)
else {
  if (wired.calls === 0) errors.push('audio.race was never called -- no race ran')
  else if (wired.simSeconds < 5) {
    errors.push(`only ${wired.simSeconds}s of race ran -- the sample proves nothing`)
  } else if (wired.events === 0) {
    errors.push(
      `audio.race ran ${wired.calls} times over ${wired.simSeconds}s of race ` +
      'and was handed ZERO events',
    )
  }
  if (wired.holes > 0) errors.push(`${wired.holes} undefined racer slots reached the planner`)
}

if (measure.err) errors.push(measure.err)
else {
  if (measure.after !== 'running') errors.push(`context is ${measure.after}, not running`)
  // The floor is generous: this is proving a signal EXISTS, not measuring it.
  if (measure.oneShot < 0.01) errors.push(`a one-shot produced peak ${measure.oneShot} -- silence`)
  if (measure.boost < 0.01) errors.push(`the boost produced peak ${measure.boost} -- silence`)
  if (measure.muted > measure.oneShot * 0.2) {
    errors.push(`mute let ${measure.muted} through against ${measure.oneShot} unmuted`)
  }
}

console.log(`\nerrors: ${errors.length}`, errors.slice(0, 4))
await browser.close()
server.close()
process.exit(errors.length ? 1 : 0)
