/**
 * IS ANY PART OF THE TRACK STANDING IN THE ROAD?
 *
 * Reported from play on Ashkar: "this strange passthrough wall ... do not have
 * any tracks that clip into the track."
 *
 * `probe-selfclear.ts` exists to catch that and cannot, and Elkarim is the
 * proof. It expands each sample across its RIBBON and asks for 2 m of 3-D
 * clearance between the two point sets, and the closest that ever comes on the
 * roster is Elkarim's flyover over its own sweeper, at 3.9 m -- comfortably
 * passing. Measured as the mesh actually builds it, the SAME pair has 3.01 m of
 * headroom over a road with a 3.0 m barrier standing on it, so the bridge's
 * deck plate and the barrier's cap are inside one another by a quarter of a
 * metre. One number, a pass and a failure at the same time. No threshold on
 * ribbon distance can separate those, because the distance is not what is wrong.
 *
 * WHAT IS MISSING FROM A RIBBON. `trackMesh.ts` stands a 3 m barrier at each
 * road edge, leaning 0.42 m inboard, capping 0.55 m outboard, with a skirt that
 * hangs 0.9 m below the edge on a viaduct and up to 6 m on banked ground. The
 * solid at a road edge is therefore about 9 m tall and 1.1 m thick, and two
 * ribbons six metres apart in 3-space can have three metres of one's barrier
 * standing in the middle of the other's road.
 *
 * AND THE ASYMMETRY THAT MAKES IT SUBTLE. A circuit is allowed to run two parts
 * of its lap side by side with a barrier between them; that is an ordinary
 * layout and it ships. `probe-selfclear` records that a flat 4.5 m gate was
 * tried and thrown out for failing exactly that. A distance gate has to choose
 * between passing a neighbour and failing a rail through the road and it cannot
 * have both, because the two are the same distance apart. They differ in
 * DIRECTION, not in distance: one is beside the road, the other is over it.
 *
 * So this gate is directional. It expands each sample into the solid the mesh
 * actually builds -- deck plus barrier, straight out of `trackMesh.wallProfile`
 * -- and asks whether that solid stands inside another part of the lap's
 * DRIVEABLE AIRSPACE: the box over its deck, no wider than the physics edge and
 * no taller than the barrier that bounds it. A neighbour is outside that box at
 * any gap down to 0.67 m, which is the barrier's own outboard reach; a rail over
 * the road is inside it from 4.55 m of vertical separation down. `--selftest`
 * sweeps both and prints where it flips, and both flips are predicted from the
 * constants rather than observed.
 *
 * It also measures the VIADUCT SUBSTRUCTURE -- piers, cross-heads and the
 * soffit -- which `buildViaductPiers` guards with `legsClearOtherTrack` and
 * nothing verified. That found a real one: a pier leg standing 0.54 m proud of
 * its own road on Namaresh.
 *
 *   npx tsx tools/probe-solidclear.ts --track=rustfall
 *   npx tsx tools/probe-solidclear.ts --all
 *   npx tsx tools/probe-solidclear.ts --selftest       (see SABOTAGE below)
 *   npx tsx tools/probe-solidclear.ts --track=rustfall --widen=1.4
 *
 * SISTER GATE. This one is about the road against itself.
 * `tools/probe-intrude.ts` asks what the THEMES have put in the road, and
 * neither can see what the other sees. Ashkar's actual passthrough wall was a
 * theme landmark and only that one found it.
 */
import * as THREE from 'three'
import { Track, type TrackDef, type TrackSample } from '../src/sim/track'
import { TRACKS_BY_ID, TRACKS } from '../src/content/tracks'
import { wallProfile, lipProfile, viaductWeight, buildTrackVisual } from '../src/render/trackMesh'
import { QUALITY_PRESETS } from '../src/render/api'
import { TUNING } from '../src/content/tuning'

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]
const flag = (k: string) => process.argv.includes(`--${k}`)

/* ------------------------------------------------------------------- gates */

