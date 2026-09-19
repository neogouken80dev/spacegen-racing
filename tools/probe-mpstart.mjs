/**
 * A LOBBY START, DRIVEN AND PHOTOGRAPHED.
 *
 * Runs the real front end through title -> multiplayer -> create -> ready ->
 * Start against the mock service, and then measures the things a still frame
 * cannot show: which slot the sim thinks is local, whether the camera is behind
 * that car, whether the plate roster excludes it, and whether a saved Grand
 * Circuit is still exactly where it was.
 *
 * The second half fires the SAME packet body with `localPlayerId` re-stamped to
 * another human on the grid -- which is byte-for-byte what net/mock.ts's
 * notifyStart hands every guest ({ ...body, localPlayerId: c.playerId }) -- so
 * the non-zero-slot case is a real guest's packet and not an invention.
 *
 * NEEDS dist/: run `npx vite build` first.
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { join, extname } from 'node:path'

const ROOT = new URL('file:///home/claude/spacegen/dist/').pathname
const OUT = '/home/claude/spacegen/shots/mpstart/'
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
}
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0])
    if (p === '/api/leaderboard') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ rows: [], rank: 0 }))
      return
    }
    if (p === '/' || p.endsWith('/')) p += 'index.html'
    const buf = await readFile(join(ROOT, p))
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' })
    res.end(buf)
  } catch { res.writeHead(404); res.end('nf') }
})
await new Promise((r) => server.listen(0, r))
const url = `http://127.0.0.1:${server.address().port}/?net=perfect`
await mkdir(OUT, { recursive: true })

const errors = []
const note = (m) => { errors.push(m); console.log('  !! ' + m) }
const say = (m) => console.log('  ' + m)

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist'],
})
const ctx = await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1 })
const page = await ctx.newPage()
page.on('pageerror', (e) => note('page error: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') note('console: ' + m.text()) })

// A saved Grand Circuit, planted before the game boots so the game reads it the
// way it reads a real one. Written with the module's own serialiser format --
// version, signature, grid, rounds -- by letting the page do it is impossible
// before load, so instead: boot once, make one through the UI, read it back.
await page.addInitScript(() => { window.__MP_PROBE__ = true })

await page.goto(url, { waitUntil: 'load', timeout: 40000 })
await page.waitForFunction(() => !!window.__GAME__, null, { timeout: 60000 })
await page.waitForTimeout(2500)
await page.evaluate(() => { window.__GAME__.maxSubSteps = 400 })

// --- plant a Grand Circuit --------------------------------------------------
// Through the shipping path: New circuit writes one to localStorage.
await page.evaluate(() => { window.__GAME__.frontEnd.onCircuitNew() })
await page.waitForTimeout(400)
const circuitBefore = await page.evaluate(() => window.localStorage.getItem('sg.circuit'))
if (!circuitBefore) note('could not plant a Grand Circuit to test against')
else say(`planted a Grand Circuit (${circuitBefore.length} bytes)`)
// Back to the title, which is where a player would go to reach multiplayer.
await page.evaluate(() => { window.__GAME__.frontEnd.show('title') })
await page.waitForTimeout(800)
const activeBefore = await page.evaluate(() => window.__GAME__.circuitActive)
say(`circuitActive on the title screen: ${activeBefore}`)

// --- the real flow ----------------------------------------------------------
await page.locator('.sg-title__multi .sg-btn--violet').click()
await page.waitForSelector('.sglb--browser', { state: 'visible', timeout: 20000 })
await page.waitForTimeout(1200)
// Create.
await page.locator('.sglb--browser .sglb__foot .sg-btn:not(.sg-btn--gold)').last().click()
await page.waitForSelector('.sglb--create', { state: 'visible', timeout: 20000 })
await page.locator('.sglb--create .sglb__in').fill('Wiring probe')
// A circuit that is NOT the one the game boots on, so the track change is real.
const WANT_TRACK = 'neonspire'
await page.locator(`.sglb--create .sglb__track[data-track="${WANT_TRACK}"]`).click()
await page.locator('.sglb--create [data-max="4"]').click()
await page.locator('.sglb--create [data-laps="3"]').click()
await page.waitForTimeout(200)
await page.locator('.sglb--create .sg-btn--start').click()
await page.waitForSelector('.sglb--room', { state: 'visible', timeout: 20000 })
say('room created')

// Hook the seam under test BEFORE anything can fire it, and keep the game's own
// handler: this records the packet, it does not replace the wiring.
await page.evaluate(() => {
  const fe = window.__GAME__.frontEnd
  const real = fe.onMultiplayerStart
  window.__PACKETS__ = []
  fe.onMultiplayerStart = (p) => { window.__PACKETS__.push(p); real(p) }
  window.__FIRE__ = (p) => real(p)
})

// Ready up and wait for company and for everybody to be ready.
const readRoom = () => page.evaluate(() => {
  const start = document.querySelector('.sglbr__start')
  return {
    why: document.querySelector('.sglbr__why')?.textContent?.trim() ?? '',
    startDisabled: start ? start.disabled : null,
    ready: document.querySelector('.sglbr__ready')?.textContent ?? '',
    members: [...document.querySelectorAll('.sglbr__member')].map((m) => ({
      you: !!m.querySelector('.sg-you'),
      name: m.querySelector('.sglbr__who')?.textContent ?? '',
      state: m.querySelector('.sglbr__mstate')?.dataset.state ?? '',
    })),
    racing: !!window.__GAME__.race && window.__GAME__.phase === 'racing',
  }
})

let started = false
for (let i = 0; i < 140; i++) {
  const r = await readRoom()
  if (r.racing || (await page.evaluate(() => window.__PACKETS__.length)) > 0) { started = true; break }
  const me = r.members.find((m) => m.you)
  if (me && me.state !== 'ready' && me.state !== 'connecting') {
    await page.locator('.sglbr__ready').click().catch(() => {})
  }
  if (r.startDisabled === false && r.members.length >= 2) {
    say(`pressing Start with ${r.members.length} in the room`)
    await page.locator('.sglbr__start').click()
    started = true
    break
  }
  await page.waitForTimeout(700)
}
if (!started) note('never reached a startable room')

await page.waitForFunction(() => (window.__PACKETS__ || []).length > 0, null, { timeout: 30000 })
  .catch(() => note('no start packet ever reached the front end'))
await page.waitForTimeout(4500)

const packet = await page.evaluate(() => window.__PACKETS__[0])
say('')
say('=== THE PACKET ===')
say(`track ${packet.trackId}  laps ${packet.laps}  seed ${packet.seed}  `
  + `inputDelay ${packet.inputDelay}  localPlayerId ${packet.localPlayerId}`)
for (const s of packet.grid) {
  say(`   slot ${s.slot}  ${String(s.name).padEnd(14)} ${String(s.chassisId).padEnd(10)} `
    + `${String(s.pilotId).padEnd(10)} host=${s.isHost ? 'y' : 'n'} `
    + `player=${s.playerId ?? '-'} skill=${s.aiSkill ?? '-'}`)
}

const measure = () => page.evaluate(() => {
  const g = window.__GAME__
  const r = g.race
  const local = r ? r.state.racers[g.localId] : null
  const cam = g.chase.camera.position
  const dist = (c) => Math.hypot(cam.x - c.pos.x, cam.y - c.pos.y, cam.z - c.pos.z)
  const dists = r ? r.state.racers.map((c) => +dist(c).toFixed(1)) : []
  let nearest = -1, best = Infinity
  dists.forEach((d, i) => { if (d < best) { best = d; nearest = i } })
  const cam3 = g.chase.camera
  cam3.updateMatrixWorld(true)
  const ndc = r ? r.state.racers.map((c) => {
    const v = new (Object.getPrototypeOf(cam3.position).constructor)(c.pos.x, c.pos.y, c.pos.z)
    v.project(cam3)
    return { x: +v.x.toFixed(3), y: +v.y.toFixed(3), z: +v.z.toFixed(3) }
  }) : []
  let centred = -1, bestC = Infinity
  ndc.forEach((v, i) => {
    if (v.z > 1) return
    const d = Math.hypot(v.x, v.y)
    if (d < bestC) { bestC = d; centred = i }
  })
  return {
    phase: g.phase,
    trackId: g.track.def.id,
    localId: g.localId,
    localRacerIndex: r ? r.config.localRacerIndex : null,
    seed: r ? r.config.seed : null,
    totalLaps: r ? r.config.totalLaps : null,
    grid: r ? r.state.racers.map((c) => ({ id: c.id, chassisId: c.chassisId, pilotId: c.pilotId, isLocal: c.isLocal, isAI: c.isAI, aiSkill: c.aiSkill })) : [],
    camDistToLocal: r ? +dist(local).toFixed(1) : null,
    camNearestCar: nearest,
    camCentredCar: centred,
    ndc,
    camDists: dists,
    plateRoster: g.plates ? g.plates.stats.roster : null,
    plateSlots: g.nameplateRoster ? g.nameplateRoster.grid.map((s) => s.slot) : null,
    rosterLocalPlayerId: g.nameplateRoster ? g.nameplateRoster.localPlayerId : null,
    hudPos: document.querySelector('.sghud__posNum')?.textContent
      ?? document.querySelector('[class*=pos]')?.textContent ?? '',
    hudText: (document.querySelector('.sg-hud')?.textContent ?? '').slice(0, 220),
    circuitActive: g.circuitActive,
    circuitSave: window.localStorage.getItem('sg.circuit'),
    multiplayerHeld: !!g.multiplayer,
  }
})

const shoot = async (name) => {
  const f = OUT + name + '.png'
  await page.screenshot({ path: f })
  return f
}

const a = await measure()
say('')
say('=== HOST CLIENT (the packet as the host reads it) ===')
say(JSON.stringify({ ...a, grid: undefined, camDists: undefined, circuitSave: undefined, hudText: undefined, ndc: undefined }, null, 1))
say('grid: ' + a.grid.map((c) => `${c.id}:${c.chassisId}${c.isLocal ? '*' : ''}`).join(' '))
say('cam distances: ' + a.camDists.join(' '))
say('shot ' + await shoot('host-slot' + a.localId))

// --- the same packet, read by a guest ---------------------------------------
const guestSlots = packet.grid.filter((s) => s.playerId && s.playerId !== packet.localPlayerId).map((s) => s.slot)
const guestSlot = guestSlots.length ? guestSlots[guestSlots.length - 1] : -1
say('other humans on the grid: ' + JSON.stringify(guestSlots))
if (guestSlot < 0) {
  note('only one human on the grid — cannot exercise a non-zero local slot end to end')
} else {
  say('')
  say(`=== GUEST CLIENT — the same broadcast, localPlayerId re-stamped to slot ${guestSlot} ===`)
  await page.evaluate((slot) => {
    const body = window.__PACKETS__[0]
    window.__FIRE__({ ...body, localPlayerId: body.grid[slot].playerId })
  }, guestSlot)
  await page.waitForTimeout(4500)
  const b = await measure()
  say(JSON.stringify({ ...b, grid: undefined, camDists: undefined, circuitSave: undefined, hudText: undefined, ndc: undefined }, null, 1))
  say('grid: ' + b.grid.map((c) => `${c.id}:${c.chassisId}${c.isLocal ? '*' : ''}`).join(' '))
  say('cam distances: ' + b.camDists.join(' '))
  say('hud: ' + JSON.stringify(b.hudText))
  say('shot ' + await shoot('guest-slot' + b.localId))

  if (b.localId !== guestSlot) note(`localId is ${b.localId}, packet says slot ${guestSlot}`)
  if (b.localRacerIndex !== guestSlot) note(`sim localRacerIndex is ${b.localRacerIndex}`)
  const fa = { x: a.ndc[a.localId].x, y: a.ndc[a.localId].y, d: a.camDistToLocal }
  const fb = { x: b.ndc[guestSlot].x, y: b.ndc[guestSlot].y, d: b.camDistToLocal }
  say(`framing  host car ${a.localId}: ndc ${fa.x.toFixed(2)},${fa.y.toFixed(2)} at ${fa.d}m`)
  say(`framing guest car ${guestSlot}: ndc ${fb.x.toFixed(2)},${fb.y.toFixed(2)} at ${fb.d}m`)
  if (Math.abs(fa.x - fb.x) > 0.08 || Math.abs(fa.y - fb.y) > 0.08) {
    note('the local car is not framed the same way for the two readers')
  }
  if (Math.abs(fa.d - fb.d) > 2) note(`the chase distance changed: ${fa.d} -> ${fb.d}`)
  if (b.ndc[guestSlot].z > 1) note(`car ${guestSlot} is behind the camera`)
  if (b.grid.filter((c) => c.isLocal).length !== 1) note('not exactly one car is local')
  if (b.grid[guestSlot] && !b.grid[guestSlot].isLocal) note('the packet slot is not the local car')
  for (let i = 0; i < packet.grid.length; i++) {
    if (b.grid[i].chassisId !== packet.grid[i].chassisId) {
      note(`slot ${i} chassis ${b.grid[i].chassisId} != packet ${packet.grid[i].chassisId}`)
    }
    if (b.grid[i].pilotId !== packet.grid[i].pilotId) {
      note(`slot ${i} pilot ${b.grid[i].pilotId} != packet ${packet.grid[i].pilotId}`)
    }
  }
  if (b.seed !== packet.seed) note(`seed ${b.seed} != packet ${packet.seed}`)
  if (b.totalLaps !== packet.laps) note(`laps ${b.totalLaps} != packet ${packet.laps}`)
  if (b.trackId !== packet.trackId) note(`track ${b.trackId} != packet ${packet.trackId}`)
  if (b.circuitActive) note('the Grand Circuit is still active during a lobby race')
  if (b.circuitSave !== circuitBefore) note('the saved Grand Circuit changed')
  const humans = packet.grid.filter((s) => s.playerId).length
  if (b.plateRoster !== packet.grid.length - 1) {
    note(`plate roster is ${b.plateRoster}, expected ${packet.grid.length - 1} (everyone but you)`)
  }
  say(`humans on the grid: ${humans}; plates in the roster: ${b.plateRoster}`)
}

// --- back out to a single race: the roster and the packet must go -----------
say('')
say('=== LEAVING THE LOBBY ===')
await page.evaluate(() => {
  const g = window.__GAME__
  g.frontEnd.onStart({ trackId: 'rustfall', chassisId: 'solaire', pilotId: 'socket', quality: g.tier })
})
await page.waitForTimeout(3000)
const c = await measure()
say(JSON.stringify({ phase: c.phase, trackId: c.trackId, localId: c.localId,
  localRacerIndex: c.localRacerIndex, plateRoster: c.plateRoster,
  multiplayerHeld: c.multiplayerHeld, circuitActive: c.circuitActive }, null, 1))
if (c.multiplayerHeld) note('a single race still holds the lobby packet')
if (c.plateRoster) note('a single race still draws the lobby name plates')
if (c.localId !== 0) note('a single race did not put the player on pole')
if (c.circuitSave !== circuitBefore) note('the saved Grand Circuit changed after all')
say('shot ' + await shoot('after-single-race'))

say('')
console.log(errors.length ? `\nPROBE FAILED (${errors.length})` : '\nPROBE PASSED')
await browser.close()
server.close()
process.exit(errors.length ? 1 : 0)
