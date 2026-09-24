/**
 * SpaceGen Racing — the audio planner.
 * ---------------------------------------------------------------------------
 * Pure. Sim events in, a list of sounds out. No Web Audio, no DOM, no clock of
 * its own -- the caller passes `now`, so a test can step it a frame at a time
 * and assert on what came back.
 *
 * This file holds every rule worth having in a game's audio, and all of them
 * are rules about NOT playing something:
 *
 *   THE CONTACT PROBLEM. `wall` and `bump` fire on EVERY contact frame. That is
 *   deliberate in the sim -- it is what lets the VFX scale a scrape against a
 *   crash without a second threshold -- but a one-shot per event is sixty
 *   sounds a second per car. A car leaning on a barrier through a long corner
 *   would produce several hundred. So contacts do not become one-shots at all:
 *   they drive a SUSTAINED scrape whose gain tracks the force, and only the
 *   hard end of the distribution also fires an impact.
 *
 *   THE FIELD PROBLEM. Eight cars, each generating pickups, fires, hits and
 *   landings. Everything from another car is distance-attenuated and dropped
 *   entirely past a cutoff, and every id carries a repeat floor so one missile
 *   catching three cars in a frame is one sound rather than three stacked 10 dB
 *   hot.
 *
 *   THE PLAYER PROBLEM, which the field problem's own fix created. Those
 *   repeat floors were ONE per sound, shared by all eight cars, and racers
 *   were visited in index order -- so seven AI cars spent the player's slots.
 *   Measured over six AI races with racer 0 standing in for the player: 14 of
 *   154 of the player's own boosts, 26 of 110 landings and 9 of 35 ramps were
 *   silenced by a floor another car had just taken. With the player in slot 5,
 *   as in multiplayer, 16 of 17 of their EMP-hit sounds and 58 of 79 car
 *   crashes went the same way, because the EMP lands on the whole field in one
 *   frame and lower-numbered cars were always asked first. The floors are now
 *   kept separately for the player and for everyone else, the player is heard
 *   first, and the field YIELDS to the player rather than competing: see
 *   `allowed`.
 *
 *   THE DISPLAY PROBLEM. Events are produced per fixed sim step and consumed
 *   per render frame, which are not the same rate. The Game already carries
 *   events across sub-steps (see eventCarry) so none are lost at 30fps; the
 *   mirror of that at 120fps is that a frame can run zero sim steps and see the
 *   same array twice. Repeat floors make that harmless without this file
 *   needing to know the frame counter.
 */
import type { RacerEvent, RacerState, RaceState } from '../sim/types'
import type {
  AudioFrame, EngineVoice, PlayRequest, ScrapeLevel, SoundDef, SoundId,
} from './api'
import { TUNING } from '../content/tuning'
import { BOOST_SOUND, CATALOGUE, FIRE_SOUND, HIT_SOUND, LAUNCH_SOUND } from './catalogue'
import { lockOnTime, urgency } from './threat'

/** Past this, another car's one-shots are not worth a voice. Metres. */
export const HEAR_RANGE = 150

/** Inside this, no attenuation at all -- it is effectively on top of you. */
const NEAR_RANGE = 12

/**
 * Contact force that counts as a crash rather than a scrape, in m/s of closing
 * speed. Below it a contact only feeds the sustained scrape.
 *
 * HALF of `T.collision.hardImpactSpeed` (18 m/s), and derived from it rather
 * than typed. This comment used to claim the two were "the same quantity", and
 * they were not -- the number here was 9 and the physics value 18, which is
 * exactly the drift it warned about. 18 is where a barrier's bite reaches the
 * full hard-angle scrub; half of it is the point at which the plating pilot's
 * guard spends itself (`severity > hardImpactSpeed * 0.5` in vehicle.ts), which
 * is the physics' own definition of "that was a crash, not a graze". So what
 * you HEAR as a crash is what the game would have spent a guard on.
 */
export const CRASH_FORCE = TUNING.collision.hardImpactSpeed * 0.5

/**
 * Another car's version of a sound the player also makes, relative to the
 * player's own.
 *
 * Boosts, nitro and a gatling break used to reach the player flat and at full
 * level whoever made them -- 235 of the field's boosts over six AI races,
 * against 154 of the player's, all sounding identical. They are positional now
 * (see the catalogue), and trimmed to this: loud enough to hear a rival light
 * up beside you, a clear step below your own.
 */
const OTHER_CAR = 0.6

