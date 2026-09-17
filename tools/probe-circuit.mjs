/**
 * CIRCUIT MODE, DRIVEN THROUGH THE REAL GAME.
 *
 * Every claim this feature makes is a claim about wiring, and wiring is what a
 * unit test fixtures away. tests/circuit.test.ts proves the points table, the
 * tie-breaks and the save round-trip; none of that can tell you whether the
 * grid main.ts hands the simulation is the grid the circuit stored, or whether
 * the tab a player sees actually goes away in single-race mode. So this drives
 * TWO REAL ROUNDS of a real circuit in a real browser and measures:
 *
 *   1. THE GRID. The seven opponents' (pilot, chassis, aiSkill) tuples, read
 *      off race.state.racers, compared BYTE FOR BYTE between round 1 and
 *      round 2 -- with the player's own car deliberately CHANGED in between,
 *      which is the exact thing that used to rotate the opponents. This is the
 *      proof the standings mean anything.
 *   2. THE TAB. Absent in single-race mode (not present-and-empty: the button
 *      must not be in the DOM, and the tablist must announce three tabs), and
 *      present in circuit mode.
 *   3. THE AUTO-SWITCH. Opens on Results, moves to Circuit on its own, and
 *      DOES NOT MOVE FOCUS while doing it -- document.activeElement is
 *      recorded before and after.
 *   4. THE AUTO-SWITCH LOSING TO THE PLAYER. A second round where a tab is
 *      clicked inside the window; the switch must not fire.
 *   5. THE STANDINGS. Points that match the finishing positions, one row per
 *      entrant, and exactly one row marked as the player.
 *   6. THE HIGHLIGHT, as a measurement rather than an impression: the marked
 *      row's rail width and painted colour against its neighbours', and the
 *      WCAG contrast of the YOU chip.
 *   7. SHOTS of both tabs at desktop, portrait phone and landscape phone, with
 *      the player forced somewhere other than 1st so the highlight is working.
 *
 * WAITS ON SIM PHASE, NEVER WALL CLOCK -- under SwiftShader this renderer runs
 * below 1fps. Same approach as tools/probe-tabs.mjs: shorten the race to one
 * lap and let the AI drive the player's car, so the whole shipping path from
 * the flag through the circuit store to the panel runs exactly as in play.
 *
 * NEEDS dist/: run `npx vite build` first.
 *
 *   node tools/probe-circuit.mjs [--shots]
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

const SHOTS = process.argv.includes('--shots')
const OUT = new URL('../shots/circuit/', import.meta.url).pathname
if (SHOTS) await mkdir(OUT, { recursive: true })

const errors = []
const note = (m) => errors.push(m)

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist'],
})
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', (e) => note('page error: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') note('console: ' + m.text()) })

await page.goto(url, { waitUntil: 'load', timeout: 30000 })
await page.waitForTimeout(2500)

// A clean slate: no saved circuit, no board, no records from an earlier run.
await page.evaluate(() => {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k && (k.startsWith('sg.board.') || k.startsWith('sg.records.') || k === 'sg.circuit')) {
        localStorage.removeItem(k)
      }
    }
    localStorage.setItem('sg.name', 'PROBE')
  } catch { /* blocked */ }
})

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

const phase = () => page.evaluate(() => {
  const g = window.__GAME__
  const st = g.race?.state
  const r = st?.racers?.[g.localId]
  return { p: g.phase, sp: st?.phase ?? '-', t: +(st?.time ?? 0).toFixed(1), fin: !!r?.finished }
})

/** The field the SIMULATION was actually given, not the one the save holds. */
const readField = () => page.evaluate(() => {
  const st = window.__GAME__.race?.state
  if (!st) return null
  return st.racers.map((r) => ({
    id: r.id, pilotId: r.pilotId, chassisId: r.chassisId, aiSkill: r.aiSkill,
  }))
})

const readSave = () => page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('sg.circuit') || 'null') } catch { return null }
})

const readTabs = () => page.evaluate(() => {
  const list = document.querySelector('.sg-screen--results .sg-tabs')
  const tabs = [...document.querySelectorAll('.sg-screen--results .sg-tab')]
  const panels = [...document.querySelectorAll('.sg-screen--results .sg-tabpanel')]
  const vis = panels.filter((p) => !p.hidden)
  const active = document.activeElement
  return {
    hasList: !!list,
    // The BUTTONS IN THE TABLIST, which is what a screen reader counts.
    labels: tabs.map((t) => t.textContent),
    inList: list ? [...list.children].map((c) => c.textContent) : [],
    selected: tabs.filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent),
    marked: tabs.filter((t) => t.dataset.mark).map((t) => t.textContent),
    tabbable: tabs.filter((t) => t.tabIndex === 0).length,
    visible: vis.length,
    showingCircuit: vis.some((p) => p.querySelector('.sg-crows')),
    showingResults: vis.some((p) => p.querySelector('.sg-results__rows')),
    // Is a Circuit panel rendered but empty? That is the failure mode the
    // "must not appear at all" requirement is about.
    circuitPanelHidden: panels.filter((p) => p.querySelector('.sg-crows')).every((p) => p.hidden),
    focus: active ? (active.className || active.tagName) + '|' + (active.textContent || '').slice(0, 14) : 'none',
    focusRole: active ? active.getAttribute('role') : null,
    live: document.querySelector('.sg-screen--results .sg-sr')?.textContent ?? '',
  }
})

