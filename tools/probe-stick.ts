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
 * THE QUESTION HAS MOVED ON, AND SO HAS SECTION 3. The pad now has a RIM at
 * 0.80 of lock and an overtravel band past it carrying the last fifth, so
 * "where in the travel" is no longer one number. A corner that sits inside the
 * well is one the player can brace a thumb against; a corner that needs
 * overtravel is one they have to hold out past the edge with nothing to feel,
 * for as long as the corner lasts. Those are different experiences and the
 * probe has to tell them apart. Section 3 reports the corner band against the
 * RIM, and section 4 reports what the player's own two dials do to it.
 *
 * Four sections:
 *
 *   1. THE MAPPING. `stickSteerFrom` is the shipping function, so this is the
 *      real curve and not a replica of it.
 *
 *   2. THE OFF-AXIS SWEEP. A thumb pivots about the knuckle and traces an arc;
 *      it does not slide along a ruler. The anchor is fixed now and only dx
 *      steers, so the question is no longer "what ceiling does an arc hit" --
 *      it is how much SWEEP an arc has to spend to reach full lock. The
 *      ceiling is still printed, because the clamp USED to be applied to the
 *      2D vector, which silently capped steer at cos(angle) -- 0.698 on a
 *      45-degree push. Sabotage-check it by restoring the vector clamp.
 *
 *   3. THE DEMAND. Every curved 10m of a circuit, chained through the sim's own
 *      speed falloff to the lock that corner needs, then back through the curve
 *      to px of thumb -- and to which side of the rim that px falls on.
 *
 *   4. THE DIALS. The same corner band, re-read at each end of the two
 *      settings sliders. This is the section that says whether the ranges the
 *      sliders offer are ranges worth offering.
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
import {
  DEFAULT_STICK_TUNE, STICK_GAIN_RANGE, STICK_OVERTRAVEL, STICK_RADIUS,
  STICK_RIM_LOCK, STICK_THROW_RANGE, stickOvertravel, stickSteerFrom,
  type StickTune,
} from '../src/game/touchControls'

const arg = process.argv.find((a) => a.startsWith('--track='))
const TRACK_IDS = arg ? arg.slice(8).split(',') : ['rustfall', 'cryostatic', 'aetherion']

/**
 * Smallest px of thumb travel at which `hit` is already true, or -1.
 *
 * EVERY DISTANCE IN THIS FILE COMES FROM HERE, including the rim and the end
 * of the band, which could both be had by multiplying two exported constants.
 * They are asked for instead, for the reason the header gives: an arithmetic
 * copy of the mapping is a second opinion about the control, and the whole
 * point of this probe is that there is only one. It also gets the awkward
 * cases right for free -- at a gain above 1.0 full lock arrives BEFORE the
 * rim, and below 1.0 it never arrives at all.
 */
