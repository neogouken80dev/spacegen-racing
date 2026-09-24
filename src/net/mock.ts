/**
 * SpaceGen Racing — THE MOCK BACKEND.
 * ---------------------------------------------------------------------------
 * `AccountService` and `LobbyService` from ./types.ts, implemented against
 * nothing at all: no fetch, no peer connection, no Netlify function. What is
 * here instead is a small simulated world -- a directory of lobbies with people
 * in them, a clock that keeps moving it, and a request layer that is slow,
 * jittery and occasionally broken on purpose.
 *
 * WHY IT IS BUILT THIS WAY AND NOT AS A TABLE OF LOBBIES
 *
 * types.ts already argues the case ("THE MOCK IS NOT A STUB") and this file is
 * the payment on it. Every bug a lobby browser actually has is a TIMING bug:
 *
 *   - a list that flickers because two refreshes landed out of order;
 *   - a Ready button that shows the new state before the server agreed;
 *   - a row whose ping arrives after the row was re-sorted;
 *   - a room screen that renders the member list once and never again;
 *   - a modal for a lobby that closed while the modal was opening.
 *
 * None of those can happen against a static array, so against a static array
 * the UI looks finished and ships broken. Everything below exists to make them
 * happen on a laptop, in a probe, today:
 *
 *   LATENCY      every call resolves on a timer, and the timer is drawn from a
 *                bimodal distribution rather than a constant -- see LATENCY.
 *   FAILURE      a small share of calls come back `{ ok: false }`, so the error
 *                path is something you have SEEN rather than something you
 *                believe you wrote.
 *   A LIVE WORLD one interval mutates the directory and every room in it:
 *                people join, ready up, change cars, drop, hosts leave, full
 *                lobbies start racing, finished ones reopen or close, new ones
 *                appear, dead ones expire.
 *   LATE PINGS   `pingMs` starts null for every row, resolves a beat later at
 *                staggered times, and for about one host in six never resolves
 *                at all. Null is a state the UI has to render, so it has to be
 *                a state the UI actually sees.
 *
 * THE COST OF ALL THAT IS DETERMINISM, AND IT IS PAID BACK WITH A SEED.
 *
 * Every random decision here draws from one `Rng` (sim/rng.ts, the same
 * mulberry32 the race uses), seeded from options. A test fixes the seed, sets
 * `failureRate: 0`, fixes the latency, and gets the same world every run. A
 * probe leaves the defaults alone and gets a world that misbehaves.
 *
 * WHAT IS DELIBERATELY NOT SIMULATED is listed at the bottom of this file.
 */
import {
  LOBBY_MAX_PLAYERS, LOBBY_MIN_PLAYERS, NAME_RULES, REGIONS, SERIES_LENGTHS,
  type AccountService, type AchievementSync, type CreateLobbyOptions, type JoinError, type LobbyFilter,
  type LobbyMember, type LobbyRoom, type LobbyService, type LobbyStatus,
  type LobbySummary, type MultiplayerSlot, type NameError, type PlayerProfile,
  type RaceStartPacket, type RaceTransport, type RegionId, type Result,
  type SeriesLength, type SeriesPlan, type SeriesStanding,
} from './types'
import { Rng } from '../sim/rng'
import {
  AVATARS, AVATAR_BY_ID, DEFAULT_AVATAR_ID, PRICES, STARTER_IDS,
  featsFromProfile, ownsAvatar, priceOf, ranksEarned,
} from '../content/avatars'
import {
  asSnapshot, emptySnapshot, featsFromUnlocks, mergeSnapshots, withDerived,
  type AchievementSnapshot,
} from '../content/achievements'
import { CHASSIS } from '../content/chassis'
import { PILOTS, PILOTS_BY_ID } from '../content/pilots'
import { TRACKS } from '../content/tracks/index'
import { asDifficulty, skillForSlot, type Difficulty } from '../content/difficulty'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
//
// WHAT THESE NUMBERS ACTUALLY PRODUCE, MEASURED
//
// Taken from seeded runs on fake timers while the numbers below were being
// picked, so that "the mock moves" is a figure rather than an opinion. Re-run
// them by instrumenting the equivalent tests in tests/net.test.ts.
//
//   REORDERING    24 list() calls issued back to back returned in an order with
//                 126 inversions out of 276 pairs. Responses overtake each
//                 other constantly, which is the point of the fat tail.
//   THE DIRECTORY 19 polls one tick apart over 30s: 18 of them differed from
//                 the poll before. A player browsing for half a minute sees
//                 the list change under them about every 1.6 seconds.
//   STATUS        over 3 minutes of ticks, row-observations were 899 open,
//                 278 full, 169 racing, 149 closed -- all four states occur
//                 often enough to be photographed without waiting for them.
//   TURNOVER      over the same 3 minutes, 51 lobbies appeared and 37 went
//                 away, with the directory size steady between 11 and 18.
//   ROOM LIFE     40 ticks across the whole directory: 123 ready-ups, 86
//                 loadout swaps, 50 connections completing, 26 links dropping
//                 back to connecting, 42 arrivals, 78 departures.
//   PING          18 rows: 0 known at first list, 6 known at 1.2s, 17 at 5.2s,
//                 and 1 never. The ragged middle is the state a sorted list
//                 has to survive.

/**
 * The shape of a simulated round trip, in milliseconds.
 *
 * TWO MODES, NOT ONE RANGE. A constant latency is useless -- every response
 * arrives in issue order and nothing ever overtakes anything -- but a flat
 * uniform range is barely better, because with a narrow spread the reordering
 * is rare and with a wide one every request feels broken. Real request timing
 * is a tight mode with a fat tail, so that is what this is: most calls land in
 * `fast`, and `slowShare` of them fall into `slow` instead.
 *
 * The numbers: 110-260ms is a plausible mobile-network round trip to a
 * serverless function that has to touch a blob store, and one call in eight
 * taking 420-1100ms is a cold start or a bad handover. That tail is the whole
 * point -- it is what makes refresh N+1 beat refresh N back to the UI, which is
 * the single most common lobby-browser bug and is invisible without it.
 */
export const LATENCY = {
  fastMin: 110,
  fastMax: 260,
  slowShare: 0.12,
  slowMin: 420,
  slowMax: 1100,
} as const

/**
 * Share of calls that come back as a failure.
 *
 * 6% is roughly one failure every sixteen requests: often enough that a person
 * clicking around a screen for a minute will meet it, rare enough that the
 * screen is still usable to develop against. Set it to 0 in a test, and in the
 * `perfect` profile that net/index.ts exposes for screenshots.
 */
export const FAILURE_RATE = 0.06

/**
 * How often the world moves, in milliseconds.
 *
 * The brief is that a player browsing for thirty seconds sees the list change
 * under them. At 1600ms that is ~19 ticks, and with the per-lobby chances below
 * a typical thirty seconds contains a dozen or so visible changes across the
 * directory -- several rows changing player count, one lobby filling, one going
 * racing, one appearing. Faster than this and the list is a slot machine you
 * cannot read; slower and a probe that grabs two screenshots ten seconds apart
 * can honestly get the same picture twice.
 */
export const TICK_MS = 1600

/** Directory size bounds. Eight regions with a couple of rows each is a browser
 *  worth filtering; more than this and the seeded list stops being readable in
 *  a screenshot, which is what it is for. */
const LOBBY_MIN = 11
const LOBBY_MAX = 18

/**
 * A closed lobby stays listed this long.
 *
 * types.ts asks for "one refresh" so the row can say the host went away instead
 * of vanishing under the cursor. One refresh is not expressible here -- there
 * can be more than one browser attached and neither owns the other's refresh
 * clock -- so it is a duration instead, and 6s is about two refreshes at the 3s
 * poll a browser screen should be using, which leaves one to show it and one
 * for the player to notice it.
 */
const CLOSED_LINGER_MS = 6000

/** An open lobby nobody is in expires after this. Ninety seconds is long enough
 *  that it is not visibly a cull and short enough to be seen during a probe. */
const STALE_MS = 90_000

/**
 * How long a mocked race takes, milliseconds.
 *
 * A REAL five-lap race is nearer three minutes and this is deliberately not
 * that. The `racing` status exists so a browser can show a greyed row that
 * later comes back -- and nobody is going to sit in front of the lobby list for
 * three minutes to confirm that it does. 40-90s makes the whole open -> full ->
 * racing -> open cycle observable inside one session.
 */
const RACE_MIN_MS = 40_000
const RACE_MAX_MS = 90_000

/** A finished race reopens its lobby this often; otherwise everyone goes home. */
const REOPEN_SHARE = 0.65

/**
 * Per-tick probabilities for the people in a lobby.
 *
 * These are per lobby per tick, so multiply by ~1.6s to read them as rates. A
 * bot readies at 0.30/tick, which is a mean of about five seconds of thinking
 * about it -- long enough that the room screen shows an unready row for a while
 * (the state that has to be renderable) and short enough that a room fills with
 * green ticks while you watch.
 */
const P = {
  /** Somebody new turns up in a lobby with space. */
  join: 0.22,
  /** Somebody wanders off. */
  leave: 0.05,
  /** An unready member readies up. */
  ready: 0.30,
  /** A ready member changes their mind (usually just before you press Start). */
  unready: 0.05,
  /** A member swaps chassis or pilot -- which clears their own ready, for the
   *  same reason changing the track clears everyone's. */
  loadout: 0.10,
  /** A connected member's link hiccups back to `connecting`. */
  drop: 0.03,
  /** A `connecting` member finishes connecting. Mean ~2 ticks, which is about
   *  what ICE takes when it works at all. */
  connect: 0.55,
  /** The host abandons the lobby, which closes it for everyone in it. */
  hostLeaves: 0.03,
  /** A bot host kicks the local player. Rare on purpose: it is an unpleasant
   *  surprise, and it exists only so `onClosed('kicked')` is reachable. */
  kickLocal: 0.008,
  /** A new lobby is advertised. */
  spawn: 0.25,
} as const

/**
 * Ping probe timing, milliseconds after a row is first seen in a list.
 *
 * STAGGERED, BECAUSE THEY ARE SEPARATE PROBES. A list of twelve rows is twelve
 * independent round trips to twelve different hosts; they do not land together
 * and they do not land in list order. The base delay is "a beat after the list"
 * and the spread is what makes rows fill in raggedly, which is the behaviour
 * the browser's sort has to survive.
 */
const PING_MIN_MS = 350
const PING_MAX_MS = 2600

/**
 * Share of hosts whose ping never resolves.
 *
 * Not an arbitrary number: types.ts records that "somewhere between a tenth and
 * a fifth of connections will not traverse NAT without a TURN relay". A host
 * you cannot reach is a host you cannot time, so the permanently-null share is
 * that same population. 1 in 6 sits in the middle of the band.
 */
const UNPINGABLE_SHARE = 1 / 6

/** Plausible round trips to a host, once one resolves. Local-ish to far. */
const PING_LO = 14
const PING_HI = 240

/**
 * Cars on the grid.
 *
 * `CIRCUIT_GRID` in game/circuit.ts and `RACER_COUNT` in game/main.ts are the
 * same 8, and this is deliberately another copy rather than an import: net/
 * must not depend on game/.
 *
 * IT IS NOT THE SAME NUMBER AS `LOBBY_MAX_PLAYERS`, even though both are 8.
 * That one is how many PEOPLE a lobby may hold; this is how many CARS start,
 * people and AI together. They are equal today and the contract's cap is sized
 * from this one, but the relation that actually matters is `GRID_SIZE >=
 * LOBBY_MAX_PLAYERS` -- break it and `buildPacket` silently leaves the last
 * arrivals off the grid, which tests/net.test.ts asserts against.
 */
