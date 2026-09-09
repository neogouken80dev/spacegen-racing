import { clamp, clamp01, angleDelta, sign } from './math'
import type { Vec3 } from './math'
import type { InputFrame, RacerState, RaceState, ChassisDerived, LocomotionProfile } from './types'
import type { Rng } from './rng'
import { Track, SURFACE_GRIP, bridgeSolidThrough } from './track'
import { TUNING as T } from '../content/tuning'
import { getDerived, getLocomotion } from '../content/chassis'
import {
  STEER_SIGN, lateralBudget, cornerSpeedAt, driftSurfaceFactor, signedAngleAround,
  vacuumGripMult, vacuumTopSpeedMult,
} from './vehicle'

/**
 * THE GRAVITY SWITCH, AI SIDE.
 *
 * Set once per stepAI call from `track.hasGravity`, exactly as vehicle.ts sets
 * its own. Every heading comparison in this file was a bearing about world +Y:
 * `r.yaw` against `atan2(dx, dz)`, `atan2(vel.x, vel.z)`, `sin(yaw)/cos(yaw)`.
 * All of those are fine on a track that never leaves the ground and all of them
 * are meaningless for a car halfway up a vertical wall, where the nose can be
 * pointing straight down the road with a yaw 90 degrees from the tangent.
 *
 * The gravity path replaces each one with the same angle taken in the racer's
 * OWN surface plane -- about `r.up` rather than about +Y -- which reduces to
 * the identical number when `r.up` is +Y. It is still gated rather than left to
 * reduce, for the same reason vehicle.ts gates: Rustfall and Cryostatic are
 * balanced and gated, and `a + (b - a)` is not `b` in floating point.
 */
let _grav = false

/** Ground speed in the plane the car is driving in. */
function planarSpeed(v: Vec3): number {
  return _grav ? Math.hypot(v.x, v.y, v.z) : Math.hypot(v.x, v.z)
}

/**
 * Scratch vector for the offset from a racer to its aim point. Module-level so
 * the gravity path allocates nothing per racer per frame, exactly as
 * vehicle.ts's scratch basis does.
 *
 * Note this is deliberately NOT normalised and NOT fed to signedHeadingError,
 * whose `clamp(dot, -1, 1)` is only correct for a unit target -- on a 30-metre
 * lookahead it would clamp the dot to 1 and hand atan2 a bearing of nearly
 * zero regardless of where the corner actually went.
 */
const _aimVec: Vec3 = { x: 0, y: 0, z: 0 }
function _aim(target: Vec3, r: RacerState): Vec3 {
  _aimVec.x = target.x - r.pos.x
  _aimVec.y = target.y - r.pos.y
  _aimVec.z = target.z - r.pos.z
  return _aimVec
}

interface AIMemory {
  reactionTimer: number
  itemTimer: number
  lineBias: number
  mistakeTimer: number
  lastSteer: number
  /** Seconds of drift the AI has committed to; see the drift block below. */
  driftHold: number
}

const memories = new Map<number, AIMemory>()

export function resetAI(): void { memories.clear() }

function mem(id: number): AIMemory {
  let m = memories.get(id)
  if (!m) {
    m = { reactionTimer: 0, itemTimer: 0, lineBias: 0, mistakeTimer: 0, lastSteer: 0, driftHold: 0 }
    memories.set(id, m)
  }
  return m
}

