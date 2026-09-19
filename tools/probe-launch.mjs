/**
 * THE ROCKET START, PHOTOGRAPHED AND MEASURED.
 *
 * The mechanic existed for months and left no trace on screen except the boost
 * flame turning white, so nobody — including the owner of the game — knew it
 * was there. Everything this probe checks is a claim about that being fixed,
 * and every one of them is read off the DOM, the computed style or a projection
 * through the live camera rather than off a screenshot. The screenshots are for
 * a human to look at afterwards; they are not the evidence.
 *
 * WHAT IT PROVES
 *
 *   1. THREE GRADES, THREE DIFFERENT SENTENCES. The probe presses the throttle
 *      at a chosen reaction time — computed from `__TUNING__`, so a retune of
 *      the bands moves the probe with them — and reads `.sg-cheer__line`'s
 *      textContent. Three races, three distinct strings, each naming its grade.
 *   2. THE PENALTY IS NOT A THIRD FLAVOUR OF REWARD. The jump start has to
 *      differ from both rewards on channels that survive greyscale and reduced
 *      motion, so what is compared is COMPUTED STYLE: font-style, tracking,
 *      colour and the shockwave's own `--wo`. Hue alone would pass a test and
 *      fail a colourblind player.
 *   3. THE THIRD OUTCOME IS NOTHING. A racer who never opens the throttle
 *      reaches the lights with no banner, no boost and no penalty. Hesitation
 *      is not a grade, and a rule that bogged it would punish exactly the
 *      player who has not worked the mechanic out yet.
 *   4. IT IS GRID FURNITURE AND IT LEAVES. Both the banner and the hint are
 *      gone by three SIM seconds into the race — the banner shares its widget
 *      with the drift callouts, and the hint is an instruction for a window
 *      that has closed.
 *   5. THE HINT IS A FIRST-PLAY HINT. Present on a clean profile's first
 *      countdown, absent on the second race, and absent again after a reload —
 *      the stored flag, not just a variable.
 *   6. NOTHING LANDS ON THE INSTRUMENTS. The banner and the hint are
 *      intersected, in pixels, with the countdown numerals, with the round card
 *      and with the START LIGHTS — which are 3D, so their lamp instances are
 *      projected through the camera the frame was actually drawn with, the same
 *      trick probe-podium.mjs uses for the champion's head.
 *   7. AUTO-ACCELERATE IS NOT A JUMP START. With auto-accelerate on (the
 *      DEFAULT on every touch device) `sample()` holds the throttle open from
 *      the first frame of the countdown, so the sim used to grade every phone
 *      race as a start jumped by three seconds. There must be no launch event
 *      and no banner at all in that mode.
 *
 * HOW IT PRESSES THE BUTTON. `input.sample()` is wrapped in the page so the
 * throttle opens on the exact sim step where `countdown` crosses the target.
 * sample() is called once per SUB-STEP, so the reaction is exact to one frame
 * of sim time whatever the renderer is managing — which under SwiftShader is
 * about one frame a second.
 *
 * NEEDS dist/: run `npx vite build` first, or you photograph a stale bundle.
 *
 *   node tools/probe-launch.mjs [--mobile] [--landscape] [--reduced]
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

const LANDSCAPE = process.argv.includes('--landscape')
const MOBILE = LANDSCAPE || process.argv.includes('--mobile')
const REDUCED = process.argv.includes('--reduced')
const VIEWPORT = LANDSCAPE ? { width: 915, height: 412 }
  : MOBILE ? { width: 412, height: 915 } : { width: 1440, height: 810 }
const KIND = (LANDSCAPE ? 'mobilels' : MOBILE ? 'mobile' : 'desktop') + (REDUCED ? '-calm' : '')
const OUT = new URL('../shots/launch/', import.meta.url).pathname
await mkdir(OUT, { recursive: true })

const errors = []
const note = (m) => { errors.push(m); console.log('  !! ' + m) }

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

/**
 * Wait for the game, and on a touch device HAND THE THROTTLE BACK.
 *
 * Auto-accelerate is the shipped default on every touch device, and with it on
 * the rocket start does not exist: there is no GAS pad on screen, game/main.ts
 * holds the throttle shut for the whole countdown so the sim cannot mistake an
 * aid for a reaction, and the hint is deliberately not shown to a player with
 * no button to press. So a mobile run left at the default would photograph an
 * empty countdown and report seven broken claims about a feature that is
 * switched off on purpose.
 *
 * The phone case worth photographing is the one where the player turned the
 * aid off, which is also the only one where they can rocket start. PART 3 then
 * turns it back on and asserts the other half: that the default produces no
 * banner, no boost and no penalty at all.
 *
 * Re-applied on every boot because each `page.reload()` below rebuilds the
 * game from stored settings, and the touch default would come back with it.
 */