export const GRID_SIZE = 8

/** localStorage key for the device's account. Namespaced like every other
 *  key in the project (`sg.circuit`, `sg.records`, `sg.name`). */
const LS_ACCOUNT = 'sg.account'
/** Shape version of that payload. Bumped when the SHAPE changes; content that
 *  no longer exists (an avatar id) is filtered on the way in instead. */
const LS_VERSION = 1
/** The name the player already typed for the leaderboard, if they did. Owned
 *  by ui/frontend.ts; read here, never written, so a returning player's first
 *  multiplayer profile is already called what their lap times are called. */
const LS_LEGACY_NAME = 'sg.name'

// ---------------------------------------------------------------------------
// Storage — every access wrapped, twice
// ---------------------------------------------------------------------------

/**
 * The two-method slice of Storage this module needs.
 *
 * An interface rather than `Storage` so a test can hand in a Map and so the
 * "storage throws" case can be built rather than waited for.
 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
}

/**
 * The device's storage, or null if there is not one.
 *
 * EVERY ACCESS IS WRAPPED, AND SO IS THE LOOKUP ITSELF. In a partitioned
 * iframe, a private window and several embedded webviews, `localStorage` throws
 * on the PROPERTY ACCESS -- before any method is called -- and in some of those
 * it then throws again on getItem and setItem individually. game/circuit.ts,
 * ui/settings.ts and game/input.ts all carry the same note and the same double
 * guard. A multiplayer profile that takes the game down in a private window is
 * strictly worse than one that does not persist.
 *
 * `globalThis` rather than `window` so this module is usable from a test and a
 * worker, where `window` is a ReferenceError rather than undefined.
 */
function deviceStorage(): StorageLike | null {
  try {
    const s = (globalThis as { localStorage?: StorageLike }).localStorage
    return s ?? null
  } catch {
    return null
  }
}

function readKey(store: StorageLike | null, key: string): string | null {
  if (!store) return null
  try {
    return store.getItem(key)
  } catch {
    return null
  }
}

function writeKey(store: StorageLike | null, key: string, value: string): boolean {
  if (!store) return false
  try {
    store.setItem(key, value)
    return true
  } catch {
    // Quota, private mode, partitioned storage. The profile still works for
    // this session; it simply will not be there next time.
    return false
  }
}

// ---------------------------------------------------------------------------
// Avatars
// ---------------------------------------------------------------------------
//
// THE ROSTER IS src/content/avatars.ts AND NOTHING IS DUPLICATED HERE. This
// module used to carry a stand-in list because that file did not exist; it does
// now, with twenty-four avatars, four sources and the ownership rules that go
// with them, so the mock reads it and never second-guesses it.
//
// The one rule worth restating where the profile is written: OWNERSHIP IS
// DERIVED WHERE IT CAN BE (`ownsAvatar`). A starter is owned always, a rank is
// owned whenever lifetime `earned` clears the threshold whether or not a flag
// was ever written, and two feats are implied by the profile's own counters.
// So the mock asks `ownsAvatar` rather than looking in `unlocked`, and
// materialises the derivable ones into `unlocked` as a convenience rather than
// as the source of truth -- which is exactly the licence avatars.ts grants.

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * `NAME_RULES`, applied in the order the player will understand.
 *
 * Length before charset, because "too short" is a more useful thing to be told
 * about "a" than "that character is not allowed" -- which is what the pattern
 * would say, since a one-character name fails the pattern too (it demands an
 * alphanumeric at each end and "a" has only one end).
 *
 * Returns null when the name is shaped correctly. 'taken' and 'offline' are not
 * decided here: they need the directory and the connection, respectively.
 */
export function checkNameShape(name: string): NameError | null {
  if (name.length < NAME_RULES.min) return 'short'
  if (name.length > NAME_RULES.max) return 'long'
  if (!NAME_RULES.pattern.test(name)) return 'charset'
  return null
}

/** Names are claimed case-insensitively: two players called `Nova` and `nova`
 *  in one race is a nameplate bug wearing a uniqueness constraint. */
const nameKey = (name: string): string => name.trim().toLowerCase()

/**
 * A four-character join code.
 *
 * No O/0 and no I/1 in the alphabet: this is read off one screen and typed into
 * another, usually over voice chat, and those two pairs are where that goes
 * wrong. Four characters of a 32-symbol alphabet is a million codes, which is
 * ample for a directory that holds eighteen lobbies.
 */
function joinCode(rng: Rng): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < 4; i++) out += alphabet[rng.int(alphabet.length)]
  return out
}

// ---------------------------------------------------------------------------
// The roster the mock draws people and cars from
// ---------------------------------------------------------------------------

/**
 * Names for the people already in the directory.
 *
 * All of them satisfy NAME_RULES -- which is not decoration. These names go
 * into the claimed set, so the first thing a player tries after seeing the
 * lobby list ("I'll be Kestrel too") hits the 'taken' path, which is exactly
 * where you want that path to be met for the first time.
 */
const BOT_NAMES: readonly string[] = [
  'Kestrel', 'ORBITBURN', 'nova_kid', 'Halcyon.9', 'Tsu', 'RedVector',
  'mag-lev', 'Quasar', 'Bit Rot', 'PILGRIM', 'Vantablack', 'sunny d',
  'Auster', 'Mirror Ion', 'Deepwell', 'gravwell', 'NINE LIVES', 'Ohm',
  'Static', 'Cinder', 'lowkey', 'Ptarmigan', 'SEVEN', 'dust.mote',
]

/** Extra names nobody in the directory is using, so 'taken' is reachable even
 *  against a directory that has churned everybody out. */
const RESERVED_NAMES: readonly string[] = ['SpaceGen', 'Admin', 'Racer']

const LOBBY_NAMES: readonly string[] = [
  'Sunday sprint', 'chill laps', 'ranked-ish', 'Drift school', 'first to 3',
  'Clean racing only', 'The usual', 'Late night grid', 'noobs welcome',
  'Hotlap club', 'Bring your best', 'no items', 'Cryo cup qualifier',
  'Rustfall runs', 'Deep dive', 'PRO LOBBY', '5 lap dash', 'Rookie room',
]

const TRACK_IDS: readonly string[] = TRACKS.map((t) => t.id)

/**
 * The circuit a lobby is on RIGHT NOW.
 *
 * Clamped rather than allowed to run off the end, because `round` legitimately
 * reaches `series.length` the moment the last round is banked -- a series that
 * is over still has to render a row, a room and a results screen, and all three
 * want the circuit that was just raced rather than `undefined`.
 *
 * net/live.ts computes the same expression at its own two call sites. Kept in
 * step deliberately: the two implementations of one contract agreeing about
 * which track a lobby is on is not optional.
 */
function curTrack(lb: MockLobby): string {
  const ids = lb.series.trackIds
  return ids[Math.max(0, Math.min(lb.round, ids.length - 1))] ?? TRACK_IDS[0]
}

/** True once every round has been raced. */
function seriesOver(lb: MockLobby): boolean {
  return lb.round >= lb.series.length
}

/**
 * A `SeriesPlan` the rest of this file can trust, from one a caller supplied.
 *
 * EVERY FIELD IS UNTRUSTED. `create()` takes this straight off a UI that a
 * probe, a test or a future screen can all drive, and three of the four things
 * that can be wrong with a plan are silent rather than loud: a length that is
 * not one of the four produces a series that never ends, a track id this build
 * does not have produces a round that cannot start, and a repeat produces a
 * "series" that is the same circuit twice. The fourth -- too few circuits for
 * the length -- is the one the contract calls out ("Exactly `length` of them,
 * no repeats"), and it is filled from the roster rather than refused, because a
 * short list is a caller being lazy and not a caller being wrong.
 */
function cleanSeries(p: SeriesPlan | undefined): SeriesPlan {
  const length: SeriesLength = SERIES_LENGTHS.includes(p?.length as SeriesLength)
    ? (p!.length as SeriesLength)
    : 1
  const ids: string[] = []
  for (const id of p?.trackIds ?? []) {
    if (ids.length >= length) break
    if (TRACK_IDS.includes(id) && !ids.includes(id)) ids.push(id)
  }
  for (const id of TRACK_IDS) {
    if (ids.length >= length) break
    if (!ids.includes(id)) ids.push(id)
  }
  return {
    length,
    trackIds: ids,
    laps: Math.max(1, Math.min(20, Math.floor(p?.laps ?? 3) || 3)),
    difficulty: asDifficulty(p?.difficulty),
  }
}

const CHASSIS_IDS: readonly string[] = CHASSIS.map((c) => c.id)
const PILOT_IDS: readonly string[] = PILOTS.map((p) => p.id)
const REGION_IDS: readonly RegionId[] = REGIONS.map((r) => r.id)

/**
 * The AI that fills empty grid slots.
 *
 * DELIBERATELY THE SAME SEVEN PAIRS AS CIRCUIT MODE (game/circuit.ts,
 * `OPPONENTS`), copied rather than imported because net/ must not depend on
 * game/. Its reasoning holds here too: all five chassis appear, every
 * locomotion class is represented, and the one repeated pilot is repeated on
 * two different cars. A three-human multiplayer race then feels like the same
 * game as a circuit round rather than like a lobby with strangers in it.
 *
 * The NAME is the pilot's, per the contract ("the AI's roster name"), with a
 * numeral where a pilot appears twice -- two cars both labelled ZEPHYR is
 * illegible at 60 m/s, which is the only speed the nameplate is read at.
 */
const AI_ROSTER: readonly { pilotId: string; chassisId: string }[] = [
  { pilotId: 'vanguard', chassisId: 'vector7' },
  { pilotId: 'aegis', chassisId: 'bulwark' },
  { pilotId: 'zephyr', chassisId: 'filament' },
  { pilotId: 'triage', chassisId: 'dray9' },
  { pilotId: 'koan', chassisId: 'solaire' },
  { pilotId: 'socket', chassisId: 'bulwark' },
  { pilotId: 'zephyr', chassisId: 'dray9' },
]

function aiName(index: number): string {
  const entry = AI_ROSTER[index % AI_ROSTER.length]
  const base = PILOTS_BY_ID[entry.pilotId]?.name ?? entry.pilotId.toUpperCase()
  // How many earlier entries used this same pilot; 0 for the first.
  let repeat = 0
  for (let i = 0; i < index % AI_ROSTER.length; i++) {
    if (AI_ROSTER[i].pilotId === entry.pilotId) repeat++
  }
  return repeat === 0 ? base : `${base} ${'I'.repeat(repeat + 1)}`
}

// ---------------------------------------------------------------------------
// Input delay
// ---------------------------------------------------------------------------

/**
 * Frames of lockstep input delay for a room whose worst round trip is this.
 *
 * THE ARITHMETIC. The sim steps at 60Hz (`TUNING.sim.dt` is 1/60), so a frame
 * is 16.67ms. Lockstep needs a peer's input for frame N to have ARRIVED by the
 * time frame N is stepped, so the delay has to cover one-way latency -- half
 * the round trip -- plus a frame of slack for jitter and for the fact that an
 * input is sampled at an arbitrary point inside a frame rather than at its
 * start.
 *
 *     delay = ceil((worstPing / 2) / 16.67) + 1
 *
 * What that gives, and why the numbers are defensible:
 *
 *     worst ping   delay   added input lag
 *        30ms        2       33ms    a room in one city: imperceptible
 *        80ms        4       67ms    one time zone: the car still feels tied on
 *       160ms        6      100ms    transatlantic: noticeably soft, playable
 *       300ms       10      167ms    the edge of worth doing
 *
 * FLOOR OF 2. Never zero, even on a LAN: at 0 a single late packet stalls every
 * client, and 33ms of lag is cheaper than a stutter. CEILING OF 12 (200ms). Past
 * that the car is detached from the stick and more delay does not rescue the
 * race, it just makes the same race worse -- a room that needs more than this
 * should be told it is a bad room rather than handed 300ms of lag.
 *
 * AN UNKNOWN PING IS TREATED AS BAD, NOT AS ZERO. A peer whose probe never
 * resolved (the null state) is far more likely to be far away or behind a relay
 * than to be next door, and guessing low here is the one error that produces a
 * visibly broken race rather than a soft one.
 */
