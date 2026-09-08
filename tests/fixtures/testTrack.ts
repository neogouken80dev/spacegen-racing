import type { TrackDef, TrackNode } from '../../src/sim/track'

/**
 * A synthetic rig for unit-testing the driving model, not a playable track:
 * a very large, very wide, perfectly flat ring. The point is that a car can
 * hold full lock, counter-steer, spin, or sit still for ten seconds without
 * ever touching a wall or leaving the surface, so a drift test measures the
 * drift model rather than Rustfall's geometry.
 */
const R = 3000
const N = 24
const nodes = Array.from({ length: N }, (_, i) => {
  const a = (i / N) * Math.PI * 2
  return { p: [Math.sin(a) * R, 0, Math.cos(a) * R] as [number, number, number], w: 400, surface: 'tarmac' as const }
})

export const TEST_PLAIN: TrackDef = {
  id: 'test-plain',
  name: 'Test Plain',
  skyTop: 0x000000, skyBottom: 0x000000, fogColor: 0x000000, fogDensity: 0,
  sunColor: 0xffffff, sunIntensity: 1, ambientColor: 0xffffff, ambientIntensity: 1,
  sunDirection: [0, 1, 0],
  palette: { a: 0, b: 0, c: 0, accent: 0 },
  laps: 3,
  nodes,
  itemBoxRows: [],
  chargeRuns: [],
}

/**
 * A narrow BOUNCE-walled ring. Same geometry idea as TEST_PLAIN but only 12 m
 * to a side, with bounce walls on every node, so a racer held against the
 * barrier stays in contact for hundreds of consecutive frames. That sustained
 * contact is the only condition under which a per-frame energy leak in the
 * bounce-wall response is visible, and it has been the shape of two separate
 * bugs (a velocity multiply, then an additive tangential push on top of a full
 * reflection). See tests/walls.test.ts.
 */
const BR = 3000
const BN = 48
export const TEST_BOUNCE_RING: TrackDef = {
  id: 'test-bounce',
  name: 'Test Bounce Ring',
  skyTop: 0x000000, skyBottom: 0x000000, fogColor: 0x000000, fogDensity: 0,
  sunColor: 0xffffff, sunIntensity: 1, ambientColor: 0xffffff, ambientIntensity: 1,
  sunDirection: [0, 1, 0],
  palette: { a: 0, b: 0, c: 0, accent: 0 },
  laps: 3,
  nodes: Array.from({ length: BN }, (_, i) => {
    const a = (i / BN) * Math.PI * 2
    return {
      p: [Math.sin(a) * BR, 0, Math.cos(a) * BR] as [number, number, number],
      w: 12,
      bounce: true,
      surface: 'tarmac' as const,
    }
  }),
  itemBoxRows: [],
  chargeRuns: [],
}

/**
 * THE WALL-RIDE RIG. A circular circuit whose road TWISTS about its own
 * centreline: `up` rolls +Y -> +X(radial) -> -Y -> -X(radial) over ten nodes,
 * holds that 270 degrees for a stretch, and unrolls over ten more.
 *
 * The centreline never leaves the y = 0 plane. Everything that moves is the
 * frame, which is the point: it isolates the gravity system from geometry.
 * A racer that completes a lap here has driven up a wall, across a ceiling and
 * down the far wall using nothing but `TrackNode.up`, and every piece of code
 * that quietly assumed "up is +Y" -- the AI's heading comparison, its pure-
 * pursuit inversion, its item aiming, the corner-speed curvature read, the
 * renderer's car orientation, the chase camera's up-vector -- is wrong in a
 * way that either puts the field in the barrier or reads on camera.
 *
 * WHY A CONSTANT-RADIUS RING. The corner is deliberately trivial: at R = 300
 * the curvature is 0.0033, which prices the corner at about 100 m/s against a
 * roster that tops out near 68. So nothing here fails for want of grip, and a
 * car that leaves the road left it because a frame was wrong. That is the only
 * failure this fixture is trying to be sensitive to.
 *
 * WHY 20m OF HALF-WIDTH AND NO WALLS. `open: false` (the default) keeps the
 * barriers, so a frame error shows up as a wall scrape rather than a fall, and
 * `Race` respawns rather than the racer dropping out of the test. Twenty metres
 * is wide enough that the AI's normal line wander never touches the barrier on
 * the flat sections, so contact means something.
 *
 * AUTHORING NOTE. `up` must stay perpendicular to the tangent (Track's
 * constructor throws otherwise). Here the tangent is horizontal everywhere and
 * `up` is built from world +Y and the RADIAL direction, both of which are
 * perpendicular to it by construction, so the whole family of rolls is legal.
 */