const boot = async () => {
  await page.waitForFunction(() => !!window.__GAME__, null, { timeout: 60000 })
  await page.waitForTimeout(2200)
  if (MOBILE) {
    await page.evaluate(() => { window.__GAME__.input.setAutoAccelerate(false) })
    await page.waitForTimeout(150)
  }
}
await page.goto(url, { waitUntil: 'load', timeout: 40000 })
await boot()

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

const phase = () => page.evaluate(() => {
  const g = window.__GAME__
  const st = g.race && g.race.state
  return {
    p: g.phase,
    sp: st ? st.phase : '-',
    countdown: st ? +st.countdown.toFixed(3) : -1,
    // SIM seconds since the lights, not wall seconds. Under SwiftShader a wall
    // second is about four frames, so "wait two seconds and look" would read a
    // race that has barely moved; every deadline below is priced in this.
    time: st ? +st.time.toFixed(2) : -1,
    stun: st ? +st.racers[g.localId].stunTime.toFixed(2) : -1,
    boostMag: st ? +st.racers[g.localId].boostMag.toFixed(3) : -1,
    boostSrc: st ? st.racers[g.localId].boostSource : '-',
  }
})

/** The banner, as words and as computed style. Nothing here is a screenshot. */
const readBanner = () => page.evaluate(() => {
  const root = document.querySelector('.sg-cheer')
  const line = document.querySelector('.sg-cheer__line')
  if (!root || !line) return { present: false }
  const cs = getComputedStyle(line)
  const rcs = getComputedStyle(root)
  const b = line.getBoundingClientRect()
  return {
    present: true,
    hidden: root.hidden,
    text: line.textContent || '',
    w: root.dataset.w,
    bad: root.dataset.bad,
    fontStyle: cs.fontStyle,
    tracking: cs.letterSpacing,
    color: cs.color,
    // The shockwave's peak opacity. 0 means the reward bloom is switched off,
    // which is half of what makes the penalty a penalty.
    wo: rcs.getPropertyValue('--wo').trim(),
    opacity: +rcs.opacity,
    box: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
  }
})

const readHint = () => page.evaluate(() => {
  const el = document.querySelector('.sg-ctr__hint')
  if (!el) return { present: false }
  const cs = getComputedStyle(el)
  const b = el.getBoundingClientRect()
  return {
    present: true,
    hidden: el.hidden,
    text: el.textContent || '',
    display: cs.display,
    opacity: +cs.opacity,
    box: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
  }
})

/**
 * The corner instruments, in screen pixels.
 *
 * THE BANNER FIRES AT A DIFFERENT MOMENT FROM EVERY OTHER CALLOUT, and that is
 * why this is measured at all. The rest of the widget's lines land mid-race, in
 * a frame where the player is looking at the road and the corners are
 * peripheral. This one lands on the GRID, in the one frame of the race the
 * player is reading rather than driving, and the longest of the three grades is
 * the one that most needs to be read.
 *
 * The position block and the minimap's clock are what sit at that height. Both
 * are HUD, both are in a corner, and on a narrow portrait screen the callout
 * band and the minimap's own readout are at nearly the same height.
 */
const readCorners = () => page.evaluate(() => {
  const out = []
  for (const sel of ['.sg-hud__pos', '.sg-map__meta', '.sg-hud__map']) {
    const el = document.querySelector(sel)
    if (!el) continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) continue
    const b = el.getBoundingClientRect()
    if (b.width < 1 || b.height < 1) continue
    out.push({
      name: sel.replace('.sg-hud__', '').replace('.sg-map__', 'map '),
      box: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
    })
  }
  return out
})

/**
 * The touch pads that are actually drawn, in screen pixels.
 *
 * Only the visible ones: `.sgtc-gas` is `display:none` until auto-accelerate is
 * off, which is exactly the state this probe puts a phone in, so reading it
 * unconditionally would measure a box of zeros and prove nothing.
 */
const readPads = () => page.evaluate(() => {
  const out = []
  for (const sel of [
    '.sgtc-gas', '.sgtc-brake', '.sgtc-drift', '.sgtc-item',
    // THE BOTTOM INSTRUMENT BAND. styles.css places the hint by subtracting
    // this band's height from the bottom of the frame and says the number was
    // measured here rather than guessed -- so it has to actually be measured
    // here, or the comment is a promise the probe does not keep.
    '.sg-hud__band',
  ]) {
    const el = document.querySelector(sel)
    if (!el) continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || +cs.opacity < 0.05) continue
    const b = el.getBoundingClientRect()
    if (b.width < 1 || b.height < 1) continue
    out.push({
      name: sel.replace('.sgtc-', '').replace('.sg-hud__', ''),
      box: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
    })
  }
  return out
})

const readCount = () => page.evaluate(() => {
  const el = document.querySelector('.sg-ctr__count')
  if (!el) return { present: false }
  const b = el.getBoundingClientRect()
  return {
    present: true,
    hidden: el.hidden,
    text: el.textContent || '',
    box: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
    viewW: window.innerWidth,
    viewH: window.innerHeight,
  }
})

