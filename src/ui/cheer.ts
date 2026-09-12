/**
 * SpaceGen Racing — encouragement callouts.
 *
 * One short line of praise, centred, a third of the way down the screen, for a
 * moment the player earned. Nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHAT EARNS A LINE, AND WHY
 *
 * The escalation the player asked for is the DRIFT LADDER, because the drift is
 * the one thing in this game that already escalates: four charge tiers at
 * 0.65 / 1.50 / 2.60 / 4.20 seconds, each worth more boost than the last. So
 * the praise climbs with them —
 *
 *   holding a slide   a quiet tier name as each rung is banked, so the words
 *                     are the same channel as the ring and the sparks and say
 *                     "keep holding it"
 *   cashing it in     the loud line, and it is loud in proportion to the tier.
 *                     This is the payoff moment; it is the only one the copy
 *                     ever shouts about.
 *   chaining          three slides linked without dropping the chain window.
 *                     Rare, entirely skill, worth saying so.
 *
 * And four moments off the drift ladder that are worth interrupting for:
 *
 *   taking the lead   the biggest single thing that can happen to a position.
 *   an overtake       a position gained under racing. Hard-limited to one
 *                     every six seconds, because mid-pack positions swap
 *                     constantly and a racer that narrates every one is noise.
 *   a long clean air  `land.clean` after `airMin` seconds. A ramp taken flat
 *                     and landed square is a real piece of driving.
 *   breaking a car    with the Pulse Gatling. `beamHit.lethal` is the only
 *                     item event in the game that takes SUSTAINED skill —
 *                     0.8 seconds of holding a line on one car.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS DELIBERATELY LEFT OUT
 *
 *   tier 0 cash-ins   a Spark release is a corner exit, not an achievement.
 *                     Below `cashMinTier` there is no line at all.
 *   item pickups,     `pickup`, `charge`, `fire`. Constant, and none of them
 *   charges, firing   is a thing the player did well — the box was there.
 *   missile hits      `hit` on someone else is not visible to this system and
 *                     a fired missile connecting is mostly the missile's doing.
 *                     The gatling is the exception above.
 *   getting hit,      the HUD already prints SPUN OUT in violet across the
 *   spinning, walls   middle of the screen. A cheer next to it reads as mockery.
 *   lap splits and    the HUD already shows the split, green when it is a best.
 *   best laps         A second widget saying the same thing twice is clutter.
 *   the final lap     already a banner.
 *   boost pads,       passive. The player drove over a thing.
 *   slipstream
 *   anything after    the finish has its own sequence and its own copy. The
 *   the finish        victory lap is AI-driven, so praising it would be
 *                     praising the computer.
 *
 * ---------------------------------------------------------------------------
 * HOW IT STAYS OFF THE RACING LINE
 *
 *   - It sits at 33% of the viewport height, centred. On the chase rig the
 *     horizon sits near the middle of the frame and the road the player is
 *     steering by fills the bottom half, so this band is sky.
 *   - One line at a time. Never a stack, never a queue that drains later.
 *   - No filled panel, no scrim, no border: the legibility comes from a soft
 *     dark halo on the glyphs themselves, which occludes a few hundred pixels
 *     rather than a bar across the screen.
 *   - Short: `hold` + `fade` is under a second and a half, total.
 *   - `pointer-events: none`, so it can never eat a touch meant for the road.
 *   - It has its own setting (Settings > Callouts: Full / Key moments / Off),
 *     for the same reason Glare does. "Key moments" keeps only priority >= 3 —
 *     cash-ins, overtakes and the lead — drops the tier ladder, and (see
 *     KEY_CASH_MIN_TIER) raises the drift-release floor to Nova.
 *   - Under `prefers-reduced-motion` there is no stamp, no shockwave, no slide
 *     and no flicker: it fades in and it fades out. The resting state of every
 *     element is the correct one, so an animation that never runs takes
 *     nothing with it.
 *   - It suppresses itself entirely on a viewport too short to spare the band.
 *
 * ---------------------------------------------------------------------------
 * THE PRESENTATION, AND WHY THIS MUCH OF IT
 *
 * The ladder has to FEEL like it builds to Singularity, not just change hue.
 * Four channels, each switched on at a different rung, so the top of the
 * ladder is doing four things the bottom is not:
 *
 *   size          every rung, ~2.2x from a Spark whisper to a Singularity.
 *   the stamp     every rung. A CSS entrance that arrives large, leaning and
 *                 high, overshoots past rest and settles — an impact rather
 *                 than a fade-in. Its amplitude and duration scale with the
 *                 rung (`--amp` / `--dur` in styles.css), so a Spark barely
 *                 twitches and a Singularity lands.
 *   the shockwave Nova and Singularity only. A hue-matched ellipse that blooms
 *                 outward from behind the words and dies inside half a second.
 *                 Transparent, transient, and INVISIBLE AT REST, because
 *                 unlike the text it carries no information.
 *   chromatic     Singularity only. Two coloured fringes on the glyphs. Static,
 *                 so it survives reduced motion — it is a look, not a movement,
 *                 and it is the signature that says "this is the top rung".
 *
 * All of it is transform and opacity on elements built once, so it composites
 * and never touches layout. What was rejected, and why:
 *
 *   per-character   needs one element per glyph at line time, which this
 *   reveal          module's build-once contract forbids; it also delays
 *                   legibility (the whole point is to be read in a glance
 *                   while the eyes are on the road) and would make `aria-live`
 *                   announce the line in fragments.
 *   a light sweep   the obvious way is `background-clip: text`, which requires
 *   across the      a transparent text fill — and that takes the DARK OUTLINE
 *   glyphs          down with it. That outline is the half of the shadow stack
 *                   keeping this legible over a white sky. Not worth it.
 *   a flash, scrim  a bar across the screen is the exact readability failure
 *   or filled panel this widget was written to avoid.
 *   shake, strobe,  the same failure in the accessibility direction.
 *   violent scale
 */
