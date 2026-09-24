import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { Track, SURFACE_GRIP } from '../src/sim/track'
import { lerp } from '../src/sim/math'
import { getDerived, getLocomotion } from '../src/content/chassis'
import { lateralBudget, cornerSpeedAt } from '../src/sim/vehicle'
import { RUSTFALL } from '../src/content/tracks/rustfall'
import { CRYOSTATIC } from '../src/content/tracks/cryostatic'
import { AETHERION } from '../src/content/tracks/aetherion'
import { TRACKS } from '../src/content/tracks'
import { TUNING } from '../src/content/tuning'
import { buildEnvironment } from '../src/render/environment'
import { buildTrackVisual } from '../src/render/trackMesh'
import { QUALITY_PRESETS } from '../src/render/api'
import { crackProgress, publishHazard, resetHazard } from '../src/render/hazardSignal'

/**
 * The lap authoring checklist, enforced. A track that fails these is not a
 * track that can be raced, and a self-intersecting ribbon breaks both the
 * visual mesh and Track.project().
 */
describe('Rustfall track geometry', () => {
  const track = new Track(RUSTFALL)

  it('is long enough for a 55-75s lap', () => {
    expect(track.length).toBeGreaterThan(1500)
    expect(track.length).toBeLessThan(4000)
  })

  it('never turns tighter than its own half-width (no self-intersection)', () => {
    const bad: string[] = []
    const m = track.samples.length
    for (let i = 0; i < m; i++) {
      const a = track.samples[i]
      const b = track.samples[(i + 4) % m]
      const cross = a.tangent.z * b.tangent.x - a.tangent.x * b.tangent.z
      const dot = Math.max(-1, Math.min(1, a.tangent.x * b.tangent.x + a.tangent.z * b.tangent.z))
      const dTheta = Math.abs(Math.atan2(cross, dot))
      const arc = 4 * 1.5
      if (dTheta > 1e-4) {
        const radius = arc / dTheta
        if (radius < a.width * 1.05) {
          bad.push(`s=${((i / m) * track.length).toFixed(0)}m radius=${radius.toFixed(1)}m width=${a.width}`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('closes the loop smoothly at the start line', () => {
    const first = track.samples[0].tangent
    const last = track.samples[track.samples.length - 1].tangent
    const dot = first.x * last.x + first.z * last.z
    expect(dot).toBeGreaterThan(0.9)
  })

  it('has item box rows and charge runs placed on the surface', () => {
    expect(RUSTFALL.itemBoxRows.length).toBeGreaterThanOrEqual(4)
    for (const row of RUSTFALL.itemBoxRows) {
      const half = (row.count - 1) / 2 * row.spread
      const w = track.at(row.at * track.length).width
      expect(half).toBeLessThan(w)
    }
  })

  it('contains at least one Tier-4 capable sweeper', () => {
    // Tier 4 needs ~3.2-4.5s of sustained arc. At ~55 m/s that is 175m+ of
    // continuous curvature above a drift-worthy threshold.
    let best = 0, run = 0
    for (let i = 0; i < track.samples.length; i++) {
      const s = (i / track.samples.length) * track.length
      const k = Math.abs(track.curvatureAt(s, 20))
      if (k > 0.0035 && k < 0.02) { run += 1.5; best = Math.max(best, run) } else { run = 0 }
    }
    expect(best).toBeGreaterThan(150)
  })

  it('never crosses over itself in 3D (excluding the start/finish closure)', () => {
    // A ribbon that folds through itself breaks the visual mesh AND makes
    // Track.project() ambiguous, which puts racers on the wrong lap. Caught a
    // real overlap between the sweeper entry and the esses return leg.
    const m = track.samples.length
    const offenders: string[] = []
    for (let i = 0; i < m; i++) {
      for (let j = i + 40; j < m; j++) {
        // Skip pairs that are close along the track, including across the seam.
        if (Math.min(j - i, m - (j - i)) < 60) continue
        const a = track.samples[i]
        const b = track.samples[j]
        const plan = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z)
        if (plan >= a.width + b.width) continue
        if (Math.abs(a.pos.y - b.pos.y) >= 4.0) continue // a flyover is fine
        offenders.push(
          `s=${((i / m) * track.length).toFixed(0)}m overlaps s=${((j / m) * track.length).toFixed(0)}m ` +
          `(plan ${plan.toFixed(1)}m, vertical ${Math.abs(a.pos.y - b.pos.y).toFixed(2)}m)`,
        )
      }
    }
    expect(offenders.slice(0, 5)).toEqual([])
  })

  it('keeps every gradient inside the 12 percent sustained limit', () => {
    const m = track.samples.length
    const steep: string[] = []
    for (let i = 0; i < m; i++) {
      const a = track.samples[i], b = track.samples[(i + 8) % m]
      const run = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z)
      if (run < 1) continue
      const grade = Math.abs(b.pos.y - a.pos.y) / run
      if (grade > 0.26) steep.push(`s=${((i / m) * track.length).toFixed(0)}m grade=${(grade * 100).toFixed(1)}%`)
    }
    expect(steep.slice(0, 5)).toEqual([])
  })
})

/**
 * The environment has to fit the ribbon, and it has to keep fitting it when the
 * ribbon changes. Rustfall's half-widths were multiplied by 1.5 and every
 * lateral in the art layer that had been written as an absolute number of
 * metres — rather than as a function of `sample.width` — put something solid on
 * the road: the conveyor gantry legs at a hardcoded +/-19 m ended up 0.5 m
 * inside a 19.5 m half-width, and the viaduct pier legs came up through the low
 * side of their own banked deck.
 *
 * These tests are the guard. They read the real scene graph — the same
 * InstancedMeshes and merged geometry the renderer draws — so they cannot pass
 * by agreeing with a duplicate of the placement maths.
 */
/**
 * Run for EVERY track on the roster, not just the one the rules were written
 * against -- and driven off `TRACKS` rather than a hand-written list, so a
 * ninth planet is covered the day it is added rather than the day somebody
 * remembers this file.
 *
 * These are placement invariants -- nothing solid inside the road or its
 * airspace, no terrain above the road at any lateral -- and they hold for a
 * planet or they do not. Cryostatic arrived with the same placement engine and
 * a completely different catalogue (a 13.5 m rock arch swept over the cavern,
 * a banked ice tube, marker poles down the blizzard band), and the only thing
 * standing between that catalogue and a serac on the racing line is this
 * suite actually being pointed at it.
 *
 * ---------------------------------------------------------------------------
 * THIS FIXTURE USED TO PASS THINGS THAT WERE IN THE ROAD, AND IT IS WORTH
 * BEING PRECISE ABOUT WHY, BECAUSE THE OLD COMMENTS HERE NAMED THE WRONG
 * REASONS. It asserted "keeps every prop and landmark out of the road" for
 * Aetherion while `landmark-rotunda` stood 17.90 m inside the edge, and it
 * had a note explaining that the fixture could not speak for the rotunda or
 * for The Hollow Choir's drum -- so the one thing that was actually broken was
 * inside the part the fixture had already written off. Three faults, all now
 * fixed, all of them shared with the old `tools/probe-intrude.ts` and fixed
 * there first; that probe's header is the long version.
 *
 *   1. IT PICKED THE CROSS-SECTION IN PLAN. A point belonged to a sample if it
 *      was within 0.9 m along the PLAN tangent -- and where the road is a
 *      vertical wall the plan tangent and the plan right are parallel, so
 *      "along the lap" and "across the road" stopped being distinguishable.
 *      Bands are now bounded by the two neighbouring cross-section PLANES,
 *      which tile the lap exactly at any width, radius or roll.
 *
 *   2. IT WORKED IN A PLAN-PROJECTED FRAME. The lateral was
 *      `alongLat / |right_xz|`, which diverges as the ribbon rolls past
 *      vertical, and the height was a plain difference in world Y, which is
 *      meaningless on an inverted deck. Both are now taken in the sample's own
 *      banked frame -- the frame `Track.surfacePoint` and `trackMesh.ts` use.
 *
 *   3. IT COULD NOT TELL PAINT FROM AN OBSTACLE, and worked around it with a
 *      list of mesh NAMES to skip that had to be extended by hand every time a
 *      theme painted something. A decal is identified by the fact that it does
 *      not write depth: it cannot occlude anything and the renderer draws it
 *      as an overlay. Every actual prop, landmark and structure in all eight
 *      themes is `depthWrite: true`; every decal, and the camera-anchored
 *      debris volume, is not. So the list is gone and the material answers.
 *
 * `tools/probe-intrude.ts` runs the same measurement from the command line and
 * prints how deep each finding is; this is the gate.
 * ---------------------------------------------------------------------------
 */
describe.each(TRACKS.map((d) => [`${d.name} (${d.id})`, d] as const))(
  '%s environment fits the ribbon', (_name, def) => {
  const track = new Track(def)
  const m = track.samples.length
  const EDGE = TUNING.offTrack.edgeTolerance
  const RACER = TUNING.collision.racerRadius

  /**
   * One cross-section of the ribbon in the frame the sim actually uses -- the
   * full banked frame, not its plan projection.
   *
   * `limit` is where the ROAD ends, which is not where a car can get to. A
   * walled sample's road ends at the barrier, i.e. at `width`; an `open` one
   * has no barrier, so out there the car's own envelope
   * (`width * edgeTolerance + racerRadius`) is the honest edge and it still
   * applies. Measuring the envelope everywhere -- which this fixture used to do
   * -- reaches 4.9 m PAST a 30 m half-width's barrier and reports things that
   * are buried in the wall, unreachable and invisible from the road.
   */
  const frames = track.samples.map((s, i) => ({
    px: s.pos.x, py: s.pos.y, pz: s.pos.z,
    rx: s.right.x, ry: s.right.y, rz: s.right.z,
    nx: s.normal.x, ny: s.normal.y, nz: s.normal.z,
    tx: s.tangent.x, ty: s.tangent.y, tz: s.tangent.z,
    limit: s.open ? s.width * EDGE + RACER : s.width,
    s: (i / track.samples.length) * track.length,
  }))
  // Plan bucket grid covering each band's full lateral reach, so a point 30 m
  // off the centreline of a 60 m-wide road still finds its own sample.
  const CELL = 24
  const grid = new Map<string, number[]>()
  for (let i = 0; i < frames.length; i++) {
    const a = frames[i], b = frames[(i + 1) % frames.length]
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
    for (const g of [a, b]) for (const lat of [-g.limit, g.limit]) {
      const x = g.px + g.rx * lat, z = g.pz + g.rz * lat
      if (x < x0) x0 = x; if (x > x1) x1 = x
      if (z < z0) z0 = z; if (z > z1) z1 = z
    }
    for (let cx = Math.floor((x0 - 2) / CELL); cx <= Math.floor((x1 + 2) / CELL); cx++)
      for (let cz = Math.floor((z0 - 2) / CELL); cz <= Math.floor((z1 + 2) / CELL); cz++) {
        const k = `${cx},${cz}`
        const arr = grid.get(k)
        if (arr) arr.push(i); else grid.set(k, [i])
      }
  }

  /**
   * How far a world point reaches inside the road's own boundary, and how far
   * above the deck it sits, on the cross-section it actually stands on.
   *
   * Both are taken in the sample's BANKED frame, because that is where the road
   * is: on the 34-degree cargo ring the high edge is 9 m above the centreline,
   * and on an inverted deck "above the road" points at the ground. Which
   * cross-section owns a point is decided by the two neighbouring section
   * PLANES rather than by a distance along the plan tangent, so the bands tile
   * the lap exactly however the ribbon is rolled -- including where it is a
   * wall and the plan tangent and plan right are the same direction.
   */
  function reach(x: number, y: number, z: number): { pen: number; dy: number; s: number } | null {
    const cands = grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`)
    if (!cands) return null
    let out: { pen: number; dy: number; s: number } | null = null
    for (const i of cands) {
      const a = frames[i], b = frames[(i + 1) % frames.length]
      const dx = x - a.px, dy = y - a.py, dz = z - a.pz
      if (dx * a.tx + dy * a.ty + dz * a.tz < 0) continue
      if ((x - b.px) * b.tx + (y - b.py) * b.ty + (z - b.pz) * b.tz >= 0) continue
      const lat = dx * a.rx + dy * a.ry + dz * a.rz
      const pen = a.limit - Math.abs(lat)
      if (pen <= 0) continue
      const up = dx * a.nx + dy * a.ny + dz * a.nz
      if (!out || pen > out.pen) out = { pen, dy: up, s: a.s }
    }
    return out
  }

  /**
   * True where a mesh is paint rather than an obstacle: it does not write
   * depth, so it cannot occlude anything and has no inside. See fault 3 above.
   */
  function isDecal(mesh: THREE.Mesh): boolean {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    return mats.every((mm) => mm && (mm as THREE.Material).depthWrite === false)
  }

  /** Every vertex of a mesh (or of every instance of one) in world space. */
  function offenders(mesh: THREE.Mesh, band: [number, number]): string[] {
    const pos = mesh.geometry.getAttribute('position')
    const inst = mesh as unknown as THREE.InstancedMesh
    const count = inst.isInstancedMesh ? inst.count : 1
    const mat = new THREE.Matrix4()
    const p = new THREE.Vector3()
    const bad: string[] = []
    // ALONG THE EDGES, NOT JUST AT THE CORNERS.
    //
    // This used to test vertices only, and it passed a lamp post standing in
    // the middle of The Hollow Choir's start/finish straight for a whole
    // release. A mast is a tall thin box: its only vertices are at the two
    // ends, one on the ground below the deck and one in the air above it, so
    // an object whose MIDDLE goes through the road has no vertex anywhere near
    // the band and clears this fixture by construction. The reported post ran
    // from y=26.7 to y=55.8 through a road at y=30.8 and was invisible here.
    //
    // Walking each triangle edge at 0.6 m -- a tenth of the band -- costs a
    // few seconds on four tracks and makes the fixture able to see the shape
    // of prop that actually causes this, which is anything long and thin.
    const a = new THREE.Vector3(), b = new THREE.Vector3()
    const idx = mesh.geometry.getIndex()
    const tris = idx ? idx.count / 3 : pos.count / 3
    mesh.updateMatrix()
    for (let n = 0; n < count && bad.length < 6; n++) {
      if (inst.isInstancedMesh) inst.getMatrixAt(n, mat); else mat.copy(mesh.matrix)
      let found = false
      for (let t = 0; t < tris && !found; t++) {
        for (let e = 0; e < 3 && !found; e++) {
          const i0 = idx ? idx.getX(t * 3 + e) : t * 3 + e
          const i1 = idx ? idx.getX(t * 3 + ((e + 1) % 3)) : t * 3 + ((e + 1) % 3)
          a.set(pos.getX(i0), pos.getY(i0), pos.getZ(i0)).applyMatrix4(mat)
          b.set(pos.getX(i1), pos.getY(i1), pos.getZ(i1)).applyMatrix4(mat)
          const steps = Math.min(64, Math.max(1, Math.ceil(a.distanceTo(b) / 0.6)))
          for (let k = 0; k <= steps; k++) {
            p.lerpVectors(a, b, k / steps)
            const r = reach(p.x, p.y, p.z)
            if (!r || r.dy < band[0] || r.dy > band[1]) continue
            // The FIRST point of this instance inside the band, not the
            // deepest: the walk stops here because a gate only has to answer
            // yes or no, and stopping is what keeps a scatter of two hundred
            // instances off the suite's clock. Run
            // `npx tsx tools/probe-intrude.ts --track=<id>` for the deepest
            // point of each offender, which is the number that says how bad it
            // is -- this one is wherever the triangle walk happened to start.
            bad.push(`${mesh.name} stands ${r.pen.toFixed(2)}m inside the edge at ` +
              `s=${r.s.toFixed(0)}m, ${r.dy.toFixed(2)}m above the road`)
            found = true
            break
          }
        }
      }
    }
    return bad
  }

  const scene = new THREE.Scene()
  const env = buildEnvironment(track, scene, QUALITY_PRESETS.high)
  const visual = buildTrackVisual(track, QUALITY_PRESETS.high)

  /**
   * THE AIRSPACE THE ROAD OWNS, metres above the deck.
   *
   * The floor is ZERO, not a small negative. The deck is opaque and faces up:
   * anything strictly under it cannot be seen from the road and cannot be
   * touched by a car riding on it, and an object that really does pass THROUGH
   * the deck has geometry on both sides, so it is still caught from above. A
   * negative floor buys nothing and costs findings -- at -0.15 it reports The
   * Hollow Choir's drum hull, which is the bore the road runs through, sitting
   * 1.4 cm under its own deck exactly as intended.
   *
   * The ceiling is above the 3 m barrier because a flight chassis rides to
   * 6.5 m; 5 m is where the old fixture set it and nothing has argued for more.
   */
  const BAND: [number, number] = [0, 5.0]

  it('keeps every prop and landmark out of the road and its airspace', () => {
    const bad: string[] = []
    for (const obj of env.group.children) {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh) continue
      // The ground the road sits on meets the deck everywhere by construction;
      // it is the one opaque thing that is allowed to. Everything else that is
      // legitimately ON the road -- the magma veins, the smelt pit and its
      // shimmer, the crack ripple, Namaresh's void skin, the camera-anchored
      // debris volume -- is paint, and says so in its own material.
      if (mesh.name === 'terrain') continue
      if (isDecal(mesh)) continue
      bad.push(...offenders(mesh, BAND))
    }
    expect(bad.slice(0, 5)).toEqual([])
  })

  /**
   * THE GATE HAS TO BE SHOWN FAILING SOMETHING.
   *
   * A fixture that reports nothing is indistinguishable from a fixture that
   * cannot see, and this one spent a release in exactly that state. So four
   * probes are planted at known offsets from the MOST INVERTED sample on this
   * track -- found by searching rather than written down, so a content edit
   * cannot quietly move the check onto level road -- and each asserts a
   * different edge of the measurement:
   *
   *   mast-in-road      a 20 m box through the middle of the deck   -> caught
   *   mast-mid-only     the same, with its ENDS clear of the band   -> caught
   *                     (this is the lamp post that shipped: no vertex is
   *                      anywhere near the road, so the vertex-sampling
   *                      version of this fixture could not see it)
   *   prop-behind-wall  a block 1.2 m OUTSIDE the road edge         -> passed
   *   decal-on-road     the same box as mast-in-road, depthWrite:false -> passed
   *
   * On a track with no inversion this runs on its most banked sample, which is
   * still a frame the plan-projected version of `reach()` got wrong.
   */
  it('reports a mast standing in the road, and does not report paint or a prop behind the wall', () => {
    let worst = track.samples[0], wi = 0
    for (let i = 0; i < m; i++) if (track.samples[i].normal.y < worst.normal.y) { worst = track.samples[i]; wi = i }
    const at = (lat: number, up: number) => new THREE.Vector3(
      worst.pos.x + worst.right.x * lat + worst.normal.x * up,
      worst.pos.y + worst.right.y * lat + worst.normal.y * up,
      worst.pos.z + worst.right.z * lat + worst.normal.z * up,
    )
    const plant = (name: string, g: THREE.BufferGeometry, p: THREE.Vector3, mm: THREE.Material) => {
      const mesh = new THREE.Mesh(g, mm)
      mesh.name = name
      mesh.position.copy(p)
      // Stand it along the sample's own normal, so "20 m tall" means 20 m off
      // the deck even where the deck is upside down.
      mesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(worst.normal.x, worst.normal.y, worst.normal.z),
      )
      return mesh
    }
    const solid = new THREE.MeshStandardMaterial()
    const paint = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })
    const probes: [THREE.Mesh, boolean][] = [
      [plant('mast-in-road', new THREE.BoxGeometry(0.6, 20, 0.6), at(4, 2), solid), true],
      [plant('mast-mid-only', new THREE.BoxGeometry(0.6, 40, 0.6), at(-6, 0), solid), true],
      [plant('prop-behind-wall', new THREE.BoxGeometry(1.5, 2, 1.5), at(worst.width + 1.2, 1), solid), false],
      [plant('decal-on-road', new THREE.BoxGeometry(0.6, 20, 0.6), at(10, 2), paint), false],
    ]
    const where = `${_name} s=${((wi / m) * track.length).toFixed(0)}m ` +
      `(half-width ${worst.width.toFixed(1)}m, deck normal.y=${worst.normal.y.toFixed(2)})`
    for (const [mesh, shouldFail] of probes) {
      const found = isDecal(mesh) ? [] : offenders(mesh, BAND)
      expect(found.length > 0, `${mesh.name} at ${where}: ${found[0] ?? 'not reported'}`)
        .toBe(shouldFail)
      mesh.geometry.dispose()
    }
    solid.dispose(); paint.dispose()
  })

  // Only meaningful on a track that has a flyover, so it only RUNS on one:
  // this used to register for every circuit and pass the others with an
  // `expect(true)`, which reports a green tick for a measurement nobody made.
  it.runIf(def.id === 'rustfall')('keeps viaduct piers off the road the flyover crosses over', () => {
    // Piers stand `width * 0.46` off the deck centreline and run to the floor,
    // so a bay that lands where the flyover crosses the sweeper plants two legs
    // in the middle of a road 10 m below. A leg on the tarmac shows up here as a
    // clearance of roughly zero; the deck and its soffit legitimately span that
    // road, so what is asserted is the CLEARANCE, not the absence of structure.
    //
    // Measured at the pinch, where the flyover's outer edge overhangs the
    // sweeper's banked outer edge: 3.48 m at the old half-widths, 1.32 m once
    // both roads were widened by 50% — under the roof of a grounded racer,
    // never mind a hover — and 2.76 m now the deck's edge is a 0.9 m viaduct
    // plate instead of a 2.35 m ground skirt (VIA_FOOT in trackMesh.ts).
    //
    // 2.4 m is therefore a floor with the fix in and without it: a pier leg
    // standing on the tarmac reads as a clearance of about zero, and dropping
    // the viaduct edge rule puts it back under 2.
    let worst = Infinity
    let where = 'nothing overhead'
    visual.group.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh || mesh.name !== 'viaduct-piers') return
      const pos = mesh.geometry.getAttribute('position')
      const p = new THREE.Vector3()
      mesh.updateMatrix()
      for (let v = 0; v < pos.count; v++) {
        p.set(pos.getX(v), pos.getY(v), pos.getZ(v)).applyMatrix4(mesh.matrix)
        const r = reach(p.x, p.y, p.z)
        // Below the road is the pier's own cross-head, hidden inside the wall
        // skirt. Only what is over a road can be too low over it.
        if (!r || r.dy < 0 || r.dy >= worst) continue
        worst = r.dy
        where = `s=${r.s.toFixed(0)}m, ${r.pen.toFixed(1)}m inside the edge`
      }
    })
    expect(worst, `lowest pier/soffit clearance ${worst.toFixed(2)}m at ${where}`)
      .toBeGreaterThan(2.4)
  })

  /**
   * THE GROUND IS NEVER ABOVE THE ROAD.
   *
   * `Track.surfacePoint(s, lat)` is `pos + right * lat` and `right.y` is
   * non-zero wherever the track banks, so the low edge of the 34-degree cargo
   * ring sits 6.1 m BELOW its own centreline. A height field derived from the
   * centreline and tucked a fixed amount under it lands ABOVE the road it is
   * meant to be under, and the error grows with lateral distance — which is
   * exactly what widening the ribbon does. Tested against the RENDERED
   * triangles, at the coarsest terrain grid, because a grid quad straddling
   * the ribbon's low edge is where the margin is thinnest.
   */
  for (const tier of ['low', 'high'] as const) {
    it(`keeps the terrain under the road across the full width (${tier} tier)`, () => {
      const tierEnv = tier === 'high'
        ? env
        : buildEnvironment(track, new THREE.Scene(), QUALITY_PRESETS[tier])
      const terrain = tierEnv.group.children.find((c) => c.name === 'terrain') as THREE.Mesh
      const pos = terrain.geometry.getAttribute('position')
      // Structured grid, x varying fastest — recover its axes.
      let nx = 1
      while (nx < pos.count && pos.getX(nx) > pos.getX(nx - 1)) nx++
      const nz = pos.count / nx
      const xs: number[] = [], zs: number[] = []
      for (let i = 0; i < nx; i++) xs.push(pos.getX(i))
      for (let j = 0; j < nz; j++) zs.push(pos.getZ(j * nx))

      const cell = (arr: number[], v: number): number => {
        if (v < arr[0] || v > arr[arr.length - 1]) return -1
        let lo = 0, hi = arr.length - 1
        while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (arr[mid] <= v) lo = mid; else hi = mid }
        return lo
      }
      /** The rendered surface at (x,z): same alternating diagonal buildTerrain emits. */
      const heightAt = (x: number, z: number): number => {
        const i = cell(xs, x), j = cell(zs, z)
        if (i < 0 || j < 0) return -Infinity
        const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1
        const tris = ((i ^ j) & 1) === 0 ? [[a, c, b], [b, c, d]] : [[a, c, d], [a, d, b]]
        for (const t of tris) {
          const x0 = pos.getX(t[0]), z0 = pos.getZ(t[0])
          const x1 = pos.getX(t[1]), z1 = pos.getZ(t[1])
          const x2 = pos.getX(t[2]), z2 = pos.getZ(t[2])
          const det = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2)
          if (Math.abs(det) < 1e-9) continue
          const l0 = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / det
          const l1 = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / det
          const l2 = 1 - l0 - l1
          if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue
          return l0 * pos.getY(t[0]) + l1 * pos.getY(t[1]) + l2 * pos.getY(t[2])
        }
        return -Infinity
      }

      const above: string[] = []
      for (let i = 0; i < m; i++) {
        const s = track.samples[i]
        for (let k = 0; k <= 24; k++) {
          const lat = (-1 + k / 12) * s.width
          const gx = s.pos.x + s.right.x * lat
          const gy = s.pos.y + s.right.y * lat
          const gz = s.pos.z + s.right.z * lat
          const g = heightAt(gx, gz)
          if (g === -Infinity || g <= gy) continue
          above.push(`s=${((i / m) * track.length).toFixed(0)}m lat=${lat.toFixed(1)}m ` +
            `bank=${(s.bank * 180 / Math.PI).toFixed(0)}deg ground ${(g - gy).toFixed(2)}m above the road`)
        }
      }
      if (tier !== 'high') tierEnv.dispose()
      expect(above.slice(0, 5)).toEqual([])
    })
  }
})

/**
 * THE FRAGILE ICE SHELF.
 *
 * `RaceState.iceCracked` is a sim latch the road material has to see, and the
 * two things it drives — a barrier that goes through the ice and a drop-off
 * edge that comes up out of it — are both baked into the ribbon at build time
 * and swapped by a vertex displacement. Neither is visible in a screenshot
 * taken before lap 3, so this is where they get checked.
 */
describe('the fragile ice shelf', () => {
  it('ramps the collapse off the sim latch and resets for a rematch', () => {
    resetHazard()
    expect(crackProgress()).toBe(0)
    // Not cracked: no amount of time moves it.
    publishHazard(false, 5)
    expect(crackProgress()).toBe(0)
    // Cracked: ramps, and saturates rather than running past 1.
    publishHazard(true, 0.5)
    const half = crackProgress()
    expect(half).toBeGreaterThan(0.2)
    expect(half).toBeLessThan(0.6)
    publishHazard(true, 5)
    expect(crackProgress()).toBe(1)
    // A rematch starts with the shelf intact.
    resetHazard()
    expect(crackProgress()).toBe(0)
  })

  it('gives the Cryostatic shelf BOTH a barrier and a drop-off edge', () => {
    // KIND_FWALL / KIND_FLIP, the two fragile variants, live in aTrack.w. The
    // sim treats a cracked shelf as `open` — a car really can leave it — so a
    // shelf that carried only the barrier would have an invisible boundary
    // after lap 3, and one that carried only the lip would be a hole in the
    // world for two laps.
    const cryo = new Track(CRYOSTATIC)
    const vis = buildTrackVisual(cryo, QUALITY_PRESETS.high)
    let fwall = 0, flip = 0
    vis.group.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh || !mesh.name.startsWith('track-chunk')) return
      const a = mesh.geometry.getAttribute('aTrack')
      if (!a) return
      for (let i = 0; i < a.count; i++) {
        const k = a.getW(i)
        if (k > 4.5 && k < 5.5) fwall++
        else if (k > 5.5) flip++
      }
    })
    expect(fwall, 'fragile barrier vertices').toBeGreaterThan(200)
    expect(flip, 'fragile drop-off vertices').toBeGreaterThan(200)
    vis.dispose()
  })

  it('leaves a track with no fragile shelf entirely alone', () => {
    const rust = new Track(RUSTFALL)
    const vis = buildTrackVisual(rust, QUALITY_PRESETS.high)
    let fragile = 0
    vis.group.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh || !mesh.name.startsWith('track-chunk')) return
      const a = mesh.geometry.getAttribute('aTrack')
      if (!a) return
      for (let i = 0; i < a.count; i++) if (a.getW(i) > 4.5) fragile++
    })
    expect(fragile, 'Rustfall carries no fragile geometry').toBe(0)
    vis.dispose()
  })
})

/**
 * THE AUTHORING CHECKLIST AND THE CORNER GRAMMAR, FOR EVERY TRACK.
 *
 * GDD page 05 is a shared vocabulary — corner classes, structural element
 * specs, and a lap authoring checklist that says a track is not done until
 * every line is ticked. Until the friction budget landed in `sim/vehicle.ts`
 * none of it could be checked against anything: surface grip had no effect on
 * the physics, so "the ice sweeper forces grounded chassis to brake" was a
 * belief the AI held and not a property of the track.
 *
 * It is a property now, and these are the lines of the checklist that can be
 * measured from the track data alone. `tools/probe-track.ts` prints the same
 * numbers in full; this pins the ones that must not regress.
 */
describe.each([
  ['Rustfall', RUSTFALL],
  ['Cryostatic', CRYOSTATIC],
  ['Aetherion', AETHERION],
])('%s against the GDD 05 grammar', (name, def) => {
  const track = new Track(def)
  const m = track.samples.length
  const ds = track.length / m
  /** Local radius over a 15m window: short enough to find a Class C apex. */
  const radiusAt = (s: number): number => {
    const k = Math.abs(track.curvatureAt(s - 7.5, 15))
    return k > 1e-6 ? 1 / k : Infinity
  }
  /**
   * WHERE TO READ IT: HALFWAY BETWEEN SAMPLES, NEVER ON ONE.
   *
   * `curvatureAt` compares the tangents of two SAMPLES found by `Track.at`,
   * which snaps an arc length to the nearest one. Read at s = i * L/m -- on a
   * sample -- both ends of the 15 m window sit exactly on a rounding boundary,
   * so which neighbour each end snaps to is decided by the last few bits of
   * floating point, and the window flips between 10 and 11 samples from one i
   * to the next. The same corner then measures two radii an eleventh apart,
   * and every number built on it inherits the flip: Elkarim's surface tax read
   * 0.2526 against its 0.25 floor where the geometry is worth 0.336, and
   * Frosthelm's read passed its 0.55 floor on a lap length 15 mm from the
   * point where the rounding goes the other way. Read halfway between samples
   * the window is 10 samples every time, on every circuit, and the reading is
   * the road's. The sim's own reading has the same flip and is the deferred
   * `Track.at` fix; this is only the instrument.
   */
  const between = (i: number): number => ((i + 0.5) / m) * track.length

  it('lays every item box row on the road and never closer than a box is wide', () => {
    // BOX_SIZE in render/entities.ts is a 2.4m cube. Two boxes on a row closer
    // together than that interpenetrate — which a spread narrow enough to clear
    // the racing line will happily do, and did, before this test existed.
    for (const row of def.itemBoxRows) {
      expect(row.spread, `${name} row at=${row.at} spread`).toBeGreaterThanOrEqual(2.4)
      const half = ((row.count - 1) / 2) * row.spread
      expect(half, `${name} row at=${row.at} half-span`)
        .toBeLessThan(track.at(row.at * track.length).width)
    }
  })

  it('carries at least one corner the friction budget genuinely binds', () => {
    // "Binds" is the whole point of the pass: a corner whose speed limit sits
    // above top speed is a straight with scenery, whatever radius it measures.
    // Solaire (grip 7, the roster median) at the tightest point of each corner.
    const derived = getDerived('solaire')
    const loco = getLocomotion('solaire')
    const top = derived.topSpeed
    let worst = Infinity
    let worstAt = -1
    for (let i = 0; i < m; i++) {
      const s = between(i)
      const surface = track.samples[i].surface
      const grip = lerp(1, SURFACE_GRIP[surface], loco.surfaceFrictionInfluence)
      const v = cornerSpeedAt(lateralBudget(derived, loco, grip), 1 / radiusAt(s))
      if (v < worst) { worst = v; worstAt = s }
    }
    expect(worst, `${name} tightest speed limit, at s=${worstAt.toFixed(0)}m`)
      .toBeLessThan(top * 0.75)
  })

  it('makes its surfaces worth something under the friction budget', () => {
    /**
     * A surface below full grip only costs anything where the corner is tight
     * enough that the reduced lateral budget bites BEFORE top speed does.
     *
     * Measured before this pass: Rustfall's oil slick -- the lowest-grip
     * surface in the game at 0.30 -- sat on 72m of road whose tightest radius
     * is 927m, for a speed limit of 100.8 m/s against a 61.4 m/s top speed. It
     * could not cost anybody anything, and the ENTIRE surface layer of that
     * track was worth 0.108s a lap. Cryostatic's ice was real but badly placed:
     * 488m of it, of which only 342m sat on radius tight enough to bite.
     *
     * So the assertion is on the ideal lap: integrate ds / min(topSpeed,
     * cornerSpeed(s)) once with the authored surfaces and once with every
     * surface at full grip, and the difference is what the surfaces are worth
     * per lap under the physics alone -- no AI caution, no drift, no items.
     *
     * Floors are per track because the two are answering different briefs:
     * Cryostatic's hook IS its surfaces, Rustfall's hook is the crane drops and
     * its low-grip work is a texture on two corners. Measured before this pass
     * / after: Rustfall 0.108s / 0.645s, Cryostatic 1.535s / 1.990s.
     */
    const derived = getDerived('solaire')
    const loco = getLocomotion('solaire')
    const top = derived.topSpeed
    /**
     * THE BRAKING PASS, added after a player reported that a slick inside a
     * corner is no challenge. He was right, and this metric was half the
     * reason the obvious fix did not work: it integrated CORNERING speed only.
     * An approach is not tight enough for the lateral budget to bite, so a
     * patch moved out of a corner scored ~0 here -- and braking was flatly
     * grip-immune in the sim besides (measured 32.5m to stop from 61 m/s on
     * tarmac, gravel and ice alike, to three figures). Both are fixed: the
     * brake now scales with the budget above TUNING.grip.brakeFloor, and this walks
     * the lap BACKWARDS so a corner's speed limit reaches back up its own
     * approach at the braking rate available THERE. A slick before a corner
     * now costs what it should, and the floors below can mean something again.
     */
    const idealLap = (real: boolean): number => {
      const brakeRate = (top / Math.max(0.3, derived.timeToTop)) * TUNING.derive.accelCurveGain * 1.5
      const gripAt = (i: number) => {
        const surface = real ? track.samples[i].surface : 'tarmac'
        return lerp(1, SURFACE_GRIP[surface], loco.surfaceFrictionInfluence)
      }
      const v = new Array<number>(m)
      for (let i = 0; i < m; i++) {
        v[i] = Math.min(top, cornerSpeedAt(lateralBudget(derived, loco, gripAt(i)), 1 / radiusAt(between(i))))
      }
      // Two laps of backward relaxation so the limit propagates around the
      // wrap, which one pass cannot do on a closed circuit.
      for (let pass = 0; pass < 2; pass++) {
        for (let n = m - 1; n >= 0; n--) {
          const i = n, j = (n + 1) % m
          const a = brakeRate * Math.max(TUNING.grip.brakeFloor, gripAt(i))
          v[i] = Math.min(v[i], Math.sqrt(v[j] * v[j] + 2 * a * ds))
        }
      }
      let t = 0
      for (let i = 0; i < m; i++) t += ds / v[i]
      return t
    }
    // Aetherion's floor is a tenth of Cryostatic's on purpose. Its hook is not
    // its surfaces: the only low-grip road on the planet is the drift of dust
    // across Keystone Plaza and the first corner of the descent, and what that
    // has to earn is the plaza sweeper itself -- 132m and 65m of radius that
    // would both be flat out on clean stone. Measured 0.326s/lap.
    // FLOORS LOWERED, DELIBERATELY, AND THE REASON MATTERS MORE THAN THE
    // NUMBERS. Measured before this pass / after: Rustfall 0.645s / 0.313s,
    // Cryostatic 1.990s / 0.624s. The surfaces did not get weaker -- they
    // MOVED, out of the corners and onto the approaches, on a play report that
    // a slick inside a corner "really offers no challenge".
    //
    // An in-corner slick costs IDEAL LAP TIME: the corner binds, the budget is
    // smaller, the lap is slower, and no decision was ever offered. An
    // approach slick costs ERROR MARGIN: you brake earlier and still make the
    // corner, so an ideal lap barely notices -- and an ideal lap is by
    // definition driven by someone who never arrives too fast. The quantity
    // this metric measures is the quantity the new design deliberately stopped
    // spending. Adding the braking pass above recovered some of it (0.267 ->
    // 0.313, 0.566 -> 0.624) and could not recover the rest, because there is
    // nothing there to recover.
    //
    // So the floor keeps the part that still means something -- the surface
    // layer is not decorative -- and the PLACEMENT assertion below is what now
    // carries the design rule the old floor was standing in for.
    //
    // AND ONE FLOOR MOVED BECAUSE THE INSTRUMENT GOT HONEST, not because the
    // track changed. Read between samples (see `between` above) the three
    // measure Rustfall 0.336, Cryostatic 0.424 and Aetherion 0.660 s a lap.
    // Cryostatic's 0.55 floor had been cleared only by the on-sample reading's
    // rounding flip, so it comes down to 0.40, under the honest value with the
    // same kind of margin the other two have; nothing about the ice moved.
    const floor: Record<string, number> = { rustfall: 0.25, cryostatic: 0.40, aetherion: 0.25 }
    const tax = idealLap(true) - idealLap(false)
    expect(tax, `${name} surface tax per lap under the friction budget`)
      .toBeGreaterThan(floor[def.id])

    /**
     * THE PLACEMENT RULE, which the old floor was a proxy for and which is now
     * asserted directly: a low-grip run either hands the car into road that is
     * MEANINGFULLY TIGHTER than the road it sits on -- an approach, where it
     * is a braking decision -- or it is authored terrain, a whole beat
     * surfaced that way on purpose rather than a slick dropped in a corner.
     *
     * The exemptions are named rather than inferred, because "is this a slick
     * or is this terrain" is a judgement a test cannot make: Aetherion's
     * Keystone Plaza and its descent are 698m of banked, art-matched dust with
     * balance measured across several passes, and the Hollow Choir's Antechoir
     * is gravel at 0.70 rather than ice at 0.45 specifically so the corner
     * stays chargeable. Both were reviewed and kept.
     */
    const TERRAIN: Record<string, [number, number][]> = {
      aetherion: [[1700, 2420], [3040, 3170]],
      hollowchoir: [[580, 760]],
    }
    const exempt = (s: number) =>
      (TERRAIN[def.id] ?? []).some(([a, b]) => s >= a && s <= b)
    for (let i = 0; i < m; i++) {
      const s = (i / m) * track.length
      if (SURFACE_GRIP[track.samples[i].surface] >= 0.999) continue
      if (SURFACE_GRIP[track.samples[i].surface] > 0.9) continue  // 0.95 metal is flavour
      if (exempt(s)) continue
      const kOn = Math.abs(track.curvatureAt(s, 20))
      let kAhead = 0
      for (let d = 10; d <= 230; d += 10) kAhead = Math.max(kAhead, Math.abs(track.curvatureAt(s + d, 20)))
      expect(kAhead, `${name}: low-grip at s=${s.toFixed(0)}m must feed tighter road`)
        .toBeGreaterThan(kOn * 1.15)
    }

    // ...and at least one stretch where the surface is what makes the corner,
    // rather than a rounding error on a corner that already binds.
    let best = Infinity
    let bestWhere = 'no low-grip surface at all'
    for (let i = 0; i < m; i++) {
      const surface = track.samples[i].surface
      if (SURFACE_GRIP[surface] >= 0.999) continue
      const s = (i / m) * track.length
      const grip = lerp(1, SURFACE_GRIP[surface], loco.surfaceFrictionInfluence)
      const v = cornerSpeedAt(lateralBudget(derived, loco, grip), 1 / radiusAt(s))
      if (v < best) { best = v; bestWhere = `${surface} at s=${s.toFixed(0)}m, R=${radiusAt(s).toFixed(0)}m` }
    }
    expect(best / top, `${name} strongest low-grip bite is ${bestWhere}`).toBeLessThan(0.80)
  })

  it('keeps every sustained grade inside the grammar 12 percent', () => {
    // The 12% figure is "max sustained", so it is read over a 30m window; the
    // grammar allows 25% on a ramp deck and those are ~18m long. Cryostatic's
    // chasm-jump mid-gap node used to sit HIGHER than the ramp it launches from,
    // which put a 13.5% sustained grade in the middle of the jump.
    let worst = 0
    let worstAt = 0
    for (let i = 0; i < m; i++) {
      const a = track.samples[i], b = track.samples[(i + 20) % m]
      const run = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z)
      if (run < 1) continue
      const grade = Math.abs(b.pos.y - a.pos.y) / run
      if (grade > worst) { worst = grade; worstAt = (i / m) * track.length }
    }
    expect(worst, `${name} steepest sustained grade at s=${worstAt.toFixed(0)}m`)
      .toBeLessThanOrEqual(0.12)
  })

  it('holds a documented vertical clearance wherever the ribbon crosses itself', () => {
    /**
     * THIS IS A REGRESSION PIN OVER A KNOWN DEFECT, not a clean bill of health.
     *
     * The Rustfall suite above asserts the ribbon never overlaps itself in plan
     * with under 4m of vertical separation, and its comment claimed Cryostatic
     * "never crosses itself". Measured, Cryostatic crosses itself 388 sample
     * pairs' worth: the moraine switchback climb at s=1138m passes under the
     * chasm-jump approach at s=1567m with 2.12m of clearance, against half
     * widths of 18m and 20m.
     *
     * It is survivable — `Track.project` searches +/-60m around the hint, so a
     * 429m separation along the spline can never be confused, and there is no
     * vertical collision in the sim — but it is under the 4m a flyover is
     * supposed to have, and trackMesh's viaduct rule needs a 4m drop before it
     * will build a soffit, so this crossing has no bridge structure under it.
     * Fixing it means re-laying the moraine or the chasm approach, which is a
     * bigger geometry change than a surface pass should make on an art-passed
     * track. Pinned here so it cannot quietly get worse.
     */
    // Aetherion crosses itself once, on purpose: the rotunda climbs 20m of the
    // city's own tier and its exit runs back out over the causeway it arrived
    // on, which is the one place the tiers are legible from the road. Measured
    // 19.3m of clearance, so it holds the 4m a flyover is supposed to have with
    // room to spare.
    const floor: Record<string, number> = { rustfall: 4.0, cryostatic: 2.0, aetherion: 4.0 }
    let minDy = Infinity
    let where = 'the ribbon never overlaps itself in plan'
    for (let i = 0; i < m; i++) {
      for (let j = i + 40; j < m; j++) {
        if (Math.min(j - i, m - (j - i)) < 60) continue
        const a = track.samples[i], b = track.samples[j]
        if (Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z) >= a.width + b.width) continue
        const dy = Math.abs(a.pos.y - b.pos.y)
        if (dy < minDy) {
          minDy = dy
          where = `s=${((i / m) * track.length).toFixed(0)}m over s=${((j / m) * track.length).toFixed(0)}m`
        }
      }
    }
    // All three of these circuits cross themselves, on purpose and documented
    // above, so finding no crossing is a regression in its own right -- the
    // flyover or the pass-under has gone -- not a free pass. It used to return
    // `expect(true)` here, and `Infinity > floor` would have passed as well.
    expect(minDy, `${name} is documented as crossing itself, and no crossing was found`)
      .toBeLessThan(Infinity)
    expect(minDy, `${name} closest road-over-road clearance at ${where}`)
      .toBeGreaterThan(floor[def.id])
  })

  it('has a Tier-4 capable sweeper and a Class C equaliser', () => {
    // Tier 4 wants 3.2-4.5s of sustained arc, which at racing pace is 150m+ of
    // continuous Class A/B curvature. Class C (20-55m) is the grammar's
    // equaliser and every track needs one somewhere.
    let sweeper = 0, run = 0, tightest = Infinity
    for (let i = 0; i < m; i++) {
      const r = radiusAt((i / m) * track.length)
      tightest = Math.min(tightest, r)
      if (r >= 55 && r <= 260) { run += ds; sweeper = Math.max(sweeper, run) } else { run = 0 }
    }
    expect(sweeper, `${name} longest Class A/B arc`).toBeGreaterThan(150)
    expect(tightest, `${name} tightest radius`).toBeLessThan(55)
    expect(tightest, `${name} tightest radius vs the 20m Class C floor`).toBeGreaterThan(20)
  })
})
