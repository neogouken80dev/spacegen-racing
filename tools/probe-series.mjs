/**
 * A MULTI-ROUND LOBBY, DRIVEN AND PHOTOGRAPHED.
 * ---------------------------------------------------------------------------
 * Creates a THREE-ROUND lobby through the real create screen, races round 1
 * for real, and comes back to the room to find a standings table, a round
 * counter and a different circuit waiting. Then it does it again, because the
 * bug a series has that a single race does not is entirely in the SECOND
 * round: everything up to the first chequered flag is a race, and everything
 * after it is a feature.
 *
 * ===========================================================================
 * WHAT A SCREENSHOT OF A STANDINGS TABLE CANNOT TELL YOU, AND SO IS ASSERTED
 *
 *   1. THE ROUND ACTUALLY ADVANCED. A room that says "Round 2 of 3" is one
 *      `textContent` away from a room that says it and is still on round 1.
 *      So the round counter, the panel title, the running order's `next`
 *      marker and the CIRCUIT THE NEXT PACKET NAMES are all read, and they
 *      have to agree with each other.
 *
 *   2. THE TABLE IS THE ROUND'S. Eight rows, one cell per round, and the
 *      points on them are the ones game/circuit.ts's ladder awards for the
 *      places the race actually produced. Read against the finishing order
 *      the sim reported, not against a number typed in here -- otherwise this
 *      checks that the table renders and not that it is right.
 *
 *   3. A SINGLE RACE STILL LOOKS LIKE A SINGLE RACE. The same flow at length
 *      1, and the round chip, the standings panel and the running order all
 *      have to be ABSENT -- not empty. That is the contract's requirement and
 *      it is the one this whole feature is most likely to break by accident.
 *
 *   4. IT FITS A PHONE. The standings row is place + avatar + name + a cell
 *      per round + points, which is the widest thing either lobby screen has
 *      ever had to draw, and 412px is the target. Measured as rectangles: no
 *      horizontal overflow, and nothing under the 44px tap floor on the
 *      create screen's new control.
 *
 * ===========================================================================
 * IT RACES UNDER THE MOCK, WHICH HAS NO PEERS, AND THAT IS THE POINT HERE
 *
 * tools/probe-netcode.mjs is where two real browsers exchange real inputs over
 * a real data channel. This probe is about the SERIES -- the round counter,
 * the table, the running order, the podium -- all of which are the same code
 * whether the other seven cars are people or AI. Under `?net=perfect` the
 * race is local and finishes in a few seconds of fast-forwarded sim, which is
 * what makes photographing three rounds affordable at all.
 *
 * NEEDS dist/: run `npx vite build` first.
 *
 *   node tools/probe-series.mjs [--mobile]
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { join, extname } from 'node:path'

const MOBILE = process.argv.includes('--mobile')
const ROOT = new URL('../dist/', import.meta.url).pathname
const OUT = new URL('../shots/series/', import.meta.url).pathname
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

let shotN = 0
const shoot = async (page, name) => {
  const tag = `${MOBILE ? 'mobile' : 'desktop'}-${String(++shotN).padStart(2, '0')}-${name}.png`
  await page.screenshot({ path: join(OUT, tag) })
  say('shot ' + tag)
  return tag
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist'],
})
const VIEWPORT = MOBILE ? { width: 412, height: 915 } : { width: 1440, height: 810 }
const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 })
const page = await ctx.newPage()
page.on('pageerror', (e) => note('page error: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') note('console: ' + m.text()) })

await page.goto(url, { waitUntil: 'load', timeout: 40000 })
await page.waitForFunction(() => !!window.__GAME__, null, { timeout: 60000 })
await page.waitForTimeout(2000)
// THE SIM IS LET OFF ITS SUB-STEP LEASH. A three-lap race is ~90 seconds of
// simulated time and this machine renders it under a software rasteriser at
// well under one frame a second; without this the probe would spend an hour
// watching one round. The netcode is not involved -- see the header.
await page.evaluate(() => { window.__GAME__.maxSubSteps = 4000 })

/** Everything the room screen says about where the series is. */
const readRoom = () => page.evaluate(() => {
  const txt = (s) => document.querySelector(s)?.textContent?.trim() ?? ''
  const vis = (s) => {
    const e = document.querySelector(s)
    return !!e && !e.hidden && getComputedStyle(e).display !== 'none'
  }
  return {
    chip: txt('.sglbs__roundChip'),
    chipVisible: vis('.sglbs__roundChip'),
    sideTitle: txt('.sglbr__side .sglbr__panelTitle'),
    nextTrack: txt('.sglbr__trackName'),
    standingsVisible: vis('.sglbs__panel'),
    standingsTitle: txt('.sglbs__panel .sglbr__panelTitle'),
    after: txt('.sglbs__after'),
    you: txt('.sglbs__you'),
    msg: txt('.sglbr__foot .sglb__msg'),
    orderVisible: vis('.sglbs__order--room'),
    order: [...document.querySelectorAll('.sglbs__order--room .sglbs__orderRow')].map((r) => ({
      n: r.dataset.round, name: r.querySelector('.sglbs__orderName')?.textContent ?? '',
      state: r.dataset.state,
    })),
    rows: [...document.querySelectorAll('.sglbs__row')].map((r) => ({
      place: r.dataset.place,
      name: r.querySelector('.sglbs__name')?.textContent ?? '',
      runs: [...r.querySelectorAll('.sglbs__run')].map((c) => c.textContent),
      pts: Number(r.querySelector('.sglbs__pts')?.textContent ?? '-1'),
      you: r.classList.contains('is-you'),
      ai: r.classList.contains('is-ai'),
    })),
    startWhy: txt('.sglbr__why'),
    startDisabled: document.querySelector('.sglbr__start')?.disabled ?? null,
  }
})

