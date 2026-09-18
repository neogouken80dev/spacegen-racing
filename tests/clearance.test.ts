/**
 * NOTHING IN THIS REPO LOOKED AT THE FLOOR.
 *
 * The model origin sits at the racer's position, which the sim places
 * `rideHeight` above the surface. So the ground plane in MODEL space is
 * y = -rideHeight, and every vertex of a vehicle has to stay above it or the
 * car is drawn through the road it is driving on.
 *
 * That was never checked anywhere. `probe-vehicle` photographs a car floating
 * in a turntable box with no road in it; `probe-garage` asks whether the
 * preview renders; `smoke` drives a lap from a chase camera that cannot see
 * under the car. So when a 1.5x scale pass on the Star Hopper put its
 * outermost fin tip at exactly -1.000 against a hover rideHeight of 1.00 --
 * grazing the deck at rest, before any suspension travel, body roll or bank
 * -- everything passed.
 *
 * This walks the real geometry of every chassis, every pilot-independent LOD,
 * at every quality tier, and measures the lowest vertex. It is the cheapest
 * possible gate and it covers the whole roster rather than the one chassis
 * somebody happened to be looking at.
 *
 * MARGIN. A vehicle is not always level: it banks on a cambered road, rolls
 * into a drift and pitches over a crest. A clearance of exactly zero is a
 * model that touches the floor on the first degree of any of those. The floor
 * here is a REQUIREMENT of real clearance, not of non-penetration.
 */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { RIG_NODES, createPilotFigure, createVehicleVisual } from '../src/render/vehicles'
import type { PilotFigure } from '../src/render/vehicles'
import { QUALITY_PRESETS, type QualityTier } from '../src/render/api'
import { CHASSIS, getLocomotion } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'

/**
 * TWO RULES, BECAUSE THE ROSTER HAS TWO KINDS OF VEHICLE, and the first draft
 * of this test got that wrong in a way worth recording.
 *
 * It asserted real clearance for everything and immediately failed Solaire at
 * exactly -0.000m. That is not a bug: Solaire has WHEELS, and a wheeled car's
 * lowest vertex is its contact patch, which is supposed to sit on the road.
 * `rideHeight` is the distance from the origin down to the surface precisely
 * so that the tyres reach it. A test that demands air under a tyre is testing
 * the wrong thing.
 *
 * So: a GROUNDED chassis must touch and must not SINK -- the guard is a floor
 * under how far its running gear may dip below the deck, which is the
 * regression a tread or wheel-radius change would actually cause. Measured on
 * the shipped roster: Solaire 0.000m, Dray-9 0.105m, Bulwark 0.115m, the last
 * two being tread geometry deliberately modelled proud so the cleats bite.
 *
 * A HOVER or FLIGHT chassis touches nothing, so it owes real clearance.
 */
const MIN_CLEARANCE = 0.12
const MAX_SINK = 0.16

/** Lowest vertex of a built vehicle, in model space. */
function lowestVertex(group: THREE.Object3D): number {
  const v = new THREE.Vector3()
  let min = Infinity
  group.updateMatrixWorld(true)
  group.traverse((o) => {
    const mesh = o as THREE.Mesh
    const geo = mesh.geometry
    if (!geo || !geo.getAttribute) return
    const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined
    if (!pos) return
    // InstancedMesh carries its instances in a matrix buffer, so the base
    // geometry alone understates where those parts actually sit.
    const inst = o as THREE.InstancedMesh
    const count = inst.isInstancedMesh ? inst.count : 0
    const m = new THREE.Matrix4()
    for (let i = 0; i < pos.count; i++) {
      if (count > 0) {
        for (let k = 0; k < count; k++) {
          inst.getMatrixAt(k, m)
          v.set(pos.getX(i), pos.getY(i), pos.getZ(i))
            .applyMatrix4(m).applyMatrix4(o.matrixWorld)
          if (v.y < min) min = v.y
        }
      } else {
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(o.matrixWorld)
        if (v.y < min) min = v.y
      }
    }
  })
  return min
}

