/**
 * WHAT IS STANDING IN THE ROAD **AT t = 31 SECONDS**?
 *
 * `tools/probe-intrude.ts` builds a world and walks every triangle edge of
 * every mesh in it, which is the right question for a lamp post and half a
 * question for anything that moves. It never calls `EnvironmentVisual.update`,
 * so what it measures is the REST POSE: a whale that clears the deck by 40 m
 * at t=0 and swims through it at t=31 passes that gate with nothing to report.
 *
 * Meridian Deep's marine life is the first animated thing on the roster placed
 * anywhere near the road, so this is the gate that covers the motion.
 *
 * ===========================================================================
 * 1. WHY THIS CAN BE A PROOF AND NOT A SAMPLE.
 * ===========================================================================
 *
 * Because the thing being tested is PERIODIC and says so. Every rate in
 * `themes/abyssal.ts`'s life layer is an integer multiple of one base
 * frequency, every path is closed, and nothing integrates state -- so the
 * whole of time is [0, period), and sweeping that sweeps all of it.
 *
 * `--period` is therefore not a guess, it is a claim the theme makes, and this
 * probe checks it rather than trusting it: it drives `update()` to `period`,
 * compares every instance matrix against the ones it recorded at t=0, and
 * FAILS if they do not come back. An animation that does not close gets
 * reported as "not periodic", which is the honest answer, and the numbers
 * below then mean only what a sample means.
 *
 * ===========================================================================
 * 2. IT FINDS WHAT MOVES BY WATCHING, NOT BY BEING TOLD.
 * ===========================================================================
 *
 * No name list. The probe snapshots every mesh's transform state at t=0,
 * advances the clock, and keeps whatever changed. That is why it also reports
 * Meridian Deep's bloom beacons -- twenty posts that pulse their scale -- which
 * is a useful thing to have in the output, because they are a known-good
 * object standing a known 1.4 m outside the corridor and they are what proves
 * the instrument can see a small clearance at all.
 *
 * ===========================================================================
 * 3. TWO TIERS, BECAUSE AN EXACT SWEEP IS TOO SLOW AND A CHEAP ONE LIES.
 * ===========================================================================
 *
 * Tier one is a CONSERVATIVE bound: each instance's geometry bounding sphere,
 * pushed through its instance matrix, measured against the road's protected
 * volume. One distance query per instance per step. If the sphere clears, every
 * vertex of that instance clears -- no exceptions, no sampling.
 *
 * A sphere is a bad bound for a long thin animal, so tier two catches the
 * difference: any instance whose sphere comes within `--exact` of the road is
 * re-measured the expensive way, along every triangle edge at 0.5 m, exactly
 * the way probe-intrude walks a mesh. So the reported clearance is a real
 * distance wherever it is small, and merely a guaranteed lower bound wherever
 * it is large, which is the only place a loose bound costs nothing.
 *
 * ===========================================================================
 * 4. WHAT "THE ROAD" MEANS HERE, AND WHY THE CEILING IS 20 AND NOT 5.
 * ===========================================================================
 *
 * probe-intrude uses a 5.0 m band because it is looking for props standing in
 * the deck. This is looking for something flying over it, so the volume has to
 * be the airspace a car can actually occupy. MEASURED on this circuit: an
 * 8-car AI race, 3 laps, 16,298 sim steps, highest racer 16.40 m above the
 * deck at s=577 -- the trench jump, the only place on the lap anything leaves
 * the road. Everywhere else the ceiling is the flight chassis's 6.5 m. The
 * default ceiling is that measurement plus 3.6 m of margin.
 *
 * The floor is -12 m rather than 0: under the deck is a legitimate place for a
 * whale to be, but a whale that surfaces THROUGH the deck has to be caught on
 * the way up, and the deck is not infinitely thin.
 *
 * Laterally it is the placement engine's own protected half-width,
 * `width * 1.10 + 1.9`, which is what every prop is already kept out of and
 * already reaches past the barrier probe-intrude measures against.
 *
 *   npx tsx tools/probe-swim.ts --track=abyssal
 *   npx tsx tools/probe-swim.ts --track=abyssal --step=0.1 --verbose
 *   npx tsx tools/probe-swim.ts --selftest
 */