/**
 * THE STALL LINE, PHOTOGRAPHED WITHOUT A STALL.
 *
 * It only appears when a peer is late, which needs two machines -- and
 * tools/probe-netcode.mjs, which has two, parks the render loop to pump the
 * sim on its own clock and so never draws a frame while one is stalled. So
 * neither probe can catch this state by playing the game, and the line would
 * ship having been read and never looked at.
 *
 * Pushed straight into the HUD instead. `setNetStatus` is a projection of the
 * runner's three public fields and nothing else -- it decides nothing, which
 * is the contract on it -- so a hand-made status renders byte for byte what a
 * real one does, and tests/series.test.ts checks the grammar of all six
 * branches without a browser. What the PICTURE is for is the placement: that
 * the line sits below the racing line rather than across it, and that it does
 * not collide with the round card or the countdown.
 */
async function shootStallLine() {
  await page.setViewportSize(VIEWPORT)
  await page.waitForTimeout(800)
  for (const [tag, status] of [
    ['stall-one', { verdict: 'waiting', waitingFor: ['Ada'], loading: false }],
    ['stall-load', { verdict: 'waiting', waitingFor: ['Ada'], loading: true }],
    ['stall-three', { verdict: 'waiting', waitingFor: ['Ada', 'Ben', 'Cyd'], loading: false }],
    ['stall-void', { verdict: 'desync', waitingFor: [], loading: false }],
  ]) {
    await page.evaluate((st) => { window.__GAME__.hud.setNetStatus(st) }, status)
    await page.waitForTimeout(300)
    await shoot(page, tag)
  }
  await page.evaluate(() => { window.__GAME__.hud.setNetStatus(null) })
  await page.setViewportSize({ width: 320, height: 180 })
  await page.waitForTimeout(300)
}

