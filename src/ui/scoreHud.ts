/**
 * SpaceGen Racing — the score counter.
 * ---------------------------------------------------------------------------
 * THE TICKING IS THE FEATURE.
 *
 * The brief was explicit that the most exciting part is watching the number run
 * upward during a slide, so this widget is built around that one behaviour and
 * everything else is support. The counter does not snap to the true score -- it
 * CHASES it, and during a drift the true score is climbing at up to 800 points
 * a second times the combo, so the display is permanently behind and sprinting
 * to catch up. That lag is not a compromise, it is what produces the blur of
 * digits; a counter that assigned the exact value every frame would read as a
 * number changing rather than a number running.
 *
 * WHY IT SITS TOP CENTRE.
 *
 * The other three corners are taken -- position and lap splits top left, the
 * minimap and clock top right, items bottom left -- and the band across the
 * bottom is the boost gauge. Top centre is the only free region, and it happens
 * to be the right one: it is sky on the chase rig, it is where the eye goes
 * between corners, and it is directly above cheer.ts's line so the praise and
 * the number read as one column instead of two competing widgets.
 *
 * WHAT IT DOES NOT DO.
 *
 * It never shows the combo at x1 and it never shows an empty award stack. A
 * scoring HUD that is always on screen at rest is four permanent widgets in a
 * game that already has five, so at zero combo with nothing landing this is one
 * quiet number and nothing else.
 */
import type { ScoreState } from '../score/api'
import { COMBO_RUNGS } from '../score/rules'

/** How fast the displayed number closes on the real one, per second. */
const CHASE = 6.5
/** Below this gap, stop chasing and land exactly. Prevents a forever-crawl. */
const SNAP = 1.5
/** Award popups live this long. */
const POP_LIFE = 1.15
/** How many popups may stack before the oldest is recycled. */
const POP_SLOTS = 4

function div(cls: string, parent?: HTMLElement): HTMLDivElement {
  const el = document.createElement('div')
  el.className = cls
  if (parent) parent.appendChild(el)
  return el
}

interface Pop {
  el: HTMLElement
  life: number
}

export interface ScoreHud {
  root: HTMLElement
  /** One render frame. `dt` is real seconds -- this is presentation only. */
  update(s: ScoreState, dt: number): void
  /** Wipe between races so a rematch starts at zero with nothing on screen. */
  reset(): void
  setReducedMotion(reduced: boolean): void
  /** Hide the whole widget, for the front end and the ceremony. */
  setVisible(visible: boolean): void
  dispose(): void
}

class ScoreHudImpl implements ScoreHud {
  readonly root: HTMLElement
  private readonly valueEl: HTMLElement
  private readonly comboEl: HTMLElement
  private readonly comboNum: HTMLElement
  private readonly meterFill: HTMLElement
  private readonly rateEl: HTMLElement
  private readonly popWrap: HTMLElement
  private readonly pops: Pop[] = []

  /** The number actually on screen. Chases `target`. */
  private shown = 0
  private target = 0
  private reduced = false
  private lastText = ''
  private lastCombo = ''
  private lastRung = -1
  private visible = true

  constructor(host: HTMLElement) {
    this.root = div('sg-score')
    this.root.setAttribute('aria-hidden', 'true')

    const stack = div('sg-score__stack', this.root)
    this.valueEl = div('sg-score__value', stack)
    this.valueEl.textContent = '0'

    this.comboEl = div('sg-score__combo', stack)
    this.comboEl.hidden = true
    const chip = div('sg-score__chip', this.comboEl)
    div('sg-score__x', chip).textContent = '×'
    this.comboNum = div('sg-score__mult', chip)
    const meter = div('sg-score__meter', this.comboEl)
    this.meterFill = div('sg-score__meterfill', meter)

    // The live drift rate, shown only while a slide is being paid for. This is
    // the number that tells a player holding the slide is WORKING -- the total
    // is already moving too fast to read at that moment, which is the point of
    // it, so the rate is the readable half of the same information.
    this.rateEl = div('sg-score__rate', stack)
    this.rateEl.hidden = true

    this.popWrap = div('sg-score__pops', this.root)
    for (let i = 0; i < POP_SLOTS; i++) {
      const el = div('sg-score__pop', this.popWrap)
      el.hidden = true
      this.pops.push({ el, life: 0 })
    }

    host.appendChild(this.root)
  }