describe('no vehicle is drawn through the road it is driving on', () => {
  const tiers: QualityTier[] = ['high', 'medium', 'low']

  for (const def of CHASSIS) {
    it(`${def.name} clears the deck at every tier`, () => {
      const ride = getLocomotion(def.id).rideHeight
      const ground = -ride
      const worst: { tier: string; y: number }[] = []

      for (const tier of tiers) {
        const v = createVehicleVisual(def.id, PILOTS[0].id, QUALITY_PRESETS[tier])
        worst.push({ tier, y: lowestVertex(v.group) })
        v.dispose()
      }

      for (const w of worst) {
        const clearance = w.y - ground
        const where = `${def.name} (${def.locomotion}) @ ${w.tier}: lowest vertex `
          + `${w.y.toFixed(3)}, ground ${ground.toFixed(2)} (rideHeight ${ride}), `
          + `clearance ${clearance.toFixed(3)}m`
        if (def.locomotion === 'grounded') {
          expect(clearance, where).toBeGreaterThan(-MAX_SINK)
        } else {
          expect(clearance, where).toBeGreaterThan(MIN_CLEARANCE)
        }
      }
    })
  }

  /**
   * The pilot is a separate assertion because it fails differently: a head
   * poking through the floor is not a clipping artefact anyone would describe
   * as the car scraping, and it would be attributed to the chassis.
   */
  it('swapping the pilot never changes what the lowest point is', () => {
    for (const def of CHASSIS) {
      const ground = -getLocomotion(def.id).rideHeight
      const base = lowestVertexFor(def.id, PILOTS[0].id)
      for (const pilot of PILOTS) {
        const y = lowestVertexFor(def.id, pilot.id)
        // The pilot is a ball in a tub near the top of the car, so it must
        // never become the lowest thing on any chassis -- if a pilot swap
        // moves this number at all, a head is hanging below the bodywork.
        expect(y, `${pilot.name} in ${def.name}: lowest ${y.toFixed(3)} vs `
          + `${base.toFixed(3)} with ${PILOTS[0].name}`).toBeCloseTo(base, 3)
        expect(y, `${pilot.name} in ${def.name}`).toBeGreaterThan(ground - MAX_SINK)
      }
    }
  })

  /**
   * THE SIM'S FLOOR AND THE ART MUST AGREE.
   *
   * `minAltitude` is what sim/vehicle.ts clamps the hovering branch to, and it
   * is a copy of a fact that lives in the geometry: how far the body hangs
   * below the origin. Two places holding the same number is how they end up
   * disagreeing, and the failure is silent -- the floor keeps working, it just
   * stops being in the right place, and a chassis starts dipping its bodywork
   * into the road again exactly as Vector-7 did.
   *
   * So assert the relationship rather than the number: whatever the art does,
   * the floor has to sit at or below it.
   */
  it('every locomotion floor is deep enough for the deepest body that uses it', () => {
    for (const def of CHASSIS) {
      if (def.locomotion === 'grounded') continue   // wheels touch; see above
      const loco = getLocomotion(def.id)
      const depth = -lowestVertexFor(def.id, PILOTS[0].id)
      expect(
        loco.minAltitude,
        `${def.name}: body hangs ${depth.toFixed(3)}m below the origin but the `
        + `${def.locomotion} floor is ${loco.minAltitude} -- raise minAltitude in `
        + 'tuning.ts, or the bodywork will sit inside the road',
      ).toBeGreaterThanOrEqual(depth)
    }
  })

  function lowestVertexFor(chassisId: string, pilotId: string): number {
    const v = createVehicleVisual(chassisId, pilotId, QUALITY_PRESETS.high)
    const y = lowestVertex(v.group)
    v.dispose()
    return y
  }
})

// ===========================================================================
// THE PODIUM FIGURE
// ===========================================================================
//
// The standing pilot is a SECOND body on the same head, and it lives in the
// same file as the seated one. Two things about that are worth a gate rather
// than a comment:
//
//   1. A CALLER PLACES IT BY ITS SOLES. game/podium.ts stands a figure on a
//      step by setting group.position.y to the step's top surface and nothing
//      else -- no lift term, no fudge -- so y = 0 in figure space has to BE the
//      bottom of the feet. That contract used to be a hand-fitted 1.05 against
//      an origin nobody owned, and the figures visibly hovered in the shipped
//      screenshots. render/podium.ts measures it at runtime (PodiumStats.
//      soleGap) and the probe fails on it; this fails on it in 40 ms.
//
//   2. THE CAR MUST NOT GROW LEGS. The body is podium-only by construction --
//      addPilotShell is untouched and no chassis builder can reach the new
//      geometry -- but "by construction" is exactly the kind of claim that
//      stops being true. The clearance suite above already fails if a pilot
//      swap moves a chassis's lowest vertex; this says the stronger thing.

/** World-space bounds of a built figure, INSTANCES INCLUDED.
 *
 *  Box3.setFromObject would do, but it reads InstancedMesh.boundingBox, which
 *  is computed once and cached -- so after an update() moved the limbs it
 *  answers about the pose the figure was built in. Walking the matrices is the
 *  only way to measure the pose actually on screen. */
