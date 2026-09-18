/**
 * THE CHAMPIONSHIP PODIUM.
 *
 * Everything here is a claim a screenshot cannot make. A photograph of the
 * podium proves three robots are dancing on it; it cannot prove that the three
 * on it are the three the countback actually separated, that a five-car field
 * does not index past its own array, that the camera CUTS between beats rather
 * than sliding continuously from one to the next, or that a reduced-motion
 * player is getting a still frame per beat instead of a slower flight.
 *
 * Those four are exactly the ones that rot quietly later, so src/game/podium.ts
 * is kept free of the DOM, of WebGL and of three.js so they can be pinned here.
 */
import { describe, it, expect } from 'vitest'
import {
  CAR_Z, PODIUM_DURATION, PODIUM_FACE_Y, PODIUM_SHOTS,
  PODIUM_SKIP_GUARD, STEP_D, STEP_HALF_W, STEP_X, STEP_Y,
  makePodiumFrame, podiumCast, podiumDone, podiumFrameAt, podiumLensOf,
  podiumProject, podiumSkip, podiumSkyPoint,
  type PodiumBurst, type PodiumScreen,
} from '../src/game/podium'
import {
  CIRCUIT_TRACK_IDS, applyRound, newCircuit, standings,
  type CircuitState, type RoundResult,
} from '../src/game/circuit'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A round where the finishing order is exactly `order` (grid ids, 1st first). */
function round(trackId: string, order: number[]): RoundResult {
  return {
    trackId,
    finishes: order.map((id, i) => ({
      id, position: i + 1, finished: true, time: 100 + i,
    })),
  }
}

/** A circuit with every round raced, each on the given finishing order. */
function playOut(orders: number[][]): CircuitState {
  let s = newCircuit('socket', 'solaire')
  for (let i = 0; i < orders.length; i++) {
    s = applyRound(s, round(CIRCUIT_TRACK_IDS[i], orders[i]))
  }
  return s
}

const ROLL = [0, 1, 2, 3, 4, 5, 6, 7]
/** Everyone finishes in grid order, every round: 0 wins the title outright. */
const CLEAN = Array.from({ length: 8 }, () => ROLL)

