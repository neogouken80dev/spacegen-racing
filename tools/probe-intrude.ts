/**
 * WHAT IS STANDING IN THE ROAD?
 *
 * Reported from play on The Hollow Choir: "there is what seems to be a lampost
 * object that is on the left side of the track, near the end of the track. It
 * is out of place and seems placed in the middle of the track."
 *
 * tests/track.test.ts already asserts that no prop reaches into the road, and
 * it passes -- because it samples VERTICES. A lamp mast is a tall thin box:
 * its only vertices are at the two ends, one on the ground well below the deck
 * and one in the air well above it, so a mast whose MIDDLE passes through the
 * road has no vertex anywhere near the band and clears the fixture by
 * construction. The theme's own placement test knew about this failure mode
 * and sampled six points up the shaft -- but at FRACTIONS of the height, so on
 * a 20 m mast the gaps are 8 m and the airspace band is only 7.5 m tall.
 *
 * This samples along every EDGE instead, which is what actually finds it.
 *
 *   npx tsx tools/probe-intrude.ts --track=hollowchoir
 *   npx tsx tools/probe-intrude.ts --all
 *   npx tsx tools/probe-intrude.ts --selftest
 *
 * THREE THINGS IT USED TO GET WRONG, all of which it reported as Ashkar.
 *
 * 1. IT COULD NOT TELL PAINT FROM AN OBSTACLE, and it was never going to,
 *    because it only looked at where the triangles are. Ashkar paints magma
 *    veins across the full driveable width a few centimetres off the deck, and
 *    hangs a shade patch under its flyover on the deck below; both are ON the
 *    road by design and both were reported. The old file's answer was a list of
 *    five mesh names to skip -- a list that has to be extended by hand every
 *    time a theme paints something, and which had not been, so Ashkar's two
 *    decals were live findings while Rustfall's and Cryostatic's were not.
 *
 *    A decal is not identified by its name. It is identified by the fact that
 *    IT DOES NOT WRITE DEPTH: it cannot occlude anything, it has no inside, and
 *    the renderer draws it as an overlay on whatever is behind it. Every mesh
 *    on the old skip list turns out to be depthWrite:false, and so are the two
 *    Ashkar decals and Namaresh's light-bridge and glyph-script, which were
 *    never on it. Every actual prop, landmark and structure in all eight themes
 *    is depthWrite:true. So the name list is gone and the material answers.
 *
 * 2. IT MEASURED AGAINST THE CAR'S ENVELOPE, NOT THE ROAD. `width *
 *    offTrack.edgeTolerance + collision.racerRadius` is the right question for
 *    "how far off the centreline can a chassis get" and the wrong one for "is
 *    this in the road": on Ashkar's 30 m half-width it reaches 4.9 m PAST the
 *    road edge, and there is a three-metre barrier standing at that edge. It
 *    reported Ashkar's shield volcano at 4.45 m "inside the edge" when the
 *    cone's foot is 0.45 m OUTSIDE it -- buried in the wall, invisible from the
 *    road and unreachable by anything.
 *
 *    A walled sample's road ends where the wall starts. An `open` sample has no
 *    wall, so out there the envelope IS the right measure and it still applies.
 *
 * 3. IT ASSUMED THE ROAD'S UP WAS WORLD +Y. `reach` took the lateral offset in
 *    plan and the height as a plain Y difference, which is exact on Rustfall
 *    and meaningless on a loop: over Ashkar's 60 m-wide inversion at s=2750-3080
 *    the road's normal points at the ground, and a prop standing in the middle
 *    of it scored a lateral of almost nothing and a height of tens of metres.
 *    Three of the eight circuits have gravity sections and this could not see
 *    into any of them. It now works in the sample's own banked frame, which is
 *    the frame `Track.surfacePoint` and `trackMesh.ts` both use.
 *
 * SISTER GATE. This one is about what the THEMES put near the road.
 * `tools/probe-solidclear.ts` asks the same question of the road itself -- does
 * one part of the lap's deck-and-barrier stand in another part's airspace --
 * and neither can see what the other sees.
 */
import * as THREE from 'three'
import { Track, type TrackSample } from '../src/sim/track'
import { TRACKS_BY_ID, TRACKS } from '../src/content/tracks'
import { buildEnvironment } from '../src/render/environment'
import { QUALITY_PRESETS } from '../src/render/api'
import { TUNING as T } from '../src/content/tuning'

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]
const flag = (k: string) => process.argv.includes(`--${k}`)