/** A whole tone, per drift rung. See the drift-tier block in `frame`. */
const TIER_STEP = Math.pow(2, 2 / 12)

/**
 * Seconds between lock-on beeps, from a calm lock to an imminent one. The
 * interval follows `urgency` from threat.ts, so the tone and the rim quicken
 * together; 0.11 s at the sharp end is nine a second, a stutter that reads as
 * "now" without fusing into a drone.
 */
const LOCK_SLOW = 0.55
const LOCK_FAST = 0.11

/**
 * A stun's sputter fades over its last this-many seconds instead of stopping
 * dead, so the engine catches and comes back rather than snapping on.
 */
const STUN_FADE = 0.25

/** Seconds a scrape keeps sounding after its last contact frame. */
const SCRAPE_RELEASE = 0.12

/**
 * Distance falloff, 0..1. Flat inside NEAR_RANGE, then inverse to the cutoff.
 *
 * Inverse rather than linear because linear falloff makes a car at half the
 * cutoff sound half as loud, which is much too present -- at eight cars the mix
 * never clears. Inverse puts most of the audible range close to the listener,
 * which is where the racing the player cares about is happening.
 */
export function falloff(dist: number): number {
  if (dist <= NEAR_RANGE) return 1
  if (dist >= HEAR_RANGE) return 0
  const t = (dist - NEAR_RANGE) / (HEAR_RANGE - NEAR_RANGE)
  return (1 - t) / (1 + 3 * t)
}

/**
 * Engine pitch from speed.
 *
 * Not linear in speed, and not a gearbox either. A single continuous note that
 * rises quickly at low speed and compresses at the top, which is what a turbine
 * does and what every hover and flight chassis in this roster is. A linear map
 * spends most of its audible range on speeds the car is rarely at.
 */
export function enginePitch(speed: number, topSpeed: number): number {
  const t = Math.max(0, Math.min(1.25, speed / Math.max(1, topSpeed)))
  return 0.62 + 1.05 * Math.pow(t, 0.72)
}

interface Gate { last: number; until: number[] }

/**
 * How long a sound occupies a voice slot.
 *
 * The first version of this made `maxVoices` depend on the caller reporting
 * each sound finishing, and that was wrong twice over: the facade released
 * immediately, so the cap never did anything in production, and a test that
 * did NOT release saw the cap latch shut forever after N plays. A counter that
 * only decrements if somebody remembers to decrement it is not a counter.
 *
 * A voice now expires on the planner's own clock. Synth recipes declare their
 * length, so the number is exact; a file declares `holdFor` or falls back to
 * something short, because an over-estimate silences a sound and an
 * under-estimate merely lets one more overlap.
 */
function voiceHold(def: SoundDef): number {
  if (def.source.kind === 'synth') return def.source.recipe.dur
  return def.holdFor ?? 0.4
}

/** Voices still sounding in one gate at `now`. */
function liveIn(g: Gate | undefined, now: number): number {
  if (!g) return 0
  let n = 0
  for (const t of g.until) if (t > now) n++
  return n
}

/** So a state with no projectile array (a test fixture) reads as nothing flying. */
const NO_PROJECTILES: RaceState['projectiles'] = []

/**
 * Decides what may sound, and remembers what already did.
 *
 * One instance per race. Holds only numbers, so a test can drive it through a
 * thousand frames in milliseconds and assert that a barrier lean produced four
 * sounds rather than four hundred.
 */
export class AudioPlanner {
  /**
   * TWO SETS OF REPEAT FLOORS: the player's, and everyone else's.
   *
   * One shared set is what let the field silence the player -- see the header.
   * Two maps rather than one keyed by `id + ':' + isLocal`, because this is
   * consulted for every event of every car on every frame and a string built
   * per lookup is an allocation in the render loop that buys nothing.
   */
  private readonly gatesLocal = new Map<SoundId, Gate>()
  private readonly gatesOther = new Map<SoundId, Gate>()
  /** Last time each sustained contact saw a frame, and at what force. */
  private wallSeen = -1
  private wallForce = 0
  private wallAt: { x: number; y: number; z: number } | null = null
  private carSeen = -1
  private carForce = 0
  private carAt: { x: number; y: number; z: number } | null = null
  /** The player's drift rung as of the last frame; -1 while not sliding. */
  private lastTier = -1
  /** Race time the next lock-on beep is due. 0 while nothing has a lock. */
  private lockNext = 0
  /** The order `frame` visits racers in: the player, then the field. Reused. */
  private readonly order: number[] = []

