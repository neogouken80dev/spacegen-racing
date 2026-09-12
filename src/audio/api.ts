/**
 * SpaceGen Racing — audio types and the sound catalogue's shape.
 * ---------------------------------------------------------------------------
 * The whole module is built on one split, and it is the same split
 * ui/garagePreview.ts makes for the same reason:
 *
 *   PLANNING   decides WHAT should be heard. Pure arithmetic over sim events:
 *              which sound, how loud, from where, and above all what to
 *              SUPPRESS. No Web Audio, no DOM, testable in node.
 *   THE STAGE  is the only code that knows what an AudioContext is.
 *
 * That is not tidiness. Every rule worth having in a game's audio -- do not
 * play four hundred wall taps a second, do not let eight cars' pickups drown
 * the music, duck under a voice line and come back -- is a rule about numbers,
 * and none of them can be tested through a browser at a frame rate that is
 * 1-5fps under SwiftShader. Pure, they are unit tests that run in milliseconds.
 *
 * SILENCE IS A SUPPORTED STATE.
 *
 * A browser with Web Audio blocked, an autoplay policy that never gets its
 * gesture, a device that fails to construct a context: all of them end with
 * `stage === null` and every call becoming a no-op. The game plays silently and
 * says nothing about it, exactly as the garage preview hides itself rather than
 * showing a player an error about WebGL. Audio is the one subsystem a player
 * may deliberately have turned off at the OS level, so a failure here is not
 * even necessarily a failure.
 */

/** Every sound the game can make. */
export type SoundId =
  // --- driving -------------------------------------------------------------
  | 'boost0' | 'boost1' | 'boost2' | 'boost3'
  | 'driftStart' | 'driftTier' | 'driftRelease'
  | 'land' | 'landClean' | 'ramp'
  /** Sustained, gain tracks contact force. See ScrapeId. */
  | 'scrapeWall' | 'scrapeCar'
  /** One-shots for the hard end of the same two contacts. */
  | 'crashWall' | 'crashCar'
  // --- items ---------------------------------------------------------------
  | 'pickup' | 'charge'
  | 'fireMissile' | 'fireSeeker' | 'fireAlpha' | 'fireRail'
  | 'fireMine' | 'fireEmp' | 'fireWell' | 'fireGatling' | 'fireNitro'
  | 'beamFire' | 'beamHit' | 'beamBreak'
  | 'hitLight' | 'hitHeavy' | 'hitEmp'
  | 'guard' | 'ward'
  // --- race ----------------------------------------------------------------
  | 'countdown' | 'countdownGo' | 'lap' | 'lapFinal' | 'finish' | 'crack'
  // --- front end -----------------------------------------------------------
  | 'uiMove' | 'uiSelect' | 'uiBack' | 'uiStart'

/** The two sustained contacts. Their gain is driven, not triggered. */
export type ScrapeId = 'scrapeWall' | 'scrapeCar'

/** Which fader a sound answers to. */
export type Bus = 'sfx' | 'music' | 'vo'

/**
 * A sound is EITHER a file or a synth recipe, and the rest of the system does
 * not care which.
 *
 * That is the point of the union. The game has no audio assets at all today, so
 * a system that could only play files would be untestable and unshippable until
 * someone delivers a hundred wavs. Every sound below therefore ships with a
 * synth recipe that is honest placeholder material -- audible, distinguishable,
 * roughly the right shape -- and upgrading one to a real recording is a
 * one-line edit that nothing else in the codebase notices.
 *
 * It also means the arcade one-shots may simply never become files. A boost
 * whoosh generated from a filtered noise burst costs zero bytes over the wire
 * on a PWA with a download budget, never needs decoding, and can be varied per
 * play so the tenth one does not sound like a copy of the first.
 */
export type SoundSource =
  | { kind: 'file'; url: string }
  | { kind: 'synth'; recipe: SynthRecipe }

/**
 * A placeholder voice, described rather than sampled.
 *
 * Four shapes cover everything this game needs to say. They are deliberately
 * crude: the job is to be RECOGNISABLY DIFFERENT from one another so a
 * developer can hear that the right event fired, not to sound good.
 *
 *   tone   pitched body. Boosts, pickups, UI, laps.
 *   noise  filtered noise burst. Impacts, scrapes, whooshes.
 *   zap    fast downward or upward sweep. Weapons.
 *   thud   low sine with a fast pitch drop. Heavy hits, crashes.
 */
