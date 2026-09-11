/**
 * "WHY DOES A BOOST FEEL LIKE THE SCREEN IS SHAKING?"
 *
 * The report: "upon boost, the screen shakes too much, causing disorientation."
 *
 * `ChaseCamera.shake` is the obvious suspect and it is INNOCENT. The only
 * addShake call site in the game is main.ts, gated on VfxSystem.hitFlash > 0.4
 * -- an IMPACT. No boost path touches it, and TUNING.camera.shakeBoost has no
 * reader anywhere in the source. Whatever the player is feeling, it is not the
 * shake system, and turning the shake down would have changed nothing.
 *
 * What DOES move on a boost is the vertigo shot: a FOV punch, a camera pull-in
 * along the view ray, and the composite's warp riding the same impulse.
 *
 * ---------------------------------------------------------------------------
 * METHOD, and why it is not the obvious one.
 *
 * Two Race instances in the same process DO NOT produce the same race. Same
 * seed, same config, same track: they agree to about 1e-6 for 290 frames and
 * then diverge, with the RNG state identical on both sides -- float drift
 * being chaos-amplified, not a logic fork. (The determinism GATE is unaffected:
 * it hashes one race per process.) The consequence for probes is sharp: a
 * table whose rows come from separate runs is comparing different laps, and
 * any difference smaller than lap-to-lap noise is not real.
 *
 * So this RECORDS ONE LAP ONCE and replays that identical tape through every
 * camera variant. Same car, same corner, same frame -- the only difference
 * between rows is the camera.
 *
 * THE METRIC is optical flow in degrees of the player's visual field per
 * second, which is what predicts motion sickness; camera travel in metres does
 * not. It is taken as a SAME-FRAME difference between the shot camera and a
 * control camera that never got the impulse, over a spread of points on the
 * road ahead. Same frame, same points, two cameras: every degree it reports is
 * the shot's doing and none of it is the driving.
 *
 *   npx tsx tools/probe-boostcam.ts [--track=rustfall]
 * ---------------------------------------------------------------------------
 */
import * as THREE from 'three'
import { ChaseCamera, type CameraSettings } from '../src/game/camera'
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

const C = T.camera as unknown as Record<string, number>
const DT = 1 / 60
const DEG = Math.PI / 180
const def = TRACKS.find((t) => t.id === trackId)
if (!def) throw new Error(`no such track: ${trackId}`)

const track = new Track(def)
const race = new Race(track, {
  seed: 11, totalLaps: 3, racerCount: 8, trackId,
  chassisIds: ['solaire', 'bulwark', 'dray9', 'filament', 'vector7', 'solaire', 'bulwark', 'dray9'],
  pilotIds: ['pip', 'pip', 'pip', 'pip', 'pip', 'pip', 'pip', 'pip'],
  localRacerIndex: 0, aiSkill: [3, 3, 3, 3, 3, 3, 3, 3],
} as SimConfig)
const rec = race.state.racers[0]
rec.isAI = true
while (race.state.phase === 'countdown') race.step()
const top = getDerived(rec.chassisId).topSpeed

// ---------------------------------------------------------------------------
// 1. THE TAPE
// ---------------------------------------------------------------------------
interface Frame {
  pos: THREE.Vector3; vel: THREE.Vector3; fwd: THREE.Vector3; up: THREE.Vector3
  yaw: number; yawRate: number; driftSide: number; driftInward: number
  boostMag: number; splineS: number
}
const tape: Frame[] = []
{
  const idle = emptyInput()
  for (let f = 0; f < 60 * 26; f++) {
    race.setInput(0, idle); race.step()
    if (race.state.phase !== 'racing') continue
    tape.push({
      pos: new THREE.Vector3(rec.pos.x, rec.pos.y, rec.pos.z),
      vel: new THREE.Vector3(rec.vel.x, rec.vel.y, rec.vel.z),
      fwd: new THREE.Vector3(rec.fwd.x, rec.fwd.y, rec.fwd.z),
      up: new THREE.Vector3(rec.up.x, rec.up.y, rec.up.z),
      yaw: rec.yaw, yawRate: rec.yawRate, driftSide: rec.driftSide,
      driftInward: rec.driftInward, boostMag: rec.boostMag, splineS: rec.splineS,
    })
  }
}
const FIRE = Math.min(60 * 12, tape.length - 130)
const WINDOW = 60 * 2