const readStandings = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('.sg-crow')].map((r) => ({
    place: r.querySelector('.sg-crow__p')?.textContent ?? '',
    who: r.querySelector('.sg-crow__who')?.textContent ?? '',
    car: r.querySelector('.sg-crow__chassis')?.textContent ?? '',
    gain: r.querySelector('.sg-crow__gain')?.textContent ?? '',
    pts: +(r.querySelector('.sg-crow__pts')?.textContent ?? '0'),
    you: r.classList.contains('is-you'),
    win: r.classList.contains('is-win'),
    youChip: !!r.querySelector('.sg-you'),
  }))
  return {
    rows,
    title: document.querySelector('.sg-results__circuit .sg-board__title')?.textContent ?? '',
    line: document.querySelector('.sg-circuit__you')?.textContent ?? '',
    note: document.querySelector('.sg-results__circuit .sg-board__note')?.textContent ?? '',
  }
})

const readRaceRows = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('.sg-results__rows .sg-row')].filter((r) => !r.hidden)
  return rows.map((r) => ({
    pos: r.querySelector('.sg-row__p')?.textContent ?? '',
    who: r.querySelector('.sg-row__who')?.textContent ?? '',
    you: r.classList.contains('is-you'),
    win: r.classList.contains('is-win'),
    youChipShown: !!r.querySelector('.sg-you:not([hidden])'),
    ariaCurrent: r.getAttribute('aria-current'),
  }))
})

/**
 * THE HIGHLIGHT AS NUMBERS.
 *
 * "The player's row stands out" is not falsifiable; "the marked row's left
 * rail is 10px of #22d3ff against 6px of rgba(122,190,255,0.16) and the YOU
 * chip is 10.7:1" is. Contrast is computed here with real compositing rather
 * than from the token values, because a row sits on a gradient over a panel
 * over a page background and the token is not what reaches the eye.
 */
const measureMarker = (rowSel) => page.evaluate((sel) => {
  const lum = (r, g, b) => {
    const f = (v) => {
      const c = v / 255
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const ratio = (a, b) => {
    const [hi, lo] = a > b ? [a, b] : [b, a]
    return (hi + 0.05) / (lo + 0.05)
  }
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || '')
    if (!m) return null
    const p = m[1].split(',').map((v) => parseFloat(v))
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
  }
  /** Composite a stack of rgba layers, front last, onto an opaque base. */
  const over = (base, layers) => {
    let o = { ...base }
    for (const l of layers) {
      if (!l) continue
      o = {
        r: l.r * l.a + o.r * (1 - l.a),
        g: l.g * l.a + o.g * (1 - l.a),
        b: l.b * l.a + o.b * (1 - l.a),
        a: 1,
      }
    }
    return o
  }
  const rows = [...document.querySelectorAll(sel)].filter((r) => !r.hidden)
  const you = rows.find((r) => r.classList.contains('is-you'))
  const other = rows.find((r) => !r.classList.contains('is-you') && !r.classList.contains('is-win'))
  if (!you || !other) return { missing: true, rows: rows.length }
  const cs = (e) => getComputedStyle(e)
  const y = cs(you)
  const o = cs(other)
  // The page behind everything. Measured off the screen element rather than
  // assumed, then flattened to an opaque colour for the compositing above.
  const screenBg = parse(cs(document.querySelector('.sg-fe')).backgroundColor)
    || { r: 5, g: 7, b: 15, a: 1 }
  const base = { r: screenBg.r, g: screenBg.g, b: screenBg.b, a: 1 }

  const railY = parse(y.borderLeftColor)
  const railO = parse(o.borderLeftColor)
  const yFlat = over(base, [parse(y.backgroundColor)])
  const oFlat = over(base, [parse(o.backgroundColor)])

  const chip = you.querySelector('.sg-you')
  let chipRatio = 0
  let chipBg = ''
  let chipFg = ''
  if (chip) {
    const c = cs(chip)
    const bg = over(yFlat, [parse(c.backgroundColor)])
    const fg = over(bg, [parse(c.color)])
    chipRatio = ratio(lum(bg.r, bg.g, bg.b), lum(fg.r, fg.g, fg.b))
    chipBg = c.backgroundColor
    chipFg = c.color
  }

  const caret = getComputedStyle(you, '::before')
  const nameY = over(yFlat, [parse(cs(you.querySelector('.sg-row__who, .sg-crow__who')).color)])
  const nameO = over(oFlat, [parse(cs(other.querySelector('.sg-row__who, .sg-crow__who')).color)])

  return {
    missing: false,
    rows: rows.length,
    marked: rows.filter((r) => r.classList.contains('is-you')).length,
    railWidth: { you: y.borderLeftWidth, other: o.borderLeftWidth },
    railColour: { you: y.borderLeftColor, other: o.borderLeftColor },
    // Non-text contrast (WCAG 1.4.11 wants >= 3:1) of the rail against the
    // row body it sits on, and of the two rails against each other.
    railVsRow: +ratio(
      lum(over(base, [railY]).r, over(base, [railY]).g, over(base, [railY]).b),
      lum(yFlat.r, yFlat.g, yFlat.b),
    ).toFixed(2),
    railVsRail: +ratio(
      lum(over(base, [railY]).r, over(base, [railY]).g, over(base, [railY]).b),
      lum(over(base, [railO]).r, over(base, [railO]).g, over(base, [railO]).b),
    ).toFixed(2),
    // Greyscale separation: the luminance step a colourblind or monochrome
    // viewer actually gets from the rail.
    railLum: {
      you: +lum(over(base, [railY]).r, over(base, [railY]).g, over(base, [railY]).b).toFixed(4),
      other: +lum(over(base, [railO]).r, over(base, [railO]).g, over(base, [railO]).b).toFixed(4),
    },
    rowBgRatio: +ratio(lum(yFlat.r, yFlat.g, yFlat.b), lum(oFlat.r, oFlat.g, oFlat.b)).toFixed(2),
    nameOnRow: +ratio(lum(nameY.r, nameY.g, nameY.b), lum(yFlat.r, yFlat.g, yFlat.b)).toFixed(2),
    otherNameOnRow: +ratio(lum(nameO.r, nameO.g, nameO.b), lum(oFlat.r, oFlat.g, oFlat.b)).toFixed(2),
    chip: { ratio: +chipRatio.toFixed(2), bg: chipBg, fg: chipFg, present: !!chip },
    caret: {
      content: caret.content,
      // A CSS triangle: zero box, coloured left border, transparent top/bottom.
      w: caret.borderLeftWidth, colour: caret.borderLeftColor,
      top: caret.borderTopWidth,
    },
  }
}, rowSel)

