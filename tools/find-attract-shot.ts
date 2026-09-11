/**
 * WHERE DO YOU PUT A FIXED CAMERA SO IT SEES BOTH THE BLACK HOLE AND THE CARS?
 *
 * The title-screen shot has two requirements that pull against each other, and
 * eyeballing screenshots answers neither:
 *
 *   1. The hole has to be IN FRAME. It lives at a fixed sky direction, so that
 *      is a constraint on where the camera looks, not on where it stands.
 *   2. Cars have to keep arriving. A camera pointed across the circuit sees a
 *      car for half a second every lap; a camera pointed ALONG a straight sees
 *      one for several seconds as it comes at you.
 *
 * Both are computable from the spline alone -- no renderer, no browser, no
 * 4fps SwiftShader round trip. So compute them, rank every metre of the lap,
 * and hand the answer to the camera instead of hunting for it by hand the way
 * the splash-screen stills were hunted for.
 *
 *   npx tsx tools/find-attract-shot.ts [--track=hollowchoir] [--top=8]
 */
import { Track } from '../src/sim/track'
import { TRACKS_BY_ID, HOLLOWCHOIR } from '../src/content/tracks'
import { themeFor } from '../src/render/themes'

const arg = (k: string, d: string): string =>
  (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1]

const TRACK_ID = arg('track', 'hollowchoir')
const TOP = Number(arg('top', '8'))

const track = new Track(TRACKS_BY_ID[TRACK_ID] ?? HOLLOWCHOIR)

/**
 * THE HERO BODY'S AZIMUTH, read from the theme rather than retyped.
 *
 * A copy of this vector in two files is how the camera ends up pointing at
 * where the black hole used to be. The sky owns it; this reads it.
 */
const theme = themeFor(TRACK_ID)
const cel = (theme as unknown as {
  sky?: {
    celestial?: {
      hole?: { dir: [number, number, number]; sizeDeg: number }
      bodies?: { dir: [number, number, number]; sizeDeg: number }[]
    }
  }
}).sky?.celestial
const hero = cel?.hole ?? cel?.bodies?.[0]
if (!hero) {
  console.error(`${TRACK_ID} has no celestial hero body to aim at`)
  process.exit(1)
}

/** Yaw convention of the whole codebase: forward = (sin y, 0, cos y). */
const azimuthOf = (x: number, z: number): number => Math.atan2(x, z)
const DEG = 180 / Math.PI
const heroAz = azimuthOf(hero.dir[0], hero.dir[2])
const heroEl = Math.asin(
  hero.dir[1] / Math.hypot(hero.dir[0], hero.dir[1], hero.dir[2]),
)

/** Signed shortest angle from a to b, radians. */
function angDelta(a: number, b: number): number {
  let d = b - a
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}

console.log(`track    ${track.def.name ?? TRACK_ID}   length ${track.length.toFixed(1)}m`)
console.log(`hero     azimuth ${(heroAz * DEG).toFixed(1)}deg   elevation ${(heroEl * DEG).toFixed(1)}deg`
  + `   size ${hero.sizeDeg}deg`)
console.log()

interface Candidate {
  s: number
  /** |angle| between the track heading here and the hero body, degrees. */
  offAxis: number
  /** Metres of track ahead that stay within 25deg of this heading. */
  straight: number
  /** Mean track width over that run. */
  width: number
  score: number
}

const STEP = 2
const cands: Candidate[] = []

for (let s = 0; s < track.length; s += STEP) {
  const smp = track.at(s)
  const az = azimuthOf(smp.tangent.x, smp.tangent.z)
  const offAxis = Math.abs(angDelta(az, heroAz))

  // How far can you see down the road from here before it turns away? Walk
  // forward until the heading has diverged by more than 25 degrees. That is
  // the run a car stays roughly in frame for.
  let straight = 0
  let widthSum = 0
  let widthN = 0
  for (let d = 0; d < 320; d += STEP) {
    const f = track.at((s + d) % track.length)
    const faz = azimuthOf(f.tangent.x, f.tangent.z)
    if (Math.abs(angDelta(az, faz)) > 25 / DEG) break
    straight = d
    widthSum += f.width
    widthN++
  }
  const width = widthN > 0 ? widthSum / widthN : smp.width

  // Rank: being on-axis with the hole matters most, a long sightline second.
  // Both normalised so neither unit dominates the other by accident.
  const onAxis01 = Math.max(0, 1 - offAxis / (60 / DEG))
  const straight01 = Math.min(1, straight / 220)
  const score = onAxis01 * 0.62 + straight01 * 0.38

  cands.push({ s, offAxis: offAxis * DEG, straight, width, score })
}