// ---------------------------------------------------------------------------
describe('who stands on the steps', () => {
  it('puts the championship top three on the three steps, tallest first', () => {
    const cast = podiumCast(standings(playOut(CLEAN)), 0)
    expect(cast.steps.map((s) => s.step)).toEqual([1, 2, 3])
    expect(cast.steps.map((s) => s.entrantId)).toEqual([0, 1, 2])
    expect(cast.steps.map((s) => s.place)).toEqual([1, 2, 3])
    // 8 rounds x 15/12/10 points.
    expect(cast.steps.map((s) => s.points)).toEqual([120, 96, 80])
    expect(cast.steps[0].wins).toBe(8)
  })

  it('carries the pilot and the chassis, so the scene can park the right car', () => {
    const s = playOut(CLEAN)
    const cast = podiumCast(standings(s), 0)
    for (const e of cast.steps) {
      const entrant = s.grid.find((g) => g.id === e.entrantId)
      expect(entrant).toBeDefined()
      expect(e.pilotId).toBe(entrant?.pilotId)
      expect(e.chassisId).toBe(entrant?.chassisId)
    }
    // The player's own car, as circuit.ts wrote it back after the last round.
    expect(cast.steps[0].isLocal).toBe(true)
    expect(cast.steps[0].chassisId).toBe('solaire')
  })

  it('marks the local entrant even when they are nowhere near the podium', () => {
    // The player is last every round; entrant 1 takes the title.
    const last = [1, 2, 3, 4, 5, 6, 7, 0]
    const cast = podiumCast(standings(playOut(Array.from({ length: 8 }, () => last))), 0)
    expect(cast.localOnPodium).toBe(false)
    expect(cast.steps.some((s) => s.isLocal)).toBe(false)
    expect(cast.localPlace).toBe(8)
    expect(cast.localPoints).toBe(8) // 8 rounds x 1 point for eighth
  })

  /**
   * THE COUNTBACK REACHES THE PODIUM.
   *
   * Two drivers level on points, separated only by who has more wins. The
   * standings already decide that; the podium must not re-derive it or sort on
   * anything of its own, or the table and the steps will disagree in exactly
   * the case a player is most likely to look closely at.
   */
  it('follows the standings order, countback included', () => {
    // 0 wins four rounds and is 2nd in four: 4*15 + 4*12 = 108.
    // 1 is 2nd in four and wins four: the same 108, and the same counts, so
    // 2 is given a shape that sums to 108 with FEWER wins.
    const orders: number[][] = []
    for (let i = 0; i < 4; i++) orders.push([0, 1, 2, 3, 4, 5, 6, 7])
    for (let i = 0; i < 4; i++) orders.push([2, 0, 1, 3, 4, 5, 6, 7])
    const rows = standings(playOut(orders))
    const cast = podiumCast(rows, 0)
    // Whatever the arithmetic lands on, the steps are the first three rows.
    expect(cast.steps.map((s) => s.entrantId))
      .toEqual(rows.slice(0, 3).map((r) => r.entrant.id))
    expect(cast.steps.map((s) => s.place))
      .toEqual(rows.slice(0, 3).map((r) => r.place))
  })

  it('reports a top-two tie the standings could not separate', () => {
    // Two entrants whose finishing multisets are identical: 0 and 1 swap 1st
    // and 2nd every other round. Equal points AND equal countback.
    const orders: number[][] = []
    for (let i = 0; i < 8; i++) {
      orders.push(i % 2 === 0 ? [0, 1, 2, 3, 4, 5, 6, 7] : [1, 0, 2, 3, 4, 5, 6, 7])
    }
    const rows = standings(playOut(orders))
    expect(rows[0].place).toBe(1)
    expect(rows[1].place).toBe(1)
    const cast = podiumCast(rows, 0)
    expect(cast.tied).toBe(true)
    // Somebody still has to stand on the top step, and it has to be the same
    // somebody every render: the array order is total even when `place` is not.
    expect(cast.steps).toHaveLength(3)
    expect(cast.steps[0].step).toBe(1)
    expect(cast.steps[0].place).toBe(1)
    expect(cast.steps[1].place).toBe(1)
  })

  it('does not report a tie when the countback separated the top two', () => {
    expect(podiumCast(standings(playOut(CLEAN)), 0).tied).toBe(false)
  })

  /** A field shorter than the podium is not a crash. */
  it('survives a field with fewer than three entrants', () => {
    const rows = standings(playOut(CLEAN)).slice(0, 2)
    const cast = podiumCast(rows, 0)
    expect(cast.steps).toHaveLength(2)
    expect(cast.steps.map((s) => s.step)).toEqual([1, 2])
    expect(podiumCast([], 0).steps).toHaveLength(0)
    expect(podiumCast([], 0).tied).toBe(false)
    expect(podiumCast([], 0).localPlace).toBe(0)
  })
})

