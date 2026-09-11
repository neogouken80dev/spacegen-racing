/**
 * "IS THE CAMERA ACTUALLY A SET DISTANCE FROM THE CAR?"
 *
 * Drives a real Race under the AI controller for a lap and records, every sim
 * step, how far the chase camera ended up from the car it is chasing. Prints
 * the spread -- which is the whole question -- for the shipping rig and for the
 * rig with `TUNING.camera.distanceLock` and the two speed gains put back to
 * what they were before the lock existed, so the two are measured through the
 * SAME code on the SAME lap rather than across a git revision.
 *
 *   npx tsx tools/probe-camdist.ts [--track=rustfall] [--laps=1]
 *
 * The second half of the run does the same for the vertigo shot: it fires a
 * boost-sized impulse at racing speed and prints the apparent on-screen size of
 * the car against an identical camera that was not given one. Apparent size
 * goes as 1 / (d * tan(fov/2)) at the camera's ACTUAL distance -- see the long
 * note in camera.ts about why the target distance is the wrong number.
 */
import { ChaseCamera } from '../src/game/camera'
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { TRACKS } from '../src/content/tracks'
import { getDerived } from '../src/content/chassis'
import { TUNING as T } from '../src/content/tuning'
import { emptyInput } from '../src/sim/types'
import type { RacerState, SimConfig } from '../src/sim/types'

const arg = (k: string, d: string): string =>
  (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const trackId = arg('track', 'rustfall')
const LAPS = Number(arg('laps', '1'))

const C = T.camera as unknown as Record<string, number>
const DT = 1 / 60

const def = TRACKS.find((t) => t.id === trackId)
if (!def) throw new Error(`no such track: ${trackId}`)

const cfg = (): SimConfig => ({
  seed: 11, totalLaps: LAPS, racerCount: 8, trackId,
  chassisIds: ['solaire', 'bulwark', 'dray9', 'filament', 'vector7', 'solaire', 'bulwark', 'dray9'],
  pilotIds: ['pip', 'pip', 'pip', 'pip', 'pip', 'pip', 'pip', 'pip'],
  localRacerIndex: 0, aiSkill: [3, 3, 3, 3, 3, 3, 3, 3],
})

interface Row { min: number; max: number; mean: number; sd: number; p05: number; p95: number; n: number }

function stats(v: number[]): Row {
  const s = [...v].sort((a, b) => a - b)
  const mean = v.reduce((a, b) => a + b, 0) / v.length
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length)
  return {
    min: s[0], max: s[s.length - 1], mean, sd,
    p05: s[Math.floor(s.length * 0.05)], p95: s[Math.floor(s.length * 0.95)], n: v.length,
  }
}

const fmt = (r: Row): string =>
  `min ${r.min.toFixed(2)}  p05 ${r.p05.toFixed(2)}  mean ${r.mean.toFixed(2)}  `
  + `p95 ${r.p95.toFixed(2)}  max ${r.max.toFixed(2)}  sd ${r.sd.toFixed(2)}  `
  + `spread ${(r.max - r.min).toFixed(2)}m`

const dist = (cam: ChaseCamera, r: RacerState): number => Math.hypot(
  cam.camera.position.x - r.pos.x,
  cam.camera.position.y - r.pos.y,
  cam.camera.position.z - r.pos.z,
)

/** The car's on-screen size, in frame heights per metre of car. */
const apparent = (cam: ChaseCamera, r: RacerState): number =>
  1 / (Math.max(0.1, dist(cam, r)) * Math.tan(cam.camera.fov * 0.5 * Math.PI / 180))

