/**
 * NAME PLATES, PHOTOGRAPHED — because legibility is not a unit test.
 *
 * tests/nameplates.test.ts pins everything that is arithmetic: the local
 * player is excluded twice over, an anchor rides the car's own up-vector
 * through a barrel roll, the overlap rule drops the plate it says it drops, a
 * missing portrait degrades to a name. None of that answers the only question
 * that matters about this feature, which is WHETHER YOU CAN READ IT. So this
 * takes pictures of the five situations that decide that, and measures the
 * three things about them that can be measured.
 *
 * THE CASES, AND WHY EACH ONE IS HERE
 *
 *   1. THE FIRST-CORNER BUNCH. Seven rivals inside a car length of each other,
 *      which is the frame this feature is most likely to ruin. Measured: how
 *      many plates survived, how much ink is on screen, and the worst
 *      remaining overlap in square pixels. A picture of eight overlapping
 *      labels and a picture of two clean ones are both "plates drawn".
 *   2. A CAR FAR AWAY. Placed down the road and photographed with its measured
 *      camera distance, so the claim "still readable at 150 m" is a
 *      photograph next to a number rather than an adjective.
 *   3. A CAR INSIDE THE DRUM. Centurion Prime's barrel rolls the world through
 *      360 degrees. The plate must stay upright on screen and must stay over
 *      the ROOF, which on the ceiling of the drum is BELOW the car in world
 *      terms. Measured off the system's own published anchors, then shot.
 *   4. A CAR BEHIND SOMETHING. Also on the drum: a rival on the far side of
 *      the barrel has the road itself between it and the camera. The claim is
 *      that its plate survives at GHOST_ALPHA rather than vanishing or
 *      reading as if the car were in front -- so the pixels inside its rect
 *      are sampled and compared against the same plate unoccluded. That is a
 *      measurement of the depth decision, not a look at it.
 *   5. MOBILE PORTRAIT, 412 x 915. Same bunch. Measured: the plate's share of
 *      the screen width, and that the clutter budget actually bit.
 *
 * ...plus THE COST, taken the way tools/probe-podium.mjs takes it: the
 * renderer's own counters for one explicit scene render, with the roster
 * installed and again with it cleared, on the same frame of the same race.
 *
 * WHY THE FIELD IS FROZEN. Every case above is a specific geometry, and under
 * SwiftShader this page delivers between one and five frames a second -- so
 * anything driven for real would be photographed somewhere different on every
 * run. `race.step` is wrapped to restore a snapshot, exactly as
 * tools/probe-blast.mjs does it, and the cars then stay where they are put.
 *
 * NEEDS dist/: run `npx vite build` FIRST or you will photograph the last
 * bundle, which has cost this project real time more than once.
 *
 *   node tools/probe-nameplates.mjs                       # drum: 1-4 + cost
 *   node tools/probe-nameplates.mjs --track=rustfall      # flat baseline
 *   node tools/probe-nameplates.mjs --mobile              # case 5
 *   node tools/probe-nameplates.mjs --reduced             # the calm pass
 *   node tools/probe-nameplates.mjs --tier=low            # one pass, no ghost
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { PNG } from 'pngjs'

const ROOT = new URL('../dist/', import.meta.url).pathname
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
const url = `http://127.0.0.1:${server.address().port}/`

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.split('=')[1] : d
}
const MOBILE = process.argv.includes('--mobile')
const REDUCED = process.argv.includes('--reduced')
const TIER = arg('tier', '')
const TRACK = arg('track', 'hollowchoir')
const VIEWPORT = MOBILE ? { width: 412, height: 915 } : { width: 1440, height: 810 }
const KIND = (MOBILE ? 'mobile' : 'desktop') + (REDUCED ? '-calm' : '')
  + (TIER ? '-' + TIER : '') + '-' + TRACK
const OUT = new URL('../shots/nameplates/', import.meta.url).pathname
await mkdir(OUT, { recursive: true })

const errors = []
const note = (m) => { errors.push(m); console.log('  !! ' + m) }

const TRACK_NAME = {
  rustfall: 'Elkarim', cryostatic: 'Frosthelm', aetherion: 'Namaresh',
  hollowchoir: 'Centurion Prime', emberfall: 'Ashkar', abyssal: 'Meridian Deep',
  halcyon: 'Halcyon Bay', neonspire: 'Zhen-9',
}[TRACK] ?? TRACK

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist'],
})
const ctx = await browser.newContext({
  viewport: VIEWPORT,
  hasTouch: MOBILE,
  isMobile: MOBILE,
  deviceScaleFactor: 1,
  reducedMotion: REDUCED ? 'reduce' : 'no-preference',
})
const page = await ctx.newPage()
page.on('pageerror', (e) => note('page error: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') note('console: ' + m.text()) })

await page.goto(url, { waitUntil: 'load', timeout: 40000 })
await page.waitForFunction(() => !!window.__GAME__, null, { timeout: 60000 })
await page.waitForTimeout(2200)
await page.evaluate(() => { window.__GAME__.maxSubSteps = 400 })

// --- the shipping front end, to the shipping race ---------------------------
const clickText = async (labels) => {
  for (const t of labels) {
    const el = page.locator('button, .sg-btn').filter({ hasText: t }).first()
    if (await el.count() && await el.isVisible().catch(() => false)) { await el.click(); return }
  }
}
await clickText(['PLAY NOW', 'PLAY', 'Play'])
await page.waitForSelector('.sg-screen--track .sg-card--track', { state: 'visible', timeout: 20000 })
await page.locator('.sg-screen--track .sg-card--track')
  .filter({ hasText: TRACK_NAME }).first().click()
await page.waitForTimeout(900)
await page.locator('.sg-screen--track .sg-btn--start').click()
await page.waitForSelector('.sg-screen--garage .sg-btn--start', { state: 'visible', timeout: 20000 })
await page.locator('.sg-screen--garage .sg-btn--start').click()
await page.waitForTimeout(3500)

/**
 * PIN THE TIER, AFTER Start.
 *
 * SwiftShader runs this at a handful of frames a second and the adaptive
 * scaler -- correctly -- steps the game down, which on `low` deletes the ghost
 * pass this probe is partly about. Pinned after the front end's own quality
 * apply, which runs on the way into the race.
 */