/**
 * THE BRIDGE PLANNER.
 *
 * Returns the fastest speed, at or below `desired`, that puts this racer on
 * every phasing span inside its horizon while that span is solid -- or the
 * give-up speed if no candidate clears them all.
 *
 * A phasing bridge is the one hazard on any of these tracks that braking does
 * not solve, because it is not in the way: it is in the way AT A TIME. Corner
 * speed is a function of where you are, so the existing controller can chase it
 * frame by frame; bridge speed is a function of when you arrive, so it has to
 * be SOLVED ONCE and then held. That is why this returns a cruise speed rather
 * than a brake command.
 *
 * The prediction assumes the racer travels the whole approach at the candidate
 * speed, which is wrong for the first second or so while the throttle catches
 * up. It is deliberately not corrected for: the residual is what makes a racer
 * that was shoved, spun or boosted on the approach arrive off the beat and go
 * through the deck, and that is the mechanic doing its job rather than a
 * modelling error. Note also that the prediction is SELF-CONSISTENT once the
 * speed is held -- distance and race time advance together, so the predicted
 * arrival phase stops moving and the planner does not hunt.
 */
function bridgeCruise(
  track: Track,
  r: RacerState,
  raceTime: number,
  desired: number,
  skill: number,
): number {
  const horizon = T.ai.bridgeHorizon * T.ai.bridgeHorizonSkill[skill]
  const steps = T.ai.bridgeSpeedSteps
  for (let i = 0; i < steps.length; i++) {
    const v = Math.max(6, desired * steps[i])
    let ok = true
    for (const b of track.bridges) {
      // Forward distance to the span, wrapped into [0, length).
      let d0 = (b.s0 - r.splineS) % track.length
      if (d0 < 0) d0 += track.length
      if (d0 > horizon) continue
      const d1 = d0 + (b.s1 - b.s0)
      if (!bridgeSolidThrough(b.phase, raceTime + d0 / v, raceTime + d1 / v)) { ok = false; break }
    }
    if (ok) return v
  }
  return Math.max(6, desired * steps[steps.length - 1])
}

/**
 * THE LANE PLANNER -- the AI's only concept of a LATERAL hazard.
 *
 * Everything else stepAI does about the road ahead is longitudinal. The racing
 * line is an apex bias plus a random walk, the corner model is a speed, the
 * bridge planner above is a speed. None of them can express "there is nothing
 * under that side of the road", and until half-span phasing there was nothing
 * on any of the three circuits that needed them to: a whole span was gone or it
 * was not, and the only lever was arriving at a different time.
 *
 * A span that drops one half is a different question and it has a different
 * answer: BE ON THE OTHER HALF. So this returns a lateral offset in metres --
 * the middle of the surviving lane -- and stepAI aims the racing line at it
 * instead of at the apex bias for as long as a span is in range.
 *
 * WHY IT COMMITS EARLY AND HOLDS, rather than reacting to the deck going out.
 * The absent window is 0.83s and the car needs about a second to cross the
 * seam under the friction budget, so anything that waits to see the deck go has
 * already lost. The lane is picked on the approach and held through the whole
 * causeway, which is also the thing a human has to do, and it is why the
 * mechanic reads as a decision rather than as a reflex.
 *
 * IT SHARES THE BRIDGE PLANNER'S HORIZON AND SKILL SCALE, deliberately. Both
 * are the same question -- how far ahead does this racer read the causeway --
 * and a bottom-skill racer that solved the timing at 143m but the lane at 260m
 * would be worse at the thing it is supposed to be worse at. Reading the lane
 * LATE is what makes a low-skill racer meet a span still crossing the seam,
 * which is where its falls come from.
 */
/**
 * Where in the surviving half to aim, as a fraction of the half-width.
 *
 * NOT 0.5, and the difference is the crosswind. The AI's line controller chases
 * a lookahead point and a constant lateral field leaves it a steady-state
 * offset downwind of whatever it asked for -- measured on Aetherion's causeway
 * at 3-4m, more for the classes with the higher fieldForceMult. Aiming at the
 * middle of the lane therefore SITS the field a third of the way from the middle
 * to the seam. 0.62 of 16m is 9.9m of aim, which measures out at a mean lateral
 * of -7.3 to -8.4 across the roster: the middle of the surviving half, which is
 * where the lane planner is supposed to put a car.
 *
 * Measured over 24 races, falls per span entry against the aim point:
 *   0.46   grounded 0.10  hover 0.08  flight 0.05   mean lateral -5.0
 *   0.62   grounded 0.02  hover 0.03  flight 0.05   mean lateral -8.0
 *   0.72   grounded 0.01  hover 0.00  flight 0.08   mean lateral -9.9
 * 0.72 is past the middle and starts spending the far edge instead; 0.46 leaves
 * the field clipping the seam 5-16% of its span frames.
 */
