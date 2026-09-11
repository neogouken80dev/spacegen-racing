/**
 * "DO THE DIALS ACTUALLY DO ANYTHING?"
 *
 * Two complaints, one probe:
 *   - "I am not seeing an overall effect for the tracking buffer or the boost
 *      effect" -- both maxed out, both feel inert.
 *   - "The tunnel-vision effect needs to be stronger."
 *
 * A dial you cannot feel at either end is a worse failure than a bad default:
 * it teaches the player the control is fake. So this measures the TRAVEL of
 * each dial -- what changes between its stops -- and, for the tracking dial,
 * measures it ON SCREEN rather than in the rig, because that distinction is
 * the entire bug. The rig was moving 15 degrees and the picture was not
 * changing, because the screen anchor was rotating the camera by exactly as
 * much as the rig had swung in order to hold the car on its mark.
 *
 * THE TUNNEL VISION is reproduced from postfx.ts in the shader's own terms, so
 * a row is what the player sees rather than a proxy for it.
 *
 *   npx tsx tools/probe-camfeel.ts
 */
import * as THREE from 'three'
import {
  ChaseCamera, DEFAULT_CAMERA_SETTINGS, angleToAnchorY, type CameraSettings,
} from '../src/game/camera'
import { TUNING as T } from '../src/content/tuning'
import type { RacerState } from '../src/sim/types'

const C = T.camera as unknown as Record<string, number>
const DT = 1 / 60
const DEG = Math.PI / 180
/** postfx.ts. */
const WARP_SHAPE = 0.65
/** A 944-high reference frame, the one the anchor was measured against. */
const FRAME_PX = 944

// --- a car on a perfect circle ---------------------------------------------
const R = 120, V = 60
const frame = (t: number): RacerState => {
  const a = V * t / R
  return {
    pos: { x: Math.cos(a) * R, y: 0, z: Math.sin(a) * R },
    vel: { x: -Math.sin(a) * V, y: 0, z: Math.cos(a) * V },
    fwd: { x: -Math.sin(a), y: 0, z: Math.cos(a) },
    up: { x: 0, y: 1, z: 0 },
    yaw: Math.atan2(-Math.sin(a), Math.cos(a)),
    yawRate: -V / R, driftSide: 0, driftInward: 1,
    boostMag: 0, boostSource: 'none', altitude: 0, grounded: true,
  } as unknown as RacerState
}

function corner(set: Partial<CameraSettings>): {
  swing: number; lag: number; drift: number
} {
  const cam = new ChaseCamera(16 / 9)
  cam.applySettings(set)
  cam.reset(frame(0))
  let swing = 0, lag = 0, drift = 0
  const off = new THREE.Vector3(), astern = new THREE.Vector3()
  const nose = new THREE.Vector3(), fc = new THREE.Vector3(), v = new THREE.Vector3()
  const tx = C.anchorX * 2 - 1
  const ty = 1 - angleToAnchorY(set.angle ?? DEFAULT_CAMERA_SETTINGS.angle) * 2
  for (let i = 1; i < 60 * 8; i++) {
    const f = frame(i * DT)
    cam.update(f, DT, 76, false, false)
    if (i < 60 * 4) continue
    off.set(cam.camera.position.x - f.pos.x, 0, cam.camera.position.z - f.pos.z).normalize()
    astern.set(-f.fwd.x, 0, -f.fwd.z).normalize()
    nose.copy(astern).multiplyScalar(-1)
    swing = Math.max(swing, off.angleTo(astern) / DEG)
    fc.set(0, 0, -1).applyQuaternion(cam.camera.quaternion)
    fc.y = 0
    if (fc.length() > 0.2) lag = Math.max(lag, fc.normalize().angleTo(nose) / DEG)
    // THE ONLY COLUMN THE PLAYER CAN SEE: how far the car gets from its mark,
    // as a fraction of frame HEIGHT. NDC spans -1..1, hence the 0.5.
    cam.camera.updateMatrixWorld(true)
    v.set(f.pos.x, f.pos.y, f.pos.z).project(cam.camera)
    drift = Math.max(drift, Math.hypot((v.x - tx) * cam.camera.aspect, v.y - ty) * 0.5)
  }
  return { swing, lag, drift }
}