const WR = 300
const WN = 48
/** Roll angle at node i, radians. 0 = level road, PI = driving on the ceiling. */
function wallRidePhi(i: number): number {
  const TURN = Math.PI * 1.5 // 270 degrees
  if (i <= 8) return 0                                   // level: the start line
  if (i <= 18) return TURN * ((i - 8) / 10)              // roll on, 27 deg/node
  if (i <= 26) return TURN                               // held on the wall
  if (i <= 36) return TURN * (1 - (i - 26) / 10)         // roll off
  return 0                                               // level again
}
export const TEST_WALLRIDE: TrackDef = {
  id: 'test-wallride',
  name: 'Test Wall Ride',
  skyTop: 0x000000, skyBottom: 0x000000, fogColor: 0x000000, fogDensity: 0,
  sunColor: 0xffffff, sunIntensity: 1, ambientColor: 0xffffff, ambientIntensity: 1,
  sunDirection: [0, 1, 0],
  palette: { a: 0, b: 0, c: 0, accent: 0 },
  laps: 3,
  nodes: Array.from({ length: WN }, (_, i) => {
    const a = (i / WN) * Math.PI * 2
    // Outward radial. Perpendicular to the tangent, so it is a legal roll axis
    // target for `up` at every point on the ring.
    const ox = Math.sin(a), oz = Math.cos(a)
    const phi = wallRidePhi(i)
    const c = Math.cos(phi), s = Math.sin(phi)
    return {
      p: [ox * WR, 0, oz * WR] as [number, number, number],
      w: 20,
      surface: 'tarmac' as const,
      up: [ox * s, c, oz * s] as [number, number, number],
    }
  }),
  itemBoxRows: [],
  chargeRuns: [],
}

/**
 * THE VERTICAL LOOP. A straight, a full 360-degree loop in the YZ plane, and a
 * return leg. Unlike TEST_WALLRIDE the CENTRELINE itself goes vertical, which
 * is the case that separates a curvature measured about the surface normal from
 * one measured about world +Y.
 *
 * At the top of the loop the tangent is within a few degrees of straight up, so
 * its XZ projection has almost no length left and the sign of what remains is
 * numerical noise. A world-+Y curvature read there reports a corner of a few
 * metres' radius on a road that is not turning at all -- which prices the
 * corner at about 11 m/s and stands the AI on the brakes at the top of every
 * loop. See tests/gravity.test.ts.
 */
const LOOP_R = 60
function loopNodes(): TrackNode[] {
  const nodes: TrackNode[] = []
  const W = 16
  for (let i = 0; i < 10; i++) nodes.push({ p: [0, 0, -400 + i * 40], w: W })
  // `up` points at the loop's centre, which is perpendicular to the tangent all
  // the way round -- the authoring rule Track's constructor enforces.
  const LN = 16
  for (let i = 0; i < LN; i++) {
    const a = (i / LN) * Math.PI * 2
    nodes.push({
      p: [0, LOOP_R - Math.cos(a) * LOOP_R, Math.sin(a) * LOOP_R],
      w: W,
      up: [0, Math.cos(a), -Math.sin(a)],
    })
  }
  for (let i = 0; i < 14; i++) nodes.push({ p: [0, 0, LOOP_R + 20 + i * 30], w: W })
  for (let i = 0; i < 14; i++) nodes.push({ p: [220, 0, LOOP_R + 20 + (13 - i) * 30], w: W })
  for (let i = 0; i < 12; i++) nodes.push({ p: [220, 0, -400 + (11 - i) * (400 / 12)], w: W })
  return nodes
}
export const TEST_LOOP: TrackDef = {
  id: 'test-loop',
  name: 'Test Loop',
  skyTop: 0x000000, skyBottom: 0x000000, fogColor: 0x000000, fogDensity: 0,
  sunColor: 0xffffff, sunIntensity: 1, ambientColor: 0xffffff, ambientIntensity: 1,
  sunDirection: [0, 1, 0],
  palette: { a: 0, b: 0, c: 0, accent: 0 },
  laps: 3,
  nodes: loopNodes(),
  itemBoxRows: [],
  chargeRuns: [],
}