function pxWhere(hit: (px: number) => boolean, hi = 600): number {
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

/** steer -> px of thumb. Bisects the shipping mapping; no second copy of it. */
const pxFor = (steer: number, tune: StickTune = DEFAULT_STICK_TUNE): number =>
  pxWhere((px) => stickSteerFrom(px, tune) >= steer)

/** Where the knob pins, i.e. the drawn rim, in px of thumb. */
const rimPx = (tune: StickTune = DEFAULT_STICK_TUNE): number =>
  pxWhere((px) => stickOvertravel(px, tune) > 0)

/** Where full lock arrives, in px of thumb, or -1 if it never does. */
const fullPx = (tune: StickTune = DEFAULT_STICK_TUNE): number =>
  pxWhere((px) => stickSteerFrom(px, tune) >= 1)

const pad = (s: string | number, n: number): string => String(s).padStart(n)
const padr = (s: string | number, n: number): string => String(s).padEnd(n)

// ---------------------------------------------------------------------------
// 1. The mapping
// ---------------------------------------------------------------------------
const RIM = rimPx()
const FULL = fullPx()
console.log(
  `\nSTICK_RADIUS ${STICK_RADIUS}px to the rim (${STICK_RIM_LOCK.toFixed(2)} lock), `
  + `+${STICK_OVERTRAVEL}px of overtravel to full lock`,
)
console.log(`  measured: rim at ${RIM.toFixed(1)}px, full lock at ${FULL.toFixed(1)}px`)
console.log(`  rest shoulder: ${pxWhere((px) => stickSteerFrom(px) > 0).toFixed(2)}px\n`)
console.log('displacement -> steer                                     | = past the rim')
for (const d of [3, 5, 8, 10, 15, 20, 25, 29, 32, 38, 41, 47, 60]) {
  const v = stickSteerFrom(d)
  const n = Math.round(v * 40)
  const rim = Math.round(STICK_RIM_LOCK * 40)
  const bar = '#'.repeat(Math.min(n, rim)) + '='.repeat(Math.max(0, n - rim))
  const mark = d <= RIM ? ' ' : d <= FULL ? '>' : '.'
  console.log(`  ${pad(d, 3)}px ${mark} ${v.toFixed(3)}  ${bar}`)
}

// ---------------------------------------------------------------------------
// 2. The off-axis sweep
// ---------------------------------------------------------------------------
/**
 * Replays a pointer path through the SHIPPING mapping, with the anchor fixed
 * at the first sample the way `bindStick` now fixes it on pointerdown.
 *
 * The origin-drag this used to model is gone -- see the note in
 * touchControls.ts where `stickOrigin` used to be -- so the replay is shorter
 * than it was, and that is the point: with a fixed anchor the steering is a
 * pure function of dx, and the only thing a path can still cost the player is
 * SWEEP. Returns the ceiling reached and the arc length it took to get there.
 */
function drivePath(path: Array<[number, number]>): { top: number; atS: number } {
  const ox = path[0][0]
  let top = 0
  let atS = -1
  let s = 0
  for (let i = 1; i < path.length; i++) {
    s += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1])
    const v = stickSteerFrom(path[i][0] - ox)
    if (v > top) top = v
    if (atS < 0 && v >= 1) atS = s
  }
  return { top, atS }
}
console.log('\nsweep spent reaching full lock, by angle off horizontal')
{
  const row: string[] = []
  for (const deg of [0, 15, 30, 45, 60]) {
    const t = (deg * Math.PI) / 180
    const p: Array<[number, number]> = [[0, 0]]
    for (let s = 0.5; s <= 180; s += 0.5) p.push([s * Math.cos(t), s * Math.sin(t)])
    const r = drivePath(p)
    row.push(`${pad(deg, 2)}deg ${r.top.toFixed(3)} @${pad(r.atS.toFixed(0), 3)}px`)
  }
  console.log('  ' + row.join('  '))
}
console.log('sweep spent reaching full lock, on a real thumb arc, by reach (knuckle-to-pad)')
{
  const row: string[] = []
  for (const reach of [120, 160, 200, 260]) {
    const p: Array<[number, number]> = []
    for (let s = 0; s <= 180; s += 0.5) {
      const phi = s / reach
      p.push([reach * Math.sin(phi), reach * (1 - Math.cos(phi))])
    }
    const r = drivePath(p)
    row.push(`${reach}px ${r.top.toFixed(3)} @${pad(r.atS.toFixed(0), 3)}px`)
  }
  console.log('  ' + row.join('  '))
}

// ---------------------------------------------------------------------------
// 3. The demand
// ---------------------------------------------------------------------------
const maxYaw = deriveChassis(CHASSIS.find((c) => c.id === 'solaire')!.stats).maxYawRate

/**
 * The lock every curved 10m of a circuit demands of the shipping chassis.
 *
 * Uses the sim's own speed rather than a corner-speed formula, so braking,
 * surface and traffic are all still in the number.
 */
