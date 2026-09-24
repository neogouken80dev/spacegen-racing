import * as THREE from 'three'

/** Blast-projection scratch. Module level so the render path never allocates. */
const _bp = new THREE.Vector3()
const _be = new THREE.Vector3()
const _bR = new THREE.Vector3()
const _bU = new THREE.Vector3()
const _bF = new THREE.Vector3()
/** Listener orientation scratch. Same reason as the blast vectors above. */
const _aFwd = new THREE.Vector3()
const _aUp = new THREE.Vector3()
import { Race } from '../sim/race'
import { Track } from '../sim/track'
import { resetAI } from '../sim/ai'
import { TRACKS_BY_ID, RUSTFALL } from '../content/tracks'
import { CHASSIS, CHASSIS_BY_ID, getDerived, getLocomotion } from '../content/chassis'
import { PILOTS } from '../content/pilots'
import { TUNING as T } from '../content/tuning'
import type { RacerState, RacerEvent, SimConfig, InputFrame } from '../sim/types'
/**
 * THE TYPES-ONLY RULE, AND THE ONE THING THAT BROKE IT.
 *
 * It used to read: `net/index.ts` is lazy on purpose -- naming it starts a
 * mock directory ticking -- and the Game has no business reaching for a
 * service anyway, because the front end owns the lobby and hands this file the
 * one packet that comes out of it. `import type` cannot emit a runtime import,
 * so the rule enforced itself.
 *
 * NETCODE MADE IT FALSE, AND IN EXACTLY TWO PLACES.
 *
 *   `raceTransport()`  A packet cannot carry inputs. The lobby owns the peer
 *                      mesh -- it built it to run the room -- so the race
 *                      BORROWS it, and there is no route from a packet to the
 *                      transport that belongs to the round it announced.
 *   `lobbyService()`   A round has to be able to END. `endRound(standings)` is
 *                      what advances a series, and nothing else in the process
 *                      knows the finishing order.
 *   `accountService()` Credits are earned locally and BANKED on a server. The
 *                      wallet fires `onBank` and refuses to know the network
 *                      exists; the account service takes a number and cannot
 *                      know what a race is. This file is the only one that
 *                      knows both, and the only one that knows whether the
 *                      race was won. See `forwardAward`.
 *
 * All three are still lazy: `lobbyService()` is only ever called on a frame
 * where a multiplayer packet is live, which means the front end has already
 * created the service and no directory starts ticking because this module was
 * imported, and `accountService()` is only reached from a payout, which needs
 * a finished race. The attract loop, the headless harness and every unit test
 * that never opens a lobby still pay nothing.
 */
import {
  accountService, existingAccountService, liveLobby, lobbyService, netProfile, raceTransport,
} from '../net'
import { LockstepRunner } from '../net/lockstep'
import type {
  AccountService, PlayerProfile, RaceStartPacket, RaceTransport, RoundResume,
  SeriesStanding,
} from '../net/types'
import { QUALITY_PRESETS, type QualityTier, type RenderQuality } from '../render/api'
import { createVehicleVisual, disposeVehicleCache, type VehicleVisualEx } from '../render/vehicles'
import { buildTrackVisual } from '../render/trackMesh'
import { buildEnvironment } from '../render/environment'
import { createEntityVisuals, type EntityVisualsWithGate } from '../render/entities'
import { createVfx } from '../render/vfx'
import { createNameplates, type NameplateRoster, type NameplateSystem } from '../render/nameplates'
import { createPostFx, type PostFx } from '../render/postfx'
import { createHud, type Hud, type NetMigration, type PodiumLine } from '../ui/hud'
import { createCheer, type Cheer, type CheerLevel } from '../ui/cheer'
import { createScoreHud, type ScoreHud } from '../ui/scoreHud'
import { CATALOGUE } from '../audio/catalogue'
import { Scorer } from '../score/scorer'
import { createScoreboard, BOARD_SIZE } from '../score/board'
import { createRecordStore, type RecordStore } from '../score/records'
import { sharedWallet, type Payout, type Wallet } from '../score/wallet'
import { createGlobalStore, type GlobalStore } from '../score/global'
import type { ScoreStore } from '../score/api'
import { createAudio, type AudioSystem } from '../audio'
import { createFrontEnd, type FrontEnd } from '../ui/frontend'
import { createSettingsPanel, type SettingsPanel, type SettingsTab } from '../ui/settings'
import { installCompactLayout, type CompactLayout } from '../ui/compact'
import { createInput, isTouchScheme, type InputManager } from './input'
import {
  applyRound, clearCircuit, CIRCUIT_GRID, CIRCUIT_ROUNDS, gridMismatch, isComplete,
  loadCircuit, newCircuit, resultFromRace, roundsDone, saveCircuit, standings,
  trackIdForRound, type CircuitState,
} from './circuit'
import {
  PODIUM_SKIP_GUARD, podiumCast, podiumDone, podiumSkip, type PodiumCast,
} from './podium'
import {
  applySeriesRound, localSeriesLine, seriesKey, seriesPodiumCast,
  seriesPodiumNames, type SeriesFinish,
} from './series'
import { setRoomNotice } from '../ui/lobby'
import { createPodiumStage, pilotName, type PodiumStage } from '../render/podium'
import { ChaseCamera } from './camera'
import { EventCarry } from './eventCarry'
import { AchievementRun, circuitEvidence, seriesSweep } from './achievementRun'
import type { RaceContext } from '../score/tracker'
import type { CircuitEvidence } from '../content/avatars'
import { createBadgeToasts, type BadgeToasts } from '../ui/badgeToast'
import { themeFor } from '../render/themes'
import {
  ATTRACT_TRACK, attractPose, attractRacerCount, makeAttractPose, shotFor,
  spreadField, type AttractPose,
} from './attract'
import { clamp01 } from '../sim/math'
import type { VfxSystem, TrackVisual, EnvironmentVisual, CrosswindFrame } from '../render/api'
import {
  asDifficulty, DEFAULT_DIFFICULTY, difficultyOfGrid, scopeFor, skillForSlot,
  type Difficulty,
} from '../content/difficulty'

const DT = T.sim.dt
const RACER_COUNT = 8

/**
 * `ceremony` is the finish sequence: the local racer has crossed the line, the
 * sim is still stepping (the field is still coming in, and every finished car
 * is doing a victory lap under AI), and the camera has left the chase rig. It
 * is deliberately a phase of its own rather than a flag on `racing`, because
 * every branch that asks "is the player driving" has to answer no.
 *
 * `podium` is its younger sibling: the championship celebration, and it plays
 * ONCE PER CIRCUIT -- after round 8 has been scored and only then. It is in the
 * same family as `ceremony` (no input into the sim, a skip behind a guard, the
 * camera somewhere the chase rig is not) with one difference that matters: by
 * the time it starts there is no world left. The race is over, the track has
 * been torn down, and the scene holds the podium and nothing else.
 */
type Phase = 'menu' | 'attract' | 'racing' | 'ceremony' | 'podium' | 'paused' | 'results'

interface RenderRacer {
  visual: VehicleVisualEx
  /** Interpolated copy handed to the visual so 120Hz displays stay smooth. */
  view: RacerState
  prevX: number; prevY: number; prevZ: number; prevYaw: number
  /**
   * The racer's own frame at the previous sim step, for interpolation on a
   * gravity track. Six numbers rather than two Vec3s so the render loop
   * allocates nothing, exactly as prevX/Y/Z do.
   *
   * Untouched on a flat track: the sim leaves `fwd`/`up` frozen at the grid
   * there and the visual is told not to read them (VehicleVisualEx.gravity).
   */
  prevFX: number; prevFY: number; prevFZ: number
  prevUX: number; prevUY: number; prevUZ: number
}

// ---------------------------------------------------------------------------
// THE MULTIPLAYER GRID
//
// A THIRD SOURCE OF TRUTH FOR THE FIELD, AND NOT A THIRD RACE PATH. The
// argument is the one startRace() already makes for circuit mode, and it is
// stronger here: the single-race generator derives the opponents from a pool
// that excludes the player's car, so it answers differently for every reader of
// the SAME broadcast -- eight clients would build eight different fields and
// call it one race. The packet is therefore not a hint about the grid, it is
// the grid, and this function's only job is to transcribe it.
//
// PURE, AND EXPORTED, for the same reason plateRoster is: everything that can
// actually be wrong here -- which slot the reader is in, whose chassis goes
// where, what an AI's skill is -- is arithmetic over a small object, and it
// should be pinned by a test rather than by a screenshot of a race that happens
// to look right. See tests/multiplayer.test.ts.
// ---------------------------------------------------------------------------

/**
 * The pace a grid slot with no published skill drives at.
 *
 * `skillForSlot` is the one function that turns a difficulty and a grid slot
 * into an AI band, for a single race, a championship round and a multiplayer
 * fill alike -- so a car standing in for a dropped peer drives at exactly the
 * pace it would anywhere else in the game. It used to be the expression
 * `2 + (slot % 3)` written out longhand in six places, which is how a pace
 * change reaches five of them and not the sixth.
 *
 * IT STANDS IN AT NORMAL UNLESS TOLD OTHERWISE, and the caller in
 * `multiplayerSimConfig` does not tell it otherwise. A difficulty describes
 * the AI FIELD the host chose to race against; a seat a person was sitting in
 * until ten seconds ago is not part of that field, and promoting it to Expert
 * because the room was Expert would hand the disconnected player's car an
 * advantage nobody asked for over the people still racing.
 *
 * It is needed at all because of the milestone below: a HUMAN slot publishes
 * `aiSkill: null` (a person's skill is their own business) and, with no
 * transport, that car still has to be driven by something. Derived from the
 * slot number rather than invented, so every client computes the same number
 * from the same packet and the stand-in cannot itself be a source of divergence.
 */
export function standInSkill(slot: number, difficulty: Difficulty = 'normal'): number {
  return skillForSlot(difficulty, slot)
}

/**
 * The start packet, transcribed into a `SimConfig` -- or null, meaning refuse.
 *
 * THE LOCAL PLAYER IS NOT NECESSARILY SLOT 0, which is the whole reason this
 * function exists rather than a couple of lines inside startRace(). Single race
 * and circuit mode both hard-code the player onto pole; in a lobby they are
 * wherever they landed, so `localRacerIndex` is READ FROM THE PACKET by
 * matching `localPlayerId` against the grid. Nothing else in this file may
 * assume the answer is zero.
 *
 * WHY IT REFUSES RATHER THAN FALLING BACK. Every failure below is a packet that
 * cannot describe a race this client is in, and the two available fallbacks are
 * both worse than not starting: slot 0 would put the player in somebody else's
 * car for a whole race, and -1 (the attract mode value) would start a race with
 * no player in it at all. Both photograph perfectly. So a packet that does not
 * place this reader on an eight-car grid does not start a race, and the caller
 * says so.
 *
 * WHAT IT CHECKS, AND WHY EACH ONE IS A REAL SHAPE AND NOT PARANOIA
 *
 *   Eight slots exactly. `LOBBY_MAX_PLAYERS` is not a preference, it is the
 *   grid: Race builds `racerCount` cars and the results table, the podium and
 *   the points ladder are all written against eight. A short grid would run a
 *   race whose last cars had a default chassis, no name plate and a skill
 *   nobody chose.
 *
 *   `slot` is the index, and every index is used once. `slot` is documented as
 *   the racer id in the sim, and three separate things downstream believe it --
 *   nameplates.ts looks its car up with `racers[spec.slot]`, circuit scoring
 *   matches `r.id`, and the config arrays below are positional. A duplicated
 *   or out-of-range slot silently swaps two cars' identities.
 *
 *   Exactly one slot is the reader. Two would make `localRacerIndex`
 *   order-dependent, which is the one thing a broadcast may never be.
 *
 * `trackId` is passed in rather than taken from the packet because the caller
 * has already resolved it against the shipped roster -- an id with no track
 * behind it falls back to Rustfall rather than throwing a lobby's selection
 * into the sim, and the config must name the circuit that is actually loaded.
 */
export function multiplayerSimConfig(
  packet: RaceStartPacket,
  trackId: string,
): SimConfig | null {
  const grid = packet.grid
  if (grid.length !== RACER_COUNT) return null

  const chassisIds: string[] = new Array<string>(RACER_COUNT)
  const pilotIds: string[] = new Array<string>(RACER_COUNT)
  const aiSkill: number[] = new Array<number>(RACER_COUNT)
  const filled: boolean[] = new Array<boolean>(RACER_COUNT).fill(false)
  let localRacerIndex = -1

  for (const s of grid) {
    if (!Number.isInteger(s.slot) || s.slot < 0 || s.slot >= RACER_COUNT) return null
    if (filled[s.slot]) return null
    filled[s.slot] = true
    chassisIds[s.slot] = s.chassisId
    pilotIds[s.slot] = s.pilotId
    // `playerId` is null on an AI slot and `localPlayerId` is a real id, so a
    // null can never accidentally match -- the same guard plateRoster relies on.
    if (s.playerId !== null && s.playerId === packet.localPlayerId) {
      if (localRacerIndex >= 0) return null
      localRacerIndex = s.slot
    }
    /**
     * PUBLISHED WHERE THERE IS ONE, DERIVED IDENTICALLY WHERE THERE IS NOT.
     *
     * `SimConfig.aiSkill` feeds `stepAI` inside the deterministic sim, so it is
     * an input to the physics in exactly the way the seed is -- which is why
     * the packet carries it rather than letting each client invent one. A human
     * slot publishes null, and this fills that hole from the slot number alone,
     * so the array this function returns is IDENTICAL on every client that
     * reads the packet. `localRacerIndex` is the only field that differs
     * between readers, which is the only field that is allowed to.
     *
     * The local player's own entry is therefore a stand-in too, and it is never
     * read: sim/race.ts calls stepAI and aiRocketStart only for a racer with
     * `isAI`, and `isAI` is false for exactly this index.
     */
    aiSkill[s.slot] = s.aiSkill ?? standInSkill(s.slot)
  }
  if (localRacerIndex < 0) return null

  return {
    // `>>> 0` because `Rng` does it anyway and a seed that is negative or
    // fractional in one client's copy and normalised in another's is the
    // quietest desync available.
    seed: packet.seed >>> 0,
    // THE LOBBY'S LAP COUNT, NOT `T.race.totalLaps`. A lobby offers 1, 3, 5, 7
    // or 10 and every client must run the number the host published. Clamped
    // to something a race can actually be, deterministically, so a malformed
    // packet is a short race rather than a sim that never finishes.
    totalLaps: Math.max(1, Math.round(packet.laps)),
    racerCount: RACER_COUNT,
    trackId,
    chassisIds,
    pilotIds,
    localRacerIndex,
    aiSkill,
  }
}

/**
 * Post a race's payout to the account service and take back what it ACTUALLY
 * paid.
 *
 * ---------------------------------------------------------------------------
 * `adopt` IS NOT BOOKKEEPING, IT IS THE POINT. The server clamps.
 * `MAX_PER_RACE` bounds a single post -- 200, imported by net/account.ts from
 * score/wallet.ts rather than copied, so the two cannot drift -- and
 * `AWARD_MIN_GAP_MS` / `AWARD_PER_HOUR` bound the rate. So what the client
 * proposes is routinely not what it is paid, and a client that kept its own
 * number would show a balance the shop then refuses to spend, and have it
 * corrected out from under the player on some later `load()` with no
 * explanation attached. net/account.ts states the rule from its own side:
 * "What the client must NOT do is treat its own number as banked."
 *
 * The wallet is written for exactly this -- `adopt` replaces both numbers with
 * the server's, "no merge, no max, no argument" -- and the reason it can be
 * that blunt is that there is nothing to reconcile: the local copy is a cache
 * of something the server owns.
 *
 * A FAILURE IS DROPPED RATHER THAN QUEUED, which is the account layer's
 * decision and not an omission here. A queue that replays on reconnect is a
 * client posting a burst of races at once, which is precisely the shape the
 * pace limit exists to refuse -- so it would be rejected on arrival, having
 * spent the whole outage convincing the player their credits were safe. The
 * local wallet keeps the balance through the outage instead, which is the same
 * outcome with none of the lying. There is nothing to tell the player either:
 * this runs behind a results screen that has already appeared, and the profile
 * screen is already saying the account is offline.
 *
 * FREE-STANDING AND EXPORTED so the three-way handshake can be tested without
 * a WebGL context: a Game needs a canvas, and the property worth pinning here
 * -- that a clamped award leaves the local wallet agreeing with the server
 * rather than with itself -- has nothing to do with one. Returns what was
 * banked, or null when nothing was.
 */
export async function bankAward(
  account: Pick<AccountService, 'award'>,
  wallet: Pick<Wallet, 'adopt'>,
  credits: number,
  won: boolean,
): Promise<PlayerProfile | null> {
  // `Wallet.bank` only fires `onBank` on a positive payout, so this is belt and
  // braces -- and it is worth having, because `AWARD_MIN_GAP_MS` is derived
  // from that fact and a zero-credit post would spend the account's next
  // thirty seconds of quota on nothing.
  if (!Number.isFinite(credits) || credits <= 0) return null
  const res = await account.award(credits, { won })
  if (!res.ok) {
    console.warn(`account: ${credits} credits could not be banked (${res.error}); `
      + 'the wallet keeps them locally until the next successful load')
    return null
  }
  wallet.adopt(res.value)
  return res.value
}


/** The single-race difficulty. Lobby and circuit difficulties live elsewhere
 *  on purpose -- see the field comment on `Game.difficulty`. */
const LS_DIFFICULTY = 'sg.difficulty'

export class Game {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private chase: ChaseCamera
  /** Reused so the render path allocates nothing. See the projection below. */
  private readonly blastBuf: { x: number; y: number; radius: number; strength: number }[] = []
  private quality: RenderQuality
  private tier: QualityTier = 'high'

  private track: Track
  private race: Race | null = null
  private renderRacers: RenderRacer[] = []

  private trackVis: TrackVisual | null = null
  private envVis: EnvironmentVisual | null = null
  private entityVis: EntityVisualsWithGate | null = null
  private vfx: VfxSystem | null = null
  private post: PostFx | null = null
  /**
   * THE NAME PLATES, AND WHY THE ROSTER IS HELD HERE RATHER THAN IN THEM.
   *
   * The adaptive quality scaler tears the world down and builds it again
   * mid-race (see buildWorld), which destroys the plate system along with
   * everything else. The roster is a property of the RACE, not of the render
   * world, so it lives up here and is re-installed on whatever buildWorld just
   * made -- exactly as the post chain's intensity is. Without that, a single
   * frame-rate dip on a phone would silently delete every name on screen for
   * the rest of the race and nothing would ever put them back.
   *
   * Null outside multiplayer. A single race, a Grand Circuit round and the
   * title screen's attract race all leave it null, so none of them pay for any
   * part of this feature -- not the atlas, not the two passes, not the draw
   * calls. See setNameplateRoster.
   */
  private plates: NameplateSystem | null = null
  private nameplateRoster: NameplateRoster | null = null
  /** Dense view of `renderRacers[i].view`, reused each frame so the plate
   *  push allocates nothing. Same pattern, same reason, as `audioEvents`. */
  private readonly plateViews: RacerState[] = []

  private hud: Hud
  private cheer: Cheer
  private scoreHud: ScoreHud
  private readonly scorer = new Scorer()
  private readonly board: ScoreStore = createScoreboard()
  private readonly records: RecordStore = createRecordStore()
  private readonly global: GlobalStore = createGlobalStore()
  /** The finished run, held between the flag and the results screen. */
  private lastScore = 0
  private lastBestCombo = 1
  /** Set by onLocalFinish; consumed by the next scoring frame. See there. */
  private captureScoreNextFrame = false
  private readonly audio: AudioSystem = createAudio()
  /** Last countdown integer spoken, so a beep fires once per number. */
  private lastCount = -1
  /** True once the countdown has been seen, so the GO can fire when it ends. */
  private goArmed = false
  /** Last lap the music was told about, so the swap happens once. */
  private lastMusicLap = -1
  private frontEnd: FrontEnd
  private input: InputManager
  private readonly compact: CompactLayout
  private settings: SettingsPanel
  private tools: HTMLElement
  /** True when the settings overlay paused the race, so closing resumes it. */
  private pausedBySettings = false

