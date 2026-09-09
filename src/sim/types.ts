import type { Vec3 } from './math'

// ---------------------------------------------------------------------------
// Locomotion
// ---------------------------------------------------------------------------

export type LocomotionClass = 'grounded' | 'hover' | 'flight'

export interface LocomotionProfile {
  /** Resting height above the surface, metres. */
  rideHeight: number
  /** Maximum player-controlled altitude above surface (flight only). */
  maxLift: number
  /** Multiplier on how strongly track surface friction modifiers apply. */
  surfaceFrictionInfluence: number
  driftChargeMult: number
  /** Multiplier on the drift arc radius. Higher = wider, carries more speed. */
  driftArcMult: number
  gripMult: number
  knockbackMult: number
  /** Lateral force multiplier for wind, vacuum and gravity wells. */
  fieldForceMult: number
  /**
   * Share of the lateral friction budget this class loses in a full hard
   * vacuum, 0..1. See TrackNode.vacuum and T.vacuum: hover loses most (it is
   * riding on the medium that is gone), flight least.
   */
  vacuumGripLoss: number
  /** Max gap width crossable without a ramp, metres. 0 = none. */
  gapCross: number
  /** Seconds of Lift available (flight only). */
  liftCapacity: number
  /** Lift units regenerated per second. */
  liftRegen: number
  /** Landing misalignment in radians under which a Clean Landing boost fires. */
  cleanLandingTolerance: number
}

// ---------------------------------------------------------------------------
// Chassis
// ---------------------------------------------------------------------------

/** The designer-facing 1-10 scale. Physical values derive from these. */
export interface ChassisStats {
  topSpeed: number
  accel: number
  grip: number
  mass: number
  drift: number
  handling: number
}

export interface ChassisDef {
  id: string
  name: string
  nickname: string
  locomotion: LocomotionClass
  stats: ChassisStats
  /** Half-extents of the collision box, metres. */
  halfExtents: Vec3
  /** Primary and accent colours as 0xRRGGBB, used by the procedural mesh. */
  colorPrimary: number
  colorSecondary: number
  colorEmissive: number
  /** Optional glTF path. When present the renderer swaps it in for the
   *  procedural mesh. This is the GLB slot. */
  modelUrl?: string
}

/** Physical values resolved from ChassisStats by the published formulas. */
export interface ChassisDerived {
  topSpeed: number      // m/s
  timeToTop: number     // s
  gripCoeff: number
  massKg: number
  driftChargeMult: number
  maxYawRate: number    // rad/s
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface InputFrame {
  /** -1 full left .. +1 full right */
  steer: number
  /** 0..1 */
  throttle: number
  /** 0..1 */
  brake: number
  drift: boolean
  item: boolean
  /** Aim the item backwards this frame. */
  itemBack: boolean
  lift: boolean
  lookBack: boolean
}

export const emptyInput = (): InputFrame => ({
  steer: 0, throttle: 0, brake: 0,
  drift: false, item: false, itemBack: false, lift: false, lookBack: false,
})

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export type ItemId =
  | 'laserGatling'
  | 'voidMine'
  | 'nitro'
  | 'nitroTriple'
  | 'railMissile'
  | 'seekerMissile'
  | 'alphaMissile'
  | 'empBomb'
  | 'overdriveCore'
  | 'gravityWell'

export type ProjectileKind = 'rail' | 'seeker' | 'alpha'
export type FieldKind = 'mine' | 'well'

export interface Projectile {
  id: number
  kind: ProjectileKind
  ownerId: number
  targetId: number
  pos: Vec3
  vel: Vec3
  /** Distance travelled along the track spline, for alpha missiles. */
  splineS: number
  life: number
  alive: boolean
}

export interface FieldEntity {
  id: number
  kind: FieldKind
  ownerId: number
  pos: Vec3
  /**
   * The surface normal of the road this field was deployed on. World +Y on a
   * track that authors no gravity.
   *
   * A mine and a well both draw a GROUND RING at the radius that will actually
   * catch you -- that ring is the contract with the player -- and a ring laid
   * out in world XZ around a mine sitting on a wall is a ring seen edge-on,
   * promising a trigger radius in a plane nothing is driving in.
   */
  up: Vec3
  radius: number
  life: number
  /** Mines are inert until this reaches 0. */
  armDelay: number
  /** Gravity wells absorb one missile then die. */
  absorbed: boolean
  alive: boolean
}

// ---------------------------------------------------------------------------
// Racer state
// ---------------------------------------------------------------------------

export type DriftSide = -1 | 0 | 1

export interface RacerState {
  id: number
  chassisId: string
  pilotId: string
  isAI: boolean
  isLocal: boolean
  aiSkill: number

  pos: Vec3
  vel: Vec3
  /**
   * Compass yaw in radians, about world +Y.
   *
   * On a flat track this is the authoritative heading and `fwd` mirrors it. On
   * a gravity track it is the other way round -- `fwd`/`up` are the state and
   * this is kept in sync as a derived bearing -- because a yaw about world +Y
   * says nothing useful about a car halfway up a vertical wall. Code that only
   * wants a bearing (HUD, minimap, slipstream cones) can keep reading it.
   */
  yaw: number
  /** Turn rate about the racer's OWN up-vector, radians/second. */
  yawRate: number
  /** Unit heading in world space. On a flat track: (sin yaw, 0, cos yaw). */
  fwd: Vec3
  /**
   * Unit up-vector: the direction this racer calls up, and the negative of the
   * direction it falls. World +Y everywhere on a track that authors no gravity.
   */
  up: Vec3
  /** Height above the track surface directly below. */
  altitude: number
  vertVel: number
  grounded: boolean
  /**
   * Seconds of UNBROKEN contact with a barrier. An impact is a momentum transfer
   * that happens once; staying pressed against a wall is friction. Without this
   * the sim could not tell the two apart and charged the impact every frame.
   */
  wallTime: number
  /**
   * The crosswind acceleration ACTUALLY applied this frame, m/s^2, signed
   * (positive = toward the sample's `right`). Already scaled by the class's
   * fieldForceMult and already capped against the friction budget, so it is
   * what the car felt rather than what the track authored. The art reads this
   * and never recomputes it -- see the cap in sim/vehicle.ts.
   */
  windPush: number