/**
 * THE DRIVEABLE AIRSPACE IS BOUNDED BY THE PHYSICS EDGE, NOT BY THE CAR'S
 * ENVELOPE.
 *
 * `probe-intrude.ts` asks a different question -- "can a car hit this prop" --
 * and so it uses `width * offTrack.edgeTolerance + collision.racerRadius`, which
 * on Ashkar's 30 m half-width reaches 4.9 m PAST the road edge. That is right
 * for a lamp post and fatally wrong here: every deck's own barrier stands 0.67 m
 * outboard of its own edge, so an envelope that reaches 4.9 m out would have
 * Elkarim's two parallel sections each claiming the other's barrier and failing.
 *
 * The edge is where the wall is. A deck owns the road; it does not own the
 * ground beside it. Anything at |lateral| > width is, by construction, outside
 * the box the barrier draws -- which is exactly the line Elkarim's layout
 * respects and Ashkar's rail does not.
 */
const AIR_LO = -0.20
/**
 * Ceiling of the airspace: the BARRIER'S OWN HEIGHT, read off the profile
 * rather than written down here, so it tracks `WALL_H` if anyone tunes it.
 *
 * It is the honest line. Below the cap you are inside the box the barrier draws
 * around the road and a driver reads you as part of it; above the cap you are
 * over the wall, i.e. an overpass, which every circuit here has and none of them
 * are wrong for having. Ashkar's own crossover clears at 8.8 m and must keep
 * passing.
 *
 * Widening this to the flight class's ceiling (rideHeight 1.5 + maxLift 5.0 =
 * 6.5 m) was tried: it fails Elkarim's flyover, Ashkar's crossover and
 * Centurion Prime's -- every legitimate overpass on the roster, none of which
 * anyone has complained about -- so it measures "is there a bridge here", not
 * "is there a rail in the road".
 */
const AIR_HI = wallProfile({ right: { y: 0 } } as TrackSample, 0)[2][1]

/** Samples closer than this along the lap are neighbours, not a conflict.
 *  Same value and same reason as `probe-selfclear.ts`. */
const IGNORE_ALONG = 70

/** Spacing of the point set the solid is expanded into, metres. Well under the
 *  ~1.1 m thickness of the thinnest thing being tested (the barrier). */
const STEP = 0.25
/** Deck points are coarser: a deck standing in another deck's airspace overlaps
 *  by metres, never by centimetres. */
const DECK_STEP = 1.5
/** Stations along the lap, metres. Half the 1.5 m sample resolution, so a
 *  barrier crossing another deck cannot slip between two stations. */
const STATION = 0.75

/** How far outside the airspace the report still measures, metres. Only sets
 *  how much margin a PASSING track can report; it does not affect the verdict. */
const REPORT_MARGIN = 8

/**
 * The tallest thing that can be over the road: the flight class at full Lift.
 *
 * This is REPORTED, never gated on. An overpass lower than this is a bridge a
 * Vector-7 can headbutt, which is worth knowing and is a content decision --
 * the deck has to come up, and only the track's node data can do that. Failing
 * a build on it would fail every crossing on the roster.
 */
const FLIGHT_CEIL = TUNING.locomotion.flight.rideHeight + TUNING.locomotion.flight.maxLift

/**
 * How far a pier or soffit may break the deck plane before it counts, metres.
 *
 * The bridge substructure is the OTHER half of what `trackMesh.ts` builds, and
 * until now nothing measured it: `legsClearOtherTrack` slides a bay along its
 * run until both LEGS miss every other part of the ribbon in plan, and nothing
 * checks the cross-head -- which is `width * 1.9` across, so 57 m on Ashkar's
 * 60 m loop -- or the soffit, or the brace.
 *
 * Measured on the shipped roster, the cross-head comes through the deck it
 * carries by 0.04 m (Namaresh), 0.02 m (Meridian Deep) and 0.01 m (Ashkar),
 * always on the low side of a deck that is rolling away underneath it: the
 * head is placed at a flat 1.35 m below the CENTRELINE while the deck's own
 * surface drops `right.y * lat` across it, which is the same mistake the note
 * in `buildViaductPiers` records the LEGS making before they were given a
 * per-leg `headY`. A centimetre of steel in the road plane is a z-fight, not a
 * kerb, and nothing there is reachable; 0.25 m is where it becomes a thing a
 * car would hit. Rustfall's soffit is 2.98 m up in the sweeper's road and is
 * nowhere near this line.
 */
