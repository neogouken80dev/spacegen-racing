/**
 * SpaceGen Racing — the audio facade.
 * ---------------------------------------------------------------------------
 * What the Game talks to. Owns the lifecycle, holds the volumes, and drives the
 * planner and the stage. Knows no Web Audio of its own: it is handed a stage,
 * which is what lets the whole lifecycle -- unlock, mute, a race starting and
 * ending, engines coming and going with the field -- be exercised in node
 * against a fake, the same way PreviewCore is.
 *
 * MUSIC AND VO ARE FILES, AND THE FILES DO NOT EXIST YET.
 *
 * The tables below name the assets this game expects. None of them are in the
 * repo. That is deliberate rather than unfinished: a missing URL resolves to
 * silence in the stage without throwing, so the system ships now, and dropping
 * a bed into `public/audio/` is the whole of wiring it up. The names match the
 * cue sheet in the project docs -- see `claude/spacegen-racing-audio-direction.md`.
 *
 * THE VO SCRIPT IS ALREADY WRITTEN.
 *
 * ui/cheer.ts decides which moments in a race deserve a line, and it has real
 * editorial rules about it -- what escalates, what is too frequent to mention,
 * what would read as mockery next to a HUD message. VO binds to THOSE kinds
 * rather than inventing a second set, so the voice and the text can never
 * disagree about what just happened, and turning callouts off silences both.
 */
import type { RaceState, RacerState } from '../sim/types'
import { getDerived } from '../content/chassis'
import type { AudioStage, SoundId, Volumes } from './api'
import { DEFAULT_VOLUMES } from './api'
import { CATALOGUE } from './catalogue'
import { AudioPlanner, engineFor } from './plan'
import { createStage } from './stage'

/** cheer.ts's own kinds. Keeping the union here would let the two drift. */
export type VoKind = 'tierUp' | 'cash' | 'chain' | 'overtake' | 'lead' | 'air' | 'beam' | 'combo'

/**
 * Voice lines, by moment. Several variants each so a player hears a different
 * take the third time they chain a drift.
 *
 * `tierUp` has none on purpose: it fires up to four times per slide and the
 * drift already speaks through the tier sound. A voice there would talk over
 * the player constantly during the one mechanic that needs concentration.
 */
export const VO_LINES: Record<VoKind, readonly string[]> = {
  tierUp: [],
  cash: ['audio/vo/cash-1.mp3', 'audio/vo/cash-2.mp3', 'audio/vo/cash-3.mp3'],
  chain: ['audio/vo/chain-1.mp3', 'audio/vo/chain-2.mp3'],
  overtake: ['audio/vo/overtake-1.mp3', 'audio/vo/overtake-2.mp3', 'audio/vo/overtake-3.mp3'],
  lead: ['audio/vo/lead-1.mp3', 'audio/vo/lead-2.mp3'],
  air: ['audio/vo/air-1.mp3', 'audio/vo/air-2.mp3'],
  beam: ['audio/vo/beam-1.mp3', 'audio/vo/beam-2.mp3'],
  /**
   * Combo rungs. Six lines rather than variants, because unlike every other
   * kind here the rung is not interchangeable -- reaching x16 and being told
   * the x2 line would be worse than silence. cheer.ts fires these in order and
   * at most once each per run, so a fixed sequence is exactly right.
   */
  combo: [
    'audio/vo/combo-1.mp3', 'audio/vo/combo-2.mp3', 'audio/vo/combo-3.mp3',
    'audio/vo/combo-4.mp3', 'audio/vo/combo-5.mp3', 'audio/vo/combo-6.mp3',
  ],
}

/**
 * The beds, keyed by track ID.
 *
 * FILENAMES FOLLOW THE TRACK'S NAME, KEYS FOLLOW ITS ID. The four circuits were
 * renamed to Elkarim / Frosthelm / Namaresh / Centurion Prime, but their ids
 * were deliberately left alone -- an id change would orphan every saved
 * leaderboard, the remembered track preference and the determinism gates, for
 * no gain a player can see. So this table is the one place the two vocabularies
 * meet, and it is meant to look slightly odd.
 *
 * `final` is OPTIONAL and currently unset everywhere. The design called for a
 * second, tenser cue on the last lap; one track per circuit was delivered, so
 * the bed simply keeps playing. Dropping a `<name>-final.mp3` in and naming it
 * here is the whole of turning that on -- nothing else needs to change.
 */
export const MUSIC: Record<string, { bed: string; final?: string }> = {
  rustfall: { bed: 'audio/music/elkarim.mp3' },
  cryostatic: { bed: 'audio/music/frosthelm.mp3' },
  aetherion: { bed: 'audio/music/namaresh.mp3' },
  hollowchoir: { bed: 'audio/music/centurion-prime.mp3' },
}

export const MUSIC_TITLE = 'audio/music/title.mp3'
export const MUSIC_GARAGE = 'audio/music/garage.mp3'

