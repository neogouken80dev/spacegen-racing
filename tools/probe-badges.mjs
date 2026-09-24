/**
 * THE BADGE WALL, PHOTOGRAPHED AND MEASURED -- AND THE RACE PATH THAT FILLS IT.
 *
 * Two halves, because they answer different questions:
 *
 *   SCREENS   every surface the achievements feature adds, at the four sizes
 *             the game is played at: the title's new button, the wall's Global
 *             and Tracks pages, the detail card for each frame kind, the HUD's
 *             mid-race chip, the settings dialog's Badges page, the results
 *             screen's NEW BADGES strip and a toast. Each is measured as well
 *             as photographed -- text under 11px, a tap target under 44px, a
 *             page that scrolls sideways, and the chip's overlap with every HUD
 *             readout -- because a screenshot at dpr 3 flatters all four.
 *
 *   RACE      one REAL race, driven to a real results screen, with the store
 *             seeded a step short of four thresholds. What it proves is the
 *             wiring rather than the look: that main.ts's sub-step hook feeds
 *             the tracker, that the mid-race preview raises a chip on its own,
 *             that the flag banks the race and fills the strip, and that the
 *             toast fires -- none of which a staged screen can show.
 *
 * The staged results screens in the SCREENS half are labelled as such: the
 * race that reaches them is a real race abandoned early (so `finishRace`, the
 * bank and the strip all run), but the ids on the strip are set by the probe so
 * every size shows a full row. The RACE half is the one that shows what the
 * game put there by itself.
 *
 * WAITS ON SIM TIME AND SIM PHASE, NEVER WALL CLOCK, for the reason
 * probe-tabs.mjs gives: SwiftShader renders below 1 fps here.
 *
 *   node tools/probe-badges.mjs             both halves
 *   node tools/probe-badges.mjs --screens   the screens only
 *   node tools/probe-badges.mjs --race      the race only
 *
 * Serves dist/ -- run `npx vite build` first. Writes shots/achievements/*.png.
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

const OUT = 'shots/achievements'
mkdirSync(OUT, { recursive: true })
const ONLY = process.argv.includes('--screens') ? 'screens'
  : process.argv.includes('--race') ? 'race' : 'all'

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
}
// A REAL 404 for a missing file, not index.html: a badge whose webp is not in
// dist/ must exercise the medal's fallback the way a broken deploy would.
const server = createServer((req, res) => {
  const u = decodeURIComponent((req.url ?? '/').split('?')[0])
  const path = join('dist', u === '/' ? 'index.html' : u.slice(1))
  if (!existsSync(path) || !statSync(path).isFile()) { res.writeHead(404); res.end('nf'); return }
  res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' })
  res.end(readFileSync(path))
})
await new Promise((r) => server.listen(0, r))
const URL_ = `http://127.0.0.1:${server.address().port}/`

const SIZES = [
  { tag: 'desktop', w: 1280, h: 720, dpr: 1, touch: false },
  { tag: 'phone-portrait', w: 390, h: 844, dpr: 3, touch: true },
  { tag: 'phone-landscape', w: 844, h: 390, dpr: 3, touch: true },
  { tag: 'tablet', w: 820, h: 1180, dpr: 2, touch: true },
]

// ---------------------------------------------------------------------------
// THE SEED. A wall with every frame kind on it, earned and locked side by side,
// and four counters one step short of a threshold for the race to cross.
// ---------------------------------------------------------------------------
const tr = (b, t) => `${b}:${t}`
const SEED = {
  v: 1,
  d: false,
  u: [
    // Elkarim five of eight, and one or two elsewhere: two-tone rings.
    tr('track-cleanlap', 'rustfall'), tr('track-victory', 'rustfall'), tr('track-driftking', 'rustfall'),
    tr('track-wrecking', 'rustfall'), tr('track-holeshot', 'rustfall'),
    tr('track-victory', 'halcyon'), tr('track-victory', 'cryostatic'), tr('track-laprecord', 'cryostatic'),
    tr('track-cleanlap', 'hollowchoir'), tr('track-victory', 'neonspire'),
    // Front Runner on two of four: the difficulty ring, half lit.
    'frontrunner:easy', 'frontrunner:normal',
    // Every metal: prism, gold, silver (wins, via the profile floor too).
    'legendary-drifts:1', 'legendary-drifts:2', 'legendary-drifts:3', 'legendary-drifts:4',
    'knockouts:1', 'knockouts:2', 'knockouts:3',
    'wins:1', 'wins:2',
    // Singles, two of them stand-in art.
    'comeback', 'photo-finish', 'combo-king', 'iron-will',
    'mark:win:solaire', 'mark:win:bulwark',
  ],
  c: {
    singularity: 1012, knockouts: 540, wins: 12,
    // ONE SHORT, for the race half: a finish, a perfect launch, a landed hit
    // and a second of air each cross a bronze.
    finishes: 9, launches: 9, hits: 49, airtime: 59990,
  },
}
// The mock account the wall's profile comes from: Tycoon reads `earned`.
const ACCOUNT = {
  v: 1, id: 'acct-probe', secret: 'probe-secret',
  profile: {
    id: 'acct-probe', name: 'Probe', avatarId: '', unlocked: [],
    credits: 1200, earned: 62000, races: 47, wins: 12,
  },
  ach: { unlocked: [], counters: {} },
}
// What the staged results screens put on the strip: one of each frame kind.
const SAMPLE = [
  tr('track-cleanlap', 'rustfall'), 'frontrunner:hard', 'finishes:1',
  'airtime:1', 'rocket-start:1', 'untouchable', 'high-roller',
]

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist'],
})

const problems = []
const note = (tag, what) => { problems.push(`${tag}: ${what}`); console.log(`  !! ${what}`) }

async function openPage(S) {
  const ctx = await browser.newContext({
    viewport: { width: S.w, height: S.h }, deviceScaleFactor: S.dpr,
    hasTouch: S.touch, isMobile: S.touch && S.w < 900,
  })
  await ctx.addInitScript(([seed, acct]) => {
    try {
      // Once per context: a reload inside the probe keeps what the game wrote.
      if (!sessionStorage.getItem('probe.seeded')) {
        localStorage.clear()
        localStorage.setItem('sg.achievements', seed)
        localStorage.setItem('sg.account', acct)
        localStorage.setItem('sg.name', 'PROBE')
        sessionStorage.setItem('probe.seeded', '1')
      }
    } catch { /* blocked */ }
    // The iOS pre-permission state, as probe-hudstates.mjs stubs it.
    const D = window.DeviceOrientationEvent
    if (D) D.requestPermission = () => Promise.reject(new Error('requires a user gesture'))
  }, [JSON.stringify(SEED), JSON.stringify(ACCOUNT)])
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  // The console's own 404 line names no URL; the response does. The two
  // endpoints a static server cannot answer -- the leaderboard and the account
  // functions -- are expected to fail here and are not the feature's.
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text())
  })
  page.on('response', (r) => {
    if (r.status() >= 400 && !/\/api\//.test(r.url())) errors.push(`${r.status()} ${r.url()}`)
  })
  await page.goto(URL_, { waitUntil: 'load', timeout: 60000 })
  await page.waitForFunction(() => !!window.__GAME__, null, { timeout: 60000 })
  await page.waitForTimeout(1500)
  // Every piece of news the game raises, logged, so the race half can say
  // WHICH path raised it rather than only that a card was on screen.
  await page.evaluate(() => {
    const g = window.__GAME__
    window.__news = []
    const t = g.badgeToasts
    const show = t.show.bind(t), chip = t.chip.bind(t)
    t.show = (ids) => { window.__news.push({ kind: 'show', ids: [...ids], t: g.race?.state?.time ?? -1 }); show(ids) }
    t.chip = (ids) => { window.__news.push({ kind: 'chip', ids: [...ids], t: g.race?.state?.time ?? -1 }); chip(ids) }
  })
  const act = async (sel) => {
    const loc = page.locator(sel).first()
    await loc.scrollIntoViewIfNeeded({ timeout: 30000 }).catch(() => {})
    if (S.touch) await loc.tap({ timeout: 60000 })
    else await loc.click({ timeout: 60000 })
  }
  return { ctx, page, errors, act }
}

