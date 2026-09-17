/**
 * DO THE RESULTS TABS EXIST, SWITCH, AND SHOW THE RIGHT THING?
 *
 * Driven through a REAL RACE to a REAL results screen rather than by calling
 * showResults() with invented data. The difference is the whole point: the
 * records store is written from main.ts when the flag drops, and a probe that
 * feeds the UI its own fixtures would pass with that wiring severed -- which is
 * exactly how the audio system shipped silent and the score HUD nearly did.
 *
 * WAITS ON SIM TIME AND SIM PHASE, NEVER WALL CLOCK. Under SwiftShader this
 * renderer runs below 1fps, so a race is reached by raising the sub-step
 * ceiling and watching `race.state.phase`, not by sleeping.
 *
 * What it checks, in order of how badly each would fail a player:
 *   - the results screen has a tablist with two tabs
 *   - clicking the second one actually swaps which panel is visible
 *   - the records page lists all four records
 *   - each set record names a VEHICLE, which was the explicit ask
 *   - the leaderboard has a vehicle column too
 *   - arrow keys move between tabs (it is a tablist, so it must behave as one)
 *
 *   node tools/probe-tabs.mjs
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
  '.mp3': 'audio/mpeg',
}
/**
 * A stub for the leaderboard function.
 *
 * The endpoint is a Netlify Function and this harness serves a static
 * directory, so without this the global tab only ever exercises its OFFLINE
 * branch -- which is the branch least likely to be broken. Standing in for the
 * function means the populated path is tested too: the fetch, the row
 * sanitising, the rendering and the vehicle column.
 */
const GLOBAL_STUB = {
  rows: [
    { name: 'ORBIT', lap: 47.21, raceTime: 160.2, score: 210000, chassisId: 'bulwark', pilotId: 'aegis', position: 1, at: 10 },
    { name: 'KESTREL', lap: 48.90, raceTime: 164.0, score: 180000, chassisId: 'vector7', pilotId: 'zephyr', position: 2, at: 20 },
    { name: 'PROBE', lap: 51.44, raceTime: 171.5, score: 140000, chassisId: 'solaire', pilotId: 'socket', position: 4, at: 30 },
  ],
  rank: 3,
}

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0])
    if (p === '/api/leaderboard') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(GLOBAL_STUB))
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

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist'],
})
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

await page.goto(url, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(2500)

// Wipe any board/records from an earlier run so "new record" state is real.
await page.evaluate(() => {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k && (k.startsWith('sg.board.') || k.startsWith('sg.records.'))) localStorage.removeItem(k)
    }
    localStorage.setItem('sg.name', 'PROBE')
  } catch { /* blocked */ }
})

/**
 * ONE LAP, NOT THREE.
 *
 * The sim cannot be fast-forwarded: the accumulator is fed by real elapsed
 * time, so `maxSubSteps` only stops the loop falling behind -- it does not make
 * a race run quicker. Measured, a three-lap race reached 145s of sim in 360s of
 * wall clock under SwiftShader and was still going.
 *
 * So the race is shortened rather than hurried. `race.state.totalLaps` is what
 * the finish check reads (race.ts: `if (r.lap >= s.totalLaps)`), and setting it
 * to 1 changes how long the race is, not how it ends -- every line of the path
 * under test, from the flag through the records store to the panel, runs
 * exactly as it does in play.
 */
await page.evaluate(() => {
  const g = window.__GAME__
  g.maxSubSteps = 900
  g.startRace()
  const st = g.race && g.race.state
  if (!st) return
  st.totalLaps = 1
  // AND THE AI DRIVES THE PLAYER'S CAR.
  //
  // A probe can hold the throttle but it cannot steer: measured, a car with
  // KeyW and nothing else reaches the first corner, parks against the barrier
  // and never completes a lap -- 141s of sim on lap 0. Flipping `isAI` on the
  // local racer hands it to the same controller every other car uses
  // (race.ts: `r.isAI ? ... : this.inputs[r.id]`), so it drives a real lap and
  // finishes through the real finish path. It is still racer `localId`, so the
  // results screen, the score, the board and the records all treat it as the
  // player exactly as they would.
  const r = st.racers[g.localId]
  if (r) r.isAI = true
})