/**
 * The finish stings. One-shots on the music bus, chosen by finishing position.
 *
 * They REPLACE the race bed rather than layering over it: two pieces of music
 * at once is the single worst thing this system can do, and the flag is exactly
 * the moment the bed has stopped being about anything.
 */
export const STING_VICTORY = 'audio/sting/victory.mp3'
export const STING_FINISH = 'audio/sting/finish.mp3'

/**
 * TWO SWITCHES, BECAUSE THE ASSETS ARRIVED SEPARATELY.
 *
 * A URL that does not exist is handled correctly -- a failed fetch is
 * remembered and that sound is silent -- but "correctly" is not "quietly": the
 * browser logs a 404 for every one, and `tools/smoke.mjs` fails the build on
 * ANY console error. A green gate turning red for a reason that is not a bug is
 * worse than having no music, because the next real error is then lost in the
 * noise. So nothing is requested until there is something to request.
 *
 * The music and the stings are now in `public/audio/`, so HAS_MUSIC is on.
 * The voice lines are not recorded yet, so HAS_VO stays off.
 *
 * These were ONE flag until the music landed. Keeping them as one would have
 * meant either shipping music with 404s on every callout, or holding the music
 * back until someone records a voice -- both worse than a second boolean.
 *
 * TO TURN THE VOICE ON: drop the files named in VO_LINES into
 * `public/audio/vo/` and flip HAS_VO. The path is already wired and exercised
 * by tests/audio.test.ts; the flag gates the fetch, not the logic.
 */
export const HAS_MUSIC = true
export const HAS_VO = false

/** Seconds the music ducks under a voice line, and how far. */
const DUCK_LEVEL = 0.35
const DUCK_HOLD = 1.1

const LS_AUDIO = 'sg.audio'

export interface AudioSystem {
  readonly available: boolean
  readonly volumes: Volumes
  /** Call from a real user gesture. Safe to call on every click. */
  unlock(): void
  setVolumes(v: Partial<Volumes>): void
  /** One render frame of a live race. */
  race(
    state: RaceState,
    events: readonly (readonly import('../sim/types').RacerEvent[])[],
    localId: number,
    listener: { x: number; y: number; z: number },
    forward: { x: number; y: number; z: number },
    up: { x: number; y: number; z: number },
    now: number,
    engines: boolean,
  ): void
  /** A callout fired. Speaks it and ducks the music. */
  callout(kind: VoKind): void
  /** One-shot, flat. For UI and the countdown. */
  cue(id: SoundId): void
  music(trackId: string | null, finalLap: boolean): void
  menuMusic(which: 'title' | 'garage' | null): void
  /**
   * The flag. Stops the bed and plays a sting chosen by finishing position.
   * Call once, on the local racer's finish.
   */
  finishSting(position: number): void
  /** Start fetching a track's bed before it is needed. */
  preloadTrack(trackId: string | null): void
  /** Tear down engines and scrapes between races. */
  endRace(): void
  setHidden(hidden: boolean): void
  dispose(): void
}

class AudioImpl implements AudioSystem {
  private stage: AudioStage | null
  private readonly planner = new AudioPlanner()
  private vol: Volumes
  private lastVo = -99
  private voSeq = 0
  private curMusic: string | null = null
  /** Engine voices currently live, so retired racers can be stopped. */
  private liveEngines = new Set<number>()

  constructor() {
    this.vol = loadVolumes()
    this.stage = createStage(this.vol)
  }

  get available(): boolean { return this.stage !== null }
  get volumes(): Volumes { return this.vol }

  unlock(): void { this.stage?.unlock() }

  setVolumes(v: Partial<Volumes>): void {
    this.vol = { ...this.vol, ...v }
    this.stage?.setVolumes(this.vol)
    saveVolumes(this.vol)
  }

  cue(id: SoundId): void {
    if (!this.stage) return
    const def = CATALOGUE[id]
    if (!def) return
    this.stage.play({ id, gain: 1, rate: 1, at: null }, def)
  }

  race(
    state: RaceState,
    events: readonly (readonly import('../sim/types').RacerEvent[])[],
    localId: number,
    listener: { x: number; y: number; z: number },
    forward: { x: number; y: number; z: number },
    up: { x: number; y: number; z: number },
    now: number,
    engines: boolean,
  ): void {
    const stage = this.stage
    if (!stage) return

    stage.setListener(listener.x, listener.y, listener.z,
      forward.x, forward.y, forward.z, up.x, up.y, up.z)

    const frame = this.planner.frame(state, events, localId, listener, now)
    for (const p of frame.plays) {
      const def = CATALOGUE[p.id]
      if (def) stage.play(p, def)
    }
    for (const s of frame.scrapes) stage.setScrape(s.id, s.gain > 0 ? s : null)

    if (!engines) {
      for (const id of this.liveEngines) stage.setEngine(id, null)
      this.liveEngines.clear()
      return
    }

    for (let i = 0; i < state.racers.length; i++) {
      const r: RacerState = state.racers[i]
      const top = getDerived(r.chassisId, r.pilotId).topSpeed
      const v = r.finished ? null : engineFor(r, top, i === localId, listener)
      if (v) { stage.setEngine(i, v); this.liveEngines.add(i) }
      else if (this.liveEngines.has(i)) { stage.setEngine(i, null); this.liveEngines.delete(i) }
    }
  }