/** Ready up, wait for the room to be startable, press Start, race it out. */
async function raceRound(label) {
  /**
   * READY AND START ARE TRIED IN ONE LOOP, NOT IN SEQUENCE.
   *
   * The world ticks every 1.6 seconds and bots un-ready, change car and drop
   * as they please -- deliberately, it is what the mock is for -- so Start is
   * enabled and disabled again continuously. Checking that it is enabled and
   * THEN clicking it is a race the probe loses often enough to be useless: a
   * bot un-readies in the gap and Playwright waits thirty seconds for a
   * button that will not come back until the next tick.
   *
   * So each pass does whatever the room currently allows, swallows the
   * failure, and looks again. The exit condition is the only thing that
   * matters: the game is racing.
   */
  let racing = false
  for (let i = 0; i < 150; i++) {
    const r = await page.evaluate(() => ({
      phase: window.__GAME__.phase,
      startOff: document.querySelector('.sglbr__start')?.disabled ?? true,
      ready: document.querySelector('.sglbr__member.is-me .sglbr__mstate')?.dataset.state ?? '',
    }))
    if (r.phase === 'racing') { racing = true; break }
    if (!r.startOff) {
      await page.locator('.sglbr__start').click({ timeout: 1500 }).catch(() => {})
    } else if (r.ready !== 'ready' && r.ready !== 'connecting') {
      await page.locator('.sglbr__ready').click({ timeout: 1500 }).catch(() => {})
    }
    await page.waitForTimeout(400)
  }
  if (!racing) {
    await page.waitForFunction(() => window.__GAME__.phase === 'racing', null, { timeout: 20000 })
      .catch(() => note(`round ${label}: never reached a startable room`))
  }
  if (await page.evaluate(() => window.__GAME__.phase !== 'racing')) return null
  const packet = await page.evaluate(() => {
    const p = window.__GAME__.multiplayer
    return p ? { round: p.round, len: p.seriesLength, track: p.trackId, standings: p.standings.length } : null
  })
  say(`round ${label}: racing ${packet?.track} (packet round ${packet?.round} of ${packet?.len}, `
    + `${packet?.standings} rows carried in)`)

  /**
   * THE AI DRIVES THE PLAYER'S CAR, which is the same rail tools/probe-
   * circuit.mjs and tools/probe-tabs.mjs run on and it is not optional: a
   * probe can hold a throttle down but it cannot steer, so an un-driven car
   * parks on the first barrier, never finishes, and the round never ends.
   * It is still racer `localId`, so the results table, the score, the
   * standings and the podium all treat it as the player.
   *
   * SAFE HERE AND NOT UNDER REAL NETCODE. `LockstepRunner.syncAI` re-derives
   * `isAI` every step from the agreed handover frames, so this flag would be
   * cleared on the next frame of a real lockstep race -- correctly, since a
   * client that quietly handed its own car to the AI would diverge from
   * everybody else. Under `?net=perfect` there is no runner and no peer, so
   * nothing overwrites it. That is why this probe races the mock and
   * tools/probe-netcode.mjs races the wire.
   */
  await page.evaluate(() => {
    const g = window.__GAME__
    g.maxSubSteps = 900
    const st = g.race && g.race.state
    if (!st) return
    st.totalLaps = 1
    const r = st.racers[g.localId]
    if (r) r.isAI = true
  })
  /**
   * THE RACE IS RUN IN A POSTAGE STAMP.
   *
   * game/main.ts clamps a rendered frame's `rawDt` to 0.25s, so the fixed-step
   * loop can only ever run fifteen sim steps per RENDERED frame however high
   * `maxSubSteps` goes. That makes sim speed a pure function of frame rate --
   * and eight cars on Elkarim under a software rasteriser at 1440x810 renders
   * at about a third of a frame a second, which is 0.07x real time. Measured:
   * 16.9 seconds of race in four minutes of probe.
   *
   * Shrinking the viewport is the only lever that moves it, because the cost
   * is fragment-bound and nothing else in the frame is. 320x180 is a
   * twentieth of the pixels. The sim does not know or care -- it is the same
   * fixed step, the same seed and the same eight cars -- and the viewport
   * goes straight back afterwards, so every screenshot in this probe is
   * taken at the size the game is played at.
   */
  await page.setViewportSize({ width: 320, height: 180 })

  // Run it to the flag. The ceremony and the settle are part of the round, so
  // the wait is for the phase to leave 'racing'/'ceremony' entirely. Polled
  // rather than waited on in one go, so a run that is merely slow says how
  // far it got instead of timing out with nothing to read.
  let last = null
  let shotStall = false
  for (let i = 0; i < 600; i++) {
    last = await page.evaluate(() => ({
      p: window.__GAME__.phase,
      t: Math.round((window.__GAME__.race?.state.time ?? 0) * 10) / 10,
      done: window.__GAME__.race?.state.finishOrder.length ?? 0,
    }))
    if (['results', 'podium', 'menu'].includes(last.p)) break
    if (!shotStall && label === '1' && last.p === 'racing' && last.t > 6) {
      shotStall = true
      await shootStallLine()
    }
    await page.waitForTimeout(400)
  }
  say(`round ${label}: reached "${last?.p}" at ${last?.t}s of sim, ${last?.done} cars home`)
  if (!['results', 'podium', 'menu'].includes(last?.p)) {
    note(`round ${label}: the race never finished (stuck in ${last?.p} at ${last?.t}s)`)
  }
  await page.setViewportSize(VIEWPORT)
  await page.waitForTimeout(500)
  return packet
}