  private phase: Phase = 'menu'
  /**
   * Seconds the attract shot has been running. Its own clock rather than the
   * sim's: the camera's push is a property of how long the player has been
   * looking at the title screen, not of how far through a race the AI field is.
   */
  private attractT = 0
  private readonly attractBuf: AttractPose = makeAttractPose()
  /** True while the document is hidden, so the title race stops burning a phone. */
  private docHidden = false
  private accumulator = 0
  /** Per-racer one-shot events, delivered once per render frame whatever
   *  the number of sim steps it ran. See src/game/eventCarry.ts. */
  private readonly eventCarry = new EventCarry()
  /**
   * The achievements' half of every race, and the toasts that announce them.
   * Each hook into this file is one commented line; the work is in
   * game/achievementRun.ts. Assigned in the constructor, which has the
   * container the toasts hang off.
   */
  private readonly ach: AchievementRun
  private readonly badgeToasts: BadgeToasts
  /** The mid-race preview's context, built once so the render path allocates
   *  nothing for it. See `raceContext`. */
  private readonly liveContext = (): RaceContext =>
    this.raceContext(this.scorer.score, this.scorer.bestCombo)
  /** Dense per-racer view of `r.events`, reused each frame. See the audio call. */
  private audioEvents: RacerEvent[][] = []
  private lastTime = 0
  private localId = 0
  private selection = { chassisId: 'solaire', pilotId: 'socket' }
  /**
   * How hard the AI field drives in a single race the player starts here.
   *
   * NOT read by the multiplayer path and not read by a circuit in progress.
   * A lobby's difficulty is the HOST's and rides the published grid; a
   * circuit's is frozen into its save at the moment it was started. Both of
   * those are promises to somebody -- the room, or the player three rounds
   * into a championship -- and a settings row must not be able to break them
   * halfway through.
   */
  private difficulty: Difficulty = DEFAULT_DIFFICULTY

  /**
   * THE GRAND CIRCUIT.
   *
   * `circuit` is the series, saved or in progress; `circuitActive` is whether
   * the player is IN it right now. The two are deliberately separate: a saved
   * circuit has to survive being ignored -- a player who comes back, races a
   * one-off on Zhen-9 and then presses Continue must find their standings
   * exactly where they left them, and a single race must not be able to score
   * a round. Every path that starts a race asks `circuitActive`, and the only
   * things that set it false are the title screen's Play and walking into the
   * track list. See game/circuit.ts for the series itself.
   */
  private circuit: CircuitState | null = null
  private circuitActive = false
  /**
   * THE LOBBY RACE, or null for every other kind.
   *
   * Held for the same reason `circuit` is: it is the grid, the seed and the lap
   * count of the race in progress, and startRace() is re-entered by Rematch and
   * by the pause menu's Restart without any of the front end's setup screens
   * running again. Kept ACROSS those, so a rematch of a lobby race is the same
   * eight cars on the same circuit rather than a single race wearing the
   * lobby's name plates -- which is the same reason setNameplateRoster is not
   * cleared by the results screen.
   *
   * Cleared by the one thing that means "I am done with the lobby": pressing
   * Start on the garage screen, which is the entry point for every single race
   * and every circuit round. See the handler.
   *
   * The `circuit`/`circuitActive` pair has no equivalent here because there is
   * nothing to save: a multiplayer race is not a series, it scores no round and
   * it writes nothing to disk.
   */
  private multiplayer: RaceStartPacket | null = null
  /**
   * THE LOCKSTEP GATE FOR THE ROUND NOW RUNNING, OR NULL.
   *
   * Null is the ordinary case and covers every race this game shipped with: a
   * single race, a circuit round, the attract loop, and a lobby race under the
   * mock (which has no peers -- see `MockLobbyService.transport`). The
   * fixed-step loop branches on it exactly once, and when it is null the loop
   * is the one that was there before, line for line.
   *
   * PUBLIC, for the same reason `maxSubSteps` is: tools/probe-netcode.mjs
   * drives two real Chromium contexts against the built bundle and has to be
   * able to read the runner's verdict, its scheduler and who it is waiting
   * for. Those are the things a screenshot cannot show, and there is no other
   * handle on them from outside.
   */
  net: LockstepRunner | null = null
  /**
   * The repair the room is in the middle of, or null. PUBLIC for the same
   * reason `net` is: tools/probe-migrate.mjs photographs the wait and has to be
   * able to read the state the line on screen is drawn from.
   *
   * A FIELD AND NOT A PUSH, because the HUD's net line has exactly one writer
   * (`netFrame`, once per rendered frame) and two would race each other. The
   * transport refreshes this four times a second; the frame loop reads it.
   */
  netMigration: NetMigration | null = null
  /**
   * The round's transport, for the one thing the runner cannot answer: what the
   * WIRE is doing. types.ts asks the HUD to render all four `LinkStatus` values
   * differently, and `rejoining` -- this client's own link gone and being got
   * back -- is a state the runner only knows as "paused".
   *
   * Held rather than fetched per frame so it is provably the transport this
   * round's runner was built with, and dropped with the runner in `detachNet`.
   */
  private netTransport: RaceTransport | null = null
  /**
   * The series table this client last banked, and the round it belongs to.
   *
   * HELD HERE RATHER THAN READ BACK OFF THE ROOM, because the room is not
   * there yet when it is needed: `finishRace` totals the round and calls
   * `endRound`, and the push carrying the new room arrives afterwards. The
   * podium and the results screen both want the table on the frame the race
   * ends, so it is computed once, used, and handed down.
   */
  private seriesTable: readonly SeriesStanding[] = []
  /** True once `endRound` has been called for the round now finishing, so a
   *  desync and a flag racing each other cannot advance the series twice. */
  private roundEnded = false
  private raf = 0
  private reduceMotion = false
  /**
   * This frame's crosswind, refilled in place and handed to the environment.
   *
   * One long-lived object rather than a literal per frame: renderFrame runs at
   * display rate and this is the render loop's hot path, so allocating a Vec3
   * and a wrapper here is 120 objects a second for the garbage collector to
   * find during a race.
   */
  private readonly wind: CrosswindFrame = {
    push: 0, right: { x: 1, y: 0, z: 0 }, reduceMotion: false,
  }
  /**
   * The player's visual-intensity choice, 0..1 each. Held here rather than
   * only inside PostFx because the adaptive scaler destroys and rebuilds the
   * post chain mid-race: buildWorld() re-applies these to whatever it just
   * built, so a step-down cannot hand back the glare a player turned off.
   */
  private vfxGlare = 1
  private vfxScreen = 1
  /** Held here for the same reason: a rematch rebuilds nothing, but reset()
   *  wipes the cheer system's state and the level has to survive it. */
  private calloutLevel: CheerLevel = 'full'

  // --- finish ceremony ------------------------------------------------------
  /** Seconds since the local racer crossed the line. */
  private cerT = 0
  /** Seconds since the LAST car crossed, or -1 while the field is still out. */
  private cerFieldT = -1
  /** A skip control has been released at least once since the ceremony began. */
  private skipArmed = false

  // --- championship podium --------------------------------------------------
  /** The celebration scene, or null whenever the phase is not `podium`. */
  private podiumStage: PodiumStage | null = null
  /** Seconds since the podium opened. Its own clock: the camera plan in
   *  game/podium.ts is written against it and there is no sim to ask. */
  private podT = 0
  private podSkipArmed = false
  /** Reused so the per-frame HUD push allocates nothing. */
  private readonly podCard = {
    lines: [] as PodiumLine[], you: '', tied: false, canSkip: false,
    eyebrow: 'GRAND CIRCUIT',
  }

  // Adaptive quality
  private resizeObs: ResizeObserver | null = null
  private frameTimes: number[] = []
  private frameIdx = 0
  private qualityCooldown = 0
  /**
   * The tier the player chose -- the garage setting, the settings panel, or
   * the device guess before either. The adaptive scaler only ever steps DOWN
   * from where it is; this is the ceiling it may climb back toward between
   * races (see `adaptTierForRace`), and it never climbs past it.
   */
  private chosenTier: QualityTier = 'medium'
  /** The last settled p95 frame time of the race in progress, ms. */
  private raceP95 = Infinity
  private fps = 60
  /** Substep cap. Mutable so headless test harnesses can let the fixed-step
   *  accumulator catch up when the renderer is running at software speed. */
  maxSubSteps: number = T.sim.maxSubSteps
  /** Mirror of the last sampled input. sample() is stateful, so the render
   *  path must never call it a second time in the same frame. */
  private lastInput = { lookBack: false, item: false, drift: false, brake: 0, lift: false }

  private readonly container: HTMLElement