/**
 * THE START LIGHTS, IN SCREEN PIXELS.
 *
 * They are instanced 3D geometry on the gantry, so there is no DOM box to read
 * and no honest way to guess where they are: on a banked or climbing circuit
 * "up the track" is not a fixed part of the frame. Every lamp instance's
 * translation is projected through the camera's own two matrices — the ones the
 * frame was actually drawn with — and the union of the points is the box. Done
 * by hand with matrixWorldInverse and projectionMatrix so the probe needs no
 * three.js import of its own, exactly as probe-podium.mjs does for the
 * champion's head.
 */
const readLamps = () => page.evaluate(() => {
  const g = window.__GAME__
  const mesh = g.entityVis && g.entityVis.lampGlow
  if (!mesh || !mesh.instanceMatrix) return null
  const cam = g.chase.camera
  cam.updateMatrixWorld()
  const vm = cam.matrixWorldInverse.elements
  const pm = cam.projectionMatrix.elements
  const mul = (m, x, y, z, w) => [
    m[0] * x + m[4] * y + m[8] * z + m[12] * w,
    m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
    m[3] * x + m[7] * y + m[11] * z + m[15] * w,
  ]
  const a = mesh.instanceMatrix.array
  const W = window.innerWidth, H = window.innerHeight
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, seen = 0
  for (let i = 0; i < mesh.count; i++) {
    const o = i * 16
    const v = mul(vm, a[o + 12], a[o + 13], a[o + 14], 1)
    const c = mul(pm, v[0], v[1], v[2], v[3])
    if (!(c[3] > 1e-6)) continue
    const px = ((c[0] / c[3]) + 1) * 0.5 * W
    const py = (1 - (c[1] / c[3])) * 0.5 * H
    // Only the gate that is actually in front of the camera and on screen.
    if (px < -W || px > 2 * W || py < -H || py > 2 * H) continue
    seen++
    if (px < x0) x0 = px
    if (py < y0) y0 = py
    if (px > x1) x1 = px
    if (py > y1) y1 = py
  }
  if (!seen) return null
  // A lamp is a glow quad about 0.5m across; pad the point cloud so the box is
  // the lit area rather than a set of centres.
  const pad = 14
  return {
    lamps: seen,
    x: Math.round(x0) - pad,
    y: Math.round(y0) - pad,
    w: Math.round(x1 - x0) + pad * 2,
    h: Math.round(y1 - y0) + pad * 2,
  }
})

/** Overlap of two {x,y,w,h} boxes, in square pixels. */
const hit = (a, b) => (a && b)
  ? Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  : 0

const shoot = async (tag) => {
  await page.screenshot({ path: join(OUT, `${KIND}-${tag}.png`) })
  return `${KIND}-${tag}.png`
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

/** The tuning the bands are actually made of; never hard-coded here. */
const T = await page.evaluate(() => {
  const t = window.__TUNING__
  return {
    goLead: t.race.goLead,
    countdown: t.race.countdown,
    perfect: t.boost.launchPerfect,
    good: t.boost.launchGood,
    grace: t.boost.launchJumpGrace,
    bog: t.boost.bogTime,
    perfectTier: t.boost.launchPerfectTier,
    goodTier: t.boost.launchGoodTier,
    tierBoost: t.drift.tierBoost,
  }
})
console.log(`\n=== ${KIND} ===`)
console.log(`  bands: green at countdown ${T.goLead}s, PERFECT <= ${T.perfect}s reaction,`
  + ` GOOD <= ${T.good}s, jump earlier than -${T.grace}s, bog ${T.bog}s`)

/**
 * Open the throttle when `countdown` crosses `at`, and hold it shut until then.
 *
 * Wrapping sample() rather than sending keys is the only way to place a press
 * on a chosen SIM STEP: the renderer here delivers about one frame a second, so
 * a keydown lands wherever the countdown happens to be by the time it arrives —
 * which is a different grade every run and a probe that measures nothing.
 */
const armLaunch = (at) => page.evaluate((t) => {
  const g = window.__GAME__
  if (!g.__origSample) g.__origSample = g.input.sample.bind(g.input)
  g.__launchAt = t
  g.input.sample = () => {
    const f = g.__origSample()
    const st = g.race && g.race.state
    if (st && st.phase === 'countdown') {
      f.throttle = (g.__launchAt !== null && st.countdown <= g.__launchAt) ? 1 : 0
    }
    return f
  }
}, at)

/** Start a race and wait until the sim is actually counting down. */
async function startRace() {
  await page.evaluate(() => {
    const g = window.__GAME__
    // Left at the shipped value on purpose. A big sub-step budget would run the
    // whole countdown inside one render frame, and the thing being measured is
    // a reaction priced in sim steps.
    g.startRace()
  })
  for (let i = 0; i < 40; i++) {
    const p = await phase()
    if (p.p === 'racing' && p.sp === 'countdown') return p
    await page.waitForTimeout(250)
  }
  note('the race never reached its countdown')
  return null
}

/** Poll until the sim leaves the countdown, or give up. */
async function waitForGreen(capMs = 120000) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < capMs) {
    last = await phase()
    if (last.sp !== 'countdown') return last
    await page.waitForTimeout(220)
  }
  note('the countdown never ended')
  return last
}