/** The finishing order the sim actually produced, by grid slot. */
const readFinish = () => page.evaluate(() => {
  const g = window.__GAME__
  if (!g.race) return null
  return g.race.state.racers.map((r) => ({
    id: r.id, position: r.position, finished: r.finished,
  }))
})

// ===========================================================================
// PART 1 — A THREE-ROUND SERIES
// ===========================================================================
say('')
say('=== A THREE-ROUND SERIES ===')

await page.locator('.sg-title__multi .sg-btn--violet').click()
await page.waitForSelector('.sglb--browser', { state: 'visible', timeout: 20000 })
await page.waitForTimeout(800)
await page.locator('.sglb--browser .sglb__foot .sg-btn:not(.sg-btn--gold)').last().click()
await page.waitForSelector('.sglb--create', { state: 'visible', timeout: 20000 })
await page.locator('.sglb--create .sglb__in').fill('Three rounds')

// The new control. Everything else on this screen is what it always was.
await page.locator('.sglb--create [data-series="3"]').click()
await page.locator('.sglb--create .sglb__track[data-track="rustfall"]').click()
await page.locator('.sglb--create [data-max="4"]').click()
await page.locator('.sglb--create [data-laps="1"]').click()
await page.waitForTimeout(250)

{
  const c = await page.evaluate(() => ({
    lengths: [...document.querySelectorAll('.sglbs__lenBtn')].map((b) => ({
      n: b.dataset.series, on: b.classList.contains('is-on'),
      label: b.querySelector('.sglbs__lenLabel')?.textContent,
      sub: b.querySelector('.sglbs__lenSub')?.textContent,
    })),
    orderVisible: !document.querySelector('.sglbs__order')?.hidden,
    order: [...document.querySelectorAll('.sglbs__order .sglbs__orderName')].map((n) => n.textContent),
    trackK: document.querySelector('.sglb--create .sglb__k')?.textContent,
    go: document.querySelector('.sglb--create .sg-btn--start')?.textContent,
    hint: [...document.querySelectorAll('.sglb--create .sglb__hint')].map((h) => h.textContent).join(' | '),
  }))
  say(`lengths offered: ${c.lengths.map((l) => `${l.n}${l.on ? '*' : ''} "${l.label}" (${l.sub})`).join('  ')}`)
  say(`running order shown: ${c.order.join(' -> ')}`)
  say(`create button: "${c.go}"`)
  if (c.lengths.length !== 4) note(`expected 4 series lengths, saw ${c.lengths.length}`)
  if (!c.lengths.find((l) => l.n === '1')) note('a single race is not one of the choices')
  if (!c.orderVisible) note('a 3-round lobby does not show its running order before it is created')
  if (c.order.length !== 3) note(`running order has ${c.order.length} circuits, not 3`)
  if (c.order[0] !== 'Elkarim') note(`the chosen opener is not round 1 (${c.order[0]})`)
  if (new Set(c.order).size !== c.order.length) note('the running order repeats a circuit')
  if (!/3-round/.test(c.go)) note(`the create button does not say what it will create: "${c.go}"`)
  await shoot(page, 'create-3-rounds')
}

