/**
 * DOES THE MUSIC ACTUALLY PLAY, AND DOES IT LOOP CLEANLY?
 *
 * Three separate claims, and only one of them is covered by anything else:
 *
 *   1. the files are fetchable        -- smoke.mjs catches a 404 as a console
 *                                        error, so this is already gated
 *   2. a signal reaches the output    -- NOT gated anywhere. A bed that decodes
 *                                        and is never started, a gain left at
 *                                        zero, a node wired to nothing: all
 *                                        silent, all invisible to every gate.
 *   3. the loop is seamless           -- NOT gated, and not observable in a
 *                                        short run: the loop point on these
 *                                        beds is two to three minutes in.
 *
 * (2) is measured by splicing an analyser onto the MUSIC bus specifically --
 * not the master, where eight engines and the tyre scrub would happily pass a
 * completely silent music bed.
 *
 * (3) cannot be waited for -- the loop point on these beds is minutes in -- so
 * what is checked is the property that MAKES it seamless: the decoded buffer
 * must match the source file's duration. Padding welded on by the decoder, or
 * silence left on either end, both show up as a mismatch, and both are exactly
 * what puts a stutter at the loop.
 *
 * The first version of this gate asserted the opposite and was wrong. None of
 * these mp3s carry a Xing/LAME header, so I expected Chrome to return the
 * encoder delay as audible silence and asserted that the trimmer must have
 * found some. It found none -- because Chrome STRIPS the padding rather than
 * surfacing it, handing back buffers 24-40ms shorter than the container. The
 * gate was failing a build over a bug that does not exist, which is worse than
 * having no gate: it trains you to ignore it.
 *
 *   node tools/probe-music.mjs
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
/**
 * Container durations, from ffprobe on the delivered files. The decoded buffer
 * is compared against these: a mismatch is padding or truncation, and either
 * one is a stutter at the loop.
 */
const SOURCE_SECONDS = {
  'title.mp3': 119.088,
  'garage.mp3': 120.0,
  'elkarim.mp3': 179.64,
  'frosthelm.mp3': 179.328,
  'namaresh.mp3': 119.544,
  'centurion-prime.mp3': 179.64,
  'victory.mp3': 14.976,
  'finish.mp3': 14.544,
}

const served = []
const server = createServer(async (req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0])
  try {
    if (p === '/' || p.endsWith('/')) p += 'index.html'
    const buf = await readFile(join(ROOT, p))
    served.push({ p, ok: true, bytes: buf.length })
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' })
    res.end(buf)
  } catch {
    served.push({ p, ok: false, bytes: 0 })
    res.writeHead(404); res.end('nf')
  }
})
await new Promise((r) => server.listen(0, r))
const url = `http://127.0.0.1:${server.address().port}/`

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist',
         '--autoplay-policy=no-user-gesture-required'],
})
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