export const UNKNOWN_PING_MS = 220

export function inputDelayFor(worstPingMs: number | null): number {
  const ping = worstPingMs == null || !Number.isFinite(worstPingMs) || worstPingMs < 0
    ? UNKNOWN_PING_MS
    : worstPingMs
  const frameMs = 1000 / 60
  const frames = Math.ceil((ping / 2) / frameMs) + 1
  return Math.max(2, Math.min(12, frames))
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

interface MockMember extends LobbyMember {
  /** False for a real attached client (the local player, or a second service
   *  in a test). The world never puppets those. */
  bot: boolean
  joinedAt: number
}

export interface MockLobby {
  id: string
  name: string
  hostId: string
  region: RegionId
  maxPlayers: number
  private: boolean
  joinCode: string | null
  /**
   * THE SERIES, WHICH IS WHERE `trackId` AND `laps` WENT.
   *
   * A lobby no longer has a circuit, it has a running order, and the circuit is
   * whichever one `round` points at -- see `curTrack`. A single race is a
   * series of length 1 and takes the identical path, which is the whole point
   * of the contract modelling it that way: there is one set of fields to fill
   * in and one set to read, not two.
   */
  series: SeriesPlan
  /** Rounds already finished. 0 before the first race, `series.length` when it
   *  is over. Matches `LobbyRoom.round` exactly. */
  round: number
  /**
   * The table, as last banked by `endRound`.
   *
   * STORED, NEVER COMPUTED. Totalling a round means the points table, the
   * countback and the tie-break, all of which game/circuit.ts already owns --
   * and net/ must not depend on game/ (see GRID_SIZE above for the same rule
   * biting the same way). The client that just raced the round is the one with
   * the finishing order in hand, so it does the arithmetic and hands the answer
   * down. net/live.ts does exactly the same thing with exactly the same
   * reasoning, so the mock and the real service behave identically here.
   */
  standings: SeriesStanding[]
  status: LobbyStatus
  members: MockMember[]
  createdAt: number
  /** When it went `closed`; it is dropped CLOSED_LINGER_MS later. */
  closedAt: number
  /** When a `racing` lobby's race ends. */
  raceEndsAt: number
  /** The local browser's ping probe against this host. See PING_MIN_MS. */
  probe: { dueAt: number; ms: number | null; never: boolean }
}

/** What an attached service wants to be told about. */
export interface Client {
  playerId: string
  onRoom(room: LobbyRoom | null): void
  onStart(packet: RaceStartPacket): void
  onClosed(reason: 'hostLeft' | 'kicked' | 'error'): void
}

export interface MockWorldOptions {
  seed?: number
  /** Leave the clock stopped, so a test can call `tick()` by hand. */
  autoTick?: boolean
}

/**
 * The simulated backend.
 *
 * ONE WORLD, SHARED BY BOTH SERVICES, and that is the whole reason it is a
 * separate object rather than state inside `createMockLobbyService`. The
 * account service writes the local identity into it and the lobby service reads
 * it, so the name you claimed on the profile screen is the name on your row in
 * the room -- with no wiring between the two services, which the real backend
 * will not have either (there it is one account id in a database).
 *
 * It is also what makes a two-service test possible: attach two lobby services
 * to one world and one really can host a room the other really joins, so "the
 * host left and the room closed for everybody else" is a thing that happens
 * rather than a thing that is asserted about a mock's internals.
 */
export interface MockWorld {
  readonly rng: Rng
  /** Advance the world one tick. Called by the interval; exported for tests. */
  tick(): void
  /** Milliseconds now. `Date.now` so vitest's fake timers move it too. */
  now(): number
  attach(client: Client): void
  detach(client: Client): void
  dispose(): void

  // --- internals the two services use; not part of any shipped contract.
  readonly lobbies: Map<string, MockLobby>
  readonly claimed: Set<string>
  readonly accounts: Map<string, PlayerProfile>
  readonly local: { id: string; name: string; avatarId: string }
  setLocalIdentity(p: PlayerProfile): void
  nextId(prefix: string): string
  chance(p: number): boolean
  between(lo: number, hi: number): number
  closeLobby(lb: MockLobby, reason: 'hostLeft' | 'error'): void
  pushRoom(lb: MockLobby): void
  snapshot(lb: MockLobby, forPlayerId: string): LobbyRoom
  summary(lb: MockLobby): LobbySummary
  buildPacket(lb: MockLobby, seed: number): RaceStartPacket
  /** Publish the one start packet to every attached client in this lobby,
   *  stamped with each reader's own id. Returns the body it sent. */
  notifyStart(lb: MockLobby, seed: number): RaceStartPacket
  /** Tell one attached client it was thrown out. */
  notifyKicked(playerId: string): void
  startRace(lb: MockLobby): RaceStartPacket | null
}

export function createMockWorld(opts: MockWorldOptions = {}): MockWorld {
  const rng = new Rng(opts.seed ?? 0x5ace9e2)
  const lobbies = new Map<string, MockLobby>()
  const claimed = new Set<string>()
  const accounts = new Map<string, PlayerProfile>()
  const clients = new Set<Client>()
  let counter = 0
  let timer: ReturnType<typeof setInterval> | null = null
  const autoTick = opts.autoTick !== false

  const now = (): number => Date.now()
  const nextId = (prefix: string): string => `${prefix}${++counter}`
  const chance = (p: number): boolean => rng.next() < p
  const between = (lo: number, hi: number): number => rng.range(lo, hi)
  const pickOne = <T,>(arr: readonly T[]): T => arr[rng.int(arr.length)]

  /**
   * The local player, as the world knows them.
   *
   * Seeded with a provisional id because the lobby service can be used before
   * the account service has finished loading -- the browser screen does not
   * wait for the profile. `setLocalIdentity` rewrites it, and rewrites any row
   * already sitting in a lobby, so that ordering cannot leave a stale id in a
   * member list.
   */
  const local = { id: 'p-local', name: 'Racer', avatarId: DEFAULT_AVATAR_ID }

  for (const n of BOT_NAMES) claimed.add(nameKey(n))
  for (const n of RESERVED_NAMES) claimed.add(nameKey(n))

  function freeName(): string {
    // Names in the directory must be unique or two rows in one room are called
    // the same thing. Walk the pool for one nobody is using; fall back to a
    // numbered name, which is what a real service would do too.
    const used = new Set<string>()
    for (const lb of lobbies.values()) for (const m of lb.members) used.add(nameKey(m.name))
    const free = BOT_NAMES.filter((n) => !used.has(nameKey(n)))
    if (free.length > 0) return pickOne(free)
    return `Racer ${1000 + rng.int(9000)}`
  }

  function makeBot(host: boolean, at: number): MockMember {
    return {
      playerId: nextId('p-'),
      name: freeName(),
      avatarId: pickOne(AVATARS).id,
      chassisId: pickOne(CHASSIS_IDS),
      pilotId: pickOne(PILOT_IDS),
      ready: host ? chance(0.5) : chance(0.35),
      isHost: host,
      // The host's own row is always 0 (it is the reference point), and about
      // one member in six has no measurable ping for the same NAT reason the
      // directory's probes fail.
      pingMs: host ? 0 : chance(UNPINGABLE_SHARE) ? null : Math.round(between(PING_LO, PING_HI)),
      connecting: host ? false : chance(0.25),
      bot: true,
      joinedAt: at,
    }
  }

  /** See the note at the point of use. Three Normals to one of each other. */
  const DIFFICULTY_MIX: readonly Difficulty[] =
    ['normal', 'easy', 'normal', 'hard', 'normal', 'expert']
  /** The digits out of an id like `lb-14`, so the mix walks rather than
   *  clumping. Non-numeric ids fall back to 0, which is Normal. */
  const idNumber = (id: string): number => {
    const n = Number(id.replace(/^\D+/, ''))
    return Number.isFinite(n) ? Math.abs(Math.floor(n)) : 0
  }

  function makeLobby(at: number, seeded: boolean): MockLobby {
    const id = nextId('lb-')
    const maxPlayers = pickOne([4, 6, 8, 8])
    const isPrivate = chance(0.18)
    const host = makeBot(true, at)
    const lb: MockLobby = {
      id,
      name: pickOne(LOBBY_NAMES),
      hostId: host.playerId,
      region: pickOne(REGION_IDS),
      maxPlayers,
      private: isPrivate,
      joinCode: isPrivate ? joinCode(rng) : null,
      // MOST LOBBIES IN THE DIRECTORY ARE SINGLE RACES, and a minority are
      // series -- which is both what a real directory would look like and what
      // the browser needs to be photographed against. A list where every row
      // says "Round 1 of 3" would never show the single-race row, and that row
      // is the one the contract insists must read as an ordinary race.
      series: cleanSeries({
        length: pickOne([1, 1, 1, 3, 3, 5, 8] as const),
        trackIds: [pickOne(TRACK_IDS)],
        laps: pickOne([3, 3, 5, 5, 7]),
        // WEIGHTED TOWARD NORMAL, AND DRAWN WITHOUT TOUCHING THE RNG.
        //
        // A browser full of Expert rooms looks like a different game from the
        // one the player just came from, so the mix is three Normals to one
        // of everything else. It is indexed off the lobby id rather than
        // `pickOne` for a reason that cost a test: this world is a FIXTURE,
        // seeded, and a dozen screenshots and `net.test.ts` depend on what
        // seed 707 produces. One extra draw inside this loop shifted every
        // subsequent value and a test asserting "about one host in six never
        // answers a ping" found none at all. A generator that other things
        // are pinned against is append-only in its RNG calls, not in its
        // fields.
        difficulty: DIFFICULTY_MIX[idNumber(id) % DIFFICULTY_MIX.length],
      }),
      round: 0,
      standings: [],
      status: 'open',
      members: [host],
      createdAt: at,
      closedAt: 0,
      raceEndsAt: 0,
      probe: {
        // Scheduled on first sight rather than now, so a lobby that appears
        // while you are browsing gets the same "a beat later" treatment as the
        // ones that were there when you arrived. 0 means "not scheduled yet".
        dueAt: 0,
        ms: null,
        never: chance(UNPINGABLE_SHARE),
      },
    }
    // A seeded lobby arrives with a history: people are already in it. A lobby
    // that SPAWNS during play starts with just its host, because that is what
    // advertising a new lobby looks like.
    const extra = seeded ? rng.int(maxPlayers) : 0
    for (let i = 0; i < extra; i++) lb.members.push(makeBot(false, at))
    lb.status = lb.members.length >= maxPlayers ? 'full' : 'open'
    // A SEEDED SERIES IS PART-WAY THROUGH. The directory a player walks into
    // should not look like it was created a moment ago, and "Round 3 of 5" on
    // a row is a thing the browser has to render and therefore a thing the
    // world has to produce. Never the last round: a lobby whose series is over
    // is a lobby that is about to close, which is a different row.
    if (seeded && lb.series.length > 1) lb.round = rng.int(lb.series.length - 1)
    if (seeded && lb.status === 'full' && chance(0.5)) {
      lb.status = 'racing'
      lb.raceEndsAt = at + between(RACE_MIN_MS, RACE_MAX_MS)
    }
    lobbies.set(id, lb)
    return lb
  }

  function clientsIn(lb: MockLobby): Client[] {
    const out: Client[] = []
    for (const c of clients) {
      if (lb.members.some((m) => m.playerId === c.playerId)) out.push(c)
    }
    return out
  }

  /**
   * Every push is a fresh snapshot with fresh member objects.
   *
   * The UI is allowed to hold on to the last room it was given and diff against
   * the next one. If the world handed out live references that would compare
   * equal to itself forever and every re-render would decide nothing had
   * changed -- a bug that only shows up once the UI gets clever, which is late.
   */
  function snapshot(lb: MockLobby, forPlayerId: string): LobbyRoom {
    return {
      id: lb.id,
      name: lb.name,
      region: lb.region,
      private: lb.private,
      // The code is the host's to pass on. A joiner already used it and showing
      // it to them again invites them to re-share a room they do not own.
      joinCode: lb.hostId === forPlayerId ? lb.joinCode : null,
      // Copied, not shared. The room is a snapshot the UI is allowed to hold on
      // to and diff against the next one (see above), and handing out the live
      // arrays would make every diff decide nothing had changed -- which is
      // exactly the bug this function exists to prevent, arriving one field
      // deeper than it used to.
      series: { ...lb.series, trackIds: [...lb.series.trackIds] },
      round: lb.round,
      standings: lb.standings.map((s) => ({ ...s, finishes: [...s.finishes] })),
      maxPlayers: lb.maxPlayers,
      status: lb.status,
      members: lb.members.map((m) => ({
        playerId: m.playerId,
        name: m.name,
        avatarId: m.avatarId,
        chassisId: m.chassisId,
        pilotId: m.pilotId,
        ready: m.ready,
        isHost: m.isHost,
        pingMs: m.pingMs,
        connecting: m.connecting,
      })),
      localId: forPlayerId,
    }
  }

  function pushRoom(lb: MockLobby): void {
    for (const c of clientsIn(lb)) c.onRoom(snapshot(lb, c.playerId))
  }

  function summary(lb: MockLobby): LobbySummary {
    const host = lb.members.find((m) => m.playerId === lb.hostId)
    return {
      difficulty: lb.series.difficulty,
      id: lb.id,
      name: lb.name,
      // The id as well as the name, so a browser row can tell YOUR lobby from
      // somebody else's who happens to be called the same thing -- which the
      // directory allows, because two people in different rooms never had to
      // agree on a name.
      hostId: lb.hostId,
      hostName: host?.name ?? '—',
      region: lb.region,
      players: lb.members.length,
      maxPlayers: lb.maxPlayers,
      private: lb.private,
      // The circuit COMING NEXT, which for a lobby that has not started is
      // round 1's. The contract says so in as many words, and it is the only
      // reading that makes the column useful: a row advertising the circuit a
      // lobby finished twenty minutes ago is advertising the wrong race.
      trackId: curTrack(lb),
      laps: lb.series.laps,
      seriesLength: lb.series.length,
      // 1-BASED, AND CLAMPED TO THE LAST ROUND. `round` counts rounds FINISHED,
      // so the round being played (or waited for) is one more -- which is what
      // "Round 2 of 5" means to the person reading the row. A finished series
      // reads "Round 5 of 5" rather than 6 of 5, for the same reason curTrack
      // clamps: the row still has to say something true.
      seriesRound: Math.min(lb.round + 1, lb.series.length),
      status: lb.status,
      pingMs: lb.probe.ms,
    }
  }

  function closeLobby(lb: MockLobby, reason: 'hostLeft' | 'error'): void {
    const watching = clientsIn(lb)
    lb.status = 'closed'
    lb.closedAt = now()
    // Bots are dropped so the row reads "closed" with nobody in it; real
    // clients are told, in this order: the reason first, then the null room.
    // Reason-then-null, because a UI that tears its room screen down on
    // onRoom(null) would otherwise be gone before it could show the reason.
    lb.members = []
    for (const c of watching) {
      c.onClosed(reason)
      c.onRoom(null)
    }
  }

  // --- the race grid -------------------------------------------------------

  /**
   * The grid the host publishes.
   *
   * ORDER: humans first, in join order with the host on pole, then AI behind.
   * The mock owes the UI a stable, explicable order more than it owes anybody
   * fairness -- a real matchmaker would seed the grid from a draw or from the
   * last race's finishing order, and the day it does, this function is the one
   * that changes.
   *
   * ONE PACKET, BUILT ONCE. The grid, the seed and the input delay are the
   * same bytes for everybody -- that is what makes them a handshake rather than
   * a negotiation. The only per-reader field is `localPlayerId`, which the
   * delivery path stamps as it hands the packet over (see `notifyStart`); the
   * grid itself is built here exactly once per start.
   */
  function buildPacket(lb: MockLobby, seed: number): RaceStartPacket {
    const grid: MultiplayerSlot[] = []
    const humans = [...lb.members].sort((a, b) => {
      if (a.isHost !== b.isHost) return a.isHost ? -1 : 1
      return a.joinedAt - b.joinedAt
    })
    for (const m of humans) {
      if (grid.length >= GRID_SIZE) break
      grid.push({
        slot: grid.length,
        playerId: m.playerId,
        name: m.name,
        avatarId: m.avatarId,
        chassisId: m.chassisId,
        pilotId: m.pilotId,
        isHost: m.isHost,
        // Null for a human: a person's skill is their own business.
        aiSkill: null,
      })
    }
    for (let i = 0; grid.length < GRID_SIZE; i++) {
      const entry = AI_ROSTER[i % AI_ROSTER.length]
      grid.push({
        slot: grid.length,
        playerId: null,
        name: aiName(i),
        // Null for AI: an AI car draws no avatar on its nameplate.
        avatarId: null,
        chassisId: entry.chassisId,
        pilotId: entry.pilotId,
        isHost: false,
        // PUBLISHED, NOT DERIVED. `2 + (slot % 3)` is the expression
        // game/main.ts uses for a single race and game/circuit.ts reproduces
        // for a championship round, so an AI filling a multiplayer grid drives
        // at exactly the pace it would in either -- and every client is handed
        // the number rather than recomputing it, which is what stops two
        // clients running different AI and desyncing from frame one.
        aiSkill: skillForSlot(lb.series.difficulty, grid.length),
      })
    }
    // The worst ping IN THE ROOM, with the host's own 0 included and an
    // unmeasured peer counted as UNKNOWN_PING_MS rather than skipped.
    let worst = 0
    for (const m of lb.members) worst = Math.max(worst, m.pingMs ?? UNKNOWN_PING_MS)
    return {
      lobbyId: lb.id,
      // Stamped per reader on delivery. The host's own copy names the host,
      // which is right for the value `start()` returns to the caller.
      localPlayerId: lb.hostId,
      trackId: curTrack(lb),
      laps: lb.series.laps,
      // WHICH ROUND THIS IS, 0-BASED, AND THE TABLE GOING INTO IT. Both are in
      // the broadcast rather than left to each client's own copy of the room
      // for the reason every other field is: eight clients reading eight
      // slightly different rooms would score the same race into eight slightly
      // different tables, and a series is exactly a chain of those.
      round: Math.min(lb.round, lb.series.length - 1),
      seriesLength: lb.series.length,
      standings: lb.standings,
      seed,
      grid,
      inputDelay: inputDelayFor(worst),
    }
  }

  /**
   * Hand the one packet to everybody in the room, stamped with who they are.
   *
   * The body is built ONCE and shared: `grid` is the same frozen-in-practice
   * array object in every client's copy, so a test that compares two readers'
   * grids is comparing the same bytes rather than two independent builds that
   * happen to agree today. Only `localPlayerId` differs, which is the whole
   * point of the field.
   */
  function notifyStart(lb: MockLobby, seed: number): RaceStartPacket {
    const body = buildPacket(lb, seed)
    for (const c of clientsIn(lb)) c.onStart({ ...body, localPlayerId: c.playerId })
    return body
  }

  function notifyKicked(playerId: string): void {
    for (const c of clients) {
      if (c.playerId !== playerId) continue
      c.onClosed('kicked')
      c.onRoom(null)
    }
  }

  /** Put a lobby on track and tell everybody in it. Returns the packet as the
   *  host would read it. */
  function startRace(lb: MockLobby): RaceStartPacket | null {
    if (lb.status !== 'open' && lb.status !== 'full') return null
    const seed = rng.int(0x7fffffff)
    lb.status = 'racing'
    lb.raceEndsAt = now() + between(RACE_MIN_MS, RACE_MAX_MS)
    // The room goes `racing` BEFORE the start packet lands, in that order, so a
    // UI that renders the room and the countdown from the same state never
    // shows a countdown over a room that still says it is open.
    pushRoom(lb)
    return notifyStart(lb, seed)
  }

  // --- the clock -----------------------------------------------------------

  /**
   * Move the people in one lobby on by a tick.
   *
   * Returns false when the lobby did not survive it -- a host walked away and
   * the room closed. That is a RETURN VALUE rather than a `status === 'closed'`
   * check by the caller because the caller's `status` has already been narrowed
   * by its own early returns and would be checking a type it believes is
   * impossible. The boolean says what actually happened.
   */
  function stepMembers(lb: MockLobby, at: number): boolean {
    const hosted = lb.members.find((m) => m.playerId === lb.hostId)
    // A bot host walking away closes the room. A REAL host never does: their
    // leaving is a call they make, not something the world does to them.
    if (hosted?.bot && chance(P.hostLeaves)) {
      closeLobby(lb, 'hostLeft')
      return false
    }
    for (const m of lb.members) {
      if (!m.bot) {
        // The local player's own row is theirs. The one thing the world does to
        // it is kick them, and only a bot host does that.
        if (hosted?.bot && chance(P.kickLocal)) {
          const kicked = m.playerId
          lb.members = lb.members.filter((x) => x.playerId !== kicked)
          notifyKicked(kicked)
          return lb.members.length > 0
        }
        continue
      }
      if (m.connecting) {
        if (chance(P.connect)) {
          m.connecting = false
          if (m.pingMs == null && !chance(UNPINGABLE_SHARE)) {
            m.pingMs = Math.round(between(PING_LO, PING_HI))
          }
        }
        continue
      }
      if (chance(P.drop)) { m.connecting = true; m.ready = false; continue }
      if (chance(P.loadout)) {
        m.chassisId = pickOne(CHASSIS_IDS)
        m.pilotId = pickOne(PILOT_IDS)
        // Same rule as setTrack: a ready you gave on a different car is not a
        // ready on this one.
        m.ready = false
        continue
      }
      if (m.ready) {
        if (chance(P.unready)) m.ready = false
      } else if (chance(P.ready)) {
        m.ready = true
      }
      // Ping wanders a little, the way a measured one does.
      if (m.pingMs != null && m.pingMs > 0) {
        m.pingMs = Math.max(8, Math.round(m.pingMs * between(0.9, 1.12)))
      }
    }
    // Leavers, one at a time: a whole lobby emptying in a tick reads as a bug.
    if (lb.members.length > 1 && chance(P.leave)) {
      const leavers = lb.members.filter((m) => m.bot && m.playerId !== lb.hostId)
      if (leavers.length > 0) {
        const gone = pickOne(leavers)
        lb.members = lb.members.filter((m) => m.playerId !== gone.playerId)
      }
    }
    if (lb.members.length < lb.maxPlayers && chance(P.join)) {
      lb.members.push(makeBot(false, at))
    }
    return true
  }

  function stepLobby(lb: MockLobby, at: number): void {
    if (lb.status === 'closed') {
      if (at - lb.closedAt >= CLOSED_LINGER_MS) lobbies.delete(lb.id)
      return
    }
    if (lb.status === 'racing') {
      /**
       * A ROUND THE LOCAL PLAYER IS IN ENDS WHEN THEY SAY IT DOES.
       *
       * `raceEndsAt` is a made-up duration for a made-up race, which is right
       * for the ninety-odd lobbies in the directory that nobody is in. It is
       * wrong for the one the player is actually racing: their round ends when
       * they cross the line and call `endRound`, and that is a real number of
       * seconds away that this timer knows nothing about. Letting the clock
       * reopen the room underneath them would reset their readies mid-race and,
       * worse, advance the series a round they had not scored yet -- so the
       * table would come back a round short and the podium would fire early.
       *
       * So a watched lobby's race is not on a timer at all. This was not an
       * issue before series: a reopened room was cosmetic.
       */
      if (clientsIn(lb).length > 0) return
      if (at < lb.raceEndsAt) return
      // Nobody real is in it, so the world scores the round for them: the
      // series advances, which is what makes a browser row's "Round 2 of 5"
      // become "Round 3 of 5" while somebody is watching the list. The
      // STANDINGS are not invented -- see MockLobby.standings for why the mock
      // never totals a round -- so a directory series carries its round number
      // and an empty table, which is all a row ever reads.
      lb.round = Math.min(lb.round + 1, lb.series.length)
      if (seriesOver(lb)) {
        // The series is over and the room with it. A lobby that sat on a
        // finished series for ever would be a permanent row advertising a race
        // that cannot be joined.
        closeLobby(lb, 'hostLeft')
        return
      }
      if (chance(REOPEN_SHARE)) {
        // Some of the field goes again. The rest have had enough.
        const keep = 1 + rng.int(Math.max(1, lb.members.length - 1))
        lb.members = lb.members.slice(0, keep)
        for (const m of lb.members) { m.ready = false; m.connecting = false }
        lb.status = lb.members.length >= lb.maxPlayers ? 'full' : 'open'
        lb.createdAt = at
        pushRoom(lb)
      } else {
        closeLobby(lb, 'hostLeft')
      }
      return
    }

    if (!stepMembers(lb, at)) return

    if (lb.members.length === 0) { closeLobby(lb, 'hostLeft'); return }
    lb.status = lb.members.length >= lb.maxPlayers ? 'full' : 'open'

    // A FULL LOBBY WHERE EVERYONE IS READY STARTS. That causal chain is worth
    // more than a dice roll on `racing`: it means the row you are watching fill
    // up is the row that then goes green and then goes racing, and it means a
    // player sitting in a bot-hosted room really does get `onStart` from a host
    // who pressed the button.
    const everyone = lb.members.length > 1
      && lb.members.every((m) => m.ready && !m.connecting)
    if (lb.status === 'full' && everyone) { startRace(lb); return }

    // Expiry. Only for a lobby nobody real is in: the player's own empty room
    // must not evaporate under them, and `onClosed` has no reason code for it.
    const alone = lb.members.length <= 1
    const watched = clientsIn(lb).length > 0
    if (alone && !watched && at - lb.createdAt > STALE_MS) closeLobby(lb, 'hostLeft')

    pushRoom(lb)
  }

  function tick(): void {
    const at = now()
    for (const lb of [...lobbies.values()]) stepLobby(lb, at)
    // Resolve any ping probe whose time has come.
    for (const lb of lobbies.values()) {
      if (lb.probe.dueAt === 0 || lb.probe.ms != null || lb.probe.never) continue
      if (at >= lb.probe.dueAt) lb.probe.ms = Math.round(between(PING_LO, PING_HI))
    }
    // A lobby ADVERTISED while you are browsing starts with just its host,
    // because that is what advertising one looks like. A lobby created to hold
    // the directory at its floor arrives with people in it, because a browser
    // refilled with a dozen empty rooms reads as a dead game -- and the floor
    // exists precisely so the browser still looks like a place.
    if (lobbies.size < LOBBY_MAX && chance(P.spawn)) makeLobby(at, false)
    while (lobbies.size < LOBBY_MIN) makeLobby(at, true)
  }

  function startClock(): void {
    if (timer != null || !autoTick) return
    timer = setInterval(tick, TICK_MS)
    // Node keeps the process alive for a pending interval; a test that forgot
    // to dispose would then hang instead of failing. unref() where it exists.
    const t = timer as unknown as { unref?: () => void }
    if (typeof t.unref === 'function') t.unref()
  }

  function stopClock(): void {
    if (timer == null) return
    clearInterval(timer)
    timer = null
  }

  const world: MockWorld = {
    rng,
    tick,
    now,
    lobbies,
    claimed,
    accounts,
    local,
    nextId,
    chance,
    between,
    closeLobby,
    pushRoom,
    snapshot,
    summary,
    buildPacket,
    notifyStart,
    notifyKicked,
    startRace,
    setLocalIdentity(p: PlayerProfile): void {
      const was = local.id
      local.id = p.id
      local.name = p.name
      local.avatarId = p.avatarId
      for (const lb of lobbies.values()) {
        for (const m of lb.members) {
          if (m.playerId !== was && m.playerId !== p.id) continue
          m.playerId = p.id
          m.name = p.name
          m.avatarId = p.avatarId
        }
        if (lb.hostId === was) lb.hostId = p.id
      }
    },
    attach(client: Client): void {
      clients.add(client)
      startClock()
    },
    detach(client: Client): void {
      clients.delete(client)
      // The clock only runs while somebody is looking. A world nobody is
      // attached to is a timer that keeps a test process alive for nothing.
      if (clients.size === 0) stopClock()
    },
    dispose(): void {
      clients.clear()
      stopClock()
    },
  }

  // Seed the directory. `makeLobby(seeded)` gives each one a history so the
  // first screenshot of the browser is of a place with people in it.
  const born = now()
  const seedCount = LOBBY_MIN + rng.int(LOBBY_MAX - LOBBY_MIN + 1)
  for (let i = 0; i < seedCount; i++) makeLobby(born, true)

  return world
}

// ---------------------------------------------------------------------------
// The request layer
// ---------------------------------------------------------------------------

interface PendingCall {
  handle: ReturnType<typeof setTimeout> | null
  cancel(): void
}

export interface MockNetOptions {
  /** Share this world with the other service. Defaults to a private one, which
   *  is almost never what an app wants and often what a test wants. */
  world?: MockWorld
  /** 0 disables the failure dice entirely. */
  failureRate?: number
  /**
   * Scale on every simulated latency. 0 resolves on the next timer beat, which
   * is how a test says "I care about the state machine, not the clock".
   */
  latencyScale?: number
  /** Force the account service to come up offline. */
  offline?: boolean
  /** Where the profile is kept. `undefined` means the device's localStorage;
   *  `null` means nowhere, which is what a blocked context degrades to. */
  storage?: StorageLike | null
  /**
   * Who this lobby service is, instead of the world's local player.
   *
   * FOR TESTS, AND IT IS WHAT MAKES A TWO-SIDED ONE POSSIBLE. The world holds
   * ONE local identity -- there is one person at this keyboard -- so two lobby
   * services sharing a world would otherwise be the same player twice, and
   * "the host left and the room closed for everybody else" could not be
   * written. Given an identity, a service becomes a second, independent seat.
   */
  identity?: { id: string; name: string; avatarId: string }
}

function latencyOf(world: MockWorld, scale: number): number {
  const slow = world.chance(LATENCY.slowShare)
  const ms = slow
    ? world.between(LATENCY.slowMin, LATENCY.slowMax)
    : world.between(LATENCY.fastMin, LATENCY.fastMax)
  return Math.max(0, Math.round(ms * scale))
}

/**
 * Resolve `run()` after a simulated round trip.
 *
 * A CANCELLED CALL RESOLVES, IT DOES NOT HANG. When a service is disposed --
 * the player left the screen -- anything in flight settles immediately with
 * `onCancel()` instead of being dropped. A promise that never settles is a leak
 * with a UI awaiting it, and in a test it is a timeout with no message.
 */
function request<T>(
  bag: Set<PendingCall>,
  ms: number,
  run: () => T,
  onCancel: () => T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    const entry: PendingCall = {
      handle: null,
      cancel: () => resolve(onCancel()),
    }
    entry.handle = setTimeout(() => {
      bag.delete(entry)
      resolve(run())
    }, ms)
    bag.add(entry)
  })
}

