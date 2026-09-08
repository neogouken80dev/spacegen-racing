/**
 * THE DRIVEN LINE, and what the surfaces are actually worth in a race.
 *
 * `tools/probe-track.ts` measures the track. This measures the RACING, which is
 * the only way to answer two questions the geometry cannot:
 *
 *  1. Where does the optimal line actually go? The authoring checklist asks for
 *     item box rows "off the optimal line", and the obvious proxy -- the AI's
 *     own apexBias term -- is an instantaneous function of local curvature, so
 *     it understates how far a car is displaced on entry and exit. This samples
 *     the lateral the FRONT-RUNNERS actually hold at each row.
 *
 *  2. What is a surface worth? An ideal-lap integral says what the friction
 *     budget allows. It does not say what the field does with it. So every
 *     measurement here is run TWICE over identical seeds -- once on the track
 *     as authored and once with every surface forced to full grip -- and the
 *     difference is the honest answer to "is the ice decorative".
 *
 * Usage:
 *   npx tsx tools/probe-line.ts --track=cryostatic --races=24
 */
import { Race } from '../src/sim/race'
import { Track, SURFACE_GRIP } from '../src/sim/track'
import type { TrackDef } from '../src/sim/track'
import { TRACKS_BY_ID } from '../src/content/tracks'
import { CHASSIS } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'
import { resetAI } from '../src/sim/ai'
import { emptyInput } from '../src/sim/types'
import type { SimConfig } from '../src/sim/types'

const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const trackId = arg('track', 'rustfall')
const RACES = Number(arg('races', '24'))
const BINS = 240

const baseDef = TRACKS_BY_ID[trackId]
if (!baseDef) { console.error(`unknown track ${trackId}`); process.exit(1) }

/** The same track with every surface at full grip. Geometry is untouched. */
function flattened(def: TrackDef): TrackDef {
  const copy: TrackDef = JSON.parse(JSON.stringify(def))
  for (const n of copy.nodes) if (n.surface && SURFACE_GRIP[n.surface] < 1) n.surface = 'snow'
  return copy
}

interface Bin { n: number; speed: number; lat: number; absLat: number; slip: number; drift: number; off: number }
interface Run {
  bins: Bin[]
  laps: number[]
  finishes: number
  respawns: number
  offTrack: number
}

function run(def: TrackDef, races: number): Run {
  const track = new Track(def)
  const bins: Bin[] = Array.from({ length: BINS }, () => ({ n: 0, speed: 0, lat: 0, absLat: 0, slip: 0, drift: 0, off: 0 }))
  const laps: number[] = []
  let finishes = 0, respawns = 0, offTrack = 0
  const idle = emptyInput()

  for (let r = 0; r < races; r++) {
    resetAI()
    const cfg: SimConfig = {
      seed: 0x5eed1234 + r * 7919,
      totalLaps: 3,
      racerCount: 8,
      trackId: def.id,
      // Fixed lineup: this probe is measuring the TRACK, so the roster must not
      // vary between the two variants or the diff picks up chassis noise.
      chassisIds: Array.from({ length: 8 }, (_, i) => CHASSIS[i % CHASSIS.length].id),
      pilotIds: Array.from({ length: 8 }, (_, i) => PILOTS[i % PILOTS.length].id),
      localRacerIndex: -1,
      aiSkill: Array.from({ length: 8 }, (_, i) => 2 + (i % 3)),
    }
    const race = new Race(track, cfg)
    let frames = 0
    while (frames < 60 * 400 && race.state.phase !== 'finished') {
      for (const rr of race.state.racers) if (!rr.isAI) race.setInput(rr.id, idle)
      race.step()
      frames++
      if (race.state.phase !== 'racing') continue
      for (const rc of race.state.racers) {
        // Front-runners only: the optimal line is what the leaders drive, not
        // what a car recovering from a spin at the back happens to trace.
        if (rc.position > 3 || rc.finished) continue
        const b = bins[Math.min(BINS - 1, Math.floor((rc.splineS / track.length) * BINS))]
        const speed = Math.hypot(rc.vel.x, rc.vel.z)
        const fwd = { x: Math.sin(rc.yaw), z: Math.cos(rc.yaw) }
        const along = rc.vel.x * fwd.x + rc.vel.z * fwd.z
        const across = rc.vel.x * fwd.z - rc.vel.z * fwd.x
        b.n++
        b.speed += speed
        b.lat += rc.lateral
        b.absLat += Math.abs(rc.lateral)
        b.slip += speed > 4 ? Math.abs(Math.atan2(across, Math.abs(along))) : 0
        b.drift += rc.driftSide !== 0 ? 1 : 0
        b.off += Math.abs(rc.lateral) > track.at(rc.splineS).width * 1.10 ? 1 : 0
      }
    }
    for (const rc of race.state.racers) {
      if (rc.finished) finishes++
      for (const lt of rc.lapTimes) laps.push(lt)
      respawns += 0
      offTrack += rc.offTrackTime
    }
  }
  return { bins, laps, finishes, respawns, offTrack }
}

const f = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '-')
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length))
const padL = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s)
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)

