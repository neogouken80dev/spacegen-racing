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
import { createVehicleVisual } from '../src/render/vehicles'
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
