import { describe, it, expect } from 'vitest'
import {
  Track, bridgeSolid, bridgeSolidThrough, bridgePhaseFor, onDroppingHalf, type TrackDef,
} from '../src/sim/track'
import { AETHERION, RUSTFALL, CRYOSTATIC } from '../src/content/tracks'
import { stepVehicle, type VehicleContext } from '../src/sim/vehicle'
import { Race } from '../src/sim/race'
import { resetAI } from '../src/sim/ai'
import { getLocomotion } from '../src/content/chassis'
import { CHASSIS } from '../src/content/chassis'
import { PILOTS } from '../src/content/pilots'
import { TUNING as T } from '../src/content/tuning'
import { emptyInput } from '../src/sim/types'
import type { RacerState, InputFrame, SimConfig } from '../src/sim/types'

/**
 * PHASING LIGHT-BRIDGES.
 *
 * Aetherion's causeway carries three spans that cycle solid and absent on a
 * shared 3.2-second beat, EACH DROPPING ONE HALF OF ITS DECK. What has to be
 * true of them, and what this file pins:
 *
 *  0. THERE IS ALWAYS A LINE THROUGH. A span gives way on the half named by
 *     TrackNode.drops and never on the other one, so the causeway can always be
 *     driven clean -- the question it asks is which lane, not which second.
 *     This is the property the whole change exists for, and it is the one that
 *     separates a hazard a driver can learn from a coin flip they cannot: the
 *     old whole-span version fell the field 0.47-0.69 times a race on an event
 *     no rival earned.
 *
 *  1. THE EVENT IS SHARED. `bridgeSolid` takes a phase and a race time and
 *     nothing else -- no racer, no RNG, no accumulated state -- so every client
 *     stepping the same race time agrees by construction. That is the same
 *     property the fragile ice shelf buys by latching off the LEADER's lap, and
 *     it is the only version of a hazard that survives netcode.
 *
 *  2. THE HOLE IS WHERE IT WAS AUTHORED. A phasing span needs both of its ends
 *     to declare the same phase, unlike `open`/`bounce`/`fragile` which are OR'd
 *     across a segment and therefore bleed one segment either side. A hazard
 *     that bleeds onto its own approach is a different hazard.
 *
 *  3. AN ABSENT DECK SUPPORTS NOBODY, AND A PRESENT ONE SUPPORTS EVERYBODY.
 *     Grounded, hover and FLIGHT all fall through the half that is gone, at the
 *     same race time at which all three are held by the half that is not. The
 *     flight case is worth a test of its own: it was exempt for one balance
 *     pass, and removing the exemption took two goes because the flight
 *     altitude controller is an unsigned spring that will happily winch a car
 *     back up onto a road it has already fallen through.
 *
 *  3b. THE LATERAL GETS INTO THE FALL TEST THROUGH `Track.project()`, which is
 *     the one call in the sim that holds a point and the road it is over at the
 *     same time. It hands back a sample whose `bridge` is the span's beat on the
 *     half that drops and -1 on the half that stays, so `bridgeSolid` stays a
 *     two-argument pure function of (phase, time) and the netcode argument is
 *     untouched. If that resolution stops happening the mechanic silently
 *     reverts to whole-span, which is why it is pinned directly rather than
 *     only through a car falling.
 *
 *  4. THE FIELD TIMES IT AND LANES IT. The AI does not brake for a bridge --
 *     braking does not solve a hazard that is not in the way but in the way AT A
 *     TIME -- it picks a cruise speed that puts it on every span inside its
 *     horizon while that span is solid. On top of that it now COMMITS TO THE
 *     SURVIVING LANE on the approach and holds it, which is the only answer to a
 *     hazard that is not in the way at a time but in the way ON A SIDE. If
 *     either planner stops working the balance harness reads the section as
 *     difficulty when it is noise.
 *
 *  5. THE FLAT TRACKS DID NOT MOVE. Rustfall and Cryostatic are balanced,
 *     gated and shipped, and every line of this mechanic is written so that a
 *     track authoring no `phase` cannot reach it.
 */

const DT = T.sim.dt
const P = T.hazard.bridgePeriod
const DUTY = T.hazard.bridgeDuty

/** Race time at which a span of phase `ph` is `frac` of the way through its cycle. */
const timeAtPhase = (ph: number, frac: number): number => (((frac - ph) % 1 + 1) % 1) * P