const shot = async (page, name) => {
  const path = join(OUT, `${name}.png`)
  await page.screenshot({ path })
  console.log(`  shot ${path}`)
  return path
}

/** Text under 11px, targets under 44px, and sideways scroll, inside `sel`. */
const measure = (page, sel) => page.evaluate((rootSel) => {
  const vis = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const st = getComputedStyle(n)
      if (st.display === 'none' || st.visibility === 'hidden') return false
      if (n.hidden) return false
    }
    const b = el.getBoundingClientRect()
    return b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < innerHeight
  }
  const root = document.querySelector(rootSel)
  if (!root) return { missing: true }
  const small = []
  let minPx = 99
  for (const el of root.querySelectorAll('*')) {
    let text = ''
    for (const c of el.childNodes) if (c.nodeType === 3) text += c.textContent
    text = text.trim()
    if (!text || !vis(el)) continue
    const px = parseFloat(getComputedStyle(el).fontSize)
    minPx = Math.min(minPx, px)
    if (px < 10.95) small.push(`${String(el.className).split(' ')[0]} "${text.slice(0, 20)}" ${px}px`)
  }
  const tiny = []
  let minTap = 999
  for (const b of root.querySelectorAll('button')) {
    if (!vis(b)) continue
    const r = b.getBoundingClientRect()
    const m = Math.min(r.width, r.height)
    minTap = Math.min(minTap, m)
    if (r.height < 43.5 || r.width < 43.5) tiny.push(`${String(b.className).split(' ')[0]} "${(b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 18)}" ${Math.round(r.width)}x${Math.round(r.height)}`)
  }
  const doc = document.scrollingElement
  return {
    small, minPx, tiny, minTap: Math.round(minTap),
    pageOverflowX: doc.scrollWidth - innerWidth,
    rootOverflowX: root.scrollWidth - root.clientWidth,
  }
}, sel)