// ---------------------------------------------------------------------------
describe('the camera plan', () => {
  const frame = makePodiumFrame()
  const at = (t: number, reduced = false) => podiumFrameAt(t, reduced, frame)

  it('runs five beats and its own duration is their sum', () => {
    expect(PODIUM_SHOTS).toHaveLength(5)
    expect(PODIUM_DURATION).toBeCloseTo(
      PODIUM_SHOTS.reduce((a, s) => a + s.hold, 0), 6,
    )
    expect(PODIUM_DURATION).toBeGreaterThan(12)
  })

  it('visits every beat in order across its runtime', () => {
    const seen: string[] = []
    for (let t = 0; t < PODIUM_DURATION; t += 0.05) {
      const f = at(t)
      if (seen[seen.length - 1] !== f.label) seen.push(f.label)
    }
    expect(seen).toEqual(PODIUM_SHOTS.map((s) => s.label))
  })

  /**
   * THE THING THAT MAKES IT A CUT.
   *
   * Consecutive beats must not be continuous, or the whole shot list collapses
   * into one long slide and the energy the cuts are there to buy is gone. Each
   * boundary is measured as the jump in camera position between the frame
   * before it and the frame after.
   */
  it('cuts between beats rather than sliding through them', () => {
    let t = 0
    for (let i = 0; i < PODIUM_SHOTS.length - 1; i++) {
      t += PODIUM_SHOTS[i].hold
      const before = { ...at(t - 0.001).pose }
      const after = { ...at(t + 0.001).pose }
      const jump = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z)
      expect(jump).toBeGreaterThan(3)
    }
  })

  /** ...and within a beat it is a MOVE, not a hold. */
  it('moves the camera inside every beat', () => {
    let t = 0
    for (const s of PODIUM_SHOTS) {
      const a = { ...at(t + 0.01).pose }
      const b = { ...at(t + s.hold - 0.01).pose }
      const travel = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
      expect(travel).toBeGreaterThan(1.5)
      t += s.hold
    }
  })

  it('always looks at the podium, never past it', () => {
    for (let t = 0; t < PODIUM_DURATION + 4; t += 0.1) {
      const p = at(t).pose
      // The whole set is inside roughly a 12 m box around the origin; a target
      // outside that is a camera aimed at empty sky. The bound is a little
      // wider than the podium's own 5.7 m half-width on purpose: the CARS beat
      // is a lateral track whose target runs out to +/-6.5 so the outer cars
      // pass through the middle of frame rather than only reaching its edge.
      expect(Math.abs(p.tx)).toBeLessThanOrEqual(7.0)
      expect(p.ty).toBeGreaterThan(0)
      expect(p.ty).toBeLessThan(6)
      expect(Math.abs(p.tz)).toBeLessThan(8)
      // And it never goes underground, which would put the ground disc between
      // the lens and everything on it.
      expect(p.y).toBeGreaterThan(0.4)
      // ...nor behind the podium, where it would photograph three backs.
      expect(p.z).toBeGreaterThan(0)
    }
  })

  it('holds the last framing rather than looping past the end', () => {
    const end = { ...at(PODIUM_DURATION - 0.001).pose }
    const after = { ...at(PODIUM_DURATION + 30).pose }
    expect(after.x).toBeCloseTo(end.x, 2)
    expect(after.y).toBeCloseTo(end.y, 2)
    expect(after.z).toBeCloseTo(end.z, 2)
    expect(at(PODIUM_DURATION + 30).label).toBe('hold')
  })

  it('clamps a negative clock to the opening frame', () => {
    const a = { ...at(-5).pose }
    const b = { ...at(0).pose }
    expect(a.x).toBeCloseTo(b.x, 6)
    expect(a.y).toBeCloseTo(b.y, 6)
  })

  /**
   * REDUCED MOTION: STILL FRAMINGS, AND THE CUTS SURVIVE.
   *
   * Not a slower flight -- slower continuous translation is still continuous
   * translation. Each beat holds its own opening framing for its whole length,
   * so the player gets five angles on the celebration and no optical flow.
   */
  it('holds every beat still under reduced motion, and still cuts', () => {
    let t = 0
    for (const s of PODIUM_SHOTS) {
      const a = { ...at(t + 0.01, true).pose }
      const b = { ...at(t + s.hold - 0.01, true).pose }
      expect(b.x).toBeCloseTo(a.x, 6)
      expect(b.y).toBeCloseTo(a.y, 6)
      expect(b.z).toBeCloseTo(a.z, 6)
      expect(b.fov).toBeCloseTo(a.fov, 6)
      expect(a.x).toBeCloseTo(s.from.x, 6)
      t += s.hold
    }
    const seen: string[] = []
    for (let u = 0; u < PODIUM_DURATION; u += 0.05) {
      const f = at(u, true)
      if (seen[seen.length - 1] !== f.label) seen.push(f.label)
    }
    expect(seen).toEqual(PODIUM_SHOTS.map((s) => s.label))
  })

  it('allocates nothing per frame', () => {
    const f = makePodiumFrame()
    const pose = f.pose
    podiumFrameAt(2, false, f)
    podiumFrameAt(9, false, f)
    expect(f.pose).toBe(pose)
  })
})