/**
 * Drive one graded start and report everything measurable about it.
 *
 * The banner is sampled on the first frame it is up rather than at a fixed
 * delay: it holds for 1.5s of HUD time and this renderer takes about a second
 * per frame, so "wait two seconds then look" reads a different part of the
 * animation on every run.
 */
async function runGrade(tag, reaction) {
  const at = +(T.goLead - reaction).toFixed(4)
  console.log(`\n--- ${tag}: press at reaction ${reaction >= 0 ? '+' : ''}${reaction}s `
    + `(countdown ${at.toFixed(2)}s) ---`)
  await armLaunch(at)
  await startRace()

  let banner = null
  let atCountdown = -1
  let lamps = null
  let count = null
  let corners = []
  let shotName = null
  // Watch the countdown out, grabbing the banner the first frame it is visible.
  const t0 = Date.now()
  while (Date.now() - t0 < 150000) {
    const p = await phase()
    const b = await readBanner()
    if (b.present && !b.hidden && b.text && !banner) {
      banner = b
      atCountdown = p.countdown
      count = await readCount()
      lamps = await readLamps()
      corners = await readCorners()
      shotName = await shoot(tag)
    }
    if (p.sp !== 'countdown' && banner) break
    if (p.sp !== 'countdown' && Date.now() - t0 > 6000) break
    await page.waitForTimeout(200)
  }
  const after = await phase()
  if (!banner) {
    note(`${tag}: no banner ever went up`)
    return { banner: null, after }
  }
  console.log(`  text                : "${banner.text}"`)
  console.log(`  up at countdown     : ${atCountdown.toFixed(2)}s  (rung w=${banner.w}, bad=${banner.bad})`)
  console.log(`  style               : ${banner.fontStyle}, tracking ${banner.tracking},`
    + ` ${banner.color}, --wo ${banner.wo || '(unset)'}`)
  console.log(`  sim after the lights: stun ${after.stun}s, boost ${after.boostMag} from "${after.boostSrc}"`)
  console.log(`  shot                : ${shotName}`)
  // EVERY grade, not just the one PART 2 photographs: the three lines are
  // different lengths and the widest of them is the penalty, so checking only
  // the tidy one would miss the only case that can actually collide.
  //
  // MEASURED AND PRINTED, NOT ASSERTED, and the control experiment below says
  // why: this band belongs to the callout widget, every line it has ever shown
  // sits in it, and the widest of those is wider than anything here. Failing
  // the launch for it would be blaming this feature for the geometry it
  // inherited. What IS asserted is everything on the grid -- the numerals, the
  // lamps, the hint, the pads -- because those are the things this feature put
  // on screen or chose a place for.
  for (const c of corners) {
    const px = hit(banner.box, c.box)
    if (px > 0) console.log(`  banner x ${c.name}`.padEnd(30) + `= ${px} px2  ${JSON.stringify(c.box)}`)
  }
  // ...AND IT IS OVER THE MIDDLE OF THE SCREEN.
  //
  // Worth its own check because nothing else here would notice. The widget is
  // centred by its container, so the number is not interesting until some rule
  // quietly re-positions the element -- which is exactly what a stale
  // `transform: translate(-50%, -50%)` in the reduced-motion block was doing,
  // putting every callout half its own width to the left for anyone racing
  // with reduced motion on. Every other measurement in this probe passed
  // through that, because a line that is off-centre still clears the numerals
  // and still says the right words.
  if (count && count.viewW) {
    const off = Math.round((banner.box.x + banner.box.w / 2) - count.viewW / 2)
    console.log(`  off centre          : ${off > 0 ? '+' : ''}${off}px`)
    if (Math.abs(off) > 12) {
      note(`${tag}: the banner is ${Math.abs(off)}px ${off < 0 ? 'left' : 'right'} of centre`)
    }
  }
  return { banner, after, count, lamps, corners, atCountdown }
}

/** Every string this feature is allowed to put on screen. */
const LAUNCH_WORDS = /PERFECT START|GOOD START|JUMP START/i

