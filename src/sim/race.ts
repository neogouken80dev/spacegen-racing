import { clamp, clamp01, lerp, sign, angleDelta, vdist, v3, vrotAxis, type Vec3 } from './math'
import { Rng, hashFloats } from './rng'
import { Track } from './track'
import {
  stepVehicle, applyBoost, clampToTrack, signedAngleAround, type VehicleContext,
} from './vehicle'
import { stepAI } from './ai'
import {
  type InputFrame, type RacerState, type RaceState, type SimConfig,
  type ItemId, type Projectile, emptyInput,
} from './types'
import { TUNING as T } from '../content/tuning'
import { ITEM_PARAMS, ITEM_ORDER, itemWeightsForPosition } from '../content/items'
import { getDerived, getLocomotion, CHASSIS } from '../content/chassis'

const DT = T.sim.dt

/** Watchdog: this much progress, in metres, within STALL_SECONDS. */
const STALL_PROGRESS = 5
const STALL_SECONDS = 5
/** Seconds after a hit before beam charge starts bleeding off. Must exceed
 *  the interval between rounds (1/fireRate) or accrual cancels itself. */
const BEAM_GRACE = 0.18

/**
 * How far a projectile rides above the road it is following, metres. This is
 * the `+ 1.2` the flat path has always used, named so the gravity path cannot
 * drift from it.
 */
const PROJ_RIDE = 1.2
/** The Alpha Missile rides higher, clear of the field it is hunting through. */
const ALPHA_RIDE = 2.0

/** Scratch, module level so the step loop never allocates. */
const _pdir = v3()
const _paim = v3()

export class Race {
  readonly track: Track
  readonly state: RaceState
  readonly rng: Rng
  readonly config: SimConfig
  /**
   * `Track.hasGravity`, cached. Every gravity-aware branch in this file reads
   * it, and with it false each one does exactly the arithmetic it did before
   * the gravity system existed.
   */
  private readonly grav: boolean
  private inputs: InputFrame[] = []
  private aiRng: Rng[]
  /** No-progress watchdog state, one entry per racer. */
  private stallTimer: number[] = []
  private stallMark: number[] = []
  /** Rocket start is evaluated exactly once per racer, on first throttle. */
  private startResolved: boolean[] = []

  constructor(track: Track, config: SimConfig) {
    this.track = track
    this.config = config
    this.grav = track.hasGravity
    this.rng = new Rng(config.seed)
    this.aiRng = []

    const racers: RacerState[] = []
    for (let i = 0; i < config.racerCount; i++) {
      const chassisId = config.chassisIds[i] ?? CHASSIS[i % CHASSIS.length].id
      const row = Math.floor(i / 2)
      const col = i % 2 === 0 ? -1 : 1
      const backS = -(row * T.race.gridSpacingLong) - 6
      const lateral = col * T.race.gridSpacingLat * 0.5
      const s = ((backS % track.length) + track.length) % track.length
      const smp = track.at(s)
      const p = track.surfacePoint(s, lateral)
      const loco = getLocomotion(chassisId)

      racers.push({
        id: i,
        chassisId,
        pilotId: config.pilotIds[i] ?? 'pip',
        isAI: i !== config.localRacerIndex,
        isLocal: i === config.localRacerIndex,
        aiSkill: config.aiSkill[i] ?? 2,
        // Lifted along the surface normal, not world +Y: on a gravity track the
        // grid can sit on a bank, a wall or a ceiling, and only the normal knows
        // which way "off the road" is.
        //
        // Gated, because a BANKED flat track also has a tilted normal, and
        // adopting the correct lift there moves eight starting positions by a
        // few centimetres each -- which is chaos-amplified into a different
        // race by lap three, and would cost a re-gate of two shipped tracks to
        // fix a start line nobody has ever complained about.
        pos: track.hasGravity
          ? {
            x: p.x + smp.normal.x * loco.rideHeight,
            y: p.y + smp.normal.y * loco.rideHeight,
            z: p.z + smp.normal.z * loco.rideHeight,
          }
          : { x: p.x, y: p.y + smp.normal.y * loco.rideHeight, z: p.z },
        vel: v3(),
        yaw: track.yawAt(s),
        yawRate: 0,
        fwd: v3(smp.tangent.x, smp.tangent.y, smp.tangent.z),
        up: v3(smp.normal.x, smp.normal.y, smp.normal.z),
        altitude: loco.rideHeight,
        vertVel: 0,
        grounded: true,
        wallTime: 0,
        windPush: 0,
        driftSide: 0, driftCharge: 0, driftTier: -1, driftInward: 1, driftEntry: false,
        driftTime: 0,
        chainStacks: 0, chainWindow: 0,
        boostTime: 0, boostMag: 0, boostSource: 'none',
        lift: loco.liftCapacity, liftActive: false, airTime: 0, trickArmed: false,
        rampCooldown: 0, ballisticTime: 0,
        item: null, itemCharges: 0, itemSlot2: null, rouletteTime: 0,
        gatlingTime: 0, gatlingCooldown: 0, beamCharge: 0, beamGrace: 0,
        spinTime: 0, stunTime: 0, immuneTime: 0, invincibleTime: 0,
        slowTime: 0, slowMag: 0, massMult: 1,
        lap: 0, checkpoint: 0, splineS: s, totalS: backS,
        lateral, position: i + 1, finished: false, finishTime: 0,
        lapTimes: [], bestLap: 0, charges: 0,
        offTrackTime: 0, respawnTime: 0, respawnPlaced: false,
        lastHitBy: null, events: [],
      })
      this.aiRng.push(new Rng(config.seed ^ ((i + 1) * 0x9e3779b9)))
      this.inputs.push(emptyInput())
      this.stallTimer.push(0)
      this.stallMark.push(backS)
      this.startResolved.push(false)
    }

    // Pickups float ALONG THE SURFACE NORMAL, not along world +Y.
    //
    // A box is a thing you drive through, so where it sits is a gameplay fact
    // and not a decoration: lifted along +Y on a wall-ride it floats out beside
    // the ribbon, several metres off the road, and the row is simply
    // uncollectable for the whole of the wall. Gated on `hasGravity` for the
    // same reason the grid lift is -- a BANKED flat track also has a tilted
    // normal, and moving two shipped tracks' pickup rows by a few centimetres
    // buys nothing and costs a re-gate.
    const itemBoxes: RaceState['itemBoxes'] = []
    let bi = 0
    for (const row of track.def.itemBoxRows) {
      for (let k = 0; k < row.count; k++) {
        const lateral = (k - (row.count - 1) / 2) * row.spread
        const s = row.at * track.length
        const p = track.surfacePoint(s, lateral)
        const n = track.at(s).normal
        itemBoxes.push({
          index: bi++, splineS: s, lateral,
          pos: track.hasGravity
            ? { x: p.x + n.x * 1.5, y: p.y + n.y * 1.5, z: p.z + n.z * 1.5 }
            : { x: p.x, y: p.y + 1.5, z: p.z },
          up: track.hasGravity ? v3(n.x, n.y, n.z) : v3(0, 1, 0),
          respawn: 0, active: true,
        })
      }
    }

    const chargePickups: RaceState['chargePickups'] = []
    let ci = 0
    for (const run of track.def.chargeRuns) {
      for (let k = 0; k < run.count; k++) {
        const f = lerp(run.from, run.to, run.count === 1 ? 0.5 : k / (run.count - 1))
        const s = f * track.length
        const p = track.surfacePoint(s, run.lateral)
        const n = track.at(s).normal
        chargePickups.push({
          index: ci++,
          pos: track.hasGravity
            ? { x: p.x + n.x * 1.1, y: p.y + n.y * 1.1, z: p.z + n.z * 1.1 }
            : { x: p.x, y: p.y + 1.1, z: p.z },
          up: track.hasGravity ? v3(n.x, n.y, n.z) : v3(0, 1, 0),
          respawn: 0, active: true,
        })
      }
    }

    this.state = {
      time: 0, frame: 0, phase: 'countdown', countdown: T.race.countdown,
      totalLaps: config.totalLaps,
      racers, projectiles: [], fields: [], itemBoxes, chargePickups,
      empTimer: 0, iceCracked: false, nextEntityId: 1, finishOrder: [],
    }
    this.updatePositions()
  }

