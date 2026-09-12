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
 * WHERE IT SITS, AND WHY THAT TOOK TWO GOES.
 *
 * Top centre, per the reference. The first attempt put it there on the
 * reasoning that the four corners were taken -- and the MIDDLE is taken too:
 * the tools cluster (brightness + pause) occupies x 0.463-0.537 y 0.014-0.075
 * and the crosswind strip sits directly under it at y 0.086-0.115, so the
 * counter rendered underneath two buttons with the multiplier invisible. It
 * moved to the right column for a while; this is the measured way to put it
 * back where it was asked for.
 *
 * The block therefore starts BELOW that band rather than at the top edge. It is
 * still unambiguously the top-centre of the screen, it clears both widgets at
 * every width, and cheer.ts's line at 33% is far enough below to read as a
 * second voice rather than a collision.
 *
 * THE LAYOUT IS THE REFERENCE'S.
 *
 *     401,668  x16          <- total, and the multiplier beside it
 *     GREAT DRIFT   343     <- what is happening right now, and what it is worth
 *
 * The second line is the important half. The total is deliberately too large
 * and moving too fast to read mid-corner -- that blur is the point of it -- so
 * the readable number is what THIS SLIDE has banked, which is the figure that
 * decides whether to hold it one beat longer. Off the slide, the same line
 * shows the last award instead, so it is never an empty row.
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
/** Seconds line two keeps showing the last award once a slide ends. */
const EVENT_HOLD = 1.4

/**
 * The slide's name, by tier, escalating the way the reference does.
 *
 * Index is `driftTier + 1`, so -1 (charging, no rung banked yet) is a plain
 * DRIFT and the four tiers above it climb. Deliberately NOT the tier names --
 * Spark / Flare / Nova / Singularity are cheer.ts's vocabulary and already
 * appear in the callout ladder; repeating them here would put the same word on
 * screen twice in two sizes for the same event.
 */
const DRIFT_LABEL = ['DRIFT', 'GOOD DRIFT', 'GREAT DRIFT', 'AWESOME DRIFT', 'INSANE DRIFT']

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
  private readonly meterEl: HTMLElement
  private readonly eventLine: HTMLElement
  private readonly eventEl: HTMLElement
  private readonly eventVal: HTMLElement
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
  private eventHold = 0
  private lastEvent = ''

  constructor(host: HTMLElement) {
    this.root = div('sg-score')
    this.root.setAttribute('aria-hidden', 'true')

    const stack = div('sg-score__stack', this.root)

    // Line one: the total, and the multiplier on the same baseline beside it.
    const topLine = div('sg-score__line', stack)
    this.valueEl = div('sg-score__value', topLine)
    this.valueEl.textContent = '0'
    this.comboEl = div('sg-score__combo', topLine)
    this.comboEl.hidden = true
    div('sg-score__x', this.comboEl).textContent = '×'
    this.comboNum = div('sg-score__mult', this.comboEl)

    // Line two: what is happening, and what it is worth.
    const eventLine = div('sg-score__line sg-score__line--event', stack)
    this.eventEl = div('sg-score__event', eventLine)
    this.eventVal = div('sg-score__eventv', eventLine)
    eventLine.hidden = true
    this.eventLine = eventLine

    // The rung meter, full width of the block and directly under both lines,
    // so the escalation reads as belonging to the whole thing rather than to
    // the multiplier chip alone.
    const meter = div('sg-score__meter', stack)
    this.meterFill = div('sg-score__meterfill', meter)
    this.meterEl = meter
    meter.hidden = true

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
    this.meterEl.hidden = true
    this.eventLine.hidden = true
    this.eventHold = 0
    this.lastEvent = ''
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
    if (this.meterEl.hidden === showCombo) this.meterEl.hidden = !showCombo
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

    // --- line two -----------------------------------------------------------
    // While sliding it is the slide's own running tally, which is the readable
    // half of the information the blurring total carries. Off the slide it
    // holds the last award for a beat, so the row is never empty mid-race.
    const hot = s.drifting && s.driftRate > 0
    if (hot) {
      this.setEvent(DRIFT_LABEL[Math.max(0, Math.min(DRIFT_LABEL.length - 1, s.driftTier + 1))],
        s.driftBanked)
      this.eventHold = EVENT_HOLD
    } else if (s.awards.length > 0) {
      const a = s.awards[s.awards.length - 1]
      this.setEvent(a.label, a.points)
      this.eventHold = EVENT_HOLD
    } else if (this.eventHold > 0) {
      this.eventHold -= dt
    }
    const showEvent = hot || this.eventHold > 0
    if (this.eventLine.hidden === showEvent) this.eventLine.hidden = !showEvent

    const hotAttr = hot ? '1' : '0'
    if (this.root.dataset.hot !== hotAttr) this.root.dataset.hot = hotAttr

    // --- award popups -------------------------------------------------------
    // Not while sliding: line two is already saying what the slide is worth,
    // and a stack of DRIFT receipts under it says the same thing twice.
    if (!hot) for (const a of s.awards) this.pop(`${a.label}  +${a.points.toLocaleString()}`)
    for (const p of this.pops) {
      if (p.life <= 0) continue
      p.life -= dt
      if (p.life <= 0) { p.el.hidden = true; continue }
      const k = p.life / POP_LIFE
      p.el.style.opacity = String(Math.min(1, k * 2.2))
      if (!this.reduced) p.el.style.transform = `translateY(${(1 - k) * -22}px)`
    }
  }

  /** Line two, written only when it actually changes. */
  private setEvent(label: string, value: number): void {
    const key = label + '|' + value
    if (key === this.lastEvent) return
    this.lastEvent = key
    this.eventEl.textContent = label
    this.eventVal.textContent = value.toLocaleString()
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