// ---------------------------------------------------------------------------
// Driving
// ---------------------------------------------------------------------------

/** Race the round the game is currently set up for, to the results screen. */
async function race(label) {
  await page.evaluate(() => {
    const g = window.__GAME__
    g.maxSubSteps = 900
    const st = g.race && g.race.state
    if (!st) return
    st.totalLaps = 1
    // The AI drives the player's car: a probe can hold a throttle but cannot
    // steer, and a car that parks on the first barrier never finishes. It is
    // still racer localId, so the results, the score, the board and the
    // circuit all treat it as the player. Same rail as tools/probe-tabs.mjs.
    const r = st.racers[g.localId]
    if (r) r.isAI = true
  })
  let last = null
  for (let i = 0; i < 900; i++) {
    last = await phase()
    if (last.p === 'results') break
    await page.waitForTimeout(400)
  }
  console.log(`  ${label}: reached ${last?.p} at ${last?.t}s of sim`)
  if (last?.p !== 'results') note(`${label}: never reached the results screen (${last?.p})`)
  return last
}

// ===========================================================================
// PART 1 — a SINGLE RACE. The Circuit tab must not exist.
// ===========================================================================
console.log('\n=== single race: the Circuit tab must be absent ===')
await page.evaluate(() => { window.__GAME__.startRace() })
await page.waitForTimeout(600)
await race('single race')
await page.waitForTimeout(400)

const single = await readTabs()
console.log('  tabs in the tablist :', JSON.stringify(single.inList))
console.log('  panels visible      :', single.visible, '| showing results:', single.showingResults)
console.log('  circuit panel hidden:', single.circuitPanelHidden)
console.log('  primary button      :', await page.locator('.sg-results__cta .sg-btn--gold').textContent())
if (single.inList.includes('Circuit')) {
  note('the Circuit tab is in the tablist during a single race')
}
if (single.inList.length !== 3) note(`single race shows ${single.inList.length} tabs, expected 3`)
if (!single.circuitPanelHidden) note('the Circuit panel is visible during a single race')
if (single.showingCircuit) note('a single race is showing circuit standings')
const singleRows = await readRaceRows()
const singleYou = singleRows.filter((r) => r.you)
console.log('  rows                :', singleRows.length, '| marked as you:', singleYou.length)
if (singleYou.length !== 1) note(`${singleYou.length} rows marked as the player in a single race`)
if (!singleYou[0]?.youChipShown) note('the player’s row has no YOU chip in a single race')
if (singleYou[0]?.ariaCurrent !== 'true') note('the player’s row is not aria-current')
// And nothing was written to the circuit save by a single race.
if (await readSave() !== null) note('a single race wrote to the circuit save')