const report = (tag, what, m) => {
  if (m.missing) { note(tag, `${what}: root missing`); return }
  console.log(`  ${what}: smallest text ${m.minPx}px, smallest target ${m.minTap}px, `
    + `page overflow-x ${m.pageOverflowX}, root overflow-x ${m.rootOverflowX}`)
  for (const s of m.small) note(tag, `${what}: text under 11px -- ${s}`)
  for (const s of m.tiny) note(tag, `${what}: target under 44px -- ${s}`)
  if (m.pageOverflowX > 0) note(tag, `${what}: page scrolls sideways by ${m.pageOverflowX}px`)
  if (m.rootOverflowX > 1) note(tag, `${what}: wall overflows sideways by ${m.rootOverflowX}px`)
}

/** Wait until the race's sim clock has advanced `sec` from now, or the cap. */
async function waitSim(page, sec, capMs = 120000) {
  const now = () => page.evaluate(() => window.__GAME__?.race?.state?.time ?? 0)
  const start = await now()
  const t0 = Date.now()
  while (Date.now() - t0 < capMs) {
    if ((await now()) - start >= sec) return true
    await page.waitForTimeout(150)
  }
  return false
}

const frames = (page, n) => page.evaluate(async (count) => {
  for (let i = 0; i < count; i++) await new Promise((r) => requestAnimationFrame(() => r()))
}, n)