const LANE_CENTRE = 0.62
/**
 * How much of the racing line's own random walk survives inside the lane.
 * Not zero: a field that drives one lateral to the millimetre is a train, and
 * the jitter is what leaves room for a racer to be caught out. 0.18 of the
 * half-width is +/-1.6m at 16m against a lane centre 9.9m from the seam --
 * enough to look driven, not enough to be the thing that drops a car.
 */
const LANE_WANDER = 0.18
function bridgeLane(
  track: Track,
  r: RacerState,
  skill: number,
  halfWidth: number,
): number | null {
  const horizon = T.ai.bridgeHorizon * T.ai.bridgeHorizonSkill[skill]
  let bestD = Infinity
  let side = 0
  for (const b of track.bridges) {
    if (b.side === 0) continue
    // Distance to the FAR end of the span: a racer already on a span has to
    // hold its lane until it is off it, so the span stays in range until then.
    let d1 = (b.s1 - r.splineS) % track.length
    if (d1 < 0) d1 += track.length
    if (d1 > horizon) continue
    if (d1 < bestD) { bestD = d1; side = b.side }
  }
  if (side === 0) return null
  // The surviving half is the one the span does NOT drop.
  return -side * halfWidth * LANE_CENTRE
}

/**
 * AI racers drive the same input interface as a human, so they exercise
 * exactly the same physics path. There is no hidden speed bonus; skill bands
 * scale the fraction of top speed the AI is willing to ask for.
 */
