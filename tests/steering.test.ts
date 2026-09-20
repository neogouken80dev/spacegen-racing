import { describe, it, expect } from 'vitest'
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { RUSTFALL } from '../src/content/tracks/rustfall'
import { resetAI } from '../src/sim/ai'
import { emptyInput } from '../src/sim/types'
import type { SimConfig } from '../src/sim/types'

/**
 * Steering direction, asserted against the same basis the renderer uses.
 *
 * The chase camera looks along the vehicle's forward vector, so what the
 * player sees as "right" is `forward x up` — which is also how Track defines
 * its own `right`. A positive lateral offset therefore means the car moved to
 * the player's right. This caught a real inversion where the vehicle used +X
 * as right while the track and camera both used -X.
 */
const cfg = (): SimConfig => ({
  seed: 1, totalLaps: 3, racerCount: 1, trackId: 'rustfall',
  chassisIds: ['solaire'], pilotIds: [''],
  localRacerIndex: 0, aiSkill: [0],
})

function driveWithSteer(steer: number, seconds: number) {
  resetAI()
  const track = new Track(RUSTFALL)
  const race = new Race(track, cfg())
  const r = race.state.racers[0]

  // Skip the countdown so the throttle is live.
  while (race.state.phase === 'countdown') race.step()

  const startLateral = r.lateral
  const input = emptyInput()
  input.throttle = 1
  input.steer = steer
  for (let f = 0; f < Math.round(seconds * 60); f++) {
    race.setInput(0, input)
    race.step()
  }
  return { lateralDelta: r.lateral - startLateral, racer: r, track }
}

describe('steering direction', () => {
  it('steering right (+1) moves the car to the player right', () => {
    const { lateralDelta } = driveWithSteer(1, 1.6)
    expect(lateralDelta).toBeGreaterThan(1.5)
  })

  it('steering left (-1) moves the car to the player left', () => {
    const { lateralDelta } = driveWithSteer(-1, 1.6)
    expect(lateralDelta).toBeLessThan(-1.5)
  })

  it('left and right are mirror images of each other', () => {
    const right = driveWithSteer(1, 1.2).lateralDelta
    const left = driveWithSteer(-1, 1.2).lateralDelta
    expect(Math.abs(right + left)).toBeLessThan(Math.abs(right) * 0.35)
  })

  it('no steering holds the racing line', () => {
    const { lateralDelta } = driveWithSteer(0, 1.6)
    expect(Math.abs(lateralDelta)).toBeLessThan(1.5)
  })

  it('the vehicle right basis matches the track right basis', () => {
    const track = new Track(RUSTFALL)
    for (const s of [0, 300, 900, 1500, 2100]) {
      const smp = track.at(s)
      const yaw = track.yawAt(s)
      // forward x up, the definition vehicle.ts and Track must agree on.
      const rx = -Math.cos(yaw)
      const rz = Math.sin(yaw)
      const dot = rx * smp.right.x + rz * smp.right.z
      expect(dot).toBeGreaterThan(0.9)
    }
  })
})


// ---------------------------------------------------------------------------
/**
 * THE LEFT STEERING THUMBPAD.
 *
 * Pinned here rather than in a touch-specific file because this is steering:
 * it is the only path by which a phone player's thumb becomes the `steer` the
 * block above asserts on, and it had been retuned three times without a single
 * test standing behind any of the numbers.
 *
 * Everything below is mobile-only by construction. `axisCurve` (the gamepad's
 * stick) and `STEER_RAMP` (the keyboard, the gamepad d-pad and the touch arrow
 * pads) are asserted unchanged at the bottom, and no value here reaches the
 * simulation, the AI or the replay harness -- which is why this pass moved no
 * determinism hash and no lap pin.
 */
import {
  axisCurve, STEER_RAMP, STICK_GAIN_RANGE, STICK_OVERTRAVEL, STICK_RADIUS,
  STICK_RIM_LOCK, STICK_THROW_RANGE, stickOvertravel, stickSteerFrom,
  type StickTune,
} from '../src/game/touchControls'
import * as touch from '../src/game/touchControls'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = readFileSync(resolve(__dirname, '../src/game/touchControls.ts'), 'utf8')

/** Defaults spelled out, so a test can vary one axis without writing both. */
const tune = (gain = 1, thr = 1): StickTune => ({ gain, throw: thr })