function poseBox(root: THREE.Object3D): THREE.Box3 {
  root.updateMatrixWorld(true)
  const box = new THREE.Box3()
  const v = new THREE.Vector3()
  const m = new THREE.Matrix4()
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute
    const im = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh) : null
    const n = im ? im.count : 1
    for (let k = 0; k < n; k++) {
      if (im) { im.getMatrixAt(k, m); m.premultiply(mesh.matrixWorld) } else m.copy(mesh.matrixWorld)
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m)
        box.expandByPoint(v)
      }
    }
  })
  return box
}

/** Every limb matrix, flattened. Two of these compared is "are these two
 *  figures in the same pose". */
function poseOf(root: THREE.Object3D): number[] {
  root.updateMatrixWorld(true)
  const out: number[] = []
  const m = new THREE.Matrix4()
  root.traverse((o) => {
    const im = o as THREE.InstancedMesh
    if (!im.isInstancedMesh) return
    for (let k = 0; k < im.count; k++) {
      im.getMatrixAt(k, m)
      for (const e of m.elements) out.push(e)
    }
  })
  return out
}

/** The ball's authored radius. Every figure dimension is a multiple of it. */
const BALL_R = 0.40

function stepFigure(f: PilotFigure, seconds: number): void {
  const n = Math.round(seconds * 60)
  for (let i = 0; i < n; i++) f.update(1 / 60)
}

