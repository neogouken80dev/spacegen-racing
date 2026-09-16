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
 * block above asserts on, and it had been retuned twice without a single test
 * standing behind either number.
 *
 * Everything below is mobile-only by construction. `axisCurve` (the gamepad's
 * stick) and `STEER_RAMP` (the keyboard, the gamepad d-pad and the touch arrow
 * pads) are asserted unchanged at the bottom, and no value here reaches the
 * simulation, the AI or the replay harness -- which is why this pass moved no
 * determinism hash and no lap pin.
 */
import {
  axisCurve, STEER_RAMP, STICK_RADIUS, stickOrigin, stickSteerFrom,
} from '../src/game/touchControls'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** The two calls the pointermove handler makes, in the order it makes them. */
function thumb(path: Array<[number, number]>): number {
  let ox = path[0][0], oy = path[0][1], steer = 0
  for (let i = 1; i < path.length; i++) {
    ox = stickOrigin(ox, path[i][0])
    oy = stickOrigin(oy, path[i][1])
    steer = stickSteerFrom(path[i][0] - ox)
  }
  return steer
}

/** A thumb pivoting about the knuckle: an arc of `reach` px, swept `d` px. */
function arc(reach: number, d: number, dir = 1): Array<[number, number]> {
  const p: Array<[number, number]> = []
  for (let s = 0; s <= d; s += 2) {
    const phi = s / reach
    p.push([dir * reach * Math.sin(phi), reach * (1 - Math.cos(phi))])
  }
  return p
}

describe('the touch thumbpad maps thumb travel to steer', () => {
  it('reaches exactly full lock at full travel, and saturates there', () => {
    expect(stickSteerFrom(STICK_RADIUS)).toBeCloseTo(1, 6)
    expect(stickSteerFrom(STICK_RADIUS * 2)).toBeCloseTo(1, 6)
    expect(stickSteerFrom(-STICK_RADIUS)).toBeCloseTo(-1, 6)
  })

  it('ignores a thumb that is merely resting on the glass', () => {
    // The rest shoulder is 3.0px and is deliberately an ABSOLUTE distance:
    // jitter under a gripping hand does not scale with the travel, so the
    // 50 -> 38px change moved the deadzone fraction 0.06 -> 0.08 to hold it.
    // Asserted in px, not as a fraction of the travel, because that is the
    // form the claim is actually made in.
    expect(stickSteerFrom(2.9)).toBe(0)
    expect(stickSteerFrom(-2.9)).toBe(0)
    expect(stickSteerFrom(3.2)).toBeGreaterThan(0)
  })

  it('is fast-early, so a corner is not held at the end of the stroke', () => {
    // THE WHOLE POINT OF THE PASS, in its two halves.
    //
    // SHAPE: half the travel now returns MORE than half the lock (0.543). The
    // 88%-linear-plus-smoothstep curve it replaced returned 0.467 -- smoothstep
    // is slow-early, so it took slope from the start of the stroke and gave it
    // to the end, which is backwards for a pad whose corners live in the first
    // two thirds and whose full lock is 1-2% of a lap's frames.
    expect(stickSteerFrom(STICK_RADIUS * 0.5)).toBeGreaterThan(0.50)
    // GAIN: the lock the tightest measured corners demand, in px of thumb.
    // Measured on the 50px build at 38-44px; anything near that here means the
    // travel or the curve has been walked back.
    const pxFor = (s: number) => {
      let px = 0
      while (px < STICK_RADIUS && stickSteerFrom(px) < s) px += 0.05
      return px
    }
    expect(pxFor(0.43)).toBeLessThan(17)   // median curved bin   (was 19px)
    expect(pxFor(0.64)).toBeLessThan(25)   // p90                 (was 31px)
    expect(pxFor(0.88)).toBeLessThan(34)   // tightest corners    (was 43px)
  })

  it('rises monotonically and is an odd function of displacement', () => {
    let prev = -1
    for (let px = 0; px <= STICK_RADIUS + 5; px += 0.5) {
      const v = stickSteerFrom(px)
      expect(v).toBeGreaterThanOrEqual(prev)
      expect(stickSteerFrom(-px)).toBeCloseTo(-v, 10)
      prev = v
    }
  })

  it('still reaches full lock when the thumb travels on an arc, not a ruler', () => {
    // REGRESSION GUARD. The clamp used to be applied to the (dx, dy) vector,
    // which capped steer at cos(angle): 0.915-0.982 on these arcs and 0.698 on
    // a 45-degree push. Both directions, because a left-hand thumb arcs one way
    // and the mirrored grip the other.
    for (const reach of [120, 160, 200, 260]) {
      expect(thumb(arc(reach, 90))).toBeCloseTo(1, 6)
      expect(thumb(arc(reach, 90, -1))).toBeCloseTo(-1, 6)
    }
    const diag: Array<[number, number]> = []
    for (let s = 0; s <= 90; s += 2) diag.push([s * Math.SQRT1_2, s * Math.SQRT1_2])
    expect(thumb(diag)).toBeCloseTo(1, 6)
  })

  it('does not let the two axes back into the same calculation', () => {
    // THE ABOVE ONLY GUARDS THE HELPER. `stickOrigin` takes one scalar, so the
    // coupling cannot come back through it -- but the bug did not live in a
    // helper, it lived in a pointermove handler, which is exactly why nothing
    // caught it. The handler is not reachable from a unit test without a DOM,
    // so this reads it instead: it must combine dx and dy nowhere, and steer
    // through the shared mapping rather than arithmetic of its own.
    const src = readFileSync(resolve(__dirname, '../src/game/touchControls.ts'), 'utf8')
    const move = /Each axis clamps and drags on its own[\s\S]*?this\.stickSteer = [^\n]*/.exec(src)
    expect(move).not.toBeNull()
    expect(move![0]).toContain('stickSteerFrom(dx)')
    expect(move![0]).not.toMatch(/hypot|Math\.sqrt|dx \* dx|dy \* dy/)
  })

  it('drags its origin only once the thumb is past full travel', () => {
    // What lets a long swipe keep steering, and lets the stick be re-aimed
    // mid-corner without lifting.
    expect(stickOrigin(100, 100 + STICK_RADIUS - 1)).toBe(100)
    expect(stickOrigin(100, 100 + STICK_RADIUS + 25)).toBe(100 + 25)
    expect(stickOrigin(100, 100 - STICK_RADIUS - 25)).toBe(100 - 25)
  })

  it('draws a well the size of the travel it actually has', () => {
    // At 50px of travel in a hard-coded 150px well the knob met the visible rim
    // at ~0.80 of lock and the last fifth lived outside it, which reads as a
    // stick that has run out. The sizes are interpolated from the constants
    // now; this fails if either is typed back in as a literal.
    const src = readFileSync(resolve(__dirname, '../src/game/touchControls.ts'), 'utf8')
    const base = /\.sgtc-base\{width:([^;]+);/.exec(src)
    const knob = /\.sgtc-knob\{width:([^;]+);/.exec(src)
    expect(base?.[1]).toContain('STICK_RADIUS')
    expect(knob?.[1]).toContain('STICK_KNOB_R')
  })

  it('leaves every non-touch steering path exactly as it was', () => {
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
})