  /** Wipe between races so a rematch cannot inherit a held scrape. */
  reset(): void {
    this.gatesLocal.clear()
    this.gatesOther.clear()
    this.wallSeen = -1
    this.carSeen = -1
    this.wallForce = 0
    this.carForce = 0
    this.lastTier = -1
    this.lockNext = 0
  }

  /**
   * Would this id be allowed to sound right now?
   *
   * THE PLAYER answers only to their own floor. Nothing another car does can
   * take a slot from them, which is the bug the split exists to close.
   *
   * THE FIELD YIELDS to the player on top of its own floor, and in two ways.
   * It may not play an id the player played inside that id's minGap -- a
   * missile catching you and the car beside you in one frame is still one
   * explosion, and the one you hear is yours -- and its live voices count
   * against the cap TOGETHER with the player's, so the field fills whatever
   * headroom the player leaves and never adds a second full set beside it. The
   * asymmetry is the point. Two independent sets of floors would have fixed
   * the stealing by doubling every shared moment instead.
   */
  allowed(id: SoundId, now: number, isLocal = true, def: SoundDef = CATALOGUE[id]): boolean {
    const mine = this.gatesLocal.get(id)
    if (mine && now - mine.last < def.minGap) return false
    if (isLocal) return liveIn(mine, now) < def.maxVoices
    const theirs = this.gatesOther.get(id)
    if (theirs && now - theirs.last < def.minGap) return false
    return liveIn(mine, now) + liveIn(theirs, now) < def.maxVoices
  }

  private take(id: SoundId, now: number, def: SoundDef, isLocal: boolean): void {
    const gates = isLocal ? this.gatesLocal : this.gatesOther
    const end = now + voiceHold(def)
    const g = gates.get(id)
    if (!g) { gates.set(id, { last: now, until: [end] }); return }
    g.last = now
    // Drop expired entries while we are here, so this array cannot grow across
    // a whole race for a sound that fires ten times a second.
    const keep: number[] = []
    for (const t of g.until) if (t > now) keep.push(t)
    keep.push(end)
    g.until = keep
  }