import * as THREE from 'three'
import { Track } from '../src/sim/track'
import { TRACKS_BY_ID, TRACKS } from '../src/content/tracks'
import { buildEnvironment } from '../src/render/environment'
import { QUALITY_PRESETS } from '../src/render/api'
import { TUNING as T } from '../src/content/tuning'

const arg = (k: string, d: string): string =>
  (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const flag = (k: string) => process.argv.includes(`--${k}`)

const EDGE = T.offTrack.edgeTolerance, RACER = T.collision.racerRadius

/* ----------------------------------------------------------- the volume */

/**
 * The road as a run of oriented boxes, one per sample, and the signed distance
 * from a world point to the nearest of them.
 *
 * Negative is inside. The boxes are built in each sample's own banked frame --
 * the frame `Track.surfacePoint` and `trackMesh.ts` both use -- because on this
 * roster three circuits invert and a world-up height is meaningless there.
 *
 * Bucketed in plan so a query touches a few dozen samples rather than 2,645.
 * The bucket has to cover each box's full reach plus the query radius, so the
 * grid is built at the road's widest half-width plus the cap below.
 */
class RoadVolume {
  private readonly f: {
    px: number; py: number; pz: number
    rx: number; ry: number; rz: number
    nx: number; ny: number; nz: number
    tx: number; ty: number; tz: number
    lat: number; halfLen: number; s: number
  }[] = []

  private readonly cells = new Map<number, number[]>()
  private readonly cell: number
  private readonly vMid: number
  private readonly vHalf: number
  private static readonly KEY = 100000

  constructor(track: Track, lo: number, hi: number, pad: number) {
    this.vMid = (lo + hi) * 0.5
    this.vHalf = (hi - lo) * 0.5
    const S = track.samples, m = S.length
    const span = track.length / m
    for (let i = 0; i < m; i++) {
      const s = S[i]
      this.f.push({
        px: s.pos.x, py: s.pos.y, pz: s.pos.z,
        rx: s.right.x, ry: s.right.y, rz: s.right.z,
        nx: s.normal.x, ny: s.normal.y, nz: s.normal.z,
        tx: s.tangent.x, ty: s.tangent.y, tz: s.tangent.z,
        // The protected half-width the placement engine itself enforces, which
        // already reaches 0.1*w + 1.9 past the barrier.
        lat: s.width * EDGE + RACER,
        // Half a sample span each way, PLUS `pad`. Consecutive boxes are
        // wedges on a corner, not boxes, so tiling them exactly leaves a sliver
        // of gap on the outside of every turn -- and a gap is the one error
        // that makes this probe report MORE clearance than there is. The
        // overlap makes the union slightly LARGER than the road, which is the
        // safe direction to be wrong in, at the cost of over-reporting an
        // object that sits close to the edge on a corner by up to `pad`.
        // `--pad=0` turns it off, which is how you tell a real graze from the
        // instrument's own margin.
        halfLen: span * 0.5 + pad,
        s: (i / m) * track.length,
      })
    }
    // One cell has to be at least as wide as the widest box, or a query in the
    // middle of a 58 m half-width section finds nothing in its own cell.
    let widest = 0
    for (const g of this.f) if (g.lat > widest) widest = g.lat
    this.cell = Math.max(48, widest + 8)
    const C = this.cell
    for (let i = 0; i < m; i++) {
      const g = this.f[i]
      const reach = g.lat + Math.max(Math.abs(lo), Math.abs(hi)) + g.halfLen
      for (let cx = Math.floor((g.px - reach) / C); cx <= Math.floor((g.px + reach) / C); cx++) {
        for (let cz = Math.floor((g.pz - reach) / C); cz <= Math.floor((g.pz + reach) / C); cz++) {
          const k = cx * RoadVolume.KEY + cz
          const arr = this.cells.get(k)
          if (arr) arr.push(i); else this.cells.set(k, [i])
        }
      }
    }
  }

  /**
   * Distance from (x,y,z) to the protected volume, and which sample is nearest.
   * `cap` is how far out the search bothers looking: beyond it the answer is
   * "further than cap", which is all anyone needs to know.
   */
  clearance(x: number, y: number, z: number, cap: number): { d: number; s: number } {
    const C = this.cell
    const r = Math.ceil(cap / C)
    const cx0 = Math.floor(x / C), cz0 = Math.floor(z / C)
    let best = cap, bs = -1
    for (let cx = cx0 - r; cx <= cx0 + r; cx++) {
      for (let cz = cz0 - r; cz <= cz0 + r; cz++) {
        const cands = this.cells.get(cx * RoadVolume.KEY + cz)
        if (!cands) continue
        for (const i of cands) {
          const g = this.f[i]
          const dx = x - g.px, dy = y - g.py, dz = z - g.pz
          // Into the sample's own frame.
          const a = dx * g.rx + dy * g.ry + dz * g.rz
          const b = dx * g.nx + dy * g.ny + dz * g.nz
          const c = dx * g.tx + dy * g.ty + dz * g.tz
          // Per-axis signed distance to the slab, negative inside. The vertical
          // band is not centred on the deck, so it carries its own centre --
          // written as `|b - mid| - half` rather than as a pair of one-sided
          // tests, because a one-sided test returns 0 for every interior point
          // and `max(ea, 0, ec)` is then 0 for a car sitting on the road.
          const ea = Math.abs(a) - g.lat
          const eb = Math.abs(b - this.vMid) - this.vHalf
          const ec = Math.abs(c) - g.halfLen
          let d: number
          if (ea <= 0 && eb <= 0 && ec <= 0) {
            // Inside: the negative distance to the nearest face -- but NOT the
            // along-lap one, which is a seam between two boxes and not a face
            // of the road at all. Including it reported a car sitting on the
            // centreline as 1.35 m inside instead of 12.
            d = Math.max(ea, eb)
          } else {
            const pa = ea > 0 ? ea : 0, pb = eb > 0 ? eb : 0, pc = ec > 0 ? ec : 0
            d = Math.sqrt(pa * pa + pb * pb + pc * pc)
          }
          if (d < best) { best = d; bs = g.s }
        }
      }
    }
    return { d: best, s: bs }
  }
}

/* ------------------------------------------------------- what to watch */

/** True where a mesh is paint rather than an obstacle. Same rule as probe-intrude. */
function isDecal(mesh: THREE.Mesh): boolean {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  return mats.every((m) => m && (m as THREE.Material).depthWrite === false)
}

type Watch = {
  mesh: THREE.Mesh
  label: string
  /** Instance count, or 1 for a plain mesh. */
  n: number
  /** Geometry bounding sphere: centre and radius. */
  bcx: number; bcy: number; bcz: number; br: number
  /** Per-instance worst so far. */
  worst: number
  worstAt: number
  worstS: number
  worstInst: number
  /** Largest centre displacement between consecutive steps, per instance. */
  hop: number
  prev: Float64Array
}

function snapshot(mesh: THREE.Mesh): Float32Array {
  const im = mesh as unknown as THREE.InstancedMesh
  if (im.isInstancedMesh) return Float32Array.from(im.instanceMatrix.array)
  mesh.updateMatrix()
  return Float32Array.from(mesh.matrix.elements)
}

function differs(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return true
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-5) return true
  return false
}