  constructor(container: HTMLElement) {
    this.container = container
    this.reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

    const canvas = document.createElement('canvas')
    canvas.id = 'sg-canvas'
    container.appendChild(canvas)

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, powerPreference: 'high-performance', stencil: false,
    })
    this.renderer.setClearColor(0x000000, 1)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05

    this.tier = detectTier()
    this.chosenTier = this.tier
    this.quality = { ...QUALITY_PRESETS[this.tier] }

    this.track = new Track(RUSTFALL)
    this.chase = new ChaseCamera(container.clientWidth / Math.max(1, container.clientHeight))

    this.hud = createHud(container)
    this.hud.root.style.display = 'none'
    // ONE BLOCK, NOT TWO.
    //
    // The score panel and the callout used to be independently positioned --
    // 13% and 33% -- and read as two unrelated captions that happened to fire
    // at the same time. They are describing ONE moment: the slide, what it is
    // worth, and how good it was. So they now share a flow container and stack
    // as a single unit, which is also what lets them share an entrance and a
    // colour instead of each having their own.
    //
    // Inside the HUD root so all three are shown, hidden and disposed with it,
    // and so the ceremony's `is-ceremony` rule still puts them away in one
    // selector.
    const moment = document.createElement('div')
    moment.className = 'sg-moment'
    this.hud.root.appendChild(moment)
    this.cheer = createCheer(moment)
    this.scoreHud = createScoreHud(moment, this.hud.root)
    this.hud.skipButton.addEventListener('click', (e) => {
      e.preventDefault()
      if (this.phase === 'ceremony') this.finishRace()
    })
    this.hud.podiumSkipButton.addEventListener('click', (e) => {
      e.preventDefault()
      if (this.phase === 'podium') this.endPodium()
    })
    this.hud.setReducedMotion(this.reduceMotion)
    this.frontEnd = createFrontEnd(container)
    // ACHIEVEMENTS. The toasts hang off the container, above the menus and
    // below the settings dialog; the run reaches the account only through
    // `existingAccountService`, so banking a race never creates one (see the
    // header of game/achievementRun.ts for why that matters).
    this.badgeToasts = createBadgeToasts(container)
    this.badgeToasts.setReducedMotion(this.reduceMotion)
    this.frontEnd.setReducedMotion(this.reduceMotion)
    this.ach = new AchievementRun({ account: existingAccountService, news: this.badgeToasts })
    // News from outside a race -- a sync bringing another device's unlocks
    // home, a profile crossing Tycoon -- is toasted; a race's own is handled
    // at the flag. The wall repaints whenever the store moves.
    this.ach.store.onUnlock = (ids) => this.badgeToasts.show(ids)
    this.ach.store.onChange = () => this.frontEnd.refreshAchievements()
    this.frontEnd.onProfileChange = (p) => this.ach.observeProfile(p)
    this.input = createInput(canvas, container)
    // THE HUD LAYOUT FOLLOWS THE HANDS, NOT THE VIEWPORT. See ui/compact.ts:
    // a tablet is too wide for the phone breakpoints and still has thumbs on
    // the glass, so the compact instruments are driven from the live control
    // scheme as well as the window size.
    this.compact = installCompactLayout(() => isTouchScheme(this.input.scheme))
    // AND SO DOES THE SETTINGS PANEL, for the same reason and one more.
    //
    // Several of its rows exist only for one scheme -- Invert tilt and
    // Re-centre for tilt, the two steering dials and the try pad for the
    // stick -- and until now the panel only re-read the scheme when the
    // player changed it THROUGH the panel. The scheme also changes from
    // underneath: touchControls fires onTiltUnavailable when the sensor is
    // denied or simply never reports, and input.ts drops the player to the
    // stick. That can land while the panel is open, and it left the dialog
    // offering two tilt rows for a scheme that had just been taken away and
    // hiding the dials for the one that had just arrived.
    //
    // Assigned here rather than beside installCompactLayout so `this.settings`
    // is real before anything can fire it.
    this.settings = createSettingsPanel(container, {
      input: this.input,
      getQuality: () => this.tier,
      getReducedMotion: () => this.reduceMotion,
    })
    this.input.onSchemeChange = () => {
      this.compact.refresh()
      this.settings.refresh()
    }
    this.settings.onQualityChange = (q) => { this.chosenTier = q; this.setTier(q) }
    this.settings.onReducedMotionChange = (on) => {
      this.reduceMotion = on
      // All four motion consumers from one value. The VFX system reads
      // `this.reduceMotion` on its own each frame; these three are pushed.
      // The HUD is on the list because the podium card's entrance is a DOM
      // animation and a media query cannot see the in-game toggle.
      this.cheer.setReducedMotion(on)
      this.scoreHud.setReducedMotion(on)
      this.hud.setReducedMotion(on)
      // And the badges: the toasts' entrance and the wall's prism ring.
      this.badgeToasts.setReducedMotion(on)
      this.frontEnd.setReducedMotion(on)
    }
    this.settings.onVfxIntensityChange = (glare, screen) => {
      this.vfxGlare = glare
      this.vfxScreen = screen
      // Live, mid-race, mid-frame: PostFx.setIntensity is four number writes
      // and a boolean, so there is nothing to defer to a restart.
      this.post?.setIntensity(glare, screen)
    }
    this.settings.onCalloutChange = (level) => {
      this.calloutLevel = level
      this.cheer.setLevel(level)
    }
    // Live, mid-race. Every one of these is either a target the rig eases
    // toward or a damping rate, so the camera glides to the new pose instead
    // of cutting -- which is exactly what you want when the panel is open over
    // a paused race and the player is watching the frame change as they step.
    //
    // Nothing caches it here: `chase` is built once in this constructor and
    // only reset() per race, so the settings it is holding outlive every race
    // in the session, and the panel re-emits them on the next boot.
    this.settings.onCameraChange = (s) => { this.chase.applySettings(s) }
    this.settings.onVolumeChange = (v) => { this.audio.setVolumes(v) }
    this.settings.setVolumes(this.audio.volumes)

    this.settings.onClose = () => {
      this.tools.hidden = false
      if (this.pausedBySettings) { this.pausedBySettings = false; this.resume() }
    }

    this.tools = this.buildTools(container)

    // The saved circuit, read once at boot. A blocked or partitioned
    // localStorage returns null here and the game simply has no circuit to
    // resume -- see the storage note in game/circuit.ts.
    this.circuit = loadCircuit()
    this.publishCircuit()

    // Read once at boot, like every other saved selection. A blocked or
    // partitioned localStorage leaves it at Normal, which is the right
    // failure: the pace the game is balanced around.
    let savedDifficulty: string | null = null
    try { savedDifficulty = window.localStorage.getItem(LS_DIFFICULTY) } catch { /* blocked */ }
    this.difficulty = asDifficulty(savedDifficulty)

    this.frontEnd.onStart = (sel) => {
      this.selection = { chassisId: sel.chassisId, pilotId: sel.pilotId }
      // Taken from the selection, not re-read from storage. The garage wrote
      // it there when the player pressed a button; reading it back would be a
      // second source for the same fact and a second chance to disagree.
      this.difficulty = sel.difficulty
      // LEAVING THE LOBBY IS PRESSING START ON THE GARAGE, and it is the only
      // thing that is. Everything else that re-enters startRace -- Rematch,
      // the pause menu's Restart -- deliberately keeps the lobby race, so this
      // is where a packet that has been raced stops being the grid.
      //
      // The roster goes with it. Without this line a single race started after
      // a lobby race would run the player's own generated field and draw the
      // lobby's name plates over it, which is a photograph of eight strangers
      // in the wrong cars.
      if (this.multiplayer) {
        this.multiplayer = null
        this.seriesTable = []
        // AND THE WIRE WITH IT. The runner holds a transport for a round that
        // is over, a scheduler keyed on that round's slots, and a reference to
        // a `Race` this call is about to replace -- so a single race started
        // out of a lobby would be gated on a peer who is not in it.
        this.detachNet()
        this.setNameplateRoster(null)
      }
      // A FINISHED SERIES HAS NO NEXT ROUND. Reachable by walking back into the
      // garage from the final results and pressing Start: without this the race
      // would run on the frozen grid and be scored by nothing, which is a mode
      // that looks like circuit mode and is not one.
      if (this.circuitActive && this.circuit && isComplete(this.circuit)) {
        this.circuitActive = false
        this.publishCircuit()
      }
      if (this.circuitActive && this.circuit) {
        // THE CIRCUIT PICKS THE TRACK, NOT THE PLAYER. The track screen is
        // skipped entirely in this mode, so `sel.trackId` is whatever was last
        // chosen for a single race and is not the round being started.
        //
        // And the grid is frozen on the way INTO round 1 rather than when the
        // circuit was created, so it is built around the car the player
        // actually pressed Start in -- they may have changed it in the garage
        // between pressing Grand Circuit and pressing Start.
        if (this.circuit.rounds.length === 0) {
          this.circuit = newCircuit(sel.pilotId, sel.chassisId)
          saveCircuit(this.circuit)
        }
        this.setTrack(trackIdForRound(roundsDone(this.circuit)))
      } else {
        this.setTrack(sel.trackId)
      }
      this.chosenTier = sel.quality
      this.setTier(sel.quality)
      this.startRace()
    }
    // The gold button on the results screen. Inside a series it is the next
    // ROUND -- a different circuit -- so "rematch" would be the wrong promise;
    // frontend.ts relabels it and this is the other half of that.
    this.frontEnd.onRematch = () => {
      /**
       * IN A LOBBY THERE IS NO SUCH THING AS A REMATCH.
       *
       * The button would re-run the last packet -- same seed, same grid, same
       * circuit -- on this client alone, while the other seven people are
       * back in the room waiting for the host to start the next round. That
       * is not a rematch, it is one player leaving the series and racing a
       * recording of it.
       *
       * The room is where the next round comes from, so that is where it
       * goes: the standings are there, whose turn it is is there, and the
       * Start button is there for whoever owns it.
       */
      if (this.multiplayer) { this.toRoom(); return }
      if (!this.circuitActive || !this.circuit) { this.startRace(); return }
      if (isComplete(this.circuit)) {
        // The series is over. Stay out of it, keep the standings, and let the
        // title screen offer a fresh one.
        this.circuitActive = false
        this.publishCircuit()
        this.frontEnd.show('title')
        return
      }
      this.setTrack(trackIdForRound(roundsDone(this.circuit)))
      this.startRace()
    }
    this.frontEnd.onRestart = () => this.startRace()
    this.frontEnd.onCircuitNew = () => {
      clearCircuit()
      this.circuit = newCircuit(this.frontEnd.selectedPilotId, this.frontEnd.selectedChassisId)
      this.circuitActive = true
      saveCircuit(this.circuit)
      this.publishCircuit()
      // Straight to the garage: the circuit owns the track list, so the only
      // decision left before round 1 is what to drive.
      this.frontEnd.show('garage')
    }
    this.frontEnd.onCircuitResume = () => {
      if (!this.circuit) { this.frontEnd.onCircuitNew(); return }
      this.circuitActive = true
      this.publishCircuit()
      this.frontEnd.show('garage')
    }
    this.frontEnd.onResume = () => this.resume()
    this.frontEnd.onQuit = () => this.toMenu()
    // THE HOST PRESSED START. Fires on every client, the host included, from
    // LobbyService.onStart -- see the note on FrontEnd.onMultiplayerStart for
    // why this is the push and not the host's own return value.
    this.frontEnd.onMultiplayerStart = (packet) => this.startMultiplayer(packet)
    this.input.onPause = () => {
      if (this.settings.isOpen) { this.settings.close(); return }
      if (this.phase === 'racing') this.pause()
      else if (this.phase === 'paused') this.resume()
      // Escape / Start during the ceremony is the skip, not a pause menu.
      else if (this.phase === 'ceremony' && this.cerT >= T.ceremony.skipGuard) this.finishRace()
      // ...and the same during the podium, behind the same kind of guard.
      else if (this.phase === 'podium' && this.podT >= PODIUM_SKIP_GUARD) this.endPodium()
    }

    window.addEventListener('resize', this.onResize)
    window.addEventListener('orientationchange', this.onResize)
    // The visual viewport moves independently of the layout viewport when a
    // mobile URL bar slides away; the window does not always hear about it.
    window.visualViewport?.addEventListener('resize', this.onResize)
    // And the element itself, which is the thing that actually has to match:
    // a ResizeObserver fires AFTER layout, so it reports the size the page
    // settled on rather than one it was passing through.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.syncSize())
      this.resizeObs.observe(this.container)
    }
    document.addEventListener('visibilitychange', this.onVisibility)

    /**
     * THE TITLE SCREEN OWNS A RACE, AND ONLY THE TITLE SCREEN.
     *
     * Two reasons it stops the moment any other screen comes up, and only one
     * of them is thrift:
     *
     *   The garage builds a SECOND WebGL context for its vehicle preview. A
     *   full race rendering underneath that is exactly the pair of contexts
     *   garagePreview.ts exists to prevent -- see its header.
     *
     *   Every other screen is opaque. Rendering a circuit nobody can see is a
     *   phone's battery spent on nothing.
     *
     * Coming back to the title builds a fresh race rather than resuming the old
     * one, which costs a track rebuild. That is the deliberate trade: the cost
     * lands on a rare back-navigation instead of on every frame of a screen the
     * player is going to leave, and a new grid each visit is the better attract
     * screen anyway.
     */
    this.frontEnd.onScreen = (screen) => {
      if (screen === 'title') this.startAttract()
      else this.stopAttract()
      // WALKING INTO THE TRACK LIST LEAVES THE CIRCUIT. It is the one screen
      // whose whole purpose is choosing a circuit yourself, so being on it and
      // being in a series are contradictory -- and a player who ends up there
      // mid-circuit and starts a race must not have it scored as a round. The
      // save is untouched, so Continue still works from the title.
      if (screen === 'track' && this.circuitActive) {
        this.circuitActive = false
        this.publishCircuit()
      }
      this.audio.menuMusic(screen === 'title' ? 'title'
        : screen === 'track' || screen === 'garage' ? 'garage' : null)
      // Start pulling the race bed while the player is still choosing. It is
      // 2.5-4MB; left until startRace() the fetch begins at the moment the
      // music should already be playing, and on a phone the first stretch of
      // the race runs in silence with the bed fading in over it.
      if (screen === 'track' || screen === 'garage') {
        this.audio.preloadTrack(this.nextTrackId())
      }
    }

    /**
     * THE GESTURE. Every browser starts an AudioContext suspended and will only
     * resume it inside a real user interaction -- that is the autoplay policy,
     * not a bug to route around. A pointerdown on the container is the widest
     * net that still counts: it catches the PLAY button, every menu card, and
     * the first touch of the driving pads.
     */
    const unlock = (): void => { this.audio.unlock() }
    container.addEventListener('pointerdown', unlock)
    container.addEventListener('keydown', unlock)

    // VO follows the TEXT callouts rather than re-deriving the moments. See the
    // note on Cheer.onLine: one set of editorial rules, two media.
    this.cheer.onLine = (kind) => { this.audio.callout(kind) }

    /**
     * ===================================================================
     * WHERE THE CREDITS GO, WHICH UNTIL NOW WAS NOWHERE
     *
     * `score/wallet.ts` has always paid out -- `RecordStore.submit` banks every
     * finished race into the process-wide wallet -- and documented `onBank` as
     * existing "so the account layer can forward it to `award()`". Nothing ever
     * did. Meanwhile `ui/profile.ts` draws `PlayerProfile.credits`, which is the
     * SERVER's number. So the shop and the rank ladder were reading a balance
     * that no race had ever touched: credits were earned into a local cache
     * nothing displayed and banked nowhere anybody could spend them.
     *
     * THIS IS THE ONLY FILE THAT CAN CLOSE IT, and not by elimination:
     *
     *   the wallet   refuses to know the network exists, deliberately, and a
     *                results screen must not wait on one.
     *   records.ts   is the same layer -- `src/score` -- and pulling `net/` into
     *                it would invert a dependency that already points the other
     *                way (`net/account.ts` imports `MAX_PER_RACE` from the
     *                wallet, because the server's clamp and the client's cap
     *                have to be the same number).
     *   the account  is handed a count of credits and cannot know what a race
     *                is, let alone whether this one was won.
     *
     * And WON is the part that settles it. `award(credits, { won })` carries the
     * flag because `PlayerProfile.wins` is a counter the profile screen shows
     * and the `flagbearer` feat is re-derived from -- "identity, not payment",
     * as wallet.ts puts it -- and `RunRecord` deliberately carries no finishing
     * position, so the payout cannot supply it. The finishing order is in
     * `this.race`. That is here.
     *
     * INSTALLED ONCE, AT BOOT, rather than per race: `onBank` is one slot on one
     * process-wide wallet, and re-assigning it from a race path would be a
     * subscription whose lifetime is a race and whose owner is not.
     */
    sharedWallet().onBank = (paid) => { void this.forwardAward(paid) }

    this.onResize()
    this.tools.hidden = true
    this.frontEnd.show('title')
    this.lastTime = performance.now()
    this.raf = requestAnimationFrame(this.loop)
  }

  /**
   * The in-race tool bar: a settings gear and a pause button. The pause button
   * matters most on touch, where there is no Escape key and the game would
   * otherwise be unpausable.
   */
  private buildTools(container: HTMLElement): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'sg-tools'

    const mk = (label: string, svg: string, onTap: () => void): HTMLButtonElement => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'sg-tools__btn'
      b.setAttribute('aria-label', label)
      b.title = label
      b.innerHTML = svg
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation() })
      b.addEventListener('click', (e) => { e.preventDefault(); onTap() })
      return b
    }

    const gear = mk('Settings and controls',
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/>' +
      '<path d="M12 2.6v2.2M12 19.2v2.2M4.35 4.35l1.55 1.55M18.1 18.1l1.55 1.55' +
      'M2.6 12h2.2M19.2 12h2.2M4.35 19.65l1.55-1.55M18.1 5.9l1.55-1.55"/></svg>',
      () => this.openSettings())

    const pause = mk('Pause',
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5v14M15 5v14"/></svg>',
      () => {
        if (this.phase === 'racing') this.pause()
        else if (this.phase === 'paused') this.resume()
      })

    bar.appendChild(gear)
    bar.appendChild(pause)
    container.appendChild(bar)
    return bar
  }

  /** Opening settings mid-race pauses it; closing resumes. `achievements` is
   *  the Badges page -- the wall, reachable mid-race. */
  openSettings(tab: SettingsTab = 'settings'): void {
    if (this.phase === 'racing') { this.pausedBySettings = true; this.pauseSilent() }
    this.tools.hidden = true
    this.settings.open(tab)
  }

  // -------------------------------------------------------------------------
  /**
   * Swap the circuit. Everything downstream is keyed off the Track instance --
   * buildWorld() re-reads it, the HUD rebakes its minimap when the identity
   * changes, and startRace() copies `track.def.id` into SimConfig.trackId --
   * so replacing it here is the whole change. An id with no track behind it
   * falls back to Rustfall rather than throwing a menu selection into the sim.
   */
  private setTrack(id: string): void {
    // RESOLVED FIRST, THEN COMPARED. The fallback has to happen before the
    // early-out or an id with no track behind it never equals `track.def.id`
    // and rebuilds Rustfall on top of Rustfall -- which costs a track bake and
    // makes the HUD re-bake its minimap, because both are keyed off the Track
    // INSTANCE. Harmless when the ids come from the shipped track list; a lobby
    // packet is the first caller whose id this client may simply not have.
    const def = TRACKS_BY_ID[id] ?? RUSTFALL
    if (def.id === this.track.def.id) return
    this.track = new Track(def)
  }

  /**
   * The circuit the next race will actually run on.
   *
   * In circuit mode the player never sees the track list, so the front end's
   * remembered selection is the last SINGLE race's circuit and preloading its
   * music would fetch two to four megabytes of the wrong bed.
   */
  private nextTrackId(): string {
    if (this.circuitActive && this.circuit && !isComplete(this.circuit)) {
      return trackIdForRound(roundsDone(this.circuit))
    }
    return this.frontEnd.selectedTrackId
  }

  /** Push the circuit's state at every screen that shows part of it. */
  private publishCircuit(): void {
    this.frontEnd.setCircuit(this.circuit
      ? { state: this.circuit, localId: 0, active: this.circuitActive }
      : null)
  }

  private setTier(tier: QualityTier): void {
    if (tier === this.tier && this.trackVis) return
    this.tier = tier
    this.quality = { ...QUALITY_PRESETS[tier] }
    this.applyRenderScale()
    if (this.trackVis) this.buildWorld()
  }

  private applyRenderScale(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, this.tier === 'high' ? 2 : 1.5)
    this.renderer.setPixelRatio(dpr * this.quality.renderScale)
    this.renderer.shadowMap.enabled = this.quality.shadows
    if (this.quality.shadows) this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
  }

  private buildWorld(): void {
    this.teardownWorld()
    this.trackVis = buildTrackVisual(this.track, this.quality)
    this.scene.add(this.trackVis.group)
    this.envVis = buildEnvironment(this.track, this.scene, this.quality)
    if (!this.envVis.group.parent) this.scene.add(this.envVis.group)
    this.entityVis = createEntityVisuals(this.track, this.quality)
    this.scene.add(this.entityVis.group)
    this.vfx = createVfx(this.scene, this.quality)
    // Effects are placed in the racer's own frame on a gravity track, so drift
    // sparks land on the wall the car is riding rather than on the ground below
    this.vfx.gravity = this.track.hasGravity
    if (!this.vfx.group.parent) this.scene.add(this.vfx.group)
    this.plates = createNameplates(this.quality)
    this.scene.add(this.plates.group)
    // The race's roster, back onto the world that was just rebuilt. See the
    // field's own note: this is the line that stops an adaptive step-down from
    // deleting every name in the race.
    this.plates.setRoster(this.nameplateRoster)
    this.post = this.quality.postFx
      ? createPostFx(this.renderer, this.scene, this.chase.camera, this.quality)
      : null
    // A freshly built chain starts at the tuned look. Put the player's choice
    // back on it before it draws a frame: this runs on every adaptive quality
    // step-down, which is precisely the moment a player who turned the glare
    // down cannot afford to have it handed back.
    this.post?.setIntensity(this.vfxGlare, this.vfxScreen)
    // The adaptive scaler can rebuild the world mid-race. teardownWorld also
    // drops the vehicle visuals, so they must be respawned or renderFrame
    // dereferences an empty array on the very next frame.
    if (this.race) this.spawnRacerVisuals()
  }

  private spawnRacerVisuals(): void {
    if (!this.race) return
    for (const rr of this.renderRacers) { this.scene.remove(rr.visual.group); rr.visual.dispose() }
    this.renderRacers = []
    for (const r of this.race.state.racers) {
      const visual = createVehicleVisual(r.chassisId, r.pilotId, this.quality)
      // On a gravity track the body is oriented from the sim's (fwd, up) frame
      // instead of the compass yaw, so a car on a wall is rolled onto the wall.
      visual.gravity = this.track.hasGravity
      this.scene.add(visual.group)
      this.renderRacers.push({
        visual,
        view: JSON.parse(JSON.stringify(r)) as RacerState,
        prevX: r.pos.x, prevY: r.pos.y, prevZ: r.pos.z, prevYaw: r.yaw,
        prevFX: r.fwd.x, prevFY: r.fwd.y, prevFZ: r.fwd.z,
        prevUX: r.up.x, prevUY: r.up.y, prevUZ: r.up.z,
      })
    }
  }

  private teardownWorld(): void {
    for (const rr of this.renderRacers) { this.scene.remove(rr.visual.group); rr.visual.dispose() }
    this.renderRacers = []
    if (this.trackVis) { this.scene.remove(this.trackVis.group); this.trackVis.dispose(); this.trackVis = null }
    if (this.envVis) { this.scene.remove(this.envVis.group); this.envVis.dispose(); this.envVis = null }
    if (this.entityVis) { this.scene.remove(this.entityVis.group); this.entityVis.dispose(); this.entityVis = null }
    if (this.vfx) { this.scene.remove(this.vfx.group); this.vfx.dispose(); this.vfx = null }
    if (this.plates) { this.scene.remove(this.plates.group); this.plates.dispose(); this.plates = null }
    if (this.post) { this.post.dispose(); this.post = null }
  }

  /**
   * INSTALL (or clear) THE MULTIPLAYER ROSTER THE NAME PLATES DRAW.
   *
   * The only way into the feature, and it takes exactly what the transport
   * publishes: `RaceStartPacket.grid` and `RaceStartPacket.localPlayerId`. The
   * netcode calls this alongside the startRace it drives from the same packet;
   * nothing else in the game does, which is why a single-player race is
   * byte-for-byte the frame that shipped.
   *
   * Passing null clears the plates and releases the atlas. toMenu and the
   * results screen do NOT call it: a rematch of the same lobby keeps the same
   * grid, and re-baking an identical atlas between rounds would be work for
   * nothing.
   */
  setNameplateRoster(roster: NameplateRoster | null): void {
    this.nameplateRoster = roster
    this.plates?.setRoster(roster)
  }

  // -------------------------------------------------------------------------
  // THE TITLE SCREEN'S RACE
  //
  // Not a cutscene, not a video, not a pre-rendered plate: an actual race with
  // an actual field, on the same sim the player is about to drive. Everything
  // that makes the game look like itself -- the drift ribbons, the sparks, the
  // sky, the overtakes -- is already built and already tuned, so the honest
  // representation of this game is a frame of it, and the cheapest way to get
  // one is to run it.
  //
  // THREE THINGS THIS IS NOT ALLOWED TO DO
  //
  //   Cost a phone its first impression. The field scales with the tier the
  //   device already detected (see attractRacerCount): the sim is arithmetic
  //   and free, the vehicles are the draw calls, so the pack shrinks rather
  //   than the feature being gated off mobile.
  //
  //   Take the player's input. Every racer here is AI -- localRacerIndex is
  //   -1 -- and the loop does not call setInput at all in this phase, so a
  //   keypress on the title screen cannot nudge a car.
  //
  //   Keep running when nobody is looking. See the visibilitychange handler:
  //   a backgrounded tab stops stepping entirely rather than relying on the
  //   browser to throttle rAF generously.
  // -------------------------------------------------------------------------
  private startAttract(): void {
    if (this.phase === 'attract') return
    /**
     * THE TITLE SCREEN IS THE END OF A LOBBY RACE, and this is the line where
     * that matters rather than a tidiness.
     *
     * buildWorld() two lines down re-installs `nameplateRoster` on whatever it
     * just made -- that is the fix that stops an adaptive step-down deleting
     * every name mid-race -- so a roster still held from a finished lobby race
     * would make the attract race BAKE THE ATLAS. The field's own note promises
     * that the title screen pays for no part of this feature, and a stale
     * roster is the one way that promise breaks.
     *
     * Nothing draws it either way (the plate pass is gated on the racing,
     * ceremony and paused phases), so the bug would have been invisible and
     * would have cost a texture upload on the first screen of the game, on the
     * device least able to spare one.
     */
    if (this.multiplayer) {
      this.multiplayer = null
      this.seriesTable = []
      this.detachNet()
      this.setNameplateRoster(null)
    }
    resetAI()
    this.setTrack(ATTRACT_TRACK)
    this.applyRenderScale()
    this.buildWorld()
    this.eventCarry.reset()
    // ACHIEVEMENTS: nobody is credited for the title race. Ended rather than
    // banked -- every path that leaves a real race banks it on the way out
    // (finishRace, toMenu, startRace), so anything still watched here is a
    // round that was voided.
    this.ach.end()
    this.badgeToasts.setChipHost(null)

    const n = attractRacerCount(this.tier)
    // A varied grid rather than the player's garage selection: this is a shop
    // window for the roster, so it should show as much of the roster as it has
    // slots for.
    const config: SimConfig = {
      seed: (Math.random() * 0xffffffff) >>> 0,
      totalLaps: 9,   // long enough that the title screen never runs out of race
      racerCount: n,
      trackId: this.track.def.id,
      chassisIds: Array.from({ length: n }, (_, i) => CHASSIS[i % CHASSIS.length].id),
      pilotIds: Array.from({ length: n }, (_, i) => PILOTS[i % PILOTS.length].id),
      localRacerIndex: -1,
      // The title-screen attract race is always Normal. It is scenery, nobody
    // is scored against it, and a player who had set Expert would otherwise
    // watch a menu background they cannot influence being driven at a pace
    // that says something about their own setting. It says nothing.
    aiSkill: Array.from({ length: n }, (_, i) => skillForSlot('normal', i)),
    }

    this.race = new Race(this.track, config)
    // Deal the field around the lap before it steps. A grid starts bunched and
    // therefore leaves bunched, which from a fixed camera is one convoy and
    // then most of a lap of empty road -- the probe measured exactly that, zero
    // cars on screen from t+25s. See spreadField.
    //
    // Offset a third of a lap back from the camera so the first thing the
    // player sees is cars ARRIVING, not the backs of cars already leaving.
    spreadField(
      this.race.state.racers, this.track,
      shotFor(this.track.def.id).s - this.track.length / 3,
      {
        rideHeightOf: (id) => getLocomotion(id).rideHeight,
        topSpeedOf: (id) => getDerived(id).topSpeed,
      },
    )
    // Not a player, just an index the render path reads for topSpeed and wind.
    // Everything that would treat it as the player is gated on the phase.
    this.localId = 0
    this.spawnRacerVisuals()

    this.chase.gravity = this.track.hasGravity
    this.chase.endCinematic()
    this.accumulator = 0
    this.attractT = 0
    this.input.setPadsVisible(false)
    this.hud.root.style.display = 'none'
    this.tools.hidden = true
    this.phase = 'attract'
  }

  /**
   * The active circuit's theme.
   *
   * Exists for tools/probe-attract.mjs, which has to ask where the hero sky
   * body actually is in order to check the title camera is pointed at it. The
   * alternative was a second copy of that direction vector living in the probe,
   * which would be correct right up until somebody moved the black hole -- and
   * would then keep reporting a pass while the shot quietly pointed at nothing.
   * One accessor is cheaper than that class of bug.
   */
  get theme(): ReturnType<typeof themeFor> { return themeFor(this.track.def.id) }

  /** Tear the title race down. Idempotent: safe to call from any phase. */
  private stopAttract(): void {
    if (this.phase !== 'attract') return
    this.phase = 'menu'
    this.race = null
    this.teardownWorld()
  }

  // -------------------------------------------------------------------------
  /**
   * A LOBBY RACE, FROM THE PACKET THE HOST BROADCAST.
   *
   * Everything this does is set up state that `startRace` already knows how to
   * read, and then call it. There is deliberately no second race path: one
   * function builds a world, a Race, a camera, a HUD and a scorer, and the only
   * thing multiplayer changes is where the grid, the seed, the lap count and
   * the local player come from. A parallel startMultiplayerRace() would be a
   * second place for the ceremony, the settle and the results screen to drift.
   *
   * THE TRACK MAY NOT BE THE ONE THAT IS LOADED, and the existing answer to
   * that is `setTrack` -- the same call circuit mode makes between rounds. It
   * swaps the Track instance, and everything downstream is keyed off that
   * instance: buildWorld() re-reads it a few lines into startRace, the HUD
   * rebakes its minimap when the identity changes, and startRace copies
   * `track.def.id` into SimConfig.trackId. There is no second path to invent.
   *
   * THE GRAND CIRCUIT IS LEFT, NOT DISTURBED. Exactly what walking into the
   * track list does, and for the same reason: being in a series and racing
   * something that is not one of its rounds are contradictory, and a lobby race
   * must not be scored as a round. `saveCircuit` is not called from anywhere in
   * this path, so the standings are untouched and Continue still works from the
   * title screen.
   *
   * ==========================================================================
   * THE WIRE, WHICH IS NOW HERE
   *
   * The previous pass said in this space that there was no transport and the
   * other humans' cars were AI. There is one now, and the difference is
   * `attachNet` at the bottom of this function: the race is built exactly as
   * before and then a `LockstepRunner` is put in front of its step.
   *
   * IT IS STILL ONE RACE PATH. Nothing above `attachNet` knows about the wire,
   * nothing below cares: the runner gates `Race.step`, flips the networked
   * slots' `isAI` off, and feeds them transported inputs. `packet.inputDelay`
   * is finally load-bearing -- it is the number of frames every client holds
   * its own input for -- and it comes from the packet rather than being chosen
   * here, because a delay two clients disagree about is a desync.
   *
   * THE MOCK STILL RACES LOCALLY AND THAT IS CORRECT. `transport()` returns
   * null under `mock` and `perfect`, so `attachNet` does nothing and this is
   * byte for byte the race the previous pass shipped: a lobby flow that works
   * end to end on one machine with AI in the other seats. Two behaviours from
   * one packet, decided by whether there is anybody on the other end.
   *
   * ==========================================================================
   * IT IS CALLED MORE THAN ONCE PER PAGE, WHICH IT DID NOT USED TO BE
   *
   * For most of this function's life the only caller was `onStart` and a page
   * saw one packet ever: the game was on a menu screen, nothing was standing,
   * and "build a race" and "replace a race" were the same thing. `onResync` is
   * the second caller and it arrives ON TOP OF A LIVE RACE -- a running round,
   * its runner, possibly its ceremony or its podium -- because that is what
   * coming back to a round is.
   *
   * So the teardown below is not defensive tidying, it is the difference
   * between the two callers. `startRace` already rebuilds everything it OWNS
   * (`buildWorld` tears the scene down first, the vehicles are respawned, the
   * scorer and the callouts are reset), and what it does not own is exactly
   * what survived into the second race and was visible in the probe: the
   * previous round's runner still gating a `Race` that is about to be thrown
   * away, its net banner still on screen with nothing left to refresh it, and
   * the podium's cars still in the scene with their card over the top --
   * `teardownWorld` has never known about `podiumStage`, because until now
   * nothing could start a race from the podium.
   */
  private startMultiplayer(packet: RaceStartPacket): void {
    // FIRST, AND BEFORE `setTrack` TOUCHES ANYTHING. Everything from here on
    // rebuilds; none of it removes. See the note above.
    this.detachNet()
    this.closePodium()
    // The track BEFORE the config, because the config has to name the circuit
    // that is actually going to be loaded -- `setTrack` falls back to Rustfall
    // for an id this build does not have, and every client resolves it the same
    // way from the same field, so they agree.
    this.setTrack(packet.trackId)
    // A packet this client cannot place itself in does not start a race. The
    // refusal lives inside startRace so that Rematch and Restart are refused by
    // the same line; all this has to do is not have broken anything on the way
    // there, and nothing above this point is destructive.
    if (this.circuitActive) {
      this.circuitActive = false
      this.publishCircuit()
    }
    this.multiplayer = packet
    // THE TABLE THE ROUND IS SCORED ONTO, FROM THE PACKET AND NOT FROM THE
    // ROOM. Every client must fold this round into the same table or the
    // series diverges on the first disagreement, so it arrives in the
    // broadcast with the seed and the grid. Round 0 carries an empty one.
    this.seriesTable = packet.standings
    this.roundEnded = false
    // The name plates take exactly what the packet publishes. THE ONLY CALLER
    // THAT PASSES A ROSTER: a single race, a circuit round and the attract race
    // all leave it null and pay for none of the feature.
    this.setNameplateRoster({ grid: packet.grid, localPlayerId: packet.localPlayerId })
    this.startRace()
    // AFTER, NOT BEFORE. `startRace` builds the `Race` this gates, and it is
    // also the one place that can REFUSE a packet -- a grid this client is not
    // on leaves `this.race` null and `this.multiplayer` cleared, and attaching
    // a runner to that would be attaching it to the attract loop.
    this.attachNet(packet)
  }

  /**
   * Put the round's lockstep gate in front of the race, if there is a wire.
   *
   * ------------------------------------------------------------------------
   * WHAT IS WIRED TO WHAT, because five callbacks in two directions is exactly
   * the shape that ends up half-connected:
   *
   *   transport -> runner   `onInput` / `onHash` / `onDropped`, all three set
   *                         by the runner's own constructor. Not here.
   *   transport -> runner   `onRoundDrop` / `onRoundLive` / `onDesync`: the
   *                         room's VERDICTS, which a guest applies rather than
   *                         reaches. Here, because the runner cannot subscribe
   *                         to messages it does not know the shape of.
   *   runner -> transport   `announceDrop` / `announceDesync`: the same two
   *                         verdicts going the other way, and HOST ONLY. The
   *                         runner already refuses to call them on a guest;
   *                         wiring them unconditionally is safe and means the
   *                         host/guest split lives in exactly one file.
   *   transport -> THIS     `onResync` and `onMigration`, which are not the
   *                         runner's to take: one REPLACES the runner and the
   *                         race under it, and the other is a sentence for the
   *                         screen about a repair the runner is only the
   *                         subject of. Both are below, with their own notes.
   *
   * `health` COMES FROM THE MESH AND NOT FROM THE SCHEDULER. The scheduler can
   * only see that an input has not arrived; the mesh knows whether the wire is
   * gone. That is the difference between the 5-second "we are not sure" drop
   * and the immediate "there is nothing to wait for" one, and without this
   * function the runner would wait five seconds for a peer whose connection
   * had already failed -- five seconds of frozen race, every time, for no
   * information.
   */
  private attachNet(packet: RaceStartPacket): void {
    // BOTH, AND TOGETHER. `netTransport` is only ever read alongside a runner,
    // so a path that cleared one and not the other would leave `netFrame`
    // reporting the LAST round's link status over this one.
    this.net = null
    this.netTransport = null
    const race = this.race
    if (!race || this.multiplayer !== packet) return
    // The lobby's transport for THIS round. Null under the mock, which is the
    // whole of "the mock still races locally".
    const transport = raceTransport()
    if (!transport) return

    const players = new Map<number, string>()
    for (const s of packet.grid) if (s.playerId) players.set(s.slot, s.playerId)
    // The mesh, for the per-peer wire state. Reached through net/index.ts's
    // accessor rather than through the service, so this file still names one
    // module and not two implementations.
    const mesh = liveLobby()?.mesh ?? null

    const runner = new LockstepRunner({
      race,
      transport,
      players,
      // `localId` was assigned FROM THE CONFIG inside startRace, which read it
      // from the packet. Using it here rather than re-deriving keeps the one
      // number this client's whole race hangs off in one place.
      localSlot: this.localId,
      inputDelay: packet.inputDelay,
      // AUTHORITY IS THE PACKET'S ANSWER, not the service's. Every client
      // reads the same grid and reaches the same conclusion about who the host
      // is, which is the property that stops two clients both believing they
      // may propose drops.
      authority: packet.grid.some((s) => s.isHost && s.playerId === packet.localPlayerId),
      health: (slot) => {
        const id = players.get(slot)
        const link = id && mesh ? mesh.get(id) : null
        return link && link.dead ? 'down' : 'up'
      },
      announceDrop: (_slot, playerId, frame) => transport.announceDrop(playerId, frame),
      announceDesync: (frame) => transport.announceDesync(frame),
    })
    transport.onRoundDrop = (playerId, frame) => runner.acceptDrop(playerId, frame)
    /**
     * THE EXACT MIRROR OF THE LINE ABOVE, AND IT HAS TO BE.
     *
     * A drop hands a slot to `stepAI` from an agreed frame; a restore takes it
     * back from one. Both are load-bearing for the same reason and the reason
     * is not politeness: `stepAI` draws from a per-car rng, so a client that
     * substitutes one frame earlier or later than the room makes a different
     * NUMBER of draws, its stream parts company with everybody else's, and the
     * rejoin causes the desync it was meant to survive.
     *
     * `acceptRestore` is what honours the frame -- it refuses a restore that
     * has already been stepped past rather than rewriting history, and the
     * host's `REJOIN_LEAD_FRAMES` exists so that refusal is unreachable. What
     * this line must not do is apply it on ARRIVAL: the announcement is
     * deliberately ahead of the play head, and "as soon as it turns up" is a
     * different frame on every client.
     */
    transport.onRoundLive = (playerId, frame) => runner.acceptRestore(playerId, frame)
    transport.onDesync = (frame) => runner.acceptDesync(frame)
    /**
     * A REPAIR, FOR THE SCREEN.
     *
     * Kept on this object rather than pushed straight at the HUD because the
     * HUD is fed once per rendered frame from `netFrame` and nowhere else:
     * `setNetStatus` takes the whole state each time, so a second writer would
     * be a second source for one line and the next frame would overwrite
     * whichever one lost. The transport ticks this four times a second (see
     * `tickMigration`); the countdown on screen therefore moves at that rate
     * however fast or slow the renderer happens to be going.
     *
     * The ids are resolved to names HERE, where the grid is. See `NetMigration`.
     */
    transport.onMigration = (state) => {
      this.netMigration = state
        ? {
          ...state,
          previousHostName: this.gridName(state.previousHostId),
          newHostName: this.gridName(state.newHostId),
        }
        : null
    }
    /**
     * COMING BACK TO A ROUND: REBUILD, THEN REPLAY. ALWAYS BOTH.
     *
     * The rebuild is not a fallback for "we lost the race object" -- this
     * client is usually still holding a perfectly good `Race` for this very
     * round, and it is still wrong. `RoundResume` in net/types.ts sets out why
     * at length and the short version is that the frames either side of our own
     * handover are poisoned: the host hands a slot to the AI from the last
     * input it HEARD, and a dropped client holds its own inputs `inputDelay`
     * frames beyond that and goes on stepping them until it runs out. So we
     * have simulated frames with a person at the wheel where the room ran an
     * AI. Forward replay cannot undo a frame that was already stepped wrong.
     *
     * AND IT IS UNCONDITIONAL. There is a condition under which reusing the
     * race would be safe -- a drop we never stepped past -- and testing for it
     * would mean the rejoin path taken in a race is not the rejoin path
     * anything was ever verified on, and the one it misjudges desyncs quietly
     * three corners later. types.ts weighs the cost and it is one circuit load
     * plus 52-76ms of replay for six hundred frames, against a world rebuild
     * the player has already paid for once.
     *
     * `startMultiplayer` IS THE REBUILD and is called with the resume's own
     * packet, which types.ts guarantees is identical to the round's original --
     * same seed, same grid, same `inputDelay`, and `localPlayerId` stamped for
     * this reader. Reaching for it rather than for a private rebuild is the
     * point: a returning client is starting the same race everybody else
     * started, so it takes the same path, teardown and all.
     *
     * Then the replay, and it is SYNCHRONOUS with the rebuild on purpose. The
     * transport queues the live inputs arriving at 60Hz while we have no runner
     * to give them to and flushes them the moment the new one introduces itself
     * (see `LiveRaceTransport.pending`), so an await between these two lines
     * would be frames on the floor that the relay will never send again.
     */
    transport.onResync = (resume) => this.resync(resume)
    this.netTransport = transport
    this.net = runner
  }

  /**
   * The display name on this round's grid for a player id, or ''.
   *
   * The grid is the packet's, so it answers for exactly the people in this
   * round and nobody else -- including, deliberately, an old host who left
   * before it started and whose id a migration can still name.
   */
  private gridName(playerId: string): string {
    const grid = this.multiplayer?.grid
    if (!grid || !playerId) return ''
    for (const s of grid) if (s.playerId === playerId) return s.name
    return ''
  }

  /**
   * Take the round back after an absence: rebuild the race, then replay the
   * tape into it.
   *
   * REFUSING A SHORT REPLAY IS THE WHOLE OF THE ERROR HANDLING. `replay`
   * returns the frame it actually reached, which is less than the tape claimed
   * when the tape had a hole in it -- and a client that joined a race it is
   * behind in would be a client stepping frames nobody else is, which is a
   * desync with a longer fuse. There is nothing to retry with, so it says so
   * and leaves the way an ejection leaves.
   */
  /** True only for the duration of a resync rebuild. See the start-hint note
   *  in startRace for the one thing that reads it. */
  private resuming = false

  private resync(resume: RoundResume): void {
    this.resuming = true
    try {
      this.startMultiplayer(resume.packet)
    } finally {
      this.resuming = false
    }
    // ACHIEVEMENTS: the replay below steps the round outside the render loop,
    // where the tracker cannot see it. Anything proved by an absence is
    // withheld for this race; see RaceFacts.partial.
    this.ach.partial()
    const runner = this.net
    if (!runner) {
      console.warn('net: a resync rebuilt no race — the packet does not place this '
        + 'client on the grid, or the round has no wire any more')
      return
    }
    const reached = runner.replay(resume.rows, resume.handovers, resume.frame)
    if (reached >= resume.frame) return
    console.warn(`net: resync replayed to frame ${reached} of ${resume.frame}; the tape `
      + 'was short, so this client would be racing a race the room has left behind')
    // `ejected` RATHER THAN A SIXTH SENTENCE. The state it describes is exactly
    // the one we are in -- the round carried on without us and our slot was
    // driven by the AI -- and `abandonRound` already says that, banks nothing
    // and goes back to the room. A new word for the same outcome would be a
    // state the front end has never heard of.
    this.abandonRound('ejected')
  }

  /** Drop the round's lockstep state. The MESH is not touched -- it belongs to
   *  the lobby and outlives the round, which is what makes a series cheap. */
  private detachNet(): void {
    this.net = null
    this.netTransport = null
    // THE LINE GOES WITH THE RUNNER THAT WROTE IT. `netFrame` is the only
    // thing that refreshes the net sentence and it only runs while there is a
    // runner, so a migration banner left standing here would stay on screen
    // over whatever came next -- including the rebuilt race a migration ends in.
    this.netMigration = null
    this.hud.setNetStatus(null)
  }

  // -------------------------------------------------------------------------
  private startRace(): void {
    // ACHIEVEMENTS: a race still being watched is one being LEFT -- Restart on
    // the pause menu, a lobby's next round arriving over this one -- and it is
    // banked as a quit before anything below replaces it. Not on a resync,
    // which is the same round coming back rather than a new one.
    if (!this.resuming) this.bankQuit()
    /**
     * THE PACKET, RESOLVED -- AND BEFORE ANYTHING IS TORN DOWN.
     *
     * This is the one branch of startRace that can refuse, so it is asked first,
     * while the attract race is still running and the world is still standing.
     * Resolving it after buildWorld() would mean a refusal left the game
     * holding a freshly built circuit for a race that is not going to happen.
     *
     * A refusal cleans up after itself rather than reporting upwards, because
     * three different callers reach this line -- the start packet, Rematch and
     * the pause menu's Restart -- and the honest outcome is the same for all
     * three: there is no lobby race any more, the plates come down, and the
     * player is left on whatever screen they were already looking at.
     */
    const mp = this.multiplayer
      ? multiplayerSimConfig(this.multiplayer, this.track.def.id)
      : null
    if (this.multiplayer && !mp) {
      console.warn('multiplayer: start packet does not place this client on an '
        + `eight-car grid (${this.multiplayer.grid.length} slots, `
        + `localPlayerId ${JSON.stringify(this.multiplayer.localPlayerId)}); refusing`)
      this.multiplayer = null
      this.seriesTable = []
      this.detachNet()
      this.setNameplateRoster(null)
      return
    }

    // FIRST, AND NOT LATER. startRace() calls frontEnd.hide() further down,
    // which fires onScreen(null), which stops the attract race -- and at that
    // point `phase` is still 'attract', so stopAttract() would happily null the
    // race THIS call had just built and tear its world down under it. Ending
    // the title race up here leaves that callback a no-op.
    this.stopAttract()
    resetAI()
    this.adaptTierForRace()
    this.applyRenderScale()
    this.buildWorld()
    // A rematch must not replay the last race's final-frame events.
    this.eventCarry.reset()

    const chassisIds: string[] = []
    const pilotIds: string[] = []
    const aiSkill: number[] = []
    /**
     * THE FIELD, FROM ONE OF THREE PLACES.
     *
     * A LOBBY PACKET FIRST, because it is the only one of the three that is not
     * this client's own opinion. It was resolved at the top of this function --
     * grid, seed, lap count and, crucially, WHICH SLOT THE PLAYER IS IN -- and
     * nothing below may override any of it, least of all with the garage
     * selection: the packet already carries the car this player chose in the
     * room, and rewriting slot 0 from `this.selection` the way circuit mode
     * does would put the local player's car on the host's grid position and
     * leave the local player driving somebody else's.
     *
     * Then the frozen circuit grid, then the single-race generator.
     *
     * THE ONE THING CIRCUIT MODE COULD NOT REUSE.
     *
     * The single-race generator below derives the opponents' chassis from a
     * pool that EXCLUDES the player's car, so it answers differently for every
     * car the player might be driving. That is fine for a one-off race and
     * fatal for a series: a player who switches from a Solaire to a Bulwark
     * between rounds 3 and 4 would find the same seven pilot names sitting in
     * different cars, and the standings would still look perfectly consistent
     * while ranking a field that had been swapped out underneath them. That is
     * the single most likely way this feature ships looking finished and being
     * hollow, so in circuit mode the grid is read from the frozen one instead.
     *
     * Slot 0 always follows the player's current garage choice -- their car is
     * theirs to change, and circuit.ts's applyRound writes it back into the
     * grid so the standings show what they last drove. Slots 1-7 come from the
     * save, aiSkill included, so even a later change to the skill formula
     * cannot re-tune a series someone is halfway through.
     */
    // A lobby race builds nothing here: `multiplayerSimConfig` has already
    // transcribed the packet, positionally and by slot, and it is used verbatim
    // below. Re-deriving any of it on this side would be a second place for the
    // grid to be decided and a second place for it to be decided differently.
    const grid = !mp && this.circuitActive && this.circuit ? this.circuit.grid : null
    if (mp) {
      /* nothing to do: see `config` below */
    } else if (grid && grid.length === RACER_COUNT) {
      for (let i = 0; i < RACER_COUNT; i++) {
        if (i === 0) {
          chassisIds.push(this.selection.chassisId)
          pilotIds.push(this.selection.pilotId)
        } else {
          chassisIds.push(grid[i].chassisId)
          pilotIds.push(grid[i].pilotId)
        }
        aiSkill.push(grid[i].aiSkill)
      }
    } else {
      const pool = CHASSIS.filter((c) => c.id !== this.selection.chassisId)
      for (let i = 0; i < RACER_COUNT; i++) {
        if (i === 0) { chassisIds.push(this.selection.chassisId); pilotIds.push(this.selection.pilotId) }
        else {
          chassisIds.push(pool[(i - 1) % pool.length].id)
          pilotIds.push(PILOTS[i % PILOTS.length].id)
        }
        aiSkill.push(i === 0 ? 0 : skillForSlot(this.difficulty, i))
      }
    }

    /**
     * THE PACKET IS THE CONFIG, or the config is built from this client's own
     * choices. Not a blend of the two: `mp` already carries the seed every
     * client must use, the lap count the host published and the room screen
     * showed everybody, and the slot this reader is in. Picking those fields
     * out one at a time here would be a second transcription to keep in step
     * with the first.
     *
     * `localRacerIndex` is zero on both of the other two paths because a single
     * race and a circuit round put the player on pole by construction. In a
     * lobby it is wherever they landed -- and `localId` is assigned FROM THE
     * CONFIG a few lines down rather than written as a second literal, so the
     * two can never disagree. Everything downstream of this file resolves the
     * local racer by `RacerState.id` (the HUD, the results table, the VFX) or
     * by object identity (the minimap, the callouts), and `id` is the grid
     * index, so all of it follows this one number.
     */
    const config: SimConfig = mp ?? {
      seed: (Math.random() * 0xffffffff) >>> 0,
      totalLaps: T.race.totalLaps,
      racerCount: RACER_COUNT,
      trackId: this.track.def.id,
      chassisIds, pilotIds,
      localRacerIndex: 0,
      aiSkill,
    }

    this.race = new Race(this.track, config)
    this.localId = config.localRacerIndex
    // ACHIEVEMENTS: watch this race from its first step. A resync keeps the
    // watch it already had (see `resync`); its chip goes in the HUD's lap
    // column, under the splits -- see ui/badgeToast.ts for why there.
    if (!this.resuming) this.ach.begin(this.localId, this.track.def.id)
    this.badgeToasts.setChipHost(this.hud.root.querySelector<HTMLElement>('.sg-hud__pos'))
    this.spawnRacerVisuals()

    const local = this.race.state.racers[this.localId]
    this.input.setLiftEnabled(CHASSIS_BY_ID[local.chassisId].locomotion === 'flight')
    this.input.setPadsVisible(true)
    // Tell the rig which frame it is working in BEFORE the reset, so a race
    // that starts on a bank or a wall opens already framed rather than easing
    // the horizon straight over the first second.
    this.chase.gravity = this.track.hasGravity
    this.chase.reset(local)
    this.chase.endCinematic()
    this.accumulator = 0
    this.cerT = 0
    this.cerFieldT = -1
    this.hud.setFinish(null)
    /**
     * WHICH ROUND THIS IS.
     *
     * Null outside circuit mode, which is the whole of "single-race mode is
     * unaffected": the HUD draws nothing at all when it is not told a round,
     * so a one-off race's countdown is byte-for-byte the one that shipped.
     *
     * `roundsDone` is the rounds ALREADY banked, so the round about to be
     * driven is that plus one -- the same arithmetic the garage head and the
     * Start button use, deliberately, because three places disagreeing about
     * what round it is would be worse than none of them saying.
     */
    this.hud.setRound(this.circuitActive && this.circuit && !isComplete(this.circuit)
      ? {
        round: roundsDone(this.circuit) + 1,
        total: CIRCUIT_ROUNDS,
        trackName: this.track.def.name,
      }
      : null)
    /**
     * THE ROCKET-START HINT, and the one condition on it that is not "have you
     * played before".
     *
     * AUTO-ACCELERATE PLAYERS ARE NOT SHOWN IT, because they cannot act on it.
     * With auto-accelerate on -- the DEFAULT on every touch device -- the GAS
     * pad is not on screen at all (see touchControls.ts, `.sgtc-gas` is
     * display:none in auto mode), so there is no control to press when the
     * lights change and the countdown guard below holds the throttle shut
     * anyway. Teaching somebody a timing they have no button for is worse than
     * saying nothing: it reads as a mechanic that is broken.
     *
     * `takeStartHint()` is called INSIDE the branch rather than outside it, so
     * an auto-accelerate player does not silently spend their one showing on a
     * race that could not show it.
     *
     * AND NOT ON A RESYNC, for the same reason one step further out. A rejoin
     * rebuilds the race and replays it straight past the countdown at speed --
     * there is no green light to react to and nothing on screen long enough to
     * read. A player whose first-ever lobby race is the one their wifi
     * interrupted would otherwise spend their single showing on a countdown
     * that never actually ran.
     */
    this.hud.setStartHint(!this.resuming && !this.input.autoAccelerate && takeStartHint())
    this.cheer.reset()
    this.cheer.setLevel(this.calloutLevel)
    this.scorer.reset()
    this.captureScoreNextFrame = false
    this.scoreHud.reset()
    this.lastScore = 0
    this.lastBestCombo = 1

    this.frontEnd.hide()
    this.hud.root.style.display = ''
    this.tools.hidden = false
    this.audio.endRace()
    this.lastCount = -1
    this.goArmed = false
    this.lastMusicLap = -1
    this.audio.music(this.track.def.id, false)
    this.phase = 'racing'
  }

  private pause(): void {
    if (this.phase !== 'racing') return
    this.phase = 'paused'
    this.frontEnd.show('paused')
  }

  /**
   * Stop the simulation without raising the pause menu. Used when the settings
   * overlay opens mid-race: stacking the pause screen behind a modal leaves two
   * competing panels on screen.
   */
  private pauseSilent(): void {
    if (this.phase !== 'racing') return
    this.phase = 'paused'
  }

  private resume(): void {
    if (this.phase !== 'paused') return
    this.frontEnd.hide()
    this.phase = 'racing'
    this.lastTime = performance.now()
  }

  private toMenu(): void {
    // ACHIEVEMENTS: walking out of a race banks what it counted. See bankQuit.
    this.bankQuit()
    this.closePodium()
    // QUITTING A LOBBY ROUND IS QUITTING IT. The room carries on without this
    // client -- the slot keeps racing under AI and keeps its place in the
    // standings, which is the contract's rule for a mid-series departure --
    // and holding a runner for a round this client has walked out of would
    // keep publishing inputs for a car nobody is driving.
    this.detachNet()
    if (this.multiplayer) {
      this.multiplayer = null
      this.seriesTable = []
      this.setNameplateRoster(null)
    }
    this.phase = 'menu'
    this.race = null
    this.teardownWorld()
    this.tools.hidden = true
    this.hud.setFinish(null)
    this.cheer.reset()
    this.hud.root.style.display = 'none'
    this.input.setPadsVisible(false)
    this.frontEnd.show('garage')
  }

  // -------------------------------------------------------------------------
  // THE FINISH
  //
  // Three steps, and the whole design is in which of them the SIM is allowed
  // to notice:
  //
  //   beginCeremony   the local racer crossed the line. The camera leaves the
  //                   chase rig, the driving HUD goes away and the touch pads
  //                   come off screen. The sim carries on exactly as it was —
  //                   the field is still racing for real positions.
  //   stepCeremony    every FINISHED car, the player's included, is driven by
  //                   the same stepAI the field uses, through a pass that only
  //                   this loop calls. See Race.stepCeremony for the proof
  //                   that it cannot touch a result.
  //   settleRace      the ceremony is over but the field is not in. Run the
  //                   sim flat out to the flag so the results table is the
  //                   real one rather than a guess, then show it.
  // -------------------------------------------------------------------------

  private beginCeremony(): void {
    if (!this.race || this.phase !== 'racing') return
    this.phase = 'ceremony'
    this.cerT = 0
    this.cerFieldT = this.race.state.phase === 'finished' ? 0 : -1
    this.skipArmed = false
    // Hand over from the pose the chase rig is holding RIGHT NOW, before the
    // next render moves it, so there is no cut.
    // The interpolated view when there is one, so the handover starts from the
    // pose the player is actually looking at; the sim racer if the adaptive
    // scaler happens to be between teardown and respawn.
    const rr = this.renderRacers[this.localId]
    this.chase.beginCinematic(rr ? rr.view : this.race.state.racers[this.localId])
    this.input.setPadsVisible(false)
    this.tools.hidden = true
    this.cheer.reset()
    // ARMED HERE, TAKEN ONE SCORING FRAME LATER. Not the same thing.
    //
    // Capturing on this line was wrong, and wrong by the largest award in the
    // game. `onLocalFinish` runs on the sim's finish, BEFORE the render-side
    // scorer has consumed that frame's `local.events` -- and `trackPlace`, the
    // finishing bonus, is in that list. Measured on a real race: the scorer
    // read 76,590 and the results panel printed 75,740, exactly the 850 of an
    // eighth-place finish. First place was losing 6,000.
    //
    // The reason the capture is not simply deferred to the results screen is
    // unchanged and still right: the ceremony runs the remaining cars to the
    // flag and settleRace() can fast-forward the sim, so by the time the panel
    // appears the scorer may have seen a stretch of race the player did not
    // drive. So it is taken at the END of the next scorer.frame() instead --
    // late enough to include the flag, early enough to exclude the ceremony.
    this.captureScoreNextFrame = true
    // Victory or completion, by position. Here rather than off the `finish`
    // EVENT because this function is already the one place that runs exactly
    // once on the frame the local racer takes the flag -- driving it from the
    // event list would mean carrying a second "have I done this yet" flag that
    // has to be reset in all four of the places a race can start.
    this.audio.finishSting(this.race.state.racers[this.localId].position)
    this.syncFinishCard()
  }

  /** Reused: this runs every frame of the ceremony and must not allocate. */
  private readonly finishCard = { position: 0, time: 0, stillRacing: 0, canSkip: false }

  private syncFinishCard(): void {
    if (!this.race) return
    const st = this.race.state
    const local = st.racers[this.localId]
    let out = 0
    for (const r of st.racers) if (!r.finished) out++
    const c = this.finishCard
    c.position = local.position
    c.time = local.finished ? local.finishTime : st.time
    c.stillRacing = out
    c.canSkip = this.cerT >= T.ceremony.skipGuard
    this.hud.setFinish(c)
  }

  /**
   * Is the shot done? `minDuration` guarantees it always gets to land, even
   * for a player who finishes last and ends the race on the same frame.
   * `maxDuration` guarantees a runaway winner is not held hostage by the tail
   * of someone else's race.
   */
  private ceremonyDone(): boolean {
    const C = T.ceremony
    if (this.cerT < C.minDuration) return false
    if (this.cerT >= C.maxDuration) return true
    return this.cerFieldT >= 0 && this.cerFieldT >= C.holdAfterField
  }

  /**
   * Run the remaining racers to the flag at full speed. The alternative —
   * fabricating placings for whoever is still out — would print a results
   * table that never happened, and the sim is cheap enough that there is no
   * reason to: a step is a few microseconds and there are at most a couple of
   * thousand of them left.
   */
  private settleRace(): void {
    const race = this.race
    if (!race) return
    const idle: InputFrame = { steer: 0, throttle: 0, brake: 0, drift: false, item: false, itemBack: false, lift: false, lookBack: false }
    let steps = 0
    while (race.state.phase !== 'finished' && steps < T.ceremony.settleMaxSteps) {
      race.setInput(this.localId, idle)
      race.step()
      steps++
    }
  }

  private finishRace(): void {
    if (!this.race) return
    // Whatever brought us here — the shot ending, a skip, or the last car
    // crossing — the table has to be complete before it is drawn.
    this.settleRace()
    this.tools.hidden = true
    this.hud.setFinish(null)
    this.hud.setRound(null)
    this.cheer.reset()
    this.chase.endCinematic()
    this.input.setPadsVisible(false)
    this.audio.endRace()
    this.audio.music(null, false)
    // THE ROUND IS SCORED BEFORE THE SCREEN IS BUILT, in that order, because
    // showResults() arms the auto-switch to the standings page and that page
    // has to exist and be filled by then. setCircuit is what creates it.
    //
    // WAS IT ALREADY OVER? Asked BEFORE the round is banked, because "the
    // circuit is complete" is true from round 8 onwards and the podium is the
    // moment it BECOMES true. Without this, walking back into a finished
    // circuit and somehow racing again would replay the celebration for a race
    // that scored nothing.
    const wasComplete = this.circuit !== null && isComplete(this.circuit)
    this.scoreCircuitRound()
    if (this.circuitActive && this.circuit && !wasComplete && isComplete(this.circuit)) {
      // ACHIEVEMENTS, banked AFTER the round: Grand Champion is read off the
      // table scoreCircuitRound just finished. See bankRace.
      this.bankRace(true, true)
      this.beginPodium()
      return
    }
    // A LOBBY ROUND IS SCORED THE SAME WAY AND IN THE SAME PLACE, for the same
    // reason the comment above gives: the screen that follows has to be able
    // to read the table, so the table exists first. `scoreSeriesRound` is a
    // no-op outside a lobby race, which is the whole of "single player is
    // unaffected".
    const mpPodium = this.scoreSeriesRound()
    // ACHIEVEMENTS, after the series table for the same reason: a sweep is
    // read off it. The toast only when a podium comes first: the results
    // screen carries its own "New badges" strip, and a toast on top of it was
    // the same news twice -- photographed at 390x844 covering half the
    // results title for its whole 4.2 seconds.
    this.bankRace(false, mpPodium)
    if (mpPodium) { this.beginSeriesPodium(); return }
    this.phase = 'results'
    this.hud.root.style.display = 'none'
    this.showResultsScreen()
  }

  /**
   * Fold the lobby round that just finished into the series table, and say
   * whether that finished the series.
   *
   * ------------------------------------------------------------------------
   * THE FINISHING ORDER COMES FROM THE SIM AND THE IDENTITIES COME FROM THE
   * PACKET, joined on the grid slot. Neither alone is enough: the sim knows
   * who came where and nothing about who is a person, and the packet knows
   * who is a person and nothing about the race. `MultiplayerSlot.slot` is
   * documented as the racer id in the sim, which is what makes the join safe.
   *
   * IT IS SCORED FROM `this.multiplayer.grid`, NOT FROM THE CURRENT ROOM. A
   * player who left during the round is out of the room by now, and reading
   * the room here would drop them from the table -- which is precisely what
   * the contract forbids: "a table that silently drops a driver rewrites the
   * history of the rounds already raced." The grid is who STARTED, and the
   * round is scored on who started.
   *
   * A SLOT THE AI TOOK OVER STILL SCORES, and it scores for the person whose
   * slot it is. That is not generosity, it is the only consistent reading of
   * "their slot keeps racing under AI": the car finished 4th, so the row gets
   * a 4. `applySeriesRound` keeps their name and their avatar rather than
   * adopting the AI's, so the table still says a person was there.
   */
  private scoreSeriesRound(): boolean {
    const packet = this.multiplayer
    const race = this.race
    if (!packet || !race || this.roundEnded) return false
    this.roundEnded = true

    const racers = race.state.racers
    const round: SeriesFinish[] = []
    for (const slot of packet.grid) {
      const r = racers[slot.slot]
      if (!r) continue
      round.push({
        playerId: slot.playerId,
        name: slot.name,
        avatarId: slot.avatarId,
        position: r.position,
        finished: r.finished,
        isLocal: slot.playerId !== null && slot.playerId === packet.localPlayerId,
      })
    }
    this.seriesTable = applySeriesRound(packet.standings, round, packet.round)
    void this.endSeriesRound(this.seriesTable)

    // WHAT THE ROUND DID TO THE TABLE, waiting in the room for them.
    //
    // The room already draws the standings, so this is not the information --
    // it is the CHANGE, which a table cannot show: a player who was 2nd and
    // is now 4th reads two identical-looking tables one round apart and has
    // to remember. A sentence at the moment of arrival is the cheapest
    // possible answer, and it costs nothing on a single race, which gets
    // none of it.
    if (packet.seriesLength > 1) {
      const me = localSeriesLine(this.seriesTable)
      const done = packet.round + 1
      setRoomNotice(me
        ? `Round ${done} of ${packet.seriesLength} scored — you are ${ORDINAL[me.place] ?? me.place + 'th'} `
          + `on ${me.points} ${me.points === 1 ? 'point' : 'points'}.`
        : `Round ${done} of ${packet.seriesLength} scored.`)
    }

    // THE PODIUM IS THE MOMENT THE SERIES BECOMES COMPLETE, which is the round
    // index reaching the last one -- asked from the PACKET rather than from
    // the room for the same reason the table is: the room has not been told
    // yet. A single race is a series of one, so `round 0 of 1` is complete the
    // instant it is scored, and a one-off lobby race would get a championship
    // celebration for finishing one race. It does not: see below.
    const last = packet.round >= packet.seriesLength - 1
    return last && packet.seriesLength > 1
  }

  /** Build and raise the results screen. Split out of finishRace because the
   *  podium sits between the two at the end of a circuit. */
  private showResultsScreen(): void {
    if (!this.race) return
    this.frontEnd.showResults(this.race.state, this.localId, {
      score: this.lastScore,
      bestCombo: this.lastBestCombo,
    }, this.track.def.id)
    void this.publishScore()
    this.frontEnd.show('results')
  }

  // -------------------------------------------------------------------------
  // THE CHAMPIONSHIP PODIUM
  //
  // Entered from finishRace() at the exact moment round 8 is banked, and from
  // nowhere else. Everything about it is a deliberate echo of the finish
  // ceremony, because a player should not have to learn a second set of rules
  // for the second celebration in ninety seconds: the same skip guard, the
  // same edge trigger, the same "a hidden tab is skipped, not paused".
  //
  // IT PLAYS WHETHER OR NOT THE PLAYER IS ON IT. The card names where they
  // finished either way. A celebration you are locked out of is how a series
  // says the last forty minutes were somebody else's; one that says "4th, 46
  // points" while three robots dance is how it says you were in it.
  // -------------------------------------------------------------------------

  private beginPodium(): void {
    if (!this.circuit) { this.phase = 'results'; this.showResultsScreen(); return }
    this.raisePodium(podiumCast(standings(this.circuit), 0), null)
  }

  /**
   * The same celebration at the end of a LOBBY series.
   *
   * NOT A SECOND PODIUM. `game/podium.ts` and `render/podium.ts` are both
   * built, both tested and both take a standings table; everything below the
   * cast -- the five camera beats, the three parked cars, the confetti, the
   * skip rule, the reduced-motion behaviour -- is shared with the Grand
   * Circuit's, and this function's whole job is to build a cast out of a
   * different kind of table.
   *
   * THE TWO THINGS THAT ARE GENUINELY DIFFERENT, and they are both about
   * names rather than about the scene:
   *
   *   WHO. A `StandingRow` carries an entrant with a pilot and a chassis, and
   *        a `SeriesStanding` carries a person with a claimed name and an
   *        avatar. `seriesPodiumCast` joins the two through the last round's
   *        grid, so the SCENE still gets a real car and a real figure to
   *        build -- render/podium.ts never draws a name, which is what makes
   *        this work at all.
   *
   *   WHAT THE CARD SAYS. Single player prints the pilot's roster name,
   *        because in single player the driver IS the pilot. Here it prints
   *        the player's, because "SOCKET" over a car driven by somebody called
   *        Nova is the wrong name in the one place the game names a winner.
   */
  private beginSeriesPodium(): void {
    const packet = this.multiplayer
    if (!packet) { this.phase = 'results'; this.showResultsScreen(); return }
    const table = this.seriesTable
    const localKey = seriesKey({ playerId: packet.localPlayerId, name: '' })
    const cast = seriesPodiumCast(table, packet.grid, localKey)
    this.raisePodium(cast, seriesPodiumNames(table, cast),
      `${packet.seriesLength}-ROUND SERIES`)
  }

  /**
   * Raise the celebration for a cast that is already built.
   *
   * ONE BODY FOR BOTH SERIES, split out of `beginPodium` rather than copied,
   * because everything in it is about the RENDERER and the phase -- tearing
   * the circuit down, rebuilding the post chain against the one camera,
   * putting the world up, taking the racing HUD away -- and none of it knows
   * or cares which kind of series it is celebrating. `names` is the only
   * parameter: null means "use the pilot roster", which is single player.
   */
  private raisePodium(
    cast: PodiumCast,
    names: readonly string[] | null,
    eyebrow = 'GRAND CIRCUIT',
  ): void {
    // A podium with nobody on it is not a scene. Unreachable with the shipped
    // eight-car grid -- standings() returns a row per entrant -- and cheaper to
    // rule out than to debug at the end of a forty-minute series.
    if (cast.steps.length === 0) { this.phase = 'results'; this.showResultsScreen(); return }

    this.phase = 'podium'
    this.podT = 0
    this.podSkipArmed = false
    // The race world goes first. The podium needs the renderer and the scene,
    // not the track: leaving a circuit's terrain, props and sky standing under
    // it would be the most expensive frame in the game for no pixels at all.
    this.teardownWorld()
    this.podiumStage = createPodiumStage(this.scene, cast, this.quality, this.reduceMotion)
    // A fresh post chain against the SAME camera object the stage writes to.
    // See the note in buildWorld: the composer is bound to `chase.camera`, so
    // there is exactly one camera in this game and everything points it.
    this.post = this.quality.postFx
      ? createPostFx(this.renderer, this.scene, this.chase.camera, this.quality)
      : null
    this.post?.setIntensity(this.vfxGlare, this.vfxScreen)

    // WORLD UP, EXPLICITLY. ChaseCamera writes `camera.up` from the racer's
    // own frame every race (see easeUp), so on a banked grid or a gravity
    // circuit the camera arrives here still rolled onto a road that no longer
    // exists -- and `lookAt` builds its basis from `up`, so the whole podium
    // would be photographed at an angle nobody chose.
    this.chase.camera.up.set(0, 1, 0)

    // THE PODIUM OWNS THE SCREEN. In the shipping path the front end is already
    // hidden -- we arrive straight from the ceremony -- but saying so here is
    // what makes the phase self-contained rather than dependent on where it was
    // entered from, and a results panel left standing over the celebration
    // would also swallow the skip button underneath it.
    this.frontEnd.hide()
    this.fillPodiumCard(cast, names, eyebrow)
    this.hud.root.style.display = ''
    this.hud.setPodium(this.podCard)
    // The score counter lives inside the HUD root and survives `is-ceremony`,
    // because during a finish shot the run's score is still the thing the
    // player wants. There is no run here at all.
    this.scoreHud.setVisible(false)
    this.tools.hidden = true
    this.input.setPadsVisible(false)
    // The title theme, because it is the game's own anthem and a championship
    // celebrated in silence is a worse bug than a missing sound effect.
    this.audio.menuMusic('title')
  }

  /**
   * Fill the reused card object. Runs once per podium, not per frame.
   *
   * `names` overrides the pilot roster, step for step, and is how a lobby
   * series names people instead of pilots. Null everywhere else.
   */
  private fillPodiumCard(
    cast: PodiumCast,
    names: readonly string[] | null,
    eyebrow: string,
  ): void {
    const lines: PodiumLine[] = []
    for (let i = 0; i < cast.steps.length; i++) {
      const e = cast.steps[i]
      lines.push({
        place: e.place,
        pilot: names?.[i] ?? pilotName(e.pilotId),
        chassis: CHASSIS_BY_ID[e.chassisId]?.name ?? e.chassisId,
        points: e.points,
        isLocal: e.isLocal,
      })
    }
    this.podCard.lines = lines
    this.podCard.eyebrow = eyebrow
    this.podCard.tied = cast.tied
    this.podCard.canSkip = false
    const place = cast.localPlace
    const pts = cast.localPoints + (cast.localPoints === 1 ? ' point' : ' points')
    this.podCard.you = place === 1
      ? `YOU ARE THE CHAMPION — ${pts}`
      : place > 0
        ? `YOU FINISHED ${ORDINAL[place] ?? place + 'th'} — ${pts}`
        : `${pts}`
  }

  /**
   * One frame of the podium: the clock, the skip and the auto-advance.
   *
   * The skip rule is game/podium.ts's, which is the finish ceremony's: a time
   * guard AND an edge trigger. A player arrives here straight off the last
   * corner of round 8 and may well still be holding the throttle -- a level
   * test alone would end the celebration 0.7 s in, which is the bug the
   * ceremony already fixed once.
   *
   * SAMPLED HERE, ONCE. During a race the sim loop calls sample() and the
   * ceremony reads what it left in `lastInput`; there is no sim running in
   * this phase, so a stale `lastInput` would be frozen at whatever was held
   * crossing the line and the edge trigger would never see a release. So the
   * podium does its own single call per frame, which is the contract sample()
   * needs either way.
   *
   * THE SAME FOUR CONTROLS THE CEREMONY WATCHES, and throttle is deliberately
   * not among them: with auto-accelerate on, throttle is held permanently, so
   * including it would mean the skip never arms for exactly the players least
   * able to do anything about it.
   */
  private stepPodium(dt: number): void {
    this.podT += dt
    const f = this.input.sample()
    const held = f.item || f.drift || f.brake > 0.5 || f.lift
    const r = podiumSkip(this.podT, held, this.podSkipArmed)
    this.podSkipArmed = r.armed
    const canSkip = this.podT >= PODIUM_SKIP_GUARD
    if (canSkip !== this.podCard.canSkip) {
      this.podCard.canSkip = canSkip
      this.hud.setPodium(this.podCard)
    }
    if (r.skip || podiumDone(this.podT)) this.endPodium()
  }

  /** Drop the podium without advancing anywhere. For teardown paths only. */
  private closePodium(): void {
    if (this.podiumStage) { this.podiumStage.dispose(); this.podiumStage = null }
    this.hud.setPodium(null)
  }

  /** Leave the podium for the results screen. Idempotent. */
  private endPodium(): void {
    if (this.phase !== 'podium') return
    this.phase = 'results'
    this.hud.setPodium(null)
    this.hud.root.style.display = 'none'
    if (this.podiumStage) { this.podiumStage.dispose(); this.podiumStage = null }
    if (this.post) { this.post.dispose(); this.post = null }
    this.audio.menuMusic(null)
    this.showResultsScreen()
  }

  /**
   * Bank the round that just finished into the circuit standings.
   *
   * A no-op outside circuit mode, which is the whole of "single-race mode is
   * unaffected": nothing on the single-race path reads or writes the circuit.
   *
   * THE GRID IS CHECKED, NOT ASSUMED. gridMismatch is the assertion this
   * feature lives and dies by, and checking it here -- in the shipping path,
   * on every round -- is worth more than checking it in a test, because the
   * failure it catches is a wiring failure and wiring is what tests fixture
   * away. It cannot refuse the round (the race happened; throwing the result
   * away would be the worse bug) so it reports and carries on.
   */
  private scoreCircuitRound(): void {
    if (!this.circuitActive || !this.circuit || !this.race) return
    if (isComplete(this.circuit)) return
    const racers = this.race.state.racers
    if (racers.length !== CIRCUIT_GRID) return
    const bad = gridMismatch(this.circuit.grid, racers)
    if (bad.length > 0) console.warn('circuit grid drifted:', bad.join('; '))
    const trackId = trackIdForRound(roundsDone(this.circuit))
    this.circuit = applyRound(this.circuit, resultFromRace(trackId, racers.map((r) => ({
      id: r.id,
      position: r.position,
      finished: r.finished,
      finishTime: r.finishTime,
      pilotId: r.pilotId,
      chassisId: r.chassisId,
    }))))
    saveCircuit(this.circuit)
    this.publishCircuit()
  }

  /**
   * A race paid out. Post it, and take back whatever the server says it is
   * worth.
   *
   * ------------------------------------------------------------------------
   * WHY `won` IS READ OFF THE LIVE RACE. `onBank` carries a `Payout` and a
   * `PayoutRun`, and neither has a finishing position in it -- wallet.ts is
   * explicit that placement is already inside `score` and must not be paid for
   * twice. But `award` still wants the flag, for `PlayerProfile.wins` and the
   * feat derived from it. The flag is available for one reason: `onBank` fires
   * SYNCHRONOUSLY inside `RecordStore.submit`, which `publishScore` calls with
   * the finished race still standing, so `this.race` here is the race that just
   * paid. A `Race` that has gone -- a rebuild, a quit -- reads as no win rather
   * than a wrong one, which is the safe direction to be wrong in: `wins` is a
   * counter two avatar unlocks are derived from.
   *
   * Everything after that is `bankAward` below, which is free-standing so the
   * clamp can be exercised without a browser in the room.
   */
  private async forwardAward(paid: Payout): Promise<void> {
    const local = this.race?.state.racers[this.localId] ?? null
    const won = !!local && local.finished && local.position === 1
    const p = await bankAward(accountService(), sharedWallet(), paid.credits, won)
    // The banked profile is the one Tycoon reads -- lifetime credits -- so
    // the wall hears about it the moment the server has said it.
    if (p) this.ach.observeProfile(p)
  }

  // -------------------------------------------------------------------------
  // ACHIEVEMENTS -- the three calls finishRace, toMenu and startRace make.
  // Everything else is in game/achievementRun.ts.
  // -------------------------------------------------------------------------

  /**
   * What this file knows about the race that the sim does not.
   *
   * MULTIPLAYER MEANS ANOTHER PERSON ON THE GRID, not merely a lobby: a room
   * of one against the AI fill is a single race wearing a room's name, and
   * Online Victor says "multiplayer race".
   *
   * AND A PERSON MEANS THE LIVE NETWORK. The shipped default is still the
   * mock world (net/index.ts, DEFAULT_PROFILE), whose lobbies are full of
   * simulated players with player ids -- every one of them driven by the AI.
   * Counting those would hand out Online Victor for beating bots in a room
   * with a lobby's name on it, so the badge waits for `live`, the one profile
   * where the other ids on the grid are somebody.
   */
  private raceContext(
    score: number, bestCombo: number,
    circuit: CircuitEvidence | null = null, sweep = false,
  ): RaceContext {
    const packet = this.multiplayer
    const multiplayer = packet !== null && netProfile() === 'live' && packet.grid.some(
      (s) => s.playerId !== null && s.playerId !== packet.localPlayerId)
    return { difficulty: this.raceDifficulty(), multiplayer, score, bestCombo, circuit, sweep }
  }

  /**
   * Bank the race that just took the flag, and put what it unlocked on the
   * results strip -- and in a toast when `toast` says a podium stands between
   * the flag and that strip.
   *
   * CALLED AFTER THE ROUND IS SCORED, from both of finishRace's exits: Grand
   * Champion and Iron Run are read off the circuit table and a lobby sweep off
   * the series table, and both were only just written. The score and combo are
   * the ones captured at the flag (`lastScore`), not the scorer's running
   * total, for the reason the capture exists: the ceremony is not the player's.
   */
  private bankRace(circuitDone: boolean, toast: boolean): void {
    const race = this.race
    if (!race) return
    const ev = circuitDone && this.circuit ? circuitEvidence(this.circuit) : null
    const packet = this.multiplayer
    const sweep = ev ? ev.sweep
      : packet ? seriesSweep(this.seriesTable, packet.round, packet.seriesLength) : false
    const ids = this.ach.commit(race.state,
      this.raceContext(this.lastScore, this.lastBestCombo, ev?.circuit ?? null, sweep))
    this.badgeToasts.setChipHost(null)
    this.frontEnd.setUnlocks(ids)
    if (toast) this.ach.announce(ids)
  }

  /**
   * Bank a race the player is walking out of, if one is being watched.
   *
   * A QUIT STILL COUNTS WHAT HAPPENED: the drifts released and the rivals
   * knocked out were real, and a lifetime counter that forgot them because the
   * player restarted would be the game taking something back. Everything that
   * needs a result is withheld by the catalogue, because `finished` is false.
   */
  private bankQuit(): void {
    if (!this.ach.tracking || !this.race) return
    const ids = this.ach.commit(this.race.state,
      this.raceContext(this.scorer.score, this.scorer.bestCombo))
    this.badgeToasts.setChipHost(null)
    this.ach.announce(ids)
  }

  /**
   * Show the board for this track, and offer to record the run if it placed.
   *
   * NOTHING IS WRITTEN UNTIL THE PLAYER NAMES IT. `qualifies` only decides
   * whether the name row appears; the submit happens in the callback below. An
   * unnamed run is not silently filed under a default, because a board full of
   * PILOT / PILOT / PILOT is worse than a board with nine rows.
   *
   * Every call here is awaited rather than assumed instant: the store is async
   * on purpose so the server implementation can drop in without this function
   * changing, and a screen that only works when the answer is synchronous would
   * have to be rewritten on that day.
   */
  /**
   * The difficulty the race that just finished was ACTUALLY run at.
   *
   * Read back off the grid rather than off `this.difficulty`, because three
   * different things choose a field and only one of them is the settings row:
   * a circuit round uses the difficulty frozen into its save, a multiplayer
   * round uses the host's, and a single race uses the player's. All three
   * agree on one thing -- the `aiSkill` array the sim was handed -- so that is
   * what gets asked. A record filed under the wrong board is worse than no
   * record, and it is exactly the bug that three sources of truth produce.
   *
   * ONLY THE AI SLOTS. The local player's entry in `aiSkill` is a placeholder
   * that `stepAI` never reads -- it is 0 in a single race, which is band 0,
   * which would make every race look like Easy.
   *
   * Falls back to the setting for a grid that matches no tier: a hand-edited
   * save, or a guest on a build whose ladder differs. `difficultyOfGrid`
   * returning null is it refusing to guess, and guessing here would file the
   * run somewhere arbitrary rather than somewhere merely stale.
   */
  private raceDifficulty(): Difficulty {
    const race = this.race
    if (!race) return this.difficulty
    const skills: number[] = []
    for (const r of race.state.racers) if (r.isAI) skills.push(r.aiSkill)
    return difficultyOfGrid(skills) ?? this.difficulty
  }

  private async publishScore(): Promise<void> {
    const race = this.race
    if (!race) return
    const trackId = this.track.def.id
    const local = race.state.racers[this.localId]
    const score = this.lastScore
    /**
     * WAS THIS RUN OVER THE SAME DISTANCE AS EVERY OTHER ROW ON THE BOARD?
     *
     * A single race and a circuit round both run `T.race.totalLaps`. A LOBBY
     * DOES NOT: the create screen offers 1, 3, 5, 7 or 10 laps, and the host's
     * choice is what every client runs. So a race time, a score and a combo
     * from a ten-lap lobby race are roughly three times a three-lap one's, and
     * a one-lap lobby race produces a "fastest race" that no honest run can
     * ever beat.
     *
     * The board, the records and the world table are all per-TRACK bests, and
     * none of them has a distance column to sort it out afterwards -- so a run
     * over a different distance is not a better result, it is an incomparable
     * one, and filing it would quietly ruin three tables that took real races
     * to fill. It is read-only instead: the player still sees the boards, and
     * the "you qualified, name your run" row never appears, because there is
     * nothing to name it against.
     *
     * NOT gated on `this.multiplayer`. The question is the distance, not the
     * mode: a three-lap lobby race IS directly comparable and should count,
     * which is also what keeps the common case -- a lobby that left the lap
     * count on the track's authored 3 -- feeling like a real race.
     *
     * BEST LAP IS THE CASUALTY, and knowingly. It is the one figure here that
     * is distance-independent, so a blistering lap inside a ten-lap lobby race
     * is genuinely record-worthy and is being dropped with the rest. Splitting
     * the submission in two would mean a records page whose lap row and race
     * row came from different runs, which is a worse lie than a missing row.
     */
    const comparable = race.config.totalLaps === T.race.totalLaps
    const difficulty = this.raceDifficulty()
    // The LOCAL board's key. The world board below is deliberately still keyed
    // by track alone: it is a single global ranking and splitting it four ways
    // would quarter every board's population, which for a game with one player
    // on it today means four empty boards instead of one thin one. Whether the
    // world board should segregate is a product question, not a storage one.
    const boardKey = scopeFor(trackId, difficulty)
    try {
      if (!comparable) {
        this.frontEnd.setRecords(await this.records.get(trackId, difficulty), [])
        this.frontEnd.setBoard(await this.board.top(boardKey, BOARD_SIZE), 0, false)
        this.frontEnd.setGlobal({ status: 'loading', rows: [], rank: 0 })
        void this.global.top(trackId).then((b) => this.frontEnd.setGlobal(b))
        return
      }
      // RECORDS FIRST, AND UNCONDITIONALLY. Unlike the board, a record is taken
      // from every race whether or not the player names anything -- a blistering
      // lap inside a scrappy run is exactly the thing worth remembering, and it
      // would never reach a score board because the run scored badly.
      //
      // The name is whatever they last saved, which may be nothing. The car is
      // the part that carries the meaning here.
      let savedName = ''
      try { savedName = window.localStorage.getItem('sg.name') || '' } catch { /* blocked */ }
      const broken = await this.records.submit({
        trackId,
        difficulty,
        chassisId: local.chassisId,
        pilotId: local.pilotId,
        name: savedName,
        bestLap: local.bestLap,
        // A DNF has no race time, and zero would win "fastest race" forever.
        raceTime: local.finished ? local.finishTime : 0,
        score,
        bestCombo: this.lastBestCombo,
        at: Date.now(),
      })
      this.frontEnd.setRecords(await this.records.get(trackId, difficulty), broken)

      const qualifies = await this.board.qualifies(boardKey, score, BOARD_SIZE)
      const rows = await this.board.top(boardKey, BOARD_SIZE)
      this.frontEnd.setBoard(rows, 0, qualifies)

      // THE GLOBAL BOARD IS READ, NOT POSTED TO, UNTIL THERE IS A NAME.
      //
      // A row on a public table with nobody's name on it is worse than no row,
      // and the player has not been asked yet at this point. So the page shows
      // the world's times now and this run joins them from the save handler
      // below. Deliberately not awaited into the screen's critical path: a slow
      // or absent endpoint must not delay the results appearing.
      this.frontEnd.setGlobal({ status: 'loading', rows: [], rank: 0 })
      void this.global.top(trackId).then((b) => this.frontEnd.setGlobal(b))
      this.frontEnd.onSaveScore = async (name: string): Promise<void> => {
        const rank = await this.board.submit(boardKey, {
          name,
          score,
          trackId,
          chassisId: local.chassisId,
          pilotId: local.pilotId,
          position: local.position,
          bestLap: local.bestLap,
          bestCombo: this.lastBestCombo,
          at: Date.now(),
        }, BOARD_SIZE)
        const after = await this.board.top(boardKey, BOARD_SIZE)
        this.frontEnd.setBoard(after, rank, false)
        // Put the name on the records this race took. NOT by re-submitting the
        // run: an exact tie does not beat the standing record, so a second
        // submit of the same figures is a no-op and the name never lands.
        await this.records.rename(trackId, difficulty, broken, name)
        this.frontEnd.setRecords(await this.records.get(trackId, difficulty), broken)
        // And the world board, now the run has someone's name on it. A DNF has
        // no race time but may still own a fast lap, which is worth posting.
        this.frontEnd.setGlobal(await this.global.submit({
          trackId, name, chassisId: local.chassisId, pilotId: local.pilotId,
          lap: local.bestLap,
          raceTime: local.finished ? local.finishTime : 0,
          score, position: local.position,
        }))
      }
    } catch {
      // A board that cannot be read is not a reason to break the results
      // screen. The race still happened and the score is still on it.
      this.frontEnd.setBoard([], 0, false)
      this.frontEnd.setRecords({}, [])
      this.frontEnd.setGlobal({ status: 'offline', rows: [], rank: 0 })
    }
  }

  // -------------------------------------------------------------------------
  private readonly loop = (now: number): void => {
    this.raf = requestAnimationFrame(this.loop)
    // Before anything is drawn. See the note on syncSize: the shape of the
    // picture is an invariant we check, not an event we hope arrives.
    this.syncSize()
    const rawDt = Math.min(0.25, (now - this.lastTime) / 1000)
    this.lastTime = now
    if (rawDt <= 0) return

    this.trackFrame(rawDt)

    // The title race steps like any other, with one extra condition: a hidden
    // tab stops entirely. rAF throttling in a background tab is a courtesy, not
    // a guarantee, and this is a loop that would otherwise run a full race sim
    // on a phone in someone's pocket.
    const simming = (this.phase === 'racing' || this.phase === 'ceremony'
      || (this.phase === 'attract' && !this.docHidden)) && this.race !== null
    if (this.phase === 'ceremony') this.cerT += rawDt
    if (this.phase === 'attract' && !this.docHidden) this.attractT += rawDt
    if (this.phase === 'podium') this.stepPodium(rawDt)

    if (simming && this.race) {
      this.accumulator += rawDt
      let steps = 0
      const racers = this.race.state.racers
      while (this.accumulator >= DT && steps < this.maxSubSteps) {
        for (const rr of this.renderRacers) {
          const r = this.race.state.racers[this.renderRacers.indexOf(rr)]
          rr.prevX = r.pos.x; rr.prevY = r.pos.y; rr.prevZ = r.pos.z; rr.prevYaw = r.yaw
          if (this.track.hasGravity) {
            rr.prevFX = r.fwd.x; rr.prevFY = r.fwd.y; rr.prevFZ = r.fwd.z
            rr.prevUX = r.up.x; rr.prevUY = r.up.y; rr.prevUZ = r.up.z
          }
        }
        // NOT IN ATTRACT. Every racer on the title screen is AI, and a player
        // mashing keys at the menu must not reach one of them. Skipping the
        // sample outright is the guard -- there is then no path from the
        // keyboard into the title race at all, rather than a flag that some
        // later edit could read the wrong way round.
        if (this.phase !== 'attract') {
          const frame: InputFrame = this.input.sample()
          /**
           * AUTO-ACCELERATE DOES NOT GET TO PRESS THE LAUNCH BUTTON.
           *
           * sim/race.ts grades the standing start off the FIRST FRAME a racer
           * applies throttle. `InputManager.sample()` forces throttle to 1 on
           * every frame when auto-accelerate is on -- which is the default on
           * every touch device -- so the sim saw a touch player open the
           * throttle on the first frame of the countdown, 3.0 seconds before
           * the lights, and graded it as a jump start. Every race. The penalty
           * was invisible (a stun with no words attached) so nobody reported
           * it; putting words on it is what made it findable, and a red JUMP
           * START on the grid of every phone race is not a thing to ship.
           *
           * Held shut for the whole countdown rather than released at some
           * chosen moment, because an auto-throttle that lets go at the right
           * instant is the GAME claiming a bonus the player did not react for.
           * The band race.ts calls "never pressed" -- no boost, no penalty --
           * is the honest grade for a car that is driving its own throttle,
           * and it is what a player gets here. Turning auto-accelerate off
           * puts the GAS pad back and the mechanic with it.
           *
           * THIS IS AN INPUT-ROUTING FIX, NOT A TUNING ONE: the grading rule
           * is right, the throttle it was reading was synthetic.
           */
          if (this.race.state.phase === 'countdown' && this.input.autoAccelerate) {
            frame.throttle = 0
          }
          this.lastInput.lookBack = frame.lookBack
          this.lastInput.item = frame.item
          this.lastInput.drift = frame.drift
          this.lastInput.brake = frame.brake
          this.lastInput.lift = frame.lift
          /**
           * THE ONE BRANCH LOCKSTEP ADDS TO THIS LOOP.
           *
           * With no wire, the line that has always been here: this client's
           * own stick straight into its own racer, and every other car driven
           * by the AI. With a wire, the runner does it instead -- it publishes
           * this frame's input for a frame `inputDelay` ahead, sets EVERY
           * networked slot from the tape (the local one included, quantised
           * and unquantised so this client steps the identical value every
           * other client will), and answers whether the sim may advance.
           *
           * ==================================================================
           * `accumulator = 0` IS LOAD-BEARING AND IS THE WHOLE BUG.
           *
           * The accumulator is real time owed to the simulation. It is added
           * to every rendered frame and paid down in 16.67ms steps, and that
           * is exactly right when the only reason a step does not run is that
           * there is not a whole one owed yet.
           *
           * A STALL IS NOT THAT. During a stall the loop keeps being called
           * sixty times a second and keeps adding 16.67ms of debt, and none of
           * it is paid because `beforeStep` keeps saying no. Five seconds of
           * waiting for a peer banks five seconds -- three hundred frames --
           * of owed simulation. The instant the peer's inputs land, the loop
           * runs its whole sub-step budget on every rendered frame until the
           * debt clears, and the race VISIBLY FAST-FORWARDS: cars teleport
           * down the straight at several times speed, the player's own
           * steering arrives against a car that is no longer where they saw
           * it, and a stall that the netcode survived perfectly turns into a
           * corner nobody could have driven.
           *
           * So a stalled frame does not bank time. The sim clock is the frame
           * counter, and lockstep's whole premise is that the frame counter
           * advances in step with the slowest peer rather than with the wall
           * -- time spent waiting is not time the simulation owes, it is time
           * the simulation did not happen. Zeroing it says exactly that.
           *
           * (The mirror of this is already here, four lines below the loop:
           * `if (steps === this.maxSubSteps) this.accumulator = 0`, which
           * throws away debt the sub-step cap could not pay. Same reasoning,
           * different cause.)
           *
           * `break`, NOT `continue`. The answer cannot change inside one
           * rendered frame: no peer input can arrive while this loop is
           * running, because the message handler that would deliver it is a
           * callback on the same single thread. Spinning would burn the
           * sub-step budget re-asking a question with no new information.
           */
          if (this.net) {
            if (!this.net.beforeStep(frame)) { this.accumulator = 0; break }
          } else {
            this.race.setInput(this.localId, frame)
          }
        }
        this.race.step()
        // The victory lap. A separate pass, deliberately: the headless
        // determinism gate and the balance harness call step() and nothing
        // else, so nothing they measure can move because of this. It also has
        // to run while state.phase is 'finished' -- step() early-returns then,
        // so without this the whole field would freeze the moment the last car
        // crossed, which is the bug this work exists to remove.
        if (this.race.state.finishOrder.length > 0) this.race.stepCeremony()
        // Bank this step's one-shot events: race.step() clears r.events at
        // the top of each step, so with several steps per frame the renderer
        // would only ever see the LAST one's (see eventCarry.ts).
        this.eventCarry.collect(racers)
        // ACHIEVEMENTS read the same step here, once, for the same reason --
        // at any display rate. See score/tracker.ts.
        this.ach.step(this.race.state)
        this.accumulator -= DT
        steps++
      }
      // Publish exactly this frame's events -- and none when no step ran. On a
      // 120Hz or 144Hz display about half the frames run no step, and they
      // used to leave the previous step's events in place for every consumer
      // to read again: the scorer paid each award twice and a fast monitor
      // scored (and earned) half as much again. See eventCarry.ts.
      this.eventCarry.publish(racers, steps)
      if (steps === this.maxSubSteps) this.accumulator = 0

      // --- ceremony state machine -----------------------------------------
      const st = this.race.state
      if (this.phase === 'racing' && st.racers[this.localId].finished) {
        this.beginCeremony()
      }
      if (this.phase === 'ceremony') {
        if (st.phase === 'finished' && this.cerFieldT < 0) this.cerFieldT = 0
        else if (this.cerFieldT >= 0) this.cerFieldT += rawDt
        this.syncFinishCard()
        // Skipping. The pointer path is the Results button; this is the
        // keyboard, gamepad and touch-pad path, gated behind `skipGuard` so
        // the accelerate key still held across the line is not a skip. Reading
        // the frame the sim already sampled keeps sample() called exactly once
        // per step, which is the contract it needs.
        //
        // EDGE-TRIGGERED, not level-triggered. A time guard alone is not
        // enough: a player who crosses the line still holding Drift would have
        // that same unreleased press count as a skip the instant the guard
        // expired, and the shot they asked for would vanish 0.7s in. The
        // control has to be RELEASED once before it can arm.
        const f = this.lastInput
        const held = f.item || f.drift || f.brake > 0.5 || f.lift
        if (!held) this.skipArmed = true
        const skip = held && this.skipArmed && this.cerT >= T.ceremony.skipGuard
        if (this.ceremonyDone() || skip) this.finishRace()
      } else if (this.phase === 'racing' && st.phase === 'finished') {
        // Belt and braces: the local racer is in every finish order, so this
        // should be unreachable. If it ever is not, do not freeze on the line.
        this.finishRace()
      }
    }

    // AFTER the sim block and BEFORE the draw, so the line the player reads is
    // about the frame they are looking at. It also has to run when `simming`
    // is false: a race that is stalled is a race whose phase is still
    // 'racing', but one that has been VOIDED needs to leave, and a verdict
    // that only got looked at on stepping frames would never be seen on the
    // frames where nothing steps -- which is every frame of a stall.
    if (this.net) this.netFrame()

    this.renderFrame(rawDt)
  }

  /**
   * One frame of the wire: say what it is doing, and leave if it is over.
   *
   * ------------------------------------------------------------------------
   * TWO ENDINGS, TWO SENTENCES, AND THEY ARE NOT THE SAME EVENT.
   *
   *   DESYNC    the clients diverged, so the round is VOID FOR EVERYBODY.
   *             net/lockstep.ts is blunt about why there is no third option:
   *             "there is no such thing as a small desync in a deterministic
   *             sim" -- a 1e-4 difference in yaw becomes a different line,
   *             then a collision on one client and not the other, then a
   *             different finishing order. The thing that diverged IS the
   *             result. Scoring it would write the lie into rounds 3, 4 and 5
   *             as well, which is the series-shaped version of the same
   *             problem, so the round scores NOTHING and everybody keeps the
   *             table they had.
   *
   *   EJECTED   the room decided we were gone and carried on without us. The
   *             round was fine. THEIRS was fine, anyway -- they ran our slot
   *             under AI from an agreed frame and scored it, and we have
   *             simulated frames nobody else ran. So our copy of the result
   *             is worthless and the host's is not, which is why this one also
   *             banks nothing: the standings that come back through `onRoom`
   *             are the real ones, and they will have our slot's AI result in
   *             our row.
   *
   * BOTH GO BACK TO THE ROOM, because in both cases the SERIES is still alive.
   * A desync costs one round out of five; an ejection costs us one round out
   * of five. Neither is a reason for eight people to lose their evening, which
   * is the argument types.ts makes about a desync and which holds just as well
   * for the other one.
   */
  private netFrame(): void {
    const net = this.net
    if (!net) return
    const verdict = net.verdict
    if (verdict === 'desync' || verdict === 'ejected') {
      this.hud.setNetStatus({
        verdict, waitingFor: [], loading: false, migration: null, link: 'down',
      })
      this.abandonRound(verdict)
      return
    }
    this.hud.setNetStatus({
      verdict,
      /**
       * IDS IN, NAMES OUT, AND THE DIFFERENCE IS NOT COSMETIC.
       *
       * `LockstepRunner` is built with a slot -> PLAYER ID map, because that is
       * what `announceDrop` has to put on the wire, and it fills `waitingFor`
       * from the same map. `NetStatus.waitingFor` is documented as display
       * names -- and under the live profile a player id is a minted account id
       * with a device salt on the end, so the stall banner was offering to wait
       * for `a7f3…-9c21`.
       *
       * Resolved HERE for the same reason the migration's two ids are: the grid
       * is the packet's and the packet is this file's. Anything that does not
       * resolve is passed through rather than blanked, so a mapping bug reads
       * as an id on screen instead of as an empty banner.
       */
      waitingFor: net.waitingFor.map((id) => this.gridName(id) || id),
      loading: net.waitingToLoad,
      // THE REPAIR OUTRANKS THE STALL, and `netSentence` is where that is
      // decided rather than here: this function's job is to report every fact
      // it has, and choosing between them is the grammar's. Both are true at
      // once during a migration -- the race is stopped AND the relay is being
      // replaced -- and only one of them is worth a player's attention.
      migration: this.netMigration,
      // THE WIRE'S OWN WORD, which the runner does not have one for. A rejoin
      // looks to the runner exactly like a migration -- `paused`, stepping
      // nothing -- and reads to the player as the opposite thing happening.
      link: this.netTransport ? this.netTransport.status : 'up',
    })
  }

  /**
   * The round ended badly. Put the race away and go back to the room.
   *
   * NOTHING IS SCORED AND `endRound` IS STILL CALLED. Those look contradictory
   * and are not: `endRound` is what disposes the round's lockstep state and
   * reopens the room, and it is handed the table UNCHANGED so the series moves
   * on by one round having awarded nobody anything. A round that ended without
   * a result still ended -- refusing to advance would leave eight people in a
   * room whose Start button re-runs a circuit they have already lost half an
   * hour to.
   */
  private abandonRound(why: 'desync' | 'ejected'): void {
    if (this.roundEnded) return
    this.roundEnded = true
    setRoomNotice(why === 'desync'
      ? 'That round was void: the game came apart between the players, so nobody '
        + 'scored. The standings are as they were, and the series carries on.'
      : 'You were dropped from that round and it finished without you. Your car '
        + 'was driven by the AI from the frame you went quiet; the points on the '
        + 'table are what it earned.', 'bad')
    void this.endSeriesRound(this.seriesTable)
    this.toRoom()
  }

  /**
   * Put the race away and go back to the lobby room.
   *
   * THE SAME BODY `toMenu` HAS, WITH A DIFFERENT DESTINATION, and it is a
   * separate function rather than a parameter because the two are reached for
   * different reasons and one of them is not allowed to forget the wire.
   * Every way out of a lobby round arrives here: a void round, an ejection,
   * and the button on the results screen.
   *
   * THE RUNNER GOES AND THE MESH STAYS. `detachNet` drops the round's
   * lockstep state -- its tape, its scheduler, its transport -- and touches
   * nothing peer-shaped. The connections were built to run the ROOM and they
   * outlive every round in it, which is the single reason a five-round series
   * does not pay for five handshakes and five chances to lose somebody.
   */
  private toRoom(): void {
    // ACHIEVEMENTS: a round that arrives here unbanked was voided or taken
    // from us (the results screen's own exit has already banked its race), and
    // a void round banks nothing -- the same rule the standings keep.
    this.ach.end()
    this.badgeToasts.setChipHost(null)
    this.detachNet()
    this.multiplayer = null
    this.setNameplateRoster(null)
    this.race = null
    this.closePodium()
    this.phase = 'menu'
    this.teardownWorld()
    this.tools.hidden = true
    this.hud.setFinish(null)
    this.hud.setRound(null)
    this.cheer.reset()
    this.hud.root.style.display = 'none'
    this.input.setPadsVisible(false)
    this.audio.endRace()
    this.audio.music(null, false)
    this.frontEnd.show('room')
  }

  /**
   * Tell the lobby the round is over. Hook 4 of five, and the one nothing
   * called before this pass -- which is why a series could not reach round 2.
   *
   * FIRE AND FORGET, AND DELIBERATELY NOT AWAITED BY ANY CALLER. The
   * authoritative answer is the `onRoom` that follows, exactly as it is for
   * every other write on `LobbyService`; a results screen that waited on a
   * round trip before it would draw is a results screen that does not appear
   * when the network is bad, which is when it is most wanted.
   *
   * EVERY FAILURE IS SWALLOWED, including `lobbyService()` throwing outright.
   * This runs on the frame a race ends. The worst thing a mis-wired lobby can
   * do to a player at that moment is take the finish away from them, and the
   * cost of the alternative is that a series does not advance -- which the
   * room will show, in words, on the very next screen.
   */
  private async endSeriesRound(table: readonly SeriesStanding[]): Promise<void> {
    if (!this.multiplayer) return
    try {
      await lobbyService().endRound(table)
    } catch (e) {
      console.warn('multiplayer: the round could not be ended', e)
    }
  }

  private trackFrame(dt: number): void {
    const ms = dt * 1000
    if (this.frameTimes.length < 90) this.frameTimes.push(ms)
    else { this.frameTimes[this.frameIdx] = ms; this.frameIdx = (this.frameIdx + 1) % 90 }
    this.fps = 1000 / Math.max(0.5, avg(this.frameTimes))

    // Adaptive quality: step down if we cannot hold the frame, never step the
    // simulation rate, which would change the handling model.
    this.qualityCooldown -= dt
    if (this.qualityCooldown <= 0 && this.frameTimes.length >= 90 && this.phase === 'racing') {
      const p95 = percentile(this.frameTimes, 0.95)
      this.raceP95 = p95
      if (p95 > 24 && this.tier !== 'low') {
        this.setTier(this.tier === 'high' ? 'medium' : 'low')
        this.qualityCooldown = 6
        this.frameTimes.length = 0
        this.raceP95 = Infinity
      }
    }
  }

  /**
   * The quality a race STARTS at, decided before its world is built.
   *
   * TWO THINGS WERE WRONG WITH A ONE-WAY RATCHET.
   *
   * It judged the countdown. The window it reads is the last 90 frames, and
   * at the start of a race those are the frames that built the world and
   * compiled its shaders -- the slowest frames of the session on any device.
   * The check ran from the first frame the window was full, so a machine that
   * hitched while compiling could lose a tier before the lights went out. The
   * window is now emptied here and the first four seconds (the 3.6 s countdown
   * and a margin) are not judged.
   *
   * And it never gave anything back. A notification, a thermal blip or one
   * bad corner cost the player their chosen quality for every rematch and
   * every round that followed; only going back through the garage restored
   * it. Now a race that ran with a lot of room to spare -- a settled p95
   * under 13 ms at the lower tier, twice the frame rate the step-down fires
   * at -- starts the NEXT race one tier higher, never above the player's
   * choice. Between races, because a step is a world rebuild and a rebuild
   * mid-race is a hitch at the worst moment; and one tier at a time, so a
   * wrong guess costs one step-down six seconds into a race, not a lurch.
   */
  private adaptTierForRace(): void {
    const RANK: Record<QualityTier, number> = { low: 0, medium: 1, high: 2 }
    if (RANK[this.tier] < RANK[this.chosenTier] && this.raceP95 < 13) {
      this.tier = this.tier === 'low' ? 'medium' : 'high'
      this.quality = { ...QUALITY_PRESETS[this.tier] }
    }
    this.raceP95 = Infinity
    this.frameTimes.length = 0
    this.frameIdx = 0
    this.qualityCooldown = 4
  }

  private renderFrame(dt: number): void {
    // THE PODIUM DRAWS FIRST AND RETURNS. It has no racers and no track, so
    // every line below it would either skip or dereference something that is
    // not there -- and the interpolation block's guard (`renderRacers.length
    // === racers.length`) happens to be false here for the wrong reason, which
    // is exactly the kind of accidental correctness that breaks later.
    if (this.phase === 'podium' && this.podiumStage) {
      this.podiumStage.update(dt, this.podT, this.chase.camera)
      if (this.post) {
        this.blastBuf.length = 0
        this.post.setBlasts(this.blastBuf)
        // No boost, no hit, no speed, no warp: nothing here is a car. The
        // bloom is the whole point of running the chain at all -- it is what
        // turns a firework from a bright dot into a firework.
        this.post.render(dt, 0, 0, 0, 0, this.reduceMotion)
      } else {
        this.renderer.render(this.scene, this.chase.camera)
      }
      return
    }

    const alpha = this.race ? clamp01(this.accumulator / DT) : 1

    if (this.race && this.renderRacers.length === this.race.state.racers.length) {
      const st = this.race.state
      for (let i = 0; i < this.renderRacers.length; i++) {
        const rr = this.renderRacers[i]
        const r = st.racers[i]
        const v = rr.view
        // Cheap structural copy: only the fields the visual reads.
        copyView(v, r)
        v.pos.x = rr.prevX + (r.pos.x - rr.prevX) * alpha
        v.pos.y = rr.prevY + (r.pos.y - rr.prevY) * alpha
        v.pos.z = rr.prevZ + (r.pos.z - rr.prevZ) * alpha
        v.yaw = lerpAngle(rr.prevYaw, r.yaw, alpha)
        if (this.track.hasGravity) {
          // Plain lerp, not a slerp. One sim step of wall-ride roll is a few
          // degrees, where the two differ by well under a tenth of a degree,
          // and the visual re-orthogonalises and re-normalises the pair before
          // building its basis -- so the only thing a slerp would buy here is
          // an acos and two sins per racer per frame.
          v.fwd.x = rr.prevFX + (r.fwd.x - rr.prevFX) * alpha
          v.fwd.y = rr.prevFY + (r.fwd.y - rr.prevFY) * alpha
          v.fwd.z = rr.prevFZ + (r.fwd.z - rr.prevFZ) * alpha
          v.up.x = rr.prevUX + (r.up.x - rr.prevUX) * alpha
          v.up.y = rr.prevUY + (r.up.y - rr.prevUY) * alpha
          v.up.z = rr.prevUZ + (r.up.z - rr.prevUZ) * alpha
        }
        const camDist = this.chase.camera.position.distanceTo(
          TMP.set(v.pos.x, v.pos.y, v.pos.z),
        )
        rr.visual.update(v, dt, camDist)
      }

      const local = st.racers[this.localId]
      const topSpeed = getDerived(local.chassisId, local.pilotId).topSpeed
      const lookBack = this.lastInput.lookBack
      const localView = this.renderRacers[this.localId].view
      if (this.phase === 'attract') {
        // THE FIXED SHOT.
        //
        // Written straight onto the chase rig's own camera rather than onto a
        // second PerspectiveCamera, and that is load-bearing: the post chain is
        // built against `this.chase.camera` (see buildWorld), so a camera
        // swapped in here would render the scene through the old one and every
        // bloom pass would be composited from the wrong view.
        const pose = attractPose(
          shotFor(this.track.def.id), this.track, this.attractT, this.reduceMotion,
          this.attractBuf,
        )
        const cam = this.chase.camera
        cam.position.copy(pose.pos)
        cam.lookAt(pose.target)
        if (cam.fov !== pose.fov) { cam.fov = pose.fov; cam.updateProjectionMatrix() }
      } else if (this.phase === 'ceremony') {
        // The finish shot. It needs the track because "above the ground" on a
        // banked, climbing circuit is not a constant -- see camera.ts.
        this.chase.updateCinematic(localView, dt, this.track, this.reduceMotion)
      } else {
        this.chase.update(localView, dt, topSpeed, lookBack, this.reduceMotion)
      }

      this.entityVis?.update(dt, st, st.time)
      if (st.phase === 'countdown') {
        // T.race.goLead, not a literal 0.6. This is the number the rocket
        // start prices a reaction against (see T.boost.launchPerfect), and
        // when it was written out by hand in both places they disagreed --
        // which is how reacting WELL to this light became a penalty.
        const n = Math.ceil(st.countdown - T.race.goLead)
        this.entityVis?.setStartLights(Math.max(0, Math.min(3, n)))
        // One beep per integer. Driven off the same number the start lights
        // read, so the sound and the lamp can never disagree about the count.
        if (n !== this.lastCount) {
          this.lastCount = n
          if (n > 0 && n <= 3) this.audio.cue('countdown')
        }
        // Armed by ever having BEEN in the countdown, not by the counter still
        // reading above zero.
        this.goArmed = true
      } else if (this.goArmed) {
        // THE GO HAD NEVER PLAYED. NOT ONCE.
        //
        // This used to be `else if (this.lastCount > 0)`, and `lastCount`
        // cannot be above zero by the time it is tested: `n` is
        // `ceil(countdown - 0.6)`, so it reaches 0 about six tenths of a second
        // BEFORE the phase changes, while still inside the branch above, and
        // sets lastCount to 0 on the way past. By the time the phase actually
        // flips, the guard is already false.
        //
        // Measured over a full race: `countdown` fired three times and
        // `countdownGo` fired zero. It was silent with the synth too -- this is
        // not something the sound pack broke, it is something the sound pack
        // made audible by making everything else louder.
        this.goArmed = false
        this.lastCount = 0
        this.audio.cue('countdownGo')
      }

      /**
       * THE AUDIO FRAME.
       *
       * Handed each racer's `events` -- the SAME lists the VFX read, holding
       * everything this render frame's sub-steps produced and nothing when no
       * step ran (src/game/eventCarry.ts). That is what stops audio from
       * losing events at 30fps, or hearing one twice at 144Hz.
       *
       * The listener is the camera, not the car. During the finish ceremony the
       * camera has left the chase rig entirely and is orbiting, and a listener
       * pinned to the car would put the crowd of engines in the wrong place for
       * the one shot the player is actually watching.
       */
      const cam = this.chase.camera
      _aFwd.set(0, 0, -1).applyQuaternion(cam.quaternion)
      _aUp.set(0, 1, 0).applyQuaternion(cam.quaternion)
      // Read `r.events`, which is where the carry published this frame's
      // events and is the same list the VFX pass reads a few lines further
      // down. Handing over the carry's own bank instead was wrong twice over:
      // it is drained by the publish before this line runs, so audio heard
      // nothing at all; and it is SPARSE, because its slots are only created
      // for racers that have had an event, so a hole for racer 0 reached the
      // planner's `for (const ev of events[i])` as undefined and threw every
      // frame. Rebuilt into a reused array rather than mapped, so this costs
      // no allocation in the render loop.
      this.audioEvents.length = st.racers.length
      for (let i = 0; i < st.racers.length; i++) this.audioEvents[i] = st.racers[i].events
      this.audio.race(
        st, this.audioEvents, this.localId,
        cam.position, _aFwd, _aUp, st.time,
        this.phase === 'racing' || this.phase === 'ceremony',
      )

      // The final-lap bed. Keyed off the local racer's lap so the swap lands
      // when the PLAYER starts their last lap, not when the leader does.
      // `RacerState.lap` counts laps COMPLETED (sim/race.ts sets it to
      // `lapsDone`), so the last lap begins at total - 1. This used to test
      // `lap >= total`, which is true only once the flag has fallen -- the
      // same off-by-one the lapFinal sting had in audio/plan.ts. It was
      // silent only because no track ships a `final` bed yet.
      if (this.phase === 'racing') {
        const lap = st.racers[this.localId]?.lap ?? 0
        if (lap !== this.lastMusicLap) {
          this.lastMusicLap = lap
          this.audio.music(this.track.def.id, lap >= (st.totalLaps ?? 3) - 1)
        }
      }
      // ONE TOGGLE, EVERY CONSUMER. `reduceMotion` here is the player's own
      // choice (settings panel) initialised from the OS preference, and it
      // already reaches the chase shake below and the crosswind debris. The
      // VFX pass used to read `prefers-reduced-motion` for itself, so a player
      // who turned the toggle ON with the OS preference OFF got a calm camera
      // and the full strobing effect set. Pushed every frame because it is one
      // property write and there is then no path by which the two can differ.
      if (this.vfx) {
        this.vfx.reduceMotion = this.reduceMotion
        // THE DRAWN FIELD, NOT THE SIMULATED ONE. The VFX read `st` alone, so
        // every effect bolted to a car was born where the SIM had the car --
        // up to one whole step ahead of the interpolated view the meshes and
        // this camera were placed from a few lines up. At 60 m/s that is a
        // metre (16 px at the exhaust, 13 m from the lens at 720p), different
        // every frame. The render racers' views are handed over so emitters
        // spawn on the car on screen; `st` still drives everything else. See
        // VfxSystem.drawn.
        this.vfx.drawn = this.renderRacers
      }
      this.vfx?.update(dt, st, this.chase.camera.position, this.localId)
      /**
       * THE NAME PLATES.
       *
       * AFTER the camera has been placed, and that is not a preference: a
       * plate is positioned entirely in screen space off a projection through
       * `chase.camera`, so running this before the rig had moved would put
       * every name one frame behind its car -- at 60 m/s, most of a car
       * length, which is precisely the error that makes a label look like it
       * belongs to the wrong vehicle.
       *
       * Handed the INTERPOLATED views rather than `st.racers`, for the same
       * reason the vehicle visuals get them: the sim steps at a fixed 60 Hz
       * and the display does not, so the cars on screen are between sim
       * frames and a plate anchored to the raw state would swim against the
       * car it is nailed to on any display that is not exactly in step.
       *
       * The viewport is passed in CSS pixels. Device pixel ratio and the
       * adaptive render scale both cancel inside the shader, which is why
       * neither has to be plumbed through here -- see nameplates.ts.
       *
       * Plates are drawn while the player is DRIVING and during the finish
       * ceremony (the field is still on the road and still worth identifying)
       * and never on the title screen's attract race, which has no roster and
       * no local player at all.
       */
      if (this.plates) {
        this.plates.reduceMotion = this.reduceMotion
        this.plateViews.length = this.renderRacers.length
        for (let i = 0; i < this.renderRacers.length; i++) {
          this.plateViews[i] = this.renderRacers[i].view
        }
        this.plates.update(
          dt, this.plateViews, this.chase.camera,
          this.sizedW > 0 ? this.sizedW : this.container.clientWidth,
          this.sizedH > 0 ? this.sizedH : this.container.clientHeight,
          this.phase === 'racing' || this.phase === 'ceremony' || this.phase === 'paused',
        )
      }
      this.trackVis?.update(dt, st.time)
      // THE CROSSWIND, HANDED OVER RATHER THAN DERIVED.
      //
      // `windPush` is the acceleration the sim actually applied to this racer
      // this frame — after the per-class scale and after the friction-budget
      // cap — and `right` is the road's own banked, gravity-aware lateral. The
      // environment recomputes neither; see CrosswindFrame in render/api.ts.
      //
      // The LIVE racer, not `localView`: the interpolated render copy is
      // rebuilt from a JSON clone taken at spawn and lags a frame, and the
      // wind is a force the player is fighting right now.
      this.wind.push = local.windPush
      const wsmp = this.track.at(local.splineS)
      this.wind.right.x = wsmp.right.x
      this.wind.right.y = wsmp.right.y
      this.wind.right.z = wsmp.right.z
      this.wind.reduceMotion = this.reduceMotion
      this.envVis?.update(dt, st.time, this.chase.camera.position, this.wind)
      // Callouts BEFORE the HUD, so the HUD knows whether this frame's drift
      // release has already been announced up in the sky band and can stand
      // its own centre-screen flash down. Driven from here rather than from
      // inside the HUD because it reads the LIVE racer, not the interpolated
      // view: `events` is a one-shot channel and the interpolated copy does
      // not carry it.
      // Only while the player is actually driving. Paused, in the ceremony or
      // on the results screen there is nothing to praise, and no sim step is
      // running to refresh what it would read.
      if (this.phase === 'racing') this.cheer.update(st, local, dt)
      this.hud.setDriftReleaseTaken(this.phase === 'racing' && this.cheer.tookDriftRelease)

      /**
       * SCORING.
       *
       * Fed from `local.events` -- the SAME list cheer.ts reads two lines above
       * and the VFX read below, which is the list main.ts wrote the accumulated
       * sub-step events back onto. Any other source loses events at low frame
       * rates, and a lost drift release here is not a missed sound, it is
       * missing points the player has no way to notice were dropped.
       *
       * The scorer takes its seconds from `st.time`, never from `dt`, so the
       * number is the same on every machine. See src/score/scorer.ts.
       *
       * Combo rungs are routed into cheer.ts rather than announced here, so the
       * praise, the voice line and the callout setting all stay in one place.
       */
      if (this.phase !== 'attract') {
        const sc = this.scorer.frame(st, local, local.events)
        for (const rung of sc.rungs) this.cheer.comboRung(rung)
        this.scoreHud.update(sc, dt)
        // AFTER frame(), so the finishing award is in. See onLocalFinish.
        if (this.captureScoreNextFrame) {
          this.captureScoreNextFrame = false
          this.lastScore = this.scorer.score
          this.lastBestCombo = this.scorer.bestCombo
          // And the counter stops here too, so the last number the player
          // watches is the number the results screen prints. It used to keep
          // chasing through the ceremony and land on a different total, which
          // reads as the game changing its mind about what the run was worth.
          this.scoreHud.settle(this.lastScore)
        }
      }
      // ACHIEVEMENTS: the mid-race chip. Cheap on the frames where nothing
      // moved, which is nearly all of them -- see AchievementRun.frame.
      if (this.phase === 'racing') this.ach.frame(st, this.scorer.bestCombo, this.liveContext)
      this.scoreHud.setVisible(this.phase === 'racing' || this.phase === 'ceremony')
      // The attract screen has no HUD -- it is display:none -- so updating it
      // would be laying out a lap counter and a minimap nobody can see, every
      // frame, on the device least able to spare it.
      if (this.phase !== 'attract') this.hud.update(st, this.localId, this.track, this.fps)

      // Neither impulse belongs to the finish shot: a camera shake and a
      // vertigo punch are both answers to something the PLAYER did, and during
      // the ceremony the car is under AI. The same argument retires both from
      // the attract shot, twice over -- there is no player there at all, and
      // the whole premise of the shot is that the camera is locked off.
      const impulsive = this.phase !== 'ceremony' && this.phase !== 'attract'
      if (impulsive && this.vfx && this.vfx.hitFlash > 0.4 && !this.reduceMotion) {
        this.chase.addShake(this.vfx.hitFlash * T.camera.shakeHit)
      }
      // Vertigo shot on a cashed-in drift. Consumed here, not in the camera:
      // the VFX pass owns the sim-frame guard, so the impulse fires exactly
      // once per release however fast the display refreshes.
      if (this.vfx && this.vfx.dollyRequest > 0) {
        if (impulsive) this.chase.addDolly(this.vfx.dollyRequest)
        this.vfx.dollyRequest = 0
      }

      const speed01 = clamp01(Math.hypot(local.vel.x, local.vel.z) / Math.max(1, topSpeed))
      // THE WARP IS THE CAMERA'S OWN IMPULSE, not a second thing derived from
      // the boost state -- which is what makes reduced motion reach the screen
      // effect: the rig zeroes its impulses under the toggle, so there is no
      // second suppression to forget.
      //
      // `warpLevel`, NOT `dollyLevel`. They are raised by the same events and
      // are separate numbers: the dolly moves the camera and opens the lens,
      // the warp grades the picture. Tying the screen to the camera's value is
      // what made calming the boost for motion comfort silently take two
      // thirds of the tunnel vision with it.
      /**
       * THE BLAST LENSES, PROJECTED.
       *
       * The composite works in screen space and the explosions happen in the
       * world, so the bridge is here: one project() per live front, at most
       * four of them, into the 0..1 UV space the pass reads.
       *
       * A front BEHIND the camera projects to a mirrored point that is still
       * on screen, which would put a lens in the middle of the frame for an
       * explosion the player cannot see -- so those are dropped rather than
       * clamped. The radius is taken as a fraction of frame WIDTH, measured by
       * projecting a second point one radius to the camera's right: doing it
       * by similar triangles instead needs the FOV, the aspect and the
       * distance, and gets the vertical wrong on every non-16:9 screen.
       */
      if (this.post) {
        const blasts = this.blastBuf
        blasts.length = 0
        const cam = this.chase.camera
        const src = this.vfx?.blasts
        if (src && src.length > 0 && !this.reduceMotion) {
          cam.updateMatrixWorld(true)
          cam.matrixWorld.extractBasis(_bR, _bU, _bF)
          for (let i = 0; i < src.length; i++) {
            const b = src[i]
            _bp.set(b.x, b.y, b.z).project(cam)
            if (_bp.z > 1) continue
            _be.set(b.x, b.y, b.z).addScaledVector(_bR, b.radius).project(cam)
            const rad = Math.abs(_be.x - _bp.x) * 0.5
            if (!(rad > 0.001)) continue
            blasts.push({
              x: _bp.x * 0.5 + 0.5,
              y: _bp.y * 0.5 + 0.5,
              radius: rad,
              // The player's speed-effect dial owns this the way it owns the
              // warp: one multiply, here, so "Speed effects: Off" is one rule
              // and not a list of exceptions.
              strength: b.strength * this.vfxScreen,
            })
          }
        }
        this.post.setBlasts(blasts)
        this.post.render(
          dt, this.vfx?.boostIntensity ?? 0, this.vfx?.hitFlash ?? 0, speed01,
          this.chase.warpLevel, this.reduceMotion,
        )
      }
      else this.renderer.render(this.scene, this.chase.camera)
    } else {
      this.renderer.render(this.scene, this.chase.camera)
    }
  }

  // -------------------------------------------------------------------------
  /**
   * KEEPING THE PICTURE THE RIGHT SHAPE.
   *
   * A perspective camera whose `aspect` matches the surface it renders to
   * cannot distort anything -- so every stretched frame is a frame where those
   * two disagreed, and the ONLY way they disagree is if the surface changed
   * and nothing told the camera.
   *
   * This used to be subscribed to `window.resize` alone, and on a phone that is
   * not enough. Rotating to landscape fires resize while the layout viewport is
   * still mid-transition, so the handler samples a size the page is about to
   * stop having; the URL bar sliding away resizes the visual viewport without
   * necessarily firing it again; and an element can change size for reasons the
   * window never hears about at all. Whatever the camera latched onto in that
   * moment then persists for the rest of the session, and the whole image is
   * scaled by the ratio between the two -- a portrait aspect held on a
   * landscape canvas stretches everything horizontally by nearly five times.
   * Reported from play, twice, as the car looking flattened.
   *
   * So the size is no longer something we are TOLD about. `syncSize` below is
   * called every frame and reconciles the three numbers that must agree; the
   * listeners are kept only so the correction lands on the same frame as the
   * change rather than the one after it.
   */
  private readonly onResize = (): void => { this.syncSize() }

  /** Last size actually pushed to the renderer, so the per-frame check is a
   *  pair of float compares and not a stream of redundant GL calls. */
  private sizedW = -1
  private sizedH = -1

  /**
   * Reconcile canvas size, renderer size and camera aspect. Cheap enough to run
   * unconditionally: two reads and two compares when nothing has moved, which
   * is every frame but the handful where something has.
   */
  private syncSize(): void {
    const w = this.container.clientWidth || window.innerWidth
    const h = this.container.clientHeight || window.innerHeight
    if (w <= 0 || h <= 0) return
    if (w === this.sizedW && h === this.sizedH) return
    this.sizedW = w
    this.sizedH = h
    this.renderer.setSize(w, h, false)
    this.applyRenderScale()
    this.chase.resize(w / h)
    this.post?.resize(w, h)
  }

  private readonly onVisibility = (): void => {
    // A backgrounded tab during the ceremony is not paused -- there is nothing
    // to pause, the player is not driving -- it is simply skipped to results,
    // so returning to the tab does not drop into a cinematic mid-shot.
    if (document.hidden && this.phase === 'racing') this.pause()
    else if (document.hidden && this.phase === 'ceremony') this.finishRace()
    // Same rule for the podium, and for the same reason: there is nothing to
    // pause, and coming back to the tab must not drop in mid-celebration.
    else if (document.hidden && this.phase === 'podium') this.endPodium()
    // The title race has no pause menu to raise, so it is gated on this flag
    // instead: the loop stops stepping and stops advancing the shot's clock,
    // and picks both up where they left off. Read here rather than calling
    // document.hidden per frame in the loop.
    this.docHidden = document.hidden
    // Eight live oscillators in a backgrounded tab is a battery complaint.
    this.audio.setHidden(document.hidden)
    this.lastTime = performance.now()
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('orientationchange', this.onResize)
    window.visualViewport?.removeEventListener('resize', this.onResize)
    this.resizeObs?.disconnect()
    this.resizeObs = null
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.audio.dispose()
    // The round's lockstep state, before the HUD it pushes status into is
    // disposed below. The MESH is the lobby's and goes with the lobby
    // service, which the front end owns and disposes a few lines down.
    this.net = null
    this.multiplayer = null
    this.closePodium()
    this.teardownWorld()
    disposeVehicleCache()
    this.cheer.dispose()
    this.scoreHud.dispose()
    this.hud.dispose()
    this.settings.dispose()
    this.compact.dispose()
    this.tools.remove()
    this.frontEnd.dispose()
    this.input.dispose()
    this.renderer.dispose()
  }
}

