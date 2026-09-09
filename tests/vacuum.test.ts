import { describe, it, expect } from 'vitest'
import { Track, type TrackDef, type TrackNode } from '../src/sim/track'
import { RUSTFALL, CRYOSTATIC, AETHERION, HOLLOWCHOIR } from '../src/content/tracks'
import {
  stepVehicle, lateralBudget, cornerSpeedAt,
  vacuumGripMult, vacuumTopSpeedMult, type VehicleContext,
} from '../src/sim/vehicle'
import { resetAI } from '../src/sim/ai'
import { Race } from '../src/sim/race'
import { getDerived, getLocomotion, CHASSIS } from '../src/content/chassis'
import { TUNING as T } from '../src/content/tuning'
import { emptyInput } from '../src/sim/types'
import type { RacerState, InputFrame, SimConfig } from '../src/sim/types'

/**
 * HARD VACUUM.
 *
 * The Hollow Choir's hull is torn open along the Breach, and `TrackNode.vacuum`
 * is what that means to the sim. What has to be true of it:
 *
 *  1. IT IS A ROAD PROPERTY AND NOTHING ELSE. No racer, no RNG, not even race
 *     time -- so two clients stepping the same race agree by construction, the
 *     same standard Cryostatic's fragile shelf and Aetherion's phasing spans
 *     are held to, cleared more easily than either.
 *
 *  2. EVERYTHING IT DOES IS "THERE IS NO MEDIUM", APPLIED CONSISTENTLY. Top
 *     speed climbs, because the air is not resisting any more; the lateral
 *     friction budget collapses, because the medium a chassis pushes against to
 *     change direction is gone; and the flight class cannot Lift, because
 *     aerodynamic lift needs air exactly as much as a hovercraft's cushion
 *     does. A straight-line gift that charges anyone who needs to turn in it,
 *     and charges the one class that would otherwise only gain.
 *
 *  3. IT HONOURS THE CLASS CONTRACT: hover worst, grounded middle, flight best.
 *     Hover is riding on the medium that has gone; grounded keeps its mass and
 *     its contact patch; flight is least dependent on either.
 *
 *  4. THE AI KNOWS. `lateralBudget` and `vacuumGripMult` are exported so that
 *     stepAI's corner model is THE SAME ARITHMETIC the physics runs, not a
 *     second guess at it. An AI blind to the vacuum arrives at the Fall's
 *     turn-in above a limit that really has moved.
 *
 *  5. THE THREE SHIPPED CIRCUITS DID NOT MOVE. Rustfall, Cryostatic and
 *     Aetherion are balanced, gated and shipped, and every line of this
 *     mechanic is written so that a track authoring no `vacuum` cannot reach it.
 *
 * EVERY ASSERTION HERE FAILS AGAINST THE OLD BEHAVIOUR, which for a brand-new
 * field means: against a sim in which the field is present but never read. The
 * `previousBehaviour` helpers below are that sim, written out, so "this test
 * would have passed before" is checkable rather than asserted.
 */

const DT = T.sim.dt

/** The sim as it was before the vacuum: the budget and the ceiling, unscaled. */
const previousBudget = (cid: string) => lateralBudget(getDerived(cid), getLocomotion(cid), 1)
const previousTop = (cid: string) => getDerived(cid).topSpeed