const PIER_GRAZE = 0.25

/* ------------------------------------------------------------------ frames */

type Frame = {
  px: number; py: number; pz: number
  rx: number; ry: number; rz: number
  nx: number; ny: number; nz: number
  tx: number; ty: number; tz: number
  w: number; s: number; open: boolean; via: number
}

function frameOf(s: TrackSample, via: number, arc: number, w: number): Frame {
  return {
    px: s.pos.x, py: s.pos.y, pz: s.pos.z,
    rx: s.right.x, ry: s.right.y, rz: s.right.z,
    nx: s.normal.x, ny: s.normal.y, nz: s.normal.z,
    tx: s.tangent.x, ty: s.tangent.y, tz: s.tangent.z,
    w, s: arc, open: s.open, via,
  }
}

/** A station between two samples. Position, basis and width are lerped exactly
 *  the way the mesh sweeps its quads between the same pair. */
function lerpFrame(a: Frame, b: Frame, f: number, arc: number): Frame {
  const L = (u: number, v: number) => u + (v - u) * f
  const n = (x: number, y: number, z: number) => {
    const l = Math.hypot(x, y, z) || 1
    return [x / l, y / l, z / l] as const
  }
  const [rx, ry, rz] = n(L(a.rx, b.rx), L(a.ry, b.ry), L(a.rz, b.rz))
  const [nx, ny, nz] = n(L(a.nx, b.nx), L(a.ny, b.ny), L(a.nz, b.nz))
  const [tx, ty, tz] = n(L(a.tx, b.tx), L(a.ty, b.ty), L(a.tz, b.tz))
  return {
    px: L(a.px, b.px), py: L(a.py, b.py), pz: L(a.pz, b.pz),
    rx, ry, rz, nx, ny, nz, tx, ty, tz,
    w: L(a.w, b.w), s: arc,
    // The mesh ORs `open` across a segment (`sa.open || sb.open`), so a station
    // inside that segment is open exactly when the mesh drops the wall there.
    open: a.open || b.open,
    via: L(a.via, b.via),
  }
}

/* -------------------------------------------------------- the airspace grid */

const CELL = 16
const key = (i: number, j: number, k: number) => `${i},${j},${k}`

/**
 * The airspace of one segment: from sample j's cross-section plane to sample
 * j+1's, |lateral| within the half-width, and AIR_LO..AIR_HI above the deck.
 *
 * The two PLANES are what bound it along the lap, not a +/- half-resolution box
 * around the sample. A box leaves wedge-shaped gaps on the outside of every
 * corner -- on a 100 m radius the outer edge of a 30 m half-width deck travels
 * 1.95 m while the centreline travels 1.5 -- and a rail crossing the road out
 * there would fall through the gap. Planes tile the lap exactly at every width
 * and every radius.
 */
type Air = { a: Frame; b: Frame }

class AirGrid {
  private readonly cells = new Map<string, number[]>()
  constructor(air: Air[]) {
    for (let j = 0; j < air.length; j++) {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity
      let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
      for (const f of [air[j].a, air[j].b]) {
        for (const lat of [-f.w, f.w]) {
          for (const up of [AIR_LO, AIR_HI]) {
            const x = f.px + f.rx * lat + f.nx * up
            const y = f.py + f.ry * lat + f.ny * up
            const z = f.pz + f.rz * lat + f.nz * up
            if (x < x0) x0 = x; if (x > x1) x1 = x
            if (y < y0) y0 = y; if (y > y1) y1 = y
            if (z < z0) z0 = z; if (z > z1) z1 = z
          }
        }
      }
      const M = REPORT_MARGIN
      const i0 = Math.floor((x0 - M) / CELL), i1 = Math.floor((x1 + M) / CELL)
      const j0 = Math.floor((y0 - M) / CELL), j1 = Math.floor((y1 + M) / CELL)
      const k0 = Math.floor((z0 - M) / CELL), k1 = Math.floor((z1 + M) / CELL)
      for (let i = i0; i <= i1; i++) {
        for (let jj = j0; jj <= j1; jj++) {
          for (let k = k0; k <= k1; k++) {
            const kk = key(i, jj, k)
            const arr = this.cells.get(kk)
            if (arr) arr.push(j); else this.cells.set(kk, [j])
          }
        }
      }
    }
  }
  at(x: number, y: number, z: number): number[] | undefined {
    return this.cells.get(key(Math.floor(x / CELL), Math.floor(y / CELL), Math.floor(z / CELL)))
  }
}