  setInput(racerId: number, input: InputFrame): void {
    this.inputs[racerId] = input
  }

  step(): void {
    const s = this.state
    s.frame++

    for (const r of s.racers) r.events.length = 0

    if (s.phase === 'countdown') {
      s.countdown -= DT
      // Rocket start: sample the local racer's throttle during the window.
      for (const r of s.racers) {
        if (r.finished || this.startResolved[r.id]) continue
        const inp = r.isAI ? this.aiRocketStart(r) : this.inputs[r.id]
        if (inp.throttle <= 0.5) continue
        // Resolve exactly once. Re-evaluating every frame meant a player who
        // simply held accelerate through the countdown had the bog penalty
        // re-applied on every tick and could never move at all.
        this.startResolved[r.id] = true
        const w = T.boost.rocketStartWindow
        if (s.countdown <= w[1] && s.countdown >= w[0]) {
          const tier = T.boost.rocketStartTier
          r.boostMag = T.drift.tierBoost[tier]
          r.boostTime = T.drift.tierDuration[tier]
          r.boostSource = 'start'
        } else if (s.countdown > w[1]) {
          r.stunTime = T.boost.bogTime
        }
      }
      if (s.countdown <= 0) { s.phase = 'racing'; s.countdown = 0 }
      s.time += DT
      return
    }

    if (s.phase === 'finished') { s.time += DT; return }

    s.time += DT
    if (s.empTimer > 0) s.empTimer = Math.max(0, s.empTimer - DT)

    // The ice gives way when the LEADER reaches crackLap. One-way latch: a
    // shelf that has gone does not come back, and the flag is derived from lap
    // counts rather than a timer so it survives a rewind or a resimulation.
    if (!s.iceCracked && this.track.hasFragile) {
      for (const r of s.racers) {
        if (r.lap >= T.hazard.crackLap) {
          s.iceCracked = true
          for (const o of s.racers) o.events.push({ t: 'crack' })
          break
        }
      }
    }

    const ctx: VehicleContext = {
      track: this.track,
      raceTime: s.time,
      iceCracked: s.iceCracked,
    }

    // --- AI decides -------------------------------------------------------
    for (const r of s.racers) {
      if (r.isAI && !r.finished) {
        this.inputs[r.id] = stepAI(r, s, this.track, this.aiRng[r.id])
      }
    }

    // --- Vehicles ---------------------------------------------------------
    for (const r of s.racers) {
      if (r.finished) continue
      stepVehicle(r, this.inputs[r.id], ctx)
    }

    // --- Racer vs racer ---------------------------------------------------
    this.resolveRacerCollisions()

    // Collision resolution moves racers with no knowledge of the barrier, so
    // the wall has to be re-applied afterwards. Without this, two cars running
    // side by side simply push each other out through it.
    for (const r of s.racers) {
      if (!r.finished) clampToTrack(r, this.track)
    }

    // --- Slipstream -------------------------------------------------------
    this.resolveSlipstream()

    // --- Pickups ----------------------------------------------------------
    this.resolvePickups()

    // --- Items ------------------------------------------------------------
    for (const r of s.racers) {
      if (r.finished || r.spinTime > 0 || r.stunTime > 0) continue
      const inp = this.inputs[r.id]
      if (inp.item && r.item && r.rouletteTime <= 0) {
        this.useItem(r, inp.itemBack)
      }
    }
    this.stepProjectiles()
    this.stepFields()
    this.stepGatling()

    // --- No-progress watchdog ---------------------------------------------
    this.resolveStalls()

    // --- Laps and ranking -------------------------------------------------
    this.resolveLaps()
    this.updatePositions()

    if (s.finishOrder.length >= s.racers.length) s.phase = 'finished'
  }

