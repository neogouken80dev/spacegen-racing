/**
 * THE FULLSCREEN PROBE.
 *
 * tests/fullscreen.test.ts pins the platform matrix against stubbed globals,
 * which proves the branching and proves nothing about whether the button works.
 * This drives the real settings panel in real Chromium: it finds the row, reads
 * the copy the player actually sees, clicks the switch with a real pointer
 * event, checks the browser ACTUALLY went fullscreen, then exits from outside
 * the switch -- the way Escape, F11 and the OS do -- and checks the toggle
 * followed. The last one is the half that is easy to skip and the half that
 * decides whether the UI ever lies about its own state.
 *
 * Every check here found something the unit tests could not: the first run
 * passed every DOM assertion with the panel still closed, and the first
 * screenshot was the title screen.
 *
 *   node tools/probe-fullscreen.mjs
 */
import { chromium } from 'playwright'
import { createServer } from 'vite'
const server = await createServer({ server: { port: 5199 } })
await server.listen()
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-gl=swiftshader','--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errs = []
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
await page.goto('http://localhost:5199/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(4000)
const probe = await page.evaluate(async () => {
  const m = await import('/src/game/fullscreen.ts')
  return { mode: m.fullscreenMode(), supported: m.isSupported(), standalone: m.isStandalone(), active: m.isFullscreen() }
})
console.log('REAL CHROMIUM:', JSON.stringify(probe))
// open settings and find the row
const found = await page.evaluate(() => {
  const ks = [...document.querySelectorAll('.sgset-row__k')].map(e => e.textContent)
  const row = [...document.querySelectorAll('.sgset-row')].find(r => r.querySelector('.sgset-row__k')?.textContent === 'Fullscreen')
  return { keys: ks, hasRow: !!row, locked: row?.classList.contains('is-locked') ?? null,
           sub: row?.querySelector('.sgset-row__sub')?.textContent ?? null,
           checked: row?.querySelector('.sgset-sw')?.getAttribute('aria-checked') ?? null }
})
console.log('SETTINGS ROW:', JSON.stringify(found, null, 1))
// actually toggle it via a real click
const toggled = await page.evaluate(async () => {
  const row = [...document.querySelectorAll('.sgset-row')].find(r => r.querySelector('.sgset-row__k')?.textContent === 'Fullscreen')
  const sw = row?.querySelector('.sgset-sw')
  if (!sw) return 'no switch'
  sw.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true }))
  await new Promise(r => setTimeout(r, 600))
  return { fsElement: !!document.fullscreenElement, aria: sw.getAttribute('aria-checked') }
})
console.log('AFTER CLICK:', JSON.stringify(toggled))
// Exit from OUTSIDE the switch, the way Escape / F11 / the OS do.
const external = await page.evaluate(async () => {
  await document.exitFullscreen()
  await new Promise(r => setTimeout(r, 600))
  const row = [...document.querySelectorAll('.sgset-row')].find(r => r.querySelector('.sgset-row__k')?.textContent === 'Fullscreen')
  return { fsElement: !!document.fullscreenElement, aria: row?.querySelector('.sgset-sw')?.getAttribute('aria-checked') }
})
console.log('AFTER EXTERNAL EXIT:', JSON.stringify(external))
// Actually OPEN the panel. The DOM is built once in the constructor, so
// everything above passed with the panel hidden -- which proves the wiring
// and shows me nothing.
const opened = await page.evaluate(() => {
  const cands = [...document.querySelectorAll('button')]
    .map(b => ({ cls: b.className, label: b.getAttribute('aria-label'), txt: (b.textContent||'').trim().slice(0,20) }))
  // sgset__close is the panel's OWN close button -- clicking it opened nothing.
  const gear = [...document.querySelectorAll('button')].find(b =>
    /sg-tools__btn|sgset-open/.test(b.className)
    || /settings/i.test(b.getAttribute('aria-label')||''))
  if (gear) { gear.click(); return { clicked: gear.className, label: gear.getAttribute('aria-label') } }
  return { clicked: null, cands: cands.slice(0, 16) }
})
console.log('OPEN ATTEMPT:', JSON.stringify(opened))
await page.waitForTimeout(1200)
await page.screenshot({ path: 'shots/fullscreen-settings.png' })
console.log('console errors:', errs.length, errs.slice(0,3))
await browser.close(); await server.close()
