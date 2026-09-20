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
 * the host has a latency advantage, and somewhere between a tenth and a fifth
 * of connections will not traverse NAT without a TURN relay. Those are live
 * design problems, not reasons to re-litigate the choice.
 *
 * "A host who leaves ends the race" used to be the third item on that list and
 * is no longer true: see MIGRATION_BUDGET_MS. It ends the race only if no
 * survivor can be reached inside the budget.
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
  /** The circuit coming next -- round 1's for a lobby that has not started. */
  trackId: string
  laps: number
  /** 1 for a single race. A browser row says "Round 2 of 5" from these two. */
  seriesLength: SeriesLength
  seriesRound: number
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
  /**
   * Round trip TO THE HOST, published by the host and read by everybody.
   *
   * So the HOST's row reads 0 for every reader, including guests -- not the
   * reader's own row. Getting that backwards photographs perfectly and is
   * wrong: a guest would see itself at 0 and the host at its own latency,
   * which inverts who the room is waiting for.
   */
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
  series: SeriesPlan
  /**
   * Rounds already finished. 0 before the first race, `series.length` when the
   * series is over, so `series.trackIds[round]` is the circuit coming next.
   */
  round: number
  /** Empty until the first round has been scored. */
  standings: readonly SeriesStanding[]
  maxPlayers: number
  status: LobbyStatus
  members: readonly LobbyMember[]
  /** The local player's own id, so the UI can find its own row without
   *  threading the profile through every render. */
  localId: string
}

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------

/**
 * A LOBBY RUNS A SERIES, AND A SINGLE RACE IS A SERIES OF ONE.
 *
 * There is no separate "circuit lobby". Modelling one-offs and championships as
 * two shapes would give every screen, every packet and every scoring path two
 * cases to get right, and the two would drift -- which is exactly what happened
 * to single-player, where circuit mode had to grow its own grid generator
 * because the single-race one answered differently for every car the player
 * might be in (see the long comment in main.ts's startRace).
 *
 * So `length: 1` is a normal race, and everything downstream reads the same
 * fields. The UI is free to hide the round counter when there is one round.
 *
 * LENGTHS ARE 1, 3, 5 OR 8 and that is a design call, not a technical limit.
 * Eight is the full Grand Circuit and runs about forty minutes -- a real
 * commitment to ask of eight strangers, and the reason single-player's circuit
 * can be saved and resumed while an online one cannot. Three and five are what
 * people actually finish together.
 */
export const SERIES_LENGTHS = [1, 3, 5, 8] as const
export type SeriesLength = (typeof SERIES_LENGTHS)[number]

export interface SeriesPlan {
  length: SeriesLength
  /**
   * The circuits, in running order. Exactly `length` of them, no repeats.
   *
   * FIXED WHEN THE LOBBY IS CREATED, NOT DRAWN PER ROUND. Everyone can see
   * what they signed up for, a player deciding whether to join can judge the
   * whole commitment, and -- the part that actually matters -- the running
   * order does not have to be agreed over the wire between rounds, which is
   * one fewer thing for a peer-to-peer room to disagree about.
   */
  trackIds: readonly string[]
  /** Laps per round. One value for the series: a 3-lap opener and a 7-lap
   *  finale is a fine idea and a different feature. */
  laps: number
}

/** One driver's line in the series table, between rounds and at the end. */
export interface SeriesStanding {
  playerId: string | null
  name: string
  avatarId: string | null
  points: number
  /** Finishing position per round played, 1-8, or 0 for a round they missed. */
  finishes: readonly number[]
  isLocal: boolean
}

/**
 * WHAT HAPPENS WHEN SOMEBODY LEAVES MID-SERIES, written down because it is the
 * question a series raises that a single race does not.
 *
 * Their slot keeps racing under AI, and they keep scoring -- zero for the
 * rounds they miss, since `finishes` records a 0 and the points table pays
 * nothing for it. They are NOT removed from the standings: a table that
 * silently drops a driver rewrites the history of the rounds already raced,
 * and the player who beat them in round 1 should keep having beaten them.
 *
 * If they come back, they take their own slot again and score normally from
 * that round on. The slot is theirs for the whole series.
 *
 * A HOST WHO LEAVES is no longer the end of it. The role migrates to the
 * lowest surviving grid slot (see MIGRATION_BUDGET_MS), and the series carries
 * on under them. Only a migration that cannot complete inside the budget ends
 * things -- and then the standings as they stand are shown rather than
 * discarded.
 */