  /**
   * Plan one render frame.
   *
   * `events` is the carried set from the Game -- the same array the VFX read,
   * so audio and art can never disagree about what happened.
   */
  frame(
    state: RaceState,
    events: readonly (readonly RacerEvent[])[],
    localId: number,
    listener: { x: number; y: number; z: number },
    now: number,
  ): AudioFrame {
    const plays: PlayRequest[] = []
    let wallThisFrame = 0
    let carThisFrame = 0

    // THE PLAYER FIRST. With the floors split this no longer decides whether
    // the player is heard -- nothing the field does can take their slot -- but
    // it decides which of two copies of one moment the field yields to (see
    // `allowed`), and that has to be the player's, in every seat. It used to be
    // index order, which is why slot 5 lost nine EMP hits in ten.
    const order = this.order
    order.length = 0
    if (localId >= 0 && localId < events.length) order.push(localId)
    for (let i = 0; i < events.length; i++) if (i !== localId) order.push(i)

    for (let k = 0; k < order.length; k++) {
      const i = order[k]
      const racer = state.racers[i]
      if (!racer) continue
      const isLocal = i === localId
      const pos = racer.pos
      const dist = isLocal ? 0 : Math.hypot(
        pos.x - listener.x, pos.y - listener.y, pos.z - listener.z,
      )
      if (!isLocal && dist > HEAR_RANGE) continue
      const near = isLocal ? 1 : falloff(dist)

      // A caller handing over a sparse array is a bug in the caller -- main.ts
      // did exactly that and threw here every frame -- but a missing slot means
      // "this racer had no events", which is a silence, not a crash. Audio is
      // the one subsystem whose whole failure contract is to go quiet.
      const evs = events[i]
      if (!evs) continue

      // THE PLATING ATE IT. A guard is pushed in the same step as the wall
      // contact it absorbed (vehicle.ts: the `guard` event, then the `wall`
      // event carrying the contact's FULL force), so a planner reading forces
      // alone heard every guard as a crash: 28 of 28 guards over six AI races
      // played crashWall on top of the guard chime. The plating's whole
      // presentation is "that cost you nothing", and a crash says otherwise.
      let guarded = false
      for (let e = 0; e < evs.length; e++) if (evs[e].t === 'guard') { guarded = true; break }

      for (let e = 0; e < evs.length; e++) {
        const ev = evs[e]
        // Contacts never become one-shots on their own. See the header.
        if (ev.t === 'wall') {
          // THE SCRAPE IS THE PLAYER'S OWN. It is one flat voice, so it cannot
          // say WHOSE contact it is voicing, and it was voicing everybody's:
          // 73% of the frames it sounded over six AI races were driven by
          // another car leaning on a barrier -- a hiss in the player's ears for
          // contact they were not in. Other cars still crash, positionally.
          if (isLocal && ev.force > 0) {
            wallThisFrame = Math.max(wallThisFrame, ev.force)
            this.wallAt = { x: ev.px, y: ev.py, z: ev.pz }
          }
          if (ev.force >= CRASH_FORCE && !guarded) {
            this.emit(plays, 'crashWall', near * clamp01(ev.force / (CRASH_FORCE * 2.2)),
              { x: ev.px, y: ev.py, z: ev.pz }, now, isLocal)
          }
          continue
        }
        if (ev.t === 'bump') {
          if (isLocal && ev.force > 0) {
            carThisFrame = Math.max(carThisFrame, ev.force)
            this.carAt = { x: ev.px, y: ev.py, z: ev.pz }
          }
          // A bump is pushed on BOTH cars of the pair. The player's copy is
          // heard first; the other car's mirror of it arrives inside crashCar's
          // minGap and yields, so one collision is still one crash.
          if (ev.force >= CRASH_FORCE * 0.7) {
            this.emit(plays, 'crashCar', near * clamp01(ev.force / (CRASH_FORCE * 2.0)),
              { x: ev.px, y: ev.py, z: ev.pz }, now, isLocal)
          }
          continue
        }
        const one = this.forEvent(ev, isLocal, state, e > 0 ? evs[e - 1] : null)
        if (one) this.emit(plays, one.id, near * one.gain, isLocal ? null : pos, now, isLocal)
      }
    }

    if (wallThisFrame > 0) { this.wallSeen = now; this.wallForce = wallThisFrame }
    if (carThisFrame > 0) { this.carSeen = now; this.carForce = carThisFrame }

    const me = localId >= 0 ? state.racers[localId] : undefined
    if (me) {
      // THE DRIFT LADDER, ALOUD. `driftTier` was in the catalogue, preloaded on
      // every unlock, and described by index.ts as the drift "already speaking"
      // -- and nothing ever played it. Read off STATE rather than an event
      // because the sim fires none for a rung: the tier simply goes up. State
      // is also immune to the zero-step frame, which shows the same event array
      // twice but can never show a tier rising twice.
      //
      // Up only, and only while sliding: a release drops the tier to -1 and a
      // hit zeroes it, and neither is a rung. Pitched a whole tone per rung so
      // Spark to Singularity is a climb the player can hear without looking.
      const tier = me.driftSide !== 0 ? me.driftTier : -1
      if (tier > this.lastTier && tier >= 0) {
        this.emit(plays, 'driftTier', 1, null, now, true, Math.pow(TIER_STEP, tier > 3 ? 3 : tier))
      }
      this.lastTier = tier
    }

    // THE LOCK-ON TONE. The rim has always shown an incoming missile, and a
    // rim is exactly where the player is not looking when a seeker comes up
    // from behind. `lockOnTime` is the rim's own rule (threat.ts), so the two
    // agree about what is hunting whom. Only for a real, un-finished player in
    // a live race: the attract loop hands this an index with nobody behind it,
    // and a warning about a missile aimed at nobody is worse than silence.
    //
    // The beep is scheduled on the RACE clock, so a paused race holding a
    // missile in mid-air is silent rather than beeping at a frozen frame, and
    // it quickens as the missile closes. When the threat jumps nearer the next
    // beep is pulled in, rather than waiting out an interval that was chosen
    // when it was further away.
    const projectiles = state.projectiles ?? NO_PROJECTILES
    const tti = me && me.isLocal && !me.finished && state.phase === 'racing'
      ? lockOnTime(projectiles, me) : -1
    if (tti < 0) {
      this.lockNext = 0
    } else {
      const u = urgency(tti)
      const gap = LOCK_SLOW + (LOCK_FAST - LOCK_SLOW) * u
      if (this.lockNext === 0 || now >= this.lockNext) {
        this.emit(plays, 'lockOn', 0.75 + 0.25 * u, null, now, true, 1 + 0.25 * u)
        this.lockNext = now + gap
      } else if (this.lockNext - now > gap) {
        this.lockNext = now + gap
      }
    }

    return { plays, scrapes: this.scrapes(now) }
  }