function cancelAll(bag: Set<PendingCall>): void {
  for (const p of [...bag]) {
    if (p.handle != null) clearTimeout(p.handle)
    bag.delete(p)
    p.cancel()
  }
}

const ok = <T, E = string>(value: T): Result<T, E> => ({ ok: true, value })
const fail = <T, E = string>(error: E): Result<T, E> => ({ ok: false, error })

// ---------------------------------------------------------------------------
// Account service
// ---------------------------------------------------------------------------

interface StoredAccount {
  v: number
  id: string
  /** The device secret from types.ts's "anonymous but owned". Nothing in the
   *  mock checks it; it is here so the stored shape is the real one. */
  secret: string
  profile: PlayerProfile
  /**
   * The account's achievements, which a real backend keeps in the account
   * record. The mock has no record that survives a reload -- the world is
   * rebuilt on every page load (see `load`) -- so it keeps them where it keeps
   * the profile, on the device, and reads them back through the catalogue's
   * sanitiser like anything else from storage.
   */
  ach?: AchievementSnapshot
}

const num = (v: unknown, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : d

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)

/**
 * Rebuild a profile from whatever was in storage.
 *
 * Everything here is untrusted in exactly the way game/circuit.ts's `readGrid`
 * is untrusted: an older build, a hand-edited value, a half-finished write. An
 * avatar id that no longer exists is DROPPED rather than rejected -- losing a
 * retired portrait is a smaller harm than losing the whole profile, which is
 * the same call pilots.ts makes about a retired pilot id.
 */