/**
 * THE GRID FURNITURE IS GONE ONCE THE RACE IS A RACE.
 *
 * Both things this feature draws are grid furniture: the hint is an
 * instruction for a window that has closed, and the banner names a thing that
 * happened before the lights. Neither has any business over a racing line, and
 * the banner in particular is a CHEER -- it shares one widget with the drift
 * callouts, so a launch line that overstayed would be sitting in the slot the
 * first drift of the race wants about a second and a half later.
 *
 * Deliberately asserted in SIM seconds SINCE THE LIGHTS rather than at a fixed
 * wall delay: the hold is 1.5s of HUD time and the cheer's fade runs on top of
 * it, so the honest question is "is it gone by the time the player is driving",
 * and the first corner on this grid arrives well before `until`.
 *
 * MEASURED FROM A ZERO THIS FUNCTION TAKES ITSELF, because `state.time` is the
 * race clock and it runs through the COUNTDOWN as well -- it already reads
 * about 3.6s on the frame the lights go green. Testing it against a constant
 * therefore fired the moment the countdown ended, which is not "once the race
 * is live", it is the opposite, and it duly reported a banner that had been on
 * screen for less than half a second as having overstayed.
 *
 * ONE ASYMMETRY, STATED. The HUD and the cheer are advanced by the RENDER dt
 * (capped at 0.25s) while the sim advances at most `maxSubSteps`/60 = 0.083s
 * per frame, so under SwiftShader the widget's clock runs about three times
 * faster than the race's. That makes this check looser here than it would be
 * at 60fps, where the two clocks agree. It still catches the failure worth
 * catching -- something that never clears at all -- and the exact hold is the
 * cheer's own and is pinned in TUNING, not here.
 */
async function assertClearOnceLive(tag, until = 3.0) {
  let last = null
  let green = -1
  const t0 = Date.now()
  while (Date.now() - t0 < 240000) {
    last = await phase()
    if (last.sp !== 'countdown') {
      if (green < 0) green = last.time
      if (last.time - green >= until) break
    }
    await page.waitForTimeout(220)
  }
  if (!last || green < 0 || last.time - green < until) {
    note(`${tag}: never got ${until}s into the race to check the screen was clear`)
    return
  }
  const b = await readBanner()
  const h = await readHint()
  const bannerUp = b.present && !b.hidden && b.opacity > 0.02 && LAUNCH_WORDS.test(b.text || '')
  const hintOn = h.present && !h.hidden && h.display !== 'none' && h.opacity > 0.05
  console.log(`  ${tag}: ${(last.time - green).toFixed(2)}s after the lights — `
    + `launch banner ${bannerUp ? `STILL UP ("${b.text}")` : 'gone'}, `
    + `hint ${hintOn ? 'STILL UP' : 'gone'}`)
  if (bannerUp) note(`${tag}: the launch banner is still on screen ${until}s into the race`)
  if (hintOn) note(`${tag}: the rocket-start hint is still on screen ${until}s into the race`)
}

// ===========================================================================
// PART 1 — the three grades
// ===========================================================================

// A clean profile: the hint has to be able to fire on the very first race.
await page.evaluate(() => {
  try { localStorage.clear() } catch { /* blocked */ }
})
await page.reload({ waitUntil: 'load' })
await boot()

// The first race is also the hint's one showing, so it is measured here.
const perfect = await runGrade('perfect', Math.max(0, T.perfect * 0.4))
const hintFirst = await readHint()
console.log(`  hint on race 1      : ${hintFirst.present && !hintFirst.hidden ? `"${hintFirst.text}"` : 'ABSENT'}`
  + (hintFirst.present ? `  display ${hintFirst.display}` : ''))
// ...and both of them are off the screen by the time there is a race under it.
await assertClearOnceLive('after a perfect start')

const good = await runGrade('good', (T.perfect + T.good) / 2)
const hintSecond = await readHint()
console.log(`  hint on race 2      : ${hintSecond.present && !hintSecond.hidden ? `"${hintSecond.text}"` : 'ABSENT'}`)

const jump = await runGrade('jump', -(T.grace + 0.35))
// The penalty line matters most here: it is the one that would be sitting over
// a racing line while the player is trying to recover from the stun it names.
await assertClearOnceLive('after a jump start')