export function stepAI(r: RacerState, state: RaceState, track: Track, rng: Rng): InputFrame {
  const dt = T.sim.dt
  const m = mem(r.id)
  _grav = track.hasGravity
  const derived = getDerived(r.chassisId)
  const loco = getLocomotion(r.chassisId)
  const skill = clamp(Math.round(r.aiSkill), 0, T.ai.skillSpeed.length - 1)
  const speedCap = T.ai.skillSpeed[skill]

  const speed = planarSpeed(r.vel)
  const lookahead = T.ai.lookaheadBase + speed * T.ai.lookaheadPerSpeed

  // --- Racing line -----------------------------------------------------------
  m.lineBias += (rng.next() - 0.5) * dt * 1.2
  m.lineBias = clamp(m.lineBias, -0.55, 0.55)

  const aheadS = r.splineS + lookahead
  const curveNear = track.curvatureAt(r.splineS, 14)
  const curveFar = track.curvatureAt(aheadS, 26)
  const halfWidth = track.at(aheadS).width

  // Aim wide on entry, tight at the apex: bias against the curve direction.
  const apexBias = -sign(curveFar) * clamp01(Math.abs(curveFar) * 42) * 0.62
  // A phasing span in range REPLACES the apex bias rather than being added to
  // it. Gated on the track carrying spans, so Rustfall and Cryostatic never
  // evaluate it and their racing line is bit-identical. On Aetherion the
  // causeway is straight (R > 5000m measured) so there is no apex to give up:
  // the line the bias would have asked for and the lane are the same metres,
  // and where they are not, the lane wins because the other one is a hole.
  const lane = track.hasBridges ? bridgeLane(track, r, skill, halfWidth) : null
  const targetLateral = lane !== null
    ? clamp(lane + m.lineBias * halfWidth * LANE_WANDER, -halfWidth * 0.86, halfWidth * 0.86)
    : clamp((apexBias + m.lineBias) * halfWidth, -halfWidth * 0.86, halfWidth * 0.86)

  const target = track.surfacePoint(aheadS, targetLateral)
  // How far the nose has to swing to point at the aim point.
  //
  // Flat, that is a compass comparison: the bearing of the target minus the
  // car's own bearing, both about world +Y. On a gravity track the same angle
  // is taken about the racer's own up, which is the ONLY axis it means anything
  // about once the car is on a wall -- and which gives the identical number
  // when that up is +Y, because signedAngleAround reduces to angleDelta there.
  //
  // The raw world offset is handed over unprojected on purpose: the target sits
  // ON the road while the car floats rideHeight above it, so the offset carries
  // a component along -up, and that component contributes nothing to either
  // term of the atan2. Projecting first would cost a normalise and change
  // nothing.
  const wantYaw = Math.atan2(target.x - r.pos.x, target.z - r.pos.z)
  // NOTE: offsetting this by the measured nose-to-velocity difference, to aim
  // the velocity rather than the nose, is a positive feedback loop — steering
  // to increase the nose lead increases the crab, which increases the offset.
  // Measured at 300 races: lap times 66s -> 74.7s and three chassis out of band.
  // Negated to match STEER_SIGN in vehicle.ts: a positive steer decreases yaw.
  //
  //
  // Normalised by the chassis's OWN maxYawRate, which is correct: a car that
  // turns slowly needs more lock for the same line error. Measured alternatives
  // are both worse — a fixed reference rate makes the heavy chassis understeer
  // (Bulwark fell to 2.7% win share), and forcing a steer floor to guarantee
  // drift entry makes every car oversteer (drifts per race doubled, 80% of them
  // reaching no tier at all).
  const bearingErr = _grav
    ? signedAngleAround(r.fwd, _aim(target, r), r.up)
    : angleDelta(r.yaw, wantYaw)
  let steer = clamp(-bearingErr / Math.max(0.25, derived.maxYawRate * 0.55), -1, 1)

  // Inside a slide the nose is the wrong thing to aim -- it leads the direction
  // of travel by up to 30 degrees, which a heading-error controller reads as
  // over-rotation and answers with opposite lock. Solve for the PATH instead.
  // See T.ai.driftPursuitGain for what this replaced and what it measured.
  if (r.driftSide !== 0) {
    // The surface UNDER the car, not the one ahead: driftStick inverts the arc
    // mapping in vehicle.ts exactly, and vehicle.ts reads the surface it is
    // standing on. It is also the raw physical value with no T.ai.surfaceCaution
    // on it -- caution is a belief about how fast to go, and this is arithmetic.
    const hereSample = track.at(r.splineS)
    const hereSurface = (hereSample.fragile && state.iceCracked)
      ? T.hazard.crackedSurface
      : hereSample.surface
    const hereGrip = 1 + (SURFACE_GRIP[hereSurface] - 1) * loco.surfaceFrictionInfluence
    steer = driftStick(r, target, speed, derived, loco, driftSurfaceFactor(hereGrip))
  }

  // Reaction delay so AI does not feel robotic.
  m.reactionTimer -= dt
  if (m.reactionTimer > 0) {
    steer = m.lastSteer
  } else {
    m.reactionTimer = T.ai.reactionTime * (1.4 - skill * 0.12)
    m.lastSteer = steer
  }

  // Occasional mistakes, more often at low skill.
  m.mistakeTimer -= dt
  if (m.mistakeTimer <= 0) {
    m.mistakeTimer = 2.0 + rng.next() * 3.0
    if (rng.next() < T.ai.mistakeChance * (5 - skill)) {
      m.lineBias += (rng.next() - 0.5) * 1.6
    }
  }

  // --- Throttle and braking --------------------------------------------------
  // THE CORNER SPEED LIMIT IS NOW A PROPERTY OF THE CAR, NOT A BELIEF OF THE AI.
  //
  // This used to read `sqrt(effGrip * 26 / k)` against a physics engine that had
  // no lateral limit whatsoever: outside a drift stepVehicle rebuilt the
  // velocity on the post-rotation nose every frame, so the nose dragged the
  // momentum round with it, `grip` decayed a residue steady cornering never
  // generated, and the SAME line was traced through Cryostatic's ice sweeper at
  // ice grip 1.00, 0.45 and 0.15 -- to within a millimetre, with 0.00 degrees of
  // slip. Every second ice cost was charged right here and nowhere else.
  //
  // stepVehicle now has a real friction budget, and lateralBudget/cornerSpeedAt
  // are the SAME functions it uses. Above this speed the tyres genuinely cannot
  // hold the corner and the car genuinely runs wide, so:
  //   - T.ai.corneringCaution is a real safety margin. At c the AI spends c^2 of
  //     the lateral budget, leaving 1 - c^2 for the racing line, the mid-corner
  //     bumps and the fact that curveFar is a smoothed lookahead rather than the
  //     curvature the car will actually meet.
  //   - T.ai.surfaceCaution is the one thing here that is still a belief: how
  //     much of the surface delta the AI's model believes. It is no longer a
  //     substitute for physics -- the physics agrees now -- so it is only ever a
  //     personality knob, and 1.0 means "brake for what is actually there".
  //
  // The curvature to respect is the WORST of the corner ahead and the corner
  // the car is already in. Reading only the lookahead point was survivable
  // while the physics had no lateral limit -- overshooting the model's corner
  // speed cost nothing, because the nose dragged the momentum round regardless.
  // With a real budget it costs the corner: measured at 200 races on Rustfall,
  // the single-point read put the field 1.0-1.9 respawns and 1.4-2.6 off-track
  // seconds a race against 0.6-1.0 and 0.3-1.0 before, because the AI released
  // the brake the moment the lookahead point cleared the apex while the car was
  // still turning. Taking the max holds the corner speed until the corner is
  // actually over.
  const k = Math.max(Math.abs(curveFar), Math.abs(curveNear) * T.ai.cornerHoldShare)
  const aheadSample = track.at(aheadS)
  // A cracked shelf is bare ice, so read the surface the racer will MEET rather
  // than the one the track was authored with -- whatever the term is worth, it
  // has to be worth the same on lap 3 as on lap 1.
  const aheadSurface = (aheadSample.fragile && state.iceCracked)
    ? T.hazard.crackedSurface
    : aheadSample.surface
  const surfaceGrip = 1 + (SURFACE_GRIP[aheadSurface] - 1) * loco.surfaceFrictionInfluence * T.ai.surfaceCaution
  // HARD VACUUM moves BOTH sides of this comparison and in opposite directions:
  // the ceiling goes up because the air has stopped resisting, and the corner
  // limit collapses because there is nothing left to push against. Read off the
  // sample the car is heading FOR, exactly like the surface above -- a vacuum
  // that fades in over 90m of corner has to be braked for before it arrives,
  // not after. Gated on the track authoring any, so the three shipped circuits
  // never evaluate it and their AI is bit-identical.
  let budget = lateralBudget(derived, loco, surfaceGrip)
  let ceiling = derived.topSpeed * speedCap
  if (track.hasVacuum) {
    budget *= vacuumGripMult(aheadSample.vacuum, loco)
    ceiling *= vacuumTopSpeedMult(aheadSample.vacuum)
  }
  const cornerLimit = cornerSpeedAt(budget, k) * T.ai.corneringCaution
  let desired = Math.min(ceiling, cornerLimit)
  // The light-bridges. Gated on the track carrying any, so the two shipped
  // circuits never enter the planner and their AI is bit-identical.
  if (track.hasBridges) {
    desired = Math.min(desired, bridgeCruise(track, r, state.time, desired, skill))
  }

  let throttle = 1
  let brake = 0
  if (speed > desired * 1.06) { throttle = 0; brake = clamp01((speed - desired) / 12) }
  else if (speed > desired * 0.97) { throttle = 0.55 }


  // --- Drift -----------------------------------------------------------------
  // Commit to a drift because the CORNER asks for one, not because the steering
  // output happens to be large. Steer magnitude is divided by the chassis's own
  // maxYawRate, so gating on it meant a better-handling car produced a smaller
  // number, fell under the drift-entry threshold, and simply never drifted —
  // which made the flight class strictly worse the more handling it was given.
  const sustained = Math.abs(track.curvatureAt(r.splineS + 6, 30))
  const wantDrift =
    speed > T.drift.minSpeedToDrift * 1.4 &&
    sustained > 0.0075 &&
    rng.next() < T.ai.driftCommitment + skill * 0.05

  // ONCE COMMITTED, HOLD. The entry gate reads curvature 6m AHEAD over a 30m
  // window; the hold gate reads it AT the car over 20m. Those are different
  // measurements of different arc, so a corner that begins just ahead can open
  // a drift on one frame and have the hold gate -- looking 6m further back --
  // drop it on the next.
  //
  // The gap is real and it is worst where it hurts most: for curvature k the
  // band where entry fires and hold does not is about 16 - 0.135/k metres wide,
  // which is 9m at R=50 and zero at R=133. Every TIGHT corner on every track was
  // a drift-entry machine gun. Measured before this latch: 659 drift entries a
  // race on Aetherion against Cryostatic's 122, 70.6% of them reaching no tier
  // at all, and Tier 3 firing in 0.17% of drifts against Cryostatic's 25%. The
  // core skill mechanic was being started and thrown away hundreds of times a
  // lap.
  //
  // A minimum commitment is also simply what a driver does: you decide to drift
  // a corner and you drive it, you do not re-decide sixty times a second.
  if (r.driftSide === 0 && wantDrift) m.driftHold = T.ai.driftMinHold
  else if (m.driftHold > 0) m.driftHold = Math.max(0, m.driftHold - dt)

  const drift = r.driftSide !== 0
    ? (m.driftHold > 0 || Math.abs(track.curvatureAt(r.splineS, 20)) > 0.0045)
    : wantDrift

  // NO FLOOR ON THE IN-DRIFT STICK. A `steer = driftSide * 0.35` floor used to
  // sit here to stop the slide straightening itself out, and it accounted for
  // 38.6% of all drift frames -- more than a third of every slide was the stick
  // being pinned rather than chosen. Clamping the AI's stick has been measured
  // in every form and is worse in all of them: inward floors of 0.35 / 0.15 / 0
  // gave Solaire 49.5% / 70.0% / 50.5% win share and lap times of
  // 67.1 / 71.2 / 75.2s. The stick needed a controller, not a cage; it has one
  // now, and a floor would only overrule it.

  // --- Items -----------------------------------------------------------------
  m.itemTimer -= dt
  let useItem = false
  let itemBack = false
  if (r.item && r.rouletteTime <= 0) {
    if (m.itemTimer <= 0) {
      const [lo, hi] = T.ai.itemUseDelay
      m.itemTimer = lo + rng.next() * (hi - lo)
      switch (r.item) {
        case 'nitro':
        case 'nitroTriple':
          // Save boosts for straights.
          useItem = Math.abs(curveNear) < 0.004 && speed > derived.topSpeed * 0.6
          break
        case 'voidMine':
          useItem = hasRacerBehind(r, state, 45)
          itemBack = true
          break
        case 'gravityWell':
          useItem = hasRacerBehind(r, state, 60)
          break
        case 'railMissile':
          useItem = hasRacerAhead(r, state, 70, 0.16)
          break
        case 'laserGatling':
          // Only worth spending when someone is already roughly in the sights;
          // the budget runs whether or not it connects.
          useItem = hasRacerAhead(r, state, 110, 0.10)
          break
        case 'seekerMissile':
        case 'alphaMissile':
        case 'empBomb':
        case 'overdriveCore':
          useItem = true
          break
      }
    }
  }

  // --- Lift (flight class) ---------------------------------------------------
  // Lift does NOT hold a racer over a phased-out light-bridge -- see the deck
  // block in vehicle.ts for the measurement that removed that -- so there is
  // nothing bridge-specific to decide here and this is the shipped heuristic,
  // unchanged.
  const lift = r.lift > 1.0 && Math.abs(curveNear) < 0.003 && speed > derived.topSpeed * 0.7

  return {
    steer: clamp(steer, -1, 1),
    throttle,
    brake,
    drift,
    item: useItem,
    itemBack,
    lift,
    lookBack: false,
  }
}

