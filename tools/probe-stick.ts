/**
 * THE LEFT STEERING THUMBPAD, measured end to end.
 *
 *   npx tsx tools/probe-stick.ts [--track=<id>,<id>,...]
 *
 * Written because the floating stick had been retuned twice off the same
 * question -- "can a thumb reach full lock?" -- and the answer was yes both
 * times while the control still felt sluggish. The question that actually
 * decides the feel is WHERE ORDINARY CORNERING SITS IN THE TRAVEL, and nothing
 * in the repo could answer it: the displacement -> steer mapping lived inside a
 * pointermove handler, so measuring it meant driving a browser, and the lock a
 * corner demands had never been connected to it at all.
 *
 * Three sections:
 *
 *   1. THE MAPPING. `stickSteerFrom` is the shipping function, so this is the
 *      real curve and not a replica of it.
 *
 *   2. THE OFF-AXIS CEILING. A thumb pivots about the knuckle and traces an
 *      arc; it does not slide along a ruler. This drives real arcs through the
 *      same clamp the pointer handler uses and reports the full-lock ceiling
 *      each one reaches. It is here because the clamp USED to be applied to the
 *      2D vector, which silently capped steer at cos(angle) -- 0.698 on a
 *      45-degree push. Sabotage-check it by restoring the vector clamp.
 *
 *   3. THE DEMAND. Every curved 10m of a circuit, chained through the sim's own
 *      speed falloff to the lock that corner needs, then back through the curve
 *      to px of thumb. This is the section that says whether the pad is geared
 *      for the corners the game actually contains.
 *
 * WHAT THIS PROBE CANNOT TELL YOU. How far a thumb comfortably travels, and how
 * long it can hold an offset, are facts about a hand. They are not in the repo
 * and nothing here measures them. This tool sizes the pad against the TRACK; a
 * player is still the only instrument for whether the result feels right.
 */
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { TRACKS_BY_ID } from '../src/content/tracks'
import { CHASSIS, deriveChassis } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'
import { resetAI } from '../src/sim/ai'
import { emptyInput } from '../src/sim/types'
import { TUNING as T } from '../src/content/tuning'
import { STICK_RADIUS, stickOrigin, stickSteerFrom } from '../src/game/touchControls'

const arg = process.argv.find((a) => a.startsWith('--track='))
const TRACK_IDS = arg ? arg.slice(8).split(',') : ['rustfall', 'cryostatic', 'aetherion']

/** steer -> px of thumb. Bisects the shipping mapping; no second copy of it. */
function pxFor(steer: number): number {
  if (steer >= stickSteerFrom(STICK_RADIUS)) return STICK_RADIUS
  let lo = 0, hi = STICK_RADIUS
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) / 2
    if (stickSteerFrom(m) < steer) lo = m; else hi = m
  }
  return (lo + hi) / 2
}

const pct = (px: number) => Math.round((px / STICK_RADIUS) * 100) + '%'
const pad = (s: string | number, n: number) => String(s).padStart(n)

// ---------------------------------------------------------------------------
// 1. The mapping
// ---------------------------------------------------------------------------
console.log(`\nSTICK_RADIUS ${STICK_RADIUS}px (full lock)\n`)
console.log('displacement -> steer')
for (const d of [3, 5, 8, 10, 15, 20, 25, 30, 38, 50, 70]) {
  const bar = '#'.repeat(Math.round(stickSteerFrom(d) * 40))
  console.log(`  ${pad(d, 3)}px  ${stickSteerFrom(d).toFixed(3)}  ${bar}`)
}

// ---------------------------------------------------------------------------
// 2. The off-axis ceiling
// ---------------------------------------------------------------------------
/**
 * Replays a pointer path through the SHIPPING origin-drag and mapping.
 *
 * `stickOrigin` and `stickSteerFrom` are the two calls the pointermove handler
 * makes, in the order it makes them, so this is not a replica that can drift
 * out of step with the control. That matters here more than usual: the defect
 * this section exists to catch was invisible precisely because the arithmetic
 * lived inside an event handler no test could reach.
 */