/**
 * The 0.80 the rim was DESIGNED to sit at, which is not STICK_RIM_LOCK.
 *
 * STICK_RIM_LOCK is asked of the curve at 29px and reads 0.80947, because 29
 * is 28.6031 rounded up to a whole pixel. Tests that ask "where was 0.80 on
 * the old build" must use this literal: reaching for the constant instead
 * makes the question circular -- it asks where the curve reaches the value the
 * curve gives at 29px, and answers 29px, every time, whatever is broken.
 */
const RIM_TARGET = 0.80

/**
 * THE 38px BUILD, THE ONE THIS PASS CLAIMS NOT TO HAVE CHANGED THE FEEL OF.
 *
 * This is the only replica of shipping arithmetic anywhere in these tests, and
 * it is here for the one reason that justifies one: the code it copies no
 * longer exists. `stickSteerFrom` cannot be asked what the previous build
 * returned, and "the comfortable range did not move" is a claim about the
 * previous build. A frozen copy is the only instrument that can check it --
 * and being frozen is a feature, not a risk: it must NOT follow
 * touchControls.ts, or it stops being a record of what shipped.
 *
 * It is `stickCurve(|dx| / 38, 0.08)` -- the curve unchanged, the travel 38px,
 * the rim at full lock.
 *
 * IT NOW AGREES WITH THE SHIPPING FUNCTION TO THE BIT inside the well, which
 * is the whole point and is NOT a reason to delete it and call the shipping
 * function twice. The claim under test is "this is the same arithmetic the
 * 38px build did", and a test that asks the new code what the new code does
 * cannot fail. This replica is the second opinion; it is worth its upkeep
 * exactly while it is written independently of the thing it checks.
 */
function lockAt38(dx: number): number {
  const a = Math.abs(dx) / 38
  if (a <= 0.08) return 0
  let n = (a - 0.08) / 0.92
  if (n > 1) n = 1
  const out = 1.35 * n - 0.35 * n * n
  return dx < 0 ? -out : out
}

/** Smallest px at which `hit` is already true. `hit` must be monotonic. */
function pxWhere(hit: (px: number) => boolean, hi = 400): number {
  if (!hit(hi)) return -1
  if (hit(0)) return 0
  let lo = 0
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) / 2
    if (hit(m)) hi = m
    else lo = m
  }
  return (lo + hi) / 2
}

/** Every setting the two dials offer, at the resolution the steppers move in. */
function everyTune(): StickTune[] {
  const out: StickTune[] = []
  for (let g = STICK_GAIN_RANGE.min; g <= STICK_GAIN_RANGE.max + 1e-9; g += 0.05) {
    for (let t = STICK_THROW_RANGE.min; t <= STICK_THROW_RANGE.max + 1e-9; t += 0.05) {
      out.push({ gain: Math.round(g * 100) / 100, throw: Math.round(t * 100) / 100 })
    }
  }
  return out
}