/**
 * The stick that makes the car's PATH turn at the rate the racing line asks
 * for, while it is sliding.
 *
 * Two halves, and the whole point is that neither of them looks at the nose.
 *
 * 1. HOW HARD THE PATH MUST TURN. Pure pursuit, measured from the direction of
 *    TRAVEL: the unique circle through the car, tangent to its velocity, that
 *    passes through the lookahead point has curvature
 *
 *        kappa = 2 sin(alpha) / L
 *
 *    where alpha is the bearing of the target off the velocity heading and L
 *    the distance to it. Multiplying by speed gives the yaw rate that traces
 *    it, because a car holding a steady slide angle rotates its nose and its
 *    path at the same rate -- the crab is constant, so d(travel)/dt =
 *    d(yaw)/dt. That equality is what makes this legitimate, and it is the
 *    reason the demand is a CURVATURE and not a heading: a heading target
 *    offset by the measured crab feeds its own error (more lock -> more crab ->
 *    more offset -> more lock) and was measured to diverge, 66s -> 74.7s.
 *
 * 2. WHICH STICK PRODUCES IT. The mapping in vehicle.ts is monotonic in the
 *    stick and every term in it is readable from state, so it inverts exactly:
 *
 *        arc = lerp(hold, full,    shaped)   for shaped >= 0
 *              lerp(hold, counter, -shaped)  for shaped <  0
 *        full = tight * ease,  hold = full * arcNeutral,  counter = tight * arcCounter
 *
 *    Note `counter` is deliberately NOT eased -- vehicle.ts eases only the
 *    inward half -- and `ease` reads r.driftTime, which is one frame stale
 *    here because the AI runs before the vehicle step. At a 0.55s time
 *    constant that is a 0.03% error and not worth carrying state to fix.
 *
 *    `surfaceFactor` is T.drift.surfaceGripInfluence applied to the surface
 *    under the car -- exactly 1 on tarmac and snow, 0.70 on ice. It multiplies
 *    the arc in vehicle.ts, so it has to divide the wanted arc here or the AI
 *    would ask an ice drift for a snow arc, get less, and answer the shortfall
 *    with more lock it also cannot have.
 *
 * Saturation is a real answer, not a failure: clamping at full counter-steer
 * means the corner needs less turn than the slide can give, which is exactly
 * when a human opens the stick too.
 */