function spawn(track: Track, chassisId: string, s: number, speed: number, lat = 0): RacerState {
  const loco = getLocomotion(chassisId)
  const smp = track.at(s)
  const p = track.surfacePoint(s, lat)
  return {
    id: 0, chassisId, pilotId: 'pip', isAI: false, isLocal: false, aiSkill: 4,
    pos: {
      x: p.x + smp.normal.x * loco.rideHeight,
      y: p.y + smp.normal.y * loco.rideHeight,
      z: p.z + smp.normal.z * loco.rideHeight,
    },
    vel: { x: smp.tangent.x * speed, y: smp.tangent.y * speed, z: smp.tangent.z * speed },
    yaw: track.yawAt(s), yawRate: 0, altitude: loco.rideHeight, vertVel: 0, grounded: true, wallTime: 0,
    fwd: { x: smp.tangent.x, y: smp.tangent.y, z: smp.tangent.z },
    up: { x: smp.normal.x, y: smp.normal.y, z: smp.normal.z },
    driftSide: 0, driftCharge: 0, driftTier: -1, driftInward: 1, driftEntry: false, driftTime: 0,
    chainStacks: 0, chainWindow: 0, boostTime: 0, boostMag: 0, boostSource: 'none',
    lift: loco.liftCapacity, liftActive: false, airTime: 0, trickArmed: false,
    rampCooldown: 0, ballisticTime: 0,
    item: null, itemCharges: 0, itemSlot2: null, rouletteTime: 0,
    gatlingTime: 0, gatlingCooldown: 0, beamCharge: 0, beamGrace: 0,
    spinTime: 0, stunTime: 0, immuneTime: 0, invincibleTime: 0,
    slowTime: 0, slowMag: 0, massMult: 1,
    lap: 0, checkpoint: 0, splineS: s, totalS: 0, lateral: lat, position: 1,
    finished: false, finishTime: 0, lapTimes: [], bestLap: 0, charges: 0,
    offTrackTime: 0, respawnTime: 0, respawnPlaced: false, lastHitBy: null, events: [],
  } as RacerState
}

const drive = (): InputFrame => ({ ...emptyInput(), throttle: 1 })

/**
 * A closed ring with the vacuum authored over half of it.
 *
 * R=400 reads as straight to every chassis in and out of vacuum, which is what
 * the speed and scrub tests want. R=220 is the interesting radius and it is a
 * measured choice, not a round number: in air it prices at 78.6 m/s for a
 * Filament, which is over its 61.4 top speed, so nobody brakes; at full vacuum
 * the same corner prices at 57.2 against a raised ceiling of 70.4, so everybody
 * does. It is a corner that EXISTS ONLY BECAUSE THE AIR IS GONE, which is the
 * whole mechanic in one geometry.
 */
function strip(vac: number, R = 400): TrackDef {
  const nodes: TrackNode[] = []
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2
    nodes.push({
      p: [R * Math.sin(a), 10, R * Math.cos(a)],
      w: 20,
      surface: 'tarmac',
      // Vacuum over half the ring, ramping like wind does.
      vacuum: i >= 6 && i <= 17 ? vac : 0,
    })
  }
  return {
    id: 'test-vac', name: 'vac strip',
    skyTop: 0, skyBottom: 0, fogColor: 0, fogDensity: 0.001,
    sunColor: 0xffffff, sunIntensity: 1, ambientColor: 0, ambientIntensity: 1,
    sunDirection: [0, 1, 0], palette: { a: 0, b: 0, c: 0, accent: 0 },
    nodes, itemBoxRows: [], chargeRuns: [], laps: 1,
  }
}