function spawn(track: Track, chassisId: string, s: number, speed: number, lat = 0): RacerState {
  const loco = getLocomotion(chassisId)
  const smp = track.at(s)
  const p = track.surfacePoint(s, lat)
  return {
    id: 0, chassisId, pilotId: '', isAI: false, isLocal: false, aiSkill: 4,
    pos: {
      x: p.x + smp.normal.x * loco.rideHeight,
      y: p.y + smp.normal.y * loco.rideHeight,
      z: p.z + smp.normal.z * loco.rideHeight,
    },
    vel: { x: smp.tangent.x * speed, y: smp.tangent.y * speed, z: smp.tangent.z * speed },
    yaw: track.yawAt(s), yawRate: 0, altitude: loco.rideHeight, vertVel: 0, grounded: true, wallTime: 0, windPush: 0,
    fwd: { x: smp.tangent.x, y: smp.tangent.y, z: smp.tangent.z },
    up: { x: smp.normal.x, y: smp.normal.y, z: smp.normal.z },
    driftSide: 0, driftCharge: 0, driftTier: -1, driftInward: 1, driftEntry: false, driftTime: 0, driftGrace: 0, guardTime: 0, wardTime: 0,
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

const drive = (lift = false): InputFrame => ({ ...emptyInput(), throttle: 1, lift })

/**
 * Hold a racer on the middle of span `idx` from race time `t0` and report how
 * far it ends up below the deck, and whether it respawned.
 *
 * `lane` is which half to stand on: +1 the half that gives way, -1 the half that
 * stays. It is expressed relative to the span's own `side` rather than as a raw
 * lateral so a test reads as "on the half that drops" and keeps meaning that if
 * the causeway is ever re-authored the other way round.
 */
const LANE_OFFSET = 8 // metres from the seam: mid-lane on a 16m half.
function crossSpan(
  chassisId: string, idx: number, t0: number, seconds = 1.6, lift = false, lane = 1,
): { drop: number; respawned: boolean; grounded: boolean } {
  const track = new Track(AETHERION)
  const b = track.bridges[idx]
  const r = spawn(track, chassisId, (b.s0 + b.s1) / 2, 50, b.side * lane * LANE_OFFSET)
  let respawned = false
  let t = t0
  for (let f = 0; f < Math.round(seconds / DT); f++) {
    const ctx: VehicleContext = { track, raceTime: t, iceCracked: false }
    stepVehicle(r, drive(lift), ctx)
    if (r.respawnTime > 0) { respawned = true; break }
    t += DT
  }
  const proj = track.project(r.pos, r.splineS)
  return { drop: -proj.height, respawned, grounded: r.grounded }
}

// ---------------------------------------------------------------------------
describe('the phasing light-bridge is one event the whole field shares', () => {
  it('is a pure function of the authored phase and the race time', () => {
    // No racer, no RNG, no state: two clients on the same frame agree.
    for (let k = 0; k < 200; k++) {
      const t = k * 0.137
      expect(bridgeSolid(0.31, t)).toBe(bridgeSolid(0.31, t))
      // ...and it is periodic, so a replay from a seed reproduces every cycle.
      expect(bridgeSolid(0.31, t)).toBe(bridgeSolid(0.31, t + P * 7))
    }
  })

  it('is solid for exactly the authored duty fraction of every cycle', () => {
    let solid = 0
    const N = 20000
    for (let k = 0; k < N; k++) if (bridgeSolid(0.17, (k / N) * P * 13)) solid++
    expect(solid / N).toBeCloseTo(DUTY, 2)
  })

  it('a permanent deck (phase -1) is always solid, which is what makes every caller safe', () => {
    for (let k = 0; k < 50; k++) expect(bridgeSolid(-1, k * 0.41)).toBe(true)
    expect(bridgeSolidThrough(-1, 0, 1e6)).toBe(true)
  })

  it('answers the question a driver actually has: will it still be there on the way out', () => {
    // A crossing that STARTS inside the solid window but finishes outside it is
    // not a crossing. bridgeSolid alone says yes to that; bridgeSolidThrough
    // is the one the planner reads.
    const tLate = timeAtPhase(0, DUTY - 0.02)
    expect(bridgeSolid(0, tLate)).toBe(true)
    expect(bridgeSolidThrough(0, tLate, tLate + 0.5)).toBe(false)
    const tEarly = timeAtPhase(0, 0.02)
    expect(bridgeSolidThrough(0, tEarly, tEarly + 0.5)).toBe(true)
    // A crossing longer than the whole solid window can never be clean.
    expect(bridgeSolidThrough(0, tEarly, tEarly + P * DUTY + 0.01)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
describe('the bake puts the hole where it was authored', () => {
  const track = new Track(AETHERION)

  it('finds exactly the three authored spans, on the causeway straight', () => {
    expect(track.hasBridges).toBe(true)
    expect(track.bridges.length).toBe(3)
    for (const b of track.bridges) {
      expect(b.s1 - b.s0, 'span length').toBeGreaterThan(40)
      expect(b.s1 - b.s0, 'span length').toBeLessThan(60)
    }
    // Offsets on ONE shared beat, spaced so the absent window runs away down
    // the causeway at a speed the field can hold: this is the wave.
    const gap = track.bridges[1].s0 - track.bridges[0].s0
    const dphi = ((track.bridges[1].phase - track.bridges[0].phase) % 1 + 1) % 1
    const wave = gap / (dphi * P)
    expect(wave, 'wave speed').toBeGreaterThan(45)
    expect(wave, 'wave speed').toBeLessThan(60)
  })

  it('leaves the approach and the gaps between spans permanently solid', () => {
    // The AND semantics. With `open`-style OR'ing the flag would bleed one
    // segment either side of each span and the hazard would sit on its own
    // braking zone.
    const m = track.samples.length
    // Track.bridges reports HALF-OPEN intervals: a run of n samples starting at
    // s0 covers [s0, s0 + n*ds), so the sample sitting exactly on s1 is the
    // first solid one again.
    const onSpan = (s: number): boolean =>
      track.bridges.some((b) => s >= b.s0 - 0.01 && s < b.s1 - 0.01)
    let bridgeSamples = 0
    for (let i = 0; i < m; i++) {
      const s = (i / m) * track.length
      const isBridge = track.samples[i].bridge >= 0
      if (isBridge) bridgeSamples++
      expect(isBridge, `sample at s=${s.toFixed(0)}`).toBe(onSpan(s))
    }
    // Between span 1 and span 2 there is real ground to play the timing from.
    const gapMid = (track.bridges[0].s1 + track.bridges[1].s0) / 2
    expect(track.at(gapMid).bridge).toBe(-1)
    expect(bridgeSamples * (track.length / m)).toBeLessThan(170)
  })

  it('records which half each span gives way on, and leaves the other permanent', () => {
    for (const b of track.bridges) {
      expect(Math.abs(b.side), `span at ${b.s0.toFixed(0)}m names a half`).toBe(1)
      const smp = track.at((b.s0 + b.s1) / 2)
      expect(smp.bridgeSide).toBe(b.side)
      // Exactly one half phases. This is the shape of the whole mechanic: the
      // other half feeds -1 to bridgeSolid, which is the same permanent-deck
      // value every metre of Rustfall and Cryostatic feeds it.
      const dropping = bridgePhaseFor(smp, b.side * LANE_OFFSET)
      const surviving = bridgePhaseFor(smp, -b.side * LANE_OFFSET)
      expect(dropping, 'the half that drops carries the beat').toBe(b.phase)
      expect(surviving, 'the half that stays is permanent deck').toBe(-1)
    }
  })

  it('puts the seam on the centreline, as a hard edge and not a band', () => {
    const b = track.bridges[0]
    const smp = track.at((b.s0 + b.s1) / 2)
    // Everything from the centreline outward on the named side goes together;
    // there is no third state in the middle for a driver to have to learn.
    for (const d of [0.01, 0.5, 4, 8, 15.9]) {
      expect(onDroppingHalf(smp, b.side * d), `${d}m into the dropping half`).toBe(true)
      expect(onDroppingHalf(smp, -b.side * d), `${d}m into the surviving half`).toBe(false)
    }
  })

  it('resolves the deck under a POINT through project(), which is where the lateral gets in', () => {
    // proj.sample.bridge is not at(s).bridge, and the difference is the whole
    // half-span mechanic on the physics side: the fall test in vehicle.ts reads
    // the first and gets a half-aware answer without knowing halves exist.
    const b = track.bridges[0]
    const s = (b.s0 + b.s1) / 2
    expect(track.at(s).bridge, 'the sample carries the span beat').toBe(b.phase)
    const onDrop = track.project(
      { ...track.surfacePoint(s, b.side * LANE_OFFSET) }, s)
    const onSafe = track.project(
      { ...track.surfacePoint(s, -b.side * LANE_OFFSET) }, s)
    expect(onDrop.sample.bridge, 'projected onto the half that drops').toBe(b.phase)
    expect(onSafe.sample.bridge, 'projected onto the half that stays').toBe(-1)
    // ...and the twin is the same piece of road in every other respect, which
    // is what makes substituting it safe. It SHARES the real sample's vectors
    // by reference rather than copying them, so find its original by identity
    // and check the rest field by field. A twin that had copied the geometry
    // could drift out of step with it and put the art and the physics on
    // different roads.
    const twin = onSafe.sample
    const orig = track.samples.find((x) => x.pos === twin.pos)
    expect(orig, 'the twin shares its position vector with a real sample').toBeDefined()
    expect(twin.right).toBe(orig!.right)
    expect(twin.normal).toBe(orig!.normal)
    expect(twin.tangent).toBe(orig!.tangent)
    for (const k of ['width', 'bank', 'surface', 'boost', 'ramp', 'bounce',
      'open', 'fragile', 'wind', 'stick'] as const) {
      expect(twin[k], `twin.${k}`).toBe(orig![k])
    }
    // Only these two differ, and only in the direction that says "permanent".
    expect(orig!.bridge).toBe(b.phase)
    expect(twin.bridge).toBe(-1)
    expect(twin.bridgeSide).toBe(0)
  })

  it('refuses a span that names a beat but not a half', () => {
    // A half-authored hazard drops nothing and turns the section into
    // decoration, silently. Caught at bake time rather than at 52 m/s.
    const noSide: TrackDef = {
      ...AETHERION,
      id: 'no-side',
      nodes: AETHERION.nodes.map((n) => (n.phase === undefined ? n : { ...n, drops: undefined })),
    }
    expect(() => new Track(noSide)).toThrow(/authors a phase but no/)
  })

  it('rejects a lap that is entirely bridge', () => {
    const allBridge: TrackDef = {
      ...AETHERION,
      id: 'all-bridge',
      nodes: AETHERION.nodes.map((n) => ({ ...n, phase: 0.25, drops: 'left' as const })),
    }
    expect(() => new Track(allBridge)).toThrow(/entire lap is a phasing bridge/)
  })
})

// ---------------------------------------------------------------------------
describe('an absent deck supports nobody', () => {
  it('drops a grounded car through the span and respawns it', () => {
    const out = crossSpan('solaire', 0, timeAtPhase(0, 0.80))
    expect(out.grounded, 'wheels down over a hole').toBe(false)
    expect(out.respawned, 'fell and was recovered').toBe(true)
  })

  // THE TEST THE WHOLE CHANGE IS ABOUT. Same car, same span, same race time,
  // same everything except which side of the centreline it is standing on.
  // Under whole-span phasing both of these fell.
  it('holds the same car, at the same instant, on the half that does not give way', () => {
    const t = timeAtPhase(0, 0.80)
    const doomed = crossSpan('solaire', 0, t, 1.6, false, 1)
    const safe = crossSpan('solaire', 0, t, 1.6, false, -1)
    expect(doomed.respawned, 'the half that drops').toBe(true)
    expect(safe.respawned, 'the half that stays, same instant').toBe(false)
    expect(safe.grounded, 'wheels down on the surviving lane').toBe(true)
    expect(safe.drop, 'did not sink').toBeLessThan(1)
  })

  it('leaves a line through at every point of every cycle, on every span', () => {
    // The invariant the mechanic rests on: whatever the beat is doing, some
    // part of the road is there. A span whose two halves could both be absent
    // is the old hazard with extra steps.
    const track = new Track(AETHERION)
    for (const b of track.bridges) {
      const smp = track.at((b.s0 + b.s1) / 2)
      for (let k = 0; k < 400; k++) {
        const t = (k / 400) * P * 3
        const left = bridgeSolid(bridgePhaseFor(smp, -LANE_OFFSET), t)
        const right = bridgeSolid(bridgePhaseFor(smp, LANE_OFFSET), t)
        expect(left || right, `span at t=${t.toFixed(2)} has no line through`).toBe(true)
      }
    }
  })

  it('holds the same car on the same span while the deck is there', () => {
    // Half a second only: at 50 m/s a longer window carries the car off this
    // span and onto the NEXT one, which is a third of a beat out of phase with
    // it and will very often not be there. That is the wave doing its job, and
    // it is measured in the AI test below rather than confused with this one.
    const out = crossSpan('solaire', 0, timeAtPhase(0, 0.02), 0.5)
    expect(out.respawned).toBe(false)
    expect(out.grounded, 'wheels down').toBe(true)
    expect(out.drop, 'stayed on the deck').toBeLessThan(1)
  })

  it('holds every class on the surviving half at the instant it drops the other', () => {
    // The exemption argument in vehicle.ts is about the deck supporting nobody
    // when it is not there. Its mirror has to hold too, for every locomotion
    // class: where the deck IS there, it supports everybody, and a half that
    // never phases is deck.
    const t = timeAtPhase(0, 0.80)
    for (const id of ['solaire', 'filament', 'bulwark', 'dray9', 'vector7']) {
      expect(crossSpan(id, 0, t, 1.6, false, 1).respawned, `${id} on the dropping half`).toBe(true)
      expect(crossSpan(id, 0, t, 1.6, false, -1).respawned, `${id} on the surviving half`).toBe(false)
    }
  })

  it('drops the FLIGHT class too, Lift or no Lift', () => {
    // This is the case that took two attempts. Blocking the hover branch only
    // while the deck was out let a flight chassis fall and then get winched
    // back up by its own altitude spring the moment the deck cycled in again --
    // the spring is unsigned, so twelve metres below the road reads to it
    // exactly like twelve metres above. Measured over 300 races, the version
    // that looked fixed and was not gave Vector-7 33.7% of wins against a
    // 12-30% band, on 0.28 respawns a race against the field's 0.69-0.91.
    const noLift = crossSpan('vector7', 0, timeAtPhase(0, 0.80))
    expect(noLift.respawned, 'flight, no lift').toBe(true)
    const lifting = crossSpan('vector7', 0, timeAtPhase(0, 0.80), 1.6, true)
    expect(lifting.respawned, 'flight, holding Lift').toBe(true)
  })

  it('drops the hover class, which has no Lift to hold with', () => {
    expect(crossSpan('filament', 0, timeAtPhase(0, 0.80)).respawned).toBe(true)
  })

  it('commits the fall inside the span rather than letting it drift out the far end', () => {
    // T.hazard.voidFallDepth exists because the generic 45m fall test is 1.63s
    // of falling, during which a car doing 50 m/s covers 82m -- further than a
    // span is long, so it would arrive under the SOLID road past the far end
    // and be snapped back onto it.
    const track = new Track(AETHERION)
    const b = track.bridges[0]
    const r = spawn(track, 'solaire', b.s0 + 4, 50, b.side * LANE_OFFSET)
    let t = timeAtPhase(0, 0.78)
    let frames = 0
    for (; frames < 240; frames++) {
      stepVehicle(r, drive(), { track, raceTime: t, iceCracked: false })
      if (r.respawnTime > 0) break
      t += DT
    }
    expect(frames * DT, 'seconds from losing the deck to respawn').toBeLessThan(1.4)
  })
})

// ---------------------------------------------------------------------------
describe('the field times the causeway rather than surviving it', () => {
  const cfg = (seed: number, n = 8): SimConfig => ({
    seed, totalLaps: 3, racerCount: n, trackId: AETHERION.id,
    chassisIds: Array.from({ length: n }, (_, i) => CHASSIS[(i + seed) % CHASSIS.length].id),
    pilotIds: Array.from({ length: n }, (_, i) => PILOTS[i % PILOTS.length].id),
    localRacerIndex: -1,
    aiSkill: Array.from({ length: n }, (_, i) => 2 + (i % 3)),
  })

  /**
   * TWENTY-FOUR RACES, NOT SIX, AND THE ASSERTION BELOW IS WHY.
   *
   * The teeth check at the bottom is a floor on a RARE event: wrong-lane
   * exposure runs at roughly seven frames per thousand span frames. Over six
   * fixed seeds that is a few hundred frames generated by two or three cars
   * getting unlucky in particular corners -- and any sim change at all
   * reshuffles which cars those are. Shrinking one chassis's collision box
   * took the count from 338 to exactly 0 and the test called the hazard dead.
   * It was not: the same build at 24 races produces 680 frames across three
   * chassis. Six races could not tell "the crosswind stopped working" from
   * "these six races missed it", which is the only question this assertion
   * exists to answer.
   *
   * 24 is the figure the comment on that assertion was already quoting its
   * fall rates from, so the measurement and the sample now agree. It costs
   * about twelve seconds.
   */
  const RACES = 24

  it('crosses the spans near the authored wave speed, in the surviving lane', () => {
    const track = new Track(AETHERION)
    const spanOf = (s: number): number =>
      track.bridges.findIndex((b) => s >= b.s0 && s <= b.s1)
    let crossings = 0, falls = 0, speedSum = 0
    let onSpanFrames = 0, wrongHalfFrames = 0, laneSum = 0
    const wasOn = new Array(8).fill(-1)
    const wasResp = new Array(8).fill(false)
    for (let race = 0; race < RACES; race++) {
      resetAI()
      const r = new Race(track, cfg(race + 1))
      const idle = emptyInput()
      for (let f = 0; f < 60 * 400 && r.state.phase !== 'finished'; f++) {
        for (const x of r.state.racers) if (!x.isAI) r.setInput(x.id, idle)
        r.step()
        for (const x of r.state.racers) {
          if (x.finished) continue
          const idx = spanOf(x.splineS)
          if (idx >= 0 && wasOn[x.id] < 0 && x.respawnTime <= 0) {
            crossings++
            speedSum += Math.hypot(x.vel.x, x.vel.y, x.vel.z)
          }
          if (idx >= 0 && x.respawnTime <= 0) {
            const smp = track.at(x.splineS)
            onSpanFrames++
            // Signed so that POSITIVE is into the surviving half whichever half
            // the causeway is authored to drop.
            laneSum += -smp.bridgeSide * x.lateral
            if (onDroppingHalf(smp, x.lateral)) wrongHalfFrames++
          }
          if (x.respawnTime > 0 && !wasResp[x.id] && idx >= 0) falls++
          wasResp[x.id] = x.respawnTime > 0
          wasOn[x.id] = idx
        }
      }
    }
    expect(crossings, 'span crossings observed').toBeGreaterThan(300 * (RACES / 6))
    const mean = speedSum / crossings
    const gap = track.bridges[1].s0 - track.bridges[0].s0
    const dphi = ((track.bridges[1].phase - track.bridges[0].phase) % 1 + 1) % 1
    const wave = gap / (dphi * P)
    // The planner still solves for a cruise speed, so the field should arrive AT
    // the wave rather than at whatever the corner before happened to allow. The
    // lane planner did NOT replace the timing one: the wave is the causeway's
    // tempo and half-span phasing was not supposed to cost it.
    expect(Math.abs(mean - wave), `mean entry ${mean.toFixed(1)} vs wave ${wave.toFixed(1)}`)
      .toBeLessThan(6)

    // THE LANE. Without a lateral hazard concept the AI's line on a straight is
    // an apex bias of ~0 plus a zero-mean random walk, so the mean lateral over
    // a span sits at the centreline and this is 0. Measured with the planner it
    // is 7-8m into the surviving half -- the middle of the lane.
    const meanLane = laneSum / onSpanFrames
    expect(meanLane, `mean lane offset ${meanLane.toFixed(2)}m into the surviving half`)
      .toBeGreaterThan(4)
    // ...and it holds it. A field that wanders across the seam half the time is
    // not driving the causeway, it is surviving it.
    const wrong = wrongHalfFrames / onSpanFrames
    expect(wrong, `share of span frames on the half that drops: ${(wrong * 100).toFixed(1)}%`)
      .toBeLessThan(0.15)

    // THE HAZARD STILL HAS TEETH, and this is where the assertion moved to.
    // It used to be "somebody has to fall", which was the right test when the
    // whole deck went and the only outcome was a respawn: a field that never
    // fell meant a decoration with a period. Now the field is SUPPOSED not to
    // fall -- it drives the lane -- so the thing that has to stay non-zero is
    // the wrong-lane exposure the crosswind keeps generating. Measured at 24
    // races the falls that survive are 0.02-0.05 per span entry against
    // 0.29-0.47 before, which is the mechanic being answerable rather than
    // absent.
    expect(wrongHalfFrames, 'the crosswind still pushes somebody over the seam')
      .toBeGreaterThan(0)
    // And nobody may fall through the half that never goes.
    expect(falls / crossings, 'fall rate per crossing').toBeLessThan(0.09)
  })
})

// ---------------------------------------------------------------------------
describe('the flat tracks cannot reach any of this', () => {
  it.each([['Rustfall', RUSTFALL], ['Cryostatic', CRYOSTATIC]])(
    '%s authors no phase, so hasBridges is false and every sample is permanent deck',
    (_name, def) => {
      const track = new Track(def as TrackDef)
      expect(track.hasBridges).toBe(false)
      expect(track.bridges).toEqual([])
      expect(track.samples.every((s) => s.bridge === -1)).toBe(true)
    },
  )

  it('keeps Rustfall bit-identical: the pre-bridge determinism hash', () => {
    // Recorded from tools/headless.ts before TrackNode.phase existed. If this
    // moves, something in the bridge, deck or fall-through work has leaked onto
    // a shipped, balanced circuit -- which is the expensive failure here, not a
    // car falling off a bridge nobody has authored yet.
    resetAI()
    const track = new Track(RUSTFALL)
    const race = new Race(track, {
      seed: 1337, totalLaps: 3, racerCount: 8, trackId: RUSTFALL.id,
      chassisIds: Array.from({ length: 8 }, (_, i) => CHASSIS[i % CHASSIS.length].id),
      pilotIds: Array.from({ length: 8 }, (_, i) => PILOTS[i % PILOTS.length].id),
      localRacerIndex: -1,
      aiSkill: Array.from({ length: 8 }, (_, i) => 2 + (i % 3)),
    })
    const idle = emptyInput()
    for (let f = 0; f < 600; f++) { race.setInput(0, idle); race.step() }
    // A PINNED BASELINE, not a derived value. It moves only when someone
    // deliberately changes the shared sim, and the move must be recorded here.
    // History:
    //   1e37dee4  the pre-gravity build.
    //   29ca22ed  the barrier pass: hard deck floor, orientation-aware inset,
    //             impacts priced on closing rate, drift coyote window.
    //   1c096122  the boost-pad pump fix (applyBoost's weakerExtend branch was
    //             re-firing every frame a wheel was on a strip, banking up to
    //             209s of boost) plus the AI drift-commitment latch. Both are
    //             global sim changes and both were expected to move this.
    //   b1d19475  the crosswind cap (a player reported being pushed sideways
    //             with no steering that could answer it) forced a re-trim of
    //             locomotion.flight.gripMult, 1.01 -> 0.98. The cap and the
    //             item-box calm are PROVABLY INERT here -- Rustfall authors no
    //             wind, and pinning gripMult back at 1.01 reproduces 29ca22ed
    //             exactly with both of them still in. This move is the flight
    //             trim and nothing else.
    //   27ad749b  the hovering branch got a floor, and hover's rideHeight went
    //             1.00 -> 1.15. Rustfall authors no bridges and no vacuum, so
    //             neither of those is what moved it -- what moved it is that
    //             Vector-7 and the Star Hopper are on this grid and both ride
    //             on the altitude code that changed. The flight class had been
    //             driving through the deck (measured: bodywork inside the road
    //             on 2669 frames of 18 Rustfall races, as deep as 1.80m) and
    //             now cannot, so its line and its lap time both move.
    //             groundSnapDistance 2.4 -> 1.85 rides along in the same
    //             change and is PROVABLY INERT: the comparison it feeds moved
    //             from "below the ride height" to "below the road" in the same
    //             edit, 0.55 + 1.85 == 2.4 exactly for the grounded class, and
    //             an A/B of the two rules produced identical sub-deck frame
    //             counts on all three measured tracks.
    //   42272a00  pilots stopped being decoration. Two changes land together
    //             and both are deliberate. A pilot now contributes chassis stat
    //             POINTS before deriveChassis runs, and this grid cycles the
    //             roster, so every car on it is derived from a slightly
    //             different stat line than before. And a committed drift keeps
    //             most of its arc under boost (T.drift.boostArcRelief), which
    //             changes the line through every corner taken on a boost.
    //             Neither is a fix to a bug -- both are new mechanics, asked
    //             for, and a hash that did NOT move would mean one of them had
    //             failed to reach the sim.
    //             The drift re-entry window rides along and is NOT provably
    //             inert here: it lowers the enter threshold for 0.45s after a
    //             release, and the AI releases drifts constantly. It is not
    //             separable from the arc change by inspection, so it is not
    //             claimed to be.
    expect(race.hash()).toBe('42272a00')
  })
})