function readProfile(raw: unknown, fallbackId: string): PlayerProfile | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = str(o.id, fallbackId)
  const name = str(o.name)
  if (!id || checkNameShape(name) !== null) return null
  const unlockedRaw = Array.isArray(o.unlocked) ? o.unlocked : []
  const unlocked = new Set<string>(STARTER_IDS)
  for (const a of unlockedRaw) {
    const aid = str(a)
    // An avatar id that no longer exists is DROPPED rather than rejected:
    // losing a retired portrait is a smaller harm than losing the profile.
    if (aid && AVATAR_BY_ID.has(aid)) unlocked.add(aid)
  }
  const earned = Math.max(0, num(o.earned, 0))
  const races = Math.max(0, Math.floor(num(o.races, 0)))
  const wins = Math.max(0, Math.floor(num(o.wins, 0)))
  // Re-derive everything avatars.ts says is derivable, so a lost write cannot
  // un-rank a player who is demonstrably ranked.
  for (const a of ranksEarned(earned)) unlocked.add(a)
  for (const a of featsFromProfile({ races, wins })) unlocked.add(a)
  const avatarId = str(o.avatarId)
  return {
    id,
    name,
    avatarId: unlocked.has(avatarId) ? avatarId : DEFAULT_AVATAR_ID,
    unlocked: [...unlocked],
    credits: Math.max(0, num(o.credits, 0)),
    earned,
    races,
    wins,
  }
}