await page.evaluate((t) => {
  const g = window.__GAME__
  g.qualityCooldown = 1e9
  if (t && g.tier !== t) g.setTier(t)
}, TIER)
await page.waitForTimeout(1500)

// Countdown out of the way, then freeze the world.
await page.evaluate(() => {
  const g = window.__GAME__
  if (g.race) { g.race.state.countdown = 0; g.race.state.phase = 'racing' }
})
await page.waitForTimeout(600)

/**
 * THE ROSTER, BUILT THE WAY A LOBBY BUILDS ONE.
 *
 * Four people and four bots, which is the shape of most lobbies that do not
 * fill, and the local player is NOT slot 0 -- they are slot 2. That is
 * deliberate: the most likely way this feature ships broken is an
 * implementation that assumes the reader is the host, and every screenshot
 * below would then quietly have a plate nailed over the player's own roof.
 * Put the player in the middle of the grid and the bug is in the pictures.
 *
 * Names are chosen for length: the shortest and longest the claim rules allow
 * (3 and 12 characters, see NAME_RULES) are both on the grid, so every shot
 * exercises the variable-width plate at both ends.
 */
const LOCAL_SLOT = 2
const roster = await page.evaluate((localSlot) => {
  const g = window.__GAME__
  const AVATARS = ['cadet', 'wrench', 'nomad', 'marshal', 'neonsaint']
  const NAMES = ['Ada', 'Quartermain', 'Vince', 'Sol_Ky-9', 'MERIDIAN',
    'ORBITAL', 'HALEN', 'DRAY']
  const grid = g.race.state.racers.map((r, i) => ({
    slot: i,
    playerId: i < 4 ? `p-${i}` : null,
    name: NAMES[i],
    avatarId: i < 4 ? AVATARS[i] : null,
    chassisId: r.chassisId,
    pilotId: r.pilotId,
    isHost: i === 0,
    aiSkill: i < 4 ? null : 3,
  }))
  // The sim decides who is local; tell it the same thing the packet does.
  g.race.state.racers.forEach((r, i) => { r.isLocal = i === localSlot })
  g.localId = localSlot
  const r = { grid, localPlayerId: `p-${localSlot}` }
  g.__roster = r
  g.setNameplateRoster(r)
  return {
    roster: g.plates.stats.roster,
    names: grid.map((s) => s.name),
    humans: grid.filter((s) => s.playerId).map((s) => s.slot),
  }
}, LOCAL_SLOT)
console.log(`\n=== NAME PLATES — ${TRACK_NAME} (${TRACK}) · ${KIND} ===`)
console.log('  grid                :', roster.names.join(', '))
console.log('  humans              :', roster.humans.join(', '), `| local = slot ${LOCAL_SLOT}`)
console.log('  plates in roster    :', roster.roster, '(of 8 racers)')
if (roster.roster !== 7) note(`the roster produced ${roster.roster} plates, expected 7`)