// ===========================================================================
// PART 2 — ROUND 1 of a real circuit, started from the title screen.
// ===========================================================================
console.log('\n=== circuit round 1 ===')
await page.evaluate(() => { window.__GAME__.frontEnd.show('title') })
await page.waitForTimeout(500)
const cline = await page.locator('.sg-title__cline').textContent()
const cbtn = await page.locator('.sg-title__circuit .sg-btn--gold').textContent()
console.log(`  title screen        : "${cbtn}" / "${cline}"`)
if (!/8 rounds/i.test(cline || '')) note(`the title circuit line reads "${cline}"`)
await page.locator('.sg-title__circuit .sg-btn--gold').click()
await page.waitForTimeout(600)
const garageHead = await page.locator('.sg-screen--garage .sg-head__title').textContent()
const startLabel = await page.locator('.sg-screen--garage .sg-btn--start').textContent()
console.log(`  garage              : "${garageHead}" / "${startLabel}"`)
if (!/ROUND 1\/8/.test(garageHead || '')) note(`the garage head reads "${garageHead}"`)
if (!/ELKARIM/.test(garageHead || '')) note('round 1 is not Elkarim')
if (!/Round 1/.test(startLabel || '')) note(`the start button reads "${startLabel}"`)

await page.locator('.sg-screen--garage .sg-btn--start').click()
await page.waitForTimeout(900)
const trackR1 = await page.evaluate(() => window.__GAME__.track.def.id)
console.log('  racing on           :', trackR1)
if (trackR1 !== 'rustfall') note(`round 1 ran on ${trackR1}, not rustfall`)
const fieldR1 = await readField()
await race('round 1')
await page.waitForTimeout(500)

const afterR1 = await readTabs()
console.log('  tabs                :', JSON.stringify(afterR1.inList))
console.log('  opens on            :', JSON.stringify(afterR1.selected), '| marked', JSON.stringify(afterR1.marked))
console.log('  focus on arrival    :', afterR1.focus)
if (!afterR1.inList.includes('Circuit')) note('the Circuit tab is missing in circuit mode')
if (afterR1.inList.length !== 4) note(`circuit mode shows ${afterR1.inList.length} tabs, expected 4`)
if (!afterR1.selected.includes('Results')) note('the circuit results do not open on the race')
if (!afterR1.showingResults) note('the race standings are not the visible panel on arrival')
if (afterR1.tabbable !== 1) note(`${afterR1.tabbable} tabs in the focus order`)

// --- THE AUTO-SWITCH ------------------------------------------------------
// Armed for 3000ms from showResults(); this waits past it and no further.
const focusBefore = afterR1.focus
await page.waitForTimeout(3400)
const switched = await readTabs()
console.log('  after 3.4s          :', JSON.stringify(switched.selected),
  '| showing circuit:', switched.showingCircuit)
console.log('  focus after         :', switched.focus, '(was', focusBefore + ')')
console.log('  live region         :', JSON.stringify(switched.live.slice(0, 80)))
if (!switched.selected.includes('Circuit')) note('the auto-switch to the standings never happened')
if (!switched.showingCircuit) note('the standings panel is not the visible one after the switch')
if (switched.focus !== focusBefore) {
  note(`the auto-switch MOVED FOCUS: ${focusBefore} -> ${switched.focus}`)
}
if (!switched.live) note('the auto-switch was not announced to assistive tech')
if (switched.visible !== 1) note(`${switched.visible} panels visible after the switch`)

const st1 = await readStandings()
console.log('  title               :', JSON.stringify(st1.title))
console.log('  line                :', JSON.stringify(st1.line))
console.log('  note                :', JSON.stringify(st1.note))
console.log('  standings           :')
for (const r of st1.rows) {
  console.log(`    ${r.place.padStart(2)}  ${r.who.padEnd(10)} ${r.car.padEnd(15)} `
    + `${r.gain.padStart(4)} ${String(r.pts).padStart(3)}  ${r.you ? 'YOU' : ''}${r.win ? ' WIN' : ''}`)
}
if (st1.rows.length !== 8) note(`${st1.rows.length} standings rows, expected 8`)
if (st1.rows.filter((r) => r.you).length !== 1) note('the standings do not mark exactly one row as the player')
if (!st1.rows.find((r) => r.you)?.youChip) note('the player’s standings row has no YOU chip')
// After one round the points have to be exactly the table.
const POINTS = [15, 12, 10, 8, 6, 4, 2, 1]
const got = st1.rows.map((r) => r.pts)
if (JSON.stringify(got) !== JSON.stringify(POINTS)) {
  note(`after round 1 the standings read ${got.join(',')}, expected ${POINTS.join(',')}`)
}
if (!/ROUND 1 OF 8/.test(st1.title)) note(`the standings title reads "${st1.title}"`)
const save1 = await readSave()
console.log('  save                : v' + save1?.v, '| rounds', save1?.rounds?.length,
  '| grid', save1?.grid?.length)