// ---------------------------------------------------------------------------
describe('the vacuum is a property of the road and of nothing else', () => {
  it('is a pure function of the sample, with no racer, RNG or race time in it', () => {
    const track = new Track(HOLLOWCHOIR)
    // Mid-Breach: the field is actually on here, so this discriminates rather
    // than passing on a lap of zeroes.
    const s = 1200
    expect(track.at(s).vacuum).toBeGreaterThan(0.9)
    expect(track.at(s).vacuum).toBe(track.at(s).vacuum)
    // And identical across two independently baked copies of the same def.
    const twin = new Track(HOLLOWCHOIR)
    for (let i = 0; i < track.samples.length; i += 37) {
      expect(twin.samples[i].vacuum).toBe(track.samples[i].vacuum)
    }
  })

  it('interpolates between nodes rather than switching on at a sample boundary', () => {
    const track = new Track(strip(1))
    const vals: number[] = []
    for (let i = 0; i < track.samples.length; i++) vals.push(track.samples[i].vacuum)
    const partial = vals.filter((v) => v > 0.001 && v < 0.999).length
    // A step function would have zero samples strictly between 0 and 1. `wind`
    // ramps for the same reason and this term is a multiplier on the lateral
    // budget, so a step in it is a step in how hard the car can corner.
    expect(partial).toBeGreaterThan(20)
    expect(Math.max(...vals)).toBeCloseTo(1, 5)
    expect(Math.min(...vals)).toBe(0)
  })

  it('clamps to 0..1 however the designer authors it', () => {
    const track = new Track(strip(3.5))
    const vals = track.samples.map((s) => s.vacuum)
    // Clamped to exactly 1 rather than merely bounded by it: `<= 1` would also
    // be satisfied by a field that is zero everywhere.
    expect(Math.max(...vals)).toBe(1)
    expect(Math.min(...vals)).toBe(0)
    const neg = new Track(strip(-2))
    expect(Math.max(...neg.samples.map((s) => s.vacuum))).toBe(0)
  })
})