cands.sort((a, b) => b.score - a.score)

// Suppress near-duplicates: the best stretch would otherwise fill the table
// with forty entries two metres apart.
const picked: Candidate[] = []
for (const c of cands) {
  if (picked.some((p) => Math.abs(p.s - c.s) < 60)) continue
  picked.push(c)
  if (picked.length >= TOP) break
}

console.log('  s (m)   off-axis   sightline   width   score')
console.log('  ------  ---------  ----------  ------  -----')
for (const c of picked) {
  console.log(
    `  ${c.s.toFixed(0).padStart(6)}  ${c.offAxis.toFixed(1).padStart(8)}d`
    + `  ${c.straight.toFixed(0).padStart(9)}m  ${c.width.toFixed(1).padStart(5)}m`
    + `  ${c.score.toFixed(3)}`,
  )
}

console.log()
const best = picked[0]
const bs = track.at(best.s)
console.log(`best anchor: s=${best.s.toFixed(0)}  heading `
  + `${(azimuthOf(bs.tangent.x, bs.tangent.z) * DEG).toFixed(1)}deg vs hero `
  + `${(heroAz * DEG).toFixed(1)}deg  (off by ${best.offAxis.toFixed(1)}deg)`)
console.log(`             half-width ${(bs.width / 2).toFixed(2)}m, `
  + `so a camera at lateral +/-${(bs.width / 2 + 3).toFixed(1)} sits off the racing line`)

// ---------------------------------------------------------------------------
// WHERE DO THE CARS ACTUALLY DRIVE?
//
// The camera has to stand somewhere the race is not. Half-width says where the
// ROAD ends; it says nothing about where eight AI drivers put themselves, and
// the difference is the whole question -- a camera on the geometric edge of a
// 24m road is in the middle of the action if the pack runs wide there.
//
// The splash-screen pass guessed at this and put a camera inside a barrier. So
// run the real sim, all-AI, and histogram the lateral of every racer as it
// passes the anchor. Then pick a lateral the field demonstrably does not use.
// ---------------------------------------------------------------------------
import { Race } from '../src/sim/race'
import { CHASSIS } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'
import { resetAI } from '../src/sim/ai'
import { emptyInput } from '../src/sim/types'
import type { SimConfig } from '../src/sim/types'

const N = 8
const cfg: SimConfig = {
  seed: 0x51ace9e2,
  totalLaps: 3,
  racerCount: N,
  trackId: track.def.id,
  chassisIds: Array.from({ length: N }, (_, i) => CHASSIS[i % CHASSIS.length].id),
  pilotIds: Array.from({ length: N }, (_, i) => PILOTS[i % PILOTS.length].id),
  localRacerIndex: -1,
  aiSkill: Array.from({ length: N }, (_, i) => 2 + (i % 3)),
}

resetAI()
const race = new Race(track, cfg)
const idle = emptyInput()

/** Lateral samples taken within +/-40m of the anchor, in 2m buckets. */
const WINDOW = 40
const BUCKET = 2
const hist = new Map<number, number>()
let passes = 0
let frames = 0
while (frames < 60 * 400 && race.state.phase !== 'finished') {
  for (const r of race.state.racers) if (!r.isAI) race.setInput(r.id, idle)
  race.step()
  frames++
  for (const r of race.state.racers) {
    let d = r.splineS - best.s
    while (d > track.length / 2) d -= track.length
    while (d < -track.length / 2) d += track.length
    if (Math.abs(d) > WINDOW) continue
    passes++
    const b = Math.round(r.lateral / BUCKET) * BUCKET
    hist.set(b, (hist.get(b) ?? 0) + 1)
  }
}

console.log()
console.log(`lateral occupancy at s=${best.s.toFixed(0)} +/-${WINDOW}m`
  + `   (${passes} racer-frames over ${frames} sim frames)`)
const keys = [...hist.keys()].sort((a, b) => a - b)
const peak = Math.max(...hist.values())
for (const k of keys) {
  const n = hist.get(k) ?? 0
  const bar = '#'.repeat(Math.max(1, Math.round((n / peak) * 46)))
  console.log(`  ${k.toFixed(0).padStart(5)}m  ${bar} ${((n / passes) * 100).toFixed(1)}%`)
}
const halfW = track.at(best.s).width / 2
const used = keys.filter((k) => (hist.get(k) ?? 0) / passes > 0.01)
console.log(`  road half-width ${halfW.toFixed(1)}m; field uses `
  + `${Math.min(...used).toFixed(0)}..${Math.max(...used).toFixed(0)}m`)