// ===========================================================================
// SCREENS
// ===========================================================================
if (ONLY !== 'race') {
  for (const S of SIZES) {
    console.log(`\n=== ${S.tag} ${S.w}x${S.h} @${S.dpr}x ===`)
    const { ctx, page, errors, act } = await openPage(S)

    await shot(page, `${S.tag}-title`)
    await act('.sg-title__acct [data-open="achievements"]')
    // The account load (mock latency) and the toast it raises for Tycoon.
    await page.waitForTimeout(2500)
    await shot(page, `${S.tag}-global`)
    report(S.tag, 'global page', await measure(page, '.sg-screen--achievements'))
    const toastNews = await page.evaluate(() => window.__news.slice())
    console.log(`  news on entry: ${JSON.stringify(toastNews)}`)

    // The whole wall, a screen at a time: the page is the scroller.
    const pages = await page.evaluate(() => {
      const p = document.querySelector('.sg-screen--achievements .sg-tabpanel:not([hidden])')
      return p ? Math.ceil(p.scrollHeight / Math.max(1, p.clientHeight)) : 0
    })
    for (let i = 1; i < Math.min(pages, 4); i++) {
      await page.evaluate((k) => {
        const p = document.querySelector('.sg-screen--achievements .sg-tabpanel:not([hidden])')
        if (p) p.scrollTop = p.clientHeight * k * 0.92
      }, i)
      await frames(page, 2)
      await shot(page, `${S.tag}-global-${i + 1}`)
    }

    // A detail card for each frame kind that is not a circuit's.
    await page.evaluate(() => {
      const p = document.querySelector('.sg-screen--achievements .sg-tabpanel:not([hidden])')
      if (p) p.scrollTop = 0
    })
    for (const [badge, name] of [['legendary-drifts', 'prism'], ['frontrunner', 'difficulty'],
      ['photo-finish', 'single-standin'], ['untouchable', 'locked']]) {
      await act(`.sg-screen--achievements .sgach-tile[data-badge="${badge}"]`)
      await page.waitForTimeout(300)
      await shot(page, `${S.tag}-detail-${name}`)
      const open = await page.evaluate(() => {
        const d = document.querySelector('.sg-screen--achievements .sgach__detail')
        return !!d && !d.hidden && document.activeElement?.classList.contains('sgach__close')
      })
      if (!open) note(S.tag, `detail for ${badge} did not open with focus on Close`)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(150)
      const after = await page.evaluate(() => ({
        screen: document.querySelector('.sg-fe')?.dataset.screen,
        open: !document.querySelector('.sg-screen--achievements .sgach__detail')?.hidden,
        focus: document.activeElement?.dataset?.badge ?? document.activeElement?.className,
      }))
      if (after.screen !== 'achievements' || after.open) {
        note(S.tag, `Escape on the ${badge} card left screen=${after.screen} open=${after.open}`)
      }
    }

    // TRACKS: the picker, Elkarim's eight, and a second circuit.
    await act('.sg-screen--achievements .sg-tab[data-tab="tracks"]')
    await page.waitForTimeout(300)
    await shot(page, `${S.tag}-tracks`)
    report(S.tag, 'tracks page', await measure(page, '.sg-screen--achievements'))
    await act('.sg-screen--achievements .sgach-chip[data-circuit="cryostatic"]')
    await page.waitForTimeout(250)
    await shot(page, `${S.tag}-tracks-frosthelm`)
    await act('.sg-screen--achievements .sgach-tile[data-badge="track-victory"]')
    await page.waitForTimeout(300)
    await shot(page, `${S.tag}-detail-track`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)

    // Keyboard walk: an arrow from the tab strip must reach a tile.
    if (!S.touch) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
      const back = await page.evaluate(() => document.querySelector('.sg-fe')?.dataset.screen)
      if (back !== 'title') note(S.tag, `Escape on the wall went to ${back}, not the title`)
    } else {
      await act('.sg-screen--achievements .sg-head .sg-btn')
      await page.waitForTimeout(300)
    }

    // --- IN A RACE ----------------------------------------------------------
    await page.evaluate(() => {
      const g = window.__GAME__
      g.maxSubSteps = 400
      g.startRace()
    })
    await page.waitForFunction(() => window.__GAME__?.race?.state?.phase === 'racing', null, { timeout: 180000 })
      .catch(() => note(S.tag, 'race never left the countdown'))
    await waitSim(page, 2.5)
    await page.evaluate(() => { window.__GAME__.maxSubSteps = 0 })
    // MEASURED IN THE SAME CALL THAT RAISES IT. The chip stands for 2.6 s of
    // wall clock, and at dpr 3 under SwiftShader a screenshot alone can take
    // longer than that -- the first run measured an empty HUD after
    // photographing a full one.
    const chipBox = await page.evaluate(async () => {
      window.__GAME__.badgeToasts.chip(['track-cleanlap:rustfall', 'legendary-drifts:1'])
      await new Promise((r) => requestAnimationFrame(() => r()))
      const R = (e) => {
        if (!e) return null
        // A callout at rest is laid out at opacity 0: a box, but nothing drawn.
        if (+getComputedStyle(e).opacity <= 0.02) return null
        const b = e.getBoundingClientRect()
        return b.width > 0 && b.height > 0 ? { x: b.x, y: b.y, w: b.width, h: b.height } : null
      }
      const over = (a, b) => {
        if (!a || !b) return 0
        const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
        const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        return w > 0 && h > 0 ? Math.round(w * h) : 0
      }
      // The chip's own box, WITHOUT the opacity test: it is measured one frame
      // into its 220ms entrance, where it is laid out and still nearly clear.
      const chipEl = document.querySelector('.sgach-chipToast')
      const cb = chipEl ? chipEl.getBoundingClientRect() : null
      const chip = cb && cb.width > 0 && cb.height > 0 ? { x: cb.x, y: cb.y, w: cb.width, h: cb.height } : null
      const hits = {}
      // Every readout the HUD owns that is not the lap column the chip lives in.
      // The callout block is measured by its TEXT, not its 92vw container,
      // which is an empty box across the whole top band on a phone.
      for (const sel of ['.sg-hud__map', '.sg-hud__items', '.sg-hud__band', '.sg-total', '.sg-tools',
        '.sg-hud__speed', '.sg-gauge', '.sg-hud__drift', '.sg-moment .sg-score', '.sg-moment .sg-cheer',
        '.sgtc-pad', '.sgtc-btn', '.sgtc-knob', '.sg-ctr__count', '.sg-ctr__banner', '.sg-hud__wind']) {
        for (const e of document.querySelectorAll(sel)) {
          const o = over(chip, R(e))
          if (o > 0) hits[sel] = (hits[sel] ?? 0) + o
        }
      }
      // The racing line: the middle half of the screen, from the horizon down.
      const line = { x: innerWidth * 0.25, y: innerHeight * 0.35, w: innerWidth * 0.5, h: innerHeight * 0.55 }
      const fs = chip ? parseFloat(getComputedStyle(document.querySelector('.sgach-chipToast')).fontSize) : 0
      return { chip, hits, line: over(chip, line), fs }
    })
    // And raised again for the photograph, for the same reason.
    await page.evaluate(() => {
      window.__GAME__.badgeToasts.chip(['track-cleanlap:rustfall', 'legendary-drifts:1'])
    })
    await shot(page, `${S.tag}-race-chip`)
    console.log(`  chip ${JSON.stringify(chipBox)}`)
    if (!chipBox.chip) note(S.tag, 'the chip did not render in the HUD')
    else {
      for (const [k, v] of Object.entries(chipBox.hits)) note(S.tag, `chip overlaps ${k} by ${v}px^2`)
      if (chipBox.line > 0) note(S.tag, `chip is inside the racing-line band by ${chipBox.line}px^2`)
      if (chipBox.fs < 10.95) note(S.tag, `chip text is ${chipBox.fs}px`)
    }

    // The settings dialog's Badges page, over the paused race.
    await page.evaluate(() => { window.__GAME__.openSettings('achievements') })
    // Long enough for the dialog's 180ms entrance to have finished at 4 fps:
    // the first run photographed it half faded in.
    await page.waitForTimeout(1500)
    await shot(page, `${S.tag}-panel`)
    report(S.tag, 'settings Badges page', await measure(page, '.sgset__dialog'))
    await page.evaluate(() => {
      const b = document.querySelector('.sgset__body')
      if (b) b.scrollTop = b.scrollHeight * 0.45
    })
    await frames(page, 2)
    await shot(page, `${S.tag}-panel-2`)
    await act('.sgset .sgach-tile[data-badge="knockouts"]')
    await page.waitForTimeout(300)
    await shot(page, `${S.tag}-panel-detail`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    const panel = await page.evaluate(() => ({
      open: document.querySelector('.sgset')?.classList.contains('is-open'),
      detail: !document.querySelector('.sgset .sgach__detail')?.hidden,
    }))
    if (!panel.open || panel.detail) note(S.tag, `Escape on the panel's card: dialog open=${panel.open} card open=${panel.detail}`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)

    // STAGED results: a real finishRace on a race abandoned early, then the
    // sample ids on the strip and in a toast so every size shows a full row.
    await page.evaluate((ids) => {
      const g = window.__GAME__
      g.finishRace()
      g.frontEnd.setUnlocks(ids)
    }, SAMPLE)
    await page.waitForTimeout(500)
    // Raised and measured in one call, then raised again for the photograph:
    // the toast is a 4.2 s wall-clock timer, like the chip.
    const toast = await page.evaluate(async (ids) => {
      window.__GAME__.badgeToasts.show(ids.slice(0, 3))
      await new Promise((r) => requestAnimationFrame(() => r()))
      const R = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 ? { x: b.x, y: b.y, w: b.width, h: b.height } : null }
      const over = (a, b) => {
        if (!a || !b) return 0
        const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
        const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        return w > 0 && h > 0 ? Math.round(w * h) : 0
      }
      const cards = [...document.querySelectorAll('.sgach-toast')].map(R).filter(Boolean)
      const hit = (sel) => cards.reduce((s, c) => s + over(c, R(document.querySelector(sel))), 0)
      const strip = R(document.querySelector('.sg-screen--results .sgach-strip'))
      return {
        cards: cards.length, first: cards[0] ?? null,
        overTitle: hit('.sg-results__title'), overCta: hit('.sg-results__cta'),
        overTabs: hit('.sg-screen--results .sg-tabs'), strip,
        stripVisible: !!strip && strip.y + strip.h <= innerHeight,
      }
    }, SAMPLE)
    await page.evaluate((ids) => {
      const t = window.__GAME__.badgeToasts
      t.clear()
      t.show(ids.slice(0, 3))
    }, SAMPLE)
    await shot(page, `${S.tag}-results-staged`)
    report(S.tag, 'results screen', await measure(page, '.sg-screen--results'))
    console.log(`  toast ${JSON.stringify(toast)}`)
    if (toast.cards === 0) note(S.tag, 'no toast card on the results screen')
    if (toast.overCta > 0) note(S.tag, `toast covers the results buttons by ${toast.overCta}px^2`)
    if (!toast.strip) note(S.tag, 'NEW BADGES strip missing on the results screen')

    if (errors.length) for (const e of errors.slice(0, 6)) note(S.tag, `page error: ${e}`)
    await ctx.close()
  }
}