  /**
   * THE VICTORY LAP.
   *
   * Drive every FINISHED racer with the same AI that drives the field, so a car
   * that crosses the line keeps racing the circuit instead of stopping dead on
   * it. Cosmetic only, and deliberately a separate entry point: the headless
   * determinism gate and the balance harness call `step()` and nothing else, so
   * neither the state hash nor a single race result can move because of this.
   *
   * WHY IT CANNOT CHANGE THE RACE, mechanism by mechanism. Every one of these
   * already skipped `finished` racers before this existed; nothing here is a
   * new guard, it is an inventory of the ones being relied on:
   *
   *   resolveLaps         skips finished — no re-lap, no second finish event,
   *                       and `lap` therefore stays frozen, which is what the
   *                       ice-crack latch reads.
   *   updatePositions     ranks only the unfinished, off `finishOrder.length`.
   *   collisions          both sides skip finished: a ghost cannot block, shove
   *                       or spin anyone still racing.
   *   slipstream          skips finished as receiver AND as wake source.
   *   pickups             skips finished — a victory lap cannot eat the item
   *                       box or the charge the field behind is racing for.
   *   items / gatling     skip finished, so a ghost can never fire.
   *   projectiles/fields  skip finished as targets.
   *   resolveStalls       skips finished, so the watchdog cannot fire on one.
   *   phase               `finishOrder.length >= racers.length`, which this
   *                       pass never touches, so the race still ends.
   *
   * The ONE place that reads a finished racer's live `totalS` is the Alpha
   * Missile lockout in grantItem, which compares the leader's progress against
   * the finish. A finished racer's totalS is already >= totalLaps * length the
   * moment it crosses, so `remaining` is already <= 0 and the Alpha is already
   * locked out for the rest of the race; driving it further only makes an
   * already-negative number more negative. Same branch, same outcome.
   *
   * Events raised here (boost, drift, land, wall) land on `r.events` AFTER
   * step() has cleared it, so the renderer still gets its VFX for the victory
   * lap. The UI must not read them as gameplay feedback — see cheer.ts, which
   * gates itself on `!finished`.
   */
  stepCeremony(): void {
    const s = this.state
    const ctx: VehicleContext = {
      track: this.track,
      raceTime: s.time,
      iceCracked: s.iceCracked,
    }
    for (const r of s.racers) {
      if (!r.finished) continue
      const inp = stepAI(r, s, this.track, this.aiRng[r.id])
      stepVehicle(r, inp, ctx)
      clampToTrack(r, this.track)
    }
  }

  private aiRocketStart(r: RacerState): InputFrame {
    const skill = clamp(r.aiSkill, 0, 4)
    const rng = this.aiRng[r.id]
    // Better AI hits the window more often.
    const chance = 0.25 + skill * 0.16
    const wantAt = rng.next() < chance
      ? this.rng.range(T.boost.rocketStartWindow[0], T.boost.rocketStartWindow[1])
      : this.rng.range(0.5, 1.4)
    const inp = emptyInput()
    inp.throttle = this.state.countdown <= wantAt ? 1 : 0
    return inp
  }

  // -------------------------------------------------------------------------
  private resolveRacerCollisions(): void {
    const rs = this.state.racers
    const R = T.collision.racerRadius
    for (let i = 0; i < rs.length; i++) {
      const a = rs[i]
      if (a.finished || a.respawnTime > 0) continue
      for (let j = i + 1; j < rs.length; j++) {
        const b = rs[j]
        if (b.finished || b.respawnTime > 0) continue
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z
        const dy = b.pos.y - a.pos.y
        if (Math.abs(dy) > 3.2) continue
        const d2 = dx * dx + dz * dz
        const minD = R * 2
        if (d2 > minD * minD || d2 < 1e-6) continue

        const d = Math.sqrt(d2)
        const nx = dx / d, nz = dz / d
        const overlap = minD - d

        // Overdrive Core: instant spin-out on contact.
        if (a.invincibleTime > 0 && b.invincibleTime <= 0 && b.immuneTime <= 0) {
          this.hit(b, 'overdriveCore', ITEM_PARAMS.overdriveCore.contactSpin)
        } else if (b.invincibleTime > 0 && a.invincibleTime <= 0 && a.immuneTime <= 0) {
          this.hit(a, 'overdriveCore', ITEM_PARAMS.overdriveCore.contactSpin)
        }

        const ma = getDerived(a.chassisId).massKg * a.massMult
        const mb = getDerived(b.chassisId).massKg * b.massMult
        const total = ma + mb
        // Clamp so the heaviest chassis cannot delete the lightest.
        const ratioA = clamp(mb / total, 1 / (1 + T.collision.maxMassRatio), T.collision.maxMassRatio / (1 + T.collision.maxMassRatio))
        const ratioB = 1 - ratioA

        a.pos.x -= nx * overlap * ratioA; a.pos.z -= nz * overlap * ratioA
        b.pos.x += nx * overlap * ratioB; b.pos.z += nz * overlap * ratioB

        const rvx = b.vel.x - a.vel.x, rvz = b.vel.z - a.vel.z
        const sep = rvx * nx + rvz * nz
        if (sep < 0) {
          const locoA = getLocomotion(a.chassisId), locoB = getLocomotion(b.chassisId)
          const imp = -(1 + T.collision.restitution) * sep
          a.vel.x -= nx * imp * ratioA * locoA.knockbackMult
          a.vel.z -= nz * imp * ratioA * locoA.knockbackMult
          b.vel.x += nx * imp * ratioB * locoB.knockbackMult
          b.vel.z += nz * imp * ratioB * locoB.knockbackMult
          if (Math.abs(sep) > T.drift.collisionCancelSpeed) {
            for (const r of [a, b]) {
              if (r.driftSide !== 0) { r.driftSide = 0; r.driftCharge = 0; r.driftTier = -1; r.chainStacks = 0 }
            }
          }
          // THE CONTACT, PUBLISHED FOR THE ART. Fired on every frame the pair
          // is closing, with `force` as the closing speed along the normal --
          // so rubbing side by side is a trickle and a real slam is a burst,
          // with no second threshold to keep in sync with this one. The seam
          // is the midpoint of the two centres, and each racer gets the normal
          // pointing at the OTHER car, so either can spray away from the seam
          // without knowing who it hit.
          //
          // `sep` is negative here (the branch is gated on closing), hence the
          // minus. Nothing about the physics above depends on this block: it is
          // published state, and removing it changes no trajectory.
          const cx = (a.pos.x + b.pos.x) * 0.5
          const cy = (a.pos.y + b.pos.y) * 0.5
          const cz = (a.pos.z + b.pos.z) * 0.5
          a.events.push({ t: 'bump', force: -sep, px: cx, py: cy, pz: cz, nx, ny: 0, nz })
          b.events.push({ t: 'bump', force: -sep, px: cx, py: cy, pz: cz, nx: -nx, ny: 0, nz: -nz })
        }
      }
    }
  }

