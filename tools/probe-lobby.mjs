/**
 * THE MULTIPLAYER FRONT END, PHOTOGRAPHED — and the six things a photograph
 * cannot tell you.
 * ---------------------------------------------------------------------------
 * ui/lobby.ts and ui/profile.ts are screens whose bugs are invisible in a still
 * image. A lobby browser that renders a null ping as "0 ms" looks finished. A
 * list that yanks the row out from under the cursor photographs beautifully. A
 * failed refresh that empties the list is indistinguishable, in a screenshot,
 * from a quiet evening. So this harness takes the pictures AND asserts the
 * things the pictures leave out:
 *
 *   1. A NULL PING RENDERS AS UNKNOWN. Every ping cell carries `data-ping`, and
 *      the first list() the mock answers has no resolved probes at all -- it
 *      schedules them when a row is first SEEN. So the first render is checked
 *      for "no cell marked unknown contains a number", and a later render is
 *      checked for both states existing at once, which is the ragged middle a
 *      browser actually has to survive.
 *
 *   2. THE ROW UNDER THE CURSOR SURVIVES A POLL. The pointer is parked on a row
 *      for three polls and six world ticks, and afterwards the element at that
 *      exact point must still be the same lobby id, at the same y, to the pixel.
 *      This is the one that makes a browser feel broken and the only way to
 *      check it is to hold a cursor still and wait.
 *
 *   3. A FAILED REQUEST PRODUCES A VISIBLE ERROR, NOT AN EMPTY LIST. Two ways
 *      in: `?net=live`, whose directory this harness answers with a flat
 *      refusal (the real one is a Netlify Function, and there is not one here)
 *      so the screen must render an error rather than an empty list; and
 *      `?net=mock`, whose 6% failure dice is rolled by hammering Refresh until
 *      one comes up -- and the rows have to STILL BE THERE when it does.
 *
 *      `?net=live` USED TO THROW OUT OF `lobbyService()` and this probe leant
 *      on that. It no longer does -- net/live.ts exists -- so the failure is
 *      now an ordinary refused request, which is a better test of the same
 *      screen. The endpoint is stubbed below rather than left to 404, because
 *      a 404 logs a console error and this harness treats console errors as
 *      faults.
 *
 *   4. START IS DISABLED WITH A REASON. Read as text, in all three of its
 *      blocked states, plus the one state where it is genuinely available.
 *
 *   5. EVERY `NameError` REACHES THE SCREEN. All five, driven for real:
 *      short, long and charset from the field, `taken` against a name the mock
 *      pre-claims, and `offline` by retrying a valid claim until the failure
 *      dice comes up.
 *
 *   6. A LOCKED AVATAR CANNOT BE EQUIPPED. Pressed, and the worn portrait has
 *      to be the same one afterwards.
 *
 *   7. THE TAB STRIP IS MEASURED, NOT LOOKED AT. The profile is three pages
 *      now, and the two ways a tab strip fails on a phone are geometric: it
 *      wraps to a second row -- which draws the selected tab's underline
 *      through the middle of the block instead of on the rule -- or a tab
 *      comes out under the 44px a thumb needs. Both are read off rectangles.
 *      styles.css turns the strip into a vertical RAIL under `max-height:
 *      560px`, so which shape to demand depends on the viewport.
 *
 *   8. THE CAR IS ONE VALUE, AND BOTH SCREENS WRITE IT. This is the whole
 *      point of the restructure and it is the thing a photograph is worst at:
 *      either screen looks correct whichever id it happens to be showing. So
 *      a chassis is changed in the profile and read back off the garage's
 *      card, then changed on the garage's card and read back off the
 *      profile's tile, with `frontEnd.selectedChassisId` as the referee.
 *      Checked here too: `__GARAGE_PREVIEW__` still belongs to the GARAGE's
 *      preview and not to the profile's, which is the second such widget in
 *      the process and would otherwise have taken the handle three other
 *      probes measure the garage with.
 *
 *   9. AN UNSAVED NAME SURVIVES A TAB PRESS. tabs.ts hides an off panel with
 *      `hidden` so nothing inside it stays focusable, which is right and
 *      which would have eaten a half-typed name had the field been put on a
 *      page rather than beside them.
 *
 *  10. OFFLINE STOPS WHAT THE ACCOUNT HOLDS AND NOTHING ELSE. A portrait
 *      refuses; a chassis, which is a device key that costs nothing, does
 *      not. One boolean in ui/profile.ts separates them and the screen looks
 *      the same either way round.
 *
 * FOUR PAGE LOADS, BECAUSE `?net=` IS READ ONCE PER LOAD.
 *
 *   perfect   the photography, the cursor test, create, room, all three
 *             profile pages. No failure dice, so a shot is the same every run.
 *   mock      the two failure paths, which need the dice.
 *   live      the "the directory will not answer" path, which is deterministic.
 *   blocked   perfect again, with localStorage throwing on property access --
 *             a private window -- for the `ephemeral` banner, which must be a
 *             DIFFERENT sentence from `offline`.
 *
 * NEEDS dist/: run `npx vite build` first. The server below serves the built
 * site, so a probe run against a stale bundle photographs the last commit.
 *
 *   node tools/probe-lobby.mjs [--mobile] [--landscape]
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, mkdir, readdir, unlink } from 'node:fs/promises'
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
    // The signalling endpoint, refusing. See note 3 in the header: this probe
    // is about what the SCREEN does with a backend that will not answer, and
    // tools/probe-netcode.mjs is where the real handler is exercised.
    if (p === '/api/signal') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: false, error: 'server' }))
      return
    }
    // AND THE ACCOUNT ENDPOINT, REFUSING IN THE SAME WAY AND FOR THE SAME
    // REASON. `live` resolves a peer's identity through `accountService()`, so
    // every page under that profile posts here before it can do anything at
    // all. Left unrouted it fell through to the file server and the browser
    // logged a 404 -- which this probe counts as a fault, because an anonymous
    // 404 from its own server is how a previous session went looking for a bug
    // in the bundle. A refusal is what the screen is being tested against
    // anyway; tools/probe-netcode.mjs runs the real handler.
    if (p === '/api/account') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: false, error: 'server' }))
      return
    }
    if (p === '/' || p.endsWith('/')) p += 'index.html'
    const buf = await readFile(join(ROOT, p))
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' })
    res.end(buf)
  } catch { res.writeHead(404); res.end('nf') }
})
await new Promise((r) => server.listen(0, r))
const base = `http://127.0.0.1:${server.address().port}/`

const LANDSCAPE = process.argv.includes('--landscape')
const MOBILE = LANDSCAPE || process.argv.includes('--mobile')
const VIEWPORT = LANDSCAPE ? { width: 915, height: 412 }
  : MOBILE ? { width: 412, height: 915 } : { width: 1440, height: 810 }
const KIND = LANDSCAPE ? 'mobilels' : MOBILE ? 'mobile' : 'desktop'
const OUT = new URL('../shots/lobby/', import.meta.url).pathname
await mkdir(OUT, { recursive: true })
// THIS RUN'S SHOTS ARE THE ONLY ONES LEFT. The names carry a running number, so
// a run that takes one shot fewer than the last leaves an orphan from the
// previous build sitting in the sequence under a plausible name -- which is how
// a fixed layout gets reviewed from a picture of the bug.
for (const f of await readdir(OUT)) {
  if (f.startsWith(KIND + '-') && f.endsWith('.png')) await unlink(join(OUT, f))
}

/** Mirrors TOUCH_HOLD_MS in ui/lobby.ts, plus slack for the release timer. */
const TOUCH_RELEASE_MS = 3200

const errors = []
const note = (m) => { errors.push(m); console.log('  !! ' + m) }
const say = (m) => console.log('  ' + m)

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist'],
})

/** A fresh page on a given `?net=` profile, booted and on the title screen. */
async function open(profile, { blockStorage = false } = {}) {
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    hasTouch: MOBILE,
    isMobile: MOBILE,
    deviceScaleFactor: 1,
  })
  const page = await ctx.newPage()
  if (blockStorage) {
    // A PRIVATE WINDOW, SIMULATED AT THE ONE PLACE IT ACTUALLY BREAKS.
    // net/mock.ts's `deviceStorage()` wraps the PROPERTY ACCESS, not just the
    // methods, because that is where partitioned and private contexts throw.
    // This makes the property throw, so `ephemeral` becomes true through the
    // real code path rather than by being set.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() { throw new Error('storage blocked') },
      })
    })
  }
  page.on('pageerror', (e) => note(`[${profile}] page error: ` + e.message))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    // The portrait-fallback test breaks an <img> src on purpose; the 404 it
    // produces is the thing being tested, not a fault.
    if ((m.location()?.url ?? '').includes('definitely-not-there')) return
    note(`[${profile}] console: ` + m.text())
  })
  await page.goto(base + '?net=' + profile, { waitUntil: 'load', timeout: 40000 })
  await page.waitForFunction(() => !!window.__GAME__, null, { timeout: 60000 })
  await page.waitForTimeout(1200)
  return { ctx, page }
}

let shotN = 0
async function shoot(page, label) {
  const name = `${KIND}-${String(++shotN).padStart(2, '0')}-${label}.png`
  await page.screenshot({ path: join(OUT, name) })
  return name
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

const screenOf = (page) => page.evaluate(() =>
  document.querySelector('.sg-fe')?.dataset.screen ?? '-')

/** `show()` straight on the front end. Faster than clicking, for the loops. */
const goto = (page, screen) => page.evaluate(
  (s) => { window.__GAME__.frontEnd.show(s) }, screen)

const readRows = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.sglb__row')].map((r) => {
    const b = r.getBoundingClientRect()
    const cell = (c) => r.querySelector('.sglb__col--' + c)
    const ping = cell('ping')
    return {
      id: r.dataset.lobby,
      status: r.dataset.status,
      disabled: r.disabled,
      gone: r.classList.contains('is-gone'),
      name: cell('name')?.textContent ?? '',
      host: cell('host')?.textContent ?? '',
      region: cell('region')?.textContent ?? '',
      players: cell('players')?.textContent ?? '',
      access: cell('access')?.textContent ?? '',
      track: cell('track')?.textContent ?? '',
      statusText: cell('status')?.textContent ?? '',
      pingText: ping?.textContent ?? '',
      pingData: ping?.dataset.ping ?? '',
      top: Math.round(b.top * 10) / 10,
      height: Math.round(b.height * 10) / 10,
    }
  }))

