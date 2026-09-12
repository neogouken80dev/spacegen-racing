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
import { BOOST_SOUND, CATALOGUE, FIRE_SOUND, HIT_SOUND } from './catalogue'

/** Past this, another car's one-shots are not worth a voice. Metres. */
export const HEAR_RANGE = 150

/** Inside this, no attenuation at all -- it is effectively on top of you. */
const NEAR_RANGE = 12

/**
 * Contact force that counts as a crash rather than a scrape, in m/s of closing
 * speed. Below it a contact only feeds the sustained scrape.
 *
 * Deliberately the same quantity `T.collision.hardImpactSpeed` prices the
 * physics bite on, so what you HEAR as a crash is what the game CHARGED you for
 * as a crash. Two thresholds here would drift apart and the audio would start
 * lying about the handling.
 */
export const CRASH_FORCE = 9

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

/**
 * Decides what may sound, and remembers what already did.
 *
 * One instance per race. Holds only numbers, so a test can drive it through a
 * thousand frames in milliseconds and assert that a barrier lean produced four
 * sounds rather than four hundred.
 */
export class AudioPlanner {
  private readonly gates = new Map<SoundId, Gate>()
  /** Last time each sustained contact saw a frame, and at what force. */
  private wallSeen = -1
  private wallForce = 0
  private wallAt: { x: number; y: number; z: number } | null = null
  private carSeen = -1
  private carForce = 0
  private carAt: { x: number; y: number; z: number } | null = null

  /** Wipe between races so a rematch cannot inherit a held scrape. */
  reset(): void {
    this.gates.clear()
    this.wallSeen = -1
    this.carSeen = -1
    this.wallForce = 0
    this.carForce = 0
  }

  /** Would this id be allowed to sound right now? */
  allowed(id: SoundId, now: number, def = CATALOGUE[id]): boolean {
    const g = this.gates.get(id)
    if (!g) return true
    if (now - g.last < def.minGap) return false
    let live = 0
    for (const t of g.until) if (t > now) live++
    return live < def.maxVoices
  }

  private take(id: SoundId, now: number, def: SoundDef): void {
    const end = now + voiceHold(def)
    const g = this.gates.get(id)
    if (!g) { this.gates.set(id, { last: now, until: [end] }); return }
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

    for (let i = 0; i < events.length; i++) {
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
      for (const ev of evs) {
        // Contacts never become one-shots on their own. See the header.
        if (ev.t === 'wall') {
          wallThisFrame = Math.max(wallThisFrame, ev.force * near)
          if (wallThisFrame > 0) this.wallAt = { x: ev.px, y: ev.py, z: ev.pz }
          if (ev.force >= CRASH_FORCE) {
            this.emit(plays, 'crashWall', near * clamp01(ev.force / (CRASH_FORCE * 2.2)),
              { x: ev.px, y: ev.py, z: ev.pz }, now, isLocal)
          }
          continue
        }
        if (ev.t === 'bump') {
          carThisFrame = Math.max(carThisFrame, ev.force * near)
          if (carThisFrame > 0) this.carAt = { x: ev.px, y: ev.py, z: ev.pz }
          if (ev.force >= CRASH_FORCE * 0.7) {
            this.emit(plays, 'crashCar', near * clamp01(ev.force / (CRASH_FORCE * 2.0)),
              { x: ev.px, y: ev.py, z: ev.pz }, now, isLocal)
          }
          continue
        }
        const one = this.forEvent(ev, isLocal, state)
        if (one) this.emit(plays, one.id, near * one.gain, isLocal ? null : pos, now, isLocal)
      }
    }

    if (wallThisFrame > 0) { this.wallSeen = now; this.wallForce = wallThisFrame }
    if (carThisFrame > 0) { this.carSeen = now; this.carForce = carThisFrame }

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

  private emit(
    into: PlayRequest[], id: SoundId, gain: number,
    at: { x: number; y: number; z: number } | null,
    now: number, isLocal: boolean,
  ): void {
    if (gain <= 0.02) return
    const def: SoundDef = CATALOGUE[id]
    if (!this.allowed(id, now, def)) return
    this.take(id, now, def)
    const v = def.vary ?? 0
    // Deterministic jitter is not required -- audio is not in the sim hash --
    // and a random spread is what stops ten gatling rounds sounding like one
    // sample retriggered, which is exactly what they are.
    const rate = v > 0 ? 1 + (Math.random() * 2 - 1) * v : 1
    into.push({ id, gain: Math.min(1, gain), rate, at: def.positional && !isLocal ? at : null })
  }

  /** Which sound an event makes, and how loud relative to its own kind. */
  private forEvent(
    ev: RacerEvent, isLocal: boolean, state: RaceState,
  ): { id: SoundId; gain: number } | null {
    switch (ev.t) {
      case 'boost': {
        const tier = Math.max(0, Math.min(BOOST_SOUND.length - 1, ev.tier | 0))
        return { id: BOOST_SOUND[tier], gain: 1 }
      }
      case 'driftStart':
        // Only your own. Eight cars entering slides is a hiss with no meaning.
        return isLocal ? { id: 'driftStart', gain: 1 } : null
      case 'driftEnd':
        return isLocal && ev.tier >= 0 ? { id: 'driftRelease', gain: 1 } : null
      case 'fire':
        return { id: FIRE_SOUND[ev.item] ?? 'fireMissile', gain: 1 }
      case 'hit':
        return { id: HIT_SOUND[ev.item] ?? 'hitLight', gain: 1 }
      case 'guard': return { id: 'guard', gain: 1 }
      case 'ward': return { id: 'ward', gain: 1 }
      case 'pickup': return { id: 'pickup', gain: isLocal ? 1 : 0.7 }
      case 'charge': return { id: 'charge', gain: isLocal ? 1 : 0.5 }
      case 'beamFire': return { id: 'beamFire', gain: isLocal ? 0.9 : 0.6 }
      case 'beamHit': return { id: ev.lethal ? 'beamBreak' : 'beamHit', gain: 1 }
      case 'ramp': return { id: 'ramp', gain: clamp01(0.5 + ev.power * 0.5) }
      case 'land':
        // A clean landing is an achievement and gets its own bright cue on top
        // of the thump; a scrappy one just thumps.
        return ev.clean && isLocal ? { id: 'landClean', gain: 1 } : { id: 'land', gain: 1 }
      case 'lap': {
        if (!isLocal) return null
        const total = state.totalLaps ?? 3
        return { id: ev.lap >= total ? 'lapFinal' : 'lap', gain: 1 }
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
  return {
    rate: enginePitch(speed, topSpeed),
    gain: near * (0.22 + 0.78 * load),
    boost: r.boostTime > 0 ? clamp01(r.boostMag / 0.35) : 0,
    drift: r.driftSide !== 0 ? clamp01(0.35 + r.driftCharge * 0.2) : 0,
    at: isLocal ? null : { x: r.pos.x, y: r.pos.y, z: r.pos.z },
  }
}
