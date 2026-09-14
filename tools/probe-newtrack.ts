/**
 * IS THIS CIRCUIT DRIVEABLE, AND DOES IT RACE?
 *
 * The gate a new track has to pass before it is registered anywhere. Four
 * circuits were added in one pass and each of them could fail in a way the type
 * checker cannot see: a lap that does not bake, a corner nothing can hold, a
 * set piece that throws the field off it, or a shape the AI simply cannot get
 * around. Registering first and finding out later means every other gate in the
 * repo goes red at once and the cause is buried.
 *
 *   npx tsx tools/probe-newtrack.ts --track=emberfall
 */
import { Track } from '../src/sim/track'
import { Race } from '../src/sim/race'
import { TRACKS_BY_ID } from '../src/content/tracks'
import { CHASSIS } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'
import type { TrackDef } from '../src/sim/track'

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const id = arg('track', 'emberfall')

const DEF: TrackDef | undefined = TRACKS_BY_ID[id]
if (!DEF) { console.log(`no track with id ${id}`); process.exit(1) }

let t: Track
try { t = new Track(DEF) } catch (e) { console.log(`FAILED TO BAKE: ${(e as Error).message}`); process.exit(1) }

const nodes = DEF.nodes
let chordMin = Infinity, chordMax = 0
for (let i = 0; i < nodes.length; i++) {
  const a = nodes[i].p, b = nodes[(i + 1) % nodes.length].p
  const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  chordMin = Math.min(chordMin, L); chordMax = Math.max(chordMax, L)
}
console.log(`${DEF.name} (${id})`)
console.log(`  ${t.length.toFixed(0)}m, ${nodes.length} nodes, ${t.samples.length} samples`)
console.log(`  chord ${chordMin.toFixed(1)}-${chordMax.toFixed(1)}m   ratio ${(chordMax / chordMin).toFixed(2)}  (a big ratio puts curvature spikes at the joins)`)

// Corner census: the radii the SIM reads, which is the only opinion that counts.
const radii: number[] = []
for (let i = 0; i < t.samples.length; i++) {
  const k = Math.abs(t.curvatureAt(i * 1.5, 20))
  if (k > 0.0045) radii.push(1 / k)
}
const held = (100 * radii.length) / t.samples.length
console.log(`  road the AI reads as CURVED (|k|>0.0045): ${held.toFixed(0)}%`)
if (radii.length) {
  radii.sort((a, b) => a - b)
  console.log(`  corner radii: tightest ${radii[0].toFixed(0)}m  median ${radii[radii.length >> 1].toFixed(0)}m`)
}
const ele = t.samples.map((s) => s.pos.y)
console.log(`  elevation ${Math.min(...ele).toFixed(0)}m to ${Math.max(...ele).toFixed(0)}m`)

// ---- Does a field of eight actually race it? ----
const SEEDS = [11, 2029, 777]
let laps: number[] = []
let respawns = 0, offTrack = 0, finished = 0, frames = 0
for (const seed of SEEDS) {
  const race = new Race(t, {
    seed, totalLaps: 3, racerCount: 8, trackId: id,
    chassisIds: Array.from({ length: 8 }, (_, i) => CHASSIS[i % CHASSIS.length].id),
    pilotIds: Array.from({ length: 8 }, (_, i) => PILOTS[i % PILOTS.length].id),
    localRacerIndex: -1, aiSkill: Array.from({ length: 8 }, (_, i) => 2 + (i % 3)),
  })
  const was = race.state.racers.map(() => 0)
  for (let f = 0; f < 60 * 600 && race.state.phase !== 'finished'; f++) {
    race.step(); frames++
    race.state.racers.forEach((r, k) => {
      if (r.respawnTime > 0 && was[k] <= 0) respawns++
      was[k] = r.respawnTime
      if (r.offTrackTime > 0) offTrack++
    })
  }
  finished += race.state.racers.filter((r) => r.finished).length
  for (const r of race.state.racers) for (const l of r.lapTimes ?? []) if (l > 0) laps.push(l)
}
laps.sort((a, b) => a - b)
const mean = laps.reduce((a, b) => a + b, 0) / Math.max(1, laps.length)
console.log(`\n  races: ${finished}/${8 * SEEDS.length} racers finished`)
console.log(`  lap time: best ${laps[0]?.toFixed(2)}s  mean ${mean.toFixed(2)}s  worst ${laps[laps.length - 1]?.toFixed(2)}s   (design band 55-75s)`)
console.log(`  respawns ${(respawns / SEEDS.length).toFixed(1)}/race   off-track ${(100 * offTrack / Math.max(1, frames * 8)).toFixed(1)}% of racer-frames`)

const problems: string[] = []
if (finished !== 8 * SEEDS.length) problems.push(`only ${finished}/${8 * SEEDS.length} racers finished`)
if (mean < 55 || mean > 75) problems.push(`mean lap ${mean.toFixed(2)}s is outside the 55-75s design band`)
// CALIBRATED, not guessed. The four shipped circuits measure 0.0, 0.0, 0.3 and
// 0.7 respawns a race through this same harness, so 3 is already several times
// worse than anything that has ever shipped. The first version of this gate sat
// at 25 and passed a circuit that was throwing the field off 16 times a race.
if (respawns / SEEDS.length > 3) problems.push(`${(respawns / SEEDS.length).toFixed(1)} respawns a race -- the shipped circuits run 0.0-0.7`)
if (chordMax / chordMin > 3.5) problems.push(`chord ratio ${(chordMax / chordMin).toFixed(2)} will spike curvature at the joins`)
if (held < 12) problems.push(`only ${held.toFixed(0)}% of the lap reads as curved -- this is a flat-out circuit, not a racetrack`)
if (problems.length) { console.log(`\nPROBLEMS:`); for (const p of problems) console.log(`  - ${p}`); process.exit(1) }
console.log(`\n${DEF.name.toUpperCase()} IS RACEABLE`)