const readBrowserState = (page) => page.evaluate(() => {
  const vis = (sel) => {
    const e = document.querySelector(sel)
    return !!e && !e.hidden && getComputedStyle(e).display !== 'none'
  }
  const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? ''
  return {
    rows: document.querySelectorAll('.sglb__row').length,
    listVisible: vis('.sglb__list'),
    loading: vis('.sglb__state--loading'),
    empty: vis('.sglb__state--empty'),
    emptyKind: document.querySelector('.sglb__state--empty')?.dataset.state ?? '',
    error: vis('.sglb__state--error'),
    errorText: text('.sglb__errText'),
    pill: vis('.sglb__pill'),
    pillText: text('.sglb__pill'),
    status: text('.sglb__status'),
    statusKind: document.querySelector('.sglb__status')?.dataset.kind ?? '',
    notice: vis('.sglb__notice') ? text('.sglb__notice') : '',
    foot: text('.sglb__footText'),
    footKind: document.querySelector('.sglb__footText')?.dataset.kind ?? '',
  }
})

const readRoom = (page) => page.evaluate(() => {
  const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? ''
  const start = document.querySelector('.sglbr__start')
  const ready = document.querySelector('.sglbr__ready')
  return {
    name: text('.sglbr__name'),
    access: text('.sglbr__chips .sglb__chip[data-access]'),
    codeShown: !document.querySelector('.sglbr__codewrap')?.hidden,
    code: text('.sglbr__code'),
    track: text('.sglbr__trackName'),
    laps: text('.sglbr__trackWorld'),
    count: text('.sglbr__count'),
    hostControls: !document.querySelector('.sglbr__hostonly')?.hidden,
    why: text('.sglbr__why'),
    whyBlocked: document.querySelector('.sglbr__why')?.dataset.blocked ?? '',
    startDisabled: start ? start.disabled : null,
    startHidden: start ? start.hidden : null,
    readyLabel: ready?.textContent ?? '',
    readyDisabled: ready ? ready.disabled : null,
    alone: !document.querySelector('.sglbr__alone')?.hidden,
    members: [...document.querySelectorAll('.sglbr__member')].map((m) => ({
      id: m.dataset.member,
      me: m.classList.contains('is-me'),
      name: m.querySelector('.sglbr__who')?.textContent ?? '',
      host: !!m.querySelector('.sglbr__tag--host'),
      you: !!m.querySelector('.sg-you'),
      car: m.querySelector('.sglbr__mcar')?.textContent ?? '',
      ping: m.querySelector('.sglbr__mping')?.textContent ?? '',
      pingData: m.querySelector('.sglbr__mping')?.dataset.ping ?? '',
      state: m.querySelector('.sglbr__mstate')?.dataset.state ?? '',
      kick: !m.querySelector('.sglbr__kick')?.hidden,
      avatarArt: m.querySelector('.sglb__avatarImg')?.dataset.art ?? '',
    })),
  }
})

/**
 * The identity card, plus the PORTRAITS page.
 *
 * SCOPED TO ONE PAGE ON PURPOSE. The profile is three grids of `.sgpf__tile`
 * now, so a bare `querySelectorAll('.sgpf__tile')` counts thirty-five things
 * and reports the roster as broken -- which is exactly what it did the first
 * time this probe met the tabbed screen. Everything below that is about
 * portraits reads inside `[data-page="portrait"]`; the tabs and the other two
 * pages have `readPages` to themselves.
 */
const readProfile = (page) => page.evaluate(() => {
  const vis = (sel) => {
    const e = document.querySelector(sel)
    return !!e && !e.hidden && getComputedStyle(e).display !== 'none'
  }
  const P = '.sgpf__page[data-page="portrait"] '
  const tiles = [...document.querySelectorAll(P + '.sgpf__tile')]
  return {
    worn: document.querySelector('.sgpf__portrait')?.dataset.avatar ?? '',
    wornName: document.querySelector('.sgpf__wearing')?.textContent ?? '',
    name: document.querySelector('.sgpf__in')?.value ?? '',
    nameDisabled: document.querySelector('.sgpf__in')?.disabled ?? null,
    offline: vis('.sgpf__flag--offline'),
    ephemeral: vis('.sgpf__flag--ephemeral'),
    credits: document.querySelector('.sgpf__stat--credits .sgpf__statV')?.textContent ?? '',
    count: document.querySelector(P + '.sgpf__pickCount')?.textContent ?? '',
    nameMsg: document.querySelector('.sgpf__msg--name')?.textContent ?? '',
    nameErr: document.querySelector('.sgpf__msg--name')?.dataset.name ?? '',
    pickMsg: document.querySelector(P + '.sgpf__msg--pick')?.textContent ?? '',
    refused: document.querySelector(P + '.sgpf__msg--pick')?.dataset.refused ?? '',
    tiles: tiles.length,
    owned: tiles.filter((t) => t.dataset.status === 'owned').length,
    buyable: tiles.filter((t) => t.dataset.status === 'buyable').length,
    locked: tiles.filter((t) => t.dataset.status === 'locked').length,
    firstLocked: tiles.find((t) => t.dataset.status === 'locked')?.dataset.avatar ?? '',
    firstBuyable: tiles.find((t) => t.dataset.status === 'buyable')?.dataset.avatar ?? '',
    badArt: tiles.filter((t) =>
      t.querySelector('.sgpf__art')?.dataset.art === 'fallback').length,
  }
})

/**
 * The tab strip and all three pages at once.
 *
 * The strip geometry is read as RECTANGLES rather than trusted to a class,
 * because the two failures worth catching here are both geometric and both
 * invisible in a still: a strip that has silently wrapped onto a second row
 * (which puts the selected tab's underline through the middle of the block
 * instead of on the rule -- styles.css has the same note about the results
 * screen), and a tab under the 44px a thumb needs.
 */
const readPages = (page) => page.evaluate(() => {
  const tabs = [...document.querySelectorAll('.sgpf .sg-tab')].map((b) => {
    const r = b.getBoundingClientRect()
    return {
      id: b.dataset.tab ?? '',
      label: b.textContent ?? '',
      on: b.getAttribute('aria-selected') === 'true',
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
    }
  })
  const pages = {}
  for (const el of document.querySelectorAll('.sgpf__page')) {
    const tiles = [...el.querySelectorAll('.sgpf__tile')]
    const panel = el.closest('.sg-tabpanel')
    pages[el.dataset.page ?? '?'] = {
      shown: !!panel && !panel.hidden && getComputedStyle(panel).display !== 'none',
      count: el.querySelector('.sgpf__pickCount')?.textContent ?? '',
      lede: el.querySelector('.sgpf__lede')?.textContent ?? '',
      now: el.querySelector('.sgpf__now')?.textContent ?? '',
      msg: el.querySelector('.sgpf__msg--pick')?.textContent ?? '',
      refused: el.querySelector('.sgpf__msg--pick')?.dataset.refused ?? '',
      tiles: tiles.length,
      locked: tiles.filter((t) => t.dataset.status === 'locked').length,
      on: tiles.find((t) => t.classList.contains('is-on'))?.dataset.item ?? '',
      // The tick and the tag are the two non-colour channels on the marker.
      onTag: tiles.find((t) => t.classList.contains('is-on'))
        ?.querySelector('.sgpf__tileTag')?.textContent ?? '',
      sideways: el.scrollWidth > el.clientWidth + 1,
    }
  }
  const canvas = document.querySelector('.sgpf__prev canvas')
  return {
    tabs,
    rows: new Set(tabs.map((t) => t.y)).size,
    cols: new Set(tabs.map((t) => t.x)).size,
    selected: tabs.find((t) => t.on)?.id ?? '',
    pages,
    name: document.querySelector('.sgpf__in')?.value ?? '',
    preview: canvas
      ? { w: Math.round(canvas.getBoundingClientRect().width),
        h: Math.round(canvas.getBoundingClientRect().height) }
      : null,
  }
})

/**
 * Press a tab the way a player does, by its id rather than by its label.
 *
 * WAITS FOR THE PANEL, NOT FOR A DURATION. tabs.ts hides an off page with the
 * `hidden` attribute, so every tile on it is `display: none` and a click on
 * one fails with "element is not visible" after thirty seconds of Playwright
 * retrying -- which is how a tab switch that has not landed yet shows up:
 * as a timeout in whatever ran next, several lines away from the cause.
 */
async function selectTab(page, id) {
  await page.locator(`.sgpf .sg-tab[data-tab="${id}"]`).click()
  await page.waitForFunction((t) => {
    const panel = document.querySelector(`.sgpf__page[data-page="${t}"]`)?.closest('.sg-tabpanel')
    return !!panel && !panel.hidden && getComputedStyle(panel).display !== 'none'
  }, id, { timeout: 8000 })
  await page.waitForTimeout(180)
}

/**
 * THE INVARIANT, checked wherever a room is read.
 *
 * The button and the sentence beside it are two renderings of one fact, so the
 * only thing worth asserting is that they agree: a reason means Start is
 * unavailable, and no reason means it is available. Asserting "Start must be
 * live now" instead is a test that fails whenever somebody walks into the
 * lobby between the press and the read -- which is the mock doing its job.
 */
function checkStartAgrees(r, where) {
  const blocked = r.why !== ''
  if (r.startDisabled !== blocked) {
    note(`${where}: Start is ${r.startDisabled ? 'disabled' : 'available'} but the reason `
      + `beside it is ${blocked ? `"${r.why}"` : 'empty'}`)
  }
  if (blocked && r.whyBlocked !== 'yes') note(`${where}: a blocked Start is not marked blocked`)
}

