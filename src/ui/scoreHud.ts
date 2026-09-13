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
 * TWO WIDGETS, NOT ONE. THIS CHANGED, AND THE REASON IS WORTH KEEPING.
 *
 * The first version put the running total in the middle of the screen with the
 * current event underneath it. That reads as one number that is always there,
 * always moving, and never finishing -- so nothing on it marks a MOMENT. Vince
 * asked for the split, and it is the right call: the two numbers answer
 * different questions and want opposite treatments.
 *
 *   centre   THIS EVENT, and only while it is happening
 *
 *              GREAT DRIFT
 *               3,430  x16
 *             [====meter====]
 *
 *            It appears when something is worth points, holds for a couple of
 *            seconds after the event closes so the payoff can be read, then
 *            fades out and leaves the middle of the screen empty. Empty is the
 *            feature: the element only ever being there when it means
 *            something is what makes it mean something.
 *
 *   right    THE RUNNING TOTAL, quietly, permanently
 *
 *            Smaller, out of the racing line, below the minimap. It is
 *            reference information -- "how am I doing" -- not a moment, and it
 *            does not compete with the thing in the middle.
 *
 * BOTH still tick. The chase is what makes a number feel earned rather than
 * assigned, and it now runs on the event value as well, which is the number
 * actually sprinting during a slide.
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
/**
 * Seconds the centre panel stays up after its event closes.
 *
 * Long enough to read a five-figure number and register what earned it, short
 * enough that it is gone before the next corner. The fade itself is CSS, on
 * top of this.
 */
const EVENT_HOLD = 2.6

/**
 * One reused formatter for the running total.
 *
 * The total is the fastest-changing text in the game -- during a deep combo it
 * is a different string every frame -- and `Number.prototype.toLocaleString`
 * builds a fresh Intl.NumberFormat on every call. Constructing it once and
 * calling `.format()` is the same output for a fraction of the cost, and the
 * integer comparison below means it is only reached when the digits actually
 * moved.
 */