// ===========================================================================
// PART 1b — a racer who never opens the throttle
// ===========================================================================
//
// THE THIRD OUTCOME IS "NOTHING", AND IT HAS TO STAY NOTHING. sim/race.ts
// resolves a start only on the frame a racer first applies throttle, so a
// player who sits still through the whole countdown should reach the lights
// with no grade, no boost and -- this is the half worth guarding -- no
// penalty. A grading rule that defaulted to the bog would punish hesitation,
// which is the precise failure this whole change exists to remove, and it
// would do it to the player least likely to understand why.
//
// Distinct from the auto-accelerate case in PART 3: that one is about an input
// aid pressing the button on the player's behalf. This one is a human with a
// working GAS pad choosing not to touch it.
console.log('\n--- a racer who never presses ---')
{
  await armLaunch(null)
  await startRace()
  let banner = null
  const t0 = Date.now()
  while (Date.now() - t0 < 180000) {
    const p = await phase()
    const b = await readBanner()
    if (b.present && !b.hidden && b.text && LAUNCH_WORDS.test(b.text)) { banner = b; break }
    if (p.sp !== 'countdown') break
    await page.waitForTimeout(200)
  }
  const after = await phase()
  console.log(`  banner              : ${banner ? `"${banner.text}"` : 'none'}`)
  console.log(`  sim after the lights: stun ${after.stun}s, boost ${after.boostMag} from "${after.boostSrc}"`)
  await shoot('nopress')
  if (banner) note(`a racer who never pressed was given "${banner.text}"`)
  if (after.stun > 0) note(`a racer who never pressed was bogged for ${after.stun}s`)
  if (after.boostMag > 0) note(`a racer who never pressed was given a boost of ${after.boostMag}`)
  await waitForGreen()
}

// --- 1. three different sentences, each naming its grade -------------------
console.log('\n--- the three lines ---')
const texts = {
  perfect: perfect.banner ? perfect.banner.text : '',
  good: good.banner ? good.banner.text : '',
  jump: jump.banner ? jump.banner.text : '',
}
for (const k of ['perfect', 'good', 'jump']) console.log(`  ${k.padEnd(8)}: "${texts[k]}"`)
const seen = new Set(Object.values(texts).filter(Boolean))
if (seen.size !== 3) note(`the three grades produced ${seen.size} distinct line(s), not 3`)
if (texts.perfect && !/PERFECT/i.test(texts.perfect)) note('the perfect start does not say so')
if (texts.good && !/GOOD/i.test(texts.good)) note('the good start does not say so')
if (texts.jump && !/JUMP/i.test(texts.jump)) note('the jump start does not say so')
// A punishment the player cannot connect to the car not moving is the bug this
// work exists to fix, so the words have to name the cost too.
if (texts.jump && !/BOG/i.test(texts.jump)) note('the jump start never names the penalty it just took')

// --- and the SIM agreed with the words -------------------------------------
if (perfect.after && perfect.after.boostMag <= 0) note('the perfect start banked no boost')
if (good.after && good.after.boostMag <= 0) note('the good start banked no boost')
if (perfect.after && good.after && !(perfect.after.boostMag > good.after.boostMag)) {
  note(`PERFECT (${perfect.after.boostMag}) is not worth more than GOOD (${good.after.boostMag})`)
}
if (jump.after && jump.after.boostMag > 0) note('the jump start banked a boost')

// --- 2. the penalty is not a third reward ----------------------------------
console.log('\n--- penalty vs reward, on channels that survive greyscale ---')
if (perfect.banner && good.banner && jump.banner) {
  const rows = [['perfect', perfect.banner], ['good', good.banner], ['jump', jump.banner]]
  for (const [k, b] of rows) {
    console.log(`  ${k.padEnd(8)} style ${b.fontStyle.padEnd(7)} tracking ${String(b.tracking).padEnd(8)}`
      + ` colour ${b.color.padEnd(20)} --wo ${b.wo || '0'}  bad=${b.bad}`)
  }
  if (jump.banner.bad !== '1') note('the jump start is not flagged as a penalty')
  if (perfect.banner.bad !== '0' || good.banner.bad !== '0') {
    note('a reward is flagged as a penalty')
  }
  // Channel by channel, against BOTH rewards.
  for (const [k, b] of rows.slice(0, 2)) {
    if (jump.banner.fontStyle === b.fontStyle) {
      note(`the jump start is the same font-style as ${k} (${b.fontStyle}) — greyscale cannot tell them apart`)
    }
    if (jump.banner.color === b.color) note(`the jump start is the same colour as ${k}`)
  }
  const wo = (v) => (v === '' ? 0 : parseFloat(v) || 0)
  if (wo(jump.banner.wo) !== 0) note(`the jump start still blooms a shockwave (--wo ${jump.banner.wo})`)
  if (wo(perfect.banner.wo) <= 0) note('the perfect start lost its shockwave')
}