/** No sideways scroll and nothing wider than the viewport. */
async function checkFit(page, where) {
  const fit = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
    over: [...document.querySelectorAll('.sg-screen:not([hidden]) *')]
      .filter((e) => getComputedStyle(e).display !== 'none')
      .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 4).map((e) => e.className + ' @' + Math.round(e.getBoundingClientRect().right)),
  }))
  if (fit.doc > fit.win + 1) {
    note(`${where}: the page scrolls sideways (${fit.doc} > ${fit.win})`)
  }
  if (fit.over.length) note(`${where}: past the right edge — ${fit.over.join(' | ')}`)
}

// ===========================================================================
console.log(`\nLOBBY PROBE — ${KIND} ${VIEWPORT.width}x${VIEWPORT.height}\n`)

// ---------------------------------------------------------------------------
// PASS 1 — ?net=live against a directory that refuses, and that must be a
// SCREEN rather than an empty list or a dead front end.
//
// This pass used to be "the build has no backend", because `lobbyService()`
// threw for the live profile. net/live.ts exists now, so what it tests is the
// case that actually happens in the field -- the endpoint answering with a
// refusal -- and the harness's own server is what refuses. The real endpoint
// is exercised by tools/probe-netcode.mjs, which mounts it for real.
// ---------------------------------------------------------------------------
console.log('-- ?net=live: the directory refuses ---------------------------')
{
  const { ctx, page } = await open('live')
  await page.locator('.sg-title__multi .sg-btn--violet').click()
  await page.waitForTimeout(600)
  const st = await readBrowserState(page)
  say(`screen=${await screenOf(page)} rows=${st.rows} error=${st.error} `
    + `list=${st.listVisible}`)
  say(`error text: "${st.errorText}"`)
  if (!st.error) note('?net=live shows no error state at all')
  if (st.rows !== 0) note('?net=live somehow produced rows')
  if (st.listVisible) note('?net=live left an empty list up instead of an error')
  if (!/not available|unavailable|not implemented|did not answer|could not/i.test(st.errorText)) {
    note('the failed-directory message does not say what is wrong: ' + st.errorText)
  }
  // The controls STAY LIVE, and that is the right answer for this state --
  // which is the one thing that changed when `live` stopped being a throw. A
  // build with no backend at all could fairly grey the whole bar out; a
  // directory that did not answer THIS time is a thing to retry, and a filter
  // the player cannot touch while they wait reads as a broken screen rather
  // than a quiet one. What must not happen is a Retry that is missing.
  const live = await page.evaluate(() => [
    ...document.querySelectorAll(
      '.sglb--browser .sglb__bar input, .sglb--browser .sglb__bar select,'
      + '.sglb--browser .sglb__bar button, .sglb--browser .sglb__foot .sg-btn'),
  ].filter((e) => e.disabled === false).map((e) => e.className || e.tagName))
  say(`controls still live: ${live.length ? live.join(' | ') : 'none'}`)
  const retry = await page.evaluate(() =>
    [...document.querySelectorAll('.sglb--browser button')]
      .some((b) => !b.hidden && !b.disabled && /retry|refresh/i.test(b.textContent || '')))
  if (!retry) note('a directory that refused offers the player no way to try again')
  say('shot ' + await shoot(page, 'browser-no-backend'))
  await checkFit(page, 'refused-directory browser')
  await ctx.close()
}

// ---------------------------------------------------------------------------
// PASS 2 — ?net=perfect: the photography, and everything deterministic
// ---------------------------------------------------------------------------
console.log('\n-- ?net=perfect: browser -------------------------------------')
const { ctx: ctxP, page } = await open('perfect')
say('shot ' + await shoot(page, 'title'))
{
  const multi = await page.evaluate(() => ({
    btn: !!document.querySelector('.sg-title__multi .sg-btn--violet'),
    line: document.querySelector('.sg-title__multi .sg-title__cline')?.textContent ?? '',
    prof: !!document.querySelector('.sg-title__multi .sg-btn--ghost'),
  }))
  say(`title block: button=${multi.btn} profile=${multi.prof} line="${multi.line}"`)
  if (!multi.btn) note('there is no way into multiplayer from the title screen')
}

// --- the loading state, then the first render ------------------------------
// WATCHED, NOT SAMPLED. A poll from the harness has to beat a round trip that
// `?net=perfect` runs at a fifth speed, and it frequently does not -- which
// reported "there is no loading state" about a loading state that had come and
// gone between two samples. A MutationObserver installed BEFORE the click
// cannot miss it.
const openedAt = Date.now()
await page.evaluate(() => {
  const w = window
  w.__SAW_LOADING__ = false
  const look = () => {
    const e = document.querySelector('.sglb__state--loading')
    if (e && !e.hidden) w.__SAW_LOADING__ = true
  }
  new MutationObserver(look).observe(document.body, {
    subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'class'],
  })
  look()
})
await page.locator('.sg-title__multi .sg-btn--violet').click()
let firstRender = null
for (let i = 0; i < 400; i++) {
  const st = await readBrowserState(page)
  if (st.rows > 0) { firstRender = await readRows(page); break }
  await page.waitForTimeout(20)
}
const firstLoadMs = Date.now() - openedAt
const sawLoading = await page.evaluate(() => window.__SAW_LOADING__ === true)
if (!firstRender) note('the lobby browser never produced any rows')
say(`loading state seen: ${sawLoading} · first list took ${firstLoadMs}ms `
  + `· first render: ${firstRender?.length ?? 0} rows`)
if (!sawLoading) note('the browser never showed a loading state on first open')

// --- 1. A NULL PING IS UNKNOWN, NOT ZERO -----------------------------------
{
  const rows = firstRender ?? []
  const unknown = rows.filter((r) => r.pingData === 'unknown')
  const numericInUnknown = unknown.filter((r) => /\d/.test(r.pingText))
  say(`first render pings: ${unknown.length}/${rows.length} unknown, `
    + `sample text ${JSON.stringify(rows.slice(0, 4).map((r) => r.pingText))}`)
  if (unknown.length === 0) {
    note('no row had an unknown ping on the first render — the null state was never rendered')
  }
  if (numericInUnknown.length > 0) {
    note(`${numericInUnknown.length} row(s) marked ping-unknown printed a number: `
      + JSON.stringify(numericInUnknown.slice(0, 3).map((r) => r.pingText)))
  }
  const zeroish = rows.filter((r) => r.pingData === 'unknown' && /(^0|\b0\b)/.test(r.pingText))
  if (zeroish.length > 0) note('an unknown ping rendered as zero')
  say('shot ' + await shoot(page, 'browser-pings-unknown'))
}

// ...and later, when some have resolved and some never will.
await page.waitForTimeout(6000)
{
  const rows = await readRows(page)
  const unknown = rows.filter((r) => r.pingData === 'unknown')
  const known = rows.filter((r) => r.pingData !== 'unknown' && r.pingData !== '')
  say(`after 6s: ${known.length} pings known, ${unknown.length} still unknown`)
  if (known.length === 0) note('no ping ever resolved — the browser is not re-polling')
  for (const r of unknown) {
    if (/\d/.test(r.pingText)) note(`late render: unknown ping printed "${r.pingText}"`)
  }
  const heights = [...new Set(rows.map((r) => r.height))]
  say(`row heights: ${JSON.stringify(heights)}`)
  if (heights.length > 1) {
    note(`rows are not all the same height (${JSON.stringify(heights)}) — a status `
      + 'or ping change can now shift every row below it')
  }
  say(`columns on a row: ${JSON.stringify(rows[0])}`)
  say('shot ' + await shoot(page, 'browser'))
  await checkFit(page, 'browser')
}