await page.locator('.sglb--create .sg-btn--start').click()
await page.waitForSelector('.sglb--room', { state: 'visible', timeout: 20000 })
await page.waitForTimeout(1200)

{
  const r = await readRoom()
  say(`room before round 1: chip "${r.chip}" · side "${r.sideTitle}" · next ${r.nextTrack}`)
  say(`  order: ${r.order.map((o) => `${o.n}.${o.name}[${o.state}]`).join(' ')}`)
  if (!r.chipVisible) note('a 3-round room does not say which round it is on')
  if (!/Round 1 of 3/i.test(r.chip)) note(`the round chip reads "${r.chip}"`)
  // NOT AN EMPTY TABLE. Nothing has been raced, so there is nothing to show --
  // which is a different thing from a table with no rows in it.
  if (r.standingsVisible) note('an unraced series shows an empty standings table')
  if (!r.orderVisible) note('the room does not show the running order')
  if (r.order[0]?.state !== 'next') note('round 1 is not marked as the one coming next')
  await shoot(page, 'room-round-1')
}

const seenTracks = []
const seenTables = []
for (let n = 1; n <= 3; n++) {
  const packet = await raceRound(String(n))
  if (!packet) break
  seenTracks.push(packet.track)
  const finish = await readFinish()

  // The results screen, then back to the room the way a player gets there.
  await page.waitForTimeout(1500)
  if (n === 3) {
    // The last round ends on the podium, which is its own screen and its own
    // clock. Photograph it before skipping through.
    const phase = await page.evaluate(() => window.__GAME__.phase)
    say(`after the final round the game is in "${phase}"`)
    if (phase !== 'podium') note(`the end of a 3-round series did not raise the podium (${phase})`)
    else {
      await page.waitForTimeout(3000)
      const card = await page.evaluate(() => ({
        lines: [...document.querySelectorAll('.sg-pod__row')].map((r) => ({
          place: r.dataset.place,
          pilot: r.querySelector('.sg-pod__pilot')?.textContent ?? '',
          pts: r.querySelector('.sg-pod__pts')?.textContent ?? '',
        })),
        you: document.querySelector('.sg-pod__you')?.textContent ?? '',
      }))
      say(`podium: ${card.lines.map((l) => `${l.place}. ${l.pilot} ${l.pts}`).join(' | ')}`)
      say(`podium says: "${card.you}"`)
      if (card.lines.length !== 3) note(`the podium has ${card.lines.length} steps, not 3`)
      // THE NAMES ARE PEOPLE AND AI, NOT PILOTS. A lobby's drivers have
      // claimed names; "SOCKET" over a car driven by somebody called Nova is
      // the wrong name in the one place the game names a winner.
      if (card.lines.some((l) => !l.pilot)) note('a podium step has no name on it')
      await shoot(page, 'podium-final')
      await page.waitForFunction(() => window.__GAME__.phase !== 'podium', null, { timeout: 60000 })
        .catch(() => note('the podium never ended'))
    }
  }

  await page.waitForFunction(() => window.__GAME__.phase === 'results', null, { timeout: 60000 })
    .catch(() => note(`round ${n}: never reached the results screen`))
  await page.waitForTimeout(800)
  await shoot(page, `results-round-${n}`)

  // The gold button on the results screen goes back to the ROOM in a lobby,
  // because the next round is the host's to start and a "rematch" would be
  // one player racing a recording of the series.
  await page.locator('.sg-fe .sg-results .sg-btn--gold, .sg-results .sg-btn--gold').first().click()
    .catch(async () => { await page.evaluate(() => window.__GAME__.frontEnd.onRematch()) })
  await page.waitForTimeout(1500)

  const r = await readRoom()
  seenTables.push(r.rows)
  say(`after round ${n}: chip "${r.chip}" · next ${r.nextTrack} · "${r.after}"`)
  say(`  notice: "${r.msg}"`)
  say(`  ${r.you}`)
  for (const row of r.rows.slice(0, 4)) {
    say(`   ${row.place.padStart(2)}  ${row.name.padEnd(14)} ${row.runs.join(' ')}  ${row.pts} pts`)
  }

  if (!r.standingsVisible) note(`round ${n} produced no standings table`)
  if (r.rows.length === 0) note(`round ${n}'s standings table has no rows`)
  if (!new RegExp(`after ${n} of 3`, 'i').test(r.after) && n < 3) {
    note(`the table does not say how far in it is: "${r.after}"`)
  }
  if (!r.rows.some((row) => row.you)) note('the player cannot find themselves in the standings')

  // ------------------------------------------------------------------
  // THE POINTS ARE THE LADDER'S, CHECKED AGAINST THE RACE THAT HAPPENED.
  // ------------------------------------------------------------------
  if (n === 1 && finish) {
    const LADDER = [15, 12, 10, 8, 6, 4, 2, 1]
    const wanted = finish
      .filter((f) => f.finished)
      .map((f) => LADDER[f.position - 1] ?? 0)
      .sort((a, b) => b - a)
    const got = r.rows.map((row) => row.pts).sort((a, b) => b - a)
    say(`  points from the ladder: ${wanted.join(',')}`)
    say(`  points in the table:    ${got.join(',')}`)
    if (JSON.stringify(wanted) !== JSON.stringify(got)) {
      note('the standings do not pay game/circuit.ts’s points for the places raced')
    }
    // Every row has one cell per round from the first round on, so the
    // columns never move.
    if (r.rows.some((row) => row.runs.length !== 3)) {
      note('a standings row does not have one cell per round of the series')
    }
  }

  if (n < 3) {
    if (!new RegExp(`Round ${n + 1} of 3`, 'i').test(r.chip)) {
      note(`the room did not advance to round ${n + 1}: "${r.chip}"`)
    }
    const next = r.order.find((o) => o.state === 'next')
    if (!next || next.n !== String(n + 1)) {
      note(`the running order does not mark round ${n + 1} as next`)
    }
    if (next && next.name !== r.nextTrack) {
      note(`the panel names ${r.nextTrack} and the order marks ${next.name}`)
    }
    await shoot(page, `room-round-${n + 1}-standings`)
  } else {
    if (!/complete/i.test(r.chip)) note(`a finished series does not say so: "${r.chip}"`)
    if (!/final/i.test(r.standingsTitle)) note(`the final table is not marked final: "${r.standingsTitle}"`)
    if (r.startDisabled !== true) note('a finished series still offers Start')
    say(`finished series says: "${r.startWhy}"`)
    await shoot(page, 'room-series-complete')
  }
}