/**
 * Signed L-infinity clearance from a world point to one segment's airspace, in
 * that segment's own axes. Negative inside; the magnitude is then how deep.
 * `null` where the point is not between the segment's two end planes at all.
 *
 * THE FRAME IS INTERPOLATED ACROSS THE BAND, not taken from its leading sample,
 * because the mesh builds the deck between two cross-sections and so must this.
 * Reading a point near the far end of a band in the NEAR sample's frame is
 * exact only while the road does not twist, and where it does the error is
 * `lateral * sin(twist)` -- on Meridian Deep's exit from a 65-degree banked
 * corner that is 9 degrees per 1.5 m band and 18.5 m of lateral, so 2.9 m of
 * phantom height, which is larger than everything this gate is looking for. It
 * reported 0.6 m of soffit standing in that road and about half of it was this.
 */
function clearance(
  air: Air, x: number, y: number, z: number,
): { clr: number; lat: number; up: number } | null {
  const { a, b } = air
  const ta = (x - a.px) * a.tx + (y - a.py) * a.ty + (z - a.pz) * a.tz
  if (ta < 0) return null
  const tb = (x - b.px) * b.tx + (y - b.py) * b.ty + (z - b.pz) * b.tz
  if (tb >= 0) return null
  const f = ta / (ta - tb)
  const L = (u: number, v: number) => u + (v - u) * f
  const px = L(a.px, b.px), py = L(a.py, b.py), pz = L(a.pz, b.pz)
  let rx = L(a.rx, b.rx), ry = L(a.ry, b.ry), rz = L(a.rz, b.rz)
  let nx = L(a.nx, b.nx), ny = L(a.ny, b.ny), nz = L(a.nz, b.nz)
  const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl
  const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl
  const dx = x - px, dy = y - py, dz = z - pz
  const lat = dx * rx + dy * ry + dz * rz
  const up = dx * nx + dy * ny + dz * nz
  const latSlack = Math.abs(lat) - L(a.w, b.w)
  const upSlack = Math.max(AIR_LO - up, up - AIR_HI)
  return { clr: Math.max(latSlack, upSlack), lat, up }
}

/* ------------------------------------------- expanding a station into solid */

/** Fill a convex (lateral, up) cross-section with points at `step`. */
function fill(poly: [number, number][], step: number): [number, number][] {
  let l0 = Infinity, l1 = -Infinity, u0 = Infinity, u1 = -Infinity
  for (const [l, u] of poly) {
    if (l < l0) l0 = l; if (l > l1) l1 = l
    if (u < u0) u0 = u; if (u > u1) u1 = u
  }
  const inside = (l: number, u: number) => {
    // Convex polygon, wound consistently: the point is in if it is on the same
    // side of every edge.
    let neg = false, pos = false
    for (let i = 0; i < poly.length; i++) {
      const [px, py] = poly[i], [qx, qy] = poly[(i + 1) % poly.length]
      const c = (qx - px) * (u - py) - (qy - py) * (l - px)
      if (c < -1e-9) neg = true
      if (c > 1e-9) pos = true
    }
    return !(neg && pos)
  }
  const out: [number, number][] = []
  const nl = Math.max(1, Math.ceil((l1 - l0) / step))
  const nu = Math.max(1, Math.ceil((u1 - u0) / step))
  for (let i = 0; i <= nl; i++) {
    for (let j = 0; j <= nu; j++) {
      const l = l0 + (l1 - l0) * (i / nl), u = u0 + (u1 - u0) * (j / nu)
      if (inside(l, u)) out.push([l, u])
    }
  }
  // The outline itself, so a section thinner than `step` still contributes.
  for (let i = 0; i < poly.length; i++) {
    const [px, py] = poly[i], [qx, qy] = poly[(i + 1) % poly.length]
    const n = Math.max(1, Math.ceil(Math.hypot(qx - px, qy - py) / step))
    for (let k = 0; k <= n; k++) out.push([px + (qx - px) * (k / n), py + (qy - py) * (k / n)])
  }
  return out
}

