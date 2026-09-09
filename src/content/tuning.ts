/**
 * Every gameplay constant lives here. Nothing in sim/ or render/ may contain a
 * gameplay magic number. This object is deep-frozen in dev and exposed on
 * window.__TUNING__ so it can be poked live during a feel session.
 */
export const TUNING = {
  sim: {
    /** Fixed timestep. Never change this at runtime. */
    dt: 1 / 60,
    maxSubSteps: 5,
    gravity: -34.0,          // exaggerated for arcade jump arcs
    airDrag: 0.24,
    groundSnapDistance: 2.4,
  },

  /** stat (1-10) -> physical value */
  derive: {
    topSpeedBase: 46.0, topSpeedPer: 2.20,     // m/s
    timeToTopBase: 6.4, timeToTopPer: -0.34,   // s
    // GRIP REPRICED for the friction-budget pass. gripCoeff is now a physical
    // quantity -- it multiplies T.grip.lateralAccel to give the m/s^2 the tyres
    // can actually pull -- and it is read by the AI's corner model on top of
    // that, so a point of the grip STAT went from being worth about a finishing
    // position to being worth a race. At 0.075 the roster's grip 6 (Dray-9) and
    // grip 8 (Bulwark) sat 15% apart in cornering force, which measured
    // 7.0% / 29.0% win share over 200 races on Rustfall -- both outside the
    // 12-30% band on the strength of two stat points. At 0.050, with gripBase
    // raised to hold the roster mean where it was, the same two chassis sit
    // 9.8% apart and measure 18.0% / 22.0%. The stat still matters; it is no
    // longer a cliff. Nothing about the chassis DATA changed to get there,
    // which is the point -- the slope was wrong, not the roster.
    gripBase: 0.725, gripPer: 0.050,
    massBase: 400, massPer: 180,               // kg
    driftMultBase: 0.70, driftMultPer: 0.06,
    yawRateBase: 55, yawRatePer: 9,            // deg/s
    accelCurveGain: 2.4,
  },

  steering: {
    /** Stick deflection past which holding Drift enters a slide. */
    driftEnterThreshold: 0.22,
    /** Steering response half-life, seconds. Lower = snappier. */
    steerHalfLife: 0.075,
    /** Yaw authority retained while airborne. */
    airControl: 0.35,
    /** Speed at which yaw rate has fallen to 60% of its low-speed value. */
    yawSpeedFalloff: 44.0,
    reverseYawMult: 0.65,
  },

  /**
   * THE DRIFT.
   *
   * Design intent, in the player's words: "lean into the turn hard at a sharp
   * angle and allow a sharper turn while sliding; counter-steer to move the
   * vehicle outwards; on release, a boost in the direction the vehicle is
   * pointing." Measured against that on the flat-ring rig (tests/drift.test.ts):
   *
   *   sharper       drift out-turns full steering lock by 1.49-1.95x, and the
   *                 PATH radius shrinks by the same factor (34-45m vs 55-83m)
   *   sharp angle   31.8 degrees of crab, and the SAME 31.8 at every stick
   *                 position: sweeping full counter-steer to full lock in nine
   *                 steps, at 35 / 50 / top speed, on all five chassis, moves
   *                 the slide angle by 0.00 degrees and the ground speed by
   *                 0.00 m/s. (30.5 for hover, 27.8 for flight: the crab
   *                 target carries loco.driftArcMult.)
   *   outwards      counter-steer opens the line 94-109m over 1.5s against
   *                 full lock, never drops the slide, and keeps charging
   *   boost on nose 0.00 degrees off the heading one frame after release, at
   *                 the speed going in plus exactly releaseKick[tier]
   *
   * BALANCE NOTE (tools/balance.ts). This block used to be the single most
   * dangerous thing in the file to touch, because the AI drifted for ~45% of
   * every lap while steering by aiming its NOSE, with no model of the crab --
   * so any change to the slide reshuffled chassis win share through a
   * controller that could not see what it was doing. That is no longer true.
   * The AI now solves this mapping for the arc the corner needs
   * (T.ai.driftPursuitGain), which means it COMPENSATES for most of what is
   * tuned here instead of being knocked about by it: sweeping the pursuit gain
   * +/-15% moves the lap mean by under 1.1s, and the AI's saturation against
   * the ends of this stick sits under 5% of drift frames for every chassis.
   *
   * The practical consequence, and the thing to remember before tuning here:
   * changing the arc no longer changes how well the AI drives, so it no longer
   * launders itself into win share. It changes what the PLAYER feels, and the
   * balance consequences now land where they belong, in chassis.ts.
   */
  drift: {
    /** Time in seconds at 1.0x charge rate to reach each tier. */
    tierTimes: [0.65, 1.50, 2.60, 4.20],
    /** Speed bonus as a fraction of top speed. */
    tierBoost: [0.18, 0.28, 0.40, 0.52],
    /** Base boost duration for reaching each tier. */
    tierDuration: [0.80, 1.40, 2.20, 3.00],
    /**
     * On top of the tier base, every second of drift held adds this much boost
     * duration, capped. This is what makes a long committed slide pay more than
     * scraping into a tier and letting go.
     */
    durationPerSecond: 0.46,
    durationBonusCap: 2.40,
    /**
     * Counter-steering controls the slide rather than ending it. The stick maps
     * continuously between full counter-steer and full lock into the drift.
     *
     * THE FULL-LOCK ARC IS BUILT FROM THE CHASSIS'S OWN YAW AUTHORITY:
     *
     *   arc = arcBase + arcPerYaw * maxYawRate          (rad/s, at full lock)
     *
     * A single flat number cannot work here. maxYawRate is 55 + handling*9
     * deg/s, which spans 1.59 rad/s (Bulwark, Dray-9) to 2.37 (Filament), so
     * the flat 2.95 that used to sit here gave Bulwark an 1.86x gain over its
     * own best steering lock and Filament 1.18x — for half the roster the
     * drift was barely a corner tool. With base + slope every chassis clears
     * 1.45x, and the low-handling drift specialists still get the biggest
     * relative gain, which is what makes a drift their equaliser.
     *
     * Measured sustained yaw at ~60 m/s, drift vs full steering lock:
     *   solaire 1.68x   filament 1.55x   bulwark 1.94x   dray9 1.94x
     *   vector7 1.49x  (flight pays loco.driftArcMult 0.85)
     *
     * arcCounter is a NEGATIVE fraction of the full-lock arc: at full
     * counter-steer the nose swings AWAY from the corner, so the line genuinely
     * opens outwards instead of merely turning in more slowly.
     *
     * -0.085 was too timid to be a control. It bought about 27 m of outward
     * travel over 1.6s, which is a lot less than it sounds when the same slide
     * carries you 47 m the other way at lock: the useful half of the stick was
     * squeezed into a band the player could not feel. At -0.34 the nose swings
     * out at about a third of the lock arc, which is enough to genuinely drive
     * the car outwards mid-slide rather than just stop it tightening.
     *
     * It cannot go much past this. Counter-steer must not out-rotate the drift
     * itself, or a flick of the stick becomes a faster way round the corner
     * than committing to the slide, and the whole risk/reward of a drift
     * inverts.
     */
    arcBase: 1.72,
    arcPerYaw: 1.24,
    arcCounter: -0.34,
    /**
     * THE ARC EASES OFF AS THE SLIDE IS HELD.
     *
     * arcBase/arcPerYaw give the turn-in its bite, but holding that same rate
     * indefinitely is what made a long drift uncontrollable: a constant yaw
     * rate is a constant-radius spiral, so a corner that started as a perfect
     * arc keeps winding tighter relative to the road until the car is pointing
     * at the inside barrier. The arc now decays from full bite toward
     * `arcSustain` of it with time constant `arcEaseTime`, so the entry is as
     * sharp as before and the car settles into a line the player can hold.
     *
     * The ease applies only to the INWARD half of the stick. Counter-steer
     * keeps its full authority for the whole slide — the moment the drift
     * starts easing off is exactly when a player wants to be able to open the
     * line, and decaying both ends would take that away.
     *
     * 0.78 is the floor. Below it the drift stops being worth taking: at 0.72
     * Vector-7's sustained drift yaw falls to 1.29x its own full steering lock,
     * under the 1.35x that tests/drift.test.ts guarantees for every chassis,
     * and a drift that barely out-turns the steering wheel is a liability with
     * extra steps.
     */
    arcSustain: 0.78,
    arcEaseTime: 0.55,
    /**
     * THE STICK HAS A CENTRE THAT HOLDS THE SLIDE.
     *
     * arcNeutral is the inward arc held with the stick centred, as a fraction
     * of the (eased) full-lock arc. Full lock carves, centred holds, full
     * counter-steer opens the line — three positions, not a ramp between two.
     *
     * The old single lerp from arcCounter to full lock put the arc's SIGN FLIP
     * wherever the two happened to cross, which moved as arcCounter grew. At
     * -0.085 that crossing sat at about -0.48 of stick travel, so there was a
     * wide band of near-neutral stick that still turned inward. At -0.34 it
     * moved to within 0.04 of dead centre, and the drift reversed the instant
     * the stick crossed zero. For a keyboard player that means letting go of
     * the steering key throws the car the other way; for the AI of the time,
     * which aimed its nose and was blind to a 30-degree crab, it meant every
     * jitter into negative stick became a hard counter-steer — Vector-7 went
     * off the road 4.7 times a race and finished with a 0.0% win share. (The
     * AI half of that is fixed at source now: see T.ai.driftPursuitGain. The
     * centre is kept because it is right for the PLAYER, not because the AI
     * still needs it.)
     *
     * Clamping the AI's stick instead was measured and is worse in every form:
     * inward floors of 0.35 / 0.15 / 0 gave Solaire 49.5% / 70.0% / 50.5% and
     * lap times of 67.1 / 71.2 / 75.2s against a healthy 63.5. The stick needed
     * a centre, not a cage.
     */
    arcNeutral: 0.55,
    /**
     * HOW MUCH OF THE SURFACE THE DRIFT ARC FEELS.
     *
     * The drift is deliberately EXEMPT from the lateral friction budget in
     * T.grip: a full-lock slide traces a 34-45 m path radius at 55 m/s, which
     * is 70-90 m/s^2 of lateral acceleration against a budget of 34-39. That is
     * not an oversight, it is the arcade contract -- the drift is a commanded
     * rotation of the car about its own travel, and it is paid for in charge
     * time, in the exit alignment and in not being able to hold it forever.
     * Feeding it through the budget instead was measured and is not a tuning
     * question: it deletes the mechanic outright, taking the drift's advantage
     * over plain steering from 1.5-1.9x to under 1.0x on every chassis.
     *
     * But an exemption with no surface term at all means a drifting car cannot
     * feel ice, which on Cryostatic means the fastest way to answer an ice
     * corner is to press the drift button and stop caring. So the arc -- not
     * the slide angle -- carries the surface:
     *
     *     arc *= 1 + (SURFACE_GRIP[surface] - 1) * surfaceGripInfluence
     *
     * At 0.55 a drift on ice turns 25% less sharply than the same drift on
     * snow. The SLIDE ANGLE is untouched on purpose: slideTight is the authored
     * signature of this drift and four passes of work sit on it, so the surface
     * changes what a slide can DO, not what it looks like. On a full-grip
     * surface the whole term is exactly 1 and every measurement in
     * tests/drift.test.ts is unchanged.
     *
     * ai.ts applies the identical factor when it inverts the stick mapping
     * (see driftStick), so the AI asks for an arc it can actually get.
     */
    surfaceGripInfluence: 0.55,
    /**
     * Crab as the TANGENT of the slide angle: 0.62 = 32 degrees. This is the
     * angle the car actually holds — the slide is authored against ground
     * speed, not injected as extra lateral velocity, so drifting angles the
     * momentum instead of manufacturing 18% more of it.
     *
     * ONE VALUE, not a range across the stick. There used to be a `slideWide`
     * for the counter-steered end, which meant full counter-steer collapsed the
     * slide from 32 degrees to 10 and stood the car up mid-corner. Ground speed
     * was identical either way (58.7 m/s, the same as driving straight), but a
     * car that stops being sideways stops reading as fast, and it made
     * counter-steer feel like a brake. The stick now controls the nose's
     * rotation and nothing else; the angle is the angle.
     */
    slideTight: 0.62,
    /** How fast the slide angle reaches the commanded value, 1/s. Low enough
     *  that entry and counter-steer ease in (~0.14s), high enough that the
     *  angle is the player's, not the tyre model's. */
    slideResponse: 17.0,
    /**
     * The NOSE snaps on the entry frame: the yaw rate is set straight to the
     * drift arc instead of easing in over the steering half-life, which used
     * to leave a third of a second of skate between the button and the car
     * taking an angle.
     *
     * The SLIDE ANGLE deliberately does not snap — see slideYawLinked. Snapping
     * both is what produced the kick-out: the crab jumping to 32 degrees in one
     * frame rotates the car's travel 30 degrees outward while the nose has
     * barely moved, which is a lateral lurch off the racing line, not a drift.
     */
    entrySnap: true,
    /**
     * ZERO KICK-OUT. The slide angle may never OPEN faster than the nose is
     * rotating.
     *
     * The two are the same motion seen from different frames: if the nose turns
     * by dPsi and the car keeps travelling exactly where it was, the slide angle
     * grows by exactly dPsi. Growing it faster than that means the velocity
     * itself is being pushed outward, and that push is the kick. Capping the
     * rise at |yawRate| makes a drift entry strictly a rotation of the car
     * about its own travel: the nose bites immediately, the angle develops as
     * the nose swings ahead of the momentum, and the car never steps sideways.
     *
     * Only the rise is capped. The angle may CLOSE as fast as slideResponse
     * allows — that is grip recovering under counter-steer, and it never throws
     * the car anywhere.
     */
    slideYawLinked: true,
    /** Yaw response half-life while drifting. Much shorter than the on-road
     *  value so the arc tracks the stick immediately. */
    yawHalfLife: 0.028,
    /** Sanity clamp on the crab read back off the velocity. tan(58 deg). */
    crabCeiling: 1.6,
    /**
     * Response curve on the drift stick: both the arc and the crab read
     * `driftInward ^ stickCurve`, so the ends of the travel are unchanged and
     * the middle is softened. Above 1 the last third of the stick is where the
     * commitment lives, which is what makes a full-lock drift feel like a
     * decision rather than the default.
     *
     * It USED to be the single biggest balance lever in this block, back when
     * the AI aimed its nose and never accounted for the crab: at stickCurve 1.0
     * its habitual ~0.67 stick put it at 62% of full lock, where a 1.5-1.9x arc
     * plus a 32-degree slide made it over-rotate, saw at the wall and burn a
     * respawn, and 1.7 was what pulled the same stick back to 51%. Measured
     * over 12 solo laps per chassis at the time, the roster's lap-time spread
     * fell from 6.6s to 2.7s and respawns per race from 0.8 to 0.2.
     *
     * It is not a balance lever any more. The AI inverts this exponent exactly
     * (`^(1/stickCurve)`) on its way from a wanted arc back to a stick, so the
     * curve cancels for the AI and survives only where it was always meant to
     * live: in what the last third of a human's stick travel feels like.
     */
    stickCurve: 1.7,
    /**
     * Charge rate scale at full counter-steer vs full lock.
     *
     * THIS IS THE ONLY THING COUNTER-STEERING COSTS, and it is worth knowing
     * exactly how much, because "counter-steering slows the car down" was a
     * real player report and this is what is actually behind it. Measured over
     * a 3s held slide on an unbounded plain, every chassis:
     *
     *   ground speed          identical to the last decimal at every stick
     *   speed along the nose  identical (47.47 / 47.47 / 47.47 m/s, solaire)
     *   charge rate           1.000 / 0.850 / 0.700 x  (lock / centre / wide)
     *   time to Tier 3        3.4-4.3s at lock, 4.8-6.2s at full counter-steer
     *   tier after 3s         2-3 at lock, 1-2 at full counter-steer
     *
     * So holding counter-steer through a whole slide costs about 43% more
     * drift time per tier, which on a 3s drift is one tier -- one step down
     * the sustained boost AND one step down releaseKick. Nothing else moves.
     * That is the intended price of opening the line, and it is the honest
     * answer to the report: the car is not slower, the payoff is.
     */
    chargeAtWide: 0.70,
    /**
     * On release, how far the velocity is rotated onto the car's nose. The
     * whole point of a drift is that you exit pointing where you aimed, so the
     * boost has to fire along the heading, not along the crabbed momentum.
     * 0 = keep sliding, 1 = snap fully to the nose. Held at 1: the release is a
     * LINEAR launch along the heading, and any residue reads as the car sliding
     * out of its own boost.
     */
    releaseAlign: 1.0,
    /**
     * Instant ground speed added along the nose on release, per tier, m/s.
     *
     * The sustained boost (tierBoost / tierDuration) raises the speed CEILING
     * and lets the accelerator close the gap, which is the right shape for a
     * boost pad and the wrong one for cashing in a drift: the payoff arrives
     * over the next second and a half, so a perfectly-held Singularity slide
     * feels like nothing happened. The kick is the punch; the sustained boost
     * is still what carries it down the straight.
     *
     * Sized against the design maximum: 15 m/s on top of a ~58 m/s exit is
     * ~73 m/s, comfortably inside boostedTop at tier 3, so this never leans on
     * the SPEED_CEILING safety clamp. Measured, per chassis, on release:
     *
     *   gain           kick + 0.01-0.12 m/s, the frame's own acceleration and
     *                  nothing else, at every tier
     *   tier -1        no kick at all (0.11-0.17 m/s, i.e. the same residue)
     *   exit speed     73.3-80.6 m/s at Tier 3, against a boostedTop of
     *                  90.0-103.4 and a 1.35x clamp of 121.5-139.5
     *   3s later       peaks at 85.8-95.9 m/s; zero SPEED_CEILING hits in any
     *                  configuration tested
     *   survival       the launch decays with a 0.97-1.55s half-life and is
     *                  worth 18-25m of extra ground covered over 3s at Tier 3
     *
     * It does add speed the sustained boost would not: tapping a Tier-0 drift
     * every 0.72s parks a car 4.2-7.6 m/s ABOVE its own boosted top speed
     * indefinitely, because the kick arrives faster than the throttle model
     * bleeds it (excess decays on a ~1.7s time constant). That is inside the
     * envelope and it is bounded -- taps under ~0.65s bank no tier and give
     * exactly nothing, measured at 0.00 m/s over 40s -- but it is the third
     * time this model has been able to manufacture speed, so it is written
     * down rather than left to be rediscovered.
     */
    releaseKick: [3.0, 6.0, 10.0, 15.0],
    /** Relative impact speed above which drift charge is lost. */
    collisionCancelSpeed: 8.0,
    /** Re-enter a drift within this window to keep a chain. */
    chainWindow: 0.40,
    chainBonusPerStack: 0.15,
    chainMaxStacks: 3,
    /**
     * Seconds a GROUNDED chassis may be airborne before its drift is cancelled.
     * See the note at `canDrift` in vehicle.ts: without this, one bump deleted
     * a grounded drift and could not touch a hover or flight one. 0.25s covers
     * a kerb or a crest and is well under a ramp's ~2s of hang time, so a real
     * launch still ends the drift and arms the trick.
     */
    airGrace: 0.25,
    minSpeedToDrift: 12.0,
    hopHeight: 0.35,
    hopTime: 0.18,
  },

  /**
   * GRIP. The friction budget: how hard the tyres may turn the car's momentum,
   * and how much of that budget the engine is allowed to borrow.
   *
   * WHAT THIS REPLACED. Until this block existed, surface grip and the `grip`
   * chassis stat had no effect on cornering at all outside a drift. The
   * non-drift lateral block measured the velocity in the PRE-rotation basis and
   * rebuilt it in the POST-rotation one, so the nose dragged the whole momentum
   * round with it and `grip` was only the decay rate of a lateral residue that
   * steady cornering never generated. Measured (tests/surface.test.ts, and it
   * is worth keeping the number): a Solaire driven flat through Cryostatic's
   * ice sweeper at ice grip 1.00, 0.45 and 0.15 traced the SAME line to under a
   * millimetre, in the same 8.63s, with 0.00 degrees of slip and zero
   * off-track frames in all three. Every second ice cost was charged by one
   * line -- the AI's corner-speed model -- so ice was a belief held by the AI
   * and by nobody else, Rustfall's oil slick did nothing to a player, and the
   * GDD's Cryostatic hook, "two surfaces, one racing line", did not exist.
   *
   * THE MODEL. Velocity is now decomposed in the POST-rotation basis, so
   * turning the nose does NOT turn the momentum: it opens a slip angle. The
   * tyres pull that slip back toward zero with an acceleration
   *
   *     a = min(scrubRate * |lateral slip|, lateralAccel * effGrip)
   *
   * -- a linear cornering stiffness that SATURATES. Below saturation the car is
   * planted and the slip angle is scrubRate-small (a couple of degrees, which
   * is what ordinary cornering looked like before and still does). Above it,
   * the demand v * yawRate outruns what the surface can supply, the slip grows,
   * and the car runs wide. That is the whole mechanic: the car can now ask for
   * more than the surface has.
   *
   * WHY THE CONSTANT IS 34 AND NOT SOMETHING ROUNDER. Three constraints meet
   * here and only a narrow band satisfies all of them:
   *
   *   - The AI's corner model is now this same number (ai.ts cornerLimit reads
   *     lateralAccel directly), so the AI is finally braking for a limit that
   *     exists. Whatever goes here IS the corner-speed model.
   *   - Full steering lock must saturate at racing speed but not at parking
   *     speed. Full lock demands v * maxYawRate / (1 + v/44), which for the
   *     roster is 22-33 m/s^2 at 20 m/s and 37-56 at 50. At 34 the grounded
   *     chassis hold full lock to about 30 m/s on tarmac and understeer above
   *     it, which is the behaviour that makes a corner a decision.
   *   - Cryostatic's ice sweeper (~166 m radius) has to be losable. At 34 a
   *     Solaire on ice holds it to 52 m/s against a 61 m/s top speed, so
   *     taking it flat is a mistake -- which is what the track was authored to
   *     mean and what the physics did not implement.
   *
   * Raising it to ~50 makes full lock holdable everywhere and hands the ice
   * sweeper back (limit 63 m/s, above top speed); dropping it to the 26 the AI
   * used to guess with turns every full-lock corner into a permanent slide.
   */
  grip: {
    /**
     * Lateral acceleration one unit of effective grip buys, m/s^2. Effective
     * grip is derived.gripCoeff * loco.gripMult * SURFACE_GRIP[surface], so the
     * roster spans 34.0 (Dray-9) to 39.1 (Bulwark) on dry tarmac and 15.3-17.6
     * on ice. Gravity here is an arcade -34 m/s^2, so this is a mu of about
     * 1.0 on tarmac and 0.45 on ice, which is the point: SURFACE_GRIP is a
     * friction coefficient again.
     */
    lateralAccel: 34.0,
    /**
     * Cornering stiffness, 1/s: how fast slip is scrubbed off INSIDE the
     * budget. It sets the slip angle of ordinary, unsaturated cornering, which
     * settles at beta ~ yawRate / scrubRate independently of speed -- 2-3
     * degrees at racing pace, 5 at full lock at parking speed.
     *
     * The old code had the equivalent term at gripCoeff * 6, i.e. ~6.5/s, which
     * would put ordinary cornering at 8-9 degrees of permanent slip. It was
     * never noticed because the residue it decayed did not exist. 16 keeps the
     * car planted below the limit so that the SATURATION, not the stiffness, is
     * what the player feels.
     */
    scrubRate: 16.0,
    /**
     * THE FRICTION ELLIPSE. Longitudinal acceleration draws on the same budget:
     * what the engine may put down is
     *
     *     lateralAccel * effGrip * tractionRatio * sqrt(1 - latUse^2)
     *
     * with latUse the share of the lateral budget cornering is already using.
     *
     * This is not decoration, it is what stops every corner becoming a drift.
     * With an unlimited engine the steady state of "full lock, full throttle"
     * is a slide angle of atan(A / lateralBudget) -- about 27 degrees for a
     * Solaire -- because the engine keeps feeding the forward speed that the
     * scrub keeps converting into slip. Sharing the budget collapses that: at
     * the lateral limit there is nothing left to accelerate with, so the car
     * simply scrubs down to the speed the corner allows and grips again. That
     * is understeer, and it is the failure mode a player should get for
     * arriving too fast.
     *
     * tractionRatio is above 1 so that a straight line is untouched: at
     * latUse 0 the cap is 44-51 m/s^2 against a roster peak demand of 31-40, so
     * nothing about acceleration, top speed or the accel stat changes on dry
     * tarmac. On ice the same cap is 20-23 and a slow corner exit genuinely
     * costs the driver time.
     */
    tractionRatio: 1.30,
    /**
     * Floor under the ellipse, as a fraction of the straight-line cap. Pinned
     * at the lateral limit the ellipse gives exactly zero drive, which reads as
     * the throttle being disconnected; this leaves a sixth of it so the car
     * still crawls forward out of a slide.
     */
    tractionFloor: 0.16,
    /**
     * POWER OVERSTEER. Longitudinal demand the ellipse refuses is not simply
     * deleted: it spins the drive axle, and a spinning axle makes no lateral
     * force, so the tail steps out. The refused share becomes extra yaw in the
     * direction the car is ALREADY rotating, as a fraction of the chassis's own
     * maxYawRate and carrying the same speed falloff the steering does.
     *
     * This is the second half of "understeer and oversteer are both reachable":
     * arrive too fast and the nose washes wide; get on the power mid-corner on
     * a slick surface and the back comes round. They are told apart by the
     * throttle, which is how a driver tells them apart in a car.
     *
     * 0.45 is chosen so it is ALWAYS catchable: opposite lock commands a full
     * maxYawRate against this 0.45, through the identical falloff, so the stick
     * out-rotates the slide by better than two to one at every speed. Raising
     * it past ~0.9 would make a slide that no amount of counter-steer can
     * arrest, which is a spin the player cannot answer -- and the design
     * requirement is that losing grip is something you catch, not something
     * that happens to you. It does not apply inside a drift: the drift is an
     * authored slide and already owns the car's rotation.
     */
    powerOversteer: 0.45,
    /**
     * FRONT-AXLE SATURATION: the slip angle, in radians, at which the nose
     * starts to stop answering the stick, and the angle at which it has given
     * up all but `slipBiteFloor` of its authority.
     *
     * Without this the model has only one failure mode: the nose rotates
     * exactly as commanded while the car slides, so at the limit the yaw rate
     * is still whatever the stick asked for and the car simply scrubs speed
     * until the corner fits. That is a real effect but it is not what
     * understeer FEELS like -- understeer is turning the wheel further and
     * having nothing happen -- and it collapsed full-lock cornering to a crawl
     * (Filament settled at 17 m/s holding full lock on dry tarmac, because
     * nothing stopped it demanding 42 m/s^2 from a 38 m/s^2 surface forever).
     *
     * With it, the front simply runs out: the commanded yaw is scaled down as
     * slip grows, which pulls the demand v * yawRate back toward the budget and
     * gives a stable equilibrium instead of a runaway. Measured on the flat
     * plain at full lock and full throttle, dry tarmac: Filament now holds
     * ~48 m/s at ~10 degrees of slip rather than 17 m/s at 26.
     *
     * ONLY THE HALF OF THE STICK THAT DEEPENS THE SLIDE IS BITTEN. Steering the
     * other way -- unwinding, or opposite lock into an oversteer -- keeps full
     * authority at every slip angle, because that is the input that recovers
     * the car and taking it away is how a slide becomes a spin the player
     * cannot answer.
     */
    slipBiteStart: 0.10,
    slipBiteFull: 0.34,
    slipBiteFloor: 0.15,
    /**
     * Deadband on the rotation the wheelspin term follows, rad/s. Below it the
     * car is going straight and there is no direction for the tail to step out
     * in, so a standing start spins its wheels without also spinning the car.
     */
    oversteerMinYaw: 0.12,
  },

  ramp: {
    /** Extra forward speed a ramp grants on launch, fraction of top speed. */
    launchBoost: 0.16,
    launchBoostTime: 0.9,
    /** Steering authority while airborne off a ramp (vs the normal air value). */
    airControl: 0.55,
    /** Airborne longer than this and a clean landing pays a Tier-1 boost. */
    trickMinAir: 0.55,
    /** Widening of the clean-landing window for the flight class, which can
     *  orient itself with thrusters on the way down. */
    flightLandingBonus: 1.75,
  },

  boost: {
    /** Speed a boost pad grants, as a fraction of top speed. */
    // padDuration 1.20 -> 2.60. This number was DEAD CONFIG until the boost-pad
    // pump was fixed: stepVehicle calls applyBoost every frame a wheel is on a
    // strip, and the weakerExtend branch turned a 50m strip into ~26 seconds of
    // boost. Peak banked boostTime measured 58s on Rustfall and 209s on
    // Cryostatic, and racers held more than five seconds of it for 57-78% of
    // the race. Once that was honest, uptime fell 70-90% -> 44-56% and lead
    // retention fell to 41.5-42.0% on ALL THREE tracks -- the item pressure had
    // been balanced against a boost that never ran out, so a leader who took a
    // hit could no longer drive back out of it. Swept: 1.20 -> 42.0%,
    // 2.60 -> 51.0%, 4.00 -> 47.0%.
    //
    // 2.60 rather than 4.00 on design grounds, not on the sweep: a pad must
    // stay under a Tier 3 drift (0.52 for 3.00s), or driving over a strip beats
    // executing a Singularity and the skill ladder inverts. At 0.35 for 2.60s a
    // pad sits between Flare and Nova, which is what a free pickup should be.
    padMag: 0.35, padDuration: 2.60,
    /** When a new boost is weaker, it extends duration instead of stacking. */
    weakerExtend: 0.40,
    slipstreamMag: 0.12, slipstreamDuration: 1.50,
    slipstreamBuild: 1.50,      // seconds in the cone to trigger
    slipstreamRange: 34.0,
    slipstreamHalfAngle: 0.42,  // radians
    trickTier: 0,               // index into drift tiers
    trickMinAir: 0.45,
    trickLandTolerance: 0.44,   // radians
    rocketStartWindow: [0.05, 0.35],
    rocketStartTier: 1,
    bogTime: 1.20,
    /** Extra top speed per Charge pickup held. */
    chargePer: 0.005, chargeMax: 10, chargeLostOnHit: 3,
  },

  locomotion: {
    grounded: {
      rideHeight: 0.55, maxLift: 0, surfaceFrictionInfluence: 1.0,
      driftChargeMult: 1.00, driftArcMult: 1.00, gripMult: 1.00,
      knockbackMult: 1.00, fieldForceMult: 1.00, gapCross: 0,
      liftCapacity: 0, liftRegen: 0, cleanLandingTolerance: 0,
      // A wheel in vacuum still has a wheel, a contact patch and all of its
      // mass pressing it down -- spin gravity does not care whether there is
      // air. What it loses is the aero load that was helping to plant it, so
      // it gives up a little under half its lateral budget and keeps the rest.
      // This is the middle of the three and the anchor the other two are set
      // against.
      vacuumGripLoss: 0.42,
    },
    // Balance pass 2026-09: hover and flight used to carry driftArcMult above
    // 1.0 and gripMult well below it. driftArcMult scales BOTH the drift yaw
    // rate and the injected lateral slide, so >1.0 threw a huge outward crab
    // through Rustfall's banked ring; the AI throttle controller reads total
    // speed (crab included) and lifted off, and the excess lateral put both
    // classes off the surface. gripMult below 1.0 compounded it because the AI
    // corner-speed model reads gripCoeff only and never sees this multiplier,
    // so a low-gripMult class enters every corner above its real limit.
    // Class identity now lives in drift charge, knockback, field force, gap
    // crossing and lift rather than in a grip factor the AI cannot see.
    hover: {
      // driftChargeMult 0.85 -> 0.95 and knockbackMult 1.40 -> 1.25 are the
      // last small buff to Filament, the only hover chassis: at 14.6% win
      // share over 500 races it was the closest to the 12% floor. Both stay
      // on the correct side of grounded, so hover still charges a drift
      // slower and still gets shoved harder than a car with wheels.
      // surfaceFrictionInfluence 0.0 -> 1.0. A hovercraft ignoring surface
      // friction is the right fantasy and an unbalanceable mechanic: on
      // Cryostatic it handed hover and flight 96% of wins, and NOTHING closed
      // it -- cutting the ice from 39% to 17% of the lap moved the number by
      // one point, 5x crosswind moved it the wrong way, and halving the
      // immunity bought a tenth of the corner speed because the term enters
      // under a square root. See claude/spacegen-racing-cryostatic.md.
      //
      // It was written down at the time as a HOLDING POSITION, on the grounds
      // that surface grip had no effect on the physics at all and so making it
      // symmetric only balanced the AI field while leaving ice invisible to the
      // person holding the controller. That is no longer true: see T.grip.
      // surfaceFrictionInfluence 1.0 now means a hovercraft feels the ice in
      // its lateral budget, in its traction and in its drift arc, exactly as a
      // wheeled car does, and the value stays at 1.0 because the argument for
      // it was always symmetry rather than the physics being inert.
      // gripMult 1.00 -> 1.04. A whole point of the grip STAT moves a chassis
      // 15-20 points of win share, which cannot be landed inside a 12-30% band
      // on two tracks at once; gripMult is the same term with usable
      // granularity, so the fine trim lives here. See the wall-model pass in
      // claude/spacegen-racing-build-status.md.
      rideHeight: 1.00, maxLift: 0, surfaceFrictionInfluence: 1.0,
      driftChargeMult: 0.95, driftArcMult: 0.95, gripMult: 1.04,
      knockbackMult: 1.25, fieldForceMult: 1.50, gapCross: 4.0,
      liftCapacity: 0, liftRegen: 0, cleanLandingTolerance: 0,
      // HOVER IS THE CLASS THE VACUUM IS AIMED AT, and it is the one case
      // where the fiction and the mechanic agree without being argued into
      // agreement: a hovercraft corners by pushing on the cushion of air it is
      // floating on, and in vacuum there is no cushion. It gives up nearly two
      // five points more of its lateral budget than grounded gives up, which
      // is the GDD contract stated as a number.
      //
      // THE LADDER WAS 0.62 / 0.42 / 0.26 AND THAT SPREAD WAS THE WHOLE
      // BALANCE PROBLEM. At R=150 in full vacuum it priced the same corner at
      // 39.0 m/s for hover, 47.2 for grounded and 53.7 for flight -- a 14.7 m/s
      // spread on 420m of road. Measured at 200 races on The Hollow Choir:
      // Vector-7 46.5% of wins, Filament 1.5%, and tools/probe-sector.ts put
      // 1.17s of Vector-7's 2.79s per-lap advantage in the three bins that
      // carry the vacuum. The ORDER is the contract; the spread was never part
      // of it, and 0.47/0.42/0.38 keeps the order with a 3.3 m/s spread.
      //
      // The flight class's bill for coming out best here is charged in the
      // SAME mechanic and not by flattening this ladder: a vacuum has no air
      // to make aerodynamic lift with either. See the lift block in
      // sim/vehicle.ts.
      //
      // It is the one place in the locomotion table where hover is strictly
      // worse than grounded on the same metres. The standing caveat (see the
      // Aetherion report: "hover is grounded plus a field-force tax and minus
      // nothing") is why that was worth building.
      vacuumGripLoss: 0.47,
    },
    flight: {
      // maxLift stays at the GDD's 5.0m even though Lift is currently a net
      // loss: a racer above rideHeight * 1.8 is not `grounded`, and a racer
      // that is not grounded cannot pick up a boost pad, so Vector-7 gives up
      // about 5 points of boost uptime every time the AI uses its signature
      // mechanic. Clamping maxLift to 2.4 recovers that uptime and is worth
      // roughly half a finishing position -- which is exactly why it is not
      // done here: the fix belongs in stepVehicle's boost-pad test, not in a
      // number that quietly deletes the flight ceiling. If that is fixed,
      // re-run the gate; Vector-7 will need about half a position taken back.
      // surfaceFrictionInfluence 0.0 -> 1.0; see the note on hover above.
      rideHeight: 1.50, maxLift: 5.0, surfaceFrictionInfluence: 1.0,
      // gripMult 0.95 -> 0.98 -> 1.01. The 0.98 pass fixed Rustfall and left
      // Cryostatic marginal: 600 races put Vector-7 at 12.5% +/-2.6% against a
      // 12.0% floor, and lead retention at 45.2% against a 45.0% floor -- both
      // inside the gate by less than their own error bar, which is not a pass,
      // it is a coin toss that landed. Grip-adjacent changes land about twice
      // as hard on ice as on tarmac, so the same 0.03 that barely moves
      // Rustfall is worth ~7 points of win share on Cryostatic: 12.5% -> 19.3%,
      // retention 45.2% -> 49.0%, and the whole roster tightens from a
      // 12.5-25.2 spread to 17.7-22.2.
      driftChargeMult: 0.90, driftArcMult: 0.85, gripMult: 1.01,
      knockbackMult: 1.60, fieldForceMult: 1.80, gapCross: 999,
      liftCapacity: 4.0, liftRegen: 0.625, cleanLandingTolerance: 0.21,
      // Flight gains most, which is the GDD's contract and is expressed here
      // as losing least: a chassis that is already flying is the one least
      // dependent on a contact patch. See the note on hover for why the gap is
      // six points rather than the sixteen it started at.
      //
      // THIS IS A KNOWN RISK AND IT IS PAID FOR ELSEWHERE ON THE TRACK, not
      // softened here. Vector-7 was at 27.0% of wins on Aetherion against a
      // 30% ceiling with roster-high air time, so a section that hands the
      // flight class both the top-speed gift and the smallest cornering loss
      // needs a bill somewhere. The Hollow Choir's is the drum's spin drag --
      // a crosswind at fieldForceMult 1.80 through both walled drum corners.
      // See the header of content/tracks/hollowchoir.ts for the measurement.
      vacuumGripLoss: 0.38,
    },
  },

  collision: {
    /** Impulse ratio is clamped here so a tank cannot delete a bike. */
    maxMassRatio: 3.0,
    restitution: 0.28,
    bounceWallRestitution: 0.65,
    /** Fraction of a bounce-wall impact redirected along the wall tangent. */
    bounceWallForward: 0.60,
    grazeAngle: 0.26,        // rad, under this is a 5% scrub
    hardAngle: 0.79,         // rad, over this is a 40% scrub
    /**
     * How much of the ALONG-WALL speed a contact costs, at a graze and at a
     * square-on hit. Both are scaled by how hard the car actually went in
     * (`into / speed`), so the number a player pays is the impact they made.
     *
     * These used to multiply the WHOLE velocity vector, every contact frame,
     * which is what "the drift slows me down to zero" was. A car carving into
     * the outside barrier lost 52.3 -> 13.5 m/s on the first frame of contact
     * and then bled exponentially -- 8.8, 5.2, 4.8, 4.2, 3.8, 3.3 -- to a dead
     * stop while still on the track and still holding the throttle. Six seconds
     * of drift gave up 43-94 m/s to walls depending on chassis. A barrier can
     * take away the speed you drove INTO it; it cannot reach round and remove
     * the speed you were carrying ALONG it.
     */
    grazeScrub: 0.03,
    hardScrub: 0.22,
    /**
     * Fraction of the into-wall speed a normal barrier CONVERTS into travel
     * along itself rather than deleting. This is the difference between a
     * barrier that stops you and one that redirects you, and it is what makes
     * wall contact survivable in a kart racer: arriving at a steep angle should
     * cost you the corner, not the race.
     *
     * Lower than bounceWallForward (0.60) -- a bounce wall is a mechanic you
     * aim for, a normal barrier is a mistake you survive. As with bounce walls,
     * the result is capped at the speed carried in: redirect, never pump.
     */
    wallRedirect: 0.45,
    /**
     * Along-wall friction while scraping, per SECOND. A rate, not a per-frame
     * multiplier: the whole failure above came from a per-frame factor applied
     * to sustained contact, and 0.40 a frame is 100% a second. Scraping a wall
     * should cost a driver something and should never park them.
     */
    wallFriction: 0.55,
    /**
     * Into-wall speed at which a contact costs the FULL angle scrub. Below it
     * the bite scales down linearly, so leaning on a barrier is not charged as
     * a crash.
     *
     * The bite was first written as a ratio, `into / speed`, which looks right
     * and inverts at low speed: a car already stopped against a wall with the
     * throttle on has a tiny `into` and a tinier `speed`, so the ratio stays
     * near 1 and it keeps paying full crash price forever. Measured that way
     * the car still bled 8.6 -> 3.3 -> 2.0 -> 1.2 -> 0.7 -> 0.4 while pinned.
     * An absolute speed cannot invert.
     */
    /**
     * Seconds over which a barrier's IMPACT bite fades to nothing while contact
     * is unbroken. Past it a scrape costs only `wallFriction` per second. See
     * the note at `impactShare` in vehicle.ts: without this a car leaning on a
     * wall mid-drift paid a full collision sixty times a second and was scrubbed
     * from 61 m/s to 13 in one second, on the throttle.
     */
    impactFadeTime: 0.18,
    hardImpactSpeed: 18.0,
    /**
     * BARRIERS DEFLECT, THEY DO NOT CATCH. Max rad/s the wall turns a car's
     * nose toward the wall's own direction on contact.
     *
     * Without it, a car that arrives nose-first is held at the barrier by
     * clampToTrack while its own throttle keeps driving it in, so every frame
     * the wall deletes the speed the engine just made and the player is parked
     * with no way out but reverse. That is what a six-second drift into the
     * outside wall felt like. Real Armco does this: it turns you along itself.
     *
     * Scaled by the impact and heavily weighted toward LOW speed -- at racing
     * speed this is a light scrape that barely touches the player's steering,
     * at a standstill it is the thing that points them back down the road.
     */
    wallDeflect: 3.2,
    /** Speed at which the deflect drops to its weakest, m/s. */
    deflectFullSpeed: 30.0,
    racerRadius: 1.9,
  },

  offTrack: {
    /**
     * Beyond this fraction of half-width, the racer is off the surface.
     * Raised from 1.06: Track.project() measures lateral offset in the banked
     * basis while ride height is applied vertically, so a chassis reads a
     * phantom lateral of rideHeight * sin(bank) -- 0.84m for the 1.5m flight
     * class on Rustfall's 34-degree cargo ring, against 0.31m for a grounded
     * car. At 1.06 that phantom alone put hover and flight off the surface
     * mid-corner (2.4 respawns per race for Vector-7); at 1.10 it does not.
     */
    edgeTolerance: 1.10,
    grip: 0.55,
    speedMult: 0.62,
    /** Seconds off-track or falling before a respawn triggers. */
    respawnAfter: 1.30,
    respawnDuration: 1.80,
    respawnSpeedFraction: 0.30,
    fallY: -45,
    /**
     * Last-resort wrong-way recovery: a racer that has come to rest facing
     * back down the track is eased around rather than left to drive into
     * oncoming traffic.
     *
     * wrongWayRate 2.6 rad/s is deliberately ABOVE the roster's best steering
     * authority (Filament, 2.37 rad/s at a standstill) so a car nobody is
     * driving comes round briskly. That also means the block can only ever be
     * armed when the player is NOT asking for something: at this rate it wins
     * every argument with the stick. Hence wrongWayStickIdle, and the brake
     * check next to it in vehicle.ts -- with a speed gate alone, a player
     * holding full lock could not hold any heading past wrongWayAngle on any
     * chassis, and a reverse (which always starts from a standstill and does
     * not cross wrongWaySpeed for 2.0s) was rotated 81 degrees before the
     * speed gate ever closed.
     */
    wrongWaySpeed: 14,
    wrongWayAngle: 1.75,
    wrongWayRate: 2.6,
    /** Stick deflection under which the controls count as idle for the
     *  wrong-way block. Above every input deadzone in the game (pad 0.12,
     *  touch stick 0.10) so a resting stick still reads as hands-off. */
    wrongWayStickIdle: 0.15,
  },

  items: {
    boxRespawn: 4.0,
    chargeRespawn: 7.0,
    rouletteTime: 1.40,
    rouletteTimeTrailing: 0.90,
    noItemsBeforeTime: 3.0,
    secondSlotFromPosition: 7,
    staggerShield: 2.5,
    /**
     * The tail of a spin-out is spent straightening into the racing direction,
     * so a player never finishes a spin pointing back into traffic.
     */
    spinAlignTime: 0.55,
    spinRate: 7.5,
    empLobbyCooldown: 12.0,
    /** Measured at 8.0 and 11.0 over 300 races each: 53% vs 55% lead
     *  retention, inside the noise. The Alpha weights carry this, not the
     *  lockout, so the lockout stays where the GDD put it. */
    alphaLockoutBeforeFinish: 8.0,
    spinRetainVelocity: 0.40,
  },

  camera: {
    // Tuned against a 4.7m-long chassis. At 5.2m the camera sat inside the
    // rear bumper and the car filled the lower third of the frame.
    distance: 9.0, height: 3.6, lookAhead: 13.0,
    /**
     * FRAMING ON A SCREEN THAT IS NOT 16:9.
     *
     * fovRest/fovBoost are VERTICAL fields of view, and a PerspectiveCamera
     * holds the vertical fixed and widens horizontally as the aspect grows. On
     * a desktop 16:9 that means a 94-degree horizontal at rest. On a phone held
     * in landscape -- 2.25:1 on the designer's handset -- the same 62 degrees
     * vertical opens to 107 horizontal, and mid-boost (86 + a 30-degree dolly)
     * it reaches 129. That is geometrically correct and visually a fisheye:
     * everything toward the edges stretches, and the picture reads as skewed.
     *
     * So the horizontal field is anchored to the aspect the game was authored
     * and signed off at, and the vertical is derived from it. At exactly
     * `refAspect` nothing changes -- desktop renders the identical frame it
     * always did -- and on anything wider the extra width is spent on seeing
     * more road rather than on distorting the road you can already see.
     */
    refAspect: 16 / 9,
    /**
     * How far the vertical field may be squeezed to hold the horizontal, as a
     * fraction of the authored value. Real phone landscape (2.16-2.25:1) lands
     * around 0.82, so this floor only bites on genuinely extreme aspects, where
     * the alternative -- losing most of the road ahead -- is worse than a
     * little extra width.
     */
    minVerticalScale: 0.75,
    fovRest: 62, fovBoost: 86,
    posHalfLife: 0.12, yawHalfLife: 0.20, fovHalfLife: 0.18,
    /**
     * DOLLY ZOOM (the vertigo shot) on a drift release.
     *
     * A plain FOV spike is a zoom: everything, car included, gets smaller as
     * the frame widens, which reads as the camera backing off at the exact
     * moment the car is supposed to be fired down the road. The vertigo effect
     * is FOV and camera DISTANCE moving in opposite directions so the SUBJECT
     * stays the same size on screen while the background stretches away behind
     * it. On-screen size goes as 1 / (dist * tan(fov/2)), so holding it fixed
     * means dist scales by tan(fovRest/2) / tan(fov/2).
     *
     * dollyPull is how much of that compensation to apply. 1.0 is a textbook
     * vertigo and pins the car dead still in frame; a little under keeps some
     * of the shove, which reads better on a car that is genuinely accelerating.
     * At 0.85 the residual is (tan ratio)^0.15 -- measured, the car holds
     * within 3.6% of the size it would have had with no shot at all, for the
     * whole impulse. dollyFov is the extra FOV at full impulse, on top of
     * whatever the speed and boost terms are already asking for; it lands as a
     * 12.8-degree gap over the no-shot camera at the peak, paid for by pulling
     * the camera 3.9m in.
     *
     * BOTH HALVES MUST ACT ON THE SAME THING. See camera.ts: the pull-in is
     * applied to where the camera ACTUALLY is, not to the distance the rig is
     * aiming for. At 76 m/s the position damping leaves the camera 20m behind
     * a car whose target distance is 10.3m, so scaling the target moved it by
     * half of what the FOV asked for and the shot inverted into a zoom-out.
     */
    dollyFov: 30,
    dollyPull: 0.85,
    /** Impulse decay half-life, seconds. Short: this is a punch, not a state. */
    dollyHalfLife: 0.26,
    /** Impulse per drift tier cashed in. Tier 0 barely registers by design. */
    dollyPerTier: [0.30, 0.55, 0.80, 1.0],
    /**
     * Camera bank at full lock, radians. Scaled by how far the stick is
     * committed, so counter-steering visibly levels the frame back out.
     */
    driftRoll: 0.155,
    /** Floor on that scaling: what is left of the bank at full counter-steer. */
    driftLeanFloor: 0.34,
    /** Extra bank per rad/s of yaw rate. */
    driftRollYaw: 0.035,
    /**
     * How far the camera swings from the nose toward the direction of travel
     * while drifting. Sitting square behind the nose is what made a 32-degree
     * slide read as "driving straight while the scenery slides sideways": the
     * whole point of a drift is being able to SEE the car pointing somewhere
     * other than where it is going. At 0.55 a full-lock slide puts the car
     * about 17 degrees across the frame and a counter-steered one about 8, so
     * the two ends of the stick are told apart from the picture alone.
     */
    driftFollowVelocity: 0.55,
    shakeBoost: 0.22, shakeHit: 0.85,
    lookBackYaw: Math.PI,
  },

  ai: {
    /** Lookahead distance along the spline, scaled by speed. */
    lookaheadBase: 18.0, lookaheadPerSpeed: 0.55,
    /**
     * The safety margin the AI leaves against the corner-speed limit -- and,
     * since that limit became real physics, an honest one: at c the AI spends
     * c^2 of the lateral friction budget and keeps 1 - c^2 for the racing line,
     * the mid-corner bumps, the traffic and the fact that curveFar is a
     * smoothed lookahead rather than the curvature the car will meet.
     *
     * IT STAYED AT 0.86, and that is the finding, not an oversight. The number
     * it multiplies changed meaning underneath it -- cornerLimit was
     * sqrt(effGrip * 26 / k) against a physics engine with no lateral limit at
     * all and is now sqrt(lateralAccel * effGrip / k) against one that has --
     * so the same 0.86 asks for sqrt(34/26) = 14% more corner speed than it
     * used to. The obvious move was to take that 14% back out; it is the wrong
     * move, because what it buys is not lap time, it is LEAD RETENTION.
     * Measured on Rustfall (300 races, except where marked):
     *   0.86   lap 55.91s   retention 48.3%   18.0 / 19.0 / 21.7 / 18.7 / 22.7
     *   0.84   lap 56.53s   retention 45.0%   16.3 / 22.3 / 18.7 / 19.0 / 23.7
     *   0.82   lap 57.13s   retention 42.7%   21.8 / 23.3 / 20.8 / 16.0 / 18.0
     *          (600 races -- out of the bottom of the retention band)
     *   0.72   lap 59.35s   retention 36.0%   200 races
     * A slower field runs closer together, and a race decided in the pack is a
     * race the leader does not keep. So the AI is left driving at 0.86 of a
     * limit that now exists, spending 74% of the lateral budget and holding 26%
     * back for the racing line, the traffic and the fact that curveFar is a
     * smoothed lookahead rather than the curvature the car will meet.
     */
    corneringCaution: 0.86,
    /**
     * How much of the curvature the car is CURRENTLY in the corner-speed model
     * respects, relative to the corner it is looking at. 1.0 = hold the corner
     * speed all the way through; 0 = the old behaviour, which released the
     * brake as soon as the lookahead point cleared the apex and put the car on
     * the exit kerb while it was still turning. Below 1 because the exit of a
     * corner genuinely does open out and a car that respects the apex radius
     * until the very end leaves time on the road.
     */
    /**
     * Minimum seconds the AI holds a drift once it has committed to one,
     * regardless of what the hold gate says. Bridges the gap between the entry
     * gate (6m ahead, 30m window) and the hold gate (at the car, 20m window);
     * see the long note in ai.ts. Must sit ABOVE tierTimes[0] (0.65s) or a
     * committed drift banks exactly nothing while still costing the exit
     * alignment -- which is what 0.45 did, and it fell hardest on the three
     * low-handling chassis that open the most marginal drifts.
     */
    driftMinHold: 0.70,
    cornerHoldShare: 0.85,
    /**
     * THE BRIDGE PLANNER. How far ahead a top-skill AI reads the phasing
     * light-bridges, metres, and how much of that a bottom-skill AI gets.
     *
     * This is the AI's whole answer to a hazard it cannot brake for: it does
     * not brake FOR a bridge, it picks a cruising speed that puts it on every
     * span inside the horizon while that span is solid. 260m covers Aetherion's
     * whole causeway from the corner before it, so a racer solves the wave once
     * on the approach instead of re-solving each span with 32m of solid ground
     * to fix its speed in.
     *
     * The skill scale is the honest way to make a bottom-skill AI worse at a
     * TIMING problem. Braking earlier is not worse at timing, it is safer at
     * it; reading it LATE is worse. skill 0 gets 0.55 of the horizon (143m,
     * which reaches the causeway from about the first span) and skill 4 gets
     * the full 260m. Measured falls per race scale accordingly, which is
     * exactly what a skill band is supposed to buy.
     */
    bridgeHorizon: 260,
    bridgeHorizonSkill: [0.55, 0.66, 0.77, 0.88, 1.0],
    /**
     * The speed factors the planner searches, as fractions of the speed it
     * would otherwise ask for. Coarse on purpose: a fine search finds a knife
     * edge of a window and then loses it to the throttle lag on the way to it,
     * and 6% steps are about the resolution the longitudinal controller can
     * actually deliver over the 260m approach.
     *
     * The last entry is the give-up speed. Nothing in the list clearing every
     * span means the racer is out of phase with the causeway, and the only move
     * left is to be slow enough that the window comes back round to meet it.
     */
    bridgeSpeedSteps: [1.0, 0.94, 0.88, 0.82, 0.76, 0.70, 0.64, 0.58, 0.50],
    /** How aggressively AI seeks the racing line. */
    lineGain: 0.055,
    driftCommitment: 0.72,
    /**
     * IN-DRIFT STEERING: the AI stops aiming its NOSE and solves for the stick
     * that makes its PATH turn at the rate the racing line needs.
     *
     * Outside a drift the AI steers on a nose heading error, which is correct:
     * with no crab the nose and the travel direction are the same thing. Inside
     * one they are not — measured over 43k drift frames on Rustfall, the nose
     * leads the travel direction by 18.8 degrees on average and 29 at p90. The
     * heading-error controller reads that lead as over-rotation and commands
     * opposite lock, so the AI spent 49.6% of every drift on the counter-steer
     * side of the stick with sustained counter-steer runs of 750ms median and
     * 2.7s at p90. That was harmless while arcCounter was a token -0.085; at
     * -0.34 it is a real outward push and the AI steered itself off the road
     * with it (Vector-7: 4.7 respawns a race, 0.0% win share).
     *
     * The replacement is pure pursuit on the VELOCITY heading — the angle
     * alpha from the direction of travel to the lookahead point gives a
     * CURVATURE, kappa = 2 sin(alpha) / L — which is then converted to a yaw
     * rate and fed backwards through the (monotonic, invertible) stick-to-arc
     * mapping in vehicle.ts. Aiming the velocity by OFFSETTING the nose target
     * instead was measured and diverges: steering to increase the nose lead
     * increases the crab, which increases the offset. A curvature has no such
     * term, and the kick-out cap (drift.slideYawLinked) makes it provably
     * stable — with the slide angle unable to open faster than the nose
     * rotates, the direction of travel can never swing away from the corner, so
     * alpha can only shrink as the car turns in.
     *
     * What it bought, at 200 races: the mean lap went 67.6s -> 57.5s, respawns
     * per race went 1.21/2.71/0.77/1.68/1.60 -> 0.46/0.66/0.47/0.56/0.58, and
     * the AI's own heading error while sliding -- nose to lookahead point --
     * fell from 27.4 degrees to 8.8. Drifts per race HALVED (462 -> 284) while
     * Tier 3 Singularity went from 1.1% of them to 11.8%: the AI stopped
     * scrabbling in and out of short slides and started holding real ones.
     *
     * The gain is a scale on the demanded curvature and 1.0 means "ask for
     * exactly the arc the geometry says", which is also what measures best
     * (200 races each, on the roster in chassis.ts):
     *   gain 0.85   58.20s   20.0 / 14.0 / 30.0 / 13.0 / 23.0
     *   gain 1.00   57.50s   16.5 / 21.5 / 20.5 / 19.5 / 22.0
     *   gain 1.15   57.10s   13.5 / 16.5 / 26.0 / 15.0 / 29.0
     * Either side of 1.0 spreads the roster back out -- under-asking lets the
     * best drifter (Bulwark) keep more of its advantage, over-asking hands it
     * to the chassis with the most arc to spend -- so the value that closes the
     * geometry honestly is also the value that leaves the roster flattest.
     */
    driftPursuitGain: 1.0,
    /**
     * Floor on the pure-pursuit lookahead distance L, metres. L divides the
     * curvature, so a target the car has driven on top of would demand an
     * unbounded arc. Never reached in practice — the shipped lookahead is
     * 18 + 0.55v, so ~50m at racing speed — it exists so the controller cannot
     * divide by a small number if a racer is ever spawned onto its own target.
     */
    driftPursuitMinLookahead: 8.0,
    itemUseDelay: [0.4, 1.8],
    /**
     * Per-skill-band multiplier on effective top speed. Never exceeds 1.0.
     *
     * Scaled down 2% across the board for the friction-budget pass, and it is
     * worth being explicit about why, because it looks like a nerf and is
     * actually a decoupling. corneringCaution and skillSpeed pull on different
     * things: caution decides how close to the friction limit the AI corners,
     * which is what sets LEAD RETENTION (a faster field spreads out, and a
     * leader with a gap keeps it), while skillSpeed is a flat scale on pace,
     * which is what sets LAP TIME. Once the corner limit became real the AI got
     * 14% more corner speed at the same caution and the mean lap fell to the
     * floor of the 55-75s target; taking the caution back out fixed the lap
     * time and dropped Cryostatic's lead retention to 41.8%. Two knobs, two
     * targets: caution stays where the racing wants it and this carries the
     * pace.
     */
    skillSpeed: [0.867, 0.897, 0.926, 0.953, 0.980],
    /**
     * mistakeChance 0.055 -> 0.020 and reactionTime 0.16 -> 0.11.
     *
     * Both are randomness in the AI's LINE, and both got more expensive when
     * grip became real: a line error used to cost a little lateral offset that
     * the next frame's steering pulled straight back, and now it costs whatever
     * the resulting slip scrubs off. Measured on Cryostatic at 400 races, from
     * a 41.8% baseline, each on its own moves lead retention to 44.8% / 45.0%,
     * and together with the pace scale above to 46.5%. Nothing else in the
     * report moves: position changes per race stay at ~90, so the racing is
     * exactly as busy, it is just less of it caused by the AI wandering off its
     * own racing line.
     */
    mistakeChance: 0.020,
    reactionTime: 0.11,
    /**
     * HOW MUCH OF THE SURFACE GRIP DELTA THE AI'S CORNER MODEL BELIEVES.
     *
     * cornerLimit reads `1 + (SURFACE_GRIP[s] - 1) * surfaceFrictionInfluence`
     * and this scales that delta: 1.0 is "brake for ice exactly as if
     * SURFACE_GRIP were a real cornering limit", 0.0 is "ignore the surface".
     * It exists for the same reason hazard.windScale does -- so the balance
     * harness can sweep it without editing source -- and because on an ice
     * track it is the single most load-bearing number in the sim.
     *
     * IT USED TO BE A SEPARATE NUMBER FROM THE PHYSICS BECAUSE THE PHYSICS DID
     * NOT IMPLEMENT THE THING IT MODELS. Outside a drift, stepVehicle rebuilt
     * the velocity in the POST-rotation basis every frame, so the nose dragged
     * the whole momentum round with it and `grip` only decayed a lateral
     * residue that steady cornering never generated; sweeping SURFACE_GRIP.ice
     * over 1.00 / 0.45 / 0.15 through Cryostatic's ice sweeper gave the SAME
     * trajectory to within a millimetre, the same 8.63s, and 0.00 degrees of
     * slip. Every second ice cost was charged here, by the AI, and nowhere
     * else. The note that used to sit under this said the choice was between
     * lowering this number -- which deletes the GDD's Cryostatic hook for the
     * player as well as the AI -- and raising the physics to meet it. The
     * physics was raised: see T.grip.
     *
     * SO WHAT IS IT NOW? A personality knob, and only that. cornerLimit is
     * built from the same lateralBudget() the tyres use, so 1.0 means "brake
     * for what is actually under the car" and anything less means the AI is
     * deliberately mis-modelling a surface it can feel. It stays at 1.0, and
     * for the first time that needs no defending. Measured at 600 races on
     * Cryostatic with the shipped roster, dropping it costs the racing:
     *   1.0   21.2 / 27.5 / 16.5 / 18.5 / 16.3   lap 62.9s   retention 47.0%
     *   0.5   17.5 / 26.5 / 14.0 / 27.0 / 15.0   lap 61.5s   retention 39.5%
     *   0.0   16.5 / 24.5 / 13.0 / 30.5 / 15.5   lap 60.8s   retention 42.0%
     * (the 0.5 and 0.0 rows at 200 races, pre-roster-pass). A blind AI carries
     * snow speed onto ice, hands the race to the chassis with the most top
     * speed and the least grip, and drops lead retention out of its band.
     */
    surfaceCaution: 1.0,
  },

  /**
   * Track hazards that are not geometry. Authored per node on TrackDef; these
   * are the shared response curves.
   */
  /** Grip multiplier per track surface. See SURFACE_GRIP in sim/track.ts. */
  surfaceGrip: {
    tarmac: 1.0, ice: 0.45, snow: 1.0, gravel: 0.70, oil: 0.30, metal: 0.95, boost: 1.0,
  } as Record<string, number>,

  /**
   * THE GRAVITY SYSTEM. Only bites on tracks that author up-vectors.
   */
  /**
   * HARD VACUUM. Only bites on tracks that author TrackNode.vacuum.
   */
  vacuum: {
    /**
     * HOW MUCH OF `T.sim.airDrag` A FULL VACUUM TAKES AWAY, 0..1.
     *
     * The honest note first, because it changes what this number means.
     * `T.sim.airDrag` has been in tuning since the first pass and IS NOT READ
     * BY ANYTHING -- grep the repo. There is no drag term in stepVehicle: the
     * longitudinal controller drives ground speed toward `derived.topSpeed`
     * asymptotically, so air resistance in this sim is not a force, it is
     * already baked into the top speed the roster was tuned at. Adding a real
     * drag term would have been the physically tidy move and it would have
     * moved all three shipped circuits, which the brief forbids and which is
     * the right call anyway: they are balanced against the speeds they have.
     *
     * So the vacuum removes the drag by RAISING the asymptote instead, and
     * `airDrag` finally does the job it was named for -- it is read as "the
     * fraction of a car's thrust that the air was eating at top speed". At
     * terminal velocity thrust equals drag and drag goes as v^2, so removing a
     * fraction f of it multiplies top speed by 1/sqrt(1 - f). At airDrag 0.24
     * and dragRemoved 1.0 that is 1.147x: Bulwark's 59.2 m/s becomes 67.9 and
     * Dray-9's 63.6 becomes 72.9.
     *
     * It is deliberately the SAME multiplier for every class. The medium is a
     * property of the road, not of the car; the class contract lives entirely
     * in `vacuumGripLoss` below, where it can be read in one place.
     */
    dragRemoved: 1.0,
  },

  gravity: {
    /**
     * Seconds for a racer's up-vector to close half the gap to the surface it
     * is heading for, while airborne. Grounded, the frame snaps instead: the
     * car is ON the road and a lagging frame is visibly wrong.
     *
     * 0.12 reads as the car rotating to meet the landing. Much faster and it
     * snaps at the lip; much slower and it lands on its side.
     */
    airAlignHalfLife: 0.12,
    /**
     * How far past the road edge a racer keeps its surface gravity before the
     * track lets go and hands it back to world down, in multiples of the half
     * width. Leaving a wall-ride sideways should drop you off the wall, not
     * hold you to an invisible extension of it.
     */
    releaseEdge: 1.35,
    /**
     * Seconds for the CHASE CAMERA's up-vector to close half the gap to the
     * car's own up.
     *
     * This is a framing constant, not a physics one, and it is deliberately
     * about twice the racer's own airAlignHalfLife. The car snaps onto the wall
     * because it is on the wall; the camera must not, because a rig that rolls
     * as fast as its subject reads as the WORLD tipping over rather than the
     * car climbing. Lagging it lets the horizon visibly swing.
     *
     * 0.25 spends roughly three quarters of a second visibly rolling through a
     * 90-degree wall entry, which is about the length of the entry itself.
     * Much shorter and the roll is over before the player registers it; much
     * longer and the camera is still unwinding on the next corner, and during a
     * fast corkscrew never lines up with the road at all.
     */
    cameraUpHalfLife: 0.25,
    /**
     * Metres BELOW the deck past which a racer is falling rather than driving,
     * on a gravity track.
     *
     * The altitude controller's last branch is a spring that snaps a racer to
     * the surface, and it is unsigned: a car 30m under the road is "close to
     * the road" as far as it is concerned and gets yanked up onto it. That
     * never mattered while the only way to get below the deck was to drive
     * there, and it matters the moment a phasing bridge can remove the deck
     * from under a moving car. -2.5m is well below suspension travel and well
     * above anything a legal ride height reaches.
     *
     * Gravity-track only, so the shipped flat tracks keep the spring they were
     * balanced on, unsigned and all.
     */
    fallThrough: -2.5,
  },
  hazard: {
    /**
     * CROSSWIND. TrackNode.wind is a lateral acceleration in m/s^2, scaled per
     * locomotion class by LocomotionProfile.fieldForceMult -- grounded 1.0,
     * hover 1.5, flight 1.8, exactly the ratios the GDD specifies for
     * Cryostatic's blizzard band. Those numbers already existed and had never
     * been read by anything; this is the mechanic they were authored for.
     *
     * A dead-steady crosswind is just a lane offset the player trims out once
     * and forgets, so the force breathes: a slow gust envelope driven by race
     * time, which keeps it deterministic (no RNG, no per-racer state) while
     * making the band something you actively fight.
     */
    /**
     * Global multiplier on every authored TrackNode.wind. Exists so the balance
     * harness can sweep wind strength across hundreds of races without editing
     * track content, which is the only honest way to find out how much of a
     * counterweight a crosswind actually is.
     */
    windScale: 1.0,
    windGustPeriod: 3.7,
    /** Gust envelope depth: 0 = steady, 1 = swings between 0 and 2x. */
    windGustDepth: 0.45,
    /**
     * A second, faster ripple at an incommensurable period so the gusts never
     * settle into an obvious rhythm the player can memorise.
     */
    windRipplePeriod: 1.31,
    windRippleDepth: 0.18,

    /**
     * CRACKING ICE. The lap on which fragile shelves give way, counted from the
     * LEADER's lap rather than each racer's own: it is a single telegraphed
     * event that everyone sees happen, not eight private ones, which is both
     * better spectacle and the only version that survives netcode later.
     */
    crackLap: 3,
    /**
     * What a cracked shelf becomes. It keeps its width -- the drivable ribbon
     * does not move, so the AI's line stays valid -- but loses its walls and
     * turns to bare ice under everyone.
     */
    crackedSurface: 'ice' as const,

    /**
     * PHASING LIGHT-BRIDGES. See TrackNode.phase.
     *
     * The period is the design figure from GDD 05 and it is a RHYTHM, not a
     * tuning knob: a player learns 3.2 seconds by feel and then the whole
     * causeway is one instrument. Moving it invalidates the thing they learned,
     * which is why it lives here as a single shared number rather than per
     * span -- a span carries only its OFFSET within the shared beat.
     */
    bridgePeriod: 3.2,
    /**
     * Fraction of each period the deck is solid.
     *
     * 0.74 is 2.37s solid against 0.83s absent, and it was set by LEAD
     * RETENTION rather than by feel.
     *
     * The floor is the crossing itself: Aetherion's spans are 49m and the field
     * crosses them at 48-58 m/s, so the deck has to hold for ~1.0s after a
     * racer commits to it, and at 0.55 (1.76s solid) the arrival window that
     * clears three spans in a row collapses to under a third of a second and
     * the AI parks before the causeway rather than driving it.
     *
     * The ceiling is that a leader who falls through a bridge has lost the race
     * to an event no rival earned, so the fall rate is a direct tax on the
     * meaning of leading. Measured over 250-300 races on Aetherion:
     *   0.66   0.71-0.91 respawns/race   retention 35.0%   RANDOM
     *   0.74   0.57-0.70                 retention 47.2%   in band
     *   0.82   0.42-0.54                 retention 41.2%   (n=250, +/-6.1)
     *   0.99   0.06-0.23                 retention 51.5%
     * 0.74 is the highest fall rate the retention band will carry, which is
     * where a hazard of this shape belongs: as real as it can be without
     * deciding the race by itself.
     *
     * RE-MEASURED FOR HALF-SPAN PHASING, and it did not move. The table above
     * was taken when a span dropped its whole deck and the duty was therefore
     * the fall rate; now the surviving lane is what decides a fall and the duty
     * only sets how long the wrong lane is lethal. Measured at 600 races each:
     *   0.66   Bulwark 10.2%  OUT OF BAND   retention 56.5%   PROCESSION
     *   0.74   Bulwark 12.2%  in band       retention 52.3%   in band
     * Lower is worse in BOTH columns, which is the opposite of the whole-span
     * result and is the bridge planner's doing: a shorter solid window makes
     * the cruise solve harder, the field crosses slower (+0.17s a lap), and a
     * causeway everyone brakes for is a causeway nobody passes on.
     */
    bridgeDuty: 0.74,
    /**
     * How long before a half phases out that it starts to FLASH, in cycles.
     *
     * The art's warning had two stages already and this is a third in front of
     * them: the lattice stutters from 0.28 of a cycle out, the deck crazes from
     * 0.22, and now the half that is going washes and pulses from here. It is
     * first because it is the only one that answers WHICH SIDE, and the side is
     * the thing a driver has to act on -- a stutter and a craze say "this span
     * is going", which was the whole message when the whole span went.
     *
     * 0.30 of 3.2s is 0.96s, which at the causeway's tuned 52 m/s is 50m: about
     * a second of warning, and far enough out that the flashing half is still a
     * flat shape across the road rather than something the car is already on.
     * Any less and the lane call arrives after the last moment a car can act on
     * it -- crossing the seam with clearance is ~1.0s against the friction
     * budget -- which is what makes this a floor rather than a taste knob.
     *
     * SHADER-SIDE ONLY. The sim does not read it: a flash that changed what the
     * deck does would be a second hazard with its own timing, and the one thing
     * this mechanic cannot afford is the art and the physics disagreeing about
     * whether there is road under a wheel.
     */
    bridgeFlashLead: 0.30,
    /**
     * Metres below the deck at which a racer over an OPEN span is gone, on a
     * gravity track.
     *
     * The generic fall test (offTrack.fallY) is 45m below the road, which at
     * the sim's -34 m/s^2 is 1.63s of falling -- during which a car doing 50
     * m/s travels 82m, further than a phasing span is long, and arrives under
     * the SOLID road past the far end where the surface spring hauls it back
     * up onto the track. A racer that has dropped through a light-bridge has to
     * be committed before it can get out from under the hole it fell through.
     * 10m is 0.77s of visible drop and 38m of travel, which is inside the span.
     */
    voidFallDepth: 10,
  },

  race: {
    countdown: 3.6,
    lightInterval: 1.0,
    totalLaps: 3,
    gridSpacingLong: 9.0,
    gridSpacingLat: 5.2,
  },

  /**
   * THE FINISH.
   *
   * Crossing the line used to freeze every car on it, because `RacerState`
   * .finished makes Race.step() skip the racer outright. A field of eight cars
   * stopping dead in formation reads as a crash, not as a result.
   *
   * The replacement is the kart-racer ending: the player's car is handed to the
   * same `stepAI` that drives the other seven, and the camera leaves the chase
   * rig for a slow orbit of the vehicle while the rest of the field comes in.
   *
   * THE HARD CONSTRAINT ON ALL OF IT is that a finished car is a GHOST. It has
   * to keep driving without touching the result: `Race.stepCeremony()` is a
   * separate pass the headless and balance harnesses never call, and every
   * piece of race logic in race.ts already skips `finished` racers — laps,
   * ranking, collisions, slipstream, pickups, items, projectiles, fields, the
   * gatling and the stall watchdog. See the comment on stepCeremony for the one
   * place that reads a finished racer's `totalS` and why it does not matter.
   */
  ceremony: {
    /**
     * Seconds to blend out of the chase rig and into the orbit. The blend is
     * on the camera's OFFSET FROM THE CAR, never on a world position: the car
     * is doing 60 m/s, so lerping toward a fixed point in the world is a
     * rubber band, and the two offsets happen to start almost equal (both are
     * "behind the car, a little above it"), which is what makes the cut
     * invisible.
     */
    blendIn: 1.15,
    /** Orbit radius and height above the car, metres. */
    orbitRadius: 10.5,
    orbitHeight: 3.9,
    /** Degrees a second the camera walks around the car. Slow on purpose. */
    orbitRate: 19,
    /**
     * Where the orbit starts, degrees off dead astern. Non-zero so the first
     * second is already a three-quarter view rather than the chase shot the
     * player has been looking at for three laps.
     */
    orbitStart: 16,
    /** A breath on radius and height so the shot is not a turntable. */
    breatheAmp: 0.75,
    breathePeriod: 6.5,
    /** Cinematic FOV. Narrower than the chase rig: this is a portrait. */
    fov: 50,
    /** Look target, metres above the car's origin. */
    lookHeight: 1.15,
    /** The camera never comes closer than this to the surface beneath it. */
    groundClearance: 2.0,
    /**
     * ...and never swings further off the centreline than this fraction of the
     * half-width. Past it the shot CLIMBS rather than pushing through — a
     * crane, not a camera in a wall. Rustfall and Cryostatic both run
     * half-widths well under the orbit radius, so this bites on most of the
     * lap and the orbit is really an ellipse that rises at its wide points.
     */
    lateralMargin: 0.80,
    /** Metres of climb per metre of lateral clamp. */
    climbPerMetre: 0.62,
    /** The shot always gets at least this long, seconds. */
    minDuration: 6.0,
    /**
     * ...and never runs longer than this waiting for the field. A player who
     * wins by half a lap should not sit through the tail end of someone else's
     * race; when this expires the remaining cars are simulated to the line at
     * full speed (Game.settleRace) so the results table is the real one.
     */
    maxDuration: 10.0,
    /** Extra hold after the LAST car crosses, so the shot lands. */
    holdAfterField: 2.2,
    /**
     * Input is ignored for this long after the line. Without it the accelerate
     * key still held at the finish counts as "skip" on the very first frame.
     */
    skipGuard: 0.7,
    /** Hard cap on the settle loop, sim steps. */
    settleMaxSteps: 60 * 200,
  },

  /**
   * ENCOURAGEMENT.
   *
   * Short lines of praise, centred, a third of the way down the screen.
   *
   * THE WHOLE CRAFT HERE IS RESTRAINT. This codebase has just spent a round
   * fixing a glare blowout whose symptom was "I cannot see where I am going";
   * text laid over the racing line is the same failure in a different medium.
   * So: one line at a time, short, above the horizon, no filled panel behind
   * it, a per-kind cooldown AND a global minimum gap, and a priority ladder so
   * a bigger moment can interrupt a smaller one but never the reverse.
   *
   * The escalation the player asked for is the drift ladder: the four charge
   * tiers each get a quieter tier-up line, and cashing one in gets the loud
   * one. Everything else on the list has to earn its interruption; see
   * src/ui/cheer.ts for what was left out and why.
   */
  cheer: {
    /** Seconds a line holds at full strength, then its fade. */
    hold: 1.05,
    fade: 0.45,
    /** A quick rise so it does not pop. */
    rise: 0.11,
    /** Minimum seconds between ANY two lines. The main restraint valve. */
    minGap: 0.80,
    /**
     * Per-kind cooldowns, seconds. `tierUp` is short because the ladder IS the
     * escalation and the tiers are 0.65 / 1.5 / 2.6 / 4.2s apart anyway;
     * everything else is long enough that the same line cannot become wallpaper.
     */
    cooldown: {
      tierUp: 0.30,
      cash: 1.40,
      chain: 5.0,
      overtake: 6.0,
      lead: 10.0,
      air: 9.0,
      beam: 8.0,
    },
    /**
     * Priority. A pending line is only replaced by one strictly higher, so a
     * tier-up cannot stamp on the payoff line that just fired.
     */
    priority: {
      tierUp: 1,
      air: 2,
      beam: 2,
      chain: 3,
      cash: 3,
      overtake: 3,
      lead: 4,
    },
    /** Drift tier that a cash-in must reach before it is worth a line at all. */
    cashMinTier: 1,
    /** Chain length that is worth a line. */
    chainMin: 3,
    /** Seconds airborne before a clean landing is worth a line. */
    airMin: 1.15,
    /**
     * Lines are suppressed entirely below this fraction of the screen height
     * being available — see cheer.ts. Kept here so the one number that decides
     * "is there room for this" is not buried in a style sheet.
     */
    minViewportHeight: 300,
  },
} as const

export type Tuning = typeof TUNING