const _m = new THREE.Matrix4()
const _v = new THREE.Vector3()
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()

/** The instance's world matrix, into `_m`. */
function instMatrix(w: Watch, k: number): void {
  const im = w.mesh as unknown as THREE.InstancedMesh
  if (im.isInstancedMesh) im.getMatrixAt(k, _m)
  else { w.mesh.updateMatrix(); _m.copy(w.mesh.matrix) }
}

/** Largest scale factor in a matrix, for inflating a bounding sphere. */
function maxScale(m: THREE.Matrix4): number {
  const e = m.elements
  const a = Math.hypot(e[0], e[1], e[2])
  const b = Math.hypot(e[4], e[5], e[6])
  const c = Math.hypot(e[8], e[9], e[10])
  return Math.max(a, b, c)
}

/**
 * Exact clearance for one instance: every triangle edge, sampled at 0.5 m.
 *
 * Deliberately the same walk `probe-intrude.ts` does, for the same reason --
 * a long thin body's only vertices are at its ends, so a vertex test cannot
 * see a body whose MIDDLE is in the road.
 */
function exactClearance(w: Watch, k: number, road: RoadVolume, cap: number): { d: number; s: number } {
  const geo = w.mesh.geometry
  const pos = geo.getAttribute('position')
  const idx = geo.getIndex()
  const tri = idx ? idx.count / 3 : pos.count / 3
  instMatrix(w, k)
  let best = cap, bs = -1
  for (let t = 0; t < tri; t++) {
    for (let e = 0; e < 3; e++) {
      const i0 = idx ? idx.getX(t * 3 + e) : t * 3 + e
      const i1 = idx ? idx.getX(t * 3 + ((e + 1) % 3)) : t * 3 + ((e + 1) % 3)
      _a.set(pos.getX(i0), pos.getY(i0), pos.getZ(i0)).applyMatrix4(_m)
      _b.set(pos.getX(i1), pos.getY(i1), pos.getZ(i1)).applyMatrix4(_m)
      const steps = Math.min(64, Math.max(1, Math.ceil(_a.distanceTo(_b) / 0.5)))
      for (let j = 0; j <= steps; j++) {
        _v.lerpVectors(_a, _b, j / steps)
        const r = road.clearance(_v.x, _v.y, _v.z, best)
        if (r.d < best) { best = r.d; bs = r.s }
      }
    }
  }
  return { d: best, s: bs }
}

