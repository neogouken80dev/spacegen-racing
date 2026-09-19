/**
 * SpaceGen Racing — THE MULTIPLAYER CONTRACT.
 * ---------------------------------------------------------------------------
 * Every type the lobby browser, the profile screen, the nameplates and the
 * race transport agree on. Nothing in this file does anything: it is the seam
 * that lets the front end be built, photographed and tested today against a
 * mock, and lets the real backend arrive later without the UI noticing.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS AT ALL
 *
 * The decision Vince made is PEER-TO-PEER WebRTC: no game server, one player
 * hosts, and a serverless endpoint does nothing but introduce them. That is
 * cheap and it is also the netcode model with the most ways to be wrong --
 * the host has a latency advantage, a host who leaves ends the race, and
 * somewhere between a tenth and a fifth of connections will not traverse NAT
 * without a TURN relay. Those are live design problems, not reasons to
 * re-litigate the choice.
 *
 * What this file buys is the ability to change the answer later for the price
 * of one implementation rather than the price of the whole front end. The UI
 * talks to `LobbyService` and `RaceTransport` and never to a peer connection,
 * an ICE candidate or a fetch. Swapping P2P for a relay, or for an
 * authoritative server, is then a new class implementing two interfaces.
 *
 * ===========================================================================
 * WHAT RUNS WHERE
 *
 *   Netlify Function + Blobs  (request/response, already how the leaderboard
 *                             works, no new hosting)
 *       - minting and reading a player account
 *       - the lobby directory: advertise, list, expire
 *       - WebRTC signalling: an offer/answer/candidate mailbox, polled
 *
 *   WebRTC data channels      (peer to peer, no server in the path)
 *       - lobby room state once you are in a room
 *       - inputs and state during a race
 *
 * Signalling over polled HTTP is fine BECAUSE it is low frequency: a handful
 * of messages to establish a connection, then nothing. It would be hopeless
 * for gameplay, which is exactly why gameplay does not go through it.
 *
 * ===========================================================================
 * THE MOCK IS NOT A STUB
 *
 * `net/mock.ts` implements these interfaces with plausible latency, lobbies
 * that fill and empty on their own, and players who join, ready up and leave.
 * That is deliberate: a lobby browser that only ever renders a static array
 * looks finished and is not, and every timing bug in the UI -- a list that
 * flickers on refresh, a Ready button that lies while a request is in flight,
 * a room that outlives the lobby behind it -- only appears against something
 * that moves. The mock moves.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * A player, as the server knows them.
 *
 * ANONYMOUS BUT OWNED. There is no email, no password and no signup screen:
 * first launch mints an id and a secret, the secret lives on the device, and
 * everything below hangs off the id. The player never sees any of it.
 *
 * The point of doing it server-side rather than in localStorage is that a name
 * is then actually TAKEN, and credits and unlocks are not a number in devtools.
 * It also upgrades to real sign-in later by attaching an email to an existing
 * id, which is a migration of one column rather than of everybody's progress.
 */
export interface PlayerProfile {
  /** Server-issued, stable, never shown to the player. */
  id: string
  /** Display name. Unique, claimed, 3-12 characters -- see `NAME_RULES`. */
  name: string
  /** Which avatar they are wearing. Always one of `unlocked`. */
  avatarId: string
  /** Avatar ids this player owns. Always contains the free starters. */
  unlocked: readonly string[]
  /** Spendable balance. See `src/score/wallet.ts` for how it is earned. */
  credits: number
  /** Lifetime credits earned, which is what rank thresholds read. */
  earned: number
  /** Races finished, for the profile screen. */
  races: number
  wins: number
}

export const NAME_RULES = {
  min: 3,
  max: 12,
  /**
   * Letters, digits, and a few separators. No leading or trailing separator,
   * no runs of them.
   *
   * WIDER THAN THE LEADERBOARD'S `cleanName`, WHICH IS FINE AND DELIBERATE.
   * That one sanitises a string arriving from an untrusted POST and has to
   * assume the worst. This one is a claim check on a name the player is
   * choosing, so it can afford to explain a rejection instead of silently
   * rewriting the input -- which is the actual UX difference between the two.
   */
  pattern: /^[A-Za-z0-9](?:[A-Za-z0-9]|[ _.-](?![ _.-]))*[A-Za-z0-9]$/,
} as const

export type NameError = 'short' | 'long' | 'charset' | 'taken' | 'offline'

// ---------------------------------------------------------------------------
// Avatars
// ---------------------------------------------------------------------------

/**
 * How an avatar is earned. The UI renders each of these differently, so it is
 * an enum rather than a price of 0 meaning free.
 */