  private resolveSlipstream(): void {
    const rs = this.state.racers
    for (const a of rs) {
      if (a.finished || a.boostSource === 'drift') continue
      let inWake = false
      for (const b of rs) {
        if (b === a || b.finished) continue
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z
        const dist = Math.hypot(dx, dz)
        if (dist > T.boost.slipstreamRange || dist < 3) continue
        const fx = Math.sin(a.yaw), fz = Math.cos(a.yaw)
        const dot = (dx * fx + dz * fz) / dist
        if (dot > Math.cos(T.boost.slipstreamHalfAngle)) { inWake = true; break }
      }
      if (inWake) {
        a.chainWindow = a.chainWindow // untouched
        ;(a as RacerState & { _slip?: number })._slip =
          ((a as RacerState & { _slip?: number })._slip ?? 0) + DT
        const slip = (a as RacerState & { _slip?: number })._slip ?? 0
        if (slip >= T.boost.slipstreamBuild) {
          applyBoost(a, T.boost.slipstreamMag, T.boost.slipstreamDuration, 'slipstream')
          ;(a as RacerState & { _slip?: number })._slip = 0
        }
      } else {
        ;(a as RacerState & { _slip?: number })._slip = 0
      }
    }
  }

  private resolvePickups(): void {
    const s = this.state
    for (const box of s.itemBoxes) {
      if (!box.active) {
        box.respawn -= DT
        if (box.respawn <= 0) { box.active = true }
        continue
      }
      for (const r of s.racers) {
        if (r.finished || r.respawnTime > 0) continue
        if (vdist(r.pos, box.pos) < 3.4) {
          if (s.time < T.items.noItemsBeforeTime) break
          // Only consume the box if the racer can actually take an item.
          // Consuming it regardless silently wasted about 30% of all pickups
          // and let a hoarding leader deny the row to everyone behind.
          if (!this.canTakeItem(r)) break
          this.grantItem(r)
          box.active = false
          box.respawn = T.items.boxRespawn
          r.events.push({ t: 'pickup' })
          break
        }
      }
    }
    for (const cp of s.chargePickups) {
      if (!cp.active) {
        cp.respawn -= DT
        if (cp.respawn <= 0) cp.active = true
        continue
      }
      for (const r of s.racers) {
        if (r.finished || r.respawnTime > 0) continue
        if (vdist(r.pos, cp.pos) < 3.0) {
          r.charges = Math.min(T.boost.chargeMax, r.charges + 1)
          cp.active = false
          cp.respawn = T.items.chargeRespawn
          r.events.push({ t: 'charge' })
          break
        }
      }
    }
  }

  /** Positions 7 and 8 hold a second item; everyone else holds one. */
  private canTakeItem(r: RacerState): boolean {
    if (r.item === null) return true
    return r.position >= T.items.secondSlotFromPosition && r.itemSlot2 === null
  }

  private grantItem(r: RacerState): void {
    const trailing = r.position >= T.items.secondSlotFromPosition
    const targetSlot: 'item' | 'itemSlot2' = r.item === null ? 'item' : (trailing && r.itemSlot2 === null ? 'itemSlot2' : 'item')
    if (!this.canTakeItem(r)) return

    let weights = itemWeightsForPosition(r.position)
    // Alpha Missile is locked out near the finish so a wire-to-wire lead is safe.
    const leader = this.state.racers.reduce((a, b) => (a.totalS > b.totalS ? a : b))
    const remaining = (this.state.totalLaps * this.track.length) - leader.totalS
    const est = remaining / Math.max(20, getDerived(leader.chassisId).topSpeed)
    if (est < T.items.alphaLockoutBeforeFinish) {
      weights = weights.slice()
      weights[ITEM_ORDER.indexOf('alphaMissile')] = 0
    }
    if (this.state.empTimer > 0) {
      weights = weights.slice()
      weights[ITEM_ORDER.indexOf('empBomb')] = 0
    }

    const id = ITEM_ORDER[this.rng.weighted(weights)]
    if (targetSlot === 'item') {
      r.item = id
      r.itemCharges = id === 'nitroTriple' ? 3 : 1
    } else {
      r.itemSlot2 = id
    }
    r.rouletteTime = trailing ? T.items.rouletteTimeTrailing : T.items.rouletteTime
  }