// ---------------------------------------------------------------------------
describe('the vacuum does three things, and all three are "there is no medium"', () => {
  it('raises top speed by removing the drag T.sim.airDrag says the air was costing', () => {
    // 1/sqrt(1 - f): thrust balances drag at terminal velocity and drag goes as
    // v^2, so removing a fraction f of it multiplies the terminal speed by this.
    const want = 1 / Math.sqrt(1 - T.vacuum.dragRemoved * T.sim.airDrag)
    expect(vacuumTopSpeedMult(1)).toBeCloseTo(want, 9)
    expect(vacuumTopSpeedMult(1)).toBeGreaterThan(1.05)
    // FAILS AGAINST THE OLD BEHAVIOUR: before this, top speed in vacuum was
    // derived.topSpeed and nothing else.
    for (const c of CHASSIS) {
      expect(previousTop(c.id) * vacuumTopSpeedMult(1)).toBeGreaterThan(previousTop(c.id) + 2)
    }
  })

  it('collapses the lateral budget for every class', () => {
    for (const c of CHASSIS) {
      const lo = getLocomotion(c.id)
      const inVac = previousBudget(c.id) * vacuumGripMult(1, lo)
      // FAILS AGAINST THE OLD BEHAVIOUR: the budget used to be the same number
      // in vacuum as on the road.
      expect(inVac).toBeLessThan(previousBudget(c.id) * 0.8)
      expect(inVac).toBeGreaterThan(0)
    }
  })

  it('actually moves a car: the tyres scrub off less slip in vacuum', () => {
    // The budget is the CAP on `pull` in stepVehicle's lateral block, so the
    // direct physical reading of it is how fast a car kills sideways velocity.
    // Same ring, same chassis, same 12 m/s of slip: the only difference in the
    // two runs is the authored field.
    const remaining = (vac: number): number => {
      const track = new Track(strip(vac))
      const s = track.length * 0.5
      const smp = track.at(s)
      const r = spawn(track, 'filament', s, 50)
      r.vel.x += smp.right.x * 12; r.vel.z += smp.right.z * 12
      for (let f = 0; f < 24; f++) {
        const ctx: VehicleContext = { track, raceTime: f * DT, iceCracked: false }
        stepVehicle(r, { ...emptyInput(), throttle: 0.4 }, ctx)
      }
      const sm = track.at(r.splineS)
      return Math.abs(r.vel.x * sm.right.x + r.vel.y * sm.right.y + r.vel.z * sm.right.z)
    }
    // FAILS AGAINST THE OLD BEHAVIOUR: with the field unread these are the same
    // number to the last bit.
    expect(remaining(1)).toBeGreaterThan(remaining(0) * 1.15)
  })

  it('actually moves a car: it reaches a higher speed on the same road in vacuum', () => {
    const fastest = (vac: number): number => {
      const track = new Track(strip(vac))
      // Start well inside the authored band and stay inside it, so the two
      // runs cover the SAME metres and differ only in the field.
      const r = spawn(track, 'filament', track.length * 0.40, 55)
      let best = 0
      for (let f = 0; f < 60 * 8; f++) {
        const ctx: VehicleContext = { track, raceTime: f * DT, iceCracked: false }
        stepVehicle(r, drive(), ctx)
        best = Math.max(best, Math.hypot(r.vel.x, r.vel.y, r.vel.z))
      }
      return best
    }
    const gain = fastest(1) / fastest(0)
    // FAILS AGAINST THE OLD BEHAVIOUR: the ratio was exactly 1.
    expect(gain).toBeGreaterThan(1.05)
    // The controller drives ground speed toward the ceiling ASYMPTOTICALLY, so
    // eight seconds gets ~1.107 of the 1.147 on offer. The multiplier is a
    // ceiling and the car may approach it but never pass it.
    expect(gain).toBeLessThanOrEqual(vacuumTopSpeedMult(1) + 1e-9)
  })

  it('takes the flight class\'s Lift with the air', () => {
    // Same rule as hover's cushion: no medium, no aerodynamic anything. A
    // flight chassis in hard vacuum is a very fast brick with attitude control.
    const ceiling = (vac: number): number => {
      const track = new Track(strip(vac))
      const r = spawn(track, 'vector7', track.length * 0.45, 55)
      let top = 0
      for (let f = 0; f < 60 * 4; f++) {
        const ctx: VehicleContext = { track, raceTime: f * DT, iceCracked: false }
        stepVehicle(r, { ...drive(), lift: true }, ctx)
        top = Math.max(top, r.altitude)
      }
      return top
    }
    const lo = getLocomotion('vector7')
    // FAILS AGAINST THE OLD BEHAVIOUR: the lift ceiling used to be maxLift
    // wherever the car was.
    expect(ceiling(0)).toBeGreaterThan(lo.maxLift * 0.9)
    expect(ceiling(1)).toBeLessThan(lo.rideHeight + 0.4)
  })

  it('does not charge a flight chassis for the Lift it cannot use', () => {
    // Thrust into nothing is not spent. Charging for the attempt would be
    // punishing the same fact twice.
    const track = new Track(strip(1))
    const r = spawn(track, 'vector7', track.length * 0.45, 55)
    r.lift = 1.0
    for (let f = 0; f < 60; f++) {
      stepVehicle(r, { ...drive(), lift: true }, { track, raceTime: f * DT, iceCracked: false })
    }
    expect(r.liftActive).toBe(false)
    expect(r.lift).toBeGreaterThan(1.0)
  })

  // The only assertion in this file that PASSES against the old behaviour, and
  // deliberately: it is the regression guard on the gate, not on the mechanic.
  it('is a NO-OP at vacuum 0, exactly, in both directions', () => {
    expect(vacuumTopSpeedMult(0)).toBe(1)
    for (const c of CHASSIS) expect(vacuumGripMult(0, getLocomotion(c.id))).toBe(1)
    const d = getDerived('solaire'), lo = getLocomotion('solaire')
    // `x * 1` is exact in IEEE754, which is what lets the gate be a multiply
    // rather than a branch everywhere it appears.
    expect(lateralBudget(d, lo, 1) * vacuumGripMult(0, lo)).toBe(lateralBudget(d, lo, 1))
    expect(d.topSpeed * vacuumTopSpeedMult(0)).toBe(d.topSpeed)
  })
})