// --- 3. the first-play hint -------------------------------------------------
console.log('\n--- the first-play hint ---')
const hintUp = (h) => h.present && !h.hidden && h.display !== 'none' && h.opacity > 0.05
console.log(`  race 1 : ${hintUp(hintFirst) ? 'shown' : 'absent'}   race 2 : ${hintUp(hintSecond) ? 'shown' : 'absent'}`)
// The short-viewport rule takes it away on purpose; say so rather than failing.
const tooShort = VIEWPORT.height <= 380
if (!hintUp(hintFirst) && !tooShort) note('the first race of a clean profile showed no rocket-start hint')
if (hintUp(hintSecond)) note('the hint came back on the second race')
if (hintFirst.present && hintFirst.text && !/ROCKET START/i.test(hintFirst.text)) {
  note(`the hint never names the mechanic: "${hintFirst.text}"`)
}
{
  // ...and it is the STORED flag, not a variable that a reload would reset.
  const flag = await page.evaluate(() => {
    try { return localStorage.getItem('sg.seenStart') } catch { return 'blocked' }
  })
  console.log(`  stored flag         : ${JSON.stringify(flag)}`)
  if (flag !== '1') note('the hint did not record that it had been shown')
  await page.reload({ waitUntil: 'load' })
  await boot()
  await armLaunch(null)
  await startRace()
  await page.waitForTimeout(1500)
  const afterReload = await readHint()
  console.log(`  after a reload      : ${hintUp(afterReload) ? 'SHOWN AGAIN' : 'absent'}`)
  if (hintUp(afterReload)) note('the hint came back after a reload — the flag is not being read')
  await shoot('hint-gone')
  await waitForGreen()
}

// ===========================================================================
// PART 2 — nothing lands on the instruments
// ===========================================================================
console.log('\n--- what the words are sitting on ---')
{
  // One more clean-profile countdown, so the hint, the banner, the numerals and
  // the lamps are all on screen in the SAME frame and can be intersected.
  await page.evaluate(() => { try { localStorage.clear() } catch { /* blocked */ } })
  await page.reload({ waitUntil: 'load' })
  await boot()
  await armLaunch(+(T.goLead - Math.max(0, T.perfect * 0.4)).toFixed(4))
  await startRace()

  let frame = null
  const t0 = Date.now()
  while (Date.now() - t0 < 150000) {
    const p = await phase()
    const b = await readBanner()
    if (b.present && !b.hidden && b.text) {
      frame = {
        banner: b,
        hint: await readHint(),
        count: await readCount(),
        lamps: await readLamps(),
        pads: await readPads(),
      }
      await shoot('together')
      break
    }
    if (p.sp !== 'countdown') break
    await page.waitForTimeout(180)
  }
  if (!frame) {
    note('could not get the banner and the countdown into one frame to measure them')
  } else {
    const { banner, hint, count, lamps, pads } = frame
    console.log(`  viewport            : ${count.viewW}x${count.viewH}`)
    console.log(`  banner "${banner.text}" ${JSON.stringify(banner.box)}`)
    console.log(`  numerals "${count.text}"  ${JSON.stringify(count.box)}  hidden=${count.hidden}`)
    console.log(`  hint                : ${hintUp(hint) ? JSON.stringify(hint.box) : 'not on screen'}`)
    console.log(`  start lights        : ${lamps ? `${lamps.lamps} lamps ${JSON.stringify(lamps)}` : 'not in frame'}`)
    for (const p of pads) console.log(`  ${p.name === 'band' ? 'instrument band' : `touch pad ${p.name}`}`.padEnd(22) + `: ${JSON.stringify(p.box)}`)

    const pairs = [
      ['banner', banner.box, 'numerals', count.hidden ? null : count.box],
      ['hint', hintUp(hint) ? hint.box : null, 'numerals', count.hidden ? null : count.box],
      ['banner', banner.box, 'start lights', lamps],
      ['hint', hintUp(hint) ? hint.box : null, 'start lights', lamps],
      ['banner', banner.box, 'hint', hintUp(hint) ? hint.box : null],
      // THE PAD THE HINT IS TALKING ABOUT. On a phone the instruction names a
      // control that is on the same screen, a couple of centimetres below it,
      // and a line of type sitting ON the GAS pad would be both unreadable and
      // an invitation to press the words.
      ...pads.map((p) => [
        'hint', hintUp(hint) ? hint.box : null,
        p.name === 'band' ? 'the instrument band' : `the ${p.name} pad`, p.box,
      ]),
    ]
    for (const [an, a, bn, b] of pairs) {
      if (!a || !b) continue
      const px = hit(a, b)
      console.log(`  ${an} x ${bn}`.padEnd(30) + `= ${px} px2`)
      if (px > 0) note(`the ${an} overlaps the ${bn} by ${px} px2`)
    }
    // The round card is single-race-empty, but check it anyway: in circuit mode
    // it is the other thing in this stack, and it is the one the hint could
    // grow into if either placement moved.
    const round = await page.evaluate(() => {
      const el = document.querySelector('.sg-ctr__round')
      if (!el || el.hidden) return null
      const b = el.getBoundingClientRect()
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
    })
    if (round && hintUp(hint)) {
      const px = hit(hint.box, round)
      console.log(`  hint x round card`.padEnd(30) + `= ${px} px2`)
      if (px > 0) note(`the hint overlaps the round card by ${px} px2`)
    }
    // ...and everything stays inside the frame.
    for (const [n, b] of [['banner', banner.box], ['hint', hintUp(hint) ? hint.box : null]]) {
      if (!b) continue
      if (b.x < 0 || b.y < 0 || b.x + b.w > count.viewW || b.y + b.h > count.viewH) {
        note(`the ${n} is not fully on screen: ${JSON.stringify(b)} in ${count.viewW}x${count.viewH}`)
      }
    }
  }
  await waitForGreen()
}