const phase = () => page.evaluate(() => {
  const g = window.__GAME__
  const st = g.race?.state
  const r = st?.racers?.[g.localId]
  return {
    p: g.phase, sp: st?.phase ?? '-', t: +(st?.time ?? 0).toFixed(1),
    laps: st?.totalLaps ?? -1, lap: r?.lap ?? -1, fin: !!r?.finished,
    s: +(r?.totalS ?? 0).toFixed(0),
    v: +Math.hypot(r?.vel?.x ?? 0, r?.vel?.z ?? 0).toFixed(1),
  }
})

// Hold the throttle so the player's car actually completes laps.
let last = null
for (let i = 0; i < 900; i++) {
  last = await phase()
  if (i % 25 === 0) console.log('  ', JSON.stringify(last))
  if (last.p === 'results') break
  // The ceremony has a minimum duration and then hands over on its own.
  await page.waitForTimeout(400)
}
console.log('reached:', JSON.stringify(last))

const readTabs = () => page.evaluate(() => {
  const list = document.querySelector('.sg-screen--results .sg-tabs')
  if (!list) return { missing: true }
  const tabs = [...document.querySelectorAll('.sg-screen--results .sg-tab')]
  const panels = [...document.querySelectorAll('.sg-screen--results .sg-tabpanel')]
  const visible = panels.filter((p) => !p.hidden)
  const recRows = [...document.querySelectorAll('.sg-rec__row')].map((r) => ({
    k: r.querySelector('.sg-rec__k')?.textContent ?? '',
    v: r.querySelector('.sg-rec__v')?.textContent ?? '',
    car: r.querySelector('.sg-rec__car')?.textContent ?? '',
    isNew: r.classList.contains('is-new'),
  }))
  const boardCars = [...document.querySelectorAll('.sg-board__car')].map((e) => e.textContent)
  const glo = document.querySelector('.sg-results__global')
  const gloRows = [...document.querySelectorAll('.sg-results__global .sg-board__row')].map((r) => ({
    n: r.querySelector('.sg-board__n')?.textContent ?? '',
    name: r.querySelector('.sg-board__name')?.textContent ?? '',
    car: r.querySelector('.sg-board__car')?.textContent ?? '',
    t: r.querySelector('.sg-board__score')?.textContent ?? '',
  }))
  const gloNote = document.querySelector('.sg-results__global .sg-board__note')?.textContent ?? ''
  return {
    missing: false,
    role: list.getAttribute('role'),
    labels: tabs.map((t) => t.textContent),
    selected: tabs.filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent),
    marked: tabs.filter((t) => t.dataset.mark).map((t) => t.textContent),
    tabbable: tabs.filter((t) => t.tabIndex === 0).length,
    panelCount: panels.length,
    visiblePanels: visible.length,
    visibleHasRecords: visible.some((p) => p.querySelector('.sg-rec__rows')),
    visibleHasStandings: visible.some((p) => p.querySelector('.sg-results__rows')),
    recRows,
    boardCars,
    gloRows,
    gloNote,
    hasGlobal: !!glo,
  }
})

const before = await readTabs()
console.log('\non arrival :', JSON.stringify({
  role: before.role, labels: before.labels, selected: before.selected,
  marked: before.marked, tabbable: before.tabbable,
  visiblePanels: before.visiblePanels, standings: before.visibleHasStandings,
}))

// Click the second tab.
await page.locator('.sg-screen--results .sg-tab').nth(1).click()
await page.waitForTimeout(400)
const after = await readTabs()
console.log('after click:', JSON.stringify({
  selected: after.selected, marked: after.marked,
  visiblePanels: after.visiblePanels, records: after.visibleHasRecords,
}))
console.log('records    :', JSON.stringify(after.recRows, null, 1))
console.log('board cars :', JSON.stringify(after.boardCars))

// Arrow key back to the first tab -- it claims to be a tablist.
await page.locator('.sg-screen--results .sg-tab').nth(1).focus()
await page.keyboard.press('ArrowLeft')
await page.waitForTimeout(300)
const arrowed = await readTabs()
console.log('after Left :', JSON.stringify({ selected: arrowed.selected }))