  /**
   * The sustained contacts, held briefly past their last frame.
   *
   * The release matters: contact is not continuous frame to frame even while a
   * car is leaning on a barrier -- the clamp pushes it off and the drift pushes
   * it back -- so a scrape gated strictly on "was there an event this frame"
   * stutters at exactly the moment it should be steadiest.
   */
  private scrapes(now: number): ScrapeLevel[] {
    const out: ScrapeLevel[] = []
    const wall = now - this.wallSeen < SCRAPE_RELEASE ? this.wallForce : 0
    const car = now - this.carSeen < SCRAPE_RELEASE ? this.carForce : 0
    out.push({ id: 'scrapeWall', gain: clamp01(wall / CRASH_FORCE) * 0.9, at: wall > 0 ? this.wallAt : null })
    out.push({ id: 'scrapeCar', gain: clamp01(car / (CRASH_FORCE * 0.8)) * 0.8, at: car > 0 ? this.carAt : null })
    return out
  }

  /**
   * @param pitch a playback-rate multiplier for sounds that carry meaning in
   *   their pitch (the drift rungs, the lock-on), applied under the random
   *   spread rather than instead of it.
   */
  private emit(
    into: PlayRequest[], id: SoundId, gain: number,
    at: { x: number; y: number; z: number } | null,
    now: number, isLocal: boolean, pitch = 1,
  ): void {
    if (gain <= 0.02) return
    const def: SoundDef = CATALOGUE[id]
    if (!this.allowed(id, now, isLocal, def)) return
    this.take(id, now, def, isLocal)
    const v = def.vary ?? 0
    // Deterministic jitter is not required -- audio is not in the sim hash --
    // and a random spread is what stops ten gatling rounds sounding like one
    // sample retriggered, which is exactly what they are.
    const rate = pitch * (v > 0 ? 1 + (Math.random() * 2 - 1) * v : 1)
    into.push({ id, gain: Math.min(1, gain), rate, at: def.positional && !isLocal ? at : null })
  }

  /**
   * Which sound an event makes, and how loud relative to its own kind.
   *
   * @param prev the event pushed immediately before this one on the same
   *   racer, which is how a landing learns whether it paid out (see `land`).
   */
  private forEvent(
    ev: RacerEvent, isLocal: boolean, state: RaceState, prev: RacerEvent | null,
  ): { id: SoundId; gain: number } | null {
    switch (ev.t) {
      case 'boost': {
        const tier = Math.max(0, Math.min(BOOST_SOUND.length - 1, ev.tier | 0))
        return { id: BOOST_SOUND[tier], gain: isLocal ? 1 : OTHER_CAR }
      }
      case 'launch':
        /**
         * THE STANDING START, AND ONLY YOUR OWN.
         *
         * Same rule as driftStart below and a stronger case for it: all eight
         * cars resolve their launch inside about half a second, so playing the
         * field's would put up to eight one-shots into the single frame the GO
         * cue is in -- and the whole reason this event exists is to tell the
         * PLAYER which of three things THEY just did. A grade they cannot
         * attribute teaches nothing, which is the bug being fixed.
         */
        return isLocal ? { id: LAUNCH_SOUND[ev.grade], gain: 1 } : null
      case 'driftStart':
        // Only your own. Eight cars entering slides is a hiss with no meaning.
        return isLocal ? { id: 'driftStart', gain: 1 } : null
      case 'driftEnd':
        return isLocal && ev.tier >= 0 ? { id: 'driftRelease', gain: 1 } : null
      case 'fire': {
        const id = FIRE_SOUND[ev.item] ?? 'fireMissile'
        // Nitro is a boost by another name, and gets the boost's trim.
        return { id, gain: !isLocal && id === 'fireNitro' ? OTHER_CAR : 1 }
      }
      case 'hit':
        return { id: HIT_SOUND[ev.item] ?? 'hitLight', gain: 1 }
      case 'guard': return { id: 'guard', gain: 1 }
      case 'ward': return { id: 'ward', gain: 1 }
      case 'pickup': return { id: 'pickup', gain: isLocal ? 1 : 0.7 }
      case 'charge': return { id: 'charge', gain: isLocal ? 1 : 0.5 }
      case 'beamFire': return { id: 'beamFire', gain: isLocal ? 0.9 : 0.6 }
      // The gatling's break is reported on the SHOOTER (race.ts), so "another
      // car" here means another car scored it -- their achievement, their trim.
      case 'beamHit':
        return ev.lethal
          ? { id: 'beamBreak', gain: isLocal ? 1 : OTHER_CAR }
          : { id: 'beamHit', gain: 1 }
      case 'ramp': return { id: 'ramp', gain: clamp01(0.5 + ev.power * 0.5) }
      case 'land':
        /**
         * THE CHIME IS FOR A LANDING THAT PAID.
         *
         * `clean` only says the nose was lined up on touchdown, and on level
         * road it is lined up almost every time: the chime played about 19
         * times a minute, and about 7% of those landings actually awarded
         * anything. A reward cue that fires regardless of the reward stops
         * meaning reward. Every branch of the landing code in vehicle.ts pushes
         * the trick or clean-landing `boost` IMMEDIATELY before the `land` it
         * belongs to, so the event before this one is the whole test -- and
         * it cannot be fooled by a drift release elsewhere in the same frame.
         */
        return ev.clean && isLocal && prev !== null && prev.t === 'boost'
          ? { id: 'landClean', gain: 1 }
          : { id: 'land', gain: 1 }
      case 'lap': {
        if (!isLocal) return null
        /**
         * `ev.lap` IS LAPS COMPLETED, not the lap being started (race.ts
         * resolveLaps pushes `r.lap` after incrementing it). The final-lap cue
         * was `ev.lap >= total`, which is the chequered flag -- so it announced
         * the last lap at the moment the race ended, stacked on `finish`. It
         * fires when the LAST lap begins now, and the flag itself belongs to
         * `finish` alone.
         */
        const total = state.totalLaps ?? 3
        if (ev.lap >= total) return null
        return { id: ev.lap === total - 1 ? 'lapFinal' : 'lap', gain: 1 }
      }
      case 'finish': return isLocal ? { id: 'finish', gain: 1 } : null
      case 'crack': return { id: 'crack', gain: 1 }
      default: return null
    }
  }
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v }

