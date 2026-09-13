/**
 * A DESIGN BENCH FOR THE SCORE HUD.
 *
 * The HUD is driven by the scorer, which is driven by the sim, which under
 * SwiftShader runs at about one frame a second -- so every previous attempt to
 * LOOK at this widget meant racing a car in a headless browser for a minute to
 * get one frame where the interesting state happened to be on screen. That is
 * how `font: ... inherit` survived: the screenshots were legible, nobody could
 * hold the widget still, and 16px default text passes a glance.
 *
 * This mounts the real widget against the real stylesheet and hands it a
 * scripted ScoreState, so any state is one query parameter away and renders
 * instantly. It is a bench, not a test: it proves nothing about the scorer.
 */
import '../../src/ui/styles.css'
import { createScoreHud } from '../../src/ui/scoreHud'
import { createCheer } from '../../src/ui/cheer'
import type { ScoreState, ScoreAward } from '../../src/score/api'

const q = new URLSearchParams(location.search)
const host = document.getElementById('host') as HTMLElement
document.getElementById('bg')!.className = `bench bench--${q.get('bg') ?? 'dark'}`

const hud = createScoreHud(host)
hud.setVisible(true)

const cheer = createCheer(host)

function award(kind: ScoreAward['kind'], label: string, base: number, combo: number): ScoreAward {
  return { kind, label, base, combo, points: Math.round(base * combo) }
}

/**
 * `rung` is an INDEX into cheer's COMBO ladder (0 = GREAT .. 5 = LEGENDARY),
 * not a multiplier value. Passing the multiplier silently produces no line at
 * all, which is how the first version of this bench reported the callouts as
 * unstyled when they had simply never been asked for.
 */
const SCENES: Record<string, { state: Partial<ScoreState>; rung?: number }> = {
  // Mid-slide, deep combo -- the state the whole widget is designed around.
  hot: {
    state: {
      total: 401668, combo: 16, comboProgress: 0.62, chain: 3, chainLeft: 0.4,
      drifting: true, driftRate: 4200, driftBanked: 343, driftTier: 2,
      awards: [award('driftHold', 'HOLD', 22, 16)],
    },
  },
  // Top of the ladder.
  insane: {
    state: {
      total: 1284003, combo: 24, comboProgress: 0.93, chain: 6, chainLeft: 0.8,
      drifting: true, driftRate: 9800, driftBanked: 2470, driftTier: 3,
      awards: [award('driftHold', 'HOLD', 40, 24)],
    },
    rung: 5, // LEGENDARY
  },
  // Just cashed out: line two shows the last award, several receipts stacked.
  cash: {
    state: {
      total: 88240, combo: 8, comboProgress: 0.21, chain: 2, chainLeft: 0.9,
      drifting: false, driftRate: 0, driftBanked: 0, driftTier: -1,
      awards: [
        award('driftRelease', 'SLIDE BANKED', 900, 8),
        award('knock', 'KNOCK', 250, 8),
      ],
    },
  },
  // Every rung of the callout ladder, one per bench load, so the copy and the
  // colour ramp can be judged against each other rather than one at a time.
  callout0: { state: { total: 24000, combo: 2, comboProgress: 0.3, drifting: true, driftBanked: 120, driftTier: 0, awards: [] }, rung: 0 },
  callout2: { state: { total: 96000, combo: 5, comboProgress: 0.5, drifting: true, driftBanked: 640, driftTier: 1, awards: [] }, rung: 2 },
  callout5: { state: { total: 742100, combo: 16, comboProgress: 0.8, drifting: true, driftBanked: 1880, driftTier: 3, awards: [] }, rung: 5 },

  // The quiet state -- what most of a lap looks like.
  idle: {
    state: { total: 12400, combo: 1, comboProgress: 0, chain: 0, chainLeft: 0, drifting: false, driftRate: 0, driftBanked: 0, driftTier: -1, awards: [] },
  },
}

const base: ScoreState = {
  total: 0, combo: 1, comboProgress: 0, chain: 0, chainLeft: 0,
  drifting: false, driftRate: 0, driftBanked: 0, driftTier: -1,
  awards: [], rungs: [],
}

const scene = SCENES[q.get('scene') ?? 'hot'] ?? SCENES.hot
const state: ScoreState = { ...base, ...scene.state, rungs: [] }

// Settle the chase so the displayed total matches, then hand it one live frame
// so the pops, the meter and the hot-state transform are all in force.
for (let i = 0; i < 400; i++) hud.update({ ...state, awards: [] }, 1 / 60)
hud.update(state, 1 / 60)
if (scene.rung !== undefined) {
  cheer.comboRung(scene.rung)
  // cheer's root is `opacity: var(--k, 0)`, and --k is written by its own
  // animate() out of update(), which needs a live RaceState. The bench wants
  // the HELD frame rather than the entrance, so it pins --k directly and stops
  // the entrance animation from running out from under the screenshot.
  cheer.root.style.setProperty('--k', '1')
  cheer.root.style.animation = 'none'
  for (const el of Array.from(cheer.root.children) as HTMLElement[]) el.style.animation = 'none'
}

// Keep the pops alive at a fixed age rather than letting them fade during the
// screenshot -- the bench is a still, not an animation.
let held = 0
const tick = () => {
  if (held < 8) { hud.update({ ...state, awards: [] }, 1 / 60); held++ }
  requestAnimationFrame(tick)
}
requestAnimationFrame(tick)

;(window as unknown as { __BENCH__: unknown }).__BENCH__ = { hud, cheer, state }