export type AvatarSource =
  /** Owned by everyone from the first launch. */
  | { kind: 'starter' }
  /** Bought outright with credits. */
  | { kind: 'shop'; price: number }
  /** Unlocked by passing a lifetime-earnings threshold; no purchase step. */
  | { kind: 'rank'; earned: number }
  /** Unlocked by doing something. `how` is shown to the player verbatim. */
  | { kind: 'feat'; how: string }

export interface AvatarDef {
  id: string
  /** Shown under the portrait. Two or three words. */
  name: string
  source: AvatarSource
  /**
   * Published path of the portrait, relative to the site root.
   *
   * SQUARE, AND IT HAS TO STAY SQUARE: the picker draws it in a circle and the
   * nameplate draws it at 24px beside a name, so anything non-square gets
   * cropped differently in the two places and stops being recognisable in the
   * one that matters -- the one flying past at 60 m/s.
   */
  src: string
  /** Accent colour pulled from the art, used for the picker ring and the
   *  nameplate's edge so a player's colour is consistent everywhere. */
  accent: string
}

// ---------------------------------------------------------------------------
// Lobbies
// ---------------------------------------------------------------------------

/**
 * The regions offered in the create-lobby dropdown.
 *
 * THESE ARE A HINT, NOT A ROUTE. With no game server there is nothing in a
 * region to connect to: the host's actual location is wherever they are, and
 * the ping the browser shows is measured against that host, not against a
 * datacentre. What the field really does is let a host say who they expect to
 * play with, so a browser full of lobbies can be filtered down to the ones
 * likely to be playable. Calling it anything other than a hint in the UI would
 * be a promise the architecture cannot keep.
 */
export const REGIONS = [
  { id: 'na-west', label: 'North America — West' },
  { id: 'na-east', label: 'North America — East' },
  { id: 'sa', label: 'South America' },
  { id: 'eu-west', label: 'Europe — West' },
  { id: 'eu-east', label: 'Europe — East' },
  { id: 'apac', label: 'Asia Pacific' },
  { id: 'oce', label: 'Oceania' },
  { id: 'me-af', label: 'Middle East & Africa' },
] as const

export type RegionId = (typeof REGIONS)[number]['id']

/**
 * How many can be in one lobby.
 *
 * The ceiling is not a preference, it is the grid: `Race` builds eight cars and
 * the circuit, the results table, the podium and the points ladder are all
 * written against eight. A lobby that accepted a ninth player would have
 * nowhere to put them. The floor is two because a one-player multiplayer lobby
 * is single player with extra steps.
 */
export const LOBBY_MIN_PLAYERS = 2
export const LOBBY_MAX_PLAYERS = 8

export type LobbyStatus =
  /** Accepting players. */
  | 'open'
  /** At `maxPlayers`. Still listed, so a player can watch for a slot. */
  | 'full'
  /** The race is under way. Listed greyed rather than hidden, because a lobby
   *  that vanishes mid-browse reads as a bug. */
  | 'racing'
  /** The host went away. Kept in the list for one refresh so the row can say
   *  so rather than silently disappearing under the cursor. */
  | 'closed'

/** One row in the lobby browser. */
export interface LobbySummary {
  id: string
  name: string
  /**
   * The host's account id.
   *
   * Carried so a row can be marked as YOUR OWN lobby -- the one you are hosting
   * from another tab, or the one you just created and are looking at in the
   * list. `hostName` cannot do that job: names are claimed, but a row is
   * matched against the local profile and an id is the only thing that
   * comparison can be safely made on.
   */
  hostId: string
  /** The host's display name, which is the only identity a browser row shows. */
  hostName: string
  region: RegionId
  players: number
  maxPlayers: number
  /** Private lobbies are listed but need the join code. They are NOT hidden:
   *  a friend who was given the code still has to find the row. */
  private: boolean
  trackId: string
  laps: number
  status: LobbyStatus
  /**
   * Round-trip to the HOST, milliseconds, or null while it is being measured.
   *
   * Null is a real state and the UI must render it as one. Ping cannot be
   * known at list time -- it takes a probe per host, they resolve at different
   * times, and some never will. A row that shows "--" until it knows is honest;
   * a row that shows 0 or guesses from the region is not.
   */
  pingMs: number | null
}

/** A player inside a room. */
export interface LobbyMember {
  playerId: string
  name: string
  avatarId: string
  chassisId: string
  pilotId: string
  ready: boolean
  isHost: boolean
  /** To the host. The host's own row is always 0. */
  pingMs: number | null
  /** True while their peer connection is still coming up, or has dropped. */
  connecting: boolean
}

/** The room you are actually in. */
export interface LobbyRoom {
  id: string
  name: string
  region: RegionId
  private: boolean
  /** Shown to the host so they can pass it on. Null on a public lobby. */
  joinCode: string | null
  trackId: string
  laps: number
  maxPlayers: number
  status: LobbyStatus
  members: readonly LobbyMember[]
  /** The local player's own id, so the UI can find its own row without
   *  threading the profile through every render. */
  localId: string
}