const EDGE = T.offTrack.edgeTolerance, RACER = T.collision.racerRadius
/**
 * The road's airspace, metres above the deck.
 *
 * The floor is ZERO, not a small negative. The deck is opaque and single sided
 * facing up: anything strictly under it cannot be seen from the road and cannot
 * be touched by a car riding on it, and an object that really does pass THROUGH
 * the deck has geometry on both sides, so it is still caught from above. A
 * negative floor buys nothing and costs a finding -- at -0.15 it reported
 * Centurion Prime's drum hull, which is the bore the road runs through, sitting
 * 0.14 m UNDER its own deck exactly as intended.
 *
 * The ceiling is above the 3 m barrier because a flight chassis rides to 6.5 m.
 */
const LO = 0, HI = 5.0

type Frame = {
  px: number; py: number; pz: number
  rx: number; ry: number; rz: number
  nx: number; ny: number; nz: number
  tx: number; ty: number; tz: number
  w: number; limit: number; s: number
}

type Reach = { pen: number; up: number; lat: number; limit: number; s: number }

/**
 * Where a world point sits relative to the road: how far inside the road's own
 * boundary, and how far above the deck, both in the sample's banked frame.
 *
 * The boundary is the BARRIER on a walled sample and the car's envelope on an
 * `open` one -- see note 2 in the header. The along-lap extent is bounded by
 * the two neighbouring cross-section planes rather than by a fixed distance
 * along the tangent, so the bands tile the lap exactly at any width and radius.
 */
class Road {
  private readonly f: Frame[] = []
  private readonly cells = new Map<string, number[]>()
  private static readonly CELL = 24

  constructor(track: Track) {
    const S = track.samples, m = S.length
    for (let i = 0; i < m; i++) {
      const s = S[i]
      this.f.push({
        px: s.pos.x, py: s.pos.y, pz: s.pos.z,
        rx: s.right.x, ry: s.right.y, rz: s.right.z,
        nx: s.normal.x, ny: s.normal.y, nz: s.normal.z,
        tx: s.tangent.x, ty: s.tangent.y, tz: s.tangent.z,
        w: s.width,
        limit: s.open ? s.width * EDGE + RACER : s.width,
        s: (i / m) * track.length,
      })
    }
    // XZ buckets covering each band's full lateral reach, so a point 30 m off
    // the centreline of a 60 m-wide road still finds its own sample.
    const C = Road.CELL
    for (let i = 0; i < m; i++) {
      const a = this.f[i], b = this.f[(i + 1) % m]
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
      for (const g of [a, b]) {
        for (const lat of [-g.limit, g.limit]) {
          const x = g.px + g.rx * lat, z = g.pz + g.rz * lat
          if (x < x0) x0 = x; if (x > x1) x1 = x
          if (z < z0) z0 = z; if (z > z1) z1 = z
        }
      }
      for (let cx = Math.floor((x0 - 2) / C); cx <= Math.floor((x1 + 2) / C); cx++) {
        for (let cz = Math.floor((z0 - 2) / C); cz <= Math.floor((z1 + 2) / C); cz++) {
          const k = `${cx},${cz}`
          const arr = this.cells.get(k)
          if (arr) arr.push(i); else this.cells.set(k, [i])
        }
      }
    }
  }

  reach(x: number, y: number, z: number): Reach | null {
    const C = Road.CELL
    const cands = this.cells.get(`${Math.floor(x / C)},${Math.floor(z / C)}`)
    if (!cands) return null
    const m = this.f.length
    let out: Reach | null = null
    for (const i of cands) {
      const a = this.f[i], b = this.f[(i + 1) % m]
      const dx = x - a.px, dy = y - a.py, dz = z - a.pz
      if (dx * a.tx + dy * a.ty + dz * a.tz < 0) continue
      if ((x - b.px) * b.tx + (y - b.py) * b.ty + (z - b.pz) * b.tz >= 0) continue
      const lat = dx * a.rx + dy * a.ry + dz * a.rz
      const pen = a.limit - Math.abs(lat)
      if (pen <= 0) continue
      const up = dx * a.nx + dy * a.ny + dz * a.nz
      if (!out || pen > out.pen) out = { pen, up, lat, limit: a.limit, s: a.s }
    }
    return out
  }
}