  private useItem(r: RacerState, backwards: boolean): void {
    const id = r.item
    if (!id) return
    const s = this.state
    r.events.push({ t: 'fire', item: id })

    const consume = () => {
      r.itemCharges--
      if (r.itemCharges <= 0) {
        r.item = r.itemSlot2
        r.itemCharges = r.item === 'nitroTriple' ? 3 : r.item ? 1 : 0
        r.itemSlot2 = null
        if (r.item) r.rouletteTime = 0.12
      }
    }

    // THE FIRING AXIS.
    //
    // Flat, the nose is a compass bearing and this is the sin/cos it always
    // was. On a gravity track `r.fwd` IS the nose -- already a unit vector
    // lying in the road's plane, maintained by setBasis every step -- and the
    // compass is the derived mirror. Dropping its y there is what sent a
    // missile fired on a wall-ride off horizontally into the sky.
    //
    // THE DECISION: projectiles FOLLOW THE SURFACE. They leave along the nose,
    // they travel in the road's plane and they roll with it (see
    // stepProjectiles). An item that cannot hit anyone for the third of a lap
    // the road spends off level is an item that deletes the combat layer for
    // that third, and no amount of "it flew realistically" pays for that.
    const fwdX = this.grav ? r.fwd.x : Math.sin(r.yaw)
    const fwdY = this.grav ? r.fwd.y : 0
    const fwdZ = this.grav ? r.fwd.z : Math.cos(r.yaw)

    switch (id) {
      case 'nitro':
      case 'nitroTriple': {
        const p = ITEM_PARAMS.nitro
        applyBoost(r, p.mag, p.duration, 'item')
        if (r.slowTime > 0) { r.slowTime = 0; r.slowMag = 0 }
        consume(); break
      }
      case 'voidMine': {
        const p = ITEM_PARAMS.voidMine
        // A MINE LEAVES THE BACK OF THE CAR. Both throws are rearward: the
        // default drops it just behind, and the backward modifier lobs it
        // further back down the road for whoever is chasing.
        //
        // It used to lob 20m FORWARD by default, which is where the report
        // "it shoots out in front of the vehicle" comes from. The forward lob
        // had a use -- seeding the racing line ahead of you -- but it is the
        // wrong thing to get by pressing fire, on an item the distribution
        // table hands mostly to the leader, whose whole reason for wanting it
        // is what is behind them.
        const dist = backwards ? -p.lobDistance : -p.dropBack
        const drop = this.deployPoint(r, fwdX, fwdY, fwdZ, dist)
        s.fields.push({
          id: s.nextEntityId++, kind: 'mine', ownerId: r.id, pos: drop.pos, up: drop.up,
          radius: p.triggerRadius, life: p.life, armDelay: p.armDelay, absorbed: false, alive: true,
        })
        consume(); break
      }
      case 'gravityWell': {
        const p = ITEM_PARAMS.gravityWell
        const drop = this.deployPoint(r, fwdX, fwdY, fwdZ, -5)
        s.fields.push({
          id: s.nextEntityId++, kind: 'well', ownerId: r.id, pos: drop.pos, up: drop.up,
          radius: p.radius, life: p.life, armDelay: 0, absorbed: false, alive: true,
        })
        consume(); break
      }
      case 'railMissile': {
        const p = ITEM_PARAMS.railMissile
        const dir = backwards ? -1 : 1
        s.projectiles.push(this.mkProjectile('rail', r, -1, fwdX * dir, fwdY * dir, fwdZ * dir, p.speed, p.life))
        consume(); break
      }
      case 'seekerMissile': {
        const p = ITEM_PARAMS.seekerMissile
        const target = this.findTargetAhead(r, p.acquireRange)
        s.projectiles.push(this.mkProjectile('seeker', r, target, fwdX, fwdY, fwdZ, p.speed, p.life))
        consume(); break
      }
      case 'alphaMissile': {
        const p = ITEM_PARAMS.alphaMissile
        const leader = s.racers.filter((x) => !x.finished).reduce((a, b) => (a.totalS > b.totalS ? a : b), s.racers[0])
        const proj = this.mkProjectile('alpha', r, leader.id, fwdX, fwdY, fwdZ, p.speed, p.life)
        proj.splineS = r.splineS
        s.projectiles.push(proj)
        consume(); break
      }
      case 'empBomb': {
        if (s.empTimer > 0) { consume(); break }
        const p = ITEM_PARAMS.empBomb
        s.empTimer = T.items.empLobbyCooldown
        for (const o of s.racers) {
          if (o.id === r.id || o.finished) continue
          if (o.invincibleTime > 0 || o.immuneTime > 0) continue
          o.stunTime = Math.max(o.stunTime, o.boostTime > 0 ? p.stunTimeBoosting : p.stunTime)
          o.lastHitBy = 'empBomb'
          o.events.push({ t: 'hit', item: 'empBomb' })
        }
        consume(); break
      }
      case 'overdriveCore': {
        const p = ITEM_PARAMS.overdriveCore
        r.invincibleTime = p.duration
        applyBoost(r, p.mag, p.duration, 'item')
        consume(); break
      }
      case 'laserGatling': {
        // Activating arms a fixed budget of auto-fire. The skill is in holding
        // a line on someone for long enough, not in the trigger pull.
        r.gatlingTime = ITEM_PARAMS.laserGatling.fireTime
        r.gatlingCooldown = 0
        consume(); break
      }
    }
  }

  /**
   * Where a dropped field (mine, well) lands: `dist` metres along the racer's
   * nose, negative for behind.
   *
   * Flat, that is a translation in world XZ at the racer's own height, exactly
   * as it always was. On a gravity track a straight translation is not enough:
   * over 20 m of lob the road can roll several degrees, so a mine offset along
   * a straight `fwd` ends up off the ribbon. The offset point is re-seated onto
   * the road under it and lifted back to the height the racer was carrying, so
   * a mine dropped on a wall sits ON the wall.
   */
  private deployPoint(
    r: RacerState, fx: number, fy: number, fz: number, dist: number,
  ): { pos: Vec3; up: Vec3 } {
    const raw = { x: r.pos.x + fx * dist, y: r.pos.y + fy * dist, z: r.pos.z + fz * dist }
    if (!this.grav) return { pos: raw, up: v3(0, 1, 0) }
    const proj = this.track.project(raw, r.splineS)
    const c = this.track.surfacePoint(proj.s, proj.lateral)
    const n = proj.sample.normal
    const alt = r.altitude
    return {
      pos: { x: c.x + n.x * alt, y: c.y + n.y * alt, z: c.z + n.z * alt },
      up: v3(n.x, n.y, n.z),
    }
  }