// --- freeze ----------------------------------------------------------------
// Snapshot-restore per step, so a placement survives however many sim steps
// the render loop decides to run between screenshots.
await page.evaluate(() => {
  const g = window.__GAME__
  const race = g.race
  race.__frozen = race.state.racers.map((r) => ({
    pos: { ...r.pos }, vel: { ...r.vel }, fwd: { ...r.fwd }, up: { ...r.up },
    yaw: r.yaw, splineS: r.splineS, totalS: r.totalS, lateral: r.lateral,
    altitude: r.altitude,
  }))
  const orig = race.step.bind(race)
  race.step = function () {
    orig()
    race.state.racers.forEach((r, i) => {
      const s = race.__frozen[i]
      Object.assign(r.pos, s.pos); Object.assign(r.vel, s.vel)
      Object.assign(r.fwd, s.fwd); Object.assign(r.up, s.up)
      r.yaw = s.yaw; r.yawRate = 0
      r.splineS = s.splineS; r.totalS = s.totalS; r.lateral = s.lateral
      r.altitude = s.altitude
      r.driftSide = 0; r.spinTime = 0; r.stunTime = 0; r.respawnTime = 0
      r.boostMag = 0; r.vertVel = 0
    })
  }
})

// ---------------------------------------------------------------------------
// Placement, in the page
// ---------------------------------------------------------------------------

/**
 * Put racer `id` on the road at arc-length `s`, `lat` metres off the
 * centreline, `up` metres above the surface, facing along the tangent.
 *
 * The SURFACE BASIS is set with the position and that is not optional: on a
 * gravity track `yaw` is a derived bearing and the real orientation is
 * (fwd, up). A teleport that left those alone puts the camera in the start
 * straight's frame at the top of a barrel -- see the same note in
 * tools/probe-shots.mjs, where it cost a whole run of screenshots.
 */
const place = (id, s, lat, up = 1.2) => page.evaluate(([id, s, lat, up]) => {
  const g = window.__GAME__
  const track = g.track
  const r = g.race.state.racers[id]
  const smp = track.at(s)
  const p = track.surfacePoint(s, lat)
  r.pos.x = p.x + smp.normal.x * up
  r.pos.y = p.y + smp.normal.y * up
  r.pos.z = p.z + smp.normal.z * up
  r.splineS = s; r.totalS = s; r.lateral = lat
  r.fwd.x = smp.tangent.x; r.fwd.y = smp.tangent.y; r.fwd.z = smp.tangent.z
  r.up.x = smp.normal.x; r.up.y = smp.normal.y; r.up.z = smp.normal.z
  r.yaw = Math.atan2(smp.tangent.x, smp.tangent.z)
  r.vel.x = 0; r.vel.y = 0; r.vel.z = 0
  r.altitude = up
  const f = g.race.__frozen[id]
  f.pos = { ...r.pos }; f.vel = { ...r.vel }; f.fwd = { ...r.fwd }; f.up = { ...r.up }
  f.yaw = r.yaw; f.splineS = s; f.totalS = s; f.lateral = lat; f.altitude = up
  return { up: { ...r.up }, pos: { ...r.pos } }
}, [id, s, lat, up])

/** Wait on SIM time, never on the clock -- see tools/probe-shots.mjs. */
async function waitSim(seconds, capMs = 90000) {
  const now = () => page.evaluate(() => window.__GAME__?.race?.state?.time ?? 0)
  const start = await now()
  const t0 = Date.now()
  while (Date.now() - t0 < capMs) {
    if ((await now()) - start >= seconds) return
    await page.waitForTimeout(150)
  }
}

/**
 * SNAP THE CHASE RIG ONTO THE CAR, THEN WAIT FOR IT TO STOP MOVING.
 *
 * This is the single most expensive lesson in this probe. The rig EASES toward
 * its car -- that is its whole job -- so a teleport of eight hundred metres is
 * followed by a long flight, and under SwiftShader that flight is a handful of
 * frames spread over ten seconds of wall clock. Every measurement taken during
 * it is of a camera that is somewhere else by the next reading: the first cut
 * of this file measured the draw-call cost of the name plates as MINUS ONE and
 * sixteen thousand fewer triangles, which is not a cost, it is two different
 * frames of two different parts of the track.
 *
 * `chase.reset` is the shipping call startRace uses to put the rig on the grid,
 * so this is not a special path -- and the poll afterwards is what makes the
 * "settled" claim true rather than hoped for.
 */
async function settleCamera(maxMs = 60000) {
  // SIM TIME FIRST. The render copies the visuals and the plates are anchored
  // to are INTERPOLATED between sim steps -- `prevX` in game/main.ts -- so for
  // one step after a teleport a car's drawn position is still lerping out of
  // where it used to be. Read too early and every plate reports the distance
  // to the STARTING GRID; photographed too early and half of them are culled
  // for being 250 m away. Both happened.
  await waitSim(0.35)
  await page.evaluate(() => {
    const g = window.__GAME__
    const r = g.race.state.racers[g.localId]
    g.chase.gravity = g.track.hasGravity
    g.chase.reset(r)
    g.chase.endCinematic()
  })
  const at = () => page.evaluate(() => {
    const c = window.__GAME__.chase.camera
    return [c.position.x, c.position.y, c.position.z]
  })
  let last = await at()
  const t0 = Date.now()
  let still = 0
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(220)
    const now = await at()
    const d = Math.hypot(now[0] - last[0], now[1] - last[1], now[2] - last[2])
    last = now
    if (d < 0.05) { if (++still >= 2) { await waitSim(0.35); return } }
    else still = 0
  }
  note('the chase camera never settled')
}