function drivePath(path: Array<[number, number]>): number {
  let ox = path[0][0], oy = path[0][1], steer = 0
  for (let i = 1; i < path.length; i++) {
    ox = stickOrigin(ox, path[i][0])
    oy = stickOrigin(oy, path[i][1])
    steer = stickSteerFrom(path[i][0] - ox)
  }
  return steer
}
console.log('\nfull-lock ceiling on a straight push, by angle off horizontal')
{
  const row: string[] = []
  for (const deg of [0, 15, 30, 45, 60]) {
    const t = (deg * Math.PI) / 180
    const p: Array<[number, number]> = [[0, 0]]
    for (let s = 2; s <= 90; s += 2) p.push([s * Math.cos(t), s * Math.sin(t)])
    row.push(`${pad(deg, 2)}deg ${drivePath(p).toFixed(3)}`)
  }
  console.log('  ' + row.join('   '))
}
console.log('full-lock ceiling on a real thumb arc, by reach (knuckle-to-pad, px)')
{
  const row: string[] = []
  for (const reach of [120, 160, 200, 260]) {
    const p: Array<[number, number]> = []
    for (let s = 0; s <= 90; s += 2) {
      const phi = s / reach
      p.push([reach * Math.sin(phi), reach * (1 - Math.cos(phi))])
    }
    row.push(`${reach}px ${drivePath(p).toFixed(3)}`)
  }
  console.log('  ' + row.join('   '))
}

// ---------------------------------------------------------------------------
// 3. The demand
// ---------------------------------------------------------------------------
const maxYaw = deriveChassis(CHASSIS.find((c) => c.id === 'solaire')!.stats).maxYawRate
console.log(`\nlock demanded by real corners (solaire, maxYawRate ${((maxYaw * 180) / Math.PI).toFixed(1)} deg/s)`)
for (const id of TRACK_IDS) {
  const def = TRACKS_BY_ID[id]
  if (!def) { console.log(`  ${id}: no such track`); continue }
  resetAI()
  const track = new Track(def)
  const race = new Race(track, {
    seed: 20260901, totalLaps: 2, racerCount: 8, trackId: id,
    chassisIds: Array.from({ length: 8 }, (_, i) => CHASSIS[i % CHASSIS.length].id),
    pilotIds: Array.from({ length: 8 }, (_, i) => PILOTS[i % PILOTS.length].id),
    localRacerIndex: -1, aiSkill: Array.from({ length: 8 }, () => 4),
  })
  // The speed the field actually carries, binned along the lap. Using the sim
  // rather than a corner-speed formula keeps braking, surface and traffic in.
  const vAt = new Map<number, number[]>()
  const idle = emptyInput()
  for (let f = 0; f < 60 * 240 && race.state.phase !== 'finished'; f++) {
    race.setInput(0, idle)
    race.step()
    if (race.state.phase !== 'racing') continue
    for (const r of race.state.racers) {
      const bin = Math.floor(r.splineS / 10) * 10
      const list = vAt.get(bin) ?? []
      if (list.length === 0) vAt.set(bin, list)
      list.push(Math.hypot(r.vel.x, r.vel.y, r.vel.z))
    }
  }
  const steers: number[] = []
  let beyondLock = 0
  for (let s = 0; s < track.length; s += 10) {
    const k = Math.abs(track.curvatureAt(s, 12))
    if (k < 1e-5) continue
    const vs = vAt.get(s)
    if (!vs || vs.length < 10) continue
    vs.sort((a, b) => a - b)
    const v = vs[Math.floor(vs.length / 2)]
    // Demanded yaw rate v/R against what the wheel still has at that speed.
    const avail = maxYaw / (1 + v / T.steering.yawSpeedFalloff)
    const need = v / (1 / k) / avail
    if (need >= 1) beyondLock++
    steers.push(Math.min(need, 1))
  }
  steers.sort((a, b) => a - b)
  const q = (p: number) => steers[Math.floor(p * (steers.length - 1))]
  const cell = (p: number) => `${q(p).toFixed(2)} -> ${pad(pxFor(q(p)).toFixed(0), 2)}px (${pad(pct(pxFor(q(p))), 4)})`
  console.log(`  ${id.padEnd(11)} ${steers.length} curved bins`)
  console.log(`    median   ${cell(0.5)}`)
  console.log(`    p90      ${cell(0.9)}`)
  console.log(`    p99      ${cell(0.99)}      past full lock: ${beyondLock}/${steers.length} bins`)
}
console.log('')