import type { RaceState, RacerState } from '../sim/types'
import { TUNING } from '../content/tuning'

const CH = TUNING.cheer

export type CheerLevel = 'full' | 'key' | 'off'

/** Every kind of moment that can produce a line. */
export type CheerKind =
  'tierUp' | 'cash' | 'chain' | 'overtake' | 'lead' | 'air' | 'beam' | 'combo'
type Kind = 'tierUp' | 'cash' | 'chain' | 'overtake' | 'lead' | 'air' | 'beam' | 'combo'

export interface Cheer {
  root: HTMLElement
  /**
   * True for the frame in which a DRIFT CASH-IN line actually went up (i.e. it
   * survived the cooldown and priority gates). The HUD reads this to suppress
   * its own centre-screen boost flash for that release, so the moment is
   * announced once, up here in the sky, instead of twice with the second copy
   * laid across the car and the road. Every other boost -- pads, Nitro, trick
   * landings, tier-0 releases -- still gets the flash as before, and so does
   * every release when the callouts are switched off.
   */
  readonly tookDriftRelease: boolean
  /**
   * Fired the moment a line actually goes up, with the kind that earned it.
   *
   * The audio system binds VO to this rather than re-deriving the moments for
   * itself. That is the whole point: every rule about what deserves a line --
   * the drift ladder, the six-second overtake limit, the refusal to say
   * anything about a missile hit or a boost pad -- is decided ONCE here, in the
   * file that had the editorial argument. A voice that ran its own detectors
   * would eventually praise something the text stayed quiet about, and the two
   * would be visibly at odds on screen.
   *
   * It also means the callout level setting reaches the voice for free: a line
   * that does not go up does not fire this, so "off" is silent in both media.
   */
  onLine: (kind: CheerKind) => void
  /** Called once per render frame with the live sim state. */
  update(state: RaceState, local: RacerState, dt: number): void
  /**
   * A combo rung was crossed. Pushed in rather than detected here, because the
   * combo lives in the scorer and this file deliberately owns no game state of
   * its own -- it owns the EDITORIAL rules about what is worth interrupting
   * for, and routing the rung through the same say() gates is the whole point:
   * it inherits the cooldowns, the priority ordering, the Key-moments filter
   * and the VO binding for free, and can never contradict the drift ladder it
   * sits next to.
   */
  comboRung(rung: number): void
  setLevel(level: CheerLevel): void
  /** Wipe pending state between races so a rematch starts silent. */
  reset(): void
  dispose(): void
}

