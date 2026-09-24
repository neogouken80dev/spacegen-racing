/**
 * THE HUD STATES A RACE RARELY PHOTOGRAPHS, AND THE TYPE A PHONE CANNOT READ.
 *
 * `tools/smoke.mjs` photographs a race that is going well. The states this
 * probe exists for are the ones that are on screen for about a second in a
 * real race and never in a smoke run: an EMP stun, the pilot's plating eating a
 * crash, the ward eating a missile, a seeker locked on from behind, a player
 * driving the wrong way. Each is set up through the shipping state and then
 * photographed with the sim FROZEN (maxSubSteps = 0), so the HUD is drawing a
 * state the sim can name rather than whatever a 1-5 fps renderer happened to
 * hand over.
 *
 * It also MEASURES rather than eyeballs the two phone complaints:
 *
 *   TYPE    every visible text node under the HUD, the tool bar and the touch
 *           layer, with its computed font-size -- anything under 11px listed.
 *   TARGETS the pause/settings buttons, the tilt-permission button, and any
 *           overlap between the item slots and the tool bar.
 *
 *   node tools/probe-hudstates.mjs [--desktop|--portrait|--landscape] [--tag=x]
 *
 * Desktop is 1280x720. Portrait is 390x844 -- the narrow phone the item slot
 * collided with the tool bar on -- and landscape is the same phone turned over.
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { extname, join } from 'node:path'

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const MODE = process.argv.includes('--portrait') ? 'portrait'
  : process.argv.includes('--landscape') ? 'landscape' : 'desktop'
const TAG = arg('tag', 'now')
const VP = MODE === 'portrait' ? { width: 390, height: 844 }
  : MODE === 'landscape' ? { width: 844, height: 390 } : { width: 1280, height: 720 }
const TOUCH = MODE !== 'desktop'
const OUT = 'shots'
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg' }
const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  const path = join('dist', url === '/' ? 'index.html' : decodeURIComponent(url.slice(1)))
  if (!existsSync(path)) { res.writeHead(404); res.end('nope'); return }
  res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' })
  res.end(readFileSync(path))
})
await new Promise((r) => server.listen(0, r))
const port = server.address().port

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist'],
})
const ctx = await browser.newContext({ viewport: VP, hasTouch: TOUCH, isMobile: TOUCH, deviceScaleFactor: 1 })
const page = await ctx.newPage()
// The iOS pre-permission state, so the tilt button is on screen to be measured:
// Safari rejects requestPermission outside a gesture, which leaves the scheme
// on tilt with the sensor off and the button up. Same stub probe-shots uses.
if (TOUCH) {
  await page.addInitScript(() => {
    const D = window.DeviceOrientationEvent
    if (D) D.requestPermission = () => Promise.reject(new Error('requires a user gesture'))
  })
}
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(String(e)))

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(2200)
await page.evaluate(() => { if (window.__GAME__) window.__GAME__.maxSubSteps = 400 })

// A long timeout on purpose: "To Garage" builds the garage preview's WebGL
// context, and under SwiftShader on a shared machine that press alone was
// measured at 7-8 s -- on the build before this probe existed as well as after.
const act = async (loc) => (TOUCH ? loc.tap({ timeout: 60000 }) : loc.click({ timeout: 60000 }))
const clickText = async (labels) => {
  for (const t of labels) {
    const el = page.locator('button, .sg-btn').filter({ hasText: t }).first()
    if (await el.count() && await el.isVisible().catch(() => false)) { await act(el); return }
  }
}
await clickText(['PLAY NOW', 'PLAY', 'Play'])
await page.waitForSelector('.sg-screen--track .sg-card--track', { state: 'visible', timeout: 20000 })
await act(page.locator('.sg-screen--track .sg-btn--start').first())
await page.waitForSelector('.sg-screen--garage .sg-btn--start', { state: 'visible', timeout: 20000 })
await page.waitForTimeout(400)
await act(page.locator('.sg-screen--garage .sg-btn--start').first())
await page.waitForTimeout(3500)
await page.evaluate(() => {
  const g = window.__GAME__
  if (g && g.race) { g.race.state.countdown = 0; g.race.state.phase = 'racing' }
})

async function waitSim(seconds, capMs = 60000) {
  const now = () => page.evaluate(() => window.__GAME__?.race?.state?.time ?? 0)
  const start = await now()
  const t0 = Date.now()
  while (Date.now() - t0 < capMs) {
    if ((await now()) - start >= seconds) return
    await page.waitForTimeout(120)
  }
}
await waitSim(0.6)

/** Park the local car on the centreline at `s`, facing `dir` (+1 down the track, -1 up it). */
const park = (s, dir, speed) => page.evaluate(([sAt, d, v]) => {
  const g = window.__GAME__
  const st = g.race.state
  const me = st.racers[g.localId] ?? st.racers[0]
  const smp = g.track.at(sAt)
  const p = g.track.surfacePoint(sAt, 0)
  me.pos.x = p.x; me.pos.y = p.y + 0.6; me.pos.z = p.z
  me.splineS = sAt; me.lateral = 0
  me.fwd.x = smp.tangent.x * d; me.fwd.y = smp.tangent.y * d; me.fwd.z = smp.tangent.z * d
  me.up.x = smp.normal.x; me.up.y = smp.normal.y; me.up.z = smp.normal.z
  me.yaw = Math.atan2(me.fwd.x, me.fwd.z)
  me.vel.x = me.fwd.x * v; me.vel.y = me.fwd.y * v; me.vel.z = me.fwd.z * v
  me.spinTime = 0; me.stunTime = 0; me.respawnTime = 0; me.driftSide = 0
  for (const r of st.racers) if (r !== me) r.pos.y = -900
  if (g.chase && g.chase.reset) g.chase.reset(me)
}, [s, dir, speed])