function driftStick(
  r: RacerState,
  target: Vec3,
  speed: number,
  derived: ChassisDerived,
  loco: LocomotionProfile,
  surfaceFactor: number,
): number {
  // Both halves of `kappa = 2 sin(alpha) / L` have to be measured in the plane
  // the car is sliding in, not the XZ plane. On a wall-ride the XZ projection
  // of a 40-metre lookahead can shrink to nothing while the real distance is
  // unchanged, which inflates kappa without bound and pins the stick.
  //
  // `alpha` is the bearing of the target off the DIRECTION OF TRAVEL, about the
  // racer's own up. Everything the doc comment above says about why this is
  // measured from the velocity and not the nose is unchanged; only the axis it
  // is measured about moves.
  let L: number
  let alpha: number
  if (_grav) {
    const d = _aim(target, r)
    // In-plane distance: drop the component along `up`, which is just the ride
    // height and has nothing to do with how far down the road the corner is.
    const dn = d.x * r.up.x + d.y * r.up.y + d.z * r.up.z
    const px = d.x - r.up.x * dn, py = d.y - r.up.y * dn, pz = d.z - r.up.z * dn
    L = Math.max(T.ai.driftPursuitMinLookahead, Math.hypot(px, py, pz))
    alpha = signedAngleAround(r.vel, d, r.up)
  } else {
    const dx = target.x - r.pos.x
    const dz = target.z - r.pos.z
    L = Math.max(T.ai.driftPursuitMinLookahead, Math.hypot(dx, dz))
    const velYaw = Math.atan2(r.vel.x, r.vel.z)
    alpha = angleDelta(velYaw, Math.atan2(dx, dz))
  }
  const wantYawRate = ((2 * Math.sin(alpha)) / L) * speed * T.ai.driftPursuitGain

  // Undo everything vehicle.ts applies between `arc` and the yaw rate it sets.
  const falloff = 1 / (1 + speed / T.steering.yawSpeedFalloff)
  const arcWanted = wantYawRate
    / (STEER_SIGN * r.driftSide * falloff * loco.driftArcMult * surfaceFactor)

  const tight = T.drift.arcBase + T.drift.arcPerYaw * derived.maxYawRate
  const ease = T.drift.arcSustain
    + (1 - T.drift.arcSustain) * Math.exp(-r.driftTime / T.drift.arcEaseTime)
  const full = tight * ease
  const hold = full * T.drift.arcNeutral
  const counter = tight * T.drift.arcCounter

  const shaped = arcWanted >= hold
    ? clamp01((arcWanted - hold) / Math.max(1e-6, full - hold))
    : -clamp01((hold - arcWanted) / Math.max(1e-6, hold - counter))

  // Undo the stick curve, then put the stick back in world terms: the vehicle
  // reads `steer * driftSide`, so this is the inverse of inwardFromStick().
  const stick = sign(shaped) * Math.pow(Math.abs(shaped), 1 / T.drift.stickCurve)
  return clamp(stick * r.driftSide, -1, 1)
}