/**
 * NAME THE RUN, THEN LOOK AT THE BOARD AGAIN.
 *
 * The first version of this probe asserted the leaderboard had a vehicle column
 * straight away and failed -- correctly, because on a fresh install NOTHING has
 * been submitted to the board. Nothing is written there until the player names
 * a qualifying run, so an empty board with no vehicle cells is the right answer
 * and the assertion was measuring an empty table.
 *
 * Naming it here is the better test anyway: it exercises the save path, the
 * re-read, and the rename that puts the name onto records this race already
 * took -- which cannot be done by re-submitting the run, because an exact tie
 * does not beat a standing record.
 */
const nameRow = page.locator('.sg-screen--results .sg-results__name')
const named = await nameRow.isVisible().catch(() => false)
console.log('name row   :', named ? 'shown' : 'hidden')
if (named) {
  await page.locator('.sg-name__in').fill('PROBE')
  await page.locator('.sg-results__name .sg-btn').click()
  await page.waitForTimeout(600)
  await page.locator('.sg-screen--results .sg-tab').nth(1).click()
  await page.waitForTimeout(400)
}
const afterSave = await readTabs()
console.log('board cars :', JSON.stringify(afterSave.boardCars))
for (let i = 0; i < 3; i++) {
  await page.locator('.sg-screen--results .sg-tab').nth(i).click()
  await page.waitForTimeout(450)
  await page.screenshot({ path: new URL(`../shots/tab-${i}.png`, import.meta.url).pathname })
}
await page.locator('.sg-screen--results .sg-tab').nth(1).click()
await page.waitForTimeout(300)
await page.screenshot({ path: new URL('../shots/results-records.png', import.meta.url).pathname })
await page.locator('.sg-screen--results .sg-tab').nth(0).click()
await page.waitForTimeout(400)
await page.screenshot({ path: new URL('../shots/results-standings.png', import.meta.url).pathname })
await page.locator('.sg-screen--results .sg-tab').nth(1).click()
await page.waitForTimeout(300)
// The global page, with the stub standing in for the function.
await page.locator('.sg-screen--results .sg-tab').nth(2).click()
await page.waitForTimeout(600)
const glo = await readTabs()
console.log('global     :', JSON.stringify(glo.gloRows))
console.log('global note:', JSON.stringify(glo.gloNote))
if (!glo.hasGlobal) errors.push('there is no global panel')
else if (glo.gloRows.length === 0) errors.push('the global board rendered no rows from the stub')
else {
  if (glo.gloRows.some((r) => !r.car)) errors.push('a global row names no vehicle')
  if (glo.gloRows.some((r) => !/:/.test(r.t))) errors.push('a global row does not show a lap TIME')
  const laps = glo.gloRows.map((r) => r.t)
  if ([...laps].sort().join() !== laps.join()) errors.push(`global rows are not fastest-first: ${laps}`)
  if (!/unverified/i.test(glo.gloNote)) errors.push('the global board does not say it is unverified')
}
await page.locator('.sg-screen--results .sg-tab').nth(1).click()
await page.waitForTimeout(300)

console.log('record who :', JSON.stringify(
  await page.evaluate(() => [...document.querySelectorAll('.sg-rec__who')].map((e) => e.textContent)),
))

/**
 * CENTRING, AT THREE WIDTHS.
 *
 * The standings column rendered LEFT of the centred title and tab strip, and
 * the cause was structural rather than cosmetic: `.sg-screen--results` centres
 * its children with flex, and wrapping them in a tab panel put a plain block in
 * between, so `width: min(720px, 100%)` went flush left. A margin nudge would
 * have hidden that and failed for the next block added to a panel.
 *
 * So this measures every major block's own centre against the viewport's, at
 * desktop, tablet and phone. Centring is a number, not an impression.
 */
/**
 * `rail: true` marks a viewport where the tab strip is a LEFT-HAND RAIL rather
 * than a centred horizontal strip. There, centring is measured against the
 * BODY COLUMN -- the space to the right of the rail -- because the content is
 * deliberately not centred on the viewport any more. Measuring it against the
 * screen would report the rail working as a regression.
 */