/**
 * The engine voice for one racer, or null if it is not worth sounding.
 *
 * Culled by distance rather than by racer index so the eight nearest cars are
 * the eight you hear, which on a circuit is not the same set for long. A voice
 * per car is the single most expensive thing in this module -- each is a live
 * oscillator pair -- so the cutoff is tighter than for one-shots.
 */
export function engineFor(
  r: RacerState, topSpeed: number, isLocal: boolean,
  listener: { x: number; y: number; z: number },
): EngineVoice | null {
  const speed = Math.hypot(r.vel.x, r.vel.y, r.vel.z)
  const dist = isLocal ? 0 : Math.hypot(
    r.pos.x - listener.x, r.pos.y - listener.y, r.pos.z - listener.z,
  )
  if (!isLocal && dist > HEAR_RANGE * 0.62) return null
  const near = isLocal ? 1 : falloff(dist) * 0.8
  if (near <= 0.02) return null
  // Idle is audible: a car sitting on the grid still has something running, and
  // a note that fades to nothing at a standstill makes the countdown feel dead.
  const load = clamp01(speed / Math.max(1, topSpeed))
  /**
   * SYSTEMS DOWN. An EMP stuns for 1.1 s (0.6 if boosting) and the only thing
   * that ever said so was the one-shot on impact: for the rest of the stun the
   * engine carried on revving as if nothing had happened, while the car sat
   * there refusing to drive. It sputters now -- chopped by the stage, ducked
   * and dropped in pitch here -- and catches again over the last STUN_FADE
   * seconds. The jump start's bog is the same `stunTime` and wants the same
   * sound, which is why this reads the timer rather than who caused it.
   *
   * The player's engine only. The field's engines are too quiet and too far
   * for a stutter to read, and an EMP stuns everyone at once -- seven engines
   * chopping together would be a noise, not a fact about anyone.
   */
  const stun = isLocal && r.stunTime > 0 ? clamp01(r.stunTime / STUN_FADE) : 0
  return {
    rate: enginePitch(speed, topSpeed) * (1 - 0.16 * stun),
    gain: near * (0.22 + 0.78 * load) * (1 - 0.35 * stun),
    boost: r.boostTime > 0 ? clamp01(r.boostMag / 0.35) : 0,
    drift: r.driftSide !== 0 ? clamp01(0.35 + r.driftCharge * 0.2) : 0,
    stun,
    at: isLocal ? null : { x: r.pos.x, y: r.pos.y, z: r.pos.z },
  }
}