say('')
say(`circuits raced: ${seenTracks.join(' -> ')}`)
if (new Set(seenTracks).size !== seenTracks.length) {
  note('two rounds of one series ran the same circuit')
}

// The table has to GROW: round 2's cells are round 1's plus one more scored.
if (seenTables.length >= 2) {
  const scored = (t) => t.reduce((a, row) => a + row.runs.filter((c) => c !== '·').length, 0)
  say(`cells scored after round 1: ${scored(seenTables[0])}, after round 2: ${scored(seenTables[1])}`)
  if (scored(seenTables[1]) <= scored(seenTables[0])) {
    note('the second round added nothing to the table')
  }
}

// ===========================================================================
// PART 2 — THE SAME FLOW AT LENGTH 1
// ===========================================================================
say('')
say('=== A SINGLE RACE IS STILL A SINGLE RACE ===')

await page.evaluate(() => { void window.__NET__.lobbyService().leave() })
await page.waitForTimeout(800)
await page.evaluate(() => { window.__GAME__.frontEnd.show('lobbyNew') })
await page.waitForSelector('.sglb--create', { state: 'visible', timeout: 20000 })
await page.locator('.sglb--create .sglb__in').fill('One race')
await page.locator('.sglb--create [data-series="1"]').click()
await page.locator('.sglb--create [data-track="halcyon"]').click()
await page.locator('.sglb--create [data-laps="1"]').click()
await page.waitForTimeout(250)