export interface CreateLobbyOptions {
  name: string
  region: RegionId
  maxPlayers: number
  private: boolean
  series: SeriesPlan
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

/**
 * One slot's inputs, as they travel.
 *
 * THE INPUTS ARE THE SAVE STATE. This sim's world is not serialisable and its
 * inputs are, so rebuilding a race means replaying it rather than shipping a
 * snapshot -- which is only possible because the sim is deterministic, and is
 * the same property the whole netcode rests on. Measured: ~650 frames replay in
 * 52-76ms, so "start again from frame 1" is a real option rather than a
 * theoretical one, and it is the option taken, because a returning client has
 * routinely stepped PAST its own handover frame and forward replay cannot undo
 * that. One path, no condition to get wrong.
 *
 * `from` is the first frame in `packed`; -1 inside it is a hole.
 */
export interface TapeRow {
  slot: number
  from: number
  packed: readonly number[]
}

/**
 * Everything needed to put a race back on screen mid-round.
 *
 * THE RECEIVER MUST REBUILD THE RACE FROM `packet` AND THEN REPLAY, EVERY
 * TIME, even when it still has the `Race` it was using a moment ago. That
 * looks wasteful and it is the only correct rule.
 *
 * The reason is the drop rule read from the other direction. The host chooses
 * the AI handover from the last input it HEARD -- which no other client can
 * have stepped past, and which the dropped client itself routinely HAS: it
 * holds its own inputs `inputDelay` frames beyond anything the host received,
 * and goes on stepping them until it runs out. So a returning client's own
 * frames either side of the handover were simulated with a person at the wheel
 * where the room had an AI, and no amount of forward replay undoes that.
 *
 * Measured on an ordinary link cut rather than a contrived one: the host
 * handed the slot over at frame 304 and the returning client had already
 * stepped 304, and the hashes disagreed from the next checkpoint. Rebuilding
 * costs one circuit load plus a replay -- 52-76ms for six hundred frames --
 * against a world rebuild the player has already paid for once. Choosing
 * between two paths on a condition this subtle would be choosing to be wrong
 * occasionally.
 */
export interface RoundResume {
  /** Identical to the round's original -- same seed, same grid, same
   *  `inputDelay`. Anything else is a different race. */
  packet: RaceStartPacket
  /** Every slot's inputs, frame 1 to `frame`. */
  rows: readonly TapeRow[]
  /**
   * Agreed AI/person toggle frames per player, ascending.
   *
   * CARRIED WITH THE TAPE AND NOT DERIVED FROM IT. A client that replayed the
   * inputs but not the handover history would rebuild a race that is subtly
   * not the room's race, and the desync detector would then void a round that
   * was fine for everybody else.
   */
  handovers: ReadonlyMap<string, readonly number[]>
  /** The frame the room had reached. Replay to here, then run live. */
  frame: number
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
  /** 0-based index of this round within the series. */
  round: number
  seriesLength: SeriesLength
  /** The table going into this round. Empty on round 0. */
  standings: readonly SeriesStanding[]
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
  /**
   * A human-readable reason the room ended under the player.
   *
   * `unreachable` EXISTS BECAUSE IT IS THE COMMONEST PEER-TO-PEER FAILURE and
   * folding it into `error` tells the player nothing they can act on. Between a
   * tenth and a fifth of connections will not traverse NAT without a TURN
   * relay this project does not yet have; when that happens the player deserves
   * that sentence rather than a spinner or a shrug. `detail` carries it.
   */
  onClosed: (reason: 'hostLeft' | 'kicked' | 'unreachable' | 'error', detail?: string) => void
  /**
   * The transport for the round currently starting, or null outside a race.
   *
   * The lobby owns the peer mesh -- it built it to run the room -- so the race
   * borrows it rather than dialling its own. That is also why a series works at
   * all: the mesh OUTLIVES a round, and only the per-round lockstep state is
   * torn down between them.
   */
  transport(): RaceTransport | null
  /**
   * The round is over. Advances the series, banks the standings, disposes the
   * round's lockstep state (not the mesh), clears readies and reopens the room.
   *
   * Host calls it with the result; guests get the new room through `onRoom`.
   */
  endRound(standings: readonly SeriesStanding[]): Promise<void>
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
/**
 * HOST MIGRATION, and why a star can do it at all.
 *
 * When the hub dies the graph is EMPTY -- every guest was connected only to the
 * host, so nobody holds a link to anybody. Migration is therefore a full
 * re-handshake through the signalling mailbox, which is polled, which is where
 * the seconds go. It is not instant and cannot be made instant.
 *
 * WHAT MAKES IT POSSIBLE IS DETERMINISTIC LOCKSTEP. No client can step a frame
 * it lacks inputs for, so the moment the host vanishes every survivor is
 * stopped at a known frame holding IDENTICAL state. There is nothing to
 * reconcile -- only a relay to replace. A state-synchronised netcode would have
 * to merge eight worlds that had drifted apart; this one has to make a phone
 * call.
 *
 * Vince asked for a window rather than an instant swap, which is exactly the
 * right shape: `MIGRATION_BUDGET_MS` is how long the room will wait before it
 * gives up and ends the race.
 *
 * THE ELECTION IS DETERMINISTIC BECAUSE IT HAS TO BE. The survivors cannot
 * talk -- that is the whole problem -- so they cannot negotiate. Every client
 * runs the same rule over the same grid and arrives at the same answer alone:
 * the lowest surviving grid slot. NOT "best ping", which would require the
 * measurements that require the connections that do not exist yet.
 *
 * AND THE HOST IS A ROLE, NOT AN IDENTITY. An old host who reconnects rejoins
 * as a guest. Letting them reclaim would mean a second migration triggered by
 * the event that was supposed to end the first one.
 */
export const MIGRATION_BUDGET_MS = 30_000

export type LinkStatus =
  /** Connected and stepping. */
  | 'up'
  /** The host is gone and a new one is being elected and dialled. */
  | 'migrating'
  /** This client lost its own link and is trying to get back in. */
  | 'rejoining'
  /** Over. `onClosed` has the reason. */
  | 'down'

export interface MigrationState {
  /** The host that went away, so the screen can name who left rather than
   *  only who is taking over. */
  previousHostId: string
  /** Who every survivor independently elected. */
  newHostId: string
  /** True when that is this client. */
  isLocal: boolean
  /** Milliseconds left of `MIGRATION_BUDGET_MS`. Drives the countdown on
   *  screen -- a wait with no clock reads as a hang. */
  remainingMs: number
  /** Peers already re-connected, and how many are expected. */
  connected: number
  expected: number
}

export interface RaceTransport {
  /** Publish the local player's input for a frame. */
  sendInput(frame: number, packed: number): void
  /** Publish the local sim hash so peers can detect a desync early. */
  sendHash(frame: number, hash: string): void
  /** Inputs from a peer, for a frame that may be ahead of the local one. */
  onInput: (playerId: string, frame: number, packed: number) => void
  onHash: (playerId: string, frame: number, hash: string) => void
  /**
   * A peer's WIRE died. This is a fact about the network, not an instruction
   * to the sim -- see `onRoundDrop`, which is the one the race acts on.
   */
  onDropped: (playerId: string) => void
  /**
   * The room has AGREED that a peer's slot becomes AI, starting at `aiFromFrame`.
   *
   * THE FRAME IS THE WHOLE POINT AND THE FIRST CUT OMITTED IT. Every client
   * must hand that slot to `stepAI` on exactly the same frame: substitute one
   * frame apart and the two clients make a different number of draws from the
   * AI's rng, their streams part company, and the drop CAUSES the desync it was
   * meant to survive. Measured during development -- it presents as a netcode
   * bug and is a missing integer.
   *
   * `aiFromFrame` is one past the last frame that peer was heard for, which is
   * safe by construction: a client can only have stepped a frame it held every
   * input for, so nobody has stepped past it. No hold-the-last-input fill is
   * needed, and a player whose wifi dies mid-corner finishes the corner on
   * their own steering before the AI takes the wheel.
   */
  onRoundDrop: (playerId: string, aiFromFrame: number) => void
  /**
   * The room has AGREED that a slot is a PERSON again, from `frame`.
   *
   * The exact mirror of `onRoundDrop` and load-bearing for the identical
   * reason: substitute one frame apart and the two clients make a different
   * number of stepAI draws and their rng streams part. A drop is agreed far
   * enough BEHIND that nobody has stepped past it; a restore is agreed far
   * enough AHEAD that the returning player's own inputs arrive first.
   */
  onRoundLive: (playerId: string, frame: number) => void
  /**
   * Rebuild the race from here -- the answer to `rejoin()`.
   *
   * See `TapeRow` for why this is a tape and not a snapshot.
   */
  onResync: (resume: RoundResume) => void
  /**
   * The clients have diverged, detected from the hashes above.
   *
   * THERE IS NO SUCH THING AS A SMALL DESYNC in a deterministic sim: a 1e-4
   * difference in yaw becomes a different line, then a collision on one client
   * and not the other, then a different finishing order. The thing that
   * diverges IS the result. So a desync voids the round rather than being
   * papered over -- and with `SeriesPlan`, papering over it would write the lie
   * into rounds 3, 4 and 5 as well.
   *
   * It does not end the SERIES. The peers are fine; eight people should not
   * lose their evening over one bad round.
   */
  onDesync: (frame: number) => void
  /** Worst round trip in the room right now, for the HUD's connection pip. */
  readonly worstPingMs: number
  /** Up, migrating, rejoining or down. The HUD renders all four differently. */
  readonly status: LinkStatus
  /**
   * Migration started, progressed, or finished (null).
   *
   * The race is PAUSED throughout, which costs nothing: lockstep was already
   * stopped the instant the host's inputs stopped arriving. What the player
   * must see is that the game is waiting rather than hung -- hence the clock in
   * `MigrationState`.
   */
  onMigration: (state: MigrationState | null) => void
  /**
   * The host role moved. Fired on every client including the new host.
   *
   * Everything the old host was authoritative for moves with it: relaying
   * inputs, declaring drops, refereeing desyncs, publishing pings,
   * re-advertising the lobby row (or the room vanishes from the browser
   * mid-race) and, in a series, owning the standings.
   */
  onHostChange: (hostId: string) => void
  /**
   * Take a slot back after losing the link.
   *
   * A player whose wifi blips is handed to the AI at an agreed frame, and
   * their slot stays THEIRS for the round -- nobody else can have it. Coming
   * back is the same re-handshake migration uses, then the reverse of a drop:
   * the host announces a frame from which that slot is a person again.
   */
  rejoin(): Promise<Result<void>>
  dispose(): void
}