export interface SynthRecipe {
  shape: 'tone' | 'noise' | 'zap' | 'thud'
  /** Start frequency, Hz. For `noise`, the filter centre. */
  freq: number
  /** End frequency, Hz. Equal to `freq` means no sweep. */
  freqTo?: number
  /** Seconds from trigger to silence. */
  dur: number
  /** Peak gain 0..1 before the bus fader. */
  gain: number
  /** Attack, seconds. Zero is a click, which is sometimes what you want. */
  attack?: number
  /** Overtone added an octave (or `harmonic`) up, 0..1. Gives a tone body. */
  harm?: number
  harmonic?: number
  /** Noise-shape bandwidth as a Q. Low is a rumble, high is a ping. */
  q?: number
}

export interface SoundDef {
  source: SoundSource
  bus: Bus
  /**
   * Minimum seconds between two plays of this id. The single most important
   * field in the table.
   *
   * `wall` and `bump` fire on EVERY contact frame -- the sim's own type docs say
   * so, because that is what lets the VFX scale a scrape against a crash
   * without a second threshold. Sixty events a second through a naive player is
   * a machine gun. Most of that is handled by routing contacts to a sustained
   * scrape instead (see planContacts), but every other id gets a floor too: a
   * missile impact that lands on three cars in one frame should be one sound,
   * not three stacked 6dB louder.
   */
  minGap: number
  /** How many of this id may sound at once. */
  maxVoices: number
  /** Random playback-rate spread, +/- this fraction. Kills machine-gunning. */
  vary?: number
  /**
   * Seconds this sound occupies a voice slot. Synth recipes declare their own
   * length so they never need this; a file should, or it falls back to a short
   * default. Over-estimating silences the sound, under-estimating only allows
   * one more overlap -- so the default errs short.
   */
  holdFor?: number
  /** Plays at a world position rather than flat. */
  positional?: boolean
}

/** One decision the planner made: play this, now, like this. */
export interface PlayRequest {
  id: SoundId
  /** 0..1, before the bus fader. Already includes distance falloff. */
  gain: number
  /** Playback-rate multiplier, already jittered. */
  rate: number
  /** World position, or null for a flat sound. */
  at: { x: number; y: number; z: number } | null
}

/** The level of a sustained contact this frame. Zero means stop. */
export interface ScrapeLevel {
  id: ScrapeId
  gain: number
  at: { x: number; y: number; z: number } | null
}

/** What the planner produced for one render frame. */
export interface AudioFrame {
  plays: PlayRequest[]
  scrapes: ScrapeLevel[]
}

/** Per-bus volumes, 0..1, plus a master mute. */
export interface Volumes {
  master: number
  music: number
  sfx: number
  vo: number
  muted: boolean
}

export const DEFAULT_VOLUMES: Volumes = {
  master: 0.8, music: 0.6, sfx: 0.85, vo: 0.9, muted: false,
}

/**
 * The browser-facing half. Everything here touches Web Audio; nothing here
 * makes a decision.
 *
 * Expressed as an interface so the core can be handed a fake one in tests and
 * its whole lifecycle -- unlock, volume changes, teardown, the engine voices
 * coming and going with the field -- can be exercised with no audio hardware
 * and no browser, the same way PreviewStage lets garagePreview be tested with
 * no GPU.
 */
export interface AudioStage {
  /** True once a user gesture has actually started the context. */
  readonly running: boolean
  /** Resume after a gesture. Safe to call repeatedly. */
  unlock(): void
  setVolumes(v: Volumes): void
  /** Where the listener is, for positional sounds. */
  setListener(
    px: number, py: number, pz: number,
    fx: number, fy: number, fz: number,
    ux: number, uy: number, uz: number,
  ): void
  play(req: PlayRequest, def: SoundDef): void
  /** Drive a sustained contact. gain 0 stops it. */
  setScrape(id: ScrapeId, level: ScrapeLevel | null): void
  /** Continuous per-racer engine. `null` retires that racer's voice. */
  setEngine(racerId: number, v: EngineVoice | null): void
  /** Crossfade the music bed. `null` fades to silence. */
  setMusic(url: string | null, fadeSeconds: number): void
  /** Begin fetching these now, so they are ready when wanted. */
  preload(urls: readonly string[]): void
  /** A one-shot on the music bus. Returns false if nothing was ready. */
  sting(url: string): boolean
  /** Duck the music bus to `level` for `hold` seconds, then restore. */
  duck(level: number, hold: number): void
  /** Speak a VO line. Returns false if nothing was available to play. */
  speak(url: string): boolean
  dispose(): void
}

/** One car's engine, as numbers. The stage turns this into oscillators. */
export interface EngineVoice {
  /** Base pitch multiplier from speed, roughly 0.5..2. */
  rate: number
  /** 0..1 overall loudness, already distance-attenuated. */
  gain: number
  /** 0..1 extra harmonic bite while boosting. */
  boost: number
  /** 0..1 drift layer, the tyre/repulsor squall. */
  drift: number
  at: { x: number; y: number; z: number } | null
}