await page.goto(url, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(2500)

const out = await page.evaluate(async () => {
  const g = window.__GAME__
  const audio = g && g.audio
  if (!audio) return { err: 'no audio system' }
  if (!audio.available) return { err: 'audio unavailable' }
  const stage = audio.stage
  if (!stage || !stage.ctx || !stage.busMusic) {
    return { err: 'stage does not expose ctx/busMusic for probing' }
  }
  audio.unlock()
  await new Promise((r) => setTimeout(r, 250))

  // The MUSIC bus, not the master: a silent bed behind eight live engines
  // measures exactly like a working one on the master.
  const an = stage.ctx.createAnalyser()
  an.fftSize = 2048
  stage.busMusic.connect(an)
  const buf = new Float32Array(an.fftSize)
  const peakOver = async (ms) => {
    let peak = 0
    const until = performance.now() + ms
    while (performance.now() < until) {
      an.getFloatTimeDomainData(buf)
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i]); if (v > peak) peak = v
      }
      await new Promise((r) => setTimeout(r, 8))
    }
    return peak
  }

  audio.setVolumes({ master: 1, music: 1, muted: false })
  const silence = await peakOver(150)

  // Wait for the fetch+decode rather than guessing a timeout.
  const waitFor = async (u, ms = 20000) => {
    const until = performance.now() + ms
    while (performance.now() < until) {
      const b = stage.buffers && stage.buffers.get(u)
      if (b) return true
      if (b === null && stage.buffers.has(u)) {
        // load() marks null while in flight AND on failure; keep waiting.
      }
      await new Promise((r) => setTimeout(r, 120))
    }
    return !!(stage.buffers && stage.buffers.get(u))
  }

  audio.menuMusic('title')
  const titleLoaded = await waitFor('audio/music/title.mp3')
  const title = await peakOver(1200)

  audio.music('rustfall', false)
  const bedLoaded = await waitFor('audio/music/elkarim.mp3')
  const bed = await peakOver(1500)

  // EVERY file, not just the three that happen to be on the default path. A
  // circuit whose bed is misnamed is silent only on that circuit, which is
  // exactly the kind of thing that ships.
  const ALL = [
    'audio/music/title.mp3', 'audio/music/garage.mp3',
    'audio/music/elkarim.mp3', 'audio/music/frosthelm.mp3',
    'audio/music/namaresh.mp3', 'audio/music/centurion-prime.mp3',
    'audio/sting/victory.mp3', 'audio/sting/finish.mp3',
  ]
  stage.preload(ALL)
  const missing = []
  for (const u of ALL) if (!(await waitFor(u, 25000))) missing.push(u)

  audio.finishSting(1)
  await new Promise((r) => setTimeout(r, 500))
  const victory = await peakOver(1200)

  // What the loop-point detector found, per file it has seen.
  const loops = []
  if (stage.loops) {
    for (const [u, lp] of stage.loops) {
      const b = stage.buffers.get(u)
      loops.push({
        u: u.split('/').pop(),
        start: +lp.start.toFixed(4),
        end: +lp.end.toFixed(4),
        dur: b ? +b.duration.toFixed(4) : 0,
      })
    }
  }
  return { silence: +silence.toFixed(4), title: +title.toFixed(4),
           bed: +bed.toFixed(4), victory: +victory.toFixed(4),
           titleLoaded, bedLoaded, missing, loops }
})

console.log(JSON.stringify(out, null, 2))
const audioReqs = served.filter((s) => s.p.startsWith('/audio/'))
console.log('\naudio requests:')
for (const r of audioReqs) console.log(`  ${r.ok ? 'OK ' : '404'} ${r.p}  ${(r.bytes / 1048576).toFixed(2)} MB`)

if (out.err) errors.push(out.err)
else {
  for (const m of out.missing || []) errors.push(`never decoded: ${m}`)
  if (!out.titleLoaded) errors.push('the title bed never decoded')
  if (!out.bedLoaded) errors.push('the race bed never decoded')
  if (out.title < 0.01) errors.push(`the title music produced peak ${out.title} -- silence`)
  if (out.bed < 0.01) errors.push(`the race bed produced peak ${out.bed} -- silence`)
  if (out.victory < 0.01) errors.push(`the victory sting produced peak ${out.victory} -- silence`)
  if (out.loops.length === 0) errors.push('no loop points were measured at all')
  for (const l of out.loops) {
    if (!(l.end > l.start)) errors.push(`${l.u}: loop end ${l.end} is not past start ${l.start}`)
    if (l.start < 0 || l.end > l.dur + 1e-6) errors.push(`${l.u}: loop points outside the buffer`)
    // The seam. A decoded buffer that does not match its source has either
    // gained padding or lost audio, and both are audible once a minute.
    const src = SOURCE_SECONDS[l.u]
    if (src === undefined) continue
    const drift = Math.abs(l.dur - src)
    // Up to three mp3 frames of encoder delay plus padding is 72ms at 48kHz,
    // and Chrome strips exactly that. Anything past 100ms is not the codec --
    // it is silence in the file or audio the decoder lost, and both are
    // audible once a minute at the loop.
    if (drift > 0.10) {
      errors.push(`${l.u}: decoded ${l.dur}s against a ${src}s source -- ${drift.toFixed(3)}s adrift`)
    }
    console.log(`  ${l.u.padEnd(22)} decoded ${l.dur}s vs source ${src}s  (${(drift * 1000).toFixed(0)}ms)`)
  }
}
for (const r of audioReqs) if (!r.ok) errors.push(`404 on ${r.p}`)

console.log(`\nerrors: ${errors.length}`, errors.slice(0, 5))
await browser.close()
server.close()
process.exit(errors.length ? 1 : 0)