// --- the composite's tunnel, from postfx.ts --------------------------------
const shaped = (i: number): number => Math.pow(Math.min(1, Math.max(0, i)), WARP_SHAPE)
/** Current shader constants. */
function tunnel(impulse: number): {
  warp: number; inner: number; rim: number; streak: number; blur: number
} {
  const warp = shaped(impulse)
  return {
    warp,
    inner: 0.32 - 0.24 * warp,
    rim: 1 - warp * 0.46,
    streak: Math.min(1, warp * 1.00),
    blur: warp * warp * 0.95 * 0.34,
  }
}
/** The shader as it was BEFORE this pass, for the before column. */
function tunnelOld(impulse: number): { warp: number; inner: number; rim: number } {
  const warp = shaped(impulse)
  return { warp, inner: 0.32 - 0.15 * warp, rim: 1 - warp * 0.30 }
}

const NEW: Partial<CameraSettings> = { distance: 14, height: 5.8, angle: 12 }

console.log('\n=== THE TRACKING DIAL ==========================================')
console.log('120m corner at 60 m/s, rig at the new defaults (14.0m / 5.8m / 12 deg)\n')
console.log('  swing     = degrees the RIG gets off dead astern')
console.log('  ON SCREEN = how far the CAR gets from its mark. This is the one')
console.log('              the player can see, and the one that used to be flat.\n')
for (const t of [0, 0.25, 0.5, 0.75, 1.0]) {
  const r = corner({ ...NEW, tracking: t })
  const tag = t === DEFAULT_CAMERA_SETTINGS.tracking ? '  <- default' : ''
  console.log(
    `  tracking ${(t * 100).toFixed(0).padStart(3)}%   swing ${r.swing.toFixed(2).padStart(6)}`
    + `   lens lag ${r.lag.toFixed(2).padStart(6)}`
    + `   ON SCREEN ${(r.drift * 100).toFixed(2).padStart(5)}% of frame`
    + ` (${(r.drift * FRAME_PX).toFixed(0).padStart(3)} px)${tag}`,
  )
}
const lo = corner({ ...NEW, tracking: 0 }), hi = corner({ ...NEW, tracking: 1 })
console.log(
  `\n  TRAVEL: rig ${(hi.swing - lo.swing).toFixed(1)} deg,`
  + `  on screen ${((hi.drift - lo.drift) * FRAME_PX).toFixed(0)} px`
  + ` -- before the buffer existed the on-screen figure was under 5 px at every stop.`,
)

console.log('\n=== THE TUNNEL VISION ==========================================')
console.log('  inner = where the dark starts, as a fraction of the radius.')
console.log('          Smaller means the tunnel has walked further in.')
console.log('  rim   = what the frame edge is multiplied by at full vignette.\n')
console.log('  source                           impulse   warp   inner    rim   streak   blur')
const G = C.warpGain
const rows: [string, number][] = [
  ['pad boost, dial 100%', C.boostDollyGain * G],
  ['pad boost, dial 140% (default)', C.boostDollyGain * G * 1.4],
  ['pad boost, dial 250% (max)', C.boostDollyGain * G * 2.5],
  ['drift tier 0, dial 140%', T.camera.dollyPerTier[0] * G * 1.4],
  ['drift tier 1, dial 140%', T.camera.dollyPerTier[1] * G * 1.4],
  ['drift tier 2, dial 140%', T.camera.dollyPerTier[2] * G * 1.4],
  ['drift tier 3, dial 140%', T.camera.dollyPerTier[3] * G * 1.4],
  ['pad boost, dial 50%', C.boostDollyGain * G * 0.5],
  ['pad boost, dial 200%', C.boostDollyGain * G * 2.0],
]
for (const [label, d] of rows) {
  const v = tunnel(d)
  console.log(
    `  ${label.padEnd(33)} ${d.toFixed(2).padStart(5)}   ${v.warp.toFixed(3)}`
    + `  ${v.inner.toFixed(3)}  ${v.rim.toFixed(3)}   ${v.streak.toFixed(3)}  ${v.blur.toFixed(3)}`,
  )
}
const before = tunnelOld(0.55)
const now = tunnel(C.boostDollyGain * G * 1.4)
console.log(`\n  BEFORE this whole pass, a pad boost gave  warp ${before.warp.toFixed(3)}`
  + `  inner ${before.inner.toFixed(3)}  rim ${before.rim.toFixed(3)}`)
console.log(`  At the new default it gives              warp ${now.warp.toFixed(3)}`
  + `  inner ${now.inner.toFixed(3)}  rim ${now.rim.toFixed(3)}`)
console.log(
  `\n  Warp is ${(now.warp / before.warp * 100).toFixed(0)}% of what it was,`
  + ` the dark starts ${((before.inner - now.inner) / before.inner * 100).toFixed(0)}% further in,`
  + ` and the rim is ${((before.rim - now.rim) / before.rim * 100).toFixed(0)}% darker.`,
)
console.log('  The camera meanwhile is still at the calm 0.30 impulse.\n')