// ---------------------------------------------------------------------------
// The copy.
//
// House voice: this is a sci-fi arcade racer whose chassis are called Solaire
// GT, Bulwark MK-IV and Vector-7 and whose drift tiers are Spark, Flare, Nova
// and Singularity. So the register is flight-deck / race-engineer, not
// stadium announcer. No "NICE!", no "AWESOME!", no exclamation marks except
// where the tier itself is the exclamation.
//
// ONE EXCEPTION, SCOPED TO ONE ARRAY: the combo ladder (COMBO, below) is
// stadium announcer on purpose. It is praising the SCORE, not the driving, and
// the score is an arcade layer sitting on top of the race. See the note there
// before making it consistent with this paragraph.
// ---------------------------------------------------------------------------

/** Banked a rung of the ladder. Quiet — the ring and the sparks say it too. */
const TIER_UP: string[] = [
  'SPARK',
  'FLARE HOLDING',
  'NOVA — STAY IN IT',
  'SINGULARITY',
]

/** Cashed a slide in. The payoff line, louder the longer it was held. */
const CASH: string[][] = [
  [], // tier 0 never speaks; see cashMinTier
  ['CLEAN FLARE', 'FLARE BANKED', 'THAT LINE HELD'],
  ['NOVA RELEASE', 'BEAUTIFULLY HELD', 'NOVA — TEXTBOOK'],
  ['SINGULARITY!', 'PERFECT SLIDE', 'FULL CHARGE, FULL EXIT'],
]

const CHAIN: string[] = [
  'CHAIN HOLDING',
  'LINKED — KEEP GOING',
  'THREE IN A ROW',
]

const OVERTAKE: string[] = [
  'POSITION TAKEN',
  'THAT IS ONE BACK',
  'PAST HIM CLEAN',
  'UP A PLACE',
]

const LEAD: string[] = [
  'YOU HAVE THE LEAD',
  'FRONT OF THE FIELD',
  'CLEAR AIR AHEAD',
]

const AIR: string[] = [
  'SQUARE LANDING',
  'STUCK IT',
  'FLAT AND CLEAN',
]

const BEAM: string[] = [
  'TARGET BROKEN',
  'HELD THE LOCK',
  'TRACKED HIM DOWN',
]

/**
 * Combo rungs, one line per rung of score/rules.ts COMBO_RUNGS.
 *
 * THIS LADDER IS DELIBERATELY IN A DIFFERENT REGISTER FROM EVERY OTHER LIST IN
 * THIS FILE, and that is a decision rather than an oversight.
 *
 * The house voice note at the top of this file -- race engineer, not stadium
 * announcer -- still governs the drift ladder, the overtakes and the lead,
 * because those describe things that happened in the RACE. The combo ladder
 * does not: it describes the SCORE, which is an arcade layer sitting on top of
 * the race, and an arcade layer is allowed to sound like one. Vince asked for
 * these words specifically, twice, and named the top rung himself.
 *
 * So: if you are here to make this consistent with the rest of the file, don't.
 * The inconsistency is the point, it is scoped to this one array, and the
 * opposite version was shipped first and rejected.
 */
const COMBO: string[] = [
  'GREAT',          // x2
  'AMAZING',        // x3
  'DRIFT MASTER',   // x5
  'INCREDIBLE',     // x8
  'UNSTOPPABLE',    // x12
  'LEGENDARY',      // x16
]

/** Rung colours: the drift ladder, then gold for the two nobody reaches. */
const COMBO_COLOR = ['#3d8bff', '#b44dff', '#ffd23f', '#ffffff', '#ffb020', '#ff7a1a']

/**
 * The drift tier a cash-in must reach to survive "Key only".
 *
 * `CH.cashMinTier` (1, Flare) is the floor at Full. Key only raises it to Nova
 * because the presentation got bigger: a Flare release is the routine corner
 * exit of a competent driver, and it is by some margin the most frequent thing
 * that clears the priority >= 3 filter. Leaving the floor where it was would
 * mean the player who asked for FEWER interruptions now gets the loudest ones
 * on the most ordinary event. Key only is therefore: the moments that decide a
 * race — the lead, an overtake, a chain — plus the top two drift releases.
 *
 * Lives here rather than in TUNING because it is a presentation policy about
 * how much screen a setting is allowed to buy, not a number the driving model
 * or the balance harness has any opinion about.
 */
const KEY_CASH_MIN_TIER = 2

/** Read in place of a stale event list; never written. */
const EMPTY: RacerState['events'] = []

/** Tier colours, matching the drift ring and the boost flash. */
const TIER_COLOR = ['#3d8bff', '#b44dff', '#ffd23f', '#ffffff']

/** '#rrggbb' -> 'rgba(r, g, b, a)'. Construction-cheap; called once per line. */
function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16)
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'
}