// --- 2. THE ROW UNDER THE CURSOR SURVIVES A POLL ---------------------------
console.log('\n-- the cursor test -------------------------------------------')
{
  const before = await readRows(page)
  // A ROW THAT IS ACTUALLY ON SCREEN. At 915x412 only four of eighteen rows fit
  // and the middle one by index is a long way below the fold, so the first
  // version of this tapped empty space and then reported that the row had
  // moved. Pick the row nearest the middle of the VISIBLE list instead.
  const listBox = await page.locator('.sglb__list').boundingBox()
  const midY = listBox.y + listBox.height / 2
  let idx = 0
  let bestD = Infinity
  for (let i = 0; i < before.length; i++) {
    const c = before[i].top + before[i].height / 2
    if (c < listBox.y + 4 || c > listBox.y + listBox.height - 4) continue
    const d = Math.abs(c - midY)
    if (d < bestD) { bestD = d; idx = i }
  }
  const target = before[idx]
  const box = await page.locator(`.sglb__row[data-lobby="${target.id}"]`).boundingBox()
  const px = Math.round(box.x + box.width / 2)
  const py = Math.round(box.y + box.height / 2)
  // ON A PHONE THERE IS NO CURSOR, SO THE TEST IS THE TOUCH VERSION OF IT:
  // the gap between a finger going down and the tap landing is where a phone
  // loses a row, and the hold is timed rather than hover-driven. Both paths
  // ask the same question -- is the row I am pointing at still the row I am
  // pointing at -- and measure the same two things.
  // TIME-BOUNDED, NOT ITERATION-BOUNDED. On touch the hold is 2.5s of wall
  // clock (TOUCH_HOLD_MS in ui/lobby.ts), and a loop of four half-second sleeps
  // plus four round trips into the page takes rather more than two seconds --
  // so the first version of this measured the list AFTER the hold had released
  // and then reported the release as the bug it exists to prevent.
  const HOLD_MS = MOBILE ? 1500 : 11000
  if (MOBILE) {
    await page.touchscreen.tap(px, py)
    await page.waitForTimeout(250)
    const st = await readBrowserState(page)
    say(`tapped row ${idx} "${target.name}" (${target.id}) at y=${target.top}`)
    say(`  the join bar says: "${st.foot}"`)
    if (!st.foot.includes(target.name)) {
      note(`tapping "${target.name}" selected something else: "${st.foot}"`)
    }
  } else {
    await page.mouse.move(px, py)
    say(`parked on row ${idx} "${target.name}" (${target.id}) at y=${target.top} `
      + `— holding for ${Math.round(HOLD_MS / 1000)}s`)
  }

  let pillSeen = ''
  let pillOverRow = 0
  const holdStart = Date.now()
  while (Date.now() - holdStart < HOLD_MS) {
    await page.waitForTimeout(MOBILE ? 220 : 500)
    const st = await readBrowserState(page)
    if (st.pill && !pillSeen) pillSeen = st.pillText
    if (st.pill && pillOverRow === 0) {
      // THE PILL MUST NOT SIT ON THE LIST. The first cut floated it over the
      // bottom of the rows and it swallowed the click meant for the row
      // underneath -- a control that announces a change by making the list
      // unusable. Measured in pixels rather than trusted.
      pillOverRow = Math.max(pillOverRow, await page.evaluate(() => {
        const pill = document.querySelector('.sglb__pill')
        const list = document.querySelector('.sglb__list')
        if (!pill || !list || pill.hidden) return 0
        const a = pill.getBoundingClientRect()
        const b = list.getBoundingClientRect()
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        return w > 0 && h > 0 ? Math.round(w * h) : 0
      }))
    }
  }
  if (pillOverRow > 0) note(`the "changes waiting" pill covers ${pillOverRow}px2 of the list`)
  say(`   held for ${Date.now() - holdStart}ms`)

  const under = await page.evaluate(([x, y]) => {
    const e = document.elementFromPoint(x, y)
    const row = e && e.closest ? e.closest('.sglb__row') : null
    if (!row) return { id: null, top: null, tag: e ? e.className : 'nothing' }
    const b = row.getBoundingClientRect()
    return { id: row.dataset.lobby, top: Math.round(b.top * 10) / 10, tag: '' }
  }, [px, py])
  const after = await readRows(page)
  const still = after.find((r) => r.id === target.id)
  say(`after the hold: under the cursor = ${under.id} at y=${under.top}`)
  say(`pill while held: ${pillSeen ? `"${pillSeen}"` : '(no structural change arrived)'}`)
  if (under.id !== target.id) {
    note(`THE ROW MOVED: the cursor is now over "${under.id}" and was over `
      + `"${target.id}" (${under.tag})`)
  }
  if (still && Math.abs(still.top - target.top) > 1) {
    note(`the row shifted ${(still.top - target.top).toFixed(1)}px while the cursor was on it`)
  }
  if (!pillSeen) {
    say(`   (note: nothing structural changed in ${Math.round(HOLD_MS / 1000)}s, so the `
      + 'pin was not exercised — the result is weaker than it looks)')
  }
  say('shot ' + await shoot(page, 'browser-pinned'))

  // ...and the hold is a HOLD, not a dead poll: letting go lets it through. On
  // a phone "letting go" is the hold timing out; on a desk it is the pointer
  // leaving.
  if (MOBILE) await page.waitForTimeout(TOUCH_RELEASE_MS)
  else await page.mouse.move(6, 6)
  await page.waitForTimeout(900)
  const released = await readBrowserState(page)
  say(`after letting go: pill=${released.pill} rows=${released.rows}`)
  if (pillSeen && released.pill) note('the held-back changes never flushed after the hold ended')
}

// --- an empty result -------------------------------------------------------
console.log('\n-- filters ---------------------------------------------------')
await page.locator('.sglb__search').fill('zzzz-nothing-matches')
await page.waitForTimeout(1400)
{
  const st = await readBrowserState(page)
  say(`empty: rows=${st.rows} empty=${st.empty} kind=${st.emptyKind}`)
  say(`  "${st.status}"`)
  if (!st.empty) note('an empty result did not produce an empty state')
  if (st.emptyKind !== 'empty-filtered') {
    note(`the empty state does not know it was caused by a filter (${st.emptyKind})`)
  }
  say('shot ' + await shoot(page, 'browser-empty'))
}
await page.locator('.sglb__search').fill('')
await page.waitForTimeout(1400)

// --- the region filter and the joinable toggle -----------------------------
{
  const opts = await page.evaluate(() =>
    [...document.querySelectorAll('.sglb__bar .sglb__select option')].map((o) => o.value))
  say(`region filter offers ${opts.length} options: ${opts.join(', ')}`)
  if (opts.length !== 9) note(`expected "any" plus 8 regions, got ${opts.length}`)
  await page.locator('.sglb__toggle').click()
  await page.waitForTimeout(1200)
  const rows = await readRows(page)
  const bad = rows.filter((r) => r.status !== 'open')
  say(`joinable-only: ${rows.length} rows, ${bad.length} of them not open`)
  if (bad.length > 0) note('the joinable-only filter left non-open rows in the list')
  await page.locator('.sglb__toggle').click()
  await page.waitForTimeout(1200)
}

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------
console.log('\n-- create ----------------------------------------------------')
await page.locator('.sglb--browser .sglb__foot .sg-btn:not(.sg-btn--gold)').last().click()
await page.waitForTimeout(400)
{
  const scr = await screenOf(page)
  if (scr !== 'lobbyNew') note(`Host a lobby went to "${scr}" instead of the create screen`)
  const form = await page.evaluate(() => ({
    name: document.querySelector('.sglb--create .sglb__in')?.value ?? '',
    regions: document.querySelectorAll('.sglb--create .sglb__select option').length,
    maxes: [...document.querySelectorAll('.sglb--create [data-max]')].map((b) => b.dataset.max),
    vis: [...document.querySelectorAll('.sglb--create [data-private]')].map((b) => b.textContent),
    tracks: document.querySelectorAll('.sglb--create .sglb__track').length,
    laps: [...document.querySelectorAll('.sglb--create [data-laps]')].map((b) => b.dataset.laps),
    hints: [...document.querySelectorAll('.sglb--create .sglb__hint')].map((h) => h.textContent),
    go: document.querySelector('.sglb--create .sg-btn--start')?.textContent ?? '',
  }))
  say(`name prefilled: "${form.name}"`)
  say(`players ${form.maxes.join('/')} · visibility ${form.vis.join('/')} · `
    + `${form.tracks} circuits · laps ${form.laps.join('/')} · ${form.regions} regions`)
  if (form.maxes.join(',') !== '2,3,4,5,6,7,8') {
    note(`max-players offers ${form.maxes.join(',')}, not LOBBY_MIN..LOBBY_MAX (2..8)`)
  }
  if (form.regions !== 8) note(`create offers ${form.regions} regions, expected 8`)
  const regionHint = form.hints.find((h) => /route/i.test(h)) ?? ''
  if (!/does not route/i.test(regionHint)) {
    note('the region field does not say that a region is only a hint')
  }
  say(`region copy: "${regionHint.slice(0, 96)}…"`)
  await checkFit(page, 'create')
  say('shot ' + await shoot(page, 'create'))
}

// A PRIVATE lobby, so the room screen has a code to show.
await page.locator('.sglb--create .sglb__in').fill('Probe room')
await page.locator('.sglb--create [data-private="true"]').click()
await page.locator('.sglb--create [data-max="4"]').click()
await page.locator('.sglb--create [data-laps="3"]').click()
await page.waitForTimeout(150)
say('shot ' + await shoot(page, 'create-filled'))
await page.locator('.sglb--create .sg-btn--start').click()
// THE FIRST START BLOCK ONLY EXISTS FOR A FRACTION OF A SECOND. Your own peer
// connection comes up 600-2200ms after you sit down, scaled by `perfect`'s
// latency scale to about 120-440ms, and "waiting for you to connect" is a real
// reason Start is unavailable. Sampled rather than waited for.
const blockedReasons = new Set()
for (let i = 0; i < 60; i++) {
  const why = await page.evaluate(() =>
    document.querySelector('.sglbr__why')?.textContent?.trim() ?? '')
  if (why) blockedReasons.add(why)
  const connected = await page.evaluate(() =>
    document.querySelector('.sglbr__member .sglbr__mstate')?.dataset.state !== 'connecting')
  if (connected && i > 4) break
  await page.waitForTimeout(20)
}
await page.waitForTimeout(500)

// ---------------------------------------------------------------------------
// THE ROOM
// ---------------------------------------------------------------------------
console.log('\n-- the room --------------------------------------------------')
{
  const scr = await screenOf(page)
  if (scr !== 'room') note(`creating a lobby left the front end on "${scr}"`)
}
// Straight after create the local peer is still connecting: that is a START
// BLOCK with its own sentence, and it only exists for a second or two.
{
  const r = await readRoom(page)
  say(`"${r.name}" ${r.access} code=${r.code} ${r.track} ${r.laps} ${r.count}`)
  say(`start blocked: "${r.why}" (disabled=${r.startDisabled})`)
  if (!r.codeShown || !/^[A-Z0-9]{4}$/.test(r.code)) {
    note(`the host cannot see a 4-character join code (got "${r.code}")`)
  }
  checkStartAgrees(r, 'straight after create')
  if (r.startDisabled !== true) note('Start was available before anybody was ready')
  if (!r.why) note('Start is disabled with no reason beside it')
  if (r.members[0] && !r.members[0].you) note('the local player has no YOU marker on their row')
  if (r.members[0] && !r.members[0].host) note('the host has no HOST marker on their row')
  say('shot ' + await shoot(page, 'room-connecting'))
}
// Wait for the local link to come up (600-2200ms scaled), then the reason has
// to CHANGE -- from "connecting" to "ready up".
await page.waitForFunction(
  () => document.querySelector('.sglbr__member .sglbr__mstate')?.dataset.state !== 'connecting',
  null, { timeout: 15000 }).catch(() => note('the local peer never finished connecting'))
await page.waitForTimeout(300)
{
  const r = await readRoom(page)
  blockedReasons.add(r.why)
  say(`connected. start blocked: "${r.why}"`)
  say(`member: ${JSON.stringify(r.members[0])}`)
  checkStartAgrees(r, 'host not ready')
  if (r.startDisabled !== true) note('Start was available while the host was not ready')
  if (!/ready|connect/i.test(r.why)) note(`the block does not say what it is waiting on: "${r.why}"`)
  // ONLY WHEN THE ROOM IS ACTUALLY A ONE-PERSON ROOM. The world ticks every
  // 1.6s and a bot can walk in during the 600-2200ms the local link takes to
  // come up, at which point the advisory is correctly absent and this assertion
  // was failing the probe for the mock doing its job. Which side of that race
  // a run lands on moves with the seed.
  if (r.members.length === 1 && !r.alone) {
    note('a one-person lobby does not say the grid will be filled with AI')
  }
  if (!r.hostControls) note('the host has no circuit controls')
  await checkFit(page, 'room')
  say('shot ' + await shoot(page, 'room-start-blocked'))
}