/** True where a mesh is paint rather than an obstacle. See note 1. */
function isDecal(mesh: THREE.Mesh): boolean {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  return mats.every((m) => m && (m as THREE.Material).depthWrite === false)
}

type Found = { pen: number; text: string }

function scan(track: Track, group: THREE.Object3D): string[] {
  const road = new Road(track)
  const found: Found[] = []
  let ci = -1
  for (const obj of group.children) {
    ci++
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh) continue
    // The ground the road sits on meets the deck everywhere by construction;
    // it is the one opaque thing that is allowed to.
    if (mesh.name === 'terrain') continue
    if (isDecal(mesh)) continue
    const pos = mesh.geometry.getAttribute('position')
    const idx = mesh.geometry.getIndex()
    const instm = mesh as unknown as THREE.InstancedMesh
    const count = instm.isInstancedMesh ? instm.count : 1
    const mat = new THREE.Matrix4(), a = new THREE.Vector3(), b = new THREE.Vector3(), p = new THREE.Vector3()
    mesh.updateMatrix()
    const tri = idx ? idx.count / 3 : pos.count / 3
    // A theme that did not name its mesh still has to be findable, so fall back
    // to what the scene graph knows: which child it is and what it is made of.
    // Three of the eight themes leave a solid mesh unnamed and "(unnamed)" is
    // not something anyone can go and look at.
    const label = mesh.name || `child#${ci} ${(Array.isArray(mesh.material)
      ? mesh.material[0] : mesh.material).type}`
    for (let n = 0; n < count; n++) {
      if (instm.isInstancedMesh) instm.getMatrixAt(n, mat); else mat.copy(mesh.matrix)
      let worst: { pen: number; up: number; s: number; x: number; y: number; z: number } | null = null
      for (let t = 0; t < tri; t++) {
        for (let e = 0; e < 3; e++) {
          const i0 = idx ? idx.getX(t * 3 + e) : t * 3 + e
          const i1 = idx ? idx.getX(t * 3 + ((e + 1) % 3)) : t * 3 + ((e + 1) % 3)
          a.set(pos.getX(i0), pos.getY(i0), pos.getZ(i0)).applyMatrix4(mat)
          b.set(pos.getX(i1), pos.getY(i1), pos.getZ(i1)).applyMatrix4(mat)
          // SAMPLE ALONG THE EDGE, every ~0.6m. This is the whole difference.
          const len = a.distanceTo(b)
          const steps = Math.min(64, Math.max(1, Math.ceil(len / 0.6)))
          for (let k = 0; k <= steps; k++) {
            p.lerpVectors(a, b, k / steps)
            const r = road.reach(p.x, p.y, p.z)
            if (!r || r.up < LO || r.up > HI) continue
            // Keep the DEEPEST point of this instance, not the first one found.
            // The first is wherever the triangle walk happens to start, which
            // on a mountainside crossing a road is its outermost graze; the
            // deepest is the number that says how bad it is.
            if (!worst || r.pen > worst.pen) worst = { pen: r.pen, up: r.up, s: r.s, x: p.x, y: p.y, z: p.z }
          }
        }
      }
      if (worst) {
        found.push({
          pen: worst.pen,
          text: `${label.padEnd(30)} inst ${String(n).padStart(3)}  ` +
            `${worst.pen.toFixed(2)}m inside the edge at s=${worst.s.toFixed(0)}m, ` +
            `${worst.up.toFixed(2)}m above the road  ` +
            `world (${worst.x.toFixed(1)}, ${worst.y.toFixed(1)}, ${worst.z.toFixed(1)})`,
        })
      }
    }
  }
  return found.sort((a, b) => b.pen - a.pen).map((f) => f.text)
}

function run(id: string): number {
  const def = TRACKS_BY_ID[id]
  if (!def) { console.log(`no track ${id}`); return 1 }
  const track = new Track(def)
  const scene = new THREE.Scene()
  const env = buildEnvironment(track, scene, QUALITY_PRESETS.high)
  const hits = scan(track, env.group)
  console.log(`${def.name} (${id}): ${hits.length} intruding piece(s)`)
  for (const h of hits.slice(0, 25)) console.log('  ' + h)
  if (hits.length > 25) console.log(`  ... and ${hits.length - 25} more`)
  return hits.length ? 1 : 0
}