  private mkProjectile(
    kind: Projectile['kind'], owner: RacerState, targetId: number,
    dx: number, dy: number, dz: number, speed: number, life: number,
  ): Projectile {
    // The muzzle offset rides the racer's own up, so a shot fired on a wall
    // leaves the nose rather than half a metre off the road into the sky.
    const g = this.grav
    return {
      id: this.state.nextEntityId++,
      kind, ownerId: owner.id, targetId,
      pos: g
        ? {
          x: owner.pos.x + dx * 3 + owner.up.x * 0.5,
          y: owner.pos.y + dy * 3 + owner.up.y * 0.5,
          z: owner.pos.z + dz * 3 + owner.up.z * 0.5,
        }
        : { x: owner.pos.x + dx * 3, y: owner.pos.y + 0.5, z: owner.pos.z + dz * 3 },
      vel: { x: dx * speed, y: g ? dy * speed : 0, z: dz * speed },
      splineS: owner.splineS, life, alive: true,
    }
  }

  private findTargetAhead(r: RacerState, range: number): number {
    let best = -1
    let bestGap = Infinity
    for (const o of this.state.racers) {
      if (o.id === r.id || o.finished) continue
      const gap = o.totalS - r.totalS
      if (gap > 0 && gap < bestGap && gap < range) { bestGap = gap; best = o.id }
    }
    return best
  }