/** A brand new player. */
function mintProfile(world: MockWorld, name: string): PlayerProfile {
  return {
    id: world.nextId('acct-'),
    name,
    avatarId: DEFAULT_AVATAR_ID,
    unlocked: [...STARTER_IDS],
    // EXACTLY ONE CHEAP PORTRAIT, and read from the price table rather than
    // typed as a number so it cannot drift from the shop it is priced against.
    // The reasoning: a shop that is a wall of locked rows on first sight
    // teaches nothing, and a balance that buys two teaches the wrong thing --
    // one purchase shows a new player what buying does and leaves the other
    // twenty-three portraits as something to race for. avatars.ts puts a full
    // shop at 10,250 credits and about 128 races, so this is 2% of it.
    credits: PRICES.cheap,
    earned: 0,
    races: 0,
    wins: 0,
  }
}

/**
 * A name nobody has claimed, for a player who has not chosen one.
 *
 * Tries the name they already typed for the leaderboard first (`sg.name`,
 * owned by ui/frontend.ts). A returning player should not have to introduce
 * themselves twice to the same game.
 */
function defaultName(world: MockWorld, store: StorageLike | null): string {
  const legacy = readKey(store, LS_LEGACY_NAME)?.trim() ?? ''
  if (legacy && checkNameShape(legacy) === null && !world.claimed.has(nameKey(legacy))) {
    return legacy
  }
  for (let i = 0; i < 40; i++) {
    const candidate = `Racer ${1000 + world.rng.int(9000)}`
    if (!world.claimed.has(nameKey(candidate))) return candidate
  }
  return `Racer ${Date.now() % 10000}`
}

/**
 * The account service.
 *
 * Plain `AccountService`: `ephemeral` and `dispose()` used to be a mock-only
 * extension declared here, and both are in the contract now, so there is
 * nothing left for a wider return type to carry.
 */
export function createMockAccountService(opts: MockNetOptions = {}): AccountService {
  const world = opts.world ?? sharedWorld()
  const failureRate = opts.failureRate ?? FAILURE_RATE
  const latencyScale = opts.latencyScale ?? 1
  const store = opts.storage === undefined ? deviceStorage() : opts.storage
  const pending = new Set<PendingCall>()

  let profile: PlayerProfile | null = null
  let secret = ''
  /** The account's achievements. See `StoredAccount.ach`. */
  let achieved: AchievementSnapshot = emptySnapshot()
  let offline = opts.offline === true
  /** True when the last write to storage did not stick. The profile still
   *  works; it just will not survive a reload, and the UI may want to say so. */
  let storageBlocked = store == null

  const delay = (): number => latencyOf(world, latencyScale)
  const broken = (): boolean => failureRate > 0 && world.chance(failureRate)
  let disposed = false

  /**
   * One simulated round trip, and the only way this service makes one.
   *
   * A DISPOSED SERVICE ANSWERS NOTHING NEW. Anything issued after teardown
   * settles immediately as cancelled rather than being served -- which is what
   * an aborted fetch does, and what stops a screen that has been closed from
   * mutating the profile a second later.
   */
  function call<T>(ms: number, run: () => T, onCancel: () => T): Promise<T> {
    if (disposed) return Promise.resolve(onCancel())
    return request(pending, ms, run, onCancel)
  }

  function persist(): void {
    if (!profile) return
    const payload: StoredAccount = { v: LS_VERSION, id: profile.id, secret, profile, ach: achieved }
    storageBlocked = !writeKey(store, LS_ACCOUNT, JSON.stringify(payload))
  }

  /** Read whatever this device remembers. Never throws; see deviceStorage. */
  function restore(): {
    id: string; secret: string; profile: PlayerProfile | null; ach: AchievementSnapshot
  } | null {
    const raw = readKey(store, LS_ACCOUNT)
    if (!raw) return null
    try {
      const p = JSON.parse(raw) as Record<string, unknown>
      if (!p || typeof p !== 'object') return null
      if (num(p.v, -1) !== LS_VERSION) return null
      const id = str(p.id)
      if (!id) return null
      // An old payload has no `ach` and reads as nothing earned, which is what
      // it is. Same sanitiser as the server: unknown ids dropped one by one.
      return { id, secret: str(p.secret), profile: readProfile(p.profile, id), ach: asSnapshot(p.ach).snap }
    } catch {
      return null
    }
  }

  function publish(): void {
    if (!profile) return
    world.setLocalIdentity(profile)
    svc.onChange(profile)
  }

  /**
   * Take a name for this account, releasing whatever it held before.
   *
   * The claimed set is the mock's stand-in for a unique index. It starts loaded
   * with every name visible in the lobby directory, which is the point: the
   * first name a player tries is usually one they just saw.
   */
  function claim(id: string, name: string): boolean {
    const key = nameKey(name)
    const held = world.accounts.get(id)
    if (held && nameKey(held.name) === key) return true
    if (world.claimed.has(key)) return false
    if (held) world.claimed.delete(nameKey(held.name))
    world.claimed.add(key)
    return true
  }

  function commit(next: PlayerProfile): PlayerProfile {
    profile = next
    // AN OFFLINE PROFILE IS DEVICE-LOCAL BY DEFINITION and must not be written
    // to the account table, which stands in for the server. Writing it there
    // would make `offline` a lie the next time anything read that table -- and
    // the flag's whole job is to tell the UI that this profile has not been
    // agreed with anybody.
    if (!offline) world.accounts.set(next.id, next)
    persist()
    publish()
    return next
  }

  /** Every mutating call is the same three checks. */
  function guard(): Result<PlayerProfile> | null {
    if (!profile) return fail<PlayerProfile>('notloaded')
    if (offline) return fail<PlayerProfile>('offline')
    if (broken()) return fail<PlayerProfile>('unreachable')
    return null
  }

  const svc: AccountService = {
    get offline(): boolean {
      return offline
    },

    get ephemeral(): boolean {
      return storageBlocked
    },

    dispose(): void {
      disposed = true
      cancelAll(pending)
    },

    /**
     * LOAD NEVER REJECTS, per the contract. A player on a train gets a
     * device-local profile and a true `offline`; the UI greys out the shop and
     * the name field and the rest of the game carries on.
     *
     * Calling it again is a RETRY: it re-rolls the connection, and a successful
     * second call clears `offline`. There is nothing else in the contract that
     * could clear it.
     */
    load(): Promise<PlayerProfile> {
      const saved = restore()
      return call(
        delay(),
        () => {
          const reachable = opts.offline !== true && !broken()
          offline = !reachable
          if (saved) achieved = saved.ach
          if (saved?.profile) {
            secret = saved.secret
            // THE MOCK ADOPTS THE DEVICE'S COPY when its own table has never
            // seen this id. This is the one place it knowingly diverges from a
            // real backend: there the server remembers and the device caches,
            // here the world is rebuilt on every page load and the cache is the
            // only thing that survived. Without this, "the profile survives a
            // reload" would be false for the mock and true for production,
            // which is the wrong way round for a thing built to find bugs.
            const known = world.accounts.get(saved.profile.id)
            const live = known ?? saved.profile
            // The claim is only real if the server heard it.
            if (reachable) world.claimed.add(nameKey(live.name))
            return commit(live)
          }
          secret = saved?.secret || world.nextId('sec-')
          const fresh = mintProfile(world, defaultName(world, store))
          if (reachable) world.claimed.add(nameKey(fresh.name))
          return commit(fresh)
        },
        () => {
          // Disposed mid-load. Answer with something rather than hanging.
          offline = true
          return saved?.profile ?? mintProfile(world, 'Racer')
        },
      )
    },

    setName(name: string): Promise<Result<PlayerProfile, NameError>> {
      const trimmed = name.trim()
      return call(
        delay(),
        (): Result<PlayerProfile, NameError> => {
          // `NameError` has no case for "the request failed" and none for "you
          // never loaded a profile", and both of those ARE the server being
          // unavailable to claim a name from. So they report as 'offline',
          // which is the true sentence and one the UI already has a screen for.
          if (!profile || offline || broken()) return fail<PlayerProfile, NameError>('offline')
          const shape = checkNameShape(trimmed)
          // Every NameError is returned from this one call, which is what makes
          // an exhaustive switch over the five of them reachable in the UI.
          if (shape) return fail<PlayerProfile, NameError>(shape)
          if (!claim(profile.id, trimmed)) return fail<PlayerProfile, NameError>('taken')
          return ok(commit({ ...profile, name: trimmed }))
        },
        () => fail<PlayerProfile, NameError>('offline'),
      )
    },

    setAvatar(avatarId: string): Promise<Result<PlayerProfile>> {
      return call(
        delay(),
        (): Result<PlayerProfile> => {
          const blocked = guard()
          if (blocked) return blocked
          if (!AVATAR_BY_ID.has(avatarId)) return fail<PlayerProfile>('unknown')
          // `ownsAvatar` rather than a look in `unlocked`: a rank the player
          // has demonstrably earned is theirs whether or not the flag was ever
          // written, and refusing to let them wear it because of a lost write
          // would be the server calling its own record a liar.
          if (!ownsAvatar(profile!, avatarId)) return fail<PlayerProfile>('locked')
          return ok(commit({ ...profile!, avatarId }))
        },
        () => fail<PlayerProfile>('offline'),
      )
    },

    buyAvatar(avatarId: string): Promise<Result<PlayerProfile>> {
      return call(
        delay(),
        (): Result<PlayerProfile> => {
          const blocked = guard()
          if (blocked) return blocked
          const def = AVATAR_BY_ID.get(avatarId)
          if (!def) return fail<PlayerProfile>('unknown')
          if (ownsAvatar(profile!, avatarId)) return fail<PlayerProfile>('owned')
          // A rank or feat avatar is not for sale at any price. Saying so is
          // more useful than saying the price is missing. `priceOf` returns 0
          // for exactly those, which is why the kind is checked and not the
          // price -- a free shop item would otherwise be unbuyable.
          if (def.source.kind !== 'shop') return fail<PlayerProfile>('notforsale')
          const price = priceOf(avatarId)
          if (profile!.credits < price) return fail<PlayerProfile>('credits')
          return ok(commit({
            ...profile!,
            credits: profile!.credits - price,
            unlocked: [...profile!.unlocked, avatarId],
            // Bought it, wear it. Anything else means a second call the UI
            // would have to remember to make.
            avatarId,
          }))
        },
        () => fail<PlayerProfile>('offline'),
      )
    },

    award(credits: number, finished: { won: boolean }): Promise<Result<PlayerProfile>> {
      return call(
        delay(),
        (): Result<PlayerProfile> => {
          const blocked = guard()
          if (blocked) return blocked
          if (!Number.isFinite(credits) || credits < 0) return fail<PlayerProfile>('invalid')
          const paid = Math.floor(credits)
          const earned = profile!.earned + paid
          const races = profile!.races + 1
          const wins = profile!.wins + (finished.won ? 1 : 0)
          // Rank and counter-implied feat unlocks land HERE, on the server's
          // say-so, not in the UI. A client proposing "and I also earned this
          // avatar" is exactly what the contract's note about verification is
          // guarding against -- so the mock grants only what the numbers it was
          // just handed can be checked to imply.
          //
          // The three feats that need race evidence (a combo, a score, a
          // circuit) are NOT granted here, because `award` is not told about
          // them: see `featsEarned` in content/avatars.ts and the note at the
          // bottom of this file.
          const unlocked = new Set([
            ...profile!.unlocked,
            ...ranksEarned(earned),
            ...featsFromProfile({ races, wins }),
          ])
          return ok(commit({
            ...profile!,
            credits: profile!.credits + paid,
            earned,
            races,
            wins,
            unlocked: [...unlocked],
          }))
        },
        () => fail<PlayerProfile>('offline'),
      )
    },

    /**
     * THE SAME MERGE THE SERVER DOES, WITHOUT THE BOUNDS.
     *
     * Union and max through content/achievements.ts's one rule, then the feat
     * portraits the merged wall implies (`featsFromUnlocks`) -- which is the
     * part that finally lets the mock grant Singularity Hand, Half Million,
     * Grand Champion and Iron Run: see the note at the bottom of this file.
     *
     * No per-post bounds and no pace, exactly as this mock's `award` has no
     * clamp and no pace: the mock is the device's own account, there is nobody
     * to defend it from, and net/account.ts is where the bounds are written and
     * tested. What the mock DOES keep is the failure dice and the offline flag,
     * because those are what the calling code has to survive.
     */
    syncAchievements(progress: AchievementSnapshot): Promise<Result<AchievementSync>> {
      return call(
        delay(),
        (): Result<AchievementSync> => {
          // `guard` only ever answers with a failure, typed for the profile
          // calls; re-typed here rather than widened there.
          const blocked = guard()
          if (blocked && !blocked.ok) return fail<AchievementSync>(blocked.error)
          const merged = mergeSnapshots(achieved, asSnapshot(progress).snap)
          const p = profile!
          achieved = withDerived(merged, {
            unlocked: p.unlocked, earned: p.earned, credits: p.credits, races: p.races, wins: p.wins,
          })
          const unlocked = new Set([...p.unlocked, ...featsFromUnlocks(achieved.unlocked)])
          const next = commit({ ...p, unlocked: [...unlocked] })
          return ok({ profile: next, progress: { unlocked: [...achieved.unlocked], counters: { ...achieved.counters } } })
        },
        () => fail<AchievementSync>('offline'),
      )
    },

    onChange: () => {},
  }

  return svc
}