// Ready up: the block has to clear, and Start has to become available.
await page.locator('.sglbr__ready').click()
await page.waitForTimeout(900)
{
  const r = await readRoom(page)
  const me = r.members.find((m) => m.you)
  say(`after Ready: you=${me?.state} why="${r.why || '(none — Start is live)'}" `
    + `disabled=${r.startDisabled}`)
  if (me?.state !== 'ready') note('pressing Ready did not make your own row ready')
  checkStartAgrees(r, 'after Ready')
  if (r.why) blockedReasons.add(r.why)
  say('shot ' + await shoot(page, 'room-ready'))
}

// WAIT FOR COMPANY. Two of the four reasons Start can be unavailable only
// exist for a host with other people in the room -- somebody still connecting,
// and somebody not ready -- and the only way to get them is to be hosting when
// the world sends somebody in. `P.join` is 0.22 per lobby per tick and a
// quarter of arrivals land still connecting, so ~26s is a fair try and an
// honest note if it does not happen.
{
  let shot = false
  for (let i = 0; i < 37; i++) {
    await page.waitForTimeout(700)
    const r = await readRoom(page)
    if (r.why) blockedReasons.add(r.why)
    checkStartAgrees(r, 'waiting for company')
    if (!shot && r.members.length > 1) {
      shot = true
      say(`company arrived: ${r.count} — "${r.why}"`)
      for (const m of r.members) {
        say(`   ${m.you ? '>' : ' '} ${m.name.padEnd(12)} ${String(m.ping).padStart(7)}  `
          + `${m.state.padEnd(11)} kick=${m.kick}`)
      }
      if (!r.members.some((m) => m.kick)) note('a host is offered no way to remove anybody')
      if (r.members.some((m) => m.you && m.kick)) note('the host is offered a Kick on their own row')
      say('shot ' + await shoot(page, 'room-host-populated'))
    }
    if (shot && [...blockedReasons].some((w) => /connect/i.test(w))) break
  }
  if (![...blockedReasons].some((w) => /connect/i.test(w))) {
    say('(nobody arrived mid-connection in 26s — the "still connecting" block was not seen)')
  }
}

// Changing the circuit clears the ready — the contract says so, so check it.
{
  const before = await readRoom(page)
  const other = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.sglbr__trackBtn')].find((x) => !x.classList.contains('is-on'))
    return b ? b.dataset.track : null
  })
  await page.locator(`.sglbr__trackBtn[data-track="${other}"]`).click()
  await page.waitForTimeout(800)
  const r = await readRoom(page)
  say(`track ${before.track} -> ${r.track}; ready now ${r.members[0]?.state}; why="${r.why}"`)
  if (r.track === before.track) note('changing the circuit did nothing')
  if (r.members[0]?.state === 'ready') {
    note('changing the circuit did not clear the ready flags')
  }
  checkStartAgrees(r, 'after a circuit change')
  if (r.startDisabled !== true) note('Start stayed available after the circuit changed')
  if (r.why) blockedReasons.add(r.why)
}

// Back to the browser WITHOUT leaving — the row must still be ours to return to.
await page.keyboard.press('Escape')
await page.waitForTimeout(900)
{
  // The last click landed in the room, and that same coordinate is inside the
  // list on this screen -- which pins it, correctly, and would leave every read
  // below looking at a held-back list. A real player moves their mouse.
  await page.mouse.move(6, 6)
  await page.waitForTimeout(1800)
  const scr = await screenOf(page)
  const back = await page.evaluate(() =>
    !document.querySelector('.sglb--browser .sglb__headright .sg-btn:not(.sg-btn--ghost)')?.hidden)
  const mine = await page.evaluate(() =>
    document.querySelectorAll('.sglb__row.is-mine').length)
  say(`Escape from the room -> "${scr}"; back-to-lobby offered=${back}; own rows=${mine}`)
  if (scr !== 'lobby') note(`Escape from the room went to "${scr}"`)
  if (!back) note('there is no way back into the lobby you are still a member of')
  if (mine === 0) note('your own lobby is not marked as yours in the directory')
  say('shot ' + await shoot(page, 'browser-in-a-lobby'))
}

// --- 11. CHANGING YOUR CAR WHILE YOU ARE SITTING IN A LOBBY ----------------
//
// ui/lobby.ts publishes the loadout ONCE, from `enterRoom`, which was exactly
// right while the garage was the only way to choose one: you walked through
// it on the way in and could not reach it again without leaving. The profile
// is reachable from a button on the lobby browser's own head, so "joined in
// the Solaire, went and picked the Bulwark" is now an ordinary thing to do --
// and the room would go on showing the Solaire to seven other people, and the
// grid in `RaceStartPacket` would be built from it.
//
// The fix is `publishLoadout()` in ui/frontend.ts and this is the only thing
// that can see it: the member row is somebody ELSE's view of your choice, and
// a screenshot of the profile is right either way. We are still a member of
// the lobby created above -- that is what the block before this just proved.
{
  await goto(page, 'profile')
  await page.waitForTimeout(700)
  await selectTab(page, 'vehicle')
  const pick = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('.sgpf__page[data-page="vehicle"] .sgpf__tile')]
    const t = tiles.find((x) => !x.classList.contains('is-on'))
    return t ? { id: t.dataset.item, name: t.querySelector('.sgpf__tileName')?.textContent ?? '' } : null
  })
  if (!pick) {
    note('no other chassis to switch to while in a lobby')
  } else {
    await page.locator(`.sgpf__tile[data-chassis="${pick.id}"]`).click()
    await page.waitForTimeout(600)
    await goto(page, 'room')
    await page.waitForTimeout(1200)
    const r = await readRoom(page)
    const me = r.members.find((m) => m.me)
    say(`picked ${pick.name} in the profile; the room now shows "${me?.car ?? '(no row)'}"`)
    if (!me) note('the room lost the local member while the profile was open')
    else if (!me.car.includes(pick.name)) {
      note(`the room still publishes "${me.car}" after the profile chose ${pick.name}`)
    }
    say('shot ' + await shoot(page, 'room-loadout-followed'))
  }
  await goto(page, 'lobby')
  // Same reason as the block above: a cursor left sitting on a row pins it.
  await page.mouse.move(6, 6)
  await page.waitForTimeout(1500)
}