export interface CreateLobbyOptions {
  name: string
  region: RegionId
  maxPlayers: number
  private: boolean
  trackId: string
  laps: number
}

export interface LobbyFilter {
  region?: RegionId | 'any'
  /** Hide lobbies that are full or racing. */
  joinableOnly?: boolean
  /** Substring match on lobby name or host name. */
  search?: string
}

export type JoinError =
  | 'notfound'
  | 'full'
  | 'racing'
  | 'badcode'
  | 'offline'

// ---------------------------------------------------------------------------
// The grid a race starts from
// ---------------------------------------------------------------------------

/**
 * What the host publishes when they press Start.
 *
 * ONE SEED AND AN ORDERED GRID IS THE WHOLE HANDSHAKE, because the sim is
 * deterministic: given these, every client's `Race` produces byte-identical
 * frames from identical inputs. `tests/bridges.test.ts` pins a hash of exactly
 * that property, so it is already defended -- and that same hash is what a
 * client compares to detect a desync rather than discovering one when the cars
 * visibly disagree.
 *
 * Empty slots are filled with AI, which is why `MultiplayerSlot` carries a
 * profile OR a flag rather than a nullable everything: a race is always eight
 * cars and the front end should not have to care which are people.
 */
export interface MultiplayerSlot {
  /** Grid position, 0-7. Also the racer id in the sim, as in circuit mode. */
  slot: number
  /** Null for an AI-filled slot. */
  playerId: string | null
  /** The AI's roster name, or the player's chosen one. */
  name: string
  /** Null for AI: an AI car draws no avatar on its nameplate. */
  avatarId: string | null
  chassisId: string
  pilotId: string
  isHost: boolean
  /**
   * The AI's skill band, or null for a human.
   *
   * PUBLISHED, NOT DERIVED, AND THAT IS A DESYNC FIX. `SimConfig.aiSkill` feeds
   * `stepAI` inside the deterministic sim, so it is an input to the physics in
   * exactly the way the seed is. The first cut of this packet described the
   * grid completely except for this, which meant every client would have
   * invented its own skills and the cars would have diverged from frame one --
   * the failure would have looked like a netcode bug and been a missing field.
   *
   * If it is in the sim's config, it belongs in the packet.
   */
  aiSkill: number | null
}

export interface RaceStartPacket {
  lobbyId: string
  /**
   * Who the RECIPIENT is. STAMPED BY THE TRANSPORT ON DELIVERY.
   *
   * The body of this packet -- seed, grid, laps, track -- is one broadcast,
   * identical for everybody, and `grid` is shared by reference rather than
   * rebuilt per reader so that two clients cannot drift apart through an edit
   * here. Nothing inside that shared body can say "this one is you", which is
   * why the first cut's `MultiplayerSlot.isLocal` was wrong: its correct value
   * differed per reader, and a broadcast cannot carry that.
   *
   * So this one field is filled in as the packet is handed to each client, and
   * the client matches it against its own profile id to find its slot. Sender
   * stamps rather than receiver infers, because the receiver knowing its own id
   * is an assumption and the sender addressing an envelope is a fact.
   */
  localPlayerId: string
  trackId: string
  laps: number
  /** Feeds `SimConfig.seed`. Every client must use this and nothing else. */
  seed: number
  grid: readonly MultiplayerSlot[]
  /**
   * Frames of input delay every client applies.
   *
   * The lockstep tax, and it is a DESIGN NUMBER rather than a constant: too
   * low and the race stutters waiting for the slowest peer, too high and the
   * car feels detached from the stick. The host picks it from the worst ping
   * in the room at start time, so a lobby of local players is crisp and a
   * transatlantic one is merely playable.
   */
  inputDelay: number
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/**
 * Every call can fail, because the network is not a local function.
 *
 * `E` IS A TYPE PARAMETER AND THAT IS THE WHOLE POINT. The first cut of this
 * file declared `NameError` and `JoinError` and then typed every failure as a
 * bare string, which made both of them decorative: nothing forced `setName` to
 * return one of its five cases and the UI could not switch exhaustively over
 * them, so every rejection would have arrived at the screen as an unhandled
 * string that had to be matched by hand. Naming the error set on the signature
 * is what makes the compiler check that the screen handles all of it.
 */
export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E }