if (!save1) note('round 1 was not saved')
else {
  if (save1.rounds.length !== 1) note(`the save holds ${save1.rounds.length} rounds after round 1`)
  if (save1.rounds[0].trackId !== 'rustfall') note('the saved round 1 is not rustfall')
  if (typeof save1.sig !== 'string' || !save1.sig.includes('|15,12,10')) {
    note('the save carries no content signature')
  }
}

// --- the highlight, measured ---------------------------------------------
console.log('\n=== the player’s row, measured ===')
for (const [label, sel] of [['race result', '.sg-results__rows .sg-row'], ['standings', '.sg-crow']]) {
  const m = await measureMarker(sel)
  if (m.missing) { note(`${label}: could not find a marked row and an unmarked one`); continue }
  console.log(`  ${label}`)
  console.log(`    rows ${m.rows}, marked ${m.marked}`)
  console.log(`    rail  ${m.railWidth.you} ${m.railColour.you}`)
  console.log(`          ${m.railWidth.other} ${m.railColour.other}  (a neighbour)`)
  console.log(`    rail vs row body      ${m.railVsRow}:1  (WCAG 1.4.11 non-text wants >= 3)`)
  console.log(`    rail vs other rail    ${m.railVsRail}:1`)
  console.log(`    rail luminance        ${m.railLum.you} vs ${m.railLum.other}  (greyscale channel)`)
  console.log(`    row tint vs neighbour ${m.rowBgRatio}:1`)
  console.log(`    name on row           ${m.nameOnRow}:1  (neighbour ${m.otherNameOnRow}:1)`)
  console.log(`    YOU chip              ${m.chip.ratio}:1  ${m.chip.fg} on ${m.chip.bg}`)
  console.log(`    caret                 ${m.caret.w} ${m.caret.colour} (half-height ${m.caret.top})`)
  if (m.marked !== 1) note(`${label}: ${m.marked} rows marked as the player`)
  if (!m.chip.present) note(`${label}: no YOU chip on the marked row`)
  if (m.chip.ratio < 4.5) note(`${label}: the YOU chip is ${m.chip.ratio}:1, under AA 4.5`)
  if (m.railVsRow < 3) note(`${label}: the rail is ${m.railVsRow}:1 against the row, under 3:1`)
  if (parseFloat(m.railWidth.you) <= parseFloat(m.railWidth.other)) {
    note(`${label}: the marked rail is not wider than a neighbour's, so the marker is hue only`)
  }
  if (m.nameOnRow < 4.5) note(`${label}: the marked name is ${m.nameOnRow}:1, under AA 4.5`)
  if (!/px/.test(m.caret.w) || parseFloat(m.caret.w) < 4) {
    note(`${label}: the caret is not painted (border-left ${m.caret.w})`)
  }
}

// ===========================================================================
// PART 3 — ROUND 2, with the PLAYER'S CAR CHANGED. The grid must not move.
// ===========================================================================
console.log('\n=== circuit round 2, after the player changes car ===')
// Through the garage, the way a player would, so the change is real.
await page.locator('.sg-results__cta .sg-btn--ghost').first().click()
await page.waitForTimeout(600)
const head2 = await page.locator('.sg-screen--garage .sg-head__title').textContent()
console.log(`  garage              : "${head2}"`)
if (!/ROUND 2\/8/.test(head2 || '')) note(`the garage head reads "${head2}" before round 2`)
// Pick a different chassis by its id, not by its visible name.
const before = await page.evaluate(() => window.__GAME__.frontEnd.selectedChassisId)
const target = await page.evaluate((cur) => {
  const cards = [...document.querySelectorAll('.sg-screen--garage [data-chassis]')]
  const other = cards.find((c) => c.dataset.chassis !== cur)
  return other ? other.dataset.chassis : null
}, before)
await page.locator(`.sg-screen--garage [data-chassis="${target}"]`).click()
await page.waitForTimeout(400)
const after = await page.evaluate(() => window.__GAME__.frontEnd.selectedChassisId)
console.log(`  player's car        : ${before} -> ${after}`)
if (after === before) note('the probe failed to change the player’s car, so the grid test is vacuous')

await page.locator('.sg-screen--garage .sg-btn--start').click()
await page.waitForTimeout(900)
const trackR2 = await page.evaluate(() => window.__GAME__.track.def.id)
console.log('  racing on           :', trackR2)
if (trackR2 !== 'halcyon') note(`round 2 ran on ${trackR2}, not halcyon`)
const fieldR2 = await readField()

// --- THE PROOF ------------------------------------------------------------
console.log('\n  THE GRID, ROUND 1 vs ROUND 2 (as the SIM received it):')
const key = (e) => `${e.pilotId}/${e.chassisId}/skill${e.aiSkill}`
let drift = 0
for (let i = 0; i < 8; i++) {
  const a = fieldR1?.[i]
  const b = fieldR2?.[i]
  const same = a && b && key(a) === key(b)
  const tag = i === 0 ? 'player' : same ? 'same' : 'CHANGED'
  if (i > 0 && !same) drift++
  console.log(`    slot ${i}  ${String(a && key(a)).padEnd(28)} -> ${String(b && key(b)).padEnd(28)} ${tag}`)
}
if (drift > 0) note(`${drift} of the seven opponents changed between rounds`)
if (fieldR1 && fieldR2 && key(fieldR1[0]) === key(fieldR2[0])) {
  note('the player’s own car did not change, so the grid test proved nothing')
}