// ---------------------------------------------------------------------------
// JOINING SOMEBODY ELSE'S LOBBY — the wrong code, then the right room
// ---------------------------------------------------------------------------
console.log('\n-- joining ---------------------------------------------------')
await page.waitForTimeout(1200)
{
  // A private row with a code we do not have. `badcode` is the JoinError with
  // the most ways to be mishandled -- it is the only one the player can fix.
  const priv = await page.evaluate(() => {
    const r = [...document.querySelectorAll('.sglb__row')]
      .find((x) => x.querySelector('.sglb__col--access')?.dataset.access === 'private'
        && x.dataset.status === 'open' && !x.classList.contains('is-mine'))
    return r ? r.dataset.lobby : null
  })
  if (!priv) {
    say('(no private lobby in the directory this run — badcode not exercised)')
  } else {
    await page.locator(`.sglb__row[data-lobby="${priv}"]`).click()
    const st0 = await readBrowserState(page)
    say(`chose private ${priv}: foot = "${st0.foot}"`)
    if (!/code/i.test(st0.foot)) note('a private row does not say it needs a code')
    say('shot ' + await shoot(page, 'browser-private-chosen'))
    await page.locator('.sglb__code').fill('ZZZZ')
    await page.locator('.sglb--browser .sglb__foot .sg-btn--gold').click()
    await page.waitForTimeout(900)
    const st1 = await readBrowserState(page)
    say(`bad code -> "${st1.foot}" (${st1.footKind})`)
    if (st1.footKind !== 'bad') note('a wrong join code produced no visible refusal')
    if (await screenOf(page) !== 'lobby') note('a wrong join code still let us into a room')
    say('shot ' + await shoot(page, 'browser-badcode'))
  }
}
{
  // A public room with people already in it, so the member list is worth
  // photographing and the guest's view of Start can be read.
  // THE BUSIEST ROW THAT STILL HAS A SEAT. Sorting by player count alone picks
  // an 8/8 lobby, and the honest answer to joining one of those is `full` --
  // which the screen renders correctly and which is not what this step is for.
  const pickPublic = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll('.sglb__row')]
      .filter((x) => x.querySelector('.sglb__col--access')?.dataset.access === 'public'
        && x.dataset.status === 'open' && !x.classList.contains('is-mine'))
      .map((x) => {
        const [n, max] = (x.querySelector('.sglb__col--players')?.textContent ?? '0/0')
          .split('/').map(Number)
        return { id: x.dataset.lobby, n, max }
      })
      .filter((r) => r.n < r.max)
    rows.sort((a, b) => b.n - a.n)
    return rows[0] ? rows[0].id : null
  })
  let scr = 'lobby'
  // Up to three tries: the directory is four seconds behind the world, so a
  // seat can close between the poll and the press. That race is the reason
  // `JoinError` exists and losing it is not a failure.
  for (let attempt = 0; attempt < 3 && scr !== 'room'; attempt++) {
    const pub = await pickPublic()
    if (!pub) { note('there was no joinable public lobby to join'); break }
    await page.locator(`.sglb__row[data-lobby="${pub}"]`).click()
    await page.locator('.sglb--browser .sglb__foot .sg-btn--gold').click()
    await page.waitForTimeout(1300)
    scr = await screenOf(page)
    if (scr !== 'room') {
      say(`join lost the race: "${(await readBrowserState(page)).foot}"`)
      await page.mouse.move(6, 6)
      await page.waitForTimeout(1600)
    }
  }
  {
    if (scr !== 'room') {
      note('could not get into anybody else\'s lobby in three tries')
    } else {
      const r = await readRoom(page)
      say(`joined "${r.name}" ${r.count} — host controls=${r.hostControls}`)
      say(`guest start: disabled=${r.startDisabled} hidden=${r.startHidden} why="${r.why}"`)
      for (const m of r.members) {
        say(`   ${m.you ? '>' : ' '} ${m.name.padEnd(12)} ${m.host ? 'HOST' : '    '} `
          + `${String(m.ping).padStart(7)}  ${m.state}  kick=${m.kick}`)
      }
      if (r.startHidden === true) {
        note('a guest cannot see the Start button at all, so they cannot see why')
      }
      checkStartAgrees(r, 'guest room')
      if (!r.why) note('a guest is given no reason Start is unavailable')
      if (r.hostControls) note('a guest was given the host-only circuit controls')
      if (r.members.some((m) => m.kick)) note('a guest can kick people')
      if (r.members.length < 2) note('joined a lobby that turned out to be empty')
      const noAvatar = r.members.filter((m) => !m.avatarArt)
      if (noAvatar.length) note(`${noAvatar.length} member row(s) have no avatar`)
      await checkFit(page, 'guest room')
      say('shot ' + await shoot(page, 'room-guest'))
      if (r.why) blockedReasons.add(r.why)

      // The room ending under the player. `hostLeaves` is 0.03 per lobby per
      // tick and `kickLocal` 0.008, so ~20-30s of ticks usually does it. It is
      // a real state with its own sentence and this is the only way to reach
      // it, so it gets a bounded wait and an honest note if it does not happen.
      const closed = await page.waitForFunction(() => {
        const n = document.querySelector('.sglb__notice')
        return n && !n.hidden ? n.textContent : null
      }, null, { timeout: 30000 }).then((h) => h.jsonValue()).catch(() => null)
      if (closed) {
        say(`the room ended under us: "${closed}"`)
        say('shot ' + await shoot(page, 'browser-room-closed'))
        if (await screenOf(page) !== 'lobby') {
          note('the room closed and the player was left on the room screen')
        }
      } else {
        say('(the room survived 30s — onClosed was not exercised this run)')
        await page.locator('.sglb--room .sg-head .sg-btn--ghost').click()
        await page.waitForTimeout(800)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// WHY THE ROOM WENT AWAY, WHICH THE SCREEN USED TO THROW AWAY
// ---------------------------------------------------------------------------
//
// A room that ends mid-RACE fires `onClosed` while this screen is not on. The
// navigation branch in that handler does nothing (there is nothing to navigate
// away from), the notice is written to a browser screen nobody is looking at,
// and then game/main.ts walks back to the room -- where `enter('room')` finds
// no room and used to overwrite the whole thing with "You are not in a lobby."
//
// That is the ONLY route by which host migration and rejoin ever report
// anything to a player, and every sentence net/live.ts writes for them went
// down it. The mock cannot produce one -- it closes rooms with a reason and no
// detail -- so the two failures are driven straight into the service's own
// callback here, which is the seam ui/lobby.ts subscribes to.
console.log('\n-- a room that ended with something to say --------------------')
if (await screenOf(page) !== 'lobby') await goto(page, 'lobby')
await page.waitForTimeout(400)
{
  const cases = [
    ['migration ran out of budget', 'hostLeft',
      'Could not reach Ada, who took over when the host left. Thirty seconds was '
      + 'the whole budget and the race went on without us.'],
    ['a rejoin that never landed', 'unreachable',
      'Could not get back to Ada in 30 seconds. Your car finished the round under '
      + 'the AI from the frame you went quiet.'],
    ['a plain host departure, which has no detail at all', 'hostLeft', null],
  ]
  for (const [label, reason, detail] of cases) {
    const seen = await page.evaluate(async ([r, d]) => {
      const svc = window.__NET__.lobbyService()
      if (svc.current()) await svc.leave()
      const n = document.querySelector('.sglb__notice')
      if (n) { n.textContent = ''; n.hidden = true }
      // The wire speaks while the player is in a race, so this screen is off.
      window.__GAME__.frontEnd.hide()
      svc.onClosed(r, d ?? undefined)
      // The race ends and the game goes back to the room it no longer has.
      window.__GAME__.frontEnd.show('room')
      await new Promise((res) => setTimeout(res, 120))
      const el = document.querySelector('.sglb__notice')
      return {
        text: el && !el.hidden ? el.textContent : '',
        screen: document.querySelector('.sg-fe')?.dataset.screen ?? '-',
      }
    }, [reason, detail])
    say(`${label}:`)
    say(`   "${seen.text}"`)
    if (seen.screen === 'room') note(`${label}: left standing on a room screen with no room`)
    if (!seen.text) {
      note(`${label}: the room ended and the screen said nothing at all`)
    } else if (/not in a lobby/i.test(seen.text) && detail) {
      note(`${label}: the specific sentence was replaced by the generic one, which `
        + 'is the whole of what a player would be told about a failed repair')
    } else if (detail && !seen.text.includes(detail)) {
      note(`${label}: the detail never reached the screen`)
    } else if (!detail && !/host left/i.test(seen.text)) {
      note(`${label}: a closure with no detail lost its generic sentence too`)
    }
  }
  say('shot ' + await shoot(page, 'room-closed-detail'))
}

// ---------------------------------------------------------------------------
// THE PROFILE
// ---------------------------------------------------------------------------
console.log('\n-- the profile -----------------------------------------------')
if (await screenOf(page) !== 'lobby') await goto(page, 'lobby')
await page.waitForTimeout(400)
await page.locator('.sglb--browser .sglb__headright .sg-btn--ghost').click()
await page.waitForTimeout(900)
{
  const p = await readProfile(page)
  say(`name="${p.name}" worn=${p.worn} (${p.wornName}) credits=${p.credits}`)
  say(`picker: ${p.tiles} tiles — ${p.owned} owned, ${p.buyable} buyable, ${p.locked} locked`)
  say(`  "${p.count}"`)
  if (p.tiles !== 24) note(`the picker shows ${p.tiles} portraits, expected 24`)
  if (p.owned < 4) note(`fewer than the four starters are owned (${p.owned})`)
  if (p.buyable < 1) note('a new profile cannot afford anything — the shop teaches nothing')
  if (p.locked < 1) note('nothing is locked, so no requirement is ever shown')
  if (p.offline) note('the perfect profile came up offline')
  if (p.ephemeral) note('the perfect profile came up ephemeral with storage available')
  await checkFit(page, 'profile')
  say('shot ' + await shoot(page, 'profile'))
}

// --- 7. THE THREE PAGES, PHOTOGRAPHED AND MEASURED -------------------------
//
// A tab rail is the easiest thing in a phone layout to get wrong, and the two
// ways it goes wrong are both geometry rather than appearance: it wraps to a
// second row (which draws the selected tab's underline through the middle of
// the block rather than on the rule beneath it), or a tab drops under the
// 44px a thumb needs. Both are read off rectangles here. The strip is
// horizontal on a desk and in portrait, and styles.css turns it into a
// vertical RAIL under `max-height: 560px` -- which a landscape phone is -- so
// which shape to demand is a function of the viewport, not a constant.
const RAIL = LANDSCAPE || VIEWPORT.height <= 560
{
  const first = await readPages(page)
  say(`strip: ${first.tabs.length} tabs, ${first.rows} row(s), ${first.cols} column(s)`
    + ` — ${RAIL ? 'rail expected' : 'strip expected'}`)
  if (first.tabs.length !== 3) note(`the profile has ${first.tabs.length} tabs, expected 3`)
  if (first.tabs.some((t) => !t.id)) note('a tab has no data-tab — nothing can address it')
  if (RAIL) {
    if (first.cols !== 1) note(`the rail is ${first.cols} columns wide, so it is not a rail`)
  } else if (first.rows !== 1) {
    note(`the tab strip wrapped onto ${first.rows} rows at ${VIEWPORT.width}px`)
  }
  for (const t of first.tabs) {
    if (t.h < 44) note(`tab "${t.label}" is ${t.h}px tall — under the 44px thumb floor`)
  }

  for (const id of ['portrait', 'vehicle', 'pilot']) {
    await selectTab(page, id)
    const r = await readPages(page)
    const p = r.pages[id]
    if (r.selected !== id) note(`pressing the ${id} tab selected "${r.selected}"`)
    if (!p) { note(`there is no ${id} page`); continue }
    if (!p.shown) note(`the ${id} page is selected and not visible`)
    // Exactly one panel at a time: `hidden` on the others is what keeps their
    // buttons out of the focus walk, and a stylesheet can defeat it.
    const alsoOn = Object.entries(r.pages).filter(([k, v]) => k !== id && v.shown)
    if (alsoOn.length) note(`the ${id} page is up and so is ${alsoOn.map(([k]) => k).join(', ')}`)
    if (p.sideways) note(`the ${id} page scrolls sideways`)
    if (!p.count) note(`the ${id} page never says what is owned`)
    if (!p.on) note(`the ${id} page marks nothing as in use`)
    if (!p.onTag) note(`the ${id} page's marker is a colour with no word beside it`)
    say(`${id}: ${p.tiles} tiles, ${p.locked} locked, in use "${p.on}" (${p.onTag})`)
    say(`  "${p.count}"`)
    if (id !== 'portrait') {
      // The two rosters that are free say so, rather than leaving the
      // question of what is locked unanswered -- see paintLoadout().
      if (p.locked !== 0) note(`the ${id} page has ${p.locked} locked tiles and no shop`)
      if (!/unlocked/i.test(p.count)) note(`the ${id} page does not say that nothing is locked`)
      if (!p.now) note(`the ${id} page does not describe what is selected`)
    }
    if (id === 'vehicle') {
      if (!r.preview) note('the vehicle page has no preview canvas')
      else {
        say(`  preview canvas ${r.preview.w}x${r.preview.h}`)
        if (r.preview.w < 80 || r.preview.h < 60) {
          note(`the vehicle preview is ${r.preview.w}x${r.preview.h} — collapsed`)
        }
      }
    } else if (r.preview) {
      // The context is allowed to exist for ONE page of one screen.
      note(`the ${id} page is up and a preview canvas is still alive`)
    }
    await checkFit(page, 'profile/' + id)
    say('shot ' + await shoot(page, 'profile-' + id))
  }
}

// --- 8. ONE SELECTION, TWO SCREENS -----------------------------------------
//
// The whole point of the restructure. A screenshot of either screen looks
// right whichever value it is showing; the only way to catch two ids that
// disagree is to change one in one place and read it in the other, both ways
// round, with the front end's own getter as the referee in between.
{
  await selectTab(page, 'vehicle')
  const started = await page.evaluate(() => window.__GAME__.frontEnd.selectedChassisId)
  const other = await page.evaluate((cur) =>
    [...document.querySelectorAll('.sgpf__page[data-page="vehicle"] .sgpf__tile')]
      .map((t) => t.dataset.item).find((id) => id !== cur), started)
  if (!other) {
    note('the vehicle page offers only one chassis — nothing to change to')
  } else {
    await page.locator(`.sgpf__tile[data-chassis="${other}"]`).click()
    await page.waitForTimeout(300)
    const fe = await page.evaluate(() => window.__GAME__.frontEnd.selectedChassisId)
    const r = await readPages(page)
    say(`profile picked ${other}: front end says ${fe}, tile marked "${r.pages.vehicle.on}"`)
    if (fe !== other) note(`the profile changed a tile and the front end still says ${fe}`)
    if (r.pages.vehicle.on !== other) note('the profile did not mark the chassis it just set')

    // ...and the garage is showing the same car, without having been told.
    await goto(page, 'garage')
    await page.waitForTimeout(700)
    const garage = await page.evaluate(() => ({
      lit: document.querySelector('.sg-col--chassis .sg-card.is-sel')?.dataset.chassis ?? '',
      // SCOPED TO THE GARAGE. The track screen's briefing reuses
      // `.sg-detail__name` and comes first in the DOM, so the bare selector
      // reads an empty div until somebody has opened the track list.
      name: document.querySelector('.sg-screen--garage .sg-detail__name')?.textContent ?? '',
      // THE DEBUG HANDLE STILL BELONGS TO THE GARAGE. There are two of these
      // widgets now and garagePreview.ts publishes the handle from its
      // constructor, so the later one would take it over -- and probe-garage,
      // probe-pilots and probe-vehicle would all be measuring a hidden box.
      // `live` is true only between a show() and its hide(), so it separates
      // the two without waiting on a frame count.
      dbgLive: window.__GARAGE_PREVIEW__?.debug()?.live ?? null,
      dbgChassis: window.__GARAGE_PREVIEW__?.debug()?.chassisId ?? '',
    }))
    say(`garage: card ${garage.lit} "${garage.name}", preview handle live=${garage.dbgLive}`
      + ` on ${garage.dbgChassis}`)
    if (garage.lit !== other) note(`the garage still has ${garage.lit} selected, not ${other}`)
    if (garage.dbgLive !== true) {
      note('__GARAGE_PREVIEW__ is not live on the garage screen — a second preview took the handle')
    }
    if (garage.dbgChassis !== other) {
      note(`__GARAGE_PREVIEW__ is showing ${garage.dbgChassis}, not ${other}`)
    }

    // The other direction: choose in the garage, read it in the profile.
    await page.locator(`.sg-card[data-chassis="${started}"]`).click()
    await page.waitForTimeout(300)
    await goto(page, 'profile')
    await page.waitForTimeout(500)
    await selectTab(page, 'vehicle')
    const back = await readPages(page)
    say(`garage picked ${started}: profile tile marked "${back.pages.vehicle.on}"`)
    if (back.pages.vehicle.on !== started) {
      note(`the profile shows ${back.pages.vehicle.on} after the garage chose ${started}`)
    }
  }
}

// --- 9. A HALF-TYPED NAME SURVIVES A TAB PRESS -----------------------------
//
// tabs.ts hides an off panel with the `hidden` attribute -- deliberately, so
// nothing inside it stays focusable -- which would have taken an unsaved name
// field away and brought it back stamped over if the field had been put on a
// page. It is on the identity card instead, and this is the assertion that
// says so; it cannot be seen in a photograph of either tab.
{
  const real = await page.evaluate(() => document.querySelector('.sgpf__in').value)
  await page.locator('.sgpf__in').fill('Half Typed')
  await selectTab(page, 'vehicle')
  await selectTab(page, 'pilot')
  await selectTab(page, 'portrait')
  const kept = await page.evaluate(() => document.querySelector('.sgpf__in').value)
  say(`unsaved name across three tab presses: "${kept}"`)
  if (kept !== 'Half Typed') note(`a tab press ate an unsaved name ("${kept}")`)
  await page.locator('.sgpf__in').fill(real)
}

// Everything below drives the PORTRAITS page, so it has to be the one up: the
// other two pages are `hidden`, and a hidden tile is not clickable.
await selectTab(page, 'portrait')

// --- 6. A LOCKED AVATAR CANNOT BE EQUIPPED ---------------------------------
{
  const before = await readProfile(page)
  await page.locator(`.sgpf__tile[data-avatar="${before.firstLocked}"]`).click()
  await page.waitForTimeout(700)
  const after = await readProfile(page)
  say(`pressed locked "${before.firstLocked}": worn ${before.worn} -> ${after.worn}`)
  say(`  refusal: "${after.pickMsg}"`)
  if (after.worn !== before.worn) {
    note(`a LOCKED avatar was equipped (${before.worn} -> ${after.worn})`)
  }
  if (after.refused !== before.firstLocked) {
    note('pressing a locked avatar produced no refusal message')
  }
  if (!after.pickMsg) note('the locked avatar gave no requirement sentence')
  say('shot ' + await shoot(page, 'profile-locked-refused'))
}

// --- buying, which takes two presses ---------------------------------------
{
  const before = await readProfile(page)
  const id = before.firstBuyable
  await page.locator(`.sgpf__tile[data-avatar="${id}"]`).click()
  await page.waitForTimeout(250)
  const armed = await page.evaluate((a) =>
    document.querySelector(`.sgpf__tile[data-avatar="${a}"]`)?.classList.contains('is-armed'),
  id)
  if (!armed) note('a buy happened on one press — a mis-tap now costs credits')
  say('shot ' + await shoot(page, 'profile-buy-armed'))

  // NOTHING GOES BETWEEN THE TWO PRESSES OF THE ACTUAL PURCHASE.
  //
  // The arm disarms itself after four seconds -- the product's own behaviour,
  // and the reason the only control in the game that spends credits is safe
  // to leave lying around. A full-page screenshot of this build under
  // swiftshader measures 2.4-2.9s, so putting the shot above BETWEEN the two
  // presses was a race against that timer: about one run in three the window
  // had closed, the "second" press armed the tile afresh, the wait below then
  // watched THAT arm expire, and the probe reported a purchase that had never
  // been asked for. Re-arming on demand narrowed the race without closing it.
  //
  // So the shot and the purchase stop sharing a window. Pressing ANY other
  // tile disarms (every path through `pressAvatar` starts with `disarm`), so
  // pressing the worn portrait puts the screen in a known, unarmed state and
  // answers "Already wearing ..." -- and the pair below then runs 160ms
  // apart, nowhere near four seconds. The two-press rule itself was already
  // proved by `armed` above; this part is about the money.
  await page.locator(`.sgpf__tile[data-avatar="${before.worn}"]`).click()
  await page.waitForTimeout(350)
  await page.locator(`.sgpf__tile[data-avatar="${id}"]`).click()
  await page.waitForTimeout(160)
  await page.locator(`.sgpf__tile[data-avatar="${id}"]`).click()
  // WAIT FOR THE ANSWER, NOT FOR A DURATION. The mock's latency is bimodal on
  // purpose and its slow mode reaches ~2.2s, so a fixed 900ms read this tile
  // while the purchase was still in flight and reported "buying an avatar cost
  // nothing" about a buy that had not happened yet. Which arm of the
  // distribution a given call draws moves with the world's seed, so the same
  // assertion passed and failed depending on how many lobbies the directory
  // happened to mint first -- a flake that says nothing about the feature.
  await page.waitForFunction((a) => {
    const t = document.querySelector(`.sgpf__tile[data-avatar="${a}"]`)
    if (!t || t.classList.contains('is-armed')) return false
    // "Buying…" is the IN-FLIGHT state and it is not an answer. Waiting only
    // for the confirm to disarm caught the request on its way out, which is
    // how this read back "cost nothing" about a purchase that had not been
    // charged yet.
    const msg = document.querySelector(
      '.sgpf__page[data-page="portrait"] .sgpf__msg--pick')?.textContent ?? ''
    return !/buying/i.test(msg)
  }, id, { timeout: 12000 }).catch(() => note('the buy never came back'))
  await page.waitForTimeout(200)
  const after = await readProfile(page)
  say(`bought ${id}: credits ${before.credits} -> ${after.credits}, worn ${after.worn}`)
  say(`  "${after.pickMsg}"`)
  if (after.worn !== id) note('buying an avatar did not equip it')
  if (after.credits === before.credits) note('buying an avatar cost nothing')
  say('shot ' + await shoot(page, 'profile-bought'))
}

// --- 5. FOUR OF THE FIVE NameErrors (the fifth needs the failure dice) ------
const seenNameErrors = new Set()
for (const [value, want] of [
  ['ab', 'short'],
  ['abcdefghijklmnopqr', 'long'],
  ['a..b', 'charset'],
  ['SpaceGen', 'taken'],
]) {
  await page.locator('.sgpf__in').fill(value)
  await page.locator('.sgpf__namerow .sg-btn').click()
  await page.waitForTimeout(700)
  const p = await readProfile(page)
  seenNameErrors.add(p.nameErr)
  say(`name "${value}" -> ${p.nameErr || '(accepted)'} : "${p.nameMsg}"`)
  if (p.nameErr !== want) note(`name "${value}" should be ${want}, screen said "${p.nameErr}"`)
  if (want === 'taken') say('shot ' + await shoot(page, 'profile-name-taken'))
}

// --- portrait art that fails to load ---------------------------------------
{
  const broke = await page.evaluate(() => {
    const img = document.querySelector('.sgpf__tile .sgpf__art')
    if (!img) return false
    img.src = 'avatars/definitely-not-there.png'
    return true
  })
  await page.waitForTimeout(600)
  const p = await readProfile(page)
  say(`portrait 404 fallback: broke=${broke} tiles on fallback=${p.badArt}`)
  if (broke && p.badArt < 1) {
    note('a portrait that fails to load leaves an empty circle — no fallback fired')
  }
}

await ctxP.close()

// ---------------------------------------------------------------------------
// PASS 3 — ?net=mock: the two paths that need the 6% failure dice
// ---------------------------------------------------------------------------
console.log('\n-- ?net=mock: the failure dice -------------------------------')
{
  const { ctx, page: m } = await open('mock')
  await m.locator('.sg-title__multi .sg-btn--violet').click()
  await m.waitForFunction(() => document.querySelectorAll('.sglb__row').length > 0,
    null, { timeout: 20000 }).catch(() => note('mock never listed a lobby'))

  // 3b. A REFRESH THAT FAILS KEEPS THE ROWS. FAILURE_RATE is 0.06, so 120
  //     presses miss with probability 0.94^120 ~= 0.06%.
  let failed = null
  for (let i = 0; i < 120 && !failed; i++) {
    await m.locator('.sglb__bar .sg-btn--ghost').click()
    await m.waitForTimeout(90)
    const st = await readBrowserState(m)
    if (st.statusKind === 'bad' || st.error) failed = { i, ...st }
  }
  if (!failed) {
    note('120 refreshes and the mock never failed one — the error path was not exercised')
  } else {
    say(`refresh #${failed.i + 1} failed: rows still ${failed.rows}, `
      + `error panel=${failed.error}`)
    say(`  "${failed.status}"`)
    if (failed.rows === 0 && !failed.error) {
      note('a failed refresh emptied the list and said nothing')
    }
    if (failed.rows > 0 && !/could not refresh/i.test(failed.status)) {
      note(`a failed refresh did not say so: "${failed.status}"`)
    }
    say('shot ' + await shoot(m, 'browser-refresh-failed'))
  }

  // 5b. THE FIFTH NameError. `setName` reports a failed request as 'offline'
  //     -- the contract's own reasoning -- so re-claiming a name that is
  //     already ours is either ok or offline, and nothing else.
  await goto(m, 'profile')
  await m.waitForFunction(() => !!document.querySelector('.sgpf__in')?.value,
    null, { timeout: 20000 }).catch(() => note('the profile never loaded under ?net=mock'))
  const mine = await m.evaluate(() => document.querySelector('.sgpf__in').value)
  let gotOffline = false
  for (let i = 0; i < 140 && !gotOffline; i++) {
    // THE FIELD CAN GO DEAD UNDER THIS LOOP, and then both of the lines below
    // are aimed at a disabled control and Playwright retries them for thirty
    // seconds before the run dies with no idea why. `load()` re-rolls the
    // connection on every entry to the screen, so an iteration can leave the
    // ACCOUNT offline -- which disables the name field and the Claim button,
    // correctly, because nothing can be claimed without a server -- without
    // this loop having seen the `offline` NameError it is here to catch.
    // Re-entering the screen re-rolls the connection, which is the contract's
    // own documented way back from offline and what the banner's Try again
    // button does.
    if (await m.evaluate(() =>
      document.querySelector('.sgpf__namerow .sg-btn')?.disabled === true)) {
      await goto(m, 'lobby')
      await goto(m, 'profile')
      await m.waitForTimeout(400)
      continue
    }
    await m.locator('.sgpf__in').fill(mine)
    // CLAIM IS DISABLED WHILE A CLAIM IS IN FLIGHT, and under ?net=mock one
    // takes 110-1100ms. Clicking straight into the next iteration hit a
    // button that was still busy with the last one, and Playwright then waited
    // its full thirty seconds for a control that only comes back when the
    // request lands. Wait for it, and let a click that loses the race be
    // retried by the loop rather than fail the probe.
    await m.locator('.sgpf__namerow .sg-btn:not([disabled])')
      .waitFor({ timeout: 8000 }).catch(() => {})
    await m.locator('.sgpf__namerow .sg-btn').click({ timeout: 4000 }).catch(() => {})
    await m.waitForTimeout(80)
    await m.waitForFunction(() => {
      const el = document.querySelector('.sgpf__msg:not(.sgpf__msg--pick)')
      return el && el.dataset.kind !== 'wait'
    }, null, { timeout: 8000 }).catch(() => {})
    const p = await readProfile(m)
    if (p.nameErr === 'offline') {
      gotOffline = true
      seenNameErrors.add('offline')
      say(`claim #${i + 1} came back offline: "${p.nameMsg}"`)
      say('shot ' + await shoot(m, 'profile-name-offline'))
    }
  }
  if (!gotOffline) note('never saw the `offline` NameError in 140 claims')

  // ...and the ACCOUNT-level offline banner, which is a different sentence
  // again. `load()` re-rolls the connection on every entry to the screen.
  // ONE LOAD PER ITERATION, ACTUALLY WAITED FOR. `load()` takes 110-1100ms
  // under ?net=mock, so a fixed short sleep here fires ninety requests and
  // reads the answer to none of them. The Retry button inside the banner is
  // disabled for exactly the duration of a refresh whether or not the banner is
  // showing, which makes it the settle signal.
  let offlineBanner = false
  for (let i = 0; i < 90 && !offlineBanner; i++) {
    await goto(m, 'lobby')
    await goto(m, 'profile')
    await m.waitForFunction(() => {
      const b = document.querySelector('.sgpf__flag--offline button')
      return !!b && b.disabled === false
    }, null, { timeout: 8000 }).catch(() => {})
    const p = await readProfile(m)
    if (p.offline) {
      offlineBanner = true
      say(`profile came up offline on entry #${i + 1}: name field disabled=${p.nameDisabled}`)
      if (p.nameDisabled !== true) note('an offline profile still offers a live name field')
      if (p.ephemeral) note('offline and ephemeral were shown together with storage working')
      say('shot ' + await shoot(m, 'profile-offline'))

      // 10. OFFLINE STOPS WHAT THE ACCOUNT HOLDS, AND NOTHING ELSE.
      //
      // A portrait belongs to the server: it is bought there and worn there,
      // so with the server out of reach it must refuse, and the block above
      // and the `locked` test both prove it does. A CHASSIS does not: it is a
      // localStorage key this device owns, it costs nothing, and the garage
      // will change it with the account server on fire. Both presses go
      // through the same `refuse()` in ui/profile.ts and are separated only
      // by its `held` argument -- which is precisely the kind of boolean that
      // is written the wrong way round and never noticed, because the screen
      // looks identical either way.
      await selectTab(m, 'vehicle')
      const was = await m.evaluate(() => window.__GAME__.frontEnd.selectedChassisId)
      const alt = await m.evaluate((cur) =>
        [...document.querySelectorAll('.sgpf__page[data-page="vehicle"] .sgpf__tile')]
          .map((t) => t.dataset.item).find((id) => id !== cur), was)
      if (!alt) {
        note('no second chassis to try while offline')
      } else {
        await m.locator(`.sgpf__tile[data-chassis="${alt}"]`).click()
        await m.waitForTimeout(300)
        const got = await m.evaluate(() => window.__GAME__.frontEnd.selectedChassisId)
        const pg = await readPages(m)
        say(`  offline chassis change ${was} -> ${got}: "${pg.pages.vehicle.msg}"`)
        if (got !== alt) {
          note('an offline ACCOUNT blocked a chassis change the account does not hold')
        }
        say('shot ' + await shoot(m, 'profile-offline-vehicle'))
      }
      await selectTab(m, 'portrait')
    }
  }
  if (!offlineBanner) note('never reached the offline account state in 90 profile loads')
  await ctx.close()
}

// ---------------------------------------------------------------------------
// PASS 4 — a private window: `ephemeral`, which is NOT `offline`
// ---------------------------------------------------------------------------
console.log('\n-- storage blocked: ephemeral is its own sentence -------------')
{
  const { ctx, page: e } = await open('perfect', { blockStorage: true })
  await goto(e, 'profile')
  await e.waitForFunction(() => !!document.querySelector('.sgpf__in')?.value,
    null, { timeout: 20000 }).catch(() => note('the profile never loaded with storage blocked'))
  await e.waitForTimeout(400)
  const p = await readProfile(e)
  const words = await e.evaluate(() => ({
    eph: document.querySelector('.sgpf__flag--ephemeral')?.textContent ?? '',
    off: document.querySelector('.sgpf__flag--offline')?.textContent ?? '',
  }))
  say(`ephemeral=${p.ephemeral} offline=${p.offline}`)
  say(`  ephemeral says: "${words.eph.slice(0, 110)}…"`)
  if (!p.ephemeral) note('a browser blocking storage produced no ephemeral warning')
  if (p.offline) note('storage being blocked was reported as being offline — different facts')
  if (words.eph === words.off) note('the two account warnings are the same sentence')
  if (!/storage/i.test(words.eph)) note('the ephemeral warning does not mention storage')
  say('shot ' + await shoot(e, 'profile-ephemeral'))
  await ctx.close()
}

// ---------------------------------------------------------------------------
console.log('\n-- summary ---------------------------------------------------')
say(`NameErrors reached the screen: ${[...seenNameErrors].filter(Boolean).sort().join(', ')}`)
for (const want of ['short', 'long', 'charset', 'taken', 'offline']) {
  if (!seenNameErrors.has(want)) note(`the NameError "${want}" never reached the screen`)
}
say(`Start-blocked reasons seen (${blockedReasons.size}):`)
for (const r of blockedReasons) say('   · ' + r)
if (blockedReasons.size < 2) {
  note(`only ${blockedReasons.size} distinct reason(s) for a disabled Start were reached`)
}
for (const [what, re] of [['host not ready', /hosting does not count/i],
  ['guest waiting on the host', /starts the race|waiting for/i]]) {
  if (![...blockedReasons].some((w) => re.test(w))) {
    note(`the "${what}" reason for a disabled Start never appeared`)
  }
}

console.log('')
if (errors.length) {
  console.log(`LOBBY PROBE: ${errors.length} problem(s)`)
  for (const e of errors) console.log('  - ' + e)
} else {
  console.log('LOBBY PROBE: clean')
}
await browser.close()
server.close()
process.exit(errors.length ? 1 : 0)