export interface AccountService {
  /**
   * The profile, minting one on first ever call.
   *
   * Resolves with a LOCAL-ONLY profile when the server cannot be reached,
   * rather than rejecting. A player who opens the game on a train should still
   * get their name over their car in a single-player race; what they cannot do
   * is spend credits or claim a name, and the UI says so.
   */
  load(): Promise<PlayerProfile>
  /** True when `load` fell back to a device-local profile. */
  readonly offline: boolean
  /**
   * True when the profile will NOT survive a reload.
   *
   * Separate from `offline` because they are different sentences to the player:
   * `offline` is "the server is unreachable, your name is not claimed and you
   * cannot spend"; `ephemeral` is "this browser is blocking storage, so this
   * profile disappears when you close the tab". Conflating them produces a
   * message that is wrong in one of the two cases, and both cases are common --
   * the second is every private window.
   */
  readonly ephemeral: boolean
  setName(name: string): Promise<Result<PlayerProfile, NameError>>
  setAvatar(avatarId: string): Promise<Result<PlayerProfile>>
  /** Spends credits. Fails rather than going negative. */
  buyAvatar(avatarId: string): Promise<Result<PlayerProfile>>
  /**
   * Bank what a finished race paid.
   *
   * THE CLIENT PROPOSES AND THE SERVER DISPOSES, eventually: today it takes
   * the number, and when the leaderboard's replay verification lands this is
   * where the same evidence gets checked. The signature is already shaped for
   * that -- it returns the authoritative profile rather than assuming the add
   * succeeded.
   */
  award(credits: number, finished: { won: boolean }): Promise<Result<PlayerProfile>>
  /** Fired whenever the profile changes from any cause. */
  onChange: (p: PlayerProfile) => void
  dispose(): void
}

/**
 * THE DIRECTORY IS POLLED AND THE ROOM IS PUSHED, deliberately.
 *
 * There is no live connection to a directory -- it is a serverless endpoint
 * over HTTP -- so `list()` is a request and the browser screen has to ask
 * again to see change. About every 4 seconds while the browser is on screen,
 * and not at all while it is not: the ping design depends on this, because a
 * row's `pingMs` starts null and resolves between calls, so a screen that
 * asked once would show "--" forever and look broken.
 *
 * A ROOM IS DIFFERENT because you are in it, which means you have peer
 * connections to the people in it, which means change arrives without asking.
 * Hence `onRoom`.
 *
 * WRITES ARE FIRE-AND-FOLLOW. `setReady`, `setLoadout`, `kick` and `leave`
 * return void rather than a result: the authoritative answer is the `onRoom`
 * that follows, and a UI that treats its own call as the truth will lie the
 * first time a ready is refused -- which happens for real, because a player who
 * is still connecting cannot be ready. Render optimistically if you like, but
 * the push overwrites it.
 */
export interface LobbyService {
  list(filter?: LobbyFilter): Promise<Result<readonly LobbySummary[]>>
  create(opts: CreateLobbyOptions): Promise<Result<LobbyRoom>>
  join(lobbyId: string, code?: string): Promise<Result<LobbyRoom, JoinError>>
  /**
   * The room the local player is in right now, without waiting for a push.
   *
   * A screen that is torn down and rebuilt -- rotating a phone, coming back
   * from the garage -- has missed every `onRoom` that fired while it did not
   * exist, and has no way to recover the room it is still a member of. This is
   * that way.
   */
  current(): LobbyRoom | null
  leave(): Promise<void>
  setReady(ready: boolean): Promise<void>
  setLoadout(chassisId: string, pilotId: string): Promise<void>
  /** Host only. Fails if anybody is unready or still connecting. */
  start(): Promise<Result<RaceStartPacket>>
  /**
   * Host only. Changing the track re-clears everyone's ready flag, because a
   * ready you gave for Elkarim is not a ready for Zhen-9.
   */
  setTrack(trackId: string, laps: number): Promise<Result<LobbyRoom>>
  /** Host only. */
  kick(playerId: string): Promise<void>

  /** Push. Null once the local player has left or the lobby has closed. */
  onRoom: (room: LobbyRoom | null) => void
  /** The host pressed Start. Every client gets this, host included. */
  onStart: (packet: RaceStartPacket) => void
  /** A human-readable reason the room ended under the player. */
  onClosed: (reason: 'hostLeft' | 'kicked' | 'error') => void
  dispose(): void
}

/**
 * The race-time link. Declared here, implemented when netcode lands.
 *
 * Deliberately says nothing about WebRTC. It carries frames of input and a
 * periodic hash, which is all deterministic lockstep needs and also all an
 * authoritative server would need to receive -- so the interface survives the
 * decision being revisited.
 */
export interface RaceTransport {
  /** Publish the local player's input for a frame. */
  sendInput(frame: number, packed: number): void
  /** Publish the local sim hash so peers can detect a desync early. */
  sendHash(frame: number, hash: string): void
  /** Inputs from a peer, for a frame that may be ahead of the local one. */
  onInput: (playerId: string, frame: number, packed: number) => void
  onHash: (playerId: string, frame: number, hash: string) => void
  /** A peer's link died. The sim substitutes AI for their slot. */
  onDropped: (playerId: string) => void
  /** Worst round trip in the room right now, for the HUD's connection pip. */
  readonly worstPingMs: number
  dispose(): void
}