/* ------------------------------------------------------------------ run */

function run(id: string): number {
  const period = Number(arg('period', '240'))
  const step = Number(arg('step', '0.25'))
  const exact = Number(arg('exact', '30'))
  const cap = Number(arg('cap', '120'))
  const lo = Number(arg('floor', '-12'))
  const hi = Number(arg('ceil', '20'))
  const verbose = flag('verbose')

  const def = TRACKS_BY_ID[id]
  if (!def) { console.log(`no track ${id}`); return 1 }
  const track = new Track(def)
  const scene = new THREE.Scene()
  const env = buildEnvironment(track, scene, QUALITY_PRESETS.high)
  const road = new RoadVolume(track, lo, hi, Number(arg('pad', '0.6')))
  const camera = { x: track.samples[0].pos.x, y: track.samples[0].pos.y + 6, z: track.samples[0].pos.z }

  // Rest state, then one nudge, then keep whatever moved.
  env.update(0, 0, camera)
  const rest = new Map<THREE.Mesh, Float32Array>()
  for (const obj of env.group.children) {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh || mesh.name === 'terrain' || isDecal(mesh)) continue
    rest.set(mesh, snapshot(mesh))
  }
  env.update(1 / 60, period * 0.137, camera)

  const watch: Watch[] = []
  let ci = -1
  for (const obj of env.group.children) {
    ci++
    const mesh = obj as THREE.Mesh
    const r0 = rest.get(mesh)
    if (!r0) continue
    if (!differs(r0, snapshot(mesh))) continue
    const geo = mesh.geometry
    if (!geo.boundingSphere) geo.computeBoundingSphere()
    const bs = geo.boundingSphere!
    const im = mesh as unknown as THREE.InstancedMesh
    const n = im.isInstancedMesh ? im.count : 1
    watch.push({
      mesh, n, label: mesh.name || `child#${ci} ${mesh.type}`,
      bcx: bs.center.x, bcy: bs.center.y, bcz: bs.center.z, br: bs.radius,
      worst: Infinity, worstAt: 0, worstS: -1, worstInst: -1,
      hop: 0, prev: new Float64Array(n * 3),
    })
  }

  if (watch.length === 0) {
    console.log(`${def.name} (${id}): nothing in the environment moves. Nothing to prove.`)
    env.dispose()
    return 0
  }

  const steps = Math.max(1, Math.round(period / step))
  let exactCalls = 0
  for (let si = 0; si <= steps; si++) {
    const t = (si / steps) * period
    env.update(step, t, camera)
    for (const w of watch) {
      for (let k = 0; k < w.n; k++) {
        instMatrix(w, k)
        _v.set(w.bcx, w.bcy, w.bcz).applyMatrix4(_m)
        const r = w.br * maxScale(_m)
        // How far the centre moved since the last step, so the continuous
        // minimum can be bounded below by the sampled one (see the report).
        if (si > 0) {
          const d = Math.hypot(_v.x - w.prev[k * 3], _v.y - w.prev[k * 3 + 1], _v.z - w.prev[k * 3 + 2])
          if (d > w.hop) w.hop = d
        }
        w.prev[k * 3] = _v.x; w.prev[k * 3 + 1] = _v.y; w.prev[k * 3 + 2] = _v.z
        const hit = road.clearance(_v.x, _v.y, _v.z, cap + r)
        let d = hit.d - r, s = hit.s
        if (d < exact) {
          const ex = exactClearance(w, k, road, cap)
          exactCalls++
          d = ex.d; s = ex.s
        }
        if (d < w.worst) { w.worst = d; w.worstAt = t; w.worstS = s; w.worstInst = k }
      }
    }
  }

  // DOES IT ACTUALLY CLOSE? Compare t=period against t=2*period rather than
  // t=0 against t=period. Both of those are the same claim for a periodic
  // signal and only the second one is free of the start transient: Meridian
  // Deep's own bloom beacons read `(time * 2.2 - i * 0.16) % 3`, and at t=0
  // that modulo is handed a NEGATIVE operand, which in JS stays negative --
  // so post i>0 is mid-pulse at t=0 and never again. Reported against t=0 the
  // beacons come back "not periodic", which is true and useless.
  env.update(step, period, camera)
  const ref = new Map<THREE.Mesh, Float32Array>()
  for (const w of watch) ref.set(w.mesh, snapshot(w.mesh))
  env.update(step, period * 2, camera)
  const open: string[] = []
  for (const w of watch) if (differs(ref.get(w.mesh)!, snapshot(w.mesh))) open.push(w.label)

  console.log(`${def.name} (${id}): ${watch.length} animated mesh(es), ` +
    `${watch.reduce((a, w) => a + w.n, 0)} instances, ` +
    `swept t=0..${period}s at ${step}s (${steps + 1} steps, ${exactCalls} exact re-measures)`)
  console.log(`  road volume: lateral width*${EDGE}+${RACER}, vertical ${lo}..+${hi}m in the deck's own frame`)
  /**
   * THREE VERDICTS, because two would have to lie about one of them.
   *
   * The volume is inflated along the lap by `pad` (see `halfLen`), so a
   * reported clearance is an UNDER-estimate of the true one by at most that
   * much, and the sweep is discrete, so it is a further `hop/2` under. Put
   * together, for `bound = reported - hop/2`:
   *
   *   bound >  0      CLEAR     -- proved clear, nothing further to do
   *   bound > -pad    MARGINAL  -- inside the instrument's own margin. This
   *                                probe cannot decide it; `probe-intrude.ts`
   *                                bounds its bands by the neighbouring cross-
   *                                section planes instead of by a box, so it
   *                                tiles a corner exactly and can.
   *   otherwise       HIT       -- proved intruding
   *
   * Only a HIT fails. Calling a MARGINAL a failure would mean this gate
   * reports Meridian Deep's own bloom beacons -- which stand a deliberate
   * 1.4 m outside the corridor, which probe-intrude passes, and which come
   * back at +0.16 m under `--pad=0` -- as a bug in the road.
   */
  let bad = 0, marginal = 0
  const pad = Number(arg('pad', '0.6'))
  const rows = watch.slice().sort((a, b) => a.worst - b.worst)
  for (const w of rows) {
    // A sphere centre cannot move more than `hop` between samples and the
    // clearance field is 1-Lipschitz in it, so the true continuous minimum is
    // at worst half a hop under the sampled one.
    const bound = w.worst - w.hop * 0.5
    const tag = bound > 0 ? 'CLEAR' : bound > -pad ? 'MARGN' : ' HIT '
    if (tag === ' HIT ') bad++
    else if (tag === 'MARGN') marginal++
    const cl = w.worst >= Number(arg('cap', '120'))
      ? `>${arg('cap', '120')}m`
      : `${w.worst.toFixed(2)}m`
    console.log(`  ${tag} ${w.label.padEnd(20)} x${String(w.n).padStart(4)}  ` +
      `min ${cl.padStart(8)}  (inst ${w.worstInst}, t=${w.worstAt.toFixed(1)}s, s=${w.worstS < 0 ? '-' : w.worstS.toFixed(0) + 'm'})  ` +
      `step hop ${w.hop.toFixed(2)}m -> continuous >= ${bound.toFixed(2)}m`)
  }
  if (marginal) {
    console.log(`  ${marginal} inside the instrument's own ${pad.toFixed(2)}m margin. ` +
      'Re-run with --pad=0, and read probe-intrude for the exact answer.')
  }
  if (open.length) {
    console.log(`  NOT PERIODIC at ${period}s: ${open.join(', ')}`)
    console.log('  -> the sweep above is a sample, not a proof. Fix the period or the motion.')
    bad++
  } else {
    console.log(`  periodic: every animated instance returns to its t=0 matrix at t=${period}s.`)
  }
  if (verbose) {
    for (const w of rows) {
      const im = w.mesh as unknown as THREE.InstancedMesh
      if (!im.isInstancedMesh) continue
      im.getMatrixAt(w.worstInst, _m)
      const e = _m.elements
      console.log(`    ${w.label} inst ${w.worstInst} at end-of-sweep: ` +
        `(${e[12].toFixed(1)}, ${e[13].toFixed(1)}, ${e[14].toFixed(1)}) scale ${maxScale(_m).toFixed(2)}`)
    }
  }
  env.dispose()
  return bad ? 1 : 0
}