/**
 * Every (lateral, up) offset the built track occupies at one station: the deck
 * surface, and on each side either the barrier's cross-section or -- where the
 * segment is `open` -- the drop-off lip's. Both come straight from
 * `trackMesh.ts`, which is the only place they are written down.
 */
function solidOf(f: Frame): [number, number][] {
  const out: [number, number][] = []
  const n = Math.max(1, Math.ceil((2 * f.w) / DECK_STEP))
  for (let i = 0; i <= n; i++) out.push([-f.w + (2 * f.w) * (i / n), 0])
  const smp = { right: { y: f.ry } } as TrackSample
  for (const side of [-1, 1]) {
    const sec = f.open ? lipProfile() : wallProfile(smp, f.via)
    for (const [lat, up] of fill(sec, STEP)) out.push([side * (f.w + lat), up])
  }
  return out
}

/* --------------------------------------------------------------------- run */

type Hit = {
  s: number; into: number; depth: number; lat: number; up: number
  x: number; y: number; z: number; part: string
}

function run(track: Track, label: string, quiet = false): { hits: Hit[]; best: number } {
  const S = track.samples
  const m = S.length
  const via = viaductWeight(track)
  const widen = Number(arg('widen') ?? 1)
  const res = track.length / m

  const base: Frame[] = S.map((s, i) => frameOf(s, via[i], (i / m) * track.length, s.width * widen))
  const air: Air[] = base.map((f, i) => ({ a: f, b: base[(i + 1) % m] }))
  const grid = new AirGrid(air)

  const perStation = Math.max(1, Math.round(res / STATION))
  let best = Infinity
  let bestAt = ''
  /** Lowest thing the track builds directly OVER another part's road. */
  let head = Infinity
  let headAt = ''
  const hits: Hit[] = []

  for (let i = 0; i < m; i++) {
    const a = base[i], b = base[(i + 1) % m]
    for (let k = 0; k < perStation; k++) {
      const f = k === 0 ? a : lerpFrame(a, b, k / perStation, a.s + res * (k / perStation))
      const pts = solidOf(f)
      for (let pi = 0; pi < pts.length; pi++) {
        const [lat, up] = pts[pi]
        const x = f.px + f.rx * lat + f.nx * up
        const y = f.py + f.ry * lat + f.ny * up
        const z = f.pz + f.rz * lat + f.nz * up
        const cands = grid.at(x, y, z)
        if (!cands) continue
        for (const j of cands) {
          const d = Math.abs(air[j].a.s - f.s)
          if (Math.min(d, track.length - d) < IGNORE_ALONG) continue
          const c = clearance(air[j], x, y, z)
          if (!c) continue
          if (c.clr < best) {
            best = c.clr
            bestAt = `s=${f.s.toFixed(0)}m ${c.clr < 0 ? 'inside' : 'clear of'} s=${air[j].a.s.toFixed(0)}m` +
              ` -- ${Math.abs(c.lat).toFixed(1)}m off a ${air[j].a.w.toFixed(0)}m half-width,` +
              ` ${c.up.toFixed(2)}m above its surface`
          }
          // Headroom: only counts where the point is genuinely OVER the deck,
          // i.e. inside its lateral span. Something 4 m to the side at the same
          // height is not a low bridge, it is a neighbour.
          if (c.up > AIR_HI && Math.abs(c.lat) <= air[j].a.w && c.up < head) {
            head = c.up
            headAt = `s=${air[j].a.s.toFixed(0)}m, carried by s=${f.s.toFixed(0)}m`
          }
          if (c.clr < 0) {
            const part = pi < Math.ceil((2 * f.w) / DECK_STEP) + 1 ? 'deck'
              : f.open ? 'edge lip' : 'barrier'
            hits.push({
              s: f.s, into: air[j].a.s, depth: -c.clr,
              lat: c.lat, up: c.up, x, y, z, part,
            })
          }
        }
      }
    }
  }

  if (!quiet) {
    console.log(`${label} -- ${track.length.toFixed(0)}m, ${m} samples` +
      (widen !== 1 ? `, widths x${widen}` : ''))
    console.log(`airspace tested: |lateral| <= half-width, ${AIR_LO}m to ${AIR_HI}m above the deck`)
    if (Number.isFinite(best)) {
      console.log(best < 0
        ? `deepest intrusion into another part of the lap: ${(-best).toFixed(2)}m  (${bestAt})`
        : `closest the built track comes to another part's road: ${best.toFixed(2)}m clear  (${bestAt})`)
    } else {
      console.log(`no part of the lap comes within ${REPORT_MARGIN}m of another part's road`)
    }
    if (Number.isFinite(head)) {
      console.log(`lowest thing the track builds over its own road: ${head.toFixed(2)}m of headroom` +
        `  (over ${headAt})` +
        (head < FLIGHT_CEIL ? `   <-- under the flight class's ${FLIGHT_CEIL}m ceiling` : ''))
    }
  }
  if (widen === 1) {
    const p = piers(track, air, grid)
    if (p.worst) {
      hits.push(p.worst)
      if (!quiet) {
        console.log(`viaduct substructure: ${p.n} point(s) standing in the road, ` +
          `worst ${p.worst.depth.toFixed(2)}m inside the airspace at s=${p.worst.into.toFixed(0)}m`)
      }
    } else if (!quiet) {
      console.log('viaduct substructure: clear')
    }
  }
  return { hits, best }
}