/** One AI-driven lap; returns per-step camera distance and speed. */
function lap(label: string, lock: number, dGain: number, hGain: number, vertigo = true, hLock = -1): void {
  const before = [C.distanceLock, C.distanceSpeedGain, C.heightSpeedGain, C.boostDollyGain, C.heightLock]
  C.distanceLock = lock; C.distanceSpeedGain = dGain; C.heightSpeedGain = hGain
  if (!vertigo) C.boostDollyGain = 0
  if (hLock >= 0) C.heightLock = hLock

  const track = new Track(def!)
  const race = new Race(track, cfg())
  const r = race.state.racers[0]
  r.isAI = true
  const cam = new ChaseCamera(16 / 9)
  cam.gravity = track.hasGravity
  while (race.state.phase === 'countdown') race.step()
  cam.reset(r)

  const d: number[] = []
  const fast: number[] = []
  const hs: number[] = []
  const idle = emptyInput()
  for (let f = 0; f < 60 * 140 && !r.finished; f++) {
    race.setInput(0, idle)
    race.step()
    cam.update(r, DT, getDerived(r.chassisId).topSpeed, false, false)
    if (race.state.phase !== 'racing') continue
    const dd = dist(cam, r)
    d.push(dd)
    hs.push(cam.camera.position.y - r.pos.y)
    if (Math.hypot(r.vel.x, r.vel.z) > getDerived(r.chassisId).topSpeed * 0.8) fast.push(dd)
  }
  console.log(`  ${label.padEnd(30)} ${fmt(stats(d))}`)
  if (fast.length > 30) console.log(`  ${''.padEnd(30)} above 80% top speed: ${fmt(stats(fast))}`)
  const h = stats(hs)
  console.log(`  ${''.padEnd(30)} height above car:    ${fmt(h)}`)

  C.distanceLock = before[0]; C.distanceSpeedGain = before[1]
  C.heightSpeedGain = before[2]; C.boostDollyGain = before[3]; C.heightLock = before[4]
}

console.log(`\ncamera-to-car distance over ${LAPS} AI lap(s) of ${trackId}`)
console.log('  rig offset is 9.00m back, 3.60m up -> 9.69m of true distance\n')
lap('BEFORE (lag + 14% / 6%)', 0, 0.14, 0.06)
lap('AFTER  (shipping)', C.distanceLock, C.distanceSpeedGain, C.heightSpeedGain)
lap('AFTER, vertigo suppressed', C.distanceLock, C.distanceSpeedGain, C.heightSpeedGain, false)
for (const hl of [0.05, 0.10, 0.20, 0.35, 0.50, 1.0]) {
  lap(`   ... + heightLock ${hl}`, C.distanceLock, C.distanceSpeedGain, C.heightSpeedGain, false, hl)
}

// ---------------------------------------------------------------------------
// The shot
// ---------------------------------------------------------------------------
console.log('\nvertigo shot: apparent car size against a no-shot control')

function shot(label: string, impulse: number, reduceMotion: boolean): void {
  const track = new Track(def!)
  const race = new Race(track, cfg())
  const r = race.state.racers[0]
  r.isAI = true
  const withShot = new ChaseCamera(16 / 9)
  const control = new ChaseCamera(16 / 9)
  withShot.gravity = control.gravity = track.hasGravity
  while (race.state.phase === 'countdown') race.step()
  withShot.reset(r); control.reset(r)
  const top = getDerived(r.chassisId).topSpeed
  const idle = emptyInput()
  const tick = (): void => {
    withShot.update(r, DT, top, false, reduceMotion)
    control.update(r, DT, top, false, reduceMotion)
  }
  // Settle at racing pace.
  for (let f = 0; f < 60 * 12; f++) { race.setInput(0, idle); race.step(); tick() }
  withShot.addDolly(impulse)

  const ratios: number[] = []
  const pull: number[] = []
  let fovGap = 0
  for (let f = 0; f < 60 * 2.5; f++) {
    race.setInput(0, idle); race.step(); tick()
    ratios.push(apparent(withShot, r) / apparent(control, r))
    pull.push(dist(control, r) - dist(withShot, r))
    fovGap = Math.max(fovGap, withShot.camera.fov - control.camera.fov)
  }
  const min = Math.min(...ratios), max = Math.max(...ratios)
  const worst = Math.max(Math.abs(1 - min), Math.abs(max - 1)) * 100
  console.log(
    `  ${label.padEnd(30)} size ${min.toFixed(4)}..${max.toFixed(4)}  `
    + `worst ${worst.toFixed(2)}%  peak FOV +${fovGap.toFixed(1)} deg  `
    + `pull-in ${Math.max(...pull).toFixed(2)}m  `
    + `at 2s ${(100 * Math.max(...pull.slice(120)) / Math.max(1e-6, Math.max(...pull))).toFixed(0)}% of peak`,
  )
}

shot('boost impulse (0.55)', C.boostDollyGain, false)
shot('drift tier 3 (1.00)', 1.0, false)
shot('boost impulse, reduced motion', C.boostDollyGain, true)
console.log('')