/** Everything the plate system published for the last rendered frame. */
const readPlates = () => page.evaluate(() => {
  const g = window.__GAME__
  const st = g.race.state
  return {
    stats: { ...g.plates.stats },
    plates: g.plates.plates.map((p) => ({
      slot: p.slot, name: p.name, human: p.human,
      alpha: +p.alpha.toFixed(3), target: +p.target.toFixed(3),
      dist: +p.dist.toFixed(1), suppressed: p.suppressed,
      rect: p.rect ? {
        x: Math.round(p.rect.x), y: Math.round(p.rect.y),
        w: Math.round(p.rect.w), h: Math.round(p.rect.h),
      } : null,
      // The world offset from the car to the plate, and the car's own up, so
      // the loop claim is checkable off the report rather than by eye.
      lift: (() => {
        const r = st.racers[p.slot]
        return {
          d: [+(p.anchor.x - r.pos.x).toFixed(3), +(p.anchor.y - r.pos.y).toFixed(3),
            +(p.anchor.z - r.pos.z).toFixed(3)],
          up: [+r.up.x.toFixed(3), +r.up.y.toFixed(3), +r.up.z.toFixed(3)],
        }
      })(),
    })),
  }
})

/**
 * The renderer's OWN counters for the scene pass.
 *
 * `renderer.info.render` is reset on every render() call, and with the post
 * chain on, the LAST call of a frame is the composite's fullscreen blit -- so
 * reading it after a normal frame reports one draw call for every scene in the
 * game. Issuing one explicit scene render and reading immediately is the only
 * way this number means anything. Lifted verbatim from tools/probe-podium.mjs,
 * so the two features' costs are comparable.
 */
const readCost = () => page.evaluate(() => {
  const g = window.__GAME__
  const snap = () => {
    g.renderer.render(g.scene, g.chase.camera)
    const i = g.renderer.info
    return { calls: i.render.calls, tris: i.render.triangles, textures: i.memory.textures }
  }
  /**
   * THE A/B IS TWO RENDERS OF ONE FRAME, NOT TWO FRAMES.
   *
   * The only difference between them is `plates.group.visible`. Anything that
   * lets the camera move between the two readings -- a wait, a sim step, a
   * screenshot -- changes which of the track is inside the frustum, and the
   * difference then measures the scenery rather than the plates.
   */
  const withPlates = snap()
  const was = g.plates.group.visible
  g.plates.group.visible = false
  const without = snap()
  g.plates.group.visible = was
  return {
    tier: g.tier,
    with: withPlates,
    without,
    stats: { ...g.plates.stats },
  }
})

async function shoot(tag, quiet = false) {
  const name = `${KIND}-${tag}.png`
  const dir = quiet ? join(OUT, 'scan') : OUT
  await mkdir(dir, { recursive: true })
  await page.screenshot({ path: join(dir, name) })
  if (!quiet) console.log('    shot              :', name)
  return join(dir, name)
}

/**
 * How much two captures differ inside one rectangle: the MEAN PER-PIXEL
 * absolute luminance difference, 0..255.
 *
 * PER PIXEL, NOT A DIFFERENCE OF MEANS, and the distinction is not academic.
 * A name plate is light text on a DARK panel, so over a bright stretch of road
 * the panel pulls the average down by very nearly as much as the glyphs push
 * it up and the difference of the two means comes out near zero -- which reads
 * exactly like a plate that was not drawn. Measured on the `low` tier that is
 * precisely what happened: a plate that is plainly there in the screenshot
 * scored 4.5 against 85 for the same plate somewhere darker. Summing the
 * absolute change per pixel cannot cancel.
 */
async function diffIn(fileA, fileB, rect) {
  const [a, b] = await Promise.all([
    readFile(fileA).then((buf) => PNG.sync.read(buf)),
    readFile(fileB).then((buf) => PNG.sync.read(buf)),
  ])
  const x0 = Math.max(0, Math.round(rect.x))
  const y0 = Math.max(0, Math.round(rect.y))
  const x1 = Math.min(a.width, b.width, Math.round(rect.x + rect.w))
  const y1 = Math.min(a.height, b.height, Math.round(rect.y + rect.h))
  const lum = (p, i) => 0.2126 * p.data[i] + 0.7152 * p.data[i + 1] + 0.0722 * p.data[i + 2]
  let sum = 0, n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const ia = (y * a.width + x) * 4
      const ib = (y * b.width + x) * 4
      sum += Math.abs(lum(a, ia) - lum(b, ib))
      n++
    }
  }
  return n > 0 ? +(sum / n).toFixed(1) : 0
}

const report = {}

