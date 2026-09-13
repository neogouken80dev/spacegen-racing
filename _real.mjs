// THE REAL USER PATH. No manual unlock(), no poking the stage -- click the
// title screen like a person, drive a race, and listen at the master bus.
// This is the only version of the question that matches what Vince is doing.
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
const ROOT = new URL('./dist/', import.meta.url).pathname
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json','.ico':'image/x-icon','.mp3':'audio/mpeg'}
const server=createServer(async(q,r)=>{try{let p=decodeURIComponent((q.url||'/').split('?')[0]);if(p==='/'||p.endsWith('/'))p+='index.html'
  const b=await readFile(join(ROOT,p));r.writeHead(200,{'content-type':MIME[extname(p)]||'application/octet-stream'});r.end(b)}catch{r.writeHead(404);r.end('nf')}})
await new Promise(r=>server.listen(0,r))
const url=`http://127.0.0.1:${server.address().port}/`
const browser=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-sandbox','--no-sandbox','--ignore-gpu-blocklist']})
const page=await(await browser.newContext({viewport:{width:1280,height:800}})).newPage()
const errs=[]; page.on('pageerror',e=>errs.push(e.message))
page.on('console',m=>{if(m.type()==='error')errs.push(m.text())})
await page.goto(url,{waitUntil:'load',timeout:30000}); await page.waitForTimeout(2500)

// A REAL CLICK on the page, which is what the autoplay policy wants.
await page.mouse.click(640, 400)
await page.waitForTimeout(400)

await page.evaluate(() => {
  const g = window.__GAME__
  // The meter goes on AFTER the gesture, so nothing here is what unlocked it.
  const stage = g.audio.stage
  const ctx = stage.ctx
  const an = ctx.createAnalyser(); an.fftSize = 2048
  stage.master.connect(an)
  window.__AN__ = { an, buf: new Float32Array(an.fftSize), ctxState: ctx.state }
  window.__SFX__ = []
  window.__EV__ = {}
  // Every event kind that actually reaches the audio planner, counted. This is
  // the other half of the question: a sound that never plays may be a routing
  // bug, or the event may simply never have happened.
  const realRace = g.audio.race.bind(g.audio)
  g.audio.race = (st, events, localId, ...rest) => {
    for (let i = 0; i < events.length; i++) {
      for (const ev of (events[i] || [])) {
        const k = (i === localId ? 'me:' : 'ai:') + ev.t
        window.__EV__[k] = (window.__EV__[k] || 0) + 1
      }
    }
    return realRace(st, events, localId, ...rest)
  }
  // Record every sound the planner actually asks for, and what the stage has.
  const realPlay = stage.play.bind(stage)
  stage.play = (req, def) => {
    window.__SFX__.push({ id: req.id, gain: +req.gain.toFixed(3), kind: def.source.kind,
      url: def.source.url, buf: def.source.url ? String(stage.buffers.get(def.source.url) === undefined ? 'MISSING' : (stage.buffers.get(def.source.url) === null ? 'FAILED' : 'ok')) : '-' })
    return realPlay(req, def)
  }
  // Record the moment the SIM pushes lap/finish, independently of whether the
  // renderer ever sees it. The gap between these two counters is the answer:
  // equal means the event never happened, unequal means it was lost in between.
  window.__EMIT__ = {}
  const race = g.race
  const realStep = race.step.bind(race)
  race.step = () => {
    const before = {}
    for (const r of race.state.racers) before[r.id] = r.events.length
    realStep()
    for (const r of race.state.racers) {
      for (const ev of r.events) {
        if (ev.t === 'lap' || ev.t === 'finish' || ev.t === 'boost' || ev.t === 'driftEnd') {
          const k = (r.id === g.localId ? 'me:' : 'ai:') + ev.t
          window.__EMIT__[k] = (window.__EMIT__[k] || 0) + 1
        }
      }
    }
  }
  g.maxSubSteps = 900
  g.startRace()
  const st = g.race?.state
  if (st) { const r = st.racers[g.localId]; if (r) r.isAI = true }
})

const meter = () => page.evaluate(() => {
  const { an, buf } = window.__AN__
  an.getFloatTimeDomainData(buf)
  let peak = 0, sum = 0
  for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > peak) peak = v; sum += buf[i]*buf[i] }
  const g = window.__GAME__
  return { peak, rms: Math.sqrt(sum/buf.length), t: +(g.race?.state?.time ?? 0).toFixed(1), phase: g.phase,
    ctx: g.audio.stage.ctx.state }
})

let maxPeak = 0, samples = 0, sumRms = 0
for (let i = 0; i < 2400; i++) {
  const m = await meter()
  if (m.peak > maxPeak) maxPeak = m.peak
  sumRms += m.rms; samples++
  if (m.phase === 'results') break
  await page.waitForTimeout(120)
}
const played = await page.evaluate(() => {
  const byId = {}
  for (const p of window.__SFX__) {
    byId[p.id] = byId[p.id] || { n: 0, kind: p.kind, buf: p.buf, url: p.url }
    byId[p.id].n++
  }
  return { total: window.__SFX__.length, byId, ctx: window.__AN__.ctxState, events: window.__EV__, emitted: window.__EMIT__ }
})
const db = (v)=>+(20*Math.log10(Math.max(v,1e-9))).toFixed(1)
console.log(JSON.stringify({ ctxAtMeterSetup: played.ctx, maxPeakDb: db(maxPeak),
  meanRmsDb: db(sumRms/Math.max(1,samples)), soundsPlayed: played.total,
  byId: Object.fromEntries(Object.entries(played.byId).map(([k,v])=>[k,v.n])),
  simEmitted: played.emitted, audioSaw: played.events, errs: errs.slice(0,4) }, null, 1))
await browser.close(); server.close()