// --- and the auto-switch must LOSE to a click ----------------------------
await race('round 2')
await page.waitForTimeout(300)
const openedOn = await readTabs()
if (!openedOn.selected.includes('Results')) note('round 2 did not open on the race result')
/**
 * AND THE HEADER NAMES THE CIRCUIT THE RACE WAS ON.
 *
 * In circuit mode the series picks the track and the track screen is skipped,
 * so the front end's remembered selection is the LAST SINGLE RACE's circuit.
 * Reading it here put "ELKARIM — JUNKYARD PLANET" over a result from Halcyon
 * Bay: a wrong fact stated confidently, which is worse than a missing one.
 */
const where2 = await page.locator('.sg-results__where').textContent()
console.log('  header says         :', JSON.stringify(where2))
if (!/HALCYON BAY/i.test(where2 || '')) {
  note(`round 2's results are headed "${where2}", not Halcyon Bay`)
}
// Click Records inside the 3s window. The switch must not fire.
await page.locator('.sg-screen--results .sg-tab', { hasText: 'Records' }).click()
await page.waitForTimeout(3600)
const held = await readTabs()
console.log('\n  clicked Records at ~0.3s, then waited 3.6s')
console.log('  selected            :', JSON.stringify(held.selected))
if (held.selected.includes('Circuit')) {
  note('the auto-switch overrode a tab the player had chosen')
}
if (!held.selected.includes('Records')) note(`a clicked tab did not stick: ${held.selected}`)

// --- and the standings are cumulative ------------------------------------
await page.locator('.sg-screen--results .sg-tab', { hasText: 'Circuit' }).click()
await page.waitForTimeout(400)
const st2 = await readStandings()
console.log('\n  standings after round 2:')
for (const r of st2.rows) {
  console.log(`    ${r.place.padStart(2)}  ${r.who.padEnd(10)} ${r.car.padEnd(15)} `
    + `${r.gain.padStart(4)} ${String(r.pts).padStart(3)}  ${r.you ? 'YOU' : ''}${r.win ? ' WIN' : ''}`)
}
console.log('  line                :', JSON.stringify(st2.line))
console.log('  note                :', JSON.stringify(st2.note))
const total2 = st2.rows.reduce((a, r) => a + r.pts, 0)
const wantTotal = POINTS.reduce((a, b) => a + b, 0) * 2
console.log(`  points on the table : ${total2} (two full rounds pay ${wantTotal})`)
if (!/ROUND 2 OF 8/.test(st2.title)) note(`the standings title reads "${st2.title}"`)
// Every car finished in both probe rounds, so the table must hold exactly two
// rounds' worth of points. A DNF would legitimately reduce it, so this is only
// asserted when nothing shows DNF.
if (!st2.rows.some((r) => /DNF/.test(r.gain)) && total2 !== wantTotal) {
  note(`the standings total ${total2} after two clean rounds, expected ${wantTotal}`)
}
if (!/Next: Namaresh/.test(st2.note)) note(`the standings do not name round 3: "${st2.note}"`)
const save2 = await readSave()
if (save2?.rounds?.length !== 2) note(`the save holds ${save2?.rounds?.length} rounds after round 2`)

// --- resume ---------------------------------------------------------------
console.log('\n=== resume ===')
await page.evaluate(() => { window.__GAME__.frontEnd.show('title') })
await page.waitForTimeout(500)
const resumeBtn = await page.locator('.sg-title__circuit .sg-btn--gold').textContent()
const resumeLine = await page.locator('.sg-title__cline').textContent()
const discard = await page.locator('.sg-title__circuit .sg-btn--ghost').isVisible()
console.log(`  "${resumeBtn}" / "${resumeLine}" | discard offered: ${discard}`)
if (!/Continue/i.test(resumeBtn || '')) note(`the title button reads "${resumeBtn}" with a save present`)
if (!/Round 3 of 8/.test(resumeLine || '')) note(`the resume line reads "${resumeLine}"`)
if (!discard) note('no way to start a fresh circuit is offered')
// The destructive control takes two presses.
await page.locator('.sg-title__circuit .sg-btn--ghost').click()
await page.waitForTimeout(300)
const armed = await page.locator('.sg-title__circuit .sg-btn--ghost').textContent()
console.log(`  one press on discard: "${armed}"`)
if (!/again/i.test(armed || '')) note('discarding a circuit does not ask for confirmation')
if (await readSave() === null) note('one press on New circuit already destroyed the save')