// ---------------------------------------------------------------------------
const TMP = new THREE.Vector3()

/** Place words for the podium card. Eight entrants, so eight is the end. */
const ORDINAL: readonly string[] = [
  '', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th',
]

function copyView(v: RacerState, r: RacerState): void {
  v.id = r.id; v.chassisId = r.chassisId; v.pilotId = r.pilotId
  v.vel.x = r.vel.x; v.vel.y = r.vel.y; v.vel.z = r.vel.z
  v.yawRate = r.yawRate; v.altitude = r.altitude; v.grounded = r.grounded
  v.driftSide = r.driftSide; v.driftCharge = r.driftCharge; v.driftTier = r.driftTier
  v.chainStacks = r.chainStacks
  v.boostTime = r.boostTime; v.boostMag = r.boostMag; v.boostSource = r.boostSource
  v.lift = r.lift; v.liftActive = r.liftActive; v.airTime = r.airTime
  v.spinTime = r.spinTime; v.stunTime = r.stunTime
  v.invincibleTime = r.invincibleTime; v.immuneTime = r.immuneTime
  v.slowTime = r.slowTime; v.respawnTime = r.respawnTime
  v.item = r.item; v.itemCharges = r.itemCharges
  v.lap = r.lap; v.position = r.position; v.charges = r.charges
  v.finished = r.finished; v.splineS = r.splineS; v.lateral = r.lateral
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}