// ---------------------------------------------------------------------------
// Lobby service
// ---------------------------------------------------------------------------

export function createMockLobbyService(opts: MockNetOptions = {}): LobbyService {
  const world = opts.world ?? sharedWorld()
  const failureRate = opts.failureRate ?? FAILURE_RATE
  const latencyScale = opts.latencyScale ?? 1
  const pending = new Set<PendingCall>()
  let disposed = false
  /** The lobby this service is in, if any. Held as an id rather than a
   *  reference so a closed-and-swept lobby cannot be resurrected by it. */
  let roomId: string | null = null

  const delay = (): number => latencyOf(world, latencyScale)
  const broken = (): boolean => failureRate > 0 && world.chance(failureRate)

  /**
   * Who this service is.
   *
   * A FUNCTION RATHER THAN A CAPTURED VALUE, because the world's local identity
   * is written by the account service, which may finish loading AFTER the
   * browser screen has already been opened. Capturing it at construction would
   * seat the player in a room under the provisional id and the placeholder
   * name.
   */
  const me = (): { id: string; name: string; avatarId: string } => opts.identity ?? world.local

  /**
   * One simulated round trip, and the only way this service makes one.
   *
   * A DISPOSED SERVICE ANSWERS NOTHING NEW, for the same reason an aborted
   * fetch does not: the screen that asked is gone, and a call that lands after
   * it would be mutating a room the player has already left.
   */
  function call<T>(ms: number, run: () => T, onCancel: () => T): Promise<T> {
    if (disposed) return Promise.resolve(onCancel())
    return request(pending, ms, run, onCancel)
  }

  const client: Client = {
    get playerId(): string {
      return me().id
    },
    onRoom: (room) => svc.onRoom(room),
    onStart: (packet) => svc.onStart(packet),
    onClosed: (reason) => {
      roomId = null
      svc.onClosed(reason)
    },
  }
  world.attach(client)

  function currentLobby(): MockLobby | null {
    if (!roomId) return null
    const lb = world.lobbies.get(roomId)
    if (!lb || lb.status === 'closed') return null
    return lb
  }

  /** Put the local player into a lobby as a real, un-puppeted member. */
  function seat(lb: MockLobby, host: boolean): void {
    lb.members.push({
      playerId: me().id,
      name: me().name,
      avatarId: me().avatarId,
      // Defaults the garage will immediately overwrite via setLoadout. First
      // entries in the roster rather than a random pick: a player's car should
      // not change because they rejoined.
      chassisId: CHASSIS_IDS[0],
      pilotId: PILOT_IDS[0],
      ready: false,
      isHost: host,
      // Your own row's ping to the host is 0 when you ARE the host; otherwise
      // it is unknown until the peer connection is up, which is what
      // `connecting` says.
      pingMs: host ? 0 : null,
      connecting: !host,
      bot: false,
      joinedAt: world.now(),
    })
    roomId = lb.id
    if (host) lb.hostId = me().id
    else connectLocal(lb.id)
  }

  /**
   * Your own peer connection coming up, a moment after you join.
   *
   * WITHOUT THIS THE LOCAL ROW IS `connecting` FOREVER, which would mean the
   * room screen never leaves its loading state and `start()` could never
   * succeed -- the world only puppets bots, and the local member is not one.
   * It is also the behaviour the UI has to render: you join, your own row says
   * connecting, and a second later it says your ping.
   *
   * 600-2200ms is ICE when it works. It is scaled by `latencyScale` with
   * everything else, so one option turns the whole clock off for a test.
   */
  function connectLocal(lobbyId: string): void {
    const ms = Math.round(world.between(600, 2200) * latencyScale)
    void call(
      ms,
      () => {
        const lb = world.lobbies.get(lobbyId)
        if (!lb || lb.status === 'closed') return
        const mine = lb.members.find((m) => m.playerId === me().id)
        if (!mine || !mine.connecting) return
        mine.connecting = false
        // The same one-in-six that never resolves in the directory: a peer
        // you reached but cannot time is a real outcome, and the room screen
        // has to render a member whose ping is unknown.
        mine.pingMs = world.chance(UNPINGABLE_SHARE)
          ? null
          : Math.round(world.between(PING_LO, PING_HI))
        world.pushRoom(lb)
      },
      () => {},
    )
  }

  /**
   * Leave whatever room we are in. Shared by leave(), join() and create().
   *
   * A HOST LEAVING CLOSES THE ROOM. That is the contract's rule and it is also
   * the honest one for peer-to-peer: the host IS the server, so their leaving
   * is not a member departing, it is the server going away. Everyone else is
   * told `hostLeft` and pushed a null room.
   */
  function vacate(): void {
    const lb = currentLobby()
    roomId = null
    if (!lb) return
    const meId = me().id
    const wasHost = lb.hostId === meId
    lb.members = lb.members.filter((m) => m.playerId !== meId)
    if (wasHost || lb.members.length === 0) {
      world.closeLobby(lb, 'hostLeft')
      return
    }
    lb.status = lb.members.length >= lb.maxPlayers ? 'full' : 'open'
    world.pushRoom(lb)
  }

  /** The three host-only calls share this. */
  type HostCheck = { ok: true; lb: MockLobby } | { ok: false; error: string }
  function asHost(): HostCheck {
    const lb = currentLobby()
    if (!lb) return { ok: false, error: 'noroom' }
    if (lb.hostId !== me().id) return { ok: false, error: 'nothost' }
    return { ok: true, lb }
  }

  const svc: LobbyService = {
    /**
     * The directory, once.
     *
     * POLLED, per the contract: about every 4 seconds while the browser screen
     * is up. The ping design depends on that -- a row's `pingMs` starts null
     * and resolves BETWEEN calls, so a screen that asked once would show "--"
     * for ever and look broken through no fault of the mock's.
     */
    list(filter?: LobbyFilter): Promise<Result<readonly LobbySummary[]>> {
      return call(
        delay(),
        (): Result<readonly LobbySummary[]> => {
          if (broken()) return fail<readonly LobbySummary[]>('unreachable')
          const at = world.now()
          const rows: LobbySummary[] = []
          for (const lb of world.lobbies.values()) {
            // Schedule this row's ping probe the first time it is SEEN, not
            // when it was created. A row you have never listed has never been
            // pinged, because nothing has asked your browser to measure it.
            if (lb.probe.dueAt === 0) {
              lb.probe.dueAt = at + world.between(PING_MIN_MS, PING_MAX_MS)
            } else if (lb.probe.ms == null && !lb.probe.never && at >= lb.probe.dueAt) {
              // Resolve on read as well as on tick, so a browser that polls
              // faster than the world ticks still fills its rows in.
              lb.probe.ms = Math.round(world.between(PING_LO, PING_HI))
            }
            if (filter?.region && filter.region !== 'any' && lb.region !== filter.region) continue
            // `joinableOnly` is documented as hiding full and racing. `closed`
            // is not joinable either and follows by the same logic; a filter
            // that promises joinable rows and returns a dead one is a lie.
            if (filter?.joinableOnly && lb.status !== 'open') continue
            if (filter?.search) {
              const needle = filter.search.trim().toLowerCase()
              const host = lb.members.find((m) => m.playerId === lb.hostId)?.name ?? ''
              const hay = `${lb.name} ${host}`.toLowerCase()
              if (needle && !hay.includes(needle)) continue
            }
            rows.push(world.summary(lb))
          }
          return ok(rows)
        },
        () => fail<readonly LobbySummary[]>('offline'),
      )
    },

    create(o: CreateLobbyOptions): Promise<Result<LobbyRoom>> {
      return call(
        delay(),
        (): Result<LobbyRoom> => {
          if (broken()) return fail<LobbyRoom>('unreachable')
          vacate()
          const at = world.now()
          // Clamped to the contract's own bounds rather than to a local guess.
          // A lobby of ten would silently drop two people at the start line,
          // because the grid has eight slots and `buildPacket` stops filling
          // at GRID_SIZE.
          const maxPlayers = Math.max(
            LOBBY_MIN_PLAYERS,
            Math.min(LOBBY_MAX_PLAYERS, Math.floor(o.maxPlayers) || LOBBY_MIN_PLAYERS),
          )
          const lb: MockLobby = {
            id: world.nextId('lb-'),
            name: o.name.trim() || `${me().name}'s lobby`,
            hostId: me().id,
            region: o.region,
            maxPlayers,
            private: o.private,
            joinCode: o.private ? joinCode(world.rng) : null,
            series: cleanSeries(o.series),
            round: 0,
            standings: [],
            status: 'open',
            members: [],
            createdAt: at,
            closedAt: 0,
            raceEndsAt: 0,
            // Your own lobby's ping to yourself is 0 and known immediately.
            // A "--" on your own row would be a lie about a measurement that
            // does not need making.
            probe: { dueAt: at, ms: 0, never: false },
          }
          world.lobbies.set(lb.id, lb)
          seat(lb, true)
          return ok(world.snapshot(lb, me().id))
        },
        () => fail<LobbyRoom>('offline'),
      )
    },

    join(lobbyId: string, code?: string): Promise<Result<LobbyRoom, JoinError>> {
      return call(
        delay(),
        (): Result<LobbyRoom, JoinError> => {
          if (broken()) return fail<LobbyRoom, JoinError>('offline')
          const lb = world.lobbies.get(lobbyId)
          // Order matters: notfound, then the states you can see on the row,
          // then the code. Checking the code first would tell somebody with a
          // guessed code whether a lobby exists. A CLOSED lobby is 'notfound'
          // rather than a sixth case: from the joiner's side the difference is
          // not actionable.
          if (!lb || lb.status === 'closed') return fail<LobbyRoom, JoinError>('notfound')
          if (lb.status === 'racing') return fail<LobbyRoom, JoinError>('racing')
          if (lb.members.length >= lb.maxPlayers) return fail<LobbyRoom, JoinError>('full')
          if (lb.private && (code ?? '').trim().toUpperCase() !== lb.joinCode) {
            return fail<LobbyRoom, JoinError>('badcode')
          }
          // Joining somewhere else is leaving here. Doing it silently is what
          // the UI would otherwise have to remember to do, every time.
          vacate()
          seat(lb, false)
          lb.status = lb.members.length >= lb.maxPlayers ? 'full' : 'open'
          // Everyone else sees you arrive; you get the room as the return value.
          world.pushRoom(lb)
          return ok(world.snapshot(lb, me().id))
        },
        () => fail<LobbyRoom, JoinError>('offline'),
      )
    },

    /**
     * NOT A REQUEST, so no latency and no failure dice.
     *
     * This is the room the service already knows it is in -- the same state
     * every `onRoom` was built from -- so making it async would be inventing a
     * round trip for a value that is sitting in memory, and would hand a
     * remounting screen a spinner instead of its room. It is a snapshot like
     * any other push, so the caller may hold it and diff against the next one.
     */
    current(): LobbyRoom | null {
      const lb = currentLobby()
      return lb ? world.snapshot(lb, me().id) : null
    },

    leave(): Promise<void> {
      return call(
        delay(),
        () => {
          vacate()
          svc.onRoom(null)
        },
        () => {},
      )
    },

    setReady(ready: boolean): Promise<void> {
      return call(
        delay(),
        () => {
          const lb = currentLobby()
          if (!lb) return
          const mine = lb.members.find((m) => m.playerId === me().id)
          if (!mine) return
          // A member who is still connecting cannot be ready. The UI is free to
          // show the button pressed while the request is in flight; the push
          // that follows is the truth, and this is where it disagrees.
          mine.ready = ready && !mine.connecting
          world.pushRoom(lb)
        },
        () => {},
      )
    },

    setLoadout(chassisId: string, pilotId: string): Promise<void> {
      return call(
        delay(),
        () => {
          const lb = currentLobby()
          if (!lb) return
          const mine = lb.members.find((m) => m.playerId === me().id)
          if (!mine) return
          if (CHASSIS_IDS.includes(chassisId)) mine.chassisId = chassisId
          if (PILOT_IDS.includes(pilotId)) mine.pilotId = pilotId
          // Changing your own car clears your own ready, for the same reason
          // changing the track clears everybody's.
          mine.ready = false
          world.pushRoom(lb)
        },
        () => {},
      )
    },

    start(): Promise<Result<RaceStartPacket>> {
      return call(
        delay(),
        (): Result<RaceStartPacket> => {
          const h = asHost()
          if (!h.ok) return fail<RaceStartPacket>(h.error)
          const lb = h.lb
          if (lb.status === 'racing') return fail<RaceStartPacket>('racing')
          // "Fails if anybody is unready or still connecting", host included:
          // the host's own ready is not implied by their pressing Start, or the
          // button would mean two different things depending on who clicked it.
          const blocked = lb.members.filter((m) => !m.ready || m.connecting)
          if (blocked.length > 0) return fail<RaceStartPacket>('notready')
          const seed = world.rng.int(0x7fffffff)
          lb.status = 'racing'
          lb.raceEndsAt = world.now() + world.between(RACE_MIN_MS, RACE_MAX_MS)
          world.pushRoom(lb)
          // ONE packet, delivered to every client including this one. The
          // host's copy arrives through onStart as well as through this return
          // value, so a UI that listens only to onStart is correct -- and one
          // that acts on both must be idempotent.
          const body = world.notifyStart(lb, seed)
          return ok({ ...body, localPlayerId: me().id })
        },
        () => fail<RaceStartPacket>('offline'),
      )
    },

    setTrack(trackId: string, laps: number): Promise<Result<LobbyRoom>> {
      return call(
        delay(),
        (): Result<LobbyRoom> => {
          const h = asHost()
          if (!h.ok) return fail<LobbyRoom>(h.error)
          const lb = h.lb
          if (!TRACK_IDS.includes(trackId)) return fail<LobbyRoom>('notrack')
          /**
           * IT CHANGES THE CIRCUIT FOR THE ROUND COMING NEXT, AND NOTHING ELSE.
           *
           * The contract's `setTrack` predates series and still has exactly one
           * track in its signature, so the only sane reading is "the one the
           * room is showing" -- which is `series.trackIds[round]`. Rewriting
           * the whole running order from one id would silently discard a plan
           * eight people looked at before they joined, and rewriting a round
           * already raced would make the standings describe a series that never
           * happened.
           *
           * A DUPLICATE IS REFUSED RATHER THAN SWAPPED. "No repeats" is a
           * contract promise about `trackIds`, and a host reaching for a
           * circuit that is already round 4 is asking for something the series
           * cannot give. `notrack` is the honest answer; the UI greys the
           * button out before it can be pressed.
           *
           * net/live.ts does the same edit-in-place. They must agree.
           */
          const ids = [...lb.series.trackIds]
          const at = Math.max(0, Math.min(lb.round, ids.length - 1))
          if (ids[at] !== trackId && ids.includes(trackId)) return fail<LobbyRoom>('notrack')
          ids[at] = trackId
          lb.series = {
            ...lb.series,
            trackIds: ids,
            laps: Math.max(1, Math.min(20, Math.floor(laps) || lb.series.laps)),
          }
          // EVERYONE's ready, including the host's: a ready you gave for
          // Elkarim is not a ready for Zhen-9.
          for (const m of lb.members) m.ready = false
          world.pushRoom(lb)
          return ok(world.snapshot(lb, me().id))
        },
        () => fail<LobbyRoom>('offline'),
      )
    },

    kick(playerId: string): Promise<void> {
      return call(
        delay(),
        () => {
          const h = asHost()
          if (!h.ok) return
          const lb = h.lb
          // A host cannot kick themselves. Leaving is the call for that, and it
          // means something different: it closes the room.
          if (playerId === me().id) return
          if (!lb.members.some((m) => m.playerId === playerId)) return
          lb.members = lb.members.filter((m) => m.playerId !== playerId)
          lb.status = lb.members.length >= lb.maxPlayers ? 'full' : 'open'
          world.notifyKicked(playerId)
          world.pushRoom(lb)
        },
        () => {},
      )
    },

    /**
     * NULL, ALWAYS, AND THAT IS THE CORRECT ANSWER RATHER THAN A GAP.
     *
     * A transport carries frames of input between peers. There are no peers:
     * the mock's other seven cars are AI inside this one browser, every client
     * attached to a mock world shares one JS heap, and the race the player
     * drives is simulated entirely locally. Returning a fake one would hand
     * game/main.ts a `LockstepRunner` gating a race on inputs that no peer will
     * ever publish -- so the countdown would stall for twenty seconds and then
     * eject everybody, which is a convincing imitation of a broken network and
     * nothing else.
     *
     * Null means "race it locally", which is what the whole mock does, and it
     * is the branch game/main.ts takes when there is nothing on the wire. The
     * bottom of this file has said "NO RaceTransport" since it was written;
     * this is that statement with a signature on it.
     */
    transport(): RaceTransport | null { return null },

    /**
     * The round is over. Bank the table, advance the series, reopen the room.
     *
     * THE STANDINGS ARE TAKEN ON TRUST AND NOT CHECKED. The caller raced the
     * round and this did not; there is nothing here to check them against, and
     * a mock that second-guessed its own client would be testing an argument
     * the real service cannot have either (net/live.ts banks the host's table
     * verbatim and pushes it to everybody).
     *
     * IT IS IDEMPOTENT PAST THE END. `round` stops at `series.length`, so a
     * second call after the last round does not walk the counter off the end
     * of `trackIds` -- which matters because a desync and a finish can both
     * reach here for the same round, and the loser of that race must not
     * advance the series twice.
     */
    endRound(standings: readonly SeriesStanding[]): Promise<void> {
      return call(
        delay(),
        () => {
          const lb = currentLobby()
          if (!lb || lb.status === 'closed') return
          if (standings.length > 0) {
            lb.standings = standings.map((s) => ({ ...s, finishes: [...s.finishes] }))
          }
          if (lb.status === 'racing') lb.round = Math.min(lb.round + 1, lb.series.length)
          // BACK TO THE ROOM, READIES CLEARED. The next round is a different
          // circuit, so a ready given for the last one is not a ready for it --
          // the same rule `setTrack` applies, arriving for the same reason.
          // The room reopens even when the series is over: the final standings
          // are the last thing everybody looks at, and closing the room out
          // from under them would replace them with a browser.
          for (const m of lb.members) m.ready = false
          lb.status = lb.members.length >= lb.maxPlayers ? 'full' : 'open'
          lb.raceEndsAt = 0
          world.pushRoom(lb)
        },
        () => {},
      )
    },

    onRoom: () => {},
    onStart: () => {},
    onClosed: () => {},

    dispose(): void {
      if (disposed) return
      disposed = true
      // Leaving on dispose is deliberate. A player who closes the tab has left
      // the room as far as everyone else is concerned, and a mock that keeps
      // their ghost seated would hide exactly the "phantom member" bug the room
      // screen has to survive.
      vacate()
      world.detach(client)
      cancelAll(pending)
    },
  }

  return svc
}