{
  const c = await page.evaluate(() => ({
    orderVisible: !document.querySelector('.sglbs__order')?.hidden,
    trackK: [...document.querySelectorAll('.sglb--create .sglb__k')]
      .map((k) => k.textContent).join(' | '),
    go: document.querySelector('.sglb--create .sg-btn--start')?.textContent,
  }))
  say(`single-race create: labels "${c.trackK}" · button "${c.go}"`)
  if (c.orderVisible) note('a single race shows a "running order" of one')
  if (/Opening circuit/.test(c.trackK)) note('a single race calls its circuit an "opening circuit"')
  if (/round/i.test(c.go)) note(`a single race's create button mentions rounds: "${c.go}"`)
  await shoot(page, 'create-single-race')
}

await page.locator('.sglb--create .sg-btn--start').click()
await page.waitForSelector('.sglb--room', { state: 'visible', timeout: 20000 })
await page.waitForTimeout(1200)

{
  const r = await readRoom()
  say(`single-race room: chip visible=${r.chipVisible} · side "${r.sideTitle}" · standings=${r.standingsVisible}`)
  // THE THREE THINGS THAT MUST NOT BE THERE. The contract is explicit: length
  // 1 must still read as a single race -- no round counters, no standings tab.
  if (r.chipVisible) note('a single race shows a round counter')
  if (r.standingsVisible) note('a single race shows a standings table')
  if (r.orderVisible) note('a single race shows a running order')
  if (r.sideTitle !== 'CIRCUIT') note(`the single race's panel is titled "${r.sideTitle}"`)
  await shoot(page, 'room-single-race')
}

await raceRound('single')
await page.waitForTimeout(1500)
{
  const phase = await page.evaluate(() => window.__GAME__.phase)
  say(`a single lobby race ends in "${phase}"`)
  // NOT THE PODIUM. A championship celebration for finishing one race is the
  // most likely way "a single race is a series of one" goes wrong.
  if (phase === 'podium') note('a single lobby race raised the championship podium')
  await shoot(page, 'results-single-race')
}

// ===========================================================================
// PART 3 — GEOMETRY
// ===========================================================================
say('')
say('=== FIT ===')
await page.evaluate(() => { window.__GAME__.frontEnd.show('room') })
await page.waitForTimeout(600)
{
  const fit = await page.evaluate(() => {
    const doc = document.documentElement
    const small = [...document.querySelectorAll('.sglbs__lenBtn, .sglbs__row')]
      .map((e) => { const r = e.getBoundingClientRect(); return { cls: e.className, h: Math.round(r.height), w: Math.round(r.width) } })
    return {
      overflowX: doc.scrollWidth - doc.clientWidth,
      vw: doc.clientWidth,
      small,
    }
  })
  say(`viewport ${fit.vw}px, horizontal overflow ${fit.overflowX}px`)
  if (fit.overflowX > 1) note(`the room scrolls sideways by ${fit.overflowX}px`)
}
await page.evaluate(() => { window.__GAME__.frontEnd.show('lobbyNew') })
await page.waitForTimeout(500)
{
  const taps = await page.evaluate(() =>
    [...document.querySelectorAll('.sglbs__lenBtn')].map((e) => {
      const r = e.getBoundingClientRect()
      return { n: e.dataset.series, h: Math.round(r.height), w: Math.round(r.width) }
    }))
  say(`length buttons: ${taps.map((t) => `${t.n}:${t.w}x${t.h}`).join('  ')}`)
  const short = taps.filter((t) => t.h < 44)
  if (short.length > 0) note(`${short.length} length button(s) under the 44px tap floor`)
  const doc = await page.evaluate(() => ({
    over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }))
  if (doc.over > 1) note(`the create screen scrolls sideways by ${doc.over}px`)
  await shoot(page, 'create-fit')
}

await browser.close()
server.close()

console.log('')
if (errors.length === 0) console.log('SERIES PROBE PASSED')
else {
  console.log(`SERIES PROBE: ${errors.length} problem(s)`)
  for (const e of errors) console.log('  - ' + e)
  process.exitCode = 1
}