// ===========================================================================
// RACE -- one real one, to a real results screen
// ===========================================================================
if (ONLY !== 'screens') {
  const S = SIZES[0]
  console.log(`\n=== REAL RACE, ${S.tag} ===`)
  const { ctx, page, errors } = await openPage(S)
  const before = await page.evaluate(() => window.__GAME__.ach.store.snapshot)
  await page.evaluate(() => {
    const g = window.__GAME__
    g.maxSubSteps = 900
    g.startRace()
    const st = g.race && g.race.state
    if (!st) return
    // One lap, and the AI at the player's wheel: probe-tabs.mjs argues both.
    st.totalLaps = 1
    const r = st.racers[g.localId]
    if (r) r.isAI = true
  })
  let chipShot = false
  let last = null
  for (let i = 0; i < 3000; i++) {
    last = await page.evaluate(() => {
      const g = window.__GAME__
      const st = g.race?.state
      return { p: g.phase, t: +(st?.time ?? 0).toFixed(1), chip: !!document.querySelector('.sgach-chipToast') }
    })
    if (last.chip && !chipShot) {
      chipShot = true
      await shot(page, `${S.tag}-race-chip-real`)
    }
    if (last.p === 'results') break
    if (i % 100 === 0) console.log(`  ${JSON.stringify(last)}`)
    await page.waitForTimeout(150)
  }
  await shot(page, `${S.tag}-results-real`)
  const out = await page.evaluate(() => {
    const g = window.__GAME__
    const st = g.race?.state
    const me = st?.racers?.[g.localId]
    return {
      phase: g.phase,
      finished: !!me?.finished, position: me?.position,
      news: window.__news,
      strip: [...document.querySelectorAll('.sg-screen--results .sgach-strip__item')].map((e) => e.title),
      after: g.ach.store.snapshot,
      tracking: g.ach.tracking,
    }
  })
  console.log(`  reached ${out.phase}, finished=${out.finished} P${out.position}`)
  console.log(`  news: ${JSON.stringify(out.news)}`)
  console.log(`  strip: ${JSON.stringify(out.strip)}`)
  const delta = {}
  for (const k of Object.keys(out.after.counters)) {
    const d = (out.after.counters[k] ?? 0) - (before.counters[k] ?? 0)
    if (d) delta[k] = d
  }
  console.log(`  counters moved: ${JSON.stringify(delta)}`)
  const fresh = out.after.unlocked.filter((id) => !before.unlocked.includes(id))
  console.log(`  unlocked by the race: ${JSON.stringify(fresh)}`)
  if (out.phase !== 'results') note('race', 'never reached the results screen')
  if (!out.news.some((n) => n.kind === 'chip')) note('race', 'no mid-race chip was raised by the preview')
  if (out.strip.length === 0) note('race', 'the results strip is empty after a race that crossed thresholds')
  if (!out.news.some((n) => n.kind === 'show')) note('race', 'no toast at the flag')
  if (out.tracking) note('race', 'the tracker is still watching after the flag')
  if (!delta.finishes && out.finished) note('race', 'a finished race did not count a finish')
  if (errors.length) for (const e of errors.slice(0, 6)) note('race', `page error: ${e}`)
  await ctx.close()
}

await browser.close()
server.close()
console.log(problems.length
  ? `\n${problems.length} PROBLEM(S):\n  ${problems.join('\n  ')}`
  : '\nNO PROBLEMS FOUND')
process.exit(problems.length ? 1 : 0)