function demand(id: string): number[] | null {
  const def = TRACKS_BY_ID[id]
  if (!def) return null
  resetAI()
  const track = new Track(def)
  const race = new Race(track, {
    seed: 20260901, totalLaps: 2, racerCount: 8, trackId: id,
    chassisIds: Array.from({ length: 8 }, (_, i) => CHASSIS[i % CHASSIS.length].id),
    pilotIds: Array.from({ length: 8 }, (_, i) => PILOTS[i % PILOTS.length].id),
    localRacerIndex: -1, aiSkill: Array.from({ length: 8 }, () => 4),
  })
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
  for (let s = 0; s < track.length; s += 10) {
    const k = Math.abs(track.curvatureAt(s, 12))
    if (k < 1e-5) continue
    const vs = vAt.get(s)
    if (!vs || vs.length < 10) continue
    vs.sort((a, b) => a - b)
    const v = vs[Math.floor(vs.length / 2)]
    // Demanded yaw rate v/R against what the wheel still has at that speed.
    const avail = maxYaw / (1 + v / T.steering.yawSpeedFalloff)
    steers.push(Math.min(v / (1 / k) / avail, 1))
  }
  steers.sort((a, b) => a - b)
  return steers
}

const pool: number[] = []
console.log(
  `\nlock demanded by real corners (solaire, maxYawRate ${((maxYaw * 180) / Math.PI).toFixed(1)} deg/s)`,
)
console.log('  track         bins    quantile  lock    px    where          over the rim')
for (const id of TRACK_IDS) {
  const steers = demand(id)
  if (!steers) { console.log(`  ${id}: no such track`); continue }
  for (const s of steers) pool.push(s)
  const q = (p: number): number => steers[Math.floor(p * (steers.length - 1))]
  // The share of the corner band that cannot be held with the thumb braced
  // against the rim. This is the number the overtravel band has to justify:
  // every one of these bins is a corner the player holds out past the edge.
  const past = steers.filter((s) => s > STICK_RIM_LOCK).length
  let first = true
  for (const [name, p] of [['median', 0.5], ['p90', 0.9], ['p99', 0.99]] as const) {
    const lock = q(p)
    const px = pxFor(lock)
    const side = px <= RIM
      ? `in well ${pad(Math.round((px / RIM) * 100) + '%', 4)}`
      : `OVER    ${pad(Math.round(((px - RIM) / (FULL - RIM)) * 100) + '%', 4)}`
    console.log(
      `  ${padr(first ? id : '', 12)} ${pad(first ? steers.length : '', 4)}`
      + `    ${padr(name, 8)}  ${lock.toFixed(2)}  ${pad(px.toFixed(0), 4)}px  ${side}`
      + (first ? `   ${past}/${steers.length} bins (${((past / steers.length) * 100).toFixed(1)}%)` : ''),
    )
    first = false
  }
}
pool.sort((a, b) => a - b)
const poolQ = (p: number): number => pool[Math.floor(p * (pool.length - 1))]
const poolPast = pool.filter((s) => s > STICK_RIM_LOCK).length
console.log(
  `\n  all three:  ${pool.length} curved bins, `
  + `${poolPast} (${((poolPast / pool.length) * 100).toFixed(1)}%) demand more lock than the rim carries`,
)

// ---------------------------------------------------------------------------
// 4. The dials
// ---------------------------------------------------------------------------
/**
 * What the two settings sliders do to the table above.
 *
 * A range nobody can use is not a range, and the two failure modes are at
 * opposite ends: a gain low enough that the tightest corners become
 * unreachable, and a throw long enough that ordinary cornering no longer fits
 * under a thumb. Both are visible here and neither is visible from the
 * constants alone.
 *
 * THE FIRST ONE IS NOW STRUCTURALLY IMPOSSIBLE AND THIS SECTION IS WHERE THAT
 * WAS FOUND. While `gain` scaled the pad's output it also clamped it, so the
 * no-reach column below read 12.9% at the bottom of the dial: an eighth of the
 * roster's corners taken away from a player who had nudged a slider marked
 * "sensitivity". Gain reshapes the response curve now and every setting still
 * reaches full lock, so the column reads 0.0% everywhere -- and a column of
 * zeroes that USED to be the bug is worth more than one that was always zero,
 * so it stays, and the run fails below if it ever stops being zero.
 */