  private stepProjectiles(): void {
    const s = this.state
    for (const p of s.projectiles) {
      if (!p.alive) continue
      p.life -= DT
      if (p.life <= 0) { p.alive = false; continue }

      if (p.kind === 'seeker' && p.targetId >= 0) {
        const t = s.racers[p.targetId]
        const par = ITEM_PARAMS.seekerMissile
        if (t && !t.finished) {
          if (this.grav) {
            // Steer in the ROAD's plane, about the local surface normal. A
            // compass turn is measured about world +Y, which on a vertical
            // wall is a PITCH: the missile nosed into the road or off it
            // instead of tracking sideways onto its target.
            const n = this.track.at(p.splineS).normal
            _paim.x = t.pos.x - p.pos.x
            _paim.y = t.pos.y - p.pos.y
            _paim.z = t.pos.z - p.pos.z
            const turn = clamp(
              signedAngleAround(p.vel, _paim, n),
              -par.turnRate * DT, par.turnRate * DT,
            )
            _pdir.x = p.vel.x; _pdir.y = p.vel.y; _pdir.z = p.vel.z
            vrotAxis(_pdir, n, turn)
            const l = Math.hypot(_pdir.x, _pdir.y, _pdir.z) || 1
            p.vel.x = (_pdir.x / l) * par.speed
            p.vel.y = (_pdir.y / l) * par.speed
            p.vel.z = (_pdir.z / l) * par.speed
          } else {
            const dx = t.pos.x - p.pos.x, dz = t.pos.z - p.pos.z
            const want = Math.atan2(dx, dz)
            const cur = Math.atan2(p.vel.x, p.vel.z)
            const next = cur + clamp(angleDelta(cur, want), -par.turnRate * DT, par.turnRate * DT)
            p.vel.x = Math.sin(next) * par.speed
            p.vel.z = Math.cos(next) * par.speed
          }
        }
      } else if (p.kind === 'alpha') {
        // Rides the spline, ignoring geometry, until it reaches the leader.
        const par = ITEM_PARAMS.alphaMissile
        p.splineS += par.speed * DT
        const target = s.racers[p.targetId]
        const pos = this.track.surfacePoint(p.splineS, target ? target.lateral * 0.7 : 0)
        if (this.grav) {
          // Held clear of the road along ITS normal. Lifted along +Y instead,
          // an Alpha crossing a wall-ride flies through the ribbon and out the
          // far side of it, and the racer it is hunting is never inside its
          // blast radius.
          const n = this.track.at(p.splineS).normal
          const nx = pos.x + n.x * ALPHA_RIDE
          const ny = pos.y + n.y * ALPHA_RIDE
          const nz = pos.z + n.z * ALPHA_RIDE
          p.vel.x = (nx - p.pos.x) / DT
          p.vel.y = (ny - p.pos.y) / DT
          p.vel.z = (nz - p.pos.z) / DT
          p.pos.x = nx; p.pos.y = ny; p.pos.z = nz
        } else {
          p.vel.x = (pos.x - p.pos.x) / DT
          p.vel.z = (pos.z - p.pos.z) / DT
          p.pos.x = pos.x; p.pos.y = pos.y + ALPHA_RIDE; p.pos.z = pos.z
        }
      }

      if (p.kind !== 'alpha') {
        p.pos.x += p.vel.x * DT
        if (this.grav) p.pos.y += p.vel.y * DT
        p.pos.z += p.vel.z * DT
        const surf = this.track.project(p.pos, p.splineS)
        p.splineS = surf.s
        if (this.grav) {
          // RE-SEAT ONTO THE ROAD, and roll the velocity with it.
          //
          // The flat path integrates in XZ and then snaps the height to the
          // centreline, which is a shot that follows the road because the road
          // never leaves the XZ plane. Here the same idea has to be spelled
          // out: put the shot back on the surface it is flying over, then
          // strip whatever velocity has drifted out of that surface's plane
          // and re-normalise. Without the strip a rail shot fired at the foot
          // of a wall carries straight on into the sky while the road turns
          // away underneath it -- exactly the bug this replaces, just one
          // frame later.
          const c = this.track.surfacePoint(surf.s, surf.lateral)
          const n = surf.sample.normal
          p.pos.x = c.x + n.x * PROJ_RIDE
          p.pos.y = c.y + n.y * PROJ_RIDE
          p.pos.z = c.z + n.z * PROJ_RIDE
          const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z)
          const out = p.vel.x * n.x + p.vel.y * n.y + p.vel.z * n.z
          let vx = p.vel.x - n.x * out
          let vy = p.vel.y - n.y * out
          let vz = p.vel.z - n.z * out
          const l = Math.hypot(vx, vy, vz)
          if (l > 1e-6) {
            vx = (vx / l) * speed; vy = (vy / l) * speed; vz = (vz / l) * speed
            p.vel.x = vx; p.vel.y = vy; p.vel.z = vz
          }
        } else {
          p.pos.y = this.track.posAt(surf.s).y + PROJ_RIDE
        }
        if (Math.abs(surf.lateral) > surf.sample.width * 1.35) { p.alive = false; continue }
      }

      // Gravity wells absorb one missile each, including an Alpha.
      for (const f of s.fields) {
        if (!f.alive || f.kind !== 'well' || f.absorbed) continue
        if (vdist(f.pos, p.pos) < f.radius) {
          f.absorbed = true; f.alive = false; p.alive = false; break
        }
      }
      if (!p.alive) continue

      // Rail missiles destroy mines and can intercept an Alpha head-on.
      if (p.kind === 'rail') {
        for (const f of s.fields) {
          if (f.alive && f.kind === 'mine' && vdist(f.pos, p.pos) < 3.0) { f.alive = false; p.alive = false; break }
        }
        if (!p.alive) continue
        for (const q of s.projectiles) {
          if (q.alive && q.kind === 'alpha' && vdist(q.pos, p.pos) < 5.0) { q.alive = false; p.alive = false; break }
        }
        if (!p.alive) continue
      }

      const radius = p.kind === 'rail' ? ITEM_PARAMS.railMissile.radius
        : p.kind === 'seeker' ? ITEM_PARAMS.seekerMissile.radius
          : ITEM_PARAMS.alphaMissile.radius
      for (const r of s.racers) {
        if (r.finished || r.id === p.ownerId) continue
        if (p.kind === 'alpha' && r.id !== p.targetId) continue
        if (vdist(r.pos, p.pos) > radius + 1.5) continue
        // Overdrive Core blocks everything except the Alpha Missile.
        if (p.kind !== 'alpha' && (r.invincibleTime > 0 || r.immuneTime > 0)) continue
        if (p.kind === 'alpha' && r.immuneTime > 0) continue
        const item: ItemId = p.kind === 'rail' ? 'railMissile' : p.kind === 'seeker' ? 'seekerMissile' : 'alphaMissile'
        const spin = p.kind === 'rail' ? ITEM_PARAMS.railMissile.spinTime
          : p.kind === 'seeker' ? ITEM_PARAMS.seekerMissile.spinTime
            : ITEM_PARAMS.alphaMissile.spinTime
        this.hit(r, item, spin, p.kind === 'alpha')
        p.alive = false
        break
      }
    }
    if (s.projectiles.length > 24) s.projectiles = s.projectiles.filter((p) => p.alive)
  }

  private stepFields(): void {
    const s = this.state
    for (const f of s.fields) {
      if (!f.alive) continue
      f.life -= DT
      if (f.armDelay > 0) f.armDelay = Math.max(0, f.armDelay - DT)
      if (f.life <= 0) { f.alive = false; continue }

      for (const r of s.racers) {
        if (r.finished || r.respawnTime > 0) continue
        const d = vdist(r.pos, f.pos)
        if (f.kind === 'mine') {
          if (f.armDelay > 0 || r.id === f.ownerId) continue
          if (d < f.radius && r.invincibleTime <= 0 && r.immuneTime <= 0) {
            const p = ITEM_PARAMS.voidMine
            this.hit(r, 'voidMine', p.spinTime)
            f.alive = false
          }
        } else {
          if (r.id === f.ownerId || r.invincibleTime > 0) continue
          if (d < f.radius) {
            const p = ITEM_PARAMS.gravityWell
            r.slowTime = Math.max(r.slowTime, p.slowTime)
            r.slowMag = p.slowMag
            r.massMult = p.massMult
            if (r.lastHitBy !== 'gravityWell') {
              r.events.push({ t: 'hit', item: 'gravityWell' })
              r.lastHitBy = 'gravityWell'
            }
          } else if (r.lastHitBy === 'gravityWell' && r.slowTime <= 0) {
            r.massMult = 1
            r.lastHitBy = null
          }
        }
      }
    }
    if (s.fields.length > 20) s.fields = s.fields.filter((f) => f.alive)
  }

  /**
   * The Pulse Gatling. Hitscan, fires on a fixed cadence while its budget
   * lasts, and does no single-hit damage worth the name: every hit chips speed
   * and shoves the target sideways, and only sustained tracking on ONE racer
   * accumulates enough beam to break them. Breaking line of sight bleeds it off.
   */
  private stepGatling(): void {
    const s = this.state
    const P = ITEM_PARAMS.laserGatling
    const shotValue = 1 / P.fireRate

    // The grace window must be LONGER than the interval between shots. At 14
    // rounds a second the beam only lands on roughly one frame in four, so
    // decaying on every other frame cancels each hit almost exactly and
    // `breakAt` becomes unreachable no matter how well the player tracks.
    for (const r of s.racers) {
      if (r.gatlingTime <= 0) continue
      if (r.finished || r.spinTime > 0 || r.stunTime > 0) { r.gatlingTime = 0; continue }

      r.gatlingTime = Math.max(0, r.gatlingTime - DT)
      r.gatlingCooldown -= DT
      if (r.gatlingCooldown > 0) continue
      r.gatlingCooldown += 1 / P.fireRate
      r.events.push({ t: 'beamFire' })

      // THE AIMING FRAME. Flat: the compass nose, a cone in world XZ, and a
      // "same height" gate on world Y. On a gravity track every one of those
      // three is the wrong axis -- two cars stacked six metres apart up a
      // vertical wall are SIDE BY SIDE on the road, and the `dy > 6` gate
      // refuses the shot; the cone is measured in a plane the road does not
      // lie in; and the shove goes into the wall instead of across it.
      const gr = this.grav
      const fx = gr ? r.fwd.x : Math.sin(r.yaw)
      const fy = gr ? r.fwd.y : 0
      const fz = gr ? r.fwd.z : Math.cos(r.yaw)
      // right = forward x up, the convention Track, the vehicle and the camera
      // all share. Flat with up = +Y that is (-cos yaw, 0, sin yaw).
      const rx = gr ? fy * r.up.z - fz * r.up.y : -Math.cos(r.yaw)
      const ry = gr ? fz * r.up.x - fx * r.up.z : 0
      const rz = gr ? fx * r.up.y - fy * r.up.x : Math.sin(r.yaw)
      let best: RacerState | null = null
      let bestDist = Infinity
      for (const o of s.racers) {
        if (o.id === r.id || o.finished || o.respawnTime > 0) continue
        if (o.invincibleTime > 0 || o.immuneTime > 0) continue
        let dx = o.pos.x - r.pos.x, dy = o.pos.y - r.pos.y, dz = o.pos.z - r.pos.z
        let off: number
        if (gr) {
          // Split the offset into "in the shooter's road plane" and "out of
          // it". The out-of-plane part is what the flat `dy` gate was really
          // testing for: a car on another deck entirely.
          off = dx * r.up.x + dy * r.up.y + dz * r.up.z
          dx -= r.up.x * off; dy -= r.up.y * off; dz -= r.up.z * off
        } else {
          off = dy
          dy = 0
        }
        if (Math.abs(off) > 6) continue
        const dist = gr ? Math.hypot(dx, dy, dz) : Math.hypot(dx, dz)
        if (dist < 2 || dist > P.range) continue
        const along = (dx * fx + dy * fy + dz * fz) / dist
        if (along < Math.cos(P.cone)) continue
        if (dist < bestDist) { bestDist = dist; best = o }
      }
      if (!best) continue

      best.vel.x *= 1 - P.chip
      if (gr) best.vel.y *= 1 - P.chip
      best.vel.z *= 1 - P.chip
      // Shove along the shooter's right, so a tracked target drifts off line.
      const nudge = P.nudge * DT * P.fireRate
      best.vel.x += rx * nudge
      if (gr) best.vel.y += ry * nudge
      best.vel.z += rz * nudge
      best.beamCharge += shotValue

      best.beamGrace = BEAM_GRACE

      const lethal = best.beamCharge >= P.breakAt
      if (lethal) {
        best.beamCharge = 0
        this.hit(best, 'laserGatling', P.spinTime)
      }
      r.events.push({ t: 'beamHit', targetId: best.id, lethal })
    }

    // Anyone who has not taken a round inside the grace window bleeds off.
    // Breaking line of sight is the counterplay, so it has to actually work.
    for (const r of s.racers) {
      if (r.beamGrace > 0) { r.beamGrace = Math.max(0, r.beamGrace - DT); continue }
      if (r.beamCharge > 0) r.beamCharge = Math.max(0, r.beamCharge - P.decay * DT)
    }
  }

  private hit(r: RacerState, item: ItemId, spin: number, fullStop = false): void {
    if (r.immuneTime > 0 || r.invincibleTime > 0) return
    r.spinTime = Math.max(r.spinTime, spin)
    r.immuneTime = T.items.staggerShield
    r.lastHitBy = item
    r.driftSide = 0; r.driftCharge = 0; r.driftTier = -1; r.chainStacks = 0
    r.boostTime = 0; r.boostMag = 0; r.boostSource = 'none'
    r.charges = Math.max(0, r.charges - T.boost.chargeLostOnHit)
    r.gatlingTime = 0
    r.beamCharge = 0
    r.beamGrace = 0
    // Retain some velocity so a hit costs position rather than the whole race.
    const keep = fullStop ? 0.05 : T.items.spinRetainVelocity
    r.vel.x *= keep; r.vel.z *= keep
    r.events.push({ t: 'hit', item })
  }

  /**
   * Force a respawn on any racer that has stopped making progress. Racers can
   * wedge one another against a wall at an edge ratio inside `edgeTolerance`,
   * where the off-track watchdog never fires; without this the race can never
   * reach a finished state.
   */
  private resolveStalls(): void {
    const s = this.state
    for (const r of s.racers) {
      if (r.finished || r.respawnTime > 0) { this.stallTimer[r.id] = 0; this.stallMark[r.id] = r.totalS; continue }
      if (r.totalS - this.stallMark[r.id] > STALL_PROGRESS) {
        this.stallMark[r.id] = r.totalS
        this.stallTimer[r.id] = 0
        continue
      }
      this.stallTimer[r.id] += DT
      if (this.stallTimer[r.id] > STALL_SECONDS) {
        r.respawnTime = T.offTrack.respawnDuration
        this.stallTimer[r.id] = 0
        this.stallMark[r.id] = r.totalS
      }
    }
  }

  private resolveLaps(): void {
    const s = this.state
    const lapLen = this.track.length
    for (const r of s.racers) {
      if (r.finished) continue
      const lapsDone = Math.floor(r.totalS / lapLen)
      if (lapsDone > r.lap && r.totalS > 0) {
        const prev = r.lapTimes.reduce((a, b) => a + b, 0)
        const lapTime = s.time - prev
        r.lapTimes.push(lapTime)
        if (r.bestLap === 0 || lapTime < r.bestLap) r.bestLap = lapTime
        r.lap = lapsDone
        r.events.push({ t: 'lap', lap: r.lap, time: lapTime })
        if (r.lap >= s.totalLaps) {
          r.finished = true
          r.finishTime = s.time
          s.finishOrder.push(r.id)
          r.position = s.finishOrder.length
          r.events.push({ t: 'finish', position: r.position })
        }
      }
    }
  }

  private updatePositions(): void {
    const s = this.state
    const running = s.racers.filter((r) => !r.finished)
    running.sort((a, b) => b.totalS - a.totalS)
    let p = s.finishOrder.length
    for (const r of running) r.position = ++p
  }

  /** Quantised state hash for the determinism gate. */
  hash(): string {
    const vals: number[] = [this.state.time, this.state.frame]
    for (const r of this.state.racers) {
      vals.push(r.pos.x, r.pos.y, r.pos.z, r.vel.x, r.vel.z, r.yaw,
        r.driftCharge, r.boostMag, r.boostTime, r.totalS, r.charges, r.spinTime,
        r.gatlingTime, r.beamCharge, r.driftInward)
    }
    return hashFloats(vals)
  }

  results(): { id: number; chassisId: string; position: number; time: number; bestLap: number }[] {
    return this.state.racers
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((r) => ({ id: r.id, chassisId: r.chassisId, position: r.position, time: r.finishTime, bestLap: r.bestLap }))
  }
}

export { clamp01, sign, type Vec3 }
