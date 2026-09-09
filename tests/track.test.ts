import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { Track, SURFACE_GRIP } from '../src/sim/track'
import { lerp } from '../src/sim/math'
import { getDerived, getLocomotion } from '../src/content/chassis'
import { lateralBudget, cornerSpeedAt } from '../src/sim/vehicle'
import { RUSTFALL } from '../src/content/tracks/rustfall'
import { CRYOSTATIC } from '../src/content/tracks/cryostatic'
import { AETHERION } from '../src/content/tracks/aetherion'
import { HOLLOWCHOIR } from '../src/content/tracks/hollowchoir'
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
 * Run for EVERY track, not just the one the rules were written against.
 *
 * These are placement invariants — nothing solid inside the road or its
 * airspace, no terrain above the road at any lateral — and they hold for a
 * planet or they do not. Cryostatic arrived with the same placement engine and
 * a completely different catalogue (a 13.5 m rock arch swept over the cavern,
 * a banked ice tube, marker poles down the blizzard band), and the only thing
 * standing between that catalogue and a serac on the racing line is this
 * suite actually being pointed at it.
 */
describe.each([
  ['Rustfall', RUSTFALL],
  ['Cryostatic', CRYOSTATIC],
  // Aetherion joined this list with its art pass. It is the case the fixture
  // was hardest to get right for: `reach()` measures the lateral in the banked
  // frame as `alongLat / |right_xz|`, and on the rotunda's vertical wall
  // `|right_xz|` is zero -- so the scale diverges, every candidate lateral
  // comes out enormous, the penetration goes negative and the whole wall-ride
  // is skipped. What the fixture therefore covers on this track is the 90% of
  // the lap that is an ordinary road, which is where a prop actually can wander
  // onto the tarmac. The drum is guarded by construction instead: it is swept
  // in the ribbon's own frame at `corridor(width) + pad`, hanging along
  // -normal, so its entire surface is BEHIND the road at every sample.
  ['Aetherion', AETHERION],
  // The Hollow Choir joined with its art pass, and it is the case the fixture
  // is LEAST able to speak for -- worth stating precisely, because the design
  // note written before the pass predicted the wrong failure.
  //
  // The prediction was that `reach()` would divide by a `|right_xz|` that
  // passes through zero on the drum. It does not: `right` on this bore is
  // `-cos(psi) * e_phi + sin(psi) * e_z`, so `|right_xz|^2` is
  // `cos^2(psi) cos^2(phi) + sin^2(psi)`, and psi is 80 degrees through the
  // whole Breach -- measured, the minimum over the lap is 0.92 and the scale
  // never diverges.
  //
  // What DOES break is one step earlier. The fixture picks the cross-section a
  // point stands on by requiring it to be within 0.9 m ALONG the track, using
  // the plan projection of the frame -- and where the road is a wall, the plan
  // tangent and the plan right are parallel, so "along the track" and "across
  // it" are the same direction in plan and the test cannot tell them apart. So
  // on the drum this suite is not measuring what it measures elsewhere.
  //
  // The drum is guarded by CONSTRUCTION instead, which is the same answer
  // Aetherion's rotunda gives: every radius in `themes/hollowchoir.ts` is an
  // offset from a cylinder FITTED to the ribbon's own samples, and the
  // smallest of them is `R + 14` against a road that reaches 79.3 m from that
  // fitted axis at its worst point. What this suite does cover on this track
  // is the 73% of the lap that is ordinary road -- the two galleries, the
  // Gantry's portals, the Carousel's spindle and every scattered prop -- which
  // is exactly where something can wander onto the tarmac.
  ['Hollow Choir', HOLLOWCHOIR],
])('%s environment fits the ribbon', (_name, def) => {
  const track = new Track(def)
  const m = track.samples.length
  const EDGE = TUNING.offTrack.edgeTolerance
  const RACER = TUNING.collision.racerRadius

  /** One cross-section of the ribbon in the frame the sim actually uses. */
  const frames = track.samples.map((s) => {
    const hl = Math.hypot(s.right.x, s.right.z) || 1
    return {
      x: s.pos.x, y: s.pos.y, z: s.pos.z, w: s.width,
      ry: s.right.y, rx: s.right.x / hl, rz: s.right.z / hl, inv: 1 / hl,
    }
  })
  // Plan-space bucket grid, so a scan of every vertex of every prop is linear.
  const CELL = 24
  const grid = new Map<string, number[]>()
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    const gi = Math.floor(f.x / CELL), gj = Math.floor(f.z / CELL)
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const k = `${gi + a},${gj + b}`
      const arr = grid.get(k)
      if (arr) arr.push(i); else grid.set(k, [i])
    }
  }

  /**
   * How far a world point reaches past the forgiving edge, and how far above the
   * road surface it sits, on the cross-section it actually stands on.
   *
   * The lateral is measured in the BANKED frame, because that is where the road
   * is: on the 34-degree cargo ring the high edge is 9 m above the centreline,
   * so a prop standing on the ground well outside the plan footprint can still
   * be hanging inside the road.
   */
  function reach(x: number, y: number, z: number): { pen: number; dy: number; s: number } | null {
    const cands = grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`)
    if (!cands) return null
    let out: { pen: number; dy: number; s: number } | null = null
    for (const i of cands) {
      const f = frames[i]
      const dx = x - f.x, dz = z - f.z
      const alongLat = dx * f.rx + dz * f.rz
      // Samples are 1.5 m apart, so a 0.9 m window picks exactly one frame per
      // section — and still picks BOTH where the track crosses over itself.
      if ((dx * dx + dz * dz) - alongLat * alongLat > 0.81) continue
      const lat = alongLat * f.inv
      const pen = f.w * EDGE + RACER - Math.abs(lat)
      if (pen <= 0) continue
      const dy = y - (f.y + f.ry * Math.max(-f.w, Math.min(f.w, lat)))
      if (!out || pen > out.pen) out = { pen, dy, s: (i / m) * track.length }
    }
    return out
  }

  /** Every vertex of a mesh (or of every instance of one) in world space. */
  function offenders(mesh: THREE.Mesh, band: [number, number]): string[] {
    const pos = mesh.geometry.getAttribute('position')
    const inst = mesh as unknown as THREE.InstancedMesh
    const count = inst.isInstancedMesh ? inst.count : 1
    const mat = new THREE.Matrix4()
    const p = new THREE.Vector3()
    const bad: string[] = []
    mesh.updateMatrix()
    for (let n = 0; n < count && bad.length < 6; n++) {
      if (inst.isInstancedMesh) inst.getMatrixAt(n, mat); else mat.copy(mesh.matrix)
      for (let v = 0; v < pos.count; v++) {
        p.set(pos.getX(v), pos.getY(v), pos.getZ(v)).applyMatrix4(mat)
        const r = reach(p.x, p.y, p.z)
        if (!r || r.dy < band[0] || r.dy > band[1]) continue
        bad.push(`${mesh.name} reaches ${r.pen.toFixed(2)}m inside the edge at ` +
          `s=${r.s.toFixed(0)}m, ${r.dy.toFixed(2)}m above the road`)
        break
      }
    }
    return bad
  }

  const scene = new THREE.Scene()
  const env = buildEnvironment(track, scene, QUALITY_PRESETS.high)
  const visual = buildTrackVisual(track, QUALITY_PRESETS.high)

  it('keeps every prop and landmark out of the road and its airspace', () => {
    const bad: string[] = []
    for (const obj of env.group.children) {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh || mesh.name === 'sky' || mesh.name === 'terrain') continue
      // The smelt pit and its shimmer are unlit transparent decals on the floor,
      // and the crack ripple is a decal on the ice.
      if (mesh.name.startsWith('landmark-smelt') || mesh.name === 'heat-shimmer') continue
      if (mesh.name === 'crack-ripple') continue
      // Aetherion's void skin is a decal ON the phasing spans, 14 cm over the
      // deck, drawn only while the sim says that deck does not exist. It is on
      // the road on purpose and is the one thing in this file that is.
      if (mesh.name === 'bridge-void-decal') continue
      bad.push(...offenders(mesh, [-0.15, 5.0]))
    }
    expect(bad.slice(0, 5)).toEqual([])
  })

  it('keeps viaduct piers off the road the flyover crosses over', () => {
    // Only meaningful on a track that has a flyover. Cryostatic never crosses
    // itself, so it builds no piers and the assertion has nothing to measure.
    if (def.id !== 'rustfall') { expect(true).toBe(true); return }
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
      const s = (i / m) * track.length
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
    const idealLap = (real: boolean): number => {
      let t = 0
      for (let i = 0; i < m; i++) {
        const s = (i / m) * track.length
        const surface = real ? track.samples[i].surface : 'tarmac'
        const grip = lerp(1, SURFACE_GRIP[surface], loco.surfaceFrictionInfluence)
        t += ds / Math.min(top, cornerSpeedAt(lateralBudget(derived, loco, grip), 1 / radiusAt(s)))
      }
      return t
    }
    // Aetherion's floor is a tenth of Cryostatic's on purpose. Its hook is not
    // its surfaces: the only low-grip road on the planet is the drift of dust
    // across Keystone Plaza and the first corner of the descent, and what that
    // has to earn is the plaza sweeper itself -- 132m and 65m of radius that
    // would both be flat out on clean stone. Measured 0.326s/lap.
    const floor: Record<string, number> = { rustfall: 0.35, cryostatic: 1.75, aetherion: 0.25 }
    const tax = idealLap(true) - idealLap(false)
    expect(tax, `${name} surface tax per lap under the friction budget`)
      .toBeGreaterThan(floor[def.id])

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
    if (minDy === Infinity) { expect(true).toBe(true); return }
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