// ---------------------------------------------------------------------------
// The shared world
// ---------------------------------------------------------------------------

let shared: MockWorld | null = null

/**
 * The world both default services use.
 *
 * Lazy, because creating one seeds a directory and creating a service starts a
 * clock -- neither of which should happen because a module was imported. A test
 * that wants isolation passes its own `world`.
 */
export function sharedWorld(): MockWorld {
  if (!shared) shared = createMockWorld()
  return shared
}

/** Drop the shared world (and its clock). For tests and for a hard reset. */
export function resetSharedWorld(): void {
  shared?.dispose()
  shared = null
}

// ---------------------------------------------------------------------------
// WHAT THIS MOCK DELIBERATELY DOES NOT DO
// ---------------------------------------------------------------------------
//
//   - NO RaceTransport. `transport()` returns null and always will: a mock of
//     it would be a mock of the one thing that cannot be faked convincingly
//     (frame-accurate input exchange between machines), and there are no other
//     machines. The race takes the local branch instead, which is the same
//     branch single player takes. See the method for the longer argument.
//   - NO SCORING. `endRound` banks the table it is handed and advances the
//     round; it never totals one. The points table, the countback and the
//     tie-break all live in game/circuit.ts, and net/ must not depend on game/
//     -- see GRID_SIZE. net/live.ts has the same shape for the same reason, so
//     the two implementations of the contract agree by construction.
//   - NO SIGNALLING. No offer/answer/candidate mailbox, because nothing above
//     the seam can observe one. `connecting` is the whole of what a UI knows
//     about ICE, and that is simulated.
//   - NO CROSS-TAB OR CROSS-DEVICE STATE. The world lives in one JS heap. Two
//     browser tabs are two unrelated worlds. A BroadcastChannel version is
//     possible and was left out: it buys a demo, not a bug.
//   - NO PERSISTENCE OF THE DIRECTORY. Only the account survives a reload.
//     A lobby list that came back identical after a refresh would be a worse
//     lie than one that is obviously regenerated.
//   - NO RECONNECT. A room you were dropped from is gone. Reconnect is a real
//     feature with real UI and it needs a contract of its own before it is
//     worth mocking.
//   - NO BANDWIDTH OR PAYLOAD SIZE. Latency is modelled; throughput is not.
//     Nothing above the seam sends enough bytes for it to matter.
//   - EVIDENCE-BASED FEATS COME THROUGH THE ACHIEVEMENTS, NOT `award`. `award`
//     is still handed only credits and a won/lost flag -- enough for ranks and
//     Flag Bearer. The four feats that need a combo, a score or a circuit
//     standing are granted by `syncAchievements`, from the synced Combo King,
//     High Roller, Grand Champion and mark:ironrun (content/achievements.ts
//     FEAT_OF), exactly as net/account.ts's `toProfile` derives them. Before
//     that sync existed, nothing could grant them at all.