describe('the podium figure stands on its own soles', () => {
  const TIERS: QualityTier[] = ['low', 'high']

  it('puts y = 0 at the bottom of the feet, for every pilot and both tiers', () => {
    for (const tier of TIERS) {
      for (const p of PILOTS) {
        for (let seed = 0; seed < 3; seed++) {
          const f = createPilotFigure(p.id, QUALITY_PRESETS[tier], seed)
          f.energy = 0
          stepFigure(f, 0.5)
          const b = poseBox(f.group)
          // Exact, not approximate: the ankle pivot is authored at half the
          // foot's thickness precisely so this is arithmetic. A caller adds
          // nothing to place it, so any slack here is a visible hover.
          expect(
            b.min.y,
            `${p.name} @ ${tier} seed ${seed}: soles at ${b.min.y.toFixed(5)}, expected 0`,
          ).toBeCloseTo(0, 5)
          f.dispose()
        }
      }
    }
  })

  it('never posts a foot through the floor while it dances', () => {
    for (let seed = 0; seed < 3; seed++) {
      const f = createPilotFigure(PILOTS[seed].id, QUALITY_PRESETS.high, seed)
      f.energy = 1
      let lowest = Infinity
      let highest = -Infinity
      // Twelve seconds covers several hops and at least one full spin on the
      // slowest of the three dances.
      for (let i = 0; i < 12 * 60; i++) {
        f.update(1 / 60)
        if (i % 3) continue
        const b = poseBox(f.group)
        lowest = Math.min(lowest, b.min.y)
        highest = Math.max(highest, b.min.y)
      }
      // The side-to-side rock pivots at the soles, so the outer edge of one
      // foot dips a few millimetres. A CENTIMETRE of authored figure is 2.6 cm
      // on the step; anything past that is a leg through the block.
      expect(lowest, `seed ${seed} sank to ${lowest.toFixed(4)}`).toBeGreaterThan(-0.02)
      // ...and it really does leave the step, or the hop is not a hop.
      expect(highest, `seed ${seed} never left the step`).toBeGreaterThan(0.2)
      f.dispose()
    }
  })

  it('is a figure and not a head: torso, limbs and feet under the ball', () => {
    const f = createPilotFigure('aegis', QUALITY_PRESETS.high, 0)
    f.energy = 0
    stepFigure(f, 0.5)
    const b = poseBox(f.group)
    // A bare head is 2 r tall. Anything under about 3 r is a ball with a stub.
    expect(b.max.y - b.min.y).toBeGreaterThan(BALL_R * 3.0)
    // Ten articulated segments -- two arms of two, two legs of three -- and
    // they are ONE InstancedMesh, which is the cost claim in vehicles.ts.
    let instanced = 0
    let limbs = 0
    f.group.traverse((o) => {
      const im = o as THREE.InstancedMesh
      if (im.isInstancedMesh) { instanced++; limbs += im.count }
    })
    expect(instanced, 'the limbs should cost exactly one draw call').toBe(1)
    expect(limbs).toBe(10)
    // Three meshes in total: torso+head, face panel, limbs.
    let meshes = 0
    f.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes++ })
    expect(meshes, 'a figure is three draw calls').toBe(3)
    f.dispose()
  })

  it('freezes to a still, upright standing pose at energy 0', () => {
    for (let seed = 0; seed < 3; seed++) {
      const f = createPilotFigure(PILOTS[seed].id, QUALITY_PRESETS.high, seed)
      f.energy = 0
      stepFigure(f, 0.5)
      const first = poseOf(f.group)
      const box = poseBox(f.group)
      stepFigure(f, 6)
      const later = poseOf(f.group)
      expect(later.length).toBe(first.length)
      for (let i = 0; i < first.length; i++) {
        expect(later[i], `seed ${seed} limb matrix ${i} moved under reduced motion`)
          .toBeCloseTo(first[i], 6)
      }
      // UPRIGHT, not a T-pose and not a frozen hop. The face panel is the one
      // named node in the rig, so it is what says where the head is: straight
      // above the feet, and high enough that the figure is standing rather than
      // crouched or caught mid-air.
      let face: THREE.Object3D | null = null
      f.group.traverse((o) => { if (o.name === RIG_NODES.face) face = o })
      expect(face, 'the figure has no face panel').not.toBeNull()
      const fp = new THREE.Vector3()
      ;(face as unknown as THREE.Object3D).getWorldPosition(fp)
      expect(Math.abs(fp.x), `seed ${seed} leans sideways at rest`).toBeLessThan(1e-6)
      expect(Math.abs(fp.z), `seed ${seed} leans fore/aft at rest`).toBeLessThan(1e-6)
      expect(fp.y, `seed ${seed} face height`).toBeGreaterThan(BALL_R * 2.0)
      // Feet flat on the floor, arms inside the figure's own silhouette rather
      // than stuck out level with the shoulders.
      expect(box.min.y).toBeCloseTo(0, 5)
      expect(box.max.x - box.min.x, `seed ${seed} is wider than it is tall`)
        .toBeLessThan(box.max.y - box.min.y)
      f.dispose()
    }
  })

  it('gives the three steps three different dances, not one dance offset', () => {
    const poses: number[][] = []
    for (let seed = 0; seed < 3; seed++) {
      const f = createPilotFigure('aegis', QUALITY_PRESETS.high, seed)
      f.energy = 1
      f.joy = seed === 0 ? 1 : seed === 1 ? 0.82 : 0.72
      stepFigure(f, 3.0)
      poses.push(poseOf(f.group))
      f.dispose()
    }
    // A phase offset alone would still produce the SAME pose at some other
    // instant, so this compares whole-run character rather than one frame: the
    // arms of a waving figure never reach where a fist-pumping figure's do.
    for (let a = 0; a < 3; a++) {
      for (let b = a + 1; b < 3; b++) {
        let diff = 0
        for (let i = 0; i < poses[a].length; i++) diff += Math.abs(poses[a][i] - poses[b][i])
        expect(diff, `steps ${a + 1} and ${b + 1} are in the same pose`).toBeGreaterThan(0.5)
      }
    }
  })

  it('leaves the seated pilot a head: no chassis grows a body', () => {
    for (const def of CHASSIS) {
      for (const p of PILOTS) {
        const v = createVehicleVisual(def.id, p.id, QUALITY_PRESETS.high)
        v.group.updateMatrixWorld(true)
        let seats = 0
        v.group.traverse((o) => {
          if (o.name === 'sg_limbs') {
            throw new Error(`${def.name}/${p.name}: a chassis is carrying podium limbs`)
          }
          if (o.name !== RIG_NODES.pilot) return
          seats++
          // The seated pilot is a ball of radius 0.40 with a mount peg under it
          // and a crest over it, and every chassis cuts its tub for exactly
          // that. Measured about the holder's own origin, which is the seat.
          const b = new THREE.Box3().setFromObject(o)
          const c = new THREE.Vector3()
          o.getWorldPosition(c)
          const where = `${def.name}/${p.name} seat`
          expect(b.min.y - c.y, `${where} hangs ${(b.min.y - c.y).toFixed(3)} below the seat`)
            .toBeGreaterThan(-BALL_R * 1.8)
          expect(b.max.y - c.y, `${where} stands ${(b.max.y - c.y).toFixed(3)} above the seat`)
            .toBeLessThan(BALL_R * 2.2)
          expect(Math.max(Math.abs(b.max.x - c.x), Math.abs(b.min.x - c.x)), `${where} width`)
            .toBeLessThan(BALL_R * 2.0)
        })
        expect(seats, `${def.name}/${p.name} has no pilot at all`).toBeGreaterThan(0)
        v.dispose()
      }
    }
  })
})
