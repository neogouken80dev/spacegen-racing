/**
 * STATIC CHECKS ON styles.css.
 *
 * These exist because of one bug that cost several commits' worth of CSS.
 *
 * `font: 800 clamp(34px, 6.6vw, 64px)/1 inherit` looks reasonable and is
 * INVALID: a CSS-wide keyword (`inherit`, `initial`, `unset`, `revert`) may
 * only be the ENTIRE value of a declaration, never one component of a
 * shorthand. The parser therefore discards the whole declaration -- silently,
 * with no console warning and no visual error. Eighteen of them accumulated
 * across the score HUD, the results screen, the boards, the records and the
 * tabs, and every one of those elements rendered at the inherited 16px/400 UI
 * default instead of the sizes and weights written here.
 *
 * It survived review for the reason this kind of bug always survives: 16px
 * text is perfectly legible, so the screenshots looked merely a bit
 * understated rather than broken.
 *
 * `tools/probe-css.mjs` is the thorough version -- it feeds every declaration
 * in the file to a real parser and fails on anything discarded. It needs a
 * browser, so it is not in `npm test`. This is the browser-free pin for the
 * specific mistake, and it runs on every commit.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CSS = readFileSync(resolve(__dirname, '../src/ui/styles.css'), 'utf8')

/** Blank out comments without moving any line numbers. */
const CLEAN = CSS.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
const LINES = CLEAN.split('\n')

const WIDE = /\b(inherit|initial|unset|revert|revert-layer)\b/

/** Shorthands whose value is a list of components, so a CSS-wide keyword in one slot kills it. */
const SHORTHANDS = [
  'font', 'background', 'border', 'border-top', 'border-right', 'border-bottom',
  'border-left', 'margin', 'padding', 'flex', 'grid', 'grid-area', 'grid-template',
  'transition', 'animation', 'list-style', 'outline', 'text-decoration', 'inset',
  'place-items', 'place-content', 'place-self', 'gap', 'overflow', 'mask',
]

describe('styles.css', () => {
  it('never puts a CSS-wide keyword inside a shorthand value', () => {
    const bad: string[] = []
    for (let i = 0; i < LINES.length; i++) {
      const t = LINES[i].trim()
      const m = /^([-a-zA-Z]+)\s*:\s*(.+);$/.exec(t)
      if (!m) continue
      const [, prop, value] = m
      if (!SHORTHANDS.includes(prop)) continue
      if (!WIDE.test(value)) continue
      // `font: inherit` -- the keyword AS the ENTIRE value -- is valid and common.
      if (/^(inherit|initial|unset|revert|revert-layer)$/.test(value.trim())) continue
      bad.push(`${i + 1}: ${t}`)
    }
    expect(bad, `CSS-wide keyword used as part of a shorthand -- the whole declaration is discarded:\n${bad.join('\n')}`).toEqual([])
  })

  it('gives the score HUD an explicit display face', () => {
    // The HUD sits directly above cheer.ts's callouts, which are set in
    // --sg-display. When .sg-score inherited .sg-hud's --sg-ui instead, the
    // loudest element in the game was set in the settings-menu face.
    // ANCHORED TO THE START OF A LINE, and to a selector that is exactly
    // `.sg-score`. The first version matched the first `.sg-score {` anywhere
    // in the file, which silently became `.sg-moment > .sg-score { order: 0 }`
    // the moment the panel was put inside a flow container -- a rule with no
    // font-family in it, so the test failed on a stylesheet that was correct.
    const block = /^\.sg-score\s*\{([\s\S]*?)^\}/m.exec(CLEAN)
    expect(block, 'the bare `.sg-score` rule was not found').toBeTruthy()
    expect(block![1]).toMatch(/font-family:\s*var\(--sg-display\)/)
  })
})