const track = new Track(baseDef)
console.log(`\n${baseDef.name} -- ${RACES} races x 8 AI, fixed lineup, 3 laps. ` +
  `Front-3 telemetry binned into ${BINS} sections of ${f(track.length / BINS)}m.`)

const real = run(baseDef, RACES)
const flat = run(flattened(baseDef), RACES)

console.log(`\nLAP TIME`)
console.log(`  as authored        ${f(mean(real.laps), 2)}s   (n=${real.laps.length})`)
console.log(`  every surface 1.0  ${f(mean(flat.laps), 2)}s`)
console.log(`  THE SURFACES ARE WORTH ${f(mean(real.laps) - mean(flat.laps), 3)}s PER LAP, MEASURED IN RACE.`)
console.log(`  off-track seconds: ${f(real.offTrack / RACES / 8, 2)} per racer per race ` +
  `(full grip: ${f(flat.offTrack / RACES / 8, 2)})`)

// ---- Where the surfaces cost speed --------------------------------------
console.log(`\nSPEED BY SECTION  (only sections where the two runs differ by >0.5 m/s)`)
console.log(`  ${pad('s(m)', 7)}${pad('surface', 8)}${padL('R(m)', 6)}  ${padL('authored', 9)}${padL('fullgrip', 9)}${padL('delta', 8)}${padL('slip°', 7)}${padL('drift%', 7)}`)
let shown = 0
for (let i = 0; i < BINS; i++) {
  const a = real.bins[i], b = flat.bins[i]
  if (!a.n || !b.n) continue
  const va = a.speed / a.n, vb = b.speed / b.n
  if (Math.abs(va - vb) < 0.5) continue
  const s = (i / BINS) * track.length
  const k = Math.abs(track.curvatureAt(s - 7.5, 15))
  console.log(`  ${pad(f(s, 0), 7)}${pad(track.at(s).surface, 8)}${padL(k > 1e-6 ? f(1 / k, 0) : 'inf', 6)}  ` +
    `${padL(f(va) + ' m/s', 9)}${padL(f(vb) + ' m/s', 9)}${padL(f(va - vb, 1), 8)}` +
    `${padL(f((a.slip / a.n) * 180 / Math.PI), 7)}${padL(f((a.drift / a.n) * 100, 0), 7)}`)
  shown++
}
if (!shown) console.log('  NOTHING. Every section is within 0.5 m/s of the full-grip run: the surfaces are paint.')

// ---- The driven line vs the item box rows --------------------------------
console.log(`\nITEM BOX ROWS vs THE LINE THE FRONT THREE ACTUALLY DRIVE`)
for (const row of baseDef.itemBoxRows) {
  const s = row.at * track.length
  const i = Math.min(BINS - 1, Math.floor(row.at * BINS))
  const b = real.bins[i]
  const drivenLat = b.n ? b.lat / b.n : 0
  const drivenAbs = b.n ? b.absLat / b.n : 0
  const half = ((row.count - 1) / 2) * row.spread
  // A box is collected without deviating if the driven line passes within
  // roughly a racer's own half-width of one of them.
  const nearest = Math.min(...Array.from({ length: row.count },
    (_, k) => Math.abs(drivenLat - (k - (row.count - 1) / 2) * row.spread)))
  console.log(`  at=${row.at.toFixed(2)} s=${padL(f(s, 0), 5)}m  row +/-${f(half)}m  ` +
    `driven line ${padL(f(drivenLat, 1), 5)}m (mean |lat| ${f(drivenAbs, 1)}m)  ` +
    `nearest box ${f(nearest, 1)}m away -> ${nearest < 2.0 ? 'FREE (on the line)' : 'costs a deviation'}`)
}

// ---- Where the field is displaced ---------------------------------------
console.log(`\nDRIVEN LINE, most displaced sections (candidate item-row homes)`)
// Reported per lap-fifth, because an item row's job is a rhythm as well as a
// placement: five rows all crammed into the one corner where the line is
// displaced is not a fix, it is a different failure.
const FIFTHS = Number(arg('slices', '5'))
for (let q = 0; q < FIFTHS; q++) {
  const lo = Math.floor((q / FIFTHS) * BINS), hi = Math.floor(((q + 1) / FIFTHS) * BINS)
  let best = { i: lo, lat: 0, n: 0 }
  for (let i = lo; i < hi; i++) {
    const b = real.bins[i]
    if (b.n < 200) continue
    const lat = b.lat / b.n
    if (Math.abs(lat) > Math.abs(best.lat)) best = { i, lat, n: b.n }
  }
  const s = (best.i / BINS) * track.length
  const w = track.at(s).width
  console.log(`  lap ${(q / FIFTHS).toFixed(2)}-${((q + 1) / FIFTHS).toFixed(2)}: best at=${(best.i / BINS).toFixed(3)} ` +
    `s=${padL(f(s, 0), 5)}m  line ${padL(f(best.lat, 1), 6)}m  w=${f(w)}m  ${track.at(s).surface}` +
    `   -> widest row that still misses it: count 5 spread ${f(Math.max(0, (Math.abs(best.lat) - 2.0)) / 2)}m`)
}