const CENTRE_AT = [
  { label: 'desktop', w: 1280, h: 900, rail: false },
  { label: 'tablet', w: 834, h: 1112, rail: true },
  { label: 'phone', w: 390, h: 844, rail: false },
  { label: 'phoneLS', w: 900, h: 410, rail: true },
]
const SELECTORS = [
  '.sg-results__title', '.sg-results__where',
  '.sg-results__rows', '.sg-results__meta', '.sg-results__score',
  '.sg-results__cta',
]

const measureCentre = (rail) => page.evaluate(({ sels, rail }) => {
  // The centre everything is measured against: the viewport, or -- once the
  // tabs are a rail -- the column of screen left over beside it.
  const panels = document.querySelector('.sg-screen--results .sg-tabpanels')
  const pb = panels ? panels.getBoundingClientRect() : null
  const vw = document.documentElement.clientWidth
  const axis = rail && pb && pb.width > 2 ? pb.x + pb.width / 2 : vw / 2
  const span = rail && pb && pb.width > 2 ? pb.width : vw
  const out = []
  for (const sel of sels) {
    const el = document.querySelector('.sg-screen--results ' + sel)
    if (!el) continue
    const b = el.getBoundingClientRect()
    if (b.width < 2) continue
    // The header and the button row span the WHOLE screen in the rail layout
    // -- they sit across both grid columns -- so they are still measured
    // against the viewport. Only what lives inside the panels moved.
    const full = sel === '.sg-results__title' || sel === '.sg-results__where'
      || sel === '.sg-results__cta'
    const a = full ? vw / 2 : axis
    const sp = full ? vw : span
    out.push({
      sel,
      off: +(((b.x + b.width / 2) - a)).toFixed(1),
      frac: +(Math.abs((b.x + b.width / 2) - a) / sp).toFixed(4),
      overflow: +(Math.max(0, b.width - sp)).toFixed(0),
    })
  }
  /**
   * THE OVERLAP, which is the bug this screen was actually reported for.
   *
   * The CTA row is the last child of a flex column, so when the panel above it
   * overflowed, the buttons painted ON TOP of the content instead of being
   * pushed off the bottom: the SAVE button sat behind REMATCH and the board
   * note behind GARAGE. Nothing measured it -- the centring sweep above only
   * ever looked at x.
   *
   * Every element inside the panels is tested against the CTA row's box. Any
   * intersection at all is a failure; there is no acceptable amount of a
   * button sitting over the thing it is meant to sit under.
   */
  const cta = document.querySelector('.sg-screen--results .sg-results__cta')
  const hits = []
  let ctaFrac = 0
  if (cta && panels) {
    const c = cta.getBoundingClientRect()
    ctaFrac = +(c.height / document.documentElement.clientHeight).toFixed(3)
    const walk = (el) => {
      const b = el.getBoundingClientRect()
      if (b.width < 1 || b.height < 1) return
      const over = Math.min(b.bottom, c.bottom) - Math.max(b.top, c.top)
      const side = Math.min(b.right, c.right) - Math.max(b.left, c.left)
      if (over > 0.5 && side > 0.5 && el.textContent && el.textContent.trim()) {
        hits.push({ cls: el.className || el.tagName, by: +over.toFixed(0) })
        return   // report the outermost offender, not every descendant
      }
      for (const ch of el.children) walk(ch)
    }
    walk(panels)
  }
  return { vw, out, hits: hits.slice(0, 4), ctaFrac,
    docW: document.documentElement.scrollWidth }
}, { sels: SELECTORS, rail })