// ---------------------------------------------------------------------------

class CheerImpl implements Cheer {
  readonly root: HTMLElement
  tookDriftRelease = false
  onLine: (kind: CheerKind) => void = () => {}
  private readonly line: HTMLElement
  private readonly wave: HTMLElement
  /**
   * Flips 0 <-> 1 on every line so the CSS entrance restarts.
   *
   * A line usually arrives on an element that was `hidden`, and coming back
   * into the render tree restarts an animation for free — but a bigger line is
   * allowed to REPLACE a live one without the element ever going away, and
   * that case has to restart too. The alternative is the `animation: none` +
   * forced-reflow trick, which is a synchronous layout in the middle of a
   * game loop; two identical keyframe sets selected by this attribute cost
   * nothing at runtime.
   */
  private beat = 0

  private level: CheerLevel = 'full'
  private reduced = false

  /** Time left at full strength, then in the fade. */
  private holdT = 0
  private fadeT = 0
  private riseT = 0
  private shownPriority = 0
  /** Seconds since the last line of ANY kind went up. */
  private sinceAny = 999
  private readonly cooldown: Record<Kind, number> = {
    tierUp: 999, cash: 999, chain: 999, overtake: 999, lead: 999, air: 999,
    beam: 999, combo: 999,
  }
  /** Rotating index per phrase list, so the same words never repeat back to back. */
  private readonly cursor: Record<string, number> = {}

  // change detectors
  private lastTier = -2
  private lastPos = -1
  private lastChain = 0
  private lastText = ''
  private lastColor = ''
  private airborne = 0
  private wasVisible = false

  /**
   * The sim frame whose `events` have already been read. `r.events` is cleared
   * per SIM step but this runs per RENDER frame, so on a 120Hz display half of
   * all frames run zero sim steps and see the previous frame's array a second
   * time -- and while the game is paused, no step runs at all and the same
   * array would be re-read forever. This codebase has already shipped that bug
   * once in the VFX pass; the fix there was a `state.frame` guard, and this is
   * the same guard.
   */
  private lastEventFrame = -1

  private viewH = 720
  private readonly onResize: () => void
  private readonly mq: MediaQueryList | null
  private readonly onMq: () => void

  constructor(host: HTMLElement) {
    const root = document.createElement('div')
    root.className = 'sg-cheer'
    root.setAttribute('aria-live', 'polite')
    root.setAttribute('aria-atomic', 'true')
    this.root = root
    // Behind the words, and invisible at rest. The wave is pure effect: it
    // says nothing, so opacity 0 is its correct resting state — the opposite
    // of the rule for the line, whose resting state must always be readable.
    this.wave = document.createElement('div')
    this.wave.className = 'sg-cheer__wave'
    this.wave.setAttribute('aria-hidden', 'true')
    root.appendChild(this.wave)
    this.line = document.createElement('div')
    this.line.className = 'sg-cheer__line'
    root.appendChild(this.line)
    root.dataset.beat = '0'
    root.hidden = true
    host.appendChild(root)

    this.viewH = window.innerHeight || 720
    this.onResize = (): void => { this.viewH = window.innerHeight || 720 }
    window.addEventListener('resize', this.onResize, { passive: true })
    window.addEventListener('orientationchange', this.onResize, { passive: true })

    this.mq = typeof matchMedia === 'function'
      ? matchMedia('(prefers-reduced-motion: reduce)') : null
    this.reduced = this.mq ? this.mq.matches : false
    this.onMq = (): void => { this.reduced = this.mq ? this.mq.matches : false }
    if (this.mq && this.mq.addEventListener) this.mq.addEventListener('change', this.onMq)
  }

  setLevel(level: CheerLevel): void {
    this.level = level
    if (level === 'off') this.clear()
  }