/**
 * The bridge substructure against the same airspace.
 *
 * No along-lap exclusion: a pier has no lap distance, and it does not need one
 * -- every part of it hangs at least 0.8 m BELOW the deck it carries, so its
 * own deck's airspace is out of reach by construction and anything it reaches
 * belongs to somebody else.
 */
function piers(track: Track, air: Air[], grid: AirGrid): { worst: Hit | null; n: number } {
  const vis = buildTrackVisual(track, QUALITY_PRESETS.high)
  let mesh: THREE.Mesh | null = null
  vis.group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.name === 'viaduct-piers') mesh = o as THREE.Mesh
  })
  if (!mesh) return { worst: null, n: 0 }
  const g = (mesh as THREE.Mesh).geometry
  const pos = g.getAttribute('position'), idx = g.getIndex()
  const a = new THREE.Vector3(), b = new THREE.Vector3(), q = new THREE.Vector3()
  const tri = idx ? idx.count / 3 : pos.count / 3
  let worst: Hit | null = null
  let n = 0
  for (let t = 0; t < tri; t++) {
    for (let e = 0; e < 3; e++) {
      const i0 = idx ? idx.getX(t * 3 + e) : t * 3 + e
      const i1 = idx ? idx.getX(t * 3 + ((e + 1) % 3)) : t * 3 + ((e + 1) % 3)
      a.set(pos.getX(i0), pos.getY(i0), pos.getZ(i0))
      b.set(pos.getX(i1), pos.getY(i1), pos.getZ(i1))
      const steps = Math.min(64, Math.max(1, Math.ceil(a.distanceTo(b) / 0.6)))
      for (let k = 0; k <= steps; k++) {
        q.lerpVectors(a, b, k / steps)
        const cands = grid.at(q.x, q.y, q.z)
        if (!cands) continue
        for (const j of cands) {
          const c = clearance(air[j], q.x, q.y, q.z)
          if (!c || c.clr >= 0 || c.up < PIER_GRAZE) continue
          n++
          if (!worst || -c.clr > worst.depth) {
            worst = {
              s: -1, into: air[j].a.s, depth: -c.clr, lat: c.lat, up: c.up,
              x: q.x, y: q.y, z: q.z, part: 'pier / soffit',
            }
          }
        }
      }
    }
  }
  vis.dispose()
  return { worst, n }
}