console.log('\ncentring:')
for (const vp of CENTRE_AT) {
  await page.setViewportSize({ width: vp.w, height: vp.h })
  await page.waitForTimeout(500)
  const m = await measureCentre(vp.rail)
  const worst = m.out.reduce((a, b) => (b.frac > a.frac ? b : a), { sel: '-', off: 0, frac: 0 })
  console.log(`  ${vp.label.padEnd(8)} ${String(vp.w).padStart(4)}px  worst ${worst.sel} ${worst.off}px (${(worst.frac * 100).toFixed(2)}%)  scrollW ${m.docW}`)
  for (const e of m.out) {
    // Half a percent of the viewport. Anything past that reads as misaligned
    // next to a centred title.
    if (e.frac > 0.005) errors.push(`${vp.label}: ${e.sel} is ${e.off}px off centre`)
    if (e.overflow > 0) errors.push(`${vp.label}: ${e.sel} is ${e.overflow}px wider than the screen`)
  }
  // A results screen must never scroll sideways on a phone.
  if (m.docW > vp.w + 1) errors.push(`${vp.label}: the page scrolls horizontally (${m.docW} > ${vp.w})`)
  if (m.hits.length) {
    errors.push(`${vp.label}: the CTA row covers ${m.hits.map((h) => `"${String(h.cls).slice(0, 40)}" by ${h.by}px`).join(', ')}`)
  }
  // The buttons are not allowed to be a quarter of the screen.
  if (vp.rail && m.ctaFrac > 0.25) {
    errors.push(`${vp.label}: the CTA row is ${(m.ctaFrac * 100).toFixed(0)}% of the viewport height`)
  }
  console.log(`  ${' '.repeat(10)}cta ${(m.ctaFrac * 100).toFixed(0)}% tall, overlaps ${m.hits.length}`)
  // One frame of each layout for a human to look at. The rail is a shape, and
  // a shape is not something a number can sign off.
  await page.screenshot({ path: new URL(`../shots/results-${vp.label}.png`, import.meta.url).pathname })
}
await page.setViewportSize({ width: 1280, height: 900 })
await page.waitForTimeout(400)

if (last?.p !== 'results') errors.push(`never reached the results screen (phase ${last?.p})`)
else if (before.missing) errors.push('the results screen has no tablist')
else {
  if (before.role !== 'tablist') errors.push(`tab strip role is "${before.role}", not tablist`)
  /**
   * THREE TABS IN A SINGLE RACE, AND A FOURTH PANEL THAT IS NOT ONE.
   *
   * Circuit Mode added a Circuit page, and the requirement was that it be
   * ABSENT outside a circuit rather than present and empty -- so tabs.ts
   * detaches the button from the tablist while leaving the panel built and
   * `hidden`. That is what these two numbers now mean: the tablist a screen
   * reader counts still has three tabs, and the fourth panel is out of the
   * accessibility tree rather than out of memory. `panelCount` was `=== 3`
   * here and is deliberately not any more.
   */
  if (before.labels.length !== 3) errors.push(`${before.labels.length} tabs, expected 3`)
  if (before.labels.includes('Circuit')) {
    errors.push('the Circuit tab is in the tablist during a single race')
  }
  if (before.panelCount !== 4) errors.push(`${before.panelCount} panels built, expected 4`)
  if (before.visiblePanels !== 1) errors.push(`${before.visiblePanels} panels visible at once`)
  if (before.tabbable !== 1) errors.push(`${before.tabbable} tabs in the focus order, expected 1`)
  if (!before.visibleHasStandings) errors.push('does not open on the race standings')
  if (after.visiblePanels !== 1) errors.push(`${after.visiblePanels} panels visible after the click`)
  if (!after.visibleHasRecords) errors.push('clicking Records did not show the records panel')
  if (after.visibleHasStandings) errors.push('the standings are still visible on the records panel')
  if (after.marked.includes('Records')) errors.push('opening the tab did not clear its marker')
  if (after.recRows.length !== 4) errors.push(`${after.recRows.length} record rows, expected 4`)
  const set = after.recRows.filter((r) => r.v && r.v !== '—')
  if (set.length === 0) errors.push('a whole race ran and NO record was set')
  for (const r of set) {
    if (!r.car) errors.push(`record "${r.k}" has a value but names no vehicle`)
  }
  if (!named) errors.push('a first run on an empty board did not offer a name')
  if (afterSave.boardCars.length === 0) {
    errors.push('the named run is not on the leaderboard, or shows no vehicle')
  } else if (afterSave.boardCars.some((c) => !c)) {
    errors.push('a leaderboard row has an empty vehicle cell')
  }
  if (!arrowed.selected.includes('Results')) {
    errors.push(`ArrowLeft left the selection on ${JSON.stringify(arrowed.selected)}`)
  }
}

console.log(`\nerrors: ${errors.length}`, errors.slice(0, 6))
await browser.close()
server.close()
process.exit(errors.length ? 1 : 0)