/** Render frames with the sim frozen. `simStep` advances the clock the HUD keys off. */
const frames = (n, simStep = 0) => page.evaluate(async ([count, dt]) => {
  const g = window.__GAME__
  const st = g.race.state
  for (let i = 0; i < count; i++) {
    if (dt > 0) { st.time += dt; st.frame++ }
    await new Promise((r) => requestAnimationFrame(() => r()))
  }
}, [n, simStep])

await page.evaluate(() => { window.__GAME__.maxSubSteps = 400 })
await park(120, 1, 30)
await waitSim(1.0)
await page.evaluate(() => { window.__GAME__.maxSubSteps = 0 })
// Speed back on after the settle, so the instruments are reading a car that is
// actually going somewhere rather than one that coasted to a stop.
await page.evaluate(() => {
  const g = window.__GAME__
  const me = g.race.state.racers[g.localId]
  me.vel.x = me.fwd.x * 30; me.vel.y = me.fwd.y * 30; me.vel.z = me.fwd.z * 30
  me.driftSide = 1; me.driftCharge = 1.0; me.driftTier = 1
  // Every instrument on at once, so every label is measured: the LIFT meter
  // only exists for the flight class, and the crosswind pill only in a gust.
  // HUD-only with the sim frozen -- the car on screen does not change.
  me.chassisId = 'vector7'; me.lift = 0.6
  me.windPush = 6
  me.item = 'seekerMissile'
})
await frames(3)