describe('the touch thumbpad anchors where the thumb lands and stays there', () => {
  it('has no origin to drag any more', () => {
    // THE BUG, in the only form a unit test can hold it. Vince, on a tablet:
    // "when i reach beyond the bounds of the steering joypad, the joypad
    // starts to move along with my finger. This should not be the behavior."
    // The mechanism was `stickOrigin`, a helper that re-zeroed the anchor once
    // the thumb passed full travel. Its absence from the module is the
    // load-bearing half of the fix.
    expect('stickOrigin' in touch).toBe(false)
    expect(SRC).not.toMatch(/export function stickOrigin/)
  })

  it('reads its anchor once, in pointerdown, and never again', () => {
    // THE REST OF THE FIX IS IN AN EVENT HANDLER, which no unit test can reach
    // without a DOM -- the same blind spot that let the dx/dy coupling ship.
    // So this reads the handler instead, and asserts the two things that make
    // the anchor fixed: pointerdown is the ONLY writer of the anchor fields,
    // and pointermove derives its displacement from them by subtraction.
    const down = /const down = \(ev: Event\): void => \{[\s\S]*?\n    \}/.exec(
      SRC.slice(SRC.indexOf('private bindStick')),
    )
    const move = /const move = \(ev: Event\): void => \{[\s\S]*?\n    \}/.exec(
      SRC.slice(SRC.indexOf('private bindStick')),
    )
    expect(down).not.toBeNull()
    expect(move).not.toBeNull()
    expect(down![0]).toContain('this.stickOx = e.clientX')
    expect(down![0]).toContain('this.stickOy = e.clientY')
    expect(move![0]).toContain('const dx = e.clientX - this.stickOx')
    // The assignment form, not the read form: `stickOx =` anywhere in move is
    // the bug coming back.
    expect(move![0]).not.toMatch(/this\.stickO[xy]\s*=[^=]/)
  })

  it('does not let the two axes back into the same calculation', () => {
    // REGRESSION GUARD, carried over from the pass that found it. The clamp
    // used to be applied to the (dx, dy) VECTOR, which silently capped steer
    // at cos(angle) -- 0.698 on a 45-degree push -- and a thumb pivoting about
    // its knuckle is always off-axis. dy may move the KNOB (it does, so the
    // drawn control follows the thumb round the rim) and may reach nothing
    // else.
    const move = /const move = \(ev: Event\): void => \{[\s\S]*?this\.stickSteer = [^\n]*/
      .exec(SRC.slice(SRC.indexOf('private bindStick')))
    expect(move).not.toBeNull()
    expect(move![0]).toContain('stickSteerFrom(dx, this.tune)')
    expect(move![0]).not.toMatch(/hypot|Math\.sqrt|dx \* dx|dy \* dy/)
  })

  it('steers on dx alone, however far off-axis the thumb travels', () => {
    // The consequence of the above, stated in the units of the report. With
    // the vector clamp in place an off-axis push had a CEILING of cos(angle)
    // -- 0.698 at 45 degrees, unreachable however hard the player leaned. It
    // has none now: every angle reaches exactly full lock, it just costs more
    // sweep to get there, because only the x component of the sweep counts.
    for (const deg of [0, 15, 30, 45, 60]) {
      const t = (deg * Math.PI) / 180
      expect(stickSteerFrom(200 * Math.cos(t))).toBe(1)
      expect(stickSteerFrom(-200 * Math.cos(t))).toBe(-1)
    }
    // And that is the whole of the cost: sweep / cos(angle), nothing else.
    // 47px of travel to full lock on the axis becomes 66px at 45 degrees and
    // 94px at 60 -- which is why probe-stick reports the sweep rather than the
    // ceiling now that the ceiling is always 1.
    for (const deg of [0, 30, 45, 60]) {
      const t = (deg * Math.PI) / 180
      const sweep = pxWhere((s) => stickSteerFrom(s * Math.cos(t)) >= 1)
      expect(sweep).toBeCloseTo((STICK_RADIUS + STICK_OVERTRAVEL) / Math.cos(t), 4)
    }
    // A thumb pivoting about its knuckle, both directions: a left-hand thumb
    // arcs one way and the mirrored grip the other.
    for (const reach of [120, 160, 200, 260]) {
      const dx = reach * Math.sin(120 / reach)
      expect(stickSteerFrom(dx)).toBe(1)
      expect(stickSteerFrom(-dx)).toBe(-1)
    }
  })
})

describe('the well returns the lock the 38px build returned', () => {
  it('but the rim is at 28.60px, and STICK_RADIUS is 29', () => {
    // VERIFIED, NOT TAKEN ON TRUST, because the whole case for this pass being
    // free is this number. Solving 1.35n - 0.35n^2 = 0.80 gives n = 0.731210,
    // so a = 0.08 + 0.731210 * 0.92 = 0.752713, so 28.6031px at a 38px travel.
    // The file's own working says 28.6 and the constant says 29.
    const px80 = pxWhere((px) => lockAt38(px) >= RIM_TARGET)
    expect(px80).toBeCloseTo(28.6031, 3)
    // 0.40px long. Sub-pixel on the drawn well and far inside a thumb's own
    // placement error, so it is not worth a fight -- but it is a rounding, and
    // "29 is where 0.80 already was" is true to within 1.4% rather than
    // exactly. This pins the gap so it cannot quietly grow.
    expect(STICK_RADIUS - px80).toBeLessThan(0.5)
    expect(STICK_RADIUS - px80).toBeGreaterThan(0)
  })

  it('lands the rim on the rim lock, which is derived rather than typed', () => {
    // STICK_RIM_LOCK USED TO BE THE LITERAL 0.80 AND IS NOW ASKED OF THE
    // CURVE, so it reads 0.80947: the rim is at 29px, 29px is 28.6031 rounded
    // up, and the curve at 29px says 0.80947. A hand-typed 0.80 was a second
    // opinion about where the rim is, and the test below could only hold it
    // true by scaling the whole well's output to meet it -- which is the refit
    // this pass removed. Deriving it is what lets the well keep the shipped
    // mapping AND the drawn rim stay honest at the same time.
    expect(stickSteerFrom(0)).toBe(0)
    expect(stickSteerFrom(STICK_RADIUS)).toBe(STICK_RIM_LOCK)
    expect(stickSteerFrom(-STICK_RADIUS)).toBe(-STICK_RIM_LOCK)
    // Still the 0.80 the design asked for, to within the pixel rounding, and
    // above it rather than below -- the rim is 0.40px PAST where 0.80 is.
    expect(STICK_RIM_LOCK).toBeGreaterThan(RIM_TARGET)
    expect(STICK_RIM_LOCK - RIM_TARGET).toBeLessThan(0.01)
  })

  it('returns the old build\'s lock exactly, not nearly, at every px in the well', () => {
    // THIS ASSERTED "WITHIN 0.034" AND THE 0.034 WAS A BUG REPORT.
    //
    // The well used to refit the WHOLE CURVE into the shorter radius and scale
    // its output by 0.80, which is not the same operation as leaving the
    // mapping alone and moving the rim inward to meet it: f(n) = 1.35n -
    // 0.35n^2 is quadratic, so compressing its domain by 0.7312 and scaling
    // its range by 0.80 do not cancel. Three contributions, largest first:
    //   0.0329  the refit, worst at 9.1px, about +15% of the lock the old pad
    //           gave a player there.
    //   0.0126  the rest shoulder, which was a FRACTION of the travel, so
    //           38 -> 29 quietly took it from 3.04px to 2.32px.
    //   0.0095  the 0.40px rounding of 28.6031 up to 29.
    //
    // All three are closed. STICK_CURVE_SPAN holds the curve's domain at 38 so
    // the rim is a label on it rather than a rescaling of it; STICK_REST_PX
    // holds the shoulder in pixels; and STICK_RIM_LOCK is asked of the curve
    // rather than typed, so the rounding lands in the rim's LABEL instead of
    // in the lock every thumb distance returns.
    //
    // So the bound is ONE ULP rather than 0.034, and the remaining ulp is
    // arithmetic order, not a difference of function: this file writes the
    // shoulder as the literal 0.92 and the shipping code computes 1 - 0.08,
    // which round to doubles one ulp apart. Worst measured 1.110e-16 at
    // 17.55px. A tolerance any looser is room for the refit to creep back.
    let worst = 0
    let at = 0
    for (let px = 0; px <= STICK_RADIUS; px += 0.05) {
      const d = Math.abs(stickSteerFrom(px) - lockAt38(px))
      if (d > worst) { worst = d; at = px }
    }
    expect(worst).toBeLessThanOrEqual(Number.EPSILON)
    expect(at).toBeGreaterThan(5)
  })

  it('keeps ordinary cornering inside the well and pays for it at the limit', () => {
    // THE MEASUREMENT THAT PICKED 38 IN THE FIRST PLACE, restated against the
    // new travel -- and the one place this pass is not free.
    //
    // probe-stick.ts chains the corner radius of every curved 10m of three
    // circuits to the lock it demands. The three quantiles it reports were
    // 19 / 31 / 43px on the 50px build; the last pass pulled them to
    // 15 / 22 / 32. Measured against THAT build, this one moves them:
    //
    //   median  0.43   15.288px -> 15.288px    0.00   unmoved, inside the well
    //   p90     0.64   22.390px -> 22.390px    0.00   unmoved, inside the well
    //   p99     0.88   32.085px -> 35.663px   +3.58   PAST THE RIM
    //   0.95           35.414px -> 42.276px   +6.86   PAST THE RIM
    //
    // THE FIRST TWO ROWS ARE THE POINT. Everything a player does most is not
    // approximately where it was, it is at the same double, because the well
    // still evaluates the 38px curve and only the rim's label moved. An
    // earlier draft of this pass refit the curve and those rows read -0.94 and
    // -0.56; small, in the helpful direction, and still a change nobody asked
    // for to the part of the stroke that carries a whole lap.
    //
    // The cost is all at the top and it is real: 0.88 is 3.6px further out and
    // 0.95 is 6.9px, because the top fifth of the lock now occupies 18px
    // instead of 9.4. The tightest corners cost more reach and are twice as
    // easy to hold once reached. A trade, not a free win, and past about 40px
    // the pad stops being reachable from a resting grip at all -- which is
    // what the previous two retunes were both reports of.
    const pxFor = (s: number): number => pxWhere((px) => stickSteerFrom(px) >= s)
    const pxOld = (s: number): number => pxWhere((px) => lockAt38(px) >= s)
    expect(pxFor(0.43)).toBe(pxOld(0.43))
    expect(pxFor(0.64)).toBe(pxOld(0.64))
    expect(pxFor(0.88)).toBeGreaterThan(pxOld(0.88))
    expect(pxFor(0.88)).toBeLessThan(37)
    expect(pxFor(0.95)).toBeLessThan(43)
    expect(pxFor(1)).toBe(STICK_RADIUS + STICK_OVERTRAVEL)
  })

  it('is fast-early, so a corner is not held at the end of the stroke', () => {
    // Half the travel returns more than half the lock, which is what the
    // 88%-linear-plus-smoothstep curve this replaced did not: smoothstep is
    // slow-early, so it took slope from the start of the stroke and gave it to
    // the end -- backwards for a pad whose corners live in the first two
    // thirds and whose full lock is 1-2% of a lap's frames. Half the WELL is
    // 14.5px, which is 0.38 of the curve's own 38px domain, so "more than
    // half" lands at 0.4049 -- a thinner margin than it looks, and the reason
    // it is asserted against the well rather than against the domain.
    expect(stickSteerFrom(STICK_RADIUS * 0.5)).toBeGreaterThan(0.40)
    expect(stickSteerFrom(STICK_RADIUS * 0.5)).toBeCloseTo(0.4049, 4)
  })
})

describe('the overtravel band carries the last fifth of the lock', () => {
  it('reaches exactly 1.0 at the end of the band and then holds', () => {
    // THE POINT OF THE BAND. 0.80 -> 1.00 used to be 29-38px: nine pixels for
    // the whole top fifth of the lock. It is 18px now, twice the travel for
    // the same fifth, so 0.85, 0.90 and 0.95 are places a thumb can sit.
    expect(stickSteerFrom(STICK_RADIUS + STICK_OVERTRAVEL)).toBeCloseTo(1, 12)
    // And nothing above it. There is no steering past full lock and a control
    // that kept climbing would be lying about the car.
    for (const px of [48, 60, 90, 200, 4000]) {
      expect(stickSteerFrom(px)).toBe(1)
      expect(stickSteerFrom(-px)).toBe(-1)
    }
  })

  it('is linear across the band, so the same push means the same thing', () => {
    // Linear on purpose: this is the band the player modulates by feel with no
    // rim to brace against, and a curve here would make an identical push mean
    // different amounts at different depths.
    for (let f = 0; f <= 1.0001; f += 0.125) {
      const px = STICK_RADIUS + STICK_OVERTRAVEL * f
      expect(stickSteerFrom(px)).toBeCloseTo(STICK_RIM_LOCK + (1 - STICK_RIM_LOCK) * f, 10)
    }
  })

  it('reports the strain 0 at the rim, 1 at full lock, and saturates', () => {
    // Drives the drawn well and nothing else, which is how a rim that is not
    // full lock stays legible as a control that is still working rather than
    // one that has run out.
    expect(stickOvertravel(0)).toBe(0)
    expect(stickOvertravel(STICK_RADIUS)).toBe(0)
    expect(stickOvertravel(STICK_RADIUS + STICK_OVERTRAVEL / 2)).toBeCloseTo(0.5, 10)
    expect(stickOvertravel(STICK_RADIUS + STICK_OVERTRAVEL)).toBeCloseTo(1, 10)
    expect(stickOvertravel(500)).toBe(1)
    expect(stickOvertravel(-500)).toBe(1)
  })

  it('doubles the resolution the top fifth of the lock used to get', () => {
    // The claim, measured rather than asserted. On the 38px build 0.80 to 1.00
    // occupied 28.60 to 38.00px: 9.4px. It now occupies 18.
    const oldSpan = 38 - pxWhere((px) => lockAt38(px) >= RIM_TARGET)
    const newSpan = pxWhere((px) => stickSteerFrom(px) >= 1)
      - pxWhere((px) => stickOvertravel(px) > 0)
    expect(oldSpan).toBeCloseTo(9.397, 2)
    expect(newSpan).toBeCloseTo(STICK_OVERTRAVEL, 4)
    expect(newSpan / oldSpan).toBeGreaterThan(1.9)
  })
})

describe('the two dials do what their labels say', () => {
  it('gain reshapes the approach and moves neither end of it', () => {
    // "HOW SOON THE LOCK ARRIVES", AND DELIBERATELY NOT "HOW MUCH LOCK".
    //
    // This test used to assert `stickSteerFrom(px) * g` clamped at 1, which is
    // what the dial did and is a HANDICAP wearing a preference's label: below
    // 1.0 it lowered the car's steering ceiling, so a player who nudged a
    // slider marked "sensitivity" was quietly handed a car that could not make
    // the calendar's tightest corner (0.92 of lock; probe-stick measures it).
    // Gain now moves the blend weight instead -- `c = 0.35 + gain` in a
    // response of `c*n + (1-c)*n^2` -- which rearranges to `n^2 + c*n*(1-n)`.
    // Read that way the three claims below are algebra, not tuning:
    //   n*(1-n) is 0 at both ends, so gain cannot move either end;
    //   n*(1-n) > 0 strictly between them, so more gain is more lock there;
    //   at c = 1.35 it is the shipped curve, so the default is a no-op.
    const ends = [0, STICK_RADIUS + STICK_OVERTRAVEL, 60, 400]
    for (const g of [0.5, 0.7, 1, 1.2, 1.4]) {
      // Neither end moves: the rest shoulder, the rim, and full lock are all
      // where they are at the default.
      expect(pxWhere((px) => stickOvertravel(px, tune(g)) > 0)).toBeCloseTo(STICK_RADIUS, 6)
      expect(pxWhere((px) => stickSteerFrom(px, tune(g)) >= 1))
        .toBeCloseTo(STICK_RADIUS + STICK_OVERTRAVEL, 9)
      for (const px of ends) {
        expect(stickSteerFrom(px, tune(g))).toBe(stickSteerFrom(px))
      }
    }
    // Strictly between them, more gain is strictly more lock -- everywhere,
    // not just at a few sampled points. The sweep starts past the rest
    // shoulder and stops short of full lock, because n*(1-n) is zero at both
    // and "strictly" is false there by the same algebra that makes it true
    // here: below 3.04px every setting returns 0, at 47px every setting
    // returns 1, and those are the two ends the dial is not allowed to move.
    for (let px = 3.5; px < STICK_RADIUS + STICK_OVERTRAVEL - 1; px += 0.25) {
      let prev = -1
      for (let g = STICK_GAIN_RANGE.min; g <= STICK_GAIN_RANGE.max + 1e-9; g += 0.05) {
        const v = stickSteerFrom(px, tune(g))
        expect(v).toBeGreaterThan(prev)
        prev = v
      }
    }
    // The size of it, at the places the measured table in touchControls.ts
    // quotes. Wide enough to be a preference, narrow enough not to be a retune.
    expect(stickSteerFrom(15, tune(0.5))).toBeCloseTo(0.308, 3)
    expect(stickSteerFrom(15, tune(1.0))).toBeCloseTo(0.421, 3)
    expect(stickSteerFrom(15, tune(1.4))).toBeCloseTo(0.511, 3)
  })

  it('throw scales the distances, except the rest shoulder, which is a distance', () => {
    // "How far the thumb travels for that lock", and the shape at the same
    // FRACTION of the travel would be identical -- if the whole pad scaled.
    // It does not, on purpose: STICK_REST_PX holds the rest shoulder at
    // 3.04px whatever the pad size, because a thumb's jitter on the glass is
    // the same distance on a big pad as on a small one. So the shoulder is
    // 15% of a 0.70 pad and 6% of a 1.80 one, and a pure-similarity assertion
    // here would be a test demanding the bug back.
    //
    // WHAT IS EXACT: where the band ends. 47px of travel becomes 47t, to 1e-13.
    for (let t = STICK_THROW_RANGE.min; t <= STICK_THROW_RANGE.max + 1e-9; t += 0.05) {
      expect(stickSteerFrom((STICK_RADIUS + STICK_OVERTRAVEL) * t, tune(1, t)))
        .toBeCloseTo(1, 12)
      expect(pxWhere((px) => stickSteerFrom(px, tune(1, t)) >= 1))
        .toBeCloseTo((STICK_RADIUS + STICK_OVERTRAVEL) * t, 9)
    }
    // WHAT IS NEARLY EXACT: the rim. The well runs to 29t and the curve's
    // domain runs to 38t minus a shoulder that does not scale, so the rim
    // drifts a little across the dial -- 0.8012 at 0.70 to 0.8174 at 1.80,
    // against 0.8095 at the default. Under a fiftieth of lock end to end.
    for (let t = STICK_THROW_RANGE.min; t <= STICK_THROW_RANGE.max + 1e-9; t += 0.05) {
      const rim = stickSteerFrom(STICK_RADIUS * t, tune(1, t))
      expect(Math.abs(rim - STICK_RIM_LOCK)).toBeLessThan(0.01)
      expect(rim).toBeGreaterThan(0.80)
      expect(rim).toBeLessThan(0.82)
    }
    // WHAT DRIFTS, AND BY HOW MUCH: the lock at the same fraction of the
    // travel, worst 0.0498 at f = 0.15 on the smallest pad -- which is 3.0px,
    // i.e. exactly at the shoulder, which is where the whole gap lives. A
    // smaller pad gives slightly LESS lock there and a larger one slightly
    // more, both because the fixed shoulder is a different share of the
    // stroke. Bounded so it stays a consequence rather than becoming one.
    let worst = 0
    for (let t = STICK_THROW_RANGE.min; t <= STICK_THROW_RANGE.max + 1e-9; t += 0.01) {
      for (let f = 0; f <= 1.0001; f += 0.002) {
        const d = Math.abs(stickSteerFrom(STICK_RADIUS * t * f, tune(1, t))
          - stickSteerFrom(STICK_RADIUS * f))
        if (d > worst) worst = d
      }
    }
    expect(worst).toBeLessThan(0.05)
  })

  it('leaves the shipped feel exactly where it was at 1.00 on both', () => {
    // The default has to be a no-op or the dials are a retune wearing a
    // settings row. Both formulations of "default", because DEFAULT_STICK_TUNE
    // is what input.ts hands the pad and the bare call is what every other
    // test here uses.
    for (let px = -80; px <= 80; px += 0.5) {
      expect(stickSteerFrom(px, tune(1, 1))).toBe(stickSteerFrom(px))
      expect(stickOvertravel(px, tune(1, 1))).toBe(stickOvertravel(px))
    }
  })

  it('is monotonic, odd and bounded at every setting the dials offer', () => {
    // Across the whole product of the two ranges, not just the corners: a
    // clamp applied in the wrong order, or a divide by a scaled zero, shows up
    // as a kink somewhere in the middle of the grid and nowhere else.
    for (const t of everyTune()) {
      let prev = -1
      for (let px = 0; px <= 140; px += 1) {
        const v = stickSteerFrom(px, t)
        expect(v).toBeGreaterThanOrEqual(prev - 1e-12)
        expect(v).toBeLessThanOrEqual(1)
        expect(stickSteerFrom(-px, t)).toBeCloseTo(-v, 12)
        prev = v
      }
    }
  })

  it('reaches full lock at every setting either dial offers', () => {
    // THE INVARIANT THAT MAKES THESE SLIDERS SAFE TO SHIP, and it replaces a
    // test that pinned the opposite. `gain` used to scale and clamp the
    // output, so 0.60 topped the car out at 0.60 of its steering however far
    // the thumb went, while probe-stick reports the roster's tightest corners
    // demanding 0.88 and up: a settings row could make a circuit
    // unfinishable, and the only warning was a sentence on the row.
    //
    // No setting can cost a player lock now, so there is nothing to warn
    // about. The whole grid, not the corners of it -- a clamp applied in the
    // wrong order shows up in the middle and nowhere else.
    for (const t of everyTune()) {
      expect(stickSteerFrom(1000, t)).toBe(1)
      expect(stickSteerFrom(-1000, t)).toBe(-1)
      // And it arrives at the end of the band, never before it: full lock
      // reached early is the drawn well lying in the other direction.
      const full = pxWhere((px) => stickSteerFrom(px, t) >= 1)
      expect(full).toBeCloseTo((STICK_RADIUS + STICK_OVERTRAVEL) * t.throw, 6)
      expect(stickOvertravel(full, t)).toBeCloseTo(1, 10)
    }
  })
})

describe('a thumb that is only resting on the glass steers nothing', () => {
  it('holds zero at the anchor and just off it, at every setting', () => {
    // 1.5px is inside the narrowest rest shoulder either dial can produce
    // (0.08 x 29 x 0.70 = 1.62px), so this is the form of the claim that is
    // true across the whole grid rather than only at the default.
    //
    // Math.abs, because the negative branch returns -0: `sign * out` with
    // sign -1 and out 0. It is harmless -- the sim only ever adds, subtracts
    // and multiplies it -- but Object.is separates -0 from 0, so asserting
    // `toBe(0)` on it would fail on a value that means exactly "no steering".
    for (const t of everyTune()) {
      expect(Math.abs(stickSteerFrom(0, t))).toBe(0)
      expect(Math.abs(stickSteerFrom(1.5, t))).toBe(0)
      expect(Math.abs(stickSteerFrom(-1.5, t))).toBe(0)
      expect(stickOvertravel(0, t)).toBe(0)
    }
  })

  it('sizes that shoulder as a distance, because that is what jitter is', () => {
    // 3.04px AT EVERY SETTING OF BOTH DIALS, and this test used to assert the
    // opposite while quoting the comment that forbade it.
    //
    // The shoulder was 0.08 of the RADIUS. A fraction of something that can
    // change is a distance waiting to be wrong, and the radius changed twice:
    // 50 -> 38 was caught and the fraction re-cut to match, 38 -> 29 was not,
    // so the shoulder silently went to 2.32px, and the Pad size dial would
    // have taken it to 1.62px at its minimum. A 2.9px resting thumb returned
    // 0 on the shipped build and 0.023 of lock on that one. STICK_REST_PX is
    // a distance now and `restFraction` divides `throw` back out of it, so a
    // bigger pad does not buy a twitchier one.
    const shoulder = (t: StickTune): number => pxWhere((px) => stickSteerFrom(px, t) > 0)
    expect(shoulder(tune())).toBeCloseTo(3.04, 6)
    for (const t of everyTune()) expect(shoulder(t)).toBeCloseTo(3.04, 6)
    // Which is 0.08 x 38, which was 0.06 x 50: the number has not moved since
    // the stick was first tuned, only the units it is kept in.
    expect(shoulder(tune())).toBeCloseTo(0.08 * 38, 6)
  })
})

describe('the drawn control is sized from the travel it actually has', () => {
  it('interpolates the well and the knob from the constants', () => {
    // At 50px of travel in a hard-coded 150px well the knob met the visible
    // rim at ~0.80 of lock and the last fifth lived outside it, which reads as
    // a stick that has run out. The sizes are interpolated now; this fails if
    // either is typed back in as a literal.
    const base = /\.sgtc-base\{width:([^;]+);/.exec(SRC)
    const knob = /\.sgtc-knob\{width:([^;]+);/.exec(SRC)
    expect(base?.[1]).toContain('STICK_RADIUS')
    expect(knob?.[1]).toContain('STICK_KNOB_R')
  })

  it('resizes that well from the Pad size dial rather than leaving it fixed', () => {
    // The same argument one step further on. A dial that changes how far the
    // thumb travels and NOT how big the well is drawn would put the rim
    // somewhere the drawn control does not have one -- the exact lie the
    // sentence above was written about.
    const fn = /private applyTuneToWell\(\): void \{[\s\S]*?\n  \}/.exec(SRC)
    expect(fn).not.toBeNull()
    expect(fn![0]).toContain('STICK_RADIUS + STICK_KNOB_R) * this.tune.throw')
    expect(fn![0]).toContain('STICK_KNOB_R * this.tune.throw')
  })

  it('draws the strain from the same function the steering comes from', () => {
    // `--over` is the only thing left telling the player that leaning harder
    // is still doing something, once the knob has pinned. It has to come from
    // stickOvertravel and not from a second opinion about where the rim is.
    const move = /const move = \(ev: Event\): void => \{[\s\S]*?\n    \}/.exec(
      SRC.slice(SRC.indexOf('private bindStick')),
    )
    expect(move![0]).toContain('stickOvertravel(dx, this.tune)')
    expect(move![0]).toContain("setProperty('--over'")
  })
})

describe('every non-touch steering path is exactly as it was', () => {
  it('leaves the gamepad stick and the digital ramp alone', () => {
    // The gamepad stick keeps its own slow-early shoulder: a physical stick
    // self-centres and is held under tension, so the argument for a fast-early
    // curve on glass does not transfer to it.
    expect(axisCurve(0.5, 0.12)).toBeCloseTo(0.411744, 6)
    expect(axisCurve(1, 0.12)).toBeCloseTo(1, 6)
    // The digital ramp shared by the keyboard, the d-pad and the arrow pads.
    expect(STEER_RAMP.attackTime).toBe(0.120)
    expect(STEER_RAMP.releaseTime).toBe(0.070)
    expect(STEER_RAMP.crossTime).toBe(0.055)
  })

  it('keeps the two dials out of reach of anything but the pad', () => {
    // The tune is a property of the touch control. If it ever reached the sim,
    // the AI or the replay harness, two players with different settings would
    // desync -- and `npx tsx tools/headless.ts --assert` would stop being
    // evidence that this pass moved nothing.
    const sim = readFileSync(resolve(__dirname, '../src/game/input.ts'), 'utf8')
    const sampled = /sample\(\): InputFrame \{[\s\S]*?\n  \}/.exec(sim)
    expect(sampled).not.toBeNull()
    expect(sampled![0]).not.toMatch(/tune|stickTune|StickTune/)
  })
})