const G = STICK_GAIN_RANGE
const TH = STICK_THROW_RANGE
console.log('\nwhat the two dials do to that band')
console.log(
  '  gain  throw    rim   full    rest   median    p90     p99   over-rim  no-reach',
)
const rows: StickTune[] = [
  { gain: G.min, throw: 1 },
  { gain: 0.8, throw: 1 },
  { gain: 1, throw: TH.min },
  { gain: 1, throw: 1 },
  { gain: 1, throw: 1.4 },
  { gain: 1, throw: TH.max },
  { gain: 1.2, throw: 1 },
  { gain: G.max, throw: 1 },
  { gain: G.max, throw: TH.max },
]
for (const t of rows) {
  const rim = rimPx(t)
  const full = fullPx(t)
  const rest = pxWhere((px) => stickSteerFrom(px, t) > 0)
  const top = stickSteerFrom(1e6, t)
  // TWO DIFFERENT KINDS OF TROUBLE, AND THEY MUST NOT SHARE A COLUMN.
  //
  //   over-rim  the corner is reachable, but only out past the edge, with
  //             nothing under the thumb to brace against for the length of it.
  //   no-reach  the pad cannot produce that much lock AT ALL: how many of the
  //             roster's corners stop being corners and start being walls.
  //             Zero at every setting, by construction, since gain reshapes
  //             the curve rather than scaling and clamping its output. Kept
  //             because it is the column that reported the defect.
  const rimLock = stickSteerFrom(rim, t)
  const over = pool.filter((s) => s > rimLock && s <= top).length
  const gone = pool.filter((s) => s > top).length
  const cell = (p: number): string => {
    const px = pxFor(poolQ(p), t)
    return px < 0 ? '   --' : pad(px.toFixed(0) + (px > rim ? '>' : ' '), 5)
  }
  console.log(
    `  ${t.gain.toFixed(2)}  ${t.throw.toFixed(2)}  `
    + `${pad(rim.toFixed(0), 4)}px ${pad(full < 0 ? '--' : full.toFixed(0), 4)}px `
    + `${pad(rest.toFixed(1), 5)}px  ${cell(0.5)}px ${cell(0.9)}px ${cell(0.99)}px`
    + `   ${pad(((over / pool.length) * 100).toFixed(1) + '%', 6)}   `
    + `${pad(((gone / pool.length) * 100).toFixed(1) + '%', 6)}`,
  )
}
console.log(
  '\n  > marks a corner that has to be held past the rim, -- one the pad cannot'
  + '\n  reach at that gain. Both columns are shares of the 780-bin pool above.',
)

/**
 * NO SETTING OF EITHER DIAL MAY COST THE PLAYER LOCK, checked rather than
 * printed, because this is the one thing in this file that is a correctness
 * claim rather than a measurement.
 *
 * This block used to compute a gain FLOOR -- the smallest gain at which every
 * corner the roster contains is still reachable -- and print it beside
 * STICK_GAIN_RANGE.min for a human to compare. That was the right instrument
 * for a dial that could take lock away, and the number it printed (0.92, the
 * hardest corner on the calendar, against a min of 0.60) is how the defect was
 * found. A dial that cannot take lock away does not need a floor; it needs
 * this to stay true, so the check is in the run instead of in the reader.
 *
 * Whole grid, both dials, 0.05 steps. `tests/steering.test.ts` holds the same
 * invariant; this holds it against the roster's own corner demands, which the
 * test has no way to see.
 */
{
  const worst = pool[pool.length - 1]
  const bad: string[] = []
  for (let g = G.min; g <= G.max + 1e-9; g += 0.05) {
    for (let th = TH.min; th <= TH.max + 1e-9; th += 0.05) {
      const top = stickSteerFrom(1e6, { gain: g, throw: th })
      if (top < 1) bad.push(`gain ${g.toFixed(2)} throw ${th.toFixed(2)} tops out at ${top.toFixed(3)}`)
    }
  }
  console.log(
    `\n  the hardest corner in the pool demands ${worst.toFixed(2)} lock.`
    + `\n  every setting of both dials reaches 1.00: ${bad.length === 0 ? 'yes' : 'NO'}`,
  )
  if (bad.length > 0) {
    console.log('  FAIL -- a settings row is taking lock away from the player:')
    for (const b of bad.slice(0, 8)) console.log(`    ${b}`)
    process.exitCode = 1
  }
}
console.log('')