// ===========================================================================
// THE GEOMETRY OF THIS TRACK
// ===========================================================================
const geom = await page.evaluate(() => {
  const g = window.__GAME__
  const t = g.track
  const out = { length: +t.length.toFixed(1), gravity: !!t.hasGravity, inverted: [] }
  // Arc-lengths where the road's own up has rolled past the horizontal, which
  // on Centurion Prime is the inside of the barrel and on a loop track is the
  // top of the loop. This is the set of places the aAxis bug would show.
  for (let s = 0; s < t.length; s += 4) {
    const n = t.at(s).normal
    if (n.y < -0.25) out.inverted.push(+s.toFixed(0))
  }
  return out
})
console.log('  track             :', `${geom.length} m`, geom.gravity ? '(gravity)' : '(flat)')
console.log('  inverted road at  :', geom.inverted.length
  ? `${geom.inverted.length} samples, s=${geom.inverted[0]}..${geom.inverted[geom.inverted.length - 1]}`
  : 'nowhere')

// ===========================================================================
// CASE 1 — THE FIRST-CORNER BUNCH
// ===========================================================================
console.log('\n--- 1. the first-corner bunch ---')
{
  const S = Math.round(geom.length * 0.08)
  // The player at the back of the pack looking into it, and seven rivals
  // packed into thirty metres of road ahead: the shape of turn one.
  await place(LOCAL_SLOT, S, 0)
  const LAT = [-7, -3.5, 0, 3.5, 7, -5, 5]
  let k = 0
  for (let i = 0; i < 8; i++) {
    if (i === LOCAL_SLOT) continue
    await place(i, S + 14 + (k % 4) * 7, LAT[k])
    k++
  }
  await settleCamera()
  const r = await readPlates()
  const shown = r.plates.filter((p) => p.alpha > 0.02)
  // Worst remaining overlap between two SHOWN plates, square pixels. The whole
  // point of the rule is that this stays small; it is the number that says so.
  let worst = 0, worstPair = ''
  for (let a = 0; a < shown.length; a++) {
    for (let b = a + 1; b < shown.length; b++) {
      const A = shown[a].rect, B = shown[b].rect
      if (!A || !B) continue
      const ox = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x)
      const oy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y)
      const area = ox > 0 && oy > 0 ? ox * oy : 0
      if (area > worst) { worst = area; worstPair = `${shown[a].name}/${shown[b].name}` }
    }
  }
  const plateArea = shown.length ? shown[0].rect.w * shown[0].rect.h : 1
  console.log('  plates up         :', shown.length, 'of', r.stats.roster,
    `(suppressed ${r.stats.suppressed}, culled ${r.stats.culled})`)
  console.log('  names             :', shown.map((p) => `${p.name}@${p.dist}m`).join(', '))
  console.log('  plate size        :', shown.length
    ? `${shown[0].rect.w} x ${shown[0].rect.h} px (h target ${r.stats.heightPx.toFixed(1)})` : '-')
  console.log('  worst overlap     :', worst, 'px^2',
    `= ${(100 * worst / plateArea).toFixed(1)}% of a plate`, worstPair ? `(${worstPair})` : '')
  if (shown.length === 0) note('the bunch produced no plates at all')
  if (worst > plateArea * 0.5) {
    note(`two plates in the bunch still cover ${(100 * worst / plateArea).toFixed(0)}% of each other`)
  }
  // The local player, again, in the picture that would show it worst.
  const mine = r.plates.find((p) => p.slot === LOCAL_SLOT)
  if (mine) note('the local player has a plate in the roster')
  report.bunch = { shown: shown.length, worst, stats: r.stats, plates: shown }
  await shoot('bunch')
}

// ===========================================================================
// CASE 2 — A CAR FAR AWAY
// ===========================================================================
console.log('\n--- 2. a car far away ---')
{
  const S = Math.round(geom.length * 0.08)
  await place(LOCAL_SLOT, S, 0)
  // Everybody off the road except one rival, who walks away down the track.
  for (let i = 0; i < 8; i++) if (i !== LOCAL_SLOT) await place(i, S + 20, 400)
  await settleCamera()
  const rows = []
  for (const D of [40, 90, 150, 200, 240]) {
    await place(1, S + D, 0)
    await waitSim(0.25)
    const r = await readPlates()
    const p = r.plates.find((x) => x.slot === 1)
    rows.push({ D, dist: p.dist, alpha: p.alpha, rect: p.rect })
    console.log(`  s+${String(D).padStart(3)} m  ->  ${String(p.dist).padStart(6)} m from the lens`
      + `  alpha ${p.alpha.toFixed(2)}`
      + `  ${p.rect ? `${p.rect.w}x${p.rect.h} px at (${p.rect.x}, ${p.rect.y})` : 'off screen'}`)
    if (D === 150) await shoot('far-150')
  }
  // The claim: the plate is the same size on screen at 40 m and at 200 m.
  const near = rows.find((r) => r.D === 40)
  const far = rows.find((r) => r.D === 200)
  if (near?.rect && far?.rect && Math.abs(near.rect.w - far.rect.w) > 1) {
    note(`the plate changed size with distance: ${near.rect.w} px at ${near.dist} m`
      + ` vs ${far.rect.w} px at ${far.dist} m`)
  }
  report.far = rows
  await shoot('far-sweep-end')
}