function avg(a: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]
  return s / Math.max(1, a.length)
}

function percentile(a: number[], p: number): number {
  const c = a.slice().sort((x, y) => x - y)
  return c[Math.min(c.length - 1, Math.floor(c.length * p))]
}

/**
 * HAS THIS PROFILE EVER SEEN A COUNTDOWN? Answers, and records that it has.
 *
 * The rocket start is the one mechanic in the game a player cannot discover by
 * driving: its window is three and a half seconds long, it happens once a race,
 * and until this pass it produced no words, no sound and no light. So the first
 * countdown a profile ever sees carries one line of type telling them it is
 * there, and no countdown after that does.
 *
 * TWO GATES, AND THEY ARE NOT THE SAME GATE.
 *
 *   the stored flag   survives a reload, which is the actual claim being made
 *                     ("you have played before").
 *   `hintSpent`       a module-scope latch for THIS page load. It is what
 *                     makes the answer correct when storage is not available:
 *                     localStorage throws outright in a partitioned iframe and
 *                     in some private windows, and a player there is a genuine
 *                     first-timer every single session -- but they are not a
 *                     first-timer on their second race of one. Without the
 *                     latch the hint would come back on every restart, every
 *                     race, forever, for exactly the players least able to
 *                     turn it off.
 *
 * Every access is wrapped, and a throw falls through to SHOWING it. That is
 * the deliberate direction: the cost of showing a hint to someone who has seen
 * it is one quiet line for three seconds; the cost of hiding it from someone
 * who has not is the whole feature.
 */