function hasRacerBehind(r: RacerState, s: RaceState, range: number): boolean {
  for (const o of s.racers) {
    if (o.id === r.id || o.finished) continue
    const gap = r.totalS - o.totalS
    if (gap > 0 && gap < range) return true
  }
  return false
}

/**
 * Is anyone roughly in the sights? Decides whether a forward-firing item is
 * worth spending.
 *
 * The flat path builds the nose from the compass yaw and measures in XZ, which
 * is right for a track that never leaves the ground. On a gravity track the
 * nose is `r.fwd` -- yaw is a derived bearing there and two cars on opposite
 * walls of a corkscrew can share one -- and the range is a true 3D distance,
 * because "45 metres behind me" on a loop is not 45 metres of ground plane.
 */
function hasRacerAhead(r: RacerState, s: RaceState, range: number, aimTolerance: number): boolean {
  if (_grav) {
    const f = r.fwd
    for (const o of s.racers) {
      if (o.id === r.id || o.finished) continue
      const dx = o.pos.x - r.pos.x, dy = o.pos.y - r.pos.y, dz = o.pos.z - r.pos.z
      const d = Math.hypot(dx, dy, dz)
      if (d > range || d < 4) continue
      if ((dx * f.x + dy * f.y + dz * f.z) / d > 1 - aimTolerance) return true
    }
    return false
  }
  const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw)
  for (const o of s.racers) {
    if (o.id === r.id || o.finished) continue
    const dx = o.pos.x - r.pos.x, dz = o.pos.z - r.pos.z
    const d = Math.hypot(dx, dz)
    if (d > range || d < 4) continue
    const dot = (dx * fx + dz * fz) / d
    if (dot > 1 - aimTolerance) return true
  }
  return false
}