// ===========================================================================
// CASE 3 + 4 — INSIDE THE DRUM, AND BEHIND IT
// ===========================================================================
const DRUM_S = Math.round(geom.length * 0.08)
if (geom.inverted.length > 6) {
  console.log('\n--- 3. a car inside the drum (the aAxis case) ---')
  // The most inverted sample on the track: the ceiling of the barrel.
  const S = await page.evaluate((list) => {
    const t = window.__GAME__.track
    let best = list[0], bestY = 2
    for (const s of list) { const y = t.at(s).normal.y; if (y < bestY) { bestY = y; best = s } }
    return best
  }, geom.inverted)
  await place(LOCAL_SLOT, S, 0)
  for (let i = 0; i < 8; i++) if (i !== LOCAL_SLOT) await place(i, S, 400)
  await place(1, S + 26, -4)
  await place(3, S + 40, 5)
  await settleCamera()
  const r = await readPlates()
  for (const p of r.plates.filter((x) => x.alpha > 0.02)) {
    const [dx, dy, dz] = p.lift.d
    const [ux, uy, uz] = p.lift.up
    const len = Math.hypot(dx, dy, dz)
    // cos of the angle between the lift and the car's own up. 1.000 or the
    // whole design claim is wrong.
    const cos = len > 0 ? (dx * ux + dy * uy + dz * uz) / len : 0
    console.log(`  ${p.name.padEnd(12)} up=(${ux}, ${uy}, ${uz})`
      + `  lift=(${dx}, ${dy}, ${dz})  |lift|=${len.toFixed(3)} m`
      + `  cos(lift, up)=${cos.toFixed(4)}`
      + `  worldY ${dy < 0 ? 'BELOW' : 'above'} the car`)
    if (cos < 0.999) note(`${p.name}'s plate is not lifted along its own up (cos ${cos.toFixed(4)})`)
    if (uy < -0.25 && dy >= 0) {
      note(`${p.name} is upside down and its plate is still lifted along world +Y`)
    }
  }
  report.drum = r
  await shoot('drum')
} else {
  console.log('\n--- 3. skipped: this track has no inverted road ---')
}