// ===========================================================================
// PART 2b — whose band is this? A control, not an assertion
// ===========================================================================
//
// On a narrow portrait phone the callout line reaches the minimap's clock, and
// the question that decides whether it is this feature's bug is whether the
// lines that were already there reach it too. So the SAME element is measured
// with a string this work did not write -- the longest in ui/cheer.ts, at the
// rung a drift cash-in says it at -- and the two widths are printed together.
//
// Layout only: textContent and data-w are set, the box is read, and both are
// put straight back. Nothing is said, no cooldown is spent and the widget is
// not running, so this cannot disturb anything measured above.
console.log('\n--- whose band is this? (control) ---')
{
  const rows = await page.evaluate(() => {
    const root = document.querySelector('.sg-cheer')
    const line = document.querySelector('.sg-cheer__line')
    const meta = document.querySelector('.sg-map__meta')
    if (!root || !line || !meta) return null
    const wasText = line.textContent
    const wasW = root.dataset.w
    const wasHidden = root.hidden
    root.hidden = false
    const m = meta.getBoundingClientRect()
    const probe = (text, w) => {
      line.textContent = text
      root.dataset.w = String(w)
      const b = line.getBoundingClientRect()
      return {
        text,
        w,
        width: Math.round(b.width),
        // Horizontal overlap with the clock chip, which is the readout the
        // words actually run into.
        into: Math.round(Math.max(0, Math.min(b.right, m.right) - Math.max(b.left, m.left))),
      }
    }
    const out = [
      // This work's lines...
      probe('PERFECT START', 2),
      probe('JUMP START — BOGGED', 1),
      // ...and the widest line the widget already had, at the cash rung.
      probe('FULL CHARGE, FULL EXIT', 3),
      probe('LINKED — KEEP GOING', 3),
    ]
    line.textContent = wasText
    if (wasW === undefined) delete root.dataset.w; else root.dataset.w = wasW
    root.hidden = wasHidden
    return out
  })
  if (!rows) {
    console.log('  (widget not in the DOM to measure)')
  } else {
    for (const r of rows) {
      console.log(`  w=${r.w} ${String(r.width).padStart(4)}px  into the clock ${String(r.into).padStart(3)}px  "${r.text}"`)
    }
    const mine = Math.max(...rows.slice(0, 2).map((r) => r.into))
    const theirs = Math.max(...rows.slice(2).map((r) => r.into))
    console.log(`  worst of this feature's lines: ${mine}px   worst of the lines already here: ${theirs}px`)
    if (mine > theirs) {
      note(`this feature's words reach ${mine}px into the clock, further than the ${theirs}px`
        + ' the widget already put there — the band is not the excuse')
    }
  }
}

// ===========================================================================
// PART 3 — auto-accelerate must not read as a jump start
// ===========================================================================
console.log('\n--- auto-accelerate on the grid ---')
{
  await page.evaluate(() => {
    const g = window.__GAME__
    // Hand the throttle back to the game entirely, then turn on the aid that
    // holds it open. This is the shipped default on every touch device.
    if (g.__origSample) { g.input.sample = g.__origSample; g.__origSample = null }
    g.input.setAutoAccelerate(true)
  })
  await startRace()
  const hintAuto = await readHint()
  let banner = null
  const t0 = Date.now()
  while (Date.now() - t0 < 150000) {
    const p = await phase()
    const b = await readBanner()
    if (b.present && !b.hidden && b.text) { banner = b; break }
    if (p.sp !== 'countdown') break
    await page.waitForTimeout(200)
  }
  const after = await phase()
  await shoot('autoaccel')
  console.log(`  banner              : ${banner ? `"${banner.text}"` : 'none'}`)
  console.log(`  hint                : ${hintUp(hintAuto) ? 'shown' : 'absent'}`)
  console.log(`  sim after the lights: stun ${after.stun}s, boost ${after.boostMag} from "${after.boostSrc}"`)
  if (banner) note(`auto-accelerate produced a "${banner.text}" the player never pressed for`)
  if (after.stun > 0) note(`auto-accelerate bogged the car for ${after.stun}s off the line`)
  if (hintUp(hintAuto)) note('the hint is shown to a player whose GAS pad is not on screen')
  await page.evaluate(() => { window.__GAME__.input.setAutoAccelerate(false) })
}

// ---------------------------------------------------------------------------
console.log('')
if (errors.length) {
  console.log(`LAUNCH PROBE: ${errors.length} problem(s)`)
  for (const e of errors) console.log('  - ' + e)
} else {
  console.log('LAUNCH PROBE: clean')
}
await browser.close()
server.close()
process.exit(errors.length ? 1 : 0)