// ---------------------------------------------------------------------------
describe('the class contract: hover worst, grounded middle, flight best', () => {
  const loss = (id: string) => 1 - vacuumGripMult(1, getLocomotion(id))

  it('orders the three locomotion classes the way the GDD requires', () => {
    expect(loss('filament')).toBeGreaterThan(loss('solaire'))   // hover  > grounded
    expect(loss('solaire')).toBeGreaterThan(loss('vector7'))    // grounded > flight
    // Every grounded chassis is charged the same: this is a property of the
    // class, not of the roster.
    expect(loss('bulwark')).toBe(loss('solaire'))
    expect(loss('dray9')).toBe(loss('solaire'))
  })

  it('prices the same corner differently for the three classes, in that order', () => {
    // The Fall's turn-in: R=150, in full vacuum.
    const k = 1 / 150
    const v = (id: string) => cornerSpeedAt(
      lateralBudget(getDerived(id), getLocomotion(id), 1) * vacuumGripMult(1, getLocomotion(id)), k,
    ) * T.ai.corneringCaution
    expect(v('filament')).toBeLessThan(v('solaire'))
    expect(v('solaire')).toBeLessThan(v('vector7'))
    // ...and the spread stays small enough to be a contract rather than a
    // sentence. It was 14.7 m/s at the first cut (0.62/0.42/0.26), which put
    // Vector-7 at 46.5% of wins and Filament at 1.5% over 200 races.
    expect(v('vector7') - v('filament')).toBeLessThan(7)
  })

  it('leaves hover strictly worse than grounded on the same metres, which no other mechanic does', () => {
    // The standing caveat from the Aetherion pass: "hover is grounded plus a
    // field-force tax and minus nothing, so no section can punish hover without
    // punishing grounded at least as hard." The vacuum is the exception, and it
    // is the reason it was built this way round.
    const hover = getLocomotion('filament'), ground = getLocomotion('solaire')
    expect(hover.vacuumGripLoss).toBeGreaterThan(ground.vacuumGripLoss)
  })
})

// ---------------------------------------------------------------------------
describe('the AI reads the same arithmetic the physics does', () => {
  it('slows for a vacuum corner that it would take flat out in air', () => {
    // One ring, two defs, identical geometry: the ONLY difference is the field.
    const measure = (vac: number): number => {
      resetAI()
      const track = new Track(strip(vac, 220))
      const cfg: SimConfig = {
        seed: 99, totalLaps: 1, racerCount: 1, trackId: 'test-vac',
        chassisIds: ['filament'], pilotIds: [PILOT], localRacerIndex: -1, aiSkill: [4],
      }
      const race = new Race(track, cfg)
      const r = race.state.racers[0]
      let slowest = Infinity
      for (let f = 0; f < 60 * 40; f++) {
        race.step()
        // Sample the same ARC-LENGTH band in both runs. Gating on the field
        // itself is the obvious thing and it is a false positive: the air run
        // never enters the band, `slowest` stays Infinity, and the assertion
        // passes against a sim that does not read the field at all.
        const f01 = ((r.splineS / track.length) % 1 + 1) % 1
        if (f01 > 0.35 && f01 < 0.65) {
          slowest = Math.min(slowest, Math.hypot(r.vel.x, r.vel.z))
        }
      }
      return slowest
    }
    const inAir = measure(0)
    const inVac = measure(1)
    // FAILS AGAINST THE OLD BEHAVIOUR: with the AI blind to the field, both
    // runs are the same lap and this difference is zero.
    expect(inVac).toBeLessThan(inAir * 0.95)
  })
})
const PILOT = 'pip'

// ---------------------------------------------------------------------------
describe('the three shipped circuits cannot reach the mechanic', () => {
  it.each([['Rustfall', RUSTFALL], ['Cryostatic', CRYOSTATIC], ['Aetherion', AETHERION]] as const)(
    '%s authors no vacuum and reads exactly 0 on every sample',
    (_n, def: TrackDef) => {
      const track = new Track(def)
      expect(track.hasVacuum).toBe(false)
      for (const s of track.samples) expect(s.vacuum).toBe(0)
    },
  )

  it('The Hollow Choir is the only circuit that does author one', () => {
    const track = new Track(HOLLOWCHOIR)
    expect(track.hasVacuum).toBe(true)
    expect(Math.max(...track.samples.map((s) => s.vacuum))).toBeCloseTo(1, 3)
  })
})