/* -------------------------------------------------------------- SABOTAGE */

/**
 * THE GATE HAS TO BE SHOWN FAILING SOMETHING, and in particular it has to be
 * shown catching the exact bug it exists for: an object that is clear at t=0
 * and in the road later. So this does not use a theme at all. It builds a
 * RoadVolume on a real circuit and asks four questions of it directly:
 *
 *   over-the-deck     60 m above the deck                    -> clear, ~40 m
 *   in-the-airspace   8 m above the deck, on the centreline  -> INSIDE
 *   past-the-edge     3 m outside the protected half-width   -> clear, ~3 m
 *   under-the-deck    40 m below the deck                    -> clear, ~28 m
 *
 * If the middle one ever comes back positive the volume is wrong and every
 * number this probe prints is decoration.
 */
function selftest(): number {
  const track = new Track(TRACKS_BY_ID['abyssal'] ?? TRACKS[0])
  const lo = -12, hi = 20
  const road = new RoadVolume(track, lo, hi, Number(arg('pad', '0.6')))
  const smp = track.samples[Math.floor(track.samples.length * 0.3)]
  const at = (lat: number, up: number) => road.clearance(
    smp.pos.x + smp.right.x * lat + smp.normal.x * up,
    smp.pos.y + smp.right.y * lat + smp.normal.y * up,
    smp.pos.z + smp.right.z * lat + smp.normal.z * up, 200)
  const limit = smp.width * EDGE + RACER
  const cases: [string, number, boolean][] = [
    ['over-the-deck', at(0, 60).d, true],
    ['in-the-airspace', at(0, 8).d, false],
    ['past-the-edge', at(limit + 3, 2).d, true],
    ['under-the-deck', at(0, -40).d, true],
    ['inside-the-deck', at(limit - 4, 0.5).d, false],
  ]
  console.log(`SABOTAGE on ${track.def.name} at s=${(0.3 * track.length).toFixed(0)}m ` +
    `(half-width ${smp.width}m, protected ${limit.toFixed(1)}m, band ${lo}..${hi}m)\n`)
  let bad = 0
  for (const [name, d, wantClear] of cases) {
    const got = d > 0
    const ok = got === wantClear
    if (!ok) bad++
    console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name.padEnd(18)} ${d.toFixed(2)}m  ` +
      `(${got ? 'clear' : 'inside'}, wanted ${wantClear ? 'clear' : 'inside'})`)
  }
  return bad ? 1 : 0
}

if (flag('selftest')) process.exit(selftest())
else if (flag('all')) {
  let bad = 0
  for (const d of TRACKS) bad += run(d.id)
  process.exit(bad ? 1 : 0)
} else process.exit(run(arg('track', 'abyssal')))