  setReducedMotion(reduced: boolean): void {
    this.reduced = reduced
    this.root.dataset.reduced = reduced ? '1' : '0'
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return
    this.visible = visible
    this.root.hidden = !visible
  }

  reset(): void {
    this.shown = 0
    this.target = 0
    this.lastRung = -1
    this.lastText = ''
    this.lastCombo = ''
    this.valueEl.textContent = '0'
    this.comboEl.hidden = true
    this.rateEl.hidden = true
    this.root.dataset.hot = '0'
    for (const p of this.pops) { p.life = 0; p.el.hidden = true }
  }

  update(s: ScoreState, dt: number): void {
    this.target = s.total

    // --- the chase ----------------------------------------------------------
    // Exponential, so a big jump moves fast and a small one settles. Framed as
    // a per-second rate through an exp() rather than a raw `* dt` lerp, because
    // the raw form overshoots and oscillates the moment a frame runs long --
    // which on this renderer, under SwiftShader, is most of them.
    const gap = this.target - this.shown
    if (Math.abs(gap) <= SNAP) {
      this.shown = this.target
    } else if (this.reduced) {
      // No running digits under reduced motion: the blur IS the animation.
      this.shown = this.target
    } else {
      this.shown += gap * (1 - Math.exp(-CHASE * Math.max(0, dt)))
    }

    const text = String(Math.floor(this.shown))
    if (text !== this.lastText) {
      this.lastText = text
      this.valueEl.textContent = text
    }

    // --- the combo ----------------------------------------------------------
    const showCombo = s.combo > 1.01
    if (this.comboEl.hidden === showCombo) this.comboEl.hidden = !showCombo
    if (showCombo) {
      const c = s.combo >= 10 ? s.combo.toFixed(0) : s.combo.toFixed(1)
      if (c !== this.lastCombo) { this.lastCombo = c; this.comboNum.textContent = c }
      this.meterFill.style.transform = `scaleX(${s.comboProgress.toFixed(3)})`
      const rung = rungIndex(s.combo)
      if (rung !== this.lastRung) {
        this.lastRung = rung
        this.root.dataset.rung = String(rung)
      }
    }

    // --- the live rate, while sliding ---------------------------------------
    const hot = s.drifting && s.driftRate > 0
    if (this.rateEl.hidden === hot) this.rateEl.hidden = !hot
    if (hot) this.rateEl.textContent = `+${Math.round(s.driftRate)}/s`
    const hotAttr = hot ? '1' : '0'
    if (this.root.dataset.hot !== hotAttr) this.root.dataset.hot = hotAttr

    // --- award popups -------------------------------------------------------
    for (const a of s.awards) this.pop(`${a.label}  +${a.points.toLocaleString()}`)
    for (const p of this.pops) {
      if (p.life <= 0) continue
      p.life -= dt
      if (p.life <= 0) { p.el.hidden = true; continue }
      const k = p.life / POP_LIFE
      p.el.style.opacity = String(Math.min(1, k * 2.2))
      if (!this.reduced) p.el.style.transform = `translateY(${(1 - k) * -22}px)`
    }
  }

  /** Show one receipt. Oldest slot is recycled when all are busy. */
  private pop(text: string): void {
    let slot = this.pops.find((p) => p.life <= 0)
    if (!slot) {
      slot = this.pops[0]
      for (const p of this.pops) if (p.life < slot.life) slot = p
    }
    slot.life = POP_LIFE
    slot.el.textContent = text
    slot.el.style.opacity = '1'
    slot.el.style.transform = 'translateY(0)'
    slot.el.hidden = false
  }

  dispose(): void {
    this.root.remove()
  }
}

function rungIndex(combo: number): number {
  let r = -1
  for (let i = 0; i < COMBO_RUNGS.length; i++) if (combo >= COMBO_RUNGS[i]) r = i
  return r
}

export function createScoreHud(host: HTMLElement): ScoreHud {
  return new ScoreHudImpl(host)
}