function report(hits: Hit[]): void {
  if (!hits.length) {
    console.log('\nCLEAR -- nothing the track builds stands in the track')
    return
  }
  // One line per contiguous run of intruding stations.
  const regions: { from: number; to: number; into: number; worst: Hit }[] = []
  for (const h of hits.sort((a, b) => a.s - b.s)) {
    const last = regions[regions.length - 1]
    if (last && h.s - last.to < 40 && Math.abs(h.into - last.into) < 120) {
      last.to = h.s
      if (h.depth > last.worst.depth) last.worst = h
    } else regions.push({ from: h.s, to: h.s, into: h.into, worst: h })
  }
  console.log(`\nFAILED: ${regions.length} place(s) where the track stands in its own road`)
  for (const r of regions) {
    const w = r.worst
    console.log(`  ${r.from < 0 ? 'viaduct substructure' : `s=${r.from.toFixed(0)}-${r.to.toFixed(0)}m`}` +
      `: ${w.part} intrudes into the road at ` +
      `s=${w.into.toFixed(0)}m, ${w.depth.toFixed(2)}m inside its airspace`)
    console.log(`      ${Math.abs(w.lat).toFixed(1)}m from that deck's centre (half-width there), ` +
      `${w.up.toFixed(2)}m above its surface` +
      `   world (${w.x.toFixed(1)}, ${w.y.toFixed(1)}, ${w.z.toFixed(1)})`)
  }
}

/* -------------------------------------------------------------- SABOTAGE */

/**
 * A GATE THAT HAS ONLY EVER BEEN SEEN PASSING IS NOT EVIDENCE OF ANYTHING.
 *
 * This builds a figure-eight that crosses over itself, sweeps the vertical
 * separation at the crossing, and prints where the gate flips. The flip point
 * is PREDICTED, not observed: the upper deck's barrier skirt hangs
 * `WALL_FOOT` = 1.55 m below its edge on level road, and the airspace it must
 * stay out of is AIR_HI = 3.0 m tall, so the last failing separation is 4.55 m
 * and the first clear one is just above it. If the gate flips anywhere else it
 * is not measuring the wall the mesh builds.
 *
 * It also confirms that a crossing is reported at the two lap distances where
 * it actually happens, not merely that something somewhere went red.
 */
function lemniscate(sep: number): TrackDef {
  const A = 400, H = sep / 2, N = 64
  const nodes = []
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2
    nodes.push({
      p: [A * Math.cos(th), H * Math.sin(th), (A / 2) * Math.sin(2 * th)] as [number, number, number],
      w: 12,
    })
  }
  return {
    id: 'selftest', name: 'self-test figure eight',
    skyTop: 0, skyBottom: 0, fogColor: 0, fogDensity: 0, sunColor: 0, sunIntensity: 1,
    ambientColor: 0, ambientIntensity: 1, sunDirection: [0, 1, 0],
    palette: { a: 0, b: 0, c: 0, accent: 0 },
    nodes, itemBoxRows: [], chargeRuns: [], laps: 3,
  }
}

/**
 * The other half of the sabotage, and the one the whole design turns on: two
 * straights of the SAME lap running side by side at the SAME height, with the
 * gap between their edges swept down to nothing.
 *
 * These must stay green however small the gap gets, because a neighbour beside
 * the road is not in the road -- that is Elkarim's shipped layout and the reason
 * `probe-selfclear`'s 4.5 m distance gate was thrown out. They go red only once
 * the gap is narrower than the barrier's own outboard reach, WALL_CAP + 0.12 =
 * 0.67 m, at which point one deck's wall really is standing in the other's road.
 *
 * Against the 4.55 m the vertical sweep flips at, that is the whole argument:
 * the same gate passes 0.7 m of horizontal separation and fails 4.5 m of
 * vertical. A distance gate cannot do that in either direction.
 */