const asRacer = (f: Frame): RacerState => ({
  ...rec,
  pos: { x: f.pos.x, y: f.pos.y, z: f.pos.z },
  vel: { x: f.vel.x, y: f.vel.y, z: f.vel.z },
  fwd: { x: f.fwd.x, y: f.fwd.y, z: f.fwd.z },
  up: { x: f.up.x, y: f.up.y, z: f.up.z },
  yaw: f.yaw, yawRate: f.yawRate, driftSide: f.driftSide,
  driftInward: f.driftInward, boostMag: f.boostMag, splineS: f.splineS,
} as RacerState)

/** A spread of points across the road ahead -- what the player is looking at. */
function fieldPoints(f: Frame): THREE.Vector3[] {
  const out: THREE.Vector3[] = []
  const right = new THREE.Vector3().copy(f.fwd).cross(f.up).normalize()
  for (const ahead of [16, 30, 55, 95]) {
    for (const side of [-11, -4, 4, 11]) {
      out.push(new THREE.Vector3().copy(f.pos)
        .addScaledVector(f.fwd, ahead).addScaledVector(right, side))
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 2. REPLAY
// ---------------------------------------------------------------------------
interface Result {
  travel: number; rate: number; jerk: number
  fovLo: number; fovHi: number; fovRate: number
  dispPeak: number; flowPeak: number; flowHi: number
}

function replay(
  impulse: number,
  tweak: Record<string, number> = {},
  set: Partial<CameraSettings> = {},
): Result {
  const saved: Record<string, number> = {}
  for (const k of Object.keys(tweak)) { saved[k] = C[k]; C[k] = tweak[k] }

  const shot = new ChaseCamera(16 / 9)
  const ctl = new ChaseCamera(16 / 9)
  shot.gravity = ctl.gravity = track.hasGravity
  // BOTH cameras get the settings; only one gets the impulse. Otherwise a row
  // that moves the rig back would be comparing two different rigs and calling
  // the difference "what the boost added".
  shot.applySettings(set); ctl.applySettings(set)
  shot.reset(asRacer(tape[0])); ctl.reset(asRacer(tape[0]))

  const d: number[] = [], fov: number[] = [], disp: number[] = []
  const v = new THREE.Vector3()
  for (let i = 0; i < FIRE + WINDOW && i < tape.length; i++) {
    const f = tape[i]
    const r = asRacer(f)
    shot.update(r, DT, top, false, false)
    ctl.update(r, DT, top, false, false)
    if (i === FIRE && impulse >= 0) shot.addDolly(impulse)
    if (i < FIRE - 1) continue

    d.push(shot.camera.position.distanceTo(f.pos))
    fov.push(shot.camera.fov)

    // SAME FRAME, SAME POINTS, TWO CAMERAS.
    shot.camera.updateMatrixWorld(true)
    ctl.camera.updateMatrixWorld(true)
    const pts = fieldPoints(f)
    let sum = 0, n = 0
    for (const p of pts) {
      v.copy(p).project(shot.camera)
      const ax = v.x, ay = v.y, az = v.z
      v.copy(p).project(ctl.camera)
      if (az > 1 || v.z > 1) continue
      if (Math.abs(ax) > 1.6 && Math.abs(v.x) > 1.6) continue
      // NDC 1.0 vertical is half the vertical field, so this is degrees.
      sum += Math.hypot((ax - v.x) * shot.camera.aspect, ay - v.y) * shot.camera.fov * 0.5
      n++
    }
    disp.push(n > 0 ? sum / n : 0)
  }
  for (const k of Object.keys(saved)) C[k] = saved[k]

  const der = (a: number[]): number[] => a.slice(1).map((x, i) => (x - a[i]) / DT)
  const pk = (a: number[]): number => (a.length ? Math.max(...a.map(Math.abs)) : 0)
  const rate = der(d)
  const fl = der(disp).map(Math.abs)
  // How long the added flow stays above the comfort threshold.
  const hi = fl.filter((x) => x > 40).length * DT
  return {
    travel: Math.max(...d) - Math.min(...d), rate: pk(rate), jerk: pk(der(rate)),
    fovLo: Math.min(...fov), fovHi: Math.max(...fov), fovRate: pk(der(fov)),
    dispPeak: pk(disp), flowPeak: pk(fl), flowHi: hi,
  }
}

function row(
  label: string, impulse: number,
  tweak: Record<string, number> = {}, set: Partial<CameraSettings> = {},
): void {
  const r = replay(impulse, tweak, set)
  console.log(
    `  ${label.padEnd(34)}`
    + ` move ${r.travel.toFixed(2)}m @${r.rate.toFixed(1)}m/s`
    + `  fov ${(r.fovHi - r.fovLo).toFixed(1)}d @${r.fovRate.toFixed(0)}d/s`
    + `  ||  shift ${r.dispPeak.toFixed(1)}d`
    + `  FLOW ${r.flowPeak.toFixed(0)} deg/s`
    + `  over-40 ${r.flowHi.toFixed(2)}s`,
  )
}

console.log(`\nWHAT A BOOST DOES TO THE PICTURE -- ${trackId}, one recorded lap replayed`)
console.log('  "flow" = optical flow the SHOT adds, degrees of visual field per second.')
console.log('  Sustained whole-field motion over ~40 deg/s is where simulator')
console.log('  sickness starts being reported; brief transients are tolerated.\n')

console.log('  --- baseline -----------------------------------------------------')
row('no shot at all (control)', -1)
console.log('\n  --- as shipped ---------------------------------------------------')
row(`boost, gain ${C.boostDollyGain}`, C.boostDollyGain)
row('drift tier 3 (1.00), for scale', 1.0)

console.log('\n  --- turning the impulse down -------------------------------------')
for (const g of [0.45, 0.35, 0.28, 0.20, 0.12]) row(`boost gain ${g.toFixed(2)}`, g)

console.log('\n  --- which HALF of the shot is doing it ----------------------------')
row('gain 0.55, camera move off', C.boostDollyGain, { dollyPull: 0 })
row('gain 0.55, lens punch halved', C.boostDollyGain, { dollyFov: 15 })
row('gain 0.55, lens 15 + pull 0.85', C.boostDollyGain, { dollyFov: 15 })
row('gain 0.28, lens 18', 0.28, { dollyFov: 18 })
row('gain 0.28, lens 18, slower decay', 0.28, { dollyFov: 18, dollyHalfLife: 0.40 })

console.log('\n  --- THE CANDIDATE: gain 0.30, lens 20 -----------------------------')
row('boost  (candidate)', 0.30, { dollyFov: 20 })
row('tier 3 (candidate)', 1.00, { dollyFov: 20 })
row('boost  (candidate) @ 10.5m', 0.30, { dollyFov: 20 }, { distance: 10.5 })
row('tier 3 (candidate) @ 10.5m', 1.00, { dollyFov: 20 }, { distance: 10.5 })

console.log('\n  --- the player dial, over the candidate defaults ------------------')
for (const b of [0, 0.5, 1.0, 1.5]) {
  row(`boost dial ${b.toFixed(1)}`, 0.30, { dollyFov: 20 }, { distance: 10.5, boost: b })
}

/**
 * THE TRACKING DIAL needs a different question asked of it.
 *
 * The flow metric above is a same-frame difference between two cameras, so
 * with no impulse it is identically zero -- correctly, and uselessly. What
 * the tracking dial actually changes is THE CORNER SWING: how far the rig
 * drifts off "straight behind the car" while the road bends, which is the
 * thing that slews the world across the frame on every turn.
 *
 * So: the angle between where the camera actually stands and dead astern,
 * over the whole recorded lap, in degrees. And the yaw LAG -- how far the
 * camera's heading trails the car's -- which is the other half of the feel.
 */
function swing(set: Partial<CameraSettings>): {
  swing: number, swingP95: number, lag: number, skipped: number, dbg: string[],
} {
  const cam = new ChaseCamera(16 / 9)
  cam.gravity = track.hasGravity
  cam.applySettings(set)
  cam.reset(asRacer(tape[0]))
  const a: number[] = []
  const l: number[] = []
  let skip = 0
  const dbg: string[] = []
  const off = new THREE.Vector3(), astern = new THREE.Vector3()
  for (let i = 0; i < tape.length; i++) {
    const f = tape[i]
    cam.update(asRacer(f), DT, top, false, false)
    off.copy(cam.camera.position).sub(f.pos)
    off.addScaledVector(f.up, -off.dot(f.up))
    astern.copy(f.fwd).multiplyScalar(-1)
    astern.addScaledVector(f.up, -astern.dot(f.up))
    // DEGENERACY, and why the guard is this loose rather than 1e-6.
    //
    // Both vectors are projected into the ground plane. On a ramp the nose
    // pitches toward vertical, and its ground-plane shadow shrinks to nothing
    // -- at 89 degrees of pitch the projection is 0.017 long and its DIRECTION
    // is pure numerical noise, which a 1e-6 guard happily lets through. That
    // is where the first version of this probe got its 180-degree peaks: not
    // from the camera swinging round the car, but from asking "which way is
    // the car pointing, flattened" about a car pointing at the sky.
    //
    // 0.2 is about 11 degrees clear of vertical. Frames inside that are
    // counted and reported rather than silently dropped.
    if (off.length() < 0.2 || astern.length() < 0.2) { skip++; continue }
    // ONLY WHILE THE CAR IS DRIVING.
    //
    // The first version of this metric reported a 180-degree swing and the
    // obvious explanation -- a near-vertical nose on a ramp flattening to
    // noise -- was wrong: zero frames were near vertical. The real cause was a
    // SPIN-OUT at frame 753, where the CAR rotates through a full turn while
    // the camera sits behind where it was. The angle between "where the rig
    // stands" and "where the nose points" then sweeps the whole circle, which
    // is correct behaviour and nothing to do with the corner trail this dial
    // controls.
    //
    // So: moving at a racing speed, and going roughly where it is pointing.
    // A spun or stationary car is not what "how much does the camera swing
    // through a corner" is asking about.
    const crab = f.vel.length() > 1
      ? f.vel.clone().normalize().angleTo(new THREE.Vector3().copy(f.fwd).normalize()) / DEG
      : 0
    if (f.vel.length() < 15 || crab > 45) { skip++; continue }
    off.normalize(); astern.normalize()
    a.push(off.angleTo(astern) / DEG)
    // Where the LENS points, against where the car points.
    const fwdCam = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.camera.quaternion)
    fwdCam.addScaledVector(f.up, -fwdCam.dot(f.up))
    const nose = astern.clone().multiplyScalar(-1)
    if (fwdCam.length() > 0.2) l.push(fwdCam.normalize().angleTo(nose) / DEG)
    void dbg
  }
  const sorted = [...a].sort((x, y) => x - y)
  return {
    swing: Math.max(...a),
    swingP95: sorted[Math.floor(sorted.length * 0.95)],
    lag: l.length ? Math.max(...l) : 0,
    skipped: skip,
    dbg,
  }
}

console.log('\n  --- the TRACKING dial: corner swing over the whole lap ------------')
console.log('    "swing" = how far off dead-astern the rig gets, degrees.')
console.log('    "lag"   = how far the lens trails the nose, degrees.\n')
for (const t of [0, 0.15, 0.30, 0.50, 0.75, 1.0]) {
  const r = swing({ distance: 10.5, tracking: t })
  const tag = Math.abs(t - 0.30) < 1e-9 ? '  <- default (the shipped feel)' : ''
  console.log(
    `  tracking ${t.toFixed(2)}   swing peak ${r.swing.toFixed(1)}d  p95 ${r.swingP95.toFixed(1)}d`
    + `   lens lag ${r.lag.toFixed(1)}d   (${r.skipped} non-driving frames excluded)${tag}`,
  )
}
console.log('')