// ===========================================================================
// CASE 4 — A CAR BEHIND SOMETHING
// ===========================================================================
console.log('\n--- 4. a car behind something ---')
{
  {
    /**
     * THE OCCLUSION MEASUREMENT, ON PIXELS, WITH A CONTROL.
     *
     * A photograph of a dimmer plate proves nothing on its own: the plate sits
     * over a different piece of scenery in every position, so "dimmer" could
     * be the background. Three captures of ONE frame, differing only in the
     * plate:
     *
     *   A  the plate as it ships (depth test on)
     *   B  the same plate with the depth test forced off
     *   C  no plate at all
     *
     * The plate's STRENGTH inside its own rectangle is then |mean(A)-mean(C)|
     * and |mean(B)-mean(C)|, and the ratio of the two is what the depth
     * decision is worth. A plain depth test would put it at 0; drawing through
     * would put it at 1; this design says GHOST_ALPHA, which is 0.30.
     *
     * TWO WAYS OF GETTING SOMETHING IN THE WAY. First the road itself: the
     * rival is walked down the track and the most occluded position wins,
     * which finds a barrier or a crest rather than assuming where one is.
     * Then, because whether a given track HAS one in front of the camera is
     * luck, the rival is also dropped six metres under the road -- which puts
     * the opaque surface the player is driving on directly between the lens
     * and the plate's anchor on every track in the game. The second is
     * artificial in the car's position and exactly honest in the thing being
     * measured.
     */
    const setDepth = (on) => page.evaluate((v) => {
      const m = window.__GAME__.plates.solidMat
      m.depthTest = v
      m.needsUpdate = true
    }, on)
    /** The ghost pass is silenced through its own uniform rather than through
     *  `visible`, which update() rewrites on every frame. */
    const setGhost = (on) => page.evaluate((v) => {
      const m = window.__GAME__.plates.ghostMat
      if (m) m.uniforms.uGhost.value = v ? 0.3 : 0
    }, on)

    /**
     * FOUR CAPTURES OF ONE FRAME, so the answer decomposes instead of being a
     * single ratio to squint at.
     *
     *   C  nothing drawn                     the background, on its own
     *   D  solid pass only, depth tested     what survives the depth buffer
     *   A  as it ships (solid + ghost)       the shipping answer
     *   B  solid only, depth test off        the plate with nothing in the way
     *
     * If the anchor is genuinely hidden then D collapses onto C, A - C is the
     * ghost on its own, and (A - C) / (B - C) is GHOST_ALPHA. If it is NOT
     * hidden then D is close to B and the ratio is 1, which is the probe
     * telling you it failed to find an occluder rather than telling you the
     * feature is broken -- a distinction the first version of this could not
     * make.
     */
    async function measure(label) {
      const r2 = await readPlates()
      const p = r2.plates.find((x) => x.slot === 1)
      if (!p?.rect || p.alpha < 0.02) return null
      const rect = p.rect
      const fA = await shoot(`occ-${label}-A`, true)
      await setGhost(false)
      await waitSim(0.4)
      const fD = await shoot(`occ-${label}-D`, true)
      await setDepth(false)
      await waitSim(0.4)
      const fB = await shoot(`occ-${label}-B`, true)
      await setDepth(true)
      await setGhost(true)
      await page.evaluate(() => { window.__GAME__.setNameplateRoster(null) })
      await waitSim(0.4)
      const fC = await shoot(`occ-${label}-C`, true)
      await page.evaluate(() => { window.__GAME__.setNameplateRoster(window.__GAME__.__roster) })
      await waitSim(0.5)
      const [solid, ghost, clear, ships] = await Promise.all([
        diffIn(fD, fC, rect),   // the depth-tested pass, against the background
        diffIn(fA, fD, rect),   // what the ghost adds on top of it
        diffIn(fB, fC, rect),   // the same plate with nothing in the way
        diffIn(fA, fC, rect),   // what actually ships
      ])
      return {
        label, dist: p.dist, rect,
        solid, ghost, clear, ships,
        hidden: clear > 1 ? +(1 - solid / clear).toFixed(3) : -1,
        ratio: clear > 1 ? +(ships / clear).toFixed(3) : -1,
      }
    }

    const row = (m) => console.log(
      `  ${m.label.padEnd(10)} ${String(m.dist).padStart(6)} m`
      + `  clear ${String(m.clear).padStart(5)}`
      + `  solid ${String(m.solid).padStart(5)}`
      + `  ghost ${String(m.ghost).padStart(5)}`
      + `  ->  ${(m.hidden * 100).toFixed(0)}% of the anchor hidden,`
      + ` plate reads at ${(m.ratio * 100).toFixed(0)}%`)

    const S = DRUM_S
    await place(LOCAL_SLOT, S, 0)
    for (let i = 0; i < 8; i++) if (i !== LOCAL_SLOT) await place(i, S, 400)
    await settleCamera()
    let best = null
    const rows = []
    for (const d of [45, 75, 105, 140, 180]) {
      await place(1, S + d, 0)
      await waitSim(0.7)
      const m = await measure(`road+${d}`)
      if (!m) continue
      rows.push(m)
      row(m)
      if (m.hidden >= 0 && (!best || m.hidden > best.hidden)) best = m
    }
    /**
     * ...and the occluder that exists on every track in the game: the road the
     * player is driving on. Twenty metres under the surface and twenty-five
     * ahead puts the anchor squarely behind the tarmac in the bottom half of
     * the frame, which is a real barrier made of real scene geometry -- only
     * the car's position is contrived, and the car is not what is being
     * measured.
     */
    await place(1, S + 25, 0, -20)
    await waitSim(0.7)
    const under = await measure('under-road')
    if (under) { rows.push(under); row(under); if (!best || under.hidden > best.hidden) best = under }

    if (!best) {
      note('could not measure an occluded plate at all')
    } else {
      console.log(`  most occluded     : ${best.label} -- ${(best.hidden * 100).toFixed(0)}%`
        + ` of the anchor behind scenery, and its plate reads at`
        + ` ${(best.ratio * 100).toFixed(0)}% of an unoccluded one`)
      console.log('  (GHOST_ALPHA is 0.30, so a fully hidden plate should land near 30%)')
      /**
       * THE EXPECTED ANSWER DEPENDS ON THE TIER, which is the whole reason the
       * pass count is published. With the ghost pass a hidden plate must
       * survive near GHOST_ALPHA; on `low`, where the ghost pass is
       * deliberately dropped to save the draw call, it must VANISH -- so
       * "gone" is a pass there and a failure everywhere else.
       */
      const passes = (await readPlates()).stats.passes
      if (best.hidden < 0.5) {
        note(`nothing hid the anchor anywhere (best ${(best.hidden * 100).toFixed(0)}%);`
          + ' the depth claim is untested on this track')
      } else if (best.ratio > 0.6) {
        note(`a hidden plate still reads at ${(best.ratio * 100).toFixed(0)}%;`
          + ' the depth test is not biting')
      } else if (passes > 1 && best.ratio < 0.12) {
        note(`a hidden plate is gone (${(best.ratio * 100).toFixed(0)}%); the ghost pass is missing`)
      } else if (passes === 1 && best.ratio > 0.12) {
        note(`low has no ghost pass, but a hidden plate still reads at`
          + ` ${(best.ratio * 100).toFixed(0)}%`)
      } else {
        console.log(`  as expected for ${passes} pass${passes > 1 ? 'es' : ''}:`
          + (passes > 1 ? ' hidden but readable' : ' hidden and gone'))
      }
      report.occlusion = { best, rows }
    }
    // The deliverable picture: the sunken rival, plate ghosted through the road.
    await place(1, S + 25, 0, -20)
    await waitSim(0.7)
    await shoot('occluded')
    await setDepth(false)
    await waitSim(0.4)
    await shoot('occluded-depthoff')
    await setDepth(true)
  }
}