const LS_SEEN_START = 'sg.seenStart'
let hintSpent = false

function takeStartHint(): boolean {
  if (hintSpent) return false
  hintSpent = true
  let seen = false
  try { seen = window.localStorage.getItem(LS_SEEN_START) === '1' } catch { /* blocked */ }
  if (seen) return false
  try { window.localStorage.setItem(LS_SEEN_START, '1') } catch { /* blocked */ }
  return true
}

/** Cheap device-class guess used only as a starting point; the adaptive
 *  scaler corrects it within a few seconds of real frame data. */
function detectTier(): QualityTier {
  const nav = navigator as Navigator & { deviceMemory?: number; hardwareConcurrency?: number }
  const coarse = matchMedia('(pointer: coarse)').matches
  const mem = nav.deviceMemory ?? 4
  const cores = nav.hardwareConcurrency ?? 4
  if (coarse && (mem <= 4 || cores <= 4)) return 'low'
  if (coarse) return 'medium'
  if (mem <= 4 || cores <= 4) return 'medium'
  return 'high'
}

export function boot(): Game {
  const container = document.getElementById('app') ?? document.body
  const game = new Game(container as HTMLElement)
  // Dismiss the boot overlay from here rather than from an inline script in
  // index.html: single-file bundling strips those, which would leave the
  // overlay permanently covering the game.
  const bootEl = document.getElementById('sg-boot')
  if (bootEl) {
    bootEl.classList.add('gone')
    setTimeout(() => bootEl.remove(), 600)
  }
  ;(window as unknown as { __GAME__: Game }).__GAME__ = game
  ;(window as unknown as { __TUNING__: typeof T }).__TUNING__ = T
  // For tools/probe-audio.mjs, which needs to know how many recorded sounds it
  // should be waiting for before it can tell "not loaded yet" from "silent".
  ;(window as unknown as { __CATALOGUE__: typeof CATALOGUE }).__CATALOGUE__ = CATALOGUE
  return game
}
