import type { ChassisDef, ChassisDerived, ChassisStats, LocomotionProfile } from '../sim/types'
import { TUNING } from './tuning'

export const CHASSIS: ChassisDef[] = [
  {
    id: 'solaire', name: 'Solaire GT', nickname: 'the honest one',
    locomotion: 'grounded',
    // ROSTER PASS after the AI learned to drive the reworked drift (see
    // T.ai.driftPursuitGain). topSpeed 8 -> 7 and grip 8 -> 7, which finally
    // makes "the honest one" honest: a flat 7 in every stat the balance test
    // looks at. It had to come down. While the AI was steering its nose it
    // could not use a drift at all, so the two chassis whose whole case is the
    // drift arc -- Bulwark and Dray-9 -- were carrying a dead mechanic, and
    // Solaire's even spread won 42.5% of races by default. With the arc
    // actually being used, the same even spread measured 54.0%; at 7s it is
    // 16.5% over 200 races, which is what a chassis with no edge anywhere
    // should look like.
    stats: { topSpeed: 7, accel: 7, grip: 7, mass: 5, drift: 7, handling: 7 },
    halfExtents: { x: 1.15, y: 0.55, z: 2.35 },
    colorPrimary: 0xe8452f, colorSecondary: 0x22252c, colorEmissive: 0xffb03a,
  },
  {
    id: 'filament', name: 'Filament', nickname: 'the scalpel',
    locomotion: 'hover',
    // grip 4 -> 7, and nothing else. At grip 4 the AI's corner-speed model
    // asked for more than the chassis could hold: Filament finished 6.11th on
    // average across 300 races for a 0.3% win share. Grip is by far the most
    // load-bearing stat in the roster -- one point measured at roughly a full
    // finishing position over 2000 races -- so it is the only one that moved.
    // Accel 9, handling 9, mass 2 and topSpeed 7 are untouched: still the
    // scalpel, just no longer the slowest thing on the track.
    // accel 9 -> 8 for the two-track pass. Filament took 30.5% on Cryostatic,
    // just over the band, on the best average lap in the field. Handling 9 and
    // mass 2 are the scalpel's actual signature and both stay; accel was the
    // third roster-max stat on one chassis.
    stats: { topSpeed: 7, accel: 8, grip: 7, mass: 2, drift: 6, handling: 9 },
    // SHORTENED WITH THE HULL. The Filament was redesigned from a 4.1m needle
    // to a 3.2m blade, and a box that no longer matches its mesh is a car that
    // clips barriers a metre before it touches them.
    //
    // x is DELIBERATELY UNCHANGED. Half-width is the most load-bearing number
    // here -- bodyInset() is exactly `x + 0.12`, so it sets the wall clamp for
    // every square-on contact in the game, and the redesign keeps the hull
    // core inside the old width (only the fan plates reach wider, and those
    // are thin swept decoration, the same licence Vector-7's wings take).
    //
    // z 2.05 -> 1.58 and y 0.62 -> 0.54 feed orientedInset(), which projects
    // the box onto the wall normal. So this is a real change, and in one
    // direction: a CRABBED Filament now presents a smaller corner and can
    // carry a drift closer to a barrier than it could. That is the honest
    // consequence of the car being shorter, not a buff smuggled in as art --
    // but it is a sim change and the balance gate re-ran because of it.
    halfExtents: { x: 0.68, y: 0.54, z: 1.58 },
    colorPrimary: 0x1ad6ff, colorSecondary: 0x101821, colorEmissive: 0x6ffcff,
  },
  {
    id: 'bulwark', name: 'Bulwark MK-IV', nickname: 'the drift king',
    locomotion: 'grounded',
    // topSpeed 5 -> 6 and accel 5 -> 6. Bulwark pays for drift 10 and grip 9 by
    // being the slowest thing on the grid, and that was the correct price while
    // the drift arc was the strongest tool in the game. It is not any more: the
    // AI now takes only as much arc as the corner asks for, so "my drift
    // out-turns my steering lock by 1.94x" stopped being worth anything -- 39.5%
    // win share before the AI could drive, 8.5% after. One point of top speed
    // and one of acceleration buy it back to 20.5% without touching the two
    // stats that ARE its identity. It is still strictly the slowest chassis and
    // strictly the best drifter, which is what tests/balance.test.ts asserts.
    // accel 6 -> 5, restoring the tank's slow launch. It was raised last pass to
    // rescue Bulwark when the AI could not drive the drift; with the AI fixed
    // and the track widened it took 33% of wins with the buff still on.
    // grip 9 -> 8 for the symmetric-surface pass. Once hover and flight stopped
    // ignoring surface friction, the AI's corner model started reading the grip
    // stat for all five chassis instead of three, and the roster-max value took
    // Bulwark to 30-31% on both tracks. 8 is still the roster maximum, so the
    // tank is still the grippiest thing in the game.
    // accel back to 6: with Vector-7's point removed the tank was left on the
    // Cryostatic floor at 13%, and this is the point it lost two passes ago.
    // FRICTION-BUDGET PASS: accel 6 -> 7. Bulwark was on the Cryostatic floor
    // again (11.3% over 400 races) once grip acquired physical meaning, and for
    // a reason worth writing down: the repricing of the grip STAT (see
    // T.derive) narrowed the roster's cornering spread from 15% to 9.8%, which
    // is exactly the advantage Bulwark's roster-max grip was being paid in. The
    // three obvious answers were all worse. grip 8 -> 9 put it at 30.8% on
    // Rustfall while dropping Solaire to 10.0% on Cryostatic -- a whole grip
    // point is STILL too coarse a step even at the flatter slope. handling
    // 4 -> 5 bought 1.5 points and blurred the tank. So the payment is in a
    // straight line, where it costs the identity least: Bulwark is still the
    // slowest thing on the grid by a clear point and still the best drifter by
    // two, and Filament is still strictly the best accelerating chassis.
    stats: { topSpeed: 6, accel: 7, grip: 8, mass: 10, drift: 10, handling: 4 },
    halfExtents: { x: 1.55, y: 0.85, z: 2.55 },
    colorPrimary: 0x5c6b4a, colorSecondary: 0x2a2f26, colorEmissive: 0xff7a1f,
  },
  {
    id: 'dray9', name: 'Dray-9', nickname: 'the freight train',
    locomotion: 'grounded',
    // grip 4 -> 6. HISTORY: grip went 6 -> 4 in two earlier passes because
    // Dray-9 held both stats this sim prices highest -- roster-max top speed and
    // near-max mass -- and paid for them only in accel and handling, neither of
    // which cost much when the drift arc handed a low-handling chassis 2.3x its
    // own steering lock. It ran away with 33-41% of wins, and charging for that
    // in grip was right at the time. It is not right now: the drift arc stopped
    // being free the moment the AI started metering it, and grip turned out to
    // be the only thing still separating the roster.
    //
    // (HISTORICAL, and wrong as of the friction-budget pass: "grip is priced
    // twice in this sim and only one of them is physics -- outside a drift the
    // velocity is rebuilt in the post-rotation basis every frame, so the nose
    // drags the momentum round with it and grip only scrubs a small residue".
    // Both halves are physics now; see T.grip and the note below.)
    // The load-bearing half WAS the AI's corner
    // model, cornerLimit = sqrt(effGrip * 26 / k), which is why one point of it
    // measured a whole finishing position. At grip 4 that model asked Dray-9 to
    // take every corner 14% slower than Solaire, and once the AI stopped
    // throwing away time elsewhere that deficit was the only thing left: 1.0%
    // win share on a 3.7s-a-lap deficit. At 6 it runs 19.5%. It is still the
    // roster minimum -- the truck still cannot hold a line -- just not by a
    // margin that no amount of top speed can pay for.
    // accel 3 -> 4. The wider track lengthens every corner exit, which punishes
    // the slowest-accelerating chassis twice over; Dray-9 sat on the 12% floor
    // until it got this point back. Still the roster minimum.
    //
    // topSpeed 10 -> 9 for the wall-model pass. Barriers that redirect instead
    // of absorbing reward the chassis that carries the most speed into them,
    // and Dray-9 went to 27.7% on Rustfall and 33.8% on Cryostatic. Still the
    // roster maximum by a clear point, so it is still the fastest thing here.
    //
    // FRICTION-BUDGET PASS: topSpeed 9 -> 8, with Vector-7 dropped to 7 so the
    // truck keeps its crown. HISTORY IS NOW WRONG ON ONE POINT and it is worth
    // correcting rather than deleting: the note below says grip is "priced
    // twice in this sim and only one of them is physics". Both halves are
    // physics now -- gripCoeff multiplies the lateral acceleration budget the
    // tyres actually have -- and the slope was flattened to match
    // (T.derive.gripPer 0.075 -> 0.050), which took Dray-9 from 7.0% to 18.0%
    // on Rustfall without touching its stats at all.
    //
    // That fix overshot on Cryostatic, where it ran 28-30%. The reason is the
    // track, not the chassis: Cryostatic is 2892 m of open, gently-curved ice
    // and snow against Rustfall's 2480 m of tight metal, so it pays for top
    // speed and not for cornering, and Dray-9 holds the roster maximum of one
    // and the minimum of the other. Charging the difference in grip was
    // measured and is the wrong lever -- grip 6 -> 5 gives 17.8% on Cryostatic
    // and 11.3% on Rustfall, which is out of the band at the other end. Top
    // speed is the stat the two tracks disagree about, so top speed is what
    // moves: 19.5% / 16.5% across the pair.
    stats: { topSpeed: 8, accel: 4, grip: 6, mass: 9, drift: 6, handling: 4 },
    halfExtents: { x: 1.45, y: 1.05, z: 3.15 },
    colorPrimary: 0xf0a01c, colorSecondary: 0x33261a, colorEmissive: 0xff4d16,
  },
  {
    id: 'vector7', name: 'Vector-7', nickname: 'the line breaker',
    locomotion: 'flight',
    // grip 7 -> 8, topSpeed 9 -> 8. HISTORY: an earlier pass took grip 3 -> 7,
    // drift 4 -> 8, accel 6 -> 8 and handling 6 -> 7, when Vector-7 won 0 of 300
    // races on 5.2 respawns and 7.4s a race off the surface. The skill ceiling
    // still lives in Lift and gap-crossing rather than in an unusable grip
    // figure; these two points are a pace adjustment on top of that, not a
    // rethink of it.
    //
    // Grip was worth 16 points of win share on its
    // own here (10.5% -> 26.5% over 200 races), which is far too coarse a step
    // to land inside a 12-30% band, so the top-speed point is what brings it
    // back to 22.0%. Vector-7 is the chassis the flight profile taxes hardest --
    // knockbackMult 1.60, fieldForceMult 1.80, driftArcMult 0.85 -- so it needs
    // to be paid somewhere, and grip is where the AI's corner model can see it.
    // Still the second-fastest chassis behind Dray-9 and still the only flight
    // frame, which is the identity that matters.
    // WIDTH PASS. grip 8 -> 7. The 50% wider ribbon and the drift release kick
    // both favour the flight class: Vector-7's air share ran 24% against 16%
    // for everyone else and it took 43.2% of wins over 600 races. Grip is worth
    // roughly a finishing position per point here, and taking the point back
    // off the chassis that gained most from the track change is a smaller lie
    // than nerfing the track.
    // accel 8 -> 7. Filament's accel came down to 8 for the two-track pass,
    // which tied it with Vector-7 and broke "Filament is the best accelerating
    // chassis" -- an identity the test suite asserts and tuning does not get to
    // quietly repeal. Taking the point off the flight frame instead keeps the
    // scalpel's crown and costs Vector-7 least: it is the only chassis that
    // leaves the track, and that is what it is for.
    // Grip stays 7. One grip point is worth ~17 points of win share to Vector-7
    // (11.5% -> 26.5% on Rustfall, 11.2% -> 32.3% on Cryostatic), which is far
    // too coarse a step to land inside a 12-30% band on two tracks at once. The
    // fine adjustment lives in locomotion.flight.gripMult instead.
    // FRICTION-BUDGET PASS: topSpeed 8 -> 7. This is Dray-9's point, not
    // Vector-7's problem: the truck had to come down to 8 on Cryostatic and
    // "Dray-9 is the fastest chassis" is an identity tests/balance.test.ts
    // asserts, so something had to be below it. Vector-7 was the chassis with
    // room -- 22.3% on Rustfall and 20.8% on Cryostatic before the change,
    // against Solaire's 22.5% / 16.5% -- and it is the frame whose case has
    // never rested on top speed. Still the second fastest, still the only
    // flight chassis, and still the only thing on the grid that can leave the
    // track and come back in front.
    stats: { topSpeed: 7, accel: 7, grip: 7, mass: 3, drift: 8, handling: 7 },
    halfExtents: { x: 1.85, y: 0.55, z: 2.45 },
    colorPrimary: 0xdfe6ee, colorSecondary: 0x394456, colorEmissive: 0x5ad2ff,
  },
]