/* -------------------------------------------------------------- SABOTAGE */

/**
 * THE GATE HAS TO BE SHOWN FAILING SOMETHING.
 *
 * Four probes are dropped onto a real circuit at known offsets from a known
 * sample, and each one asserts a different edge of the test:
 *
 *   mast-in-road      a 20 m box through the middle of the deck   -> must FAIL
 *   mast-mid-only     the same, with its ENDS clear of the band   -> must FAIL
 *                     (this is the original lamp post: no vertex is near the
 *                      road, so a vertex-sampling test cannot see it)
 *   prop-behind-wall  a block 1.2 m OUTSIDE the road edge         -> must pass
 *                     (the old envelope reported Ashkar's volcano here)
 *   decal-on-road     the same box as mast-in-road, depthWrite:false -> pass
 *
 * It runs on the MOST INVERTED sample on the roster, found by searching rather
 * than written down, so a pass also proves the banked-frame fix and content
 * edits cannot quietly move the test onto level road. In the old world-up frame
 * `dy` for a point 2 m off an inverted deck is 2 m BELOW the centreline's world
 * Y, which is under the band's old -0.15 m floor: the old probe skipped every
 * one of these four, correct and incorrect alike.
 */
function selftest(): number {
  let track = new Track(TRACKS[0])
  let smp: TrackSample = track.samples[0]
  let arc = 0
  for (const def of TRACKS) {
    const t = new Track(def)
    for (let i = 0; i < t.samples.length; i++) {
      if (t.samples[i].normal.y < smp.normal.y) {
        track = t; smp = t.samples[i]; arc = (i / t.samples.length) * t.length
      }
    }
  }
  const at = (lat: number, up: number) => new THREE.Vector3(
    smp.pos.x + smp.right.x * lat + smp.normal.x * up,
    smp.pos.y + smp.right.y * lat + smp.normal.y * up,
    smp.pos.z + smp.right.z * lat + smp.normal.z * up,
  )
  const group = new THREE.Group()
  const solid = () => new THREE.MeshStandardMaterial()
  const paint = () => new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })

  const box = (name: string, g: THREE.BufferGeometry, p: THREE.Vector3, matr: THREE.Material) => {
    const mesh = new THREE.Mesh(g, matr)
    mesh.name = name
    mesh.position.copy(p)
    // Stand it along the sample's own normal, so "20 m tall" means 20 m off the
    // deck even where the deck is upside down.
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(smp.normal.x, smp.normal.y, smp.normal.z),
    )
    group.add(mesh)
  }
  box('mast-in-road', new THREE.BoxGeometry(0.6, 20, 0.6), at(4, 2), solid())
  box('mast-mid-only', new THREE.BoxGeometry(0.6, 40, 0.6), at(-6, 0), solid())
  box('prop-behind-wall', new THREE.BoxGeometry(1.5, 2, 1.5), at(smp.width + 1.2, 1), solid())
  box('decal-on-road', new THREE.BoxGeometry(0.6, 20, 0.6), at(10, 2), paint())

  const hits = scan(track, group)
  const named = new Set(hits.map((h) => h.split(/\s+/)[0]))
  const expect: [string, boolean][] = [
    ['mast-in-road', true], ['mast-mid-only', true],
    ['prop-behind-wall', false], ['decal-on-road', false],
  ]
  console.log(`SABOTAGE on the most inverted deck on the roster: ${track.def.name} ` +
    `at s=${arc.toFixed(0)}m (half-width ${smp.width}m, deck normal.y=${smp.normal.y.toFixed(2)})\n`)
  let bad = 0
  for (const [name, want] of expect) {
    const got = named.has(name)
    if (got !== want) bad++
    console.log(`  ${name.padEnd(18)} ${got ? 'REPORTED' : 'not reported'}` +
      `   expected ${want ? 'REPORTED' : 'not reported'}   ${got === want ? 'ok' : '<-- WRONG'}`)
  }
  for (const h of hits) console.log('    ' + h)
  console.log(bad ? `\n${bad} of ${expect.length} wrong` : '\nall four as expected')
  return bad ? 1 : 0
}

if (flag('selftest')) process.exit(selftest())
const id = arg('track')
if (flag('all') || !id) {
  let bad = 0
  for (const def of TRACKS) bad += run(def.id)
  process.exit(bad ? 1 : 0)
}
process.exit(run(id))