  callout(kind: VoKind): void {
    const stage = this.stage
    if (!stage || !HAS_VO) return
    const lines = VO_LINES[kind]
    if (!lines || lines.length === 0) return
    const now = performance.now() / 1000
    // A hard floor between lines, on top of whatever cheer.ts already gates.
    // Two voices over each other is the single worst thing this system can do,
    // and the text callouts have their own priority rules that were written for
    // a medium where overlap is invisible.
    if (now - this.lastVo < 1.6) return
    const url = lines[this.voSeq++ % lines.length]
    if (stage.speak(url)) {
      this.lastVo = now
      stage.duck(DUCK_LEVEL, DUCK_HOLD)
    }
  }

  music(trackId: string | null, finalLap: boolean): void {
    const stage = this.stage
    if (!stage) return
    if (!trackId) { this.setBed(null, 1.2); return }
    const m = MUSIC[trackId]
    if (!m) { this.setBed(null, 1.2); return }
    // A longer fade into the final lap than out of the menu: the swap should
    // feel like the race tightening, not like a track change.
    // No final-lap variant delivered for these circuits, so the bed carries on
    // rather than crossfading to itself -- setBed already no-ops on an
    // unchanged URL, but being explicit here keeps the intent readable.
    const url = finalLap && m.final ? m.final : m.bed
    this.setBed(url, finalLap && m.final ? 1.8 : 0.8)
  }

  menuMusic(which: 'title' | 'garage' | null): void {
    if (!this.stage) return
    this.setBed(which === 'title' ? MUSIC_TITLE : which === 'garage' ? MUSIC_GARAGE : null, 1.0)
  }

  finishSting(position: number): void {
    const stage = this.stage
    if (!stage || !HAS_MUSIC) return
    // The bed goes first, and quickly. A sting laid over a race bed is two
    // pieces of music at once, which is the worst thing this system can do.
    // 0.35s rather than an instant cut: a hard stop on a loud mix reads as a
    // dropout, and the sting's own opening covers the tail.
    this.setBed(null, 0.35)
    stage.sting(position === 1 ? STING_VICTORY : STING_FINISH)
  }

  preloadTrack(trackId: string | null): void {
    const stage = this.stage
    if (!stage || !HAS_MUSIC) return
    const urls: string[] = [STING_VICTORY, STING_FINISH]
    const m = trackId ? MUSIC[trackId] : null
    if (m) { urls.push(m.bed); if (m.final) urls.push(m.final) }
    stage.preload(urls)
  }

  private setBed(url: string | null, fade: number): void {
    if (!HAS_MUSIC) return
    if (url === this.curMusic) return
    this.curMusic = url
    this.stage?.setMusic(url, fade)
  }

  endRace(): void {
    const stage = this.stage
    if (!stage) return
    for (const id of this.liveEngines) stage.setEngine(id, null)
    this.liveEngines.clear()
    stage.setScrape('scrapeWall', null)
    stage.setScrape('scrapeCar', null)
    this.planner.reset()
  }

  setHidden(hidden: boolean): void {
    if (!this.stage) return
    // A backgrounded tab with eight live oscillators in it is a battery
    // complaint. Suspending the whole context is one call and stops everything.
    const s = this.stage as unknown as { suspend?: () => void; unlock?: () => void }
    if (hidden) s.suspend?.()
    else s.unlock?.()
  }

  dispose(): void {
    this.stage?.dispose()
    this.stage = null
  }
}

function loadVolumes(): Volumes {
  try {
    const raw = window.localStorage.getItem(LS_AUDIO)
    if (!raw) return { ...DEFAULT_VOLUMES }
    const p = JSON.parse(raw) as Partial<Volumes>
    const n = (v: unknown, d: number): number =>
      typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(1, v)) : d
    return {
      master: n(p.master, DEFAULT_VOLUMES.master),
      music: n(p.music, DEFAULT_VOLUMES.music),
      sfx: n(p.sfx, DEFAULT_VOLUMES.sfx),
      vo: n(p.vo, DEFAULT_VOLUMES.vo),
      muted: p.muted === true,
    }
  } catch {
    return { ...DEFAULT_VOLUMES }
  }
}

function saveVolumes(v: Volumes): void {
  try { window.localStorage.setItem(LS_AUDIO, JSON.stringify(v)) } catch { /* blocked */ }
}

export function createAudio(): AudioSystem { return new AudioImpl() }