  reset(): void {
    this.clear()
    this.sinceAny = 999
    for (const k in this.cooldown) this.cooldown[k as Kind] = 999
    this.lastTier = -2
    this.lastPos = -1
    this.lastChain = 0
    this.airborne = 0
    this.lastEventFrame = -1
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('orientationchange', this.onResize)
    if (this.mq && this.mq.removeEventListener) this.mq.removeEventListener('change', this.onMq)
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root)
  }

  // -------------------------------------------------------------------------

  update(state: RaceState, r: RacerState, dt: number): void {
    this.tookDriftRelease = false
    this.sinceAny += dt
    for (const k in this.cooldown) this.cooldown[k as Kind] += dt

    this.decide(state, r, dt)
    this.animate(dt)
  }

  /**
   * Everything that decides whether a line goes up. Nothing here touches the
   * DOM; it all funnels through `say()`, which owns the restraint rules.
   */
  private decide(state: RaceState, r: RacerState, dt: number): void {
    // Silent outside the race proper, and silent for a finished racer — the
    // victory lap is AI-driven, so there is nothing there to praise. The
    // detectors are still primed on the way past, so re-entering the race
    // cannot fire a line for a change that happened while nobody was watching.
    if (state.phase !== 'racing' || r.finished) {
      this.lastEventFrame = state.frame
      this.lastTier = r.driftTier
      this.lastPos = r.position
      this.lastChain = r.chainStacks
      return
    }
    if (this.level === 'off' || this.viewH < CH.minViewportHeight) return

    // Never talk over a spin-out. The HUD is already printing SPUN OUT.
    const muted = r.spinTime > 0 || r.stunTime > 0 || r.respawnTime > 0
    if (muted) {
      this.lastTier = r.driftTier
      this.lastPos = r.position
      this.lastChain = r.chainStacks
      return
    }

    // Track airtime ourselves: `land` says whether it was clean, not how long
    // the jump was, and a 0.2s hop off a kerb is not a stuck landing.
    if (!r.grounded) this.airborne += dt

    // --- the drift ladder ---------------------------------------------------
    const tier = r.driftTier
    if (tier > this.lastTier && tier >= 0 && r.driftSide !== 0) {
      const t = tier > 3 ? 3 : tier
      this.say('tierUp', TIER_UP[t], TIER_COLOR[t])
    }
    this.lastTier = tier

    // Before the cash-in, and at the same priority, so completing a chain gets
    // the chain line instead of the release line it always coincides with.
    if (r.chainStacks > this.lastChain && r.chainStacks >= CH.chainMin) {
      this.say('chain', this.pick('chain', CHAIN), '#22d3ff', 2)
    }
    this.lastChain = r.chainStacks

    // --- events -------------------------------------------------------------
    const fresh = state.frame !== this.lastEventFrame
    this.lastEventFrame = state.frame
    const ev = fresh ? r.events : EMPTY
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i]
      if (e.t === 'driftEnd') {
        // THE CASH-IN, read off `driftEnd` rather than off `boost`. The boost
        // event looks like the obvious hook and is not: applyBoost only takes
        // the LARGEST magnitude, so a Flare release while a Nitro is still
        // running leaves boostSource at 'item' and a source test silently
        // drops the line. `driftEnd.tier` is the tier the slide actually
        // reached, always, and a trick landing raises `boost` without it.
        const t = e.tier > 3 ? 3 : e.tier
        if (t < CH.cashMinTier) continue
        if (this.level === 'key' && t < KEY_CASH_MIN_TIER) continue
        if (this.say('cash', this.pick('cash' + t, CASH[t]), TIER_COLOR[t], t)) {
          this.tookDriftRelease = true
        }
      } else if (e.t === 'land') {
        if (e.clean && this.airborne >= CH.airMin) {
          this.say('air', this.pick('air', AIR), '#2fe36b')
        }
        this.airborne = 0
      } else if (e.t === 'beamHit') {
        if (e.lethal) this.say('beam', this.pick('beam', BEAM), '#ff8b2f')
      }
    }

    // --- position -----------------------------------------------------------
    // After the events, so a cash-in that produced the overtake gets to speak
    // first and the overtake line does not stamp on it at equal priority.
    const pos = r.position
    if (this.lastPos > 0 && pos < this.lastPos) {
      if (pos === 1) this.say('lead', this.pick('lead', LEAD), '#ffd23f')
      else this.say('overtake', this.pick('overtake', OVERTAKE), '#7dffb4')
    }
    this.lastPos = pos

    void state
  }

  /** Round-robin through a phrase list so the same words never repeat. */
  private pick(key: string, list: string[]): string {
    if (list.length === 0) return ''
    const i = (this.cursor[key] ?? -1) + 1
    this.cursor[key] = i
    return list[i % list.length]
  }

  /**
   * The restraint valve. Three gates, in order:
   *   1. the per-kind cooldown, so no single kind can become wallpaper;
   *   2. the global minimum gap, so two different kinds cannot stack;
   *   3. priority, so a live line is only replaced by a strictly bigger one.
   *
   * A line that fails any of them is DROPPED, never queued. A queue would mean
   * praise arriving in a corner it has nothing to do with.
   */
  comboRung(rung: number): void {
    if (rung < 0 || rung >= COMBO.length) return
    // Tier 3 presentation from the fourth rung up: by then the run is a bigger
    // statement than any single slide in it, and the ladder should say so.
    this.say('combo', COMBO[rung], COMBO_COLOR[rung] ?? '#ffffff', rung >= 3 ? 3 : rung)
  }

  private say(kind: Kind, text: string, color: string, tier = -1): boolean {
    if (!text) return false
    const prio = CH.priority[kind]
    if (this.level === 'key' && prio < 3) return false
    if (this.cooldown[kind] < CH.cooldown[kind]) return false
    const live = this.holdT > 0 || this.fadeT > 0
    if (live && prio <= this.shownPriority) return false
    if (!live && this.sinceAny < CH.minGap) return false

    this.cooldown[kind] = 0
    this.sinceAny = 0
    this.shownPriority = prio
    // AFTER the gates, so the voice says exactly what the screen says. A hook
    // placed before them would speak lines that were dropped for being too
    // frequent, which is the failure this whole valve exists to prevent.
    this.onLine(kind as CheerKind)
    this.holdT = CH.hold
    this.fadeT = 0
    this.riseT = this.reduced ? 0 : CH.rise

    if (text !== this.lastText) { this.lastText = text; this.line.textContent = text }
    if (color !== this.lastColor) {
      this.lastColor = color
      this.root.style.setProperty('--cc', color)
      // The soft outer halo, in the line's own hue at 55%. Written from here
      // rather than composed in CSS because color-mix() is not old enough for
      // the device floor, and a text-shadow list that fails to parse takes the
      // DARK OUTLINE down with it -- which is the half that keeps this legible
      // over a white sky.
      this.root.style.setProperty('--cg', rgba(color, 0.55))
      // The shockwave, in the same hue and much weaker. It is a wash over
      // several hundred pixels of sky rather than a stroke on a glyph, so it
      // gets a fraction of the halo's alpha; the tier ladder in styles.css
      // scales it from there and zeroes it below Nova.
      this.root.style.setProperty('--cw', rgba(color, 0.26))
    }
    // Tier drives the whole ladder: size, the amplitude of the entrance stamp,
    // whether there is a shockwave at all, and whether the glyphs get their
    // chromatic fringe. styles.css hangs all four off this one attribute.
    const w = tier >= 0 ? tier : prio >= 4 ? 3 : prio >= 3 ? 2 : 0
    this.root.dataset.w = String(w)
    // Restart the entrance. Under reduced motion the CSS refuses to run it at
    // all, so this is a no-op there rather than something to branch on.
    this.beat ^= 1
    this.root.dataset.beat = String(this.beat)
    if (!this.wasVisible) { this.wasVisible = true; this.root.hidden = false }
    return true
  }

  private animate(dt: number): void {
    if (this.riseT > 0) {
      this.riseT -= dt
      if (this.riseT < 0) this.riseT = 0
    }
    if (this.holdT > 0) {
      this.holdT -= dt
      if (this.holdT <= 0) { this.holdT = 0; this.fadeT = CH.fade }
    } else if (this.fadeT > 0) {
      this.fadeT -= dt
      if (this.fadeT <= 0) { this.fadeT = 0; this.clear(); return }
    } else {
      return
    }

    const rise = this.riseT > 0 ? 1 - this.riseT / Math.max(1e-4, CH.rise) : 1
    const out = this.holdT > 0 ? 1 : this.fadeT / Math.max(1e-4, CH.fade)
    const k = Math.min(rise, out)
    // Opacity is the ONLY channel this loop drives, in both motion modes. The
    // arrival is a CSS animation on the line itself, so a reduced-motion
    // player gets exactly this fade over an element sitting at its resting
    // transform -- and the resting transform is the identity, so an animation
    // that never runs cannot park anything off screen or at zero.
    this.root.style.setProperty('--k', k.toFixed(3))
  }

  private clear(): void {
    this.holdT = 0
    this.fadeT = 0
    this.riseT = 0
    this.shownPriority = 0
    if (this.wasVisible) { this.wasVisible = false; this.root.hidden = true }
  }
}

export function createCheer(host: HTMLElement): Cheer {
  return new CheerImpl(host)
}
