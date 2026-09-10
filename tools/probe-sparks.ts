/**
 * IMPACT SPARK COST AND CORRECTNESS, headless.
 *
 * The sparks are the first effect in this file whose particles are written
 * WITH A BIRTH STAMP IN THE FUTURE: a bouncing spark is three pooled
 * particles, the arc, the bounce and the settled ember, and the CPU solves
 * where the bounce happens at spawn time rather than integrating anything per
 * frame. Two things follow that a screenshot cannot settle:
 *
 *   1. THE ARC AND THE BOUNCE HAVE TO AGREE. The landing point is computed
 *      here with the closed form; the position that actually draws comes out
 *      of the vertex shader. If the two integrate different motion the spark
 *      teleports at the bounce, and at 1-5 fps under SwiftShader nobody will
 *      ever catch that in a photograph. This re-implements the SHADER's
 *      position expression exactly and checks the seam.
 *   2. THE WORST CASE HAS TO BE A NUMBER. Eight cars, every contact frame,
 *      with particles that outlive the impact is the thing the perf risk was
 *      flagged on, so it is driven here at full rate and the live particle
 *      count is measured rather than reasoned about.
 *
 *   npx tsx tools/probe-sparks.ts [--tier=high|medium|low]
 */
import * as THREE from 'three'
import { createVfx } from '../src/render/vfx'
import { QUALITY_PRESETS } from '../src/render/api'
import { Race } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { RUSTFALL } from '../src/content/tracks'
import { resetAI } from '../src/sim/ai'
import { PILOTS } from '../src/content/pilots'
import { TUNING } from '../src/content/tuning'
import type { SimConfig, RacerEvent } from '../src/sim/types'