function stadium(gap: number): TrackDef {
  const W = 12, L = 600
  const d = gap / 2 + W               // centre-to-centre = gap + 2W
  const nodes: TrackDef['nodes'] = []
  const push = (x: number, z: number) => nodes.push({ p: [x, 0, z], w: W })
  const NS = 16, NC = 10
  for (let i = 0; i < NS; i++) push(-L / 2 + (L * i) / NS, d)
  for (let i = 0; i <= NC; i++) {
    const a = Math.PI / 2 - (Math.PI * i) / NC
    push(L / 2 + d * Math.cos(a), d * Math.sin(a))
  }
  for (let i = 0; i < NS; i++) push(L / 2 - (L * i) / NS, -d)
  for (let i = 0; i <= NC; i++) {
    const a = -Math.PI / 2 - (Math.PI * i) / NC
    push(-L / 2 + d * Math.cos(a), d * Math.sin(a))
  }
  return {
    id: 'selftest2', name: 'self-test stadium',
    skyTop: 0, skyBottom: 0, fogColor: 0, fogDensity: 0, sunColor: 0, sunIntensity: 1,
    ambientColor: 0, ambientIntensity: 1, sunDirection: [0, 1, 0],
    palette: { a: 0, b: 0, c: 0, accent: 0 },
    nodes, itemBoxRows: [], chargeRuns: [], laps: 3,
  }
}

if (flag('selftest')) {
  console.log('SABOTAGE: a figure-eight crossing over itself, separation swept.')
  console.log(`prediction: fails at and below ${(AIR_HI + 1.55).toFixed(2)}m ` +
    `(barrier skirt 1.55m below the upper edge, airspace ${AIR_HI}m tall)\n`)
  for (const sep of [2, 3, 4, 4.5, 4.6, 5, 6, 8, 30]) {
    const t = new Track(lemniscate(sep))
    const { hits, best } = run(t, '', true)
    const where = hits.length
      ? `  worst at s=${hits.reduce((p, c) => (c.depth > p.depth ? c : p)).s.toFixed(0)}m ` +
        `into s=${hits.reduce((p, c) => (c.depth > p.depth ? c : p)).into.toFixed(0)}m`
      : ''
    console.log(`  separation ${String(sep).padStart(4)}m  ->  ` +
      (hits.length ? `RED   ${hits.length} station(s), deepest ${(-best).toFixed(2)}m` : `green  ${best.toFixed(2)}m clear`) +
      where)
  }
  console.log('\nSABOTAGE: two straights of one lap side by side, edge gap swept.')
  console.log(`prediction: green down to a ${(0.55 + 0.12).toFixed(2)}m gap -- the barrier's own ` +
    'outboard reach -- and red below it\n')
  for (const gap of [30, 8, 3.9, 1, 0.7, 0.6, 0.25, 0]) {
    const t = new Track(stadium(gap))
    const { hits, best } = run(t, '', true)
    console.log(`  edge gap ${String(gap).padStart(5)}m  ->  ` +
      (hits.length ? `RED   ${hits.length} station(s), deepest ${(-best).toFixed(2)}m` : `green  ${best.toFixed(2)}m clear`))
  }
  process.exit(0)
}

const id = arg('track')
if (flag('all') || !id) {
  let bad = 0
  for (const def of TRACKS) {
    const t = new Track(def)
    const { hits } = run(t, `${def.name} (${def.id})`)
    report(hits)
    if (hits.length) bad++
    console.log('')
  }
  process.exit(bad ? 1 : 0)
}

const def = TRACKS_BY_ID[id]
if (!def) { console.log(`no track ${id}`); process.exit(1) }
const track = new Track(def)
const { hits } = run(track, `${def.name} (${id})`)
report(hits)
process.exit(hits.length ? 1 : 0)