// --- measurements -----------------------------------------------------------
const measure = await page.evaluate(() => {
  const vis = (el) => {
    const st = getComputedStyle(el)
    if (st.display === 'none' || st.visibility === 'hidden' || +st.opacity <= 0.02) return false
    // `display: contents` draws no box of its own -- the desktop instrument
    // band is one -- so its 0x0 rect says nothing about its children.
    if (st.display === 'contents') return true
    const b = el.getBoundingClientRect()
    return b.width > 0 && b.height > 0 && b.right > 0 && b.bottom > 0 && b.left < innerWidth && b.top < innerHeight
  }
  const visDeep = (el) => { for (let n = el; n && n !== document.body; n = n.parentElement) if (!vis(n)) return false; return true }
  const small = []
  const all = []
  for (const root of document.querySelectorAll('.sg-hud, .sg-tools, .sgtc')) {
    for (const el of root.querySelectorAll('*')) {
      let text = ''
      for (const c of el.childNodes) if (c.nodeType === 3) text += c.textContent
      text = text.trim()
      if (!text || !visDeep(el)) continue
      const fs = parseFloat(getComputedStyle(el).fontSize)
      const row = { cls: String(el.className).split(' ')[0], text: text.slice(0, 24), px: +fs.toFixed(1) }
      all.push(row)
      if (fs < 10.95) small.push(row)
    }
  }
  const R = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } }
  const over = (a, b) => {
    if (!a || !b) return 0
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
    return w > 0 && h > 0 ? w * h : 0
  }
  const tools = [...document.querySelectorAll('.sg-tools__btn')].filter(visDeep).map(R)
  const slots = [...document.querySelectorAll('.sg-hud__items .sg-slot')].filter(visDeep).map((e) => R(e.querySelector('.sg-slot__box')))
  const hint = [...document.querySelectorAll('.sgtc-hint')].filter(visDeep).map(R)
  let slotToolOverlap = 0
  for (const s of slots) for (const t of tools) slotToolOverlap += over(s, t)
  // Everything else the top strip and the band can collide with.
  const one = (sel) => { const e = document.querySelector(sel); return e && visDeep(e) ? R(e) : null }
  const lap = one('.sg-lap'), splits = one('.sg-splits'), wind = one('.sg-hud__wind')
  const total = one('.sg-total'), meta = one('.sg-map__meta'), band = one('.sg-hud__band')
  const pads = [...document.querySelectorAll('.sgtc-pad, .sgtc-btn, .sgtc-knob, .sgtc-base')].filter(visDeep).map(R)
    .filter((b) => b.w > 20 && b.h > 20)
  let lapToolOverlap = 0, windToolOverlap = 0
  for (const t of tools) { lapToolOverlap += over(lap, t) + over(splits, t); windToolOverlap += over(wind, t) }
  let bandPadOverlap = 0
  for (const p of pads) bandPadOverlap += over(band, p)
  const tot = document.querySelector('.sg-lap__tot')
  return {
    compact: document.documentElement.classList.contains('sg-compact'),
    vw: innerWidth, vh: innerHeight,
    small, count: all.length,
    minPx: all.reduce((m, r) => Math.min(m, r.px), 99),
    tools, slots, hint, slotToolOverlap, lapToolOverlap, windToolOverlap, wind,
    totalMetaOverlap: over(total, meta), total, meta, band, bandPadOverlap,
    lapTotColor: tot ? getComputedStyle(tot).color : null,
    lapTotBg: tot ? getComputedStyle(tot.parentElement).backgroundColor : null,
  }
})
console.log(`\n=== ${MODE} ${VP.width}x${VP.height} (${TAG}) compact=${measure.compact} ===`)
console.log(`text nodes: ${measure.count}, smallest ${measure.minPx}px, under 11px: ${measure.small.length}`)
for (const s of measure.small) console.log(`  ${s.px}px  .${s.cls}  "${s.text}"`)
console.log(`tool buttons: ${JSON.stringify(measure.tools)}`)
console.log(`item slots:   ${JSON.stringify(measure.slots)}`)
console.log(`slot/tool overlap: ${measure.slotToolOverlap}px^2   lap+splits/tool: ${measure.lapToolOverlap}px^2   wind/tool: ${measure.windToolOverlap}px^2 (wind ${JSON.stringify(measure.wind)})`)
console.log(`score total/minimap clock overlap: ${measure.totalMetaOverlap}px^2  total ${JSON.stringify(measure.total)} clock ${JSON.stringify(measure.meta)}`)
console.log(`band ${JSON.stringify(measure.band)} overlapping touch pads by ${measure.bandPadOverlap}px^2`)
console.log(`tilt button:  ${JSON.stringify(measure.hint)}`)
console.log(`lap total ink ${measure.lapTotColor} on ${measure.lapTotBg}`)
await page.screenshot({ path: join(OUT, `hud-${TAG}-${MODE}-race.png`) })