const GROUPED = new Intl.NumberFormat('en-US')

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
  /**
   * Land on the final total and stop, so the last number the player watches is
   * the number the results screen prints. See the implementation.
   */
  settle(total: number): void
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
  private readonly popWrap: HTMLElement
  /** The right-hand running-total panel, and the digits inside it. */
  private readonly totalRoot: HTMLElement
  private readonly totalEl: HTMLElement
  private readonly pops: Pop[] = []

  /** The running total on screen, right-hand panel. Chases `target`. */
  private shown = 0
  private target = 0
  /** The event value on screen, centre panel. Chases `eventTarget`. */
  private shownEvent = 0
  private eventTarget = 0
  /** True once the race is over and both numbers are final. See settle(). */
  private settled = false
  private reduced = false
  private lastValue = -1
  private lastEventValue = -1
  private lastCombo = ''
  private lastRung = -1
  private visible = true
  private eventHold = 0
  private beat = 0
  private lastEvent = ''

  /**
   * @param host      the shared centre-screen stack (`.sg-moment`), which the
   *                  callout also lives in so the two animate as one block.
   * @param totalHost where the running total goes. Deliberately NOT the same
   *                  parent: the centre stack is a centred flow container, and
   *                  an absolutely-positioned right-hand panel inside it would
   *                  be positioned against that container rather than against
   *                  the screen.
   */
  constructor(host: HTMLElement, totalHost: HTMLElement = host) {
    this.root = div('sg-score')
    this.root.setAttribute('aria-hidden', 'true')

    const stack = div('sg-score__stack', this.root)

    // Line one: what is happening. The label leads, because the number under
    // it is meaningless without knowing what earned it.
    this.eventEl = div('sg-score__event', stack)

    // Line two: what it is worth, with the multiplier on the same baseline.
    // This is now the big gold number the widget is built around -- it used to
    // be the running total, and the total has moved to its own panel.
    const valueLine = div('sg-score__line', stack)
    this.valueEl = div('sg-score__value', valueLine)
    this.valueEl.textContent = '0'
    this.comboEl = div('sg-score__combo', valueLine)
    this.comboEl.hidden = true
    div('sg-score__x', this.comboEl).textContent = '×'
    this.comboNum = div('sg-score__mult', this.comboEl)
    this.eventLine = valueLine

    // The rung meter, full width of the block, so the escalation reads as
    // belonging to the whole thing rather than to the multiplier chip alone.
    const meter = div('sg-score__meter', stack)
    this.meterFill = div('sg-score__meterfill', meter)
    this.meterEl = meter
    meter.hidden = true

    // The centre panel starts OFF. It is not a permanent fixture any more --
    // it exists only while something is worth points.
    this.root.dataset.on = '0'

    this.popWrap = div('sg-score__pops', this.root)
    for (let i = 0; i < POP_SLOTS; i++) {
      const el = div('sg-score__pop', this.popWrap)
      el.hidden = true
      this.pops.push({ el, life: 0 })
    }

    host.appendChild(this.root)

    // --- the running total, right-hand column -------------------------------
    //
    // Below the minimap and clock, which occupy x 0.889-0.990 y 0.017-0.229 at
    // 1280x720 (measured; the same table is in styles.css). This sits under
    // that band rather than beside it, so it never has to compete with the
    // track ahead for the eye.
    this.totalRoot = div('sg-total')
    this.totalRoot.setAttribute('aria-hidden', 'true')
    div('sg-total__k', this.totalRoot).textContent = 'SCORE'
    this.totalEl = div('sg-total__v', this.totalRoot)
    this.totalEl.textContent = '0'
    totalHost.appendChild(this.totalRoot)
  }

  /**
   * The race is over: land on the final total and stop.
   *
   * Called with the value the results screen is about to print, so the last
   * number the player watches and the number they are then shown are the same
   * one. Without it the counter kept chasing through the ceremony and settled
   * somewhere else, which reads as the game changing its mind about what the
   * run was worth -- and it was ALSO hiding a real bug, because the two really
   * were different: the finishing award landed after the capture. See
   * `captureScoreNextFrame` in game/main.ts.
   */
  settle(total: number): void {
    this.settled = true
    this.target = total
    this.shown = total
    const n = Math.floor(total)
    if (n !== this.lastValue) { this.lastValue = n; this.totalEl.textContent = GROUPED.format(n) }
    // The centre panel has nothing live to say once the race is over.
    this.eventHold = 0
    this.root.dataset.on = '0'
  }

  setReducedMotion(reduced: boolean): void {
    this.reduced = reduced
    this.root.dataset.reduced = reduced ? '1' : '0'
    this.totalRoot.dataset.reduced = reduced ? '1' : '0'
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return
    this.visible = visible
    this.root.hidden = !visible
    this.totalRoot.hidden = !visible
  }

  reset(): void {
    this.shown = 0
    this.target = 0
    this.shownEvent = 0
    this.eventTarget = 0
    this.settled = false
    this.lastRung = -1
    this.lastValue = -1
    this.lastEventValue = -1
    this.lastCombo = ''
    this.valueEl.textContent = '0'
    this.totalEl.textContent = '0'
    this.root.dataset.on = '0'
    this.comboEl.hidden = true
    this.meterEl.hidden = true
    this.eventLine.hidden = true
    this.eventHold = 0
    this.lastEvent = ''
    this.root.dataset.hot = '0'
    for (const p of this.pops) { p.life = 0; p.el.hidden = true }
  }

  update(s: ScoreState, dt: number): void {
    // Once settled, the numbers are the results screen's and nothing further
    // may move them -- the ceremony keeps stepping the sim behind this.
    if (this.settled) return
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

    // GROUPED, like every other number in the widget. At 64px a seven-figure
    // total read as an unbroken wall of digits -- the opposite of a brief that
    // wants the number legible WHILE it sprints. The separators also give the
    // eye fixed landmarks, so a counter running too fast to read still shows
    // at a glance how big it has got.
    //
    // Compared as an integer rather than as a string so the format() call is
    // skipped on frames where the digits did not move.
    const n = Math.floor(this.shown)
    if (n !== this.lastValue) {
      this.lastValue = n
      this.totalEl.textContent = GROUPED.format(n)
    }

    // THE TICK PULSE. A counter that only changes its digits reads as a number
    // being updated; a counter that flinches every time it is paid reads as a
    // number being EARNED, which is the whole brief. Driven off award events
    // rather than off the digits changing, because during a slide the digits
    // change every frame and a pulse on every frame is a vibration.
    //
    // Two alternating values rather than one, for the same reason cheer.ts
    // flips its beat: the element never leaves the tree, so re-applying the
    // same attribute would not restart the animation.
    // The TOTAL flinches whenever it is paid -- that is a small nudge on one
    // number and reads as the score being earned. The centre block does NOT:
    // drift-hold pays every single frame, so stamping the whole stack on every
    // award would be a continuous vibration rather than an entrance. It stamps
    // when a new event ARRIVES, which setEvent decides.
    if (s.awards.length > 0 || s.rungs.length > 0) {
      this.beat ^= 1
      this.totalRoot.dataset.beat = String(this.beat)
    }

    // --- the combo ----------------------------------------------------------
    const showCombo = s.combo > 1.01
    if (this.comboEl.hidden === showCombo) this.comboEl.hidden = !showCombo
    if (this.meterEl.hidden === showCombo) this.meterEl.hidden = !showCombo
    if (showCombo) {
      const c = s.combo >= 10 ? s.combo.toFixed(0) : s.combo.toFixed(1)
      if (c !== this.lastCombo) { this.lastCombo = c; this.comboNum.textContent = c }
      this.meterFill.style.transform = `scaleX(${s.comboProgress.toFixed(3)})`
    }
    // OUTSIDE the combo branch. The rung drives the whole escalation ladder --
    // size, hue, stamp amplitude, the top-rung fringe -- so leaving it unwritten
    // at combo 1 froze the block at whatever the last slide had reached, and
    // the next event arrived wearing the previous one's clothes.
    const rung = rungIndex(s.combo)
    if (rung !== this.lastRung) {
      this.lastRung = rung
      this.root.dataset.rung = String(rung)
    }

    // --- the event, which is the whole of the centre panel ------------------
    //
    // While sliding this is the slide's own running tally -- the figure that
    // decides whether to hold it one beat longer. Off the slide it is the last
    // award, held for EVENT_HOLD so the payoff can actually be read, and then
    // the panel goes away entirely rather than sitting there showing a stale
    // number. `data-on` drives the fade; the CSS owns the timing.
    const hot = s.drifting && s.driftRate > 0
    if (hot) {
      this.setEvent(DRIFT_LABEL[Math.max(0, Math.min(DRIFT_LABEL.length - 1, s.driftTier + 1))],
        s.driftBanked)
      this.eventHold = EVENT_HOLD
    } else if (s.awards.length > 0) {
      // The biggest of this frame's awards, not the last one. Two events can
      // land on one frame -- a chain and the release that started it -- and
      // showing whichever happened to be pushed second understates the moment.
      let best = s.awards[0]
      for (const a of s.awards) if (a.points > best.points) best = a
      this.setEvent(best.label, best.points)
      this.eventHold = EVENT_HOLD
    } else if (this.eventHold > 0) {
      this.eventHold -= dt
    }

    // The event number chases too. During a slide `driftBanked` is climbing
    // every frame, so this is the counter that actually sprints now.
    const gapE = this.eventTarget - this.shownEvent
    if (Math.abs(gapE) <= SNAP || this.reduced) this.shownEvent = this.eventTarget
    else this.shownEvent += gapE * (1 - Math.exp(-CHASE * Math.max(0, dt)))
    const ne = Math.floor(this.shownEvent)
    if (ne !== this.lastEventValue) {
      this.lastEventValue = ne
      this.valueEl.textContent = GROUPED.format(ne)
    }

    const showEvent = hot || this.eventHold > 0
    const onAttr = showEvent ? '1' : '0'
    if (this.root.dataset.on !== onAttr) this.root.dataset.on = onAttr

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

  /**
   * Point the centre panel at an event.
   *
   * The chase restarts from zero whenever the LABEL changes, not whenever the
   * value does: a new event counting up from the previous event's total would
   * read as one continuous number, which is the thing this split exists to
   * stop. Within one event the value only climbs, so the chase carries.
   */
  private setEvent(label: string, value: number): void {
    if (label !== this.lastEvent) {
      this.lastEvent = label
      this.eventEl.textContent = label
      this.shownEvent = 0
      this.lastEventValue = -1
      // A new moment: stamp it. Alternating, because re-applying the same
      // animation to an element that never leaves the tree does not restart it.
      this.beat ^= 1
      this.root.dataset.beat = String(this.beat)
    }
    this.eventTarget = value
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
    if (this.totalRoot.parentNode) this.totalRoot.parentNode.removeChild(this.totalRoot)
    this.root.remove()
  }
}

function rungIndex(combo: number): number {
  let r = -1
  for (let i = 0; i < COMBO_RUNGS.length; i++) if (combo >= COMBO_RUNGS[i]) r = i
  return r
}

export function createScoreHud(host: HTMLElement, totalHost?: HTMLElement): ScoreHud {
  return new ScoreHudImpl(host, totalHost ?? host)
}