  // Drift / boost
  driftSide: DriftSide
  driftCharge: number
  driftTier: number
  /** 0 = full counter-steer (wide, shallow slide), 1 = full lock into the
   *  drift (tight, heavily crabbed). The player's live control of the slide. */
  driftInward: number
  /** True for the single frame a drift begins, so the yaw rate can be set
   *  straight to its target instead of easing in. */
  driftEntry: boolean
  /** Seconds the current slide has been held. Drives the arc ease-off, and is
   *  wall-clock time rather than driftCharge, which is scaled per chassis. */
  driftTime: number
  chainStacks: number
  chainWindow: number
  boostTime: number
  boostMag: number
  boostSource: 'none' | 'drift' | 'pad' | 'item' | 'slipstream' | 'trick' | 'start'

  // Flight
  lift: number
  liftActive: boolean
  airTime: number
  trickArmed: boolean
  /** Blocks re-triggering the same ramp on consecutive frames. */
  rampCooldown: number
  /** While positive, the racer follows a ballistic arc regardless of its
   *  locomotion class. Without this the flight class's altitude damping
   *  cancels a ramp launch outright and it never leaves the ground. */
  ballisticTime: number

  // Items
  item: ItemId | null
  itemCharges: number
  itemSlot2: ItemId | null
  rouletteTime: number

  // Laser gatling: a time budget that auto-fires once activated.
  gatlingTime: number
  gatlingCooldown: number
  /** Incoming beam damage accumulated on THIS racer. Decays once the beam
   *  leaves them; crossing the threshold is what actually spins them out. */
  beamCharge: number
  /** Seconds of decay immunity remaining after taking a round. */
  beamGrace: number

  // Status effects
  spinTime: number
  stunTime: number
  immuneTime: number   // stagger shield
  invincibleTime: number
  slowTime: number
  slowMag: number
  massMult: number

  // Race progress
  lap: number
  checkpoint: number
  splineS: number       // distance along the centreline, metres
  totalS: number        // cumulative across laps, used for ranking
  lateral: number       // signed offset from the centreline, metres
  position: number      // 1..N
  finished: boolean
  finishTime: number
  lapTimes: number[]
  bestLap: number
  charges: number       // Charge pickups held, 0..10
  offTrackTime: number
  respawnTime: number
  /** True once a respawn has moved the racer back onto the track. */
  respawnPlaced: boolean

  // Telemetry / feedback for the renderer
  lastHitBy: ItemId | null
  events: RacerEvent[]
}

export type RacerEvent =
  | { t: 'boost'; tier: number }
  | { t: 'driftStart' }
  | { t: 'driftEnd'; tier: number }
  | { t: 'hit'; item: ItemId }
  | { t: 'fire'; item: ItemId }
  | { t: 'pickup' }
  | { t: 'charge' }
  | { t: 'lap'; lap: number; time: number }
  | { t: 'land'; clean: boolean }
  | { t: 'wall'; force: number }
  | { t: 'beamFire' }
  | { t: 'beamHit'; targetId: number; lethal: boolean }
  | { t: 'ramp'; power: number }
  | { t: 'crack' }
  | { t: 'finish'; position: number }

// ---------------------------------------------------------------------------
// Race
// ---------------------------------------------------------------------------

export type RacePhase = 'countdown' | 'racing' | 'finished'

export interface ItemBoxState {
  index: number
  splineS: number
  lateral: number
  pos: Vec3
  /**
   * The surface normal where this box sits: the axis it floats along, and the
   * axis the renderer bobs it on.
   *
   * World +Y on a track that authors no gravity, so a flat track's boxes hover
   * exactly where they always did. On a wall-ride the road is beside you and
   * "above the road" is a sideways direction -- a box lifted along +Y there
   * hangs off the edge of the ribbon where nobody can drive through it.
   */
  up: Vec3
  respawn: number
  active: boolean
}

export interface ChargePickupState {
  index: number
  pos: Vec3
  /** As ItemBoxState.up. */
  up: Vec3
  respawn: number
  active: boolean
}

export interface RaceState {
  time: number
  frame: number
  phase: RacePhase
  countdown: number
  totalLaps: number
  racers: RacerState[]
  projectiles: Projectile[]
  fields: FieldEntity[]
  itemBoxes: ItemBoxState[]
  chargePickups: ChargePickupState[]
  empTimer: number      // lobby-wide EMP suppression cooldown
  /**
   * True once the LEADER reaches TUNING.hazard.crackLap, at which point every
   * fragile ice shelf on the track gives way. Global rather than per-racer: one
   * telegraphed event the whole field sees, not eight private ones.
   */
  iceCracked: boolean
  nextEntityId: number
  finishOrder: number[]
}

export interface SimConfig {
  seed: number
  totalLaps: number
  racerCount: number
  trackId: string
  chassisIds: string[]
  pilotIds: string[]
  localRacerIndex: number
  aiSkill: number[]
}