// ===========================================================================
// CASE 5 — THE MOBILE MEASUREMENT (taken on whatever viewport is running)
// ===========================================================================
console.log('\n--- 5. the viewport ---')
{
  const S = Math.round(geom.length * 0.08)
  await place(LOCAL_SLOT, S, 0)
  const LAT = [-7, -3.5, 0, 3.5, 7, -5, 5]
  let k = 0
  for (let i = 0; i < 8; i++) {
    if (i === LOCAL_SLOT) continue
    await place(i, S + 14 + (k % 4) * 7, LAT[k])
    k++
  }
  await settleCamera()
  const r = await readPlates()
  const shown = r.plates.filter((p) => p.alpha > 0.02)
  const widest = shown.reduce((m, p) => Math.max(m, p.rect?.w ?? 0), 0)
  console.log('  viewport          :', `${VIEWPORT.width} x ${VIEWPORT.height}`)
  console.log('  plate height      :', r.stats.heightPx.toFixed(1), 'px')
  console.log('  clutter budget    :', r.stats.budget, `| plates up ${shown.length}`)
  console.log('  widest plate      :', widest, 'px =',
    `${(100 * widest / VIEWPORT.width).toFixed(1)}% of the screen width`)
  if (widest > VIEWPORT.width * 0.45) {
    note(`a plate is ${(100 * widest / VIEWPORT.width).toFixed(0)}% of the screen width`)
  }
  if (shown.length > r.stats.budget) note('more plates are up than the budget allows')
  report.viewport = { ...VIEWPORT, heightPx: r.stats.heightPx, budget: r.stats.budget, widest, shown: shown.length }
  await shoot('viewport-bunch')
}

// ===========================================================================
// THE COST
// ===========================================================================
console.log('\n--- the cost, against a racing frame of the same race ---')
{
  // Put the whole field back in front of the camera so all seven plates are up
  // and the measurement is of the worst case rather than of an empty screen.
  const S = Math.round(geom.length * 0.08)
  await place(LOCAL_SLOT, S, 0)
  const LAT = [-9, -6, -3, 3, 6, 9, 0]
  let k = 0
  for (let i = 0; i < 8; i++) {
    if (i === LOCAL_SLOT) continue
    await place(i, S + 30 + k * 9, LAT[k])
    k++
  }
  await settleCamera()
  const c = await readCost()
  const dc = c.with.calls - c.without.calls
  const dt = c.with.tris - c.without.tris
  console.log(`  tier              : ${c.tier}`)
  console.log(`  plates up         : ${c.stats.visible} of ${c.stats.roster}`
    + ` (passes ${c.stats.passes}, ${c.stats.suppressed} suppressed, ${c.stats.culled} culled)`)
  console.log(`  racing frame      : ${c.without.calls} calls, ${c.without.tris.toLocaleString()} triangles`)
  console.log(`  with name plates  : ${c.with.calls} calls, ${c.with.tris.toLocaleString()} triangles`)
  console.log(`  the plates cost   : ${dc} calls, ${dt} triangles, 1 texture (512x512 RGBA + mips)`)
  console.log(`  as a share        : ${(100 * dc / c.without.calls).toFixed(1)}% of the draw calls,`
    + ` ${(100 * dt / c.without.tris).toFixed(4)}% of the triangles`)
  if (dc !== c.stats.calls) {
    note(`the renderer counted ${dc} extra draw calls; the system claims ${c.stats.calls}`)
  }
  if (dt !== c.stats.tris) {
    note(`the renderer counted ${dt} extra triangles; the system claims ${c.stats.tris}`)
  }
  report.cost = { ...c, deltaCalls: dc, deltaTris: dt }
}

// ===========================================================================
console.log('')
// The occlusion scan's working frames -- four captures per position, about a
// megabyte and a half each -- have been measured and are not deliverables.
await rm(join(OUT, 'scan'), { recursive: true, force: true })
await writeFile(join(OUT, `${KIND}-report.json`), JSON.stringify(report, null, 2))
console.log(`  report            : shots/nameplates/${KIND}-report.json`)
if (errors.length) {
  console.log(`\nNAME PLATE PROBE: ${errors.length} problem(s)`)
  for (const e of errors) console.log('  - ' + e)
} else {
  console.log('\nNAME PLATE PROBE: clean')
}
await browser.close()
server.close()
process.exit(errors.length ? 1 : 0)