// The longest tier name, and what it sits beside. SINGULARITY is the widest
// word the drift ladder ever prints and the one most likely to collide.
const tier = await page.evaluate(async () => {
  const g = window.__GAME__
  const me = g.race.state.racers[g.localId]
  me.driftTier = 3; me.driftCharge = 3
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  const R = (sel) => {
    const e = document.querySelector(sel)
    if (!e) return null
    const st = getComputedStyle(e)
    if (st.display === 'none') return null
    const b = e.getBoundingClientRect()
    return b.width > 0 ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null
  }
  const over = (a, b) => {
    if (!a || !b) return 0
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
    return w > 0 && h > 0 ? w * h : 0
  }
  const name = R('.sg-gauge__barTier'), ring = R('.sg-gauge__tier')
  const spd = R('.sg-gauge__spd'), bolt = R('.sg-charge__icon'), bar = R('.sg-gauge__barTrack')
  const lbl = document.querySelector('.sg-gauge__barTier') || document.querySelector('.sg-gauge__tier')
  return {
    text: lbl ? lbl.textContent : '', flat: name, ring, bar, spd, bolt,
    hitsSpeed: over(name, spd), hitsCharge: over(name, bolt),
  }
})
console.log(`tier label: ${JSON.stringify(tier)}`)
await page.screenshot({ path: join(OUT, `hud-${TAG}-${MODE}-tier3.png`) })
await page.evaluate(() => {
  const g = window.__GAME__
  const me = g.race.state.racers[g.localId]
  me.driftTier = 1; me.driftCharge = 1
})

// --- the states ---------------------------------------------------------------
async function shoot(name, setup, simStep = 0, n = 4) {
  await page.evaluate(setup)
  await frames(n, simStep)
  await page.screenshot({ path: join(OUT, `hud-${TAG}-${MODE}-${name}.png`) })
  const on = await page.evaluate(() => {
    const txt = (sel) => { const e = document.querySelector(sel); return e && !e.closest('[hidden]') ? e.textContent : null }
    const warns = [...document.querySelectorAll('.sg-warn')].filter((w) => !w.hidden).length
    return {
      spin: txt('.sg-ctr__spinTxt'), wrong: txt('.sg-ctr__wrong'), chip: txt('.sg-ctr__chip'), warns,
    }
  })
  console.log(`${name.padEnd(8)} ${JSON.stringify(on)}`)
}

// A gatling round and a seeker, both behind and closing. The round is the
// noise the old rim drew as an Alpha; the seeker is the threat.
await shoot('rim', () => {
  const g = window.__GAME__
  const st = g.race.state
  const me = st.racers[g.localId] ?? st.racers[0]
  const other = st.racers.find((r) => r !== me)
  const mk = (kind, back, lat, speed, target) => {
    const p = { x: me.pos.x - me.fwd.x * back + lat, y: me.pos.y, z: me.pos.z - me.fwd.z * back }
    st.projectiles.push({
      id: 9000 + st.projectiles.length, kind, ownerId: other.id, targetId: target,
      pos: p, vel: { x: me.fwd.x * speed, y: 0, z: me.fwd.z * speed },
      splineS: me.splineS - back, life: 5, alive: true,
    })
  }
  mk('bullet', 22, 3, 140, -1)
  mk('bullet', 30, -3, 140, -1)
  mk('seeker', 48, 0, 65, me.id)
})
await page.evaluate(() => { const st = window.__GAME__.race.state; for (const p of st.projectiles) p.alive = false })

await shoot('emp', () => {
  const g = window.__GAME__
  const me = g.race.state.racers[g.localId]
  me.stunTime = 1.1; me.lastHitBy = 'empBomb'
})
await page.evaluate(() => { const g = window.__GAME__; const me = g.race.state.racers[g.localId]; me.stunTime = 0; me.lastHitBy = null })
await frames(2)

await shoot('guard', () => {
  const g = window.__GAME__
  const st = g.race.state
  st.racers[g.localId].events.push({ t: 'guard' })
  st.frame++
}, 0, 3)
await page.evaluate(() => { const g = window.__GAME__; g.race.state.racers[g.localId].events.length = 0 })
await frames(40)
await shoot('ward', () => {
  const g = window.__GAME__
  const st = g.race.state
  st.racers[g.localId].events.push({ t: 'ward', item: 'railMissile' })
  st.frame++
}, 0, 3)
// The sim is frozen, so nothing clears `events` the way a step would; left in
// place, the next frame-counter bump below would read this ward again.
await page.evaluate(() => { const g = window.__GAME__; g.race.state.racers[g.localId].events.length = 0 })
await frames(40)

// Wrong way: facing back up the track and moving that way at 25 m/s, with the
// HUD's clock advanced a sim second in twenty steps.
await park(160, -1, 25)
await frames(2)
await shoot('wrong', () => {}, 0.05, 20)

console.log(`console errors: ${errors.length}`)
if (errors.length) console.log(errors.slice(0, 5).join('\n'))
await browser.close()
server.close()
process.exit(0)