if (SHOTS) {
  // ===========================================================================
  // PART 4 — the photographs. Both tabs, three viewports, player NOT 1st.
  // ===========================================================================
  console.log('\n=== shots ===')
  await page.locator('.sg-title__circuit .sg-btn--gold').click()   // continue
  await page.waitForTimeout(500)
  await page.locator('.sg-screen--garage .sg-btn--start').click()
  await page.waitForTimeout(900)
  await race('round 3')
  await page.waitForTimeout(500)

  /**
   * THE PLAYER IS FORCED OFF THE FRONT ROW.
   *
   * With the AI driving the player's car the finishing position is whatever
   * the sim produced, and a highlight photographed on a row that is ALSO the
   * winner's row proves the easy case. So the finishing order is rewritten to
   * put the player 3rd and the screen redrawn through the shipping
   * showResults() path -- the rows, the classes, the chip and the standings
   * are all built by the same code as in play.
   */
  const shot = await page.evaluate(() => {
    const g = window.__GAME__
    const st = g.race.state
    const me = st.racers[g.localId]
    // Give the player 3rd: swap positions with whoever is there.
    const third = st.racers.find((r) => r.position === 3)
    if (third && me && third !== me) {
      const mine = me.position
      me.position = 3
      third.position = mine
    }
    for (const r of st.racers) r.finished = true
    // THE TRACK IS PASSED. The first cut of this block left it out, and the
    // screen fell back to the front end's remembered SINGLE-RACE selection --
    // so the photographs came out headed "ELKARIM — JUNKYARD PLANET" over a
    // result from Namaresh. That is exactly the bug the fourth argument exists
    // to fix, reintroduced by the harness measuring it.
    g.frontEnd.showResults(st, g.localId, { score: 184320, bestCombo: 6.4 }, g.track.def.id)
    return { pos: me.position, track: g.track.def.id }
  })
  console.log('  player forced to position', shot.pos, 'on', shot.track)
  if (shot.track !== 'aetherion') note(`round 3 ran on ${shot.track}, not aetherion`)
  await page.waitForTimeout(2200)
  const shotWhere = await page.locator('.sg-results__where').textContent()
  console.log('  header says         :', JSON.stringify(shotWhere))
  if (!/NAMARESH/i.test(shotWhere || '')) {
    note(`round 3's results are headed "${shotWhere}", not Namaresh`)
  }

  const VIEWS = [
    { name: 'desktop', w: 1440, h: 810, mobile: false },
    { name: 'phone-portrait', w: 412, h: 915, mobile: true },
    { name: 'phone-landscape', w: 915, h: 412, mobile: true },
  ]
  for (const v of VIEWS) {
    await page.setViewportSize({ width: v.w, height: v.h })
    await page.waitForTimeout(700)
    for (const tab of ['Results', 'Circuit']) {
      await page.locator('.sg-screen--results .sg-tab', { hasText: tab }).click()
      await page.waitForTimeout(650)
      const file = join(OUT, `${v.name}-${tab.toLowerCase()}.png`)
      await page.screenshot({ path: file })
      console.log(`  ${file.replace(OUT, '')}`)
    }
    // Horizontal scroll on a results screen is a bug, and a new tab is a new
    // chance to cause one.
    const docW = await page.evaluate(() => document.documentElement.scrollWidth)
    if (docW > v.w + 1) note(`${v.name}: the page scrolls horizontally (${docW} > ${v.w})`)
    /**
     * The CTA row must not paint over the standings, which is what the grid
     * layout in styles.css exists to prevent.
     *
     * CLIPPED BY ITS SCROLLER FIRST. getBoundingClientRect() reports where an
     * element WOULD be, not where it is painted, so a row scrolled below the
     * bottom of an `overflow-y: auto` list has a rect that runs straight
     * through the button row while nothing is drawn there. The first cut of
     * this check reported 33px of overlap on a landscape phone and a
     * screenshot showed clean daylight between the two. So every rect is
     * intersected with each scrollable ancestor's box before being compared --
     * which is what "painted over" actually means.
     */
    const overlap = await page.evaluate(() => {
      const cta = document.querySelector('.sg-screen--results .sg-results__cta')
      const panels = document.querySelector('.sg-screen--results .sg-tabpanels')
      if (!cta || !panels) return 0
      const c = cta.getBoundingClientRect()
      const clipTo = (b, el) => {
        let out = { top: b.top, bottom: b.bottom, left: b.left, right: b.right }
        for (let p = el.parentElement; p; p = p.parentElement) {
          const s = getComputedStyle(p)
          if (!/auto|scroll|hidden/.test(s.overflowY + s.overflowX)) continue
          const r = p.getBoundingClientRect()
          out = {
            top: Math.max(out.top, r.top), bottom: Math.min(out.bottom, r.bottom),
            left: Math.max(out.left, r.left), right: Math.min(out.right, r.right),
          }
          if (p === document.documentElement) break
        }
        return out
      }
      let worst = 0
      const walk = (el) => {
        const raw = el.getBoundingClientRect()
        if (raw.width < 1 || raw.height < 1) return
        const b = clipTo(raw, el)
        if (b.bottom - b.top < 0.5 || b.right - b.left < 0.5) return
        const over = Math.min(b.bottom, c.bottom) - Math.max(b.top, c.top)
        const side = Math.min(b.right, c.right) - Math.max(b.left, c.left)
        if (over > 0.5 && side > 0.5 && el.textContent && el.textContent.trim()) {
          worst = Math.max(worst, over); return
        }
        for (const ch of el.children) walk(ch)
      }
      walk(panels)
      return Math.round(worst)
    })
    if (overlap > 0) note(`${v.name}: the CTA row covers the panel by ${overlap}px`)

    /**
     * AND THE PLAYER'S ROW HAS TO BE ON SCREEN, which is the whole point of
     * the highlight: a marker on a row that has been scrolled out of the list
     * is a marker nobody sees. Measured as "is the marked row's painted box
     * inside its scroller's painted box", on whichever tab is showing.
     */
    const visible = await page.evaluate(() => {
      const row = document.querySelector('.sg-tabpanel:not([hidden]) .is-you')
      if (!row) return { found: false }
      let host = row.parentElement
      while (host && !/auto|scroll/.test(getComputedStyle(host).overflowY)) host = host.parentElement
      const r = row.getBoundingClientRect()
      const h = (host || document.documentElement).getBoundingClientRect()
      const shown = Math.min(r.bottom, h.bottom) - Math.max(r.top, h.top)
      return { found: true, frac: +(shown / r.height).toFixed(2), h: Math.round(r.height) }
    })
    console.log(`    scrollW ${docW}, cta overlap ${overlap}px, `
      + `player's row ${visible.found ? (visible.frac * 100) + '% visible' : 'NOT FOUND'}`)
    if (!visible.found) note(`${v.name}: no row is marked as the player on the open tab`)
    else if (visible.frac < 0.999) {
      note(`${v.name}: the player's row is only ${(visible.frac * 100).toFixed(0)}% on screen`)
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 })

  /**
   * THE CASE THE BUG WAS ACTUALLY ABOUT: WINNING.
   *
   * `.sg-row.is-you` used to set the `border-color` shorthand and
   * `.sg-row.is-win` set `border-left-color` after it, so a player who
   * finished FIRST lost the only edge that said the row was theirs -- the one
   * race where finding yourself matters most was the one where the highlight
   * did not work. The two states now touch disjoint longhands; this measures
   * that on a real row wearing both classes.
   */
  await page.waitForTimeout(400)
  const both = await page.evaluate(() => {
    const g = window.__GAME__
    const st = g.race.state
    const me = st.racers[g.localId]
    const first = st.racers.find((r) => r.position === 1)
    if (first && first !== me) { first.position = me.position; me.position = 1 }
    g.frontEnd.showResults(st, g.localId, { score: 210000, bestCombo: 8 }, g.track.def.id)
    return null
  })
  void both
  await page.waitForTimeout(2200)
  await page.locator('.sg-screen--results .sg-tab', { hasText: 'Results' }).click()
  await page.waitForTimeout(700)
  const winner = await page.evaluate(() => {
    const row = document.querySelector('.sg-results__rows .sg-row.is-you')
    if (!row) return { found: false }
    const cs = getComputedStyle(row)
    return {
      found: true,
      isWin: row.classList.contains('is-win'),
      left: cs.borderLeftColor, leftW: cs.borderLeftWidth,
      top: cs.borderTopColor, right: cs.borderRightColor,
      chip: !!row.querySelector('.sg-you:not([hidden])'),
      caret: getComputedStyle(row, '::before').borderLeftWidth,
      pos: row.querySelector('.sg-row__p')?.textContent,
      posColour: getComputedStyle(row.querySelector('.sg-row__p')).color,
    }
  })
  console.log('\n=== the player IS the winner ===')
  console.log('  ', JSON.stringify(winner))
  if (!winner.found) note('no marked row when the player wins')
  else {
    if (!winner.isWin) note('the winning player’s row is not marked as the winner')
    // Cyan on the left (you), gold on the other edges (first).
    if (!/34, *211, *255/.test(winner.left)) {
      note(`winning + you: the left edge is ${winner.left}, not cyan -- the marker was overwritten`)
    }
    if (!/255, *210, *63/.test(winner.top)) {
      note(`winning + you: the top edge is ${winner.top}, not gold`)
    }
    if (parseFloat(winner.leftW) < 9) note(`winning + you: the rail is only ${winner.leftW}`)
    if (!winner.chip) note('winning + you: no YOU chip')
    if (parseFloat(winner.caret) < 4) note('winning + you: no caret')
    if (!/255, *210, *63/.test(winner.posColour)) note('winning + you: the place is not gold')
  }
  await page.screenshot({ path: join(OUT, 'desktop-results-winner.png') })
}

console.log(`\nerrors: ${errors.length}`)
for (const e of errors) console.log('  -', e)
await browser.close()
server.close()
process.exit(errors.length ? 1 : 0)