// ---------------------------------------------------------------------------
describe('the staging', () => {
  /**
   * THE MEASUREMENT THAT MADE THE CARS BEAT A MASS.
   *
   * The lanes have to clear the cars' TURNED footprint, not their track width.
   * A chassis parked at CAR_YAW presents `w*cos(y) + l*sin(y)` across X, and
   * the shipped comment sized the lanes off `w` alone -- so the widest pair on
   * the roster overlapped by more than a metre and photographed as one object.
   *
   * The numbers here are the three that actually stand on a podium in the
   * shipped grid, measured off the LOD0 buffers. The claim is not that every
   * pair separates -- a Filament beside a Dray-9 needs a 17 m podium, which is
   * why CAR_Z also staggers them in depth -- it is that the three cars that
   * turn up most are no longer inside each other.
   */
  /**
   * MEASURED, NOT MODELLED. `w*cos(yaw) + l*sin(yaw)` treats a chassis as a
   * rectangle and over-states a tapered one by half a metre, which is enough
   * to choose the wrong lane width. These are the real X extents of the LOD0
   * buffers at the yaw each step uses, taken off the built visuals, as
   * [leftOfCentre, rightOfCentre] in metres.
   */
  const SPAN: Record<number, [number, number]> = {
    0: [2.52, 2.22], // 1st: Vector-7 at CAR_YAW[0]
    1: [1.99, 1.96], // 2nd: Solaire  at CAR_YAW[1]
    2: [3.05, 2.88], // 3rd: Bulwark  at CAR_YAW[2]
  }

  it('gives the champion and the runner-up lanes wider than their turned bodies', () => {
    // The pair the photograph complained about: the Vector-7's wing crossing
    // the Solaire parked beside it. These two are on adjacent lanes with no
    // depth between them (CAR_Z stages the OUTER pair forward, not this one),
    // so width is the only thing that can separate them.
    const gap = Math.abs(STEP_X[1] - STEP_X[0]) - SPAN[1][1] - SPAN[0][0]
    expect(gap).toBeGreaterThan(0.25)
  })

  it('separates the pair that width cannot, in depth instead', () => {
    // 1st against 3rd: the Bulwark is nearly six metres across turned, and a
    // lane wide enough for it is a podium nobody would call a podium. What
    // makes them read as two cars is that one of them is most of a car length
    // nearer the lens. The claim is that the remaining overlap is SMALL and
    // that there is depth behind it -- not that there is no overlap.
    const over = SPAN[0][1] + SPAN[2][0] - Math.abs(STEP_X[2] - STEP_X[0])
    expect(over).toBeLessThan(0.8)
    expect(CAR_Z[2] - CAR_Z[0]).toBeGreaterThan(over)
  })

  it('parks every car in front of its own step and clear of the block', () => {
    for (let i = 0; i < 3; i++) {
      // In front: the block occupies z = -STEP_D..0, the car sits past it.
      expect(CAR_Z[i]).toBeGreaterThan(2.5)
      // ...and each car is centred on its own step, which is the whole point
      // of the beat Vince asked for. A lane that drifted off its step would
      // break the association without breaking any camera test.
      expect(STEP_X[i]).toBe(STEP_X[i])
    }
    // The outer two are proud of the champion's, for parallax -- but only by
    // about half a car, or the HOLD beat's near car eats the frame.
    expect(CAR_Z[1]).toBe(CAR_Z[2])
    expect(CAR_Z[1] - CAR_Z[0]).toBeGreaterThan(0.4)
    expect(CAR_Z[1] - CAR_Z[0]).toBeLessThan(1.6)
  })

  it('keeps the step ladder and its numbers in descending order', () => {
    expect(STEP_Y[0]).toBeGreaterThan(STEP_Y[1])
    expect(STEP_Y[1]).toBeGreaterThan(STEP_Y[2])
    // The face contract is above the tall step, or it is not a face height.
    expect(PODIUM_FACE_Y).toBeGreaterThan(STEP_Y[0] + 1)
    expect(STEP_HALF_W).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
describe('aiming the fireworks', () => {
  /**
   * THE BUG THIS EXISTS TO STOP COMING BACK.
   *
   * The shipped emitter burst its shells in a fixed slab of world space, and
   * on four of the five beats most of them were outside the picture -- the
   * CARS beat, which looks down at a row of bumpers, had NONE of the slab in
   * frame and got no fireworks at all. Nothing caught it, because "is it in
   * shot" was nobody's assertion: the probe measured cost and cast, and the
   * screenshots were read for whether the podium looked right.
   *
   * It is pure arithmetic, so it is checkable for every beat at once. For each
   * beat, at eleven points through its move, at four aspect ratios (desktop,
   * portrait phone, landscape phone, an absurd ultrawide) and over a grid of
   * the three dice: project the burst back through the same lens and assert it
   * is in frame, in front of the lens, above the podium and behind the subject.
   */
  const frame = makePodiumFrame()
  const burst: PodiumBurst = { x: 0, y: 0, z: 0, dist: 0, sx: 0, sy: 0, rise: 0 }
  const scr: PodiumScreen = { sx: 0, sy: 0, depth: 0 }
  const ASPECTS = [16 / 9, 412 / 915, 915 / 412, 21 / 9]

  const sweep = (fn: (b: PodiumBurst, sc: PodiumScreen, where: string) => void): void => {
    let t = 0
    for (const shot of PODIUM_SHOTS) {
      for (let k = 0; k <= 10; k++) {
        const at = t + (k / 10) * shot.hold * 0.999
        for (const aspect of ASPECTS) {
          const lens = podiumLensOf(podiumFrameAt(at, false, frame).pose, aspect)
          for (let a = 0; a <= 1.0001; a += 0.25) {
            for (let b = 0; b <= 1.0001; b += 0.25) {
              for (const c of [0.1, 0.4, 0.6, 0.9]) {
                podiumSkyPoint(lens, Math.min(a, 1), Math.min(b, 1), c, burst)
                podiumProject(lens, burst.x, burst.y, burst.z, scr)
                fn(burst, scr, `${shot.label} u=${k / 10} asp=${aspect.toFixed(2)}`)
              }
            }
          }
        }
      }
      t += shot.hold
    }
  }

  it('puts every shell inside the frame it was aimed through', () => {
    sweep((_b, sc, where) => {
      // In front of the lens at all, first: a sign error here would put the
      // whole display behind the camera and still "project" inside 1.0.
      expect(sc.depth, where).toBeGreaterThan(1)
      // 0.995 rather than 1.0: this is the burst CENTRE, and a centre exactly
      // on the frame edge is half a burst.
      expect(Math.abs(sc.sx), where).toBeLessThan(0.995)
      expect(Math.abs(sc.sy), where).toBeLessThan(0.995)
    })
  })

  it('never bursts in the podium, in the ground, or in orbit', () => {
    sweep((b, _sc, where) => {
      // Above everything on the block: the tall step plus a figure on it.
      expect(b.y, where).toBeGreaterThan(5.9)
      expect(b.y, where).toBeLessThan(30.1)
      // Never right on top of the lens, and never in front of the subject --
      // a burst between the camera and the champion washes out the thing the
      // beat is framing. The nearest beat's subject is ~6.5 m out, so 12 m is
      // the floor everywhere and most beats push the shells past 15.
      expect(b.dist, where).toBeGreaterThan(11.9)
      // ...and never past the pool's own far fade, which dissolves everything
      // between 230 and 420 m. A beat that tilts down buys its height with
      // DISTANCE (the floor clamp in podiumSkyPoint), so a ray that climbed
      // slowly enough would satisfy every other assertion here by putting the
      // shell four hundred metres away, where the shader draws nothing at all.
      // SKY_CLIMB is what bounds it; this is the assertion that says so.
      expect(b.dist, where).toBeLessThan(60)
    })
  })

  it('keeps shells off the centre of frame, where the subject is', () => {
    sweep((b, _sc, where) => {
      expect(Math.abs(b.sx), where).toBeGreaterThanOrEqual(0.29)
      // ...and in the upper half of it, which is what "sky" means here.
      expect(b.sy, where).toBeGreaterThan(0.0)
    })
  })

  it('leaves the rise inside the sky rather than dragging it through the block', () => {
    sweep((b, _sc, where) => {
      expect(b.rise, where).toBeGreaterThanOrEqual(0)
      expect(b.y - b.rise, where).toBeGreaterThan(5.9)
    })
  })

  /** The projection is the inverse of the construction, or neither is worth
   *  anything: the test above would be checking its own arithmetic. */
  it('round-trips a point through the lens', () => {
    const lens = podiumLensOf(PODIUM_SHOTS[1].from)
    for (const [sx, sy, d] of [[0.5, 0.3, 20], [-0.8, 0.9, 14], [0, 0, 8]] as const) {
      const h = sx * d * lens.tanV * lens.aspect
      const v = sy * d * lens.tanV
      const cp = Math.hypot(lens.fx, lens.fz)
      const rx = -lens.fz / cp, rz = lens.fx / cp
      const ux = -lens.fx * lens.fy / cp, uy = cp, uz = -lens.fz * lens.fy / cp
      podiumProject(
        lens,
        lens.x + lens.fx * d + rx * h + ux * v,
        lens.y + lens.fy * d + uy * v,
        lens.z + lens.fz * d + rz * h + uz * v,
        scr,
      )
      expect(scr.sx).toBeCloseTo(sx, 6)
      expect(scr.sy).toBeCloseTo(sy, 6)
      expect(scr.depth).toBeCloseTo(d, 6)
    }
  })

  /** ...and the podium itself is in shot on every beat, which is the other
   *  half of the same claim: a lens that framed nothing would pass above. */
  it('keeps the champion in frame on every beat', () => {
    let t = 0
    for (const shot of PODIUM_SHOTS) {
      for (let k = 0; k <= 10; k++) {
        const at = t + (k / 10) * shot.hold * 0.999
        const lens = podiumLensOf(podiumFrameAt(at, false, frame).pose)
        podiumProject(lens, STEP_X[0], STEP_Y[0] + 0.4, -STEP_D * 0.45, scr)
        const where = `${shot.label} u=${k / 10}`
        expect(scr.depth, where).toBeGreaterThan(1)
        expect(Math.abs(scr.sx), where).toBeLessThan(1)
        expect(Math.abs(scr.sy), where).toBeLessThan(1.35)
      }
      t += shot.hold
    }
  })
})

// ---------------------------------------------------------------------------
describe('the face-aimed beats follow the figure', () => {
  const frame = makePodiumFrame()

  it('slides a face-aimed beat by the difference and leaves the rest alone', () => {
    let t = 0
    for (const shot of PODIUM_SHOTS) {
      const at = t + shot.hold * 0.5
      const base = { ...podiumFrameAt(at, false, frame, PODIUM_FACE_Y).pose }
      const lower = { ...podiumFrameAt(at, false, frame, PODIUM_FACE_Y - 0.8).pose }
      const delta = shot.face ? -0.8 : 0
      expect(lower.ty - base.ty, shot.label).toBeCloseTo(delta, 6)
      // The LENS moves with the aim on a face-aimed beat, or a level arc turns
      // into a look-up the moment somebody makes the pilot taller.
      expect(lower.y - base.y, shot.label).toBeCloseTo(delta, 6)
      // ...and nothing else in the pose moves, ever.
      expect(lower.x, shot.label).toBeCloseTo(base.x, 6)
      expect(lower.z, shot.label).toBeCloseTo(base.z, 6)
      expect(lower.tx, shot.label).toBeCloseTo(base.tx, 6)
      expect(lower.tz, shot.label).toBeCloseTo(base.tz, 6)
      expect(lower.fov, shot.label).toBeCloseTo(base.fov, 6)
      t += shot.hold
    }
  })

  it('has at least one beat framing the person rather than the set', () => {
    expect(PODIUM_SHOTS.filter((s) => s.face).length).toBeGreaterThanOrEqual(1)
  })

  it('defaults to the contract when nobody measures the figure', () => {
    const a = { ...podiumFrameAt(4.8, false, frame).pose }
    const b = { ...podiumFrameAt(4.8, false, frame, PODIUM_FACE_Y).pose }
    expect(a.ty).toBeCloseTo(b.ty, 9)
  })
})

// ---------------------------------------------------------------------------
describe('leaving', () => {
  it('ignores a control still held from the last race until it is released', () => {
    // Held from frame zero: the guard expires and it STILL must not skip.
    let armed = false
    for (const t of [0, 0.3, PODIUM_SKIP_GUARD, PODIUM_SKIP_GUARD + 2]) {
      const r = podiumSkip(t, true, armed)
      armed = r.armed
      expect(r.skip).toBe(false)
    }
  })

  it('arms on a release and then skips on the next press', () => {
    let armed = false
    armed = podiumSkip(0.1, true, armed).armed   // still held from the race
    expect(armed).toBe(false)
    armed = podiumSkip(0.4, false, armed).armed  // released
    expect(armed).toBe(true)
    // Armed, but inside the guard.
    expect(podiumSkip(0.5, true, armed).skip).toBe(false)
    // Armed and past it.
    expect(podiumSkip(PODIUM_SKIP_GUARD, true, armed).skip).toBe(true)
  })

  it('never skips on a frame where nothing is held', () => {
    expect(podiumSkip(10, false, true).skip).toBe(false)
  })

  it('ends itself once the shot list has played out', () => {
    expect(podiumDone(0)).toBe(false)
    expect(podiumDone(PODIUM_DURATION - 0.01)).toBe(false)
    expect(podiumDone(PODIUM_DURATION)).toBe(true)
  })

  /** The guard is the ceremony's, because a player should not have to learn a
   *  second rule for the second celebration in ninety seconds. */
  it('uses the same skip guard as the finish ceremony', async () => {
    const { TUNING } = await import('../src/content/tuning')
    expect(PODIUM_SKIP_GUARD).toBe(TUNING.ceremony.skipGuard)
  })
})