const arg = (k: string, d: string): string =>
  (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const tier = arg('tier', 'high') as 'high' | 'medium' | 'low'

const scene = new THREE.Scene()
const vfx = createVfx(scene, QUALITY_PRESETS[tier]) as unknown as {
  update(dt: number, st: unknown, cam: unknown, id: number): void
  dispose(): void
  reduceMotion: boolean | null
  pool: number
  aPos: Float32Array; aVel: Float32Array; aMisc: Float32Array; aMisc2: Float32Array; aAxis: Float32Array
  time: number
  slotTokens: number
}

resetAI()
const track = new Track(RUSTFALL)
const cfg: SimConfig = {
  seed: 7, totalLaps: 3, racerCount: 8, trackId: RUSTFALL.id,
  chassisIds: ['solaire', 'bulwark', 'vector7', 'dray9', 'filament', 'solaire', 'bulwark', 'vector7'],
  pilotIds: PILOTS.slice(0, 8).map((p) => p.id),
  localRacerIndex: 0, aiSkill: [3, 3, 3, 3, 3, 3, 3, 3],
}
const race = new Race(track, cfg)
const st = race.state
const cam = new THREE.Vector3(0, 6, -12)

/** THE SHADER'S OWN POSITION EXPRESSION, transcribed. */
function shaderPos(i: number, t: number, out: THREE.Vector3): boolean {
  const i3 = i * 3, i4 = i * 4
  const birth = vfx.aMisc[i4], life = vfx.aMisc[i4 + 1]
  const age = t - birth
  const u = life > 0 ? age / life : 2
  if (u < 0 || u >= 1) return false
  const k = vfx.aMisc2[i4 + 1]
  const integ = k > 0.001 ? (1 - Math.exp(-k * age)) / k : age
  const g = vfx.aMisc2[i4]
  out.set(
    vfx.aPos[i3] + vfx.aVel[i3] * integ + vfx.aAxis[i3] * (0.5 * g * age * age),
    vfx.aPos[i3 + 1] + vfx.aVel[i3 + 1] * integ + vfx.aAxis[i3 + 1] * (0.5 * g * age * age),
    vfx.aPos[i3 + 2] + vfx.aVel[i3 + 2] * integ + vfx.aAxis[i3 + 2] * (0.5 * g * age * age),
  )
  return true
}

/** Live particles at time t: birth <= t < birth + life. */
function live(t: number): { live: number; pending: number; kinds: Record<number, number> } {
  let n = 0, pending = 0
  const kinds: Record<number, number> = {}
  for (let i = 0; i < vfx.pool; i++) {
    const i4 = i * 4
    const birth = vfx.aMisc[i4], life = vfx.aMisc[i4 + 1]
    if (life <= 0) continue
    const age = t - birth
    if (age < 0) { pending++; continue }
    if (age >= life) continue
    n++
    const kd = Math.round(vfx.aMisc2[i4 + 2])
    kinds[kd] = (kinds[kd] ?? 0) + 1
  }
  return { live: n, pending, kinds }
}

// ---------------------------------------------------------------------------
// 1. SEAM CHECK. One racer, one full-force wall event, then walk every
//    particle written this frame and match each leg's end against the next
//    leg's start using the SHADER's formula.
// ---------------------------------------------------------------------------
const r0 = st.racers[0]
for (let i = 1; i < st.racers.length; i++) st.racers[i].pos.y = -900
r0.grounded = true
r0.altitude = 0.55
const before = { head: 0 }
;(vfx as unknown as { head: number }).head = 0
before.head = 0

const nrm = { x: 1, y: 0, z: 0 }
r0.events.length = 0
r0.events.push({
  t: 'wall', force: 22,
  px: r0.pos.x, py: r0.pos.y, pz: r0.pos.z,
  nx: nrm.x, ny: nrm.y, nz: nrm.z,
} as RacerEvent)
st.frame++
vfx.update(1 / 60, st, cam, 0)

const t0 = vfx.time
const a = new THREE.Vector3(), b = new THREE.Vector3()
// Collect everything written, ordered by slot.
type P = { i: number; birth: number; life: number; kind: number; x: number; y: number; z: number }
const written: P[] = []
for (let i = 0; i < vfx.pool; i++) {
  const i4 = i * 4, i3 = i * 3
  if (vfx.aMisc[i4 + 1] <= 0) continue
  written.push({
    i, birth: vfx.aMisc[i4], life: vfx.aMisc[i4 + 1], kind: Math.round(vfx.aMisc2[i4 + 2]),
    x: vfx.aPos[i3], y: vfx.aPos[i3 + 1], z: vfx.aPos[i3 + 2],
  })
}
let seams = 0, worstSeam = 0, chains = 0
for (let j = 0; j < written.length - 1; j++) {
  const p = written[j], q = written[j + 1]
  // A chained pair: the next slot is born exactly when this one's flight ends.
  const dt = q.birth - (p.birth + p.life / 1.55)
  if (Math.abs(dt) > 1e-4) continue
  chains++
  // Only leg -> leg. The settled ember is deliberately lifted 3 cm off the
  // road so it is not z-fighting the surface it is lying on, so measuring it
  // here would only ever re-measure that 3 cm; its placement is checked
  // against the road plane instead, below.
  if (q.kind !== 1) continue
  // Where the shader has p at the moment of the bounce...
  if (!shaderPos(p.i, p.birth + p.life / 1.55 - 1e-5, a)) continue
  b.set(q.x, q.y, q.z)
  const d = a.distanceTo(b)
  seams++
  if (d > worstSeam) worstSeam = d
}
console.log(`seam check: ${chains} chained legs, ${seams} leg->leg seams measured, worst gap ${worstSeam.toExponential(2)} m`)

// SETTLED EMBERS. Identified by a birth stamp in the FUTURE -- the flash is a
// K_SPRITE too, and counting by kind alone measured the flash and called it an
// ember (it sat 0.245 m up, which is the flank height the flash is placed at).
const roadY = r0.pos.y - r0.altitude
let embers = 0, worstEmberY = 0, legs = 0
for (const p of written) {
  if (p.birth <= t0 + 1e-6) continue
  if (p.kind !== 0) { legs++; continue }
  embers++
  const dy = Math.abs(p.y - roadY - 0.03)
  if (dy > worstEmberY) worstEmberY = dy
}
console.log(`settled embers: ${embers}, worst height error vs road plane ${worstEmberY.toExponential(2)} m` +
  `  (delayed bounce legs: ${legs})`)
console.log(`one full-force wall event wrote ${written.length} particles`)

// ---------------------------------------------------------------------------
// 1b. GRAVITY TRACKS. "Down" is the racer's own up, not world -Y, and the road
//     a spark bounces off on Aetherion or The Hollow Choir can be a wall or a
//     ceiling. The plane is built from `r.up` and `r.altitude`, so the check is
//     that a tilted racer's embers land on the TILTED plane -- a world-Y
//     assumption anywhere in the solve shows up here as metres of error.
// ---------------------------------------------------------------------------
{
  const vf = vfx as unknown as { gravity: boolean }
  vf.gravity = true
  // 62 degrees of bank, which is a wall-ride rather than a camber.
  const a = 1.09
  const ux = Math.sin(a), uy = Math.cos(a), uz = 0
  r0.up.x = ux; r0.up.y = uy; r0.up.z = uz
  // fwd must stay perpendicular to up or the racer's basis is degenerate.
  r0.fwd.x = 0; r0.fwd.y = 0; r0.fwd.z = 1
  r0.grounded = true
  r0.altitude = 0.55
  ;(vfx as unknown as { head: number }).head = 0
  for (let i = 0; i < vfx.pool; i++) vfx.aMisc[i * 4 + 1] = 0
  r0.events.length = 0
  r0.events.push({
    t: 'wall', force: 22,
    px: r0.pos.x, py: r0.pos.y, pz: r0.pos.z,
    // A barrier normal perpendicular to that up.
    nx: uy, ny: -ux, nz: 0,
  } as RacerEvent)
  st.frame++
  vfx.update(1 / 60, st, cam, 0)
  // AFTER the update: `this.time` has advanced by dt, and the impact flash is a
  // K_SPRITE born at exactly that time. Comparing against the time before the
  // update let the flash through as an ember and measured it 0.245 m up, which
  // is the flank height the flash is placed at -- the same mistake the flat
  // case above already made once.
  const tPre = vfx.time
  const px0 = r0.pos.x - ux * r0.altitude
  const py0 = r0.pos.y - uy * r0.altitude
  const pz0 = r0.pos.z - uz * r0.altitude
  let n = 0, worst = 0
  for (let i = 0; i < vfx.pool; i++) {
    const i4 = i * 4, i3 = i * 3
    if (vfx.aMisc[i4 + 1] <= 0) continue
    if (vfx.aMisc[i4] <= tPre + 1e-6) continue
    if (Math.round(vfx.aMisc2[i4 + 2]) !== 0) continue
    n++
    const h = (vfx.aPos[i3] - px0) * ux + (vfx.aPos[i3 + 1] - py0) * uy + (vfx.aPos[i3 + 2] - pz0) * uz
    const e = Math.abs(h - 0.03)
    if (e > worst) worst = e
    // ...and the particle must carry that up as its own axis, or the shader
    // integrates its gravity toward world -Y and the arc leaves the wall.
    const ax = Math.abs(vfx.aAxis[i3] - ux) + Math.abs(vfx.aAxis[i3 + 1] - uy) + Math.abs(vfx.aAxis[i3 + 2] - uz)
    if (ax > 1e-6) { console.log(`  AXIS MISMATCH on slot ${i}`); break }
  }
  console.log(`gravity track (62 deg bank): ${n} embers, worst height error vs the TILTED plane ${worst.toExponential(2)} m`)
  vf.gravity = false
  r0.up.x = 0; r0.up.y = 1; r0.up.z = 0
  r0.fwd.x = 0; r0.fwd.y = 0; r0.fwd.z = 1
}

// ---------------------------------------------------------------------------
// 2. WORST CASE. Eight cars, every frame, one wall event AND seven bump
//    events each -- the pack grinding the barrier and each other at once,
//    which is the case the perf risk was flagged on. Held for 8 seconds.
// ---------------------------------------------------------------------------
for (const rm of [false, true]) {
  vfx.reduceMotion = rm
  let peakLive = 0, peakPend = 0, peakKinds: Record<number, number> = {}
  const FRAMES = 480
  for (let f = 0; f < FRAMES; f++) {
    for (let i = 0; i < 8; i++) {
      const r = st.racers[i]
      r.pos.y = 4 + i * 0.01
      r.grounded = true
      r.altitude = 0.55
      r.events.length = 0
      r.events.push({ t: 'wall', force: 22, px: r.pos.x, py: r.pos.y, pz: r.pos.z, nx: 1, ny: 0, nz: 0 } as RacerEvent)
      for (let j = 0; j < 7; j++) {
        r.events.push({ t: 'bump', force: 12, px: r.pos.x, py: r.pos.y, pz: r.pos.z, nx: 0, ny: 0, nz: 1 } as RacerEvent)
      }
    }
    st.frame++
    vfx.update(1 / 60, st, cam, 0)
    const l = live(vfx.time)
    if (l.live + l.pending > peakLive + peakPend) { peakLive = l.live; peakPend = l.pending; peakKinds = l.kinds }
  }
  console.log(
    `worst case (8 cars x 8 contact events/frame, ${(FRAMES / 60).toFixed(0)}s, rm=${rm}): ` +
    `peak ${peakLive} live + ${peakPend} pending = ${peakLive + peakPend} of ${vfx.pool} slots ` +
    `(${(((peakLive + peakPend) / vfx.pool) * 100).toFixed(0)}%)  kinds ${JSON.stringify(peakKinds)}`,
  )
}
console.log(
  `budget: bucket ${Math.round(vfx.pool * TUNING.sparks.bucketFrac)} slots, ` +
  `refill ${Math.round(vfx.pool * TUNING.sparks.refillFrac)}/s, pool ${vfx.pool} @ ${tier}`,
)

// ---------------------------------------------------------------------------
// 3. WHAT THE VFX GROUP COSTS THE FRAME, counted the way tools/probe-envcost.ts
//    counts the environment.
//
//    The answer for the impact sparks is ZERO DELTA, and it is structural
//    rather than lucky: the pool is a fixed set of instanced quads sized in the
//    constructor, `instanceCount` is the pool and never moves, and a dead or
//    unborn particle is a vertex shader early-out, not a skipped draw. So the
//    numbers below are identical with the sparks firing and with them switched
//    off, and this change adds no mesh, no geometry and no material.
// ---------------------------------------------------------------------------
{
  const g = (vfx as unknown as { group: THREE.Group }).group
  let calls = 0, tris = 0
  const rows: string[] = []
  g.traverse((o) => {
    const mesh = o as THREE.Mesh
    const isLine = (o as unknown as THREE.LineSegments).isLineSegments
    if (!mesh.isMesh && !isLine) return
    const geo = mesh.geometry as THREE.BufferGeometry
    const idx = geo.getIndex()
    const pos = geo.getAttribute('position')
    const ig = geo as THREE.InstancedBufferGeometry
    const inst = ig.isInstancedBufferGeometry
      ? (ig.instanceCount === Infinity ? 1 : ig.instanceCount)
      : 1
    const t = isLine ? 0 : Math.round(((idx ? idx.count : pos.count) / 3) * inst)
    calls++; tris += t
    rows.push(`  ${String(t).padStart(7)}  x${String(inst).padStart(5)}  ${mesh.name || o.type}`)
  })
  console.log(`vfx group @ ${tier}: ${calls} draw calls, ${tris.toLocaleString()} triangles (invariant)`)
  console.log(rows.sort((a, b) => Number(b.trim().split(/\s+/)[0]) - Number(a.trim().split(/\s+/)[0])).slice(0, 4).join('\n'))
}
vfx.dispose()