export const CHASSIS_BY_ID: Record<string, ChassisDef> = Object.fromEntries(
  CHASSIS.map((c) => [c.id, c]),
)

const D = TUNING.derive

/** The published stat-to-physics formulas from the GDD. */
export function deriveChassis(stats: ChassisStats): ChassisDerived {
  return {
    topSpeed: D.topSpeedBase + stats.topSpeed * D.topSpeedPer,
    timeToTop: D.timeToTopBase + stats.accel * D.timeToTopPer,
    gripCoeff: D.gripBase + stats.grip * D.gripPer,
    massKg: D.massBase + stats.mass * D.massPer,
    driftChargeMult: D.driftMultBase + stats.drift * D.driftMultPer,
    maxYawRate: (D.yawRateBase + stats.handling * D.yawRatePer) * (Math.PI / 180),
  }
}

const derivedCache = new Map<string, ChassisDerived>()
export function getDerived(chassisId: string): ChassisDerived {
  let d = derivedCache.get(chassisId)
  if (!d) {
    const def = CHASSIS_BY_ID[chassisId] ?? CHASSIS[0]
    d = deriveChassis(def.stats)
    derivedCache.set(chassisId, d)
  }
  return d
}

export function getLocomotion(chassisId: string): LocomotionProfile {
  const def = CHASSIS_BY_ID[chassisId] ?? CHASSIS[0]
  return TUNING.locomotion[def.locomotion] as LocomotionProfile
}
