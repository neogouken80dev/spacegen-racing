/**
 * lobby.ts — SpaceGen Racing multiplayer front end.
 * ---------------------------------------------------------------------------
 * Three screens behind one module, because they are one flow and they share one
 * `LobbyService`:
 *
 *   BROWSER   the directory. Polled, filterable, and built to survive a list
 *             that changes underneath the player.
 *   CREATE    hosting one.
 *   ROOM      the lobby you are actually in, pushed rather than polled.
 *
 * Nothing here knows what a peer connection is. It talks to `LobbyService` from
 * net/types.ts and to nothing else, which is the seam that whole file exists to
 * defend -- see its header.
 *
 * ===========================================================================
 * THE ORDER IS FIXED AND THE FILTERS ARE NOT. That is the call, and here is why.
 *
 * A lobby browser has two ways to let a player find a row: sort it, or narrow
 * it. This one narrows.
 *
 * Sorting loses because of what the directory IS. It is POLLED, about every four
 * seconds, and every field a player would actually want to sort on moves between
 * polls: `players` changes as people arrive, `status` flips open -> full ->
 * racing, and `pingMs` starts NULL for every row and fills in raggedly over the
 * following seconds (net/mock.ts measured 0 rows known at the first list, 6 at
 * 1.2s, 17 at 5.2s and one never). A list sorted by any of those re-orders
 * itself twice for reasons the player did not cause -- once when the poll lands
 * and again when a ping resolves -- and the row under the cursor is somewhere
 * else by the time the click arrives. Offering the sort makes it worse than not
 * offering it, because it tells the player the order means something.
 *
 * So the order is by NAME, then by id. A lobby's name is the only field in
 * `LobbySummary` that cannot change for the life of the row, which makes it the
 * only key under which rows enter and leave but never trade places.
 *
 * Narrowing wins because `LobbyFilter` is part of the contract and is applied
 * SERVER-SIDE: region, joinable-only and a substring search go into `list()` and
 * come back as a smaller set. That composes with a poll in a way a client-side
 * sort never does, and a filter change is a thing the player just did, so the
 * list jumping is expected rather than baffling.
 *
 * ===========================================================================
 * THE CURSOR PROBLEM, WHICH IS NOT A REORDER PROBLEM
 *
 * Fixing the order is necessary and not sufficient. The bug that makes a browser
 * feel broken is layout shift ABOVE the row you are pointing at: one lobby
 * expires four rows up, everything below slides up by a row height, and the
 * click you were committed to lands on a different lobby. Nothing about sort
 * order prevents that.
 *
 * Two defences, and they are separate:
 *
 *   KEYED ROWS. Each row element is owned by a lobby id and updated in place.
 *   The list is never rebuilt, so a poll that changes three numbers changes
 *   three numbers -- it does not destroy and recreate eighteen buttons, which is
 *   what drops focus, kills a hover and makes the whole list blink.
 *
 *   A PIN, IN THREE PARTS, BECAUSE "POINTING AT A ROW" MEANS THREE THINGS.
 *   While any of them holds, STRUCTURAL change is held back: rows are not
 *   inserted and not removed. Field updates still land, so the row being read
 *   keeps telling the truth about its ping and its player count.
 *
 *     a hovering pointer inside the list -- ends when it leaves, an event the
 *     browser will certainly deliver;
 *     KEYBOARD focus on a row, tested with `:focus-visible` rather than
 *     `:focus`, because a tap focuses a button too and on a phone nothing ever
 *     takes that focus away again;
 *     a recent TOUCH or scroll, for a couple of seconds, which is the phone's
 *     version of the whole problem: the gap between a finger going down and a
 *     tap landing is where a list moves a row out from under it.
 *
 *   A lobby that went away while pinned is marked as gone on the spot rather
 *   than yanked out from under you, which is the same courtesy the contract
 *   already extends to a `closed` lobby. A pill beside the status line says how
 *   many changes are waiting and lets them through on click.
 *
 *   ONLY THE TOUCH HOLD EXPIRES ON A TIMER, and it has to: a finger has no
 *   "left the screen for good" event to end it. The hover and focus pins do
 *   not, because an auto-flush would reintroduce exactly the jump they exist to
 *   prevent, at the least predictable possible moment.
 *
 *   AND THE PIN ONLY HOLDS BACK WHAT THE PLAYER DID NOT ASK FOR. A poll is held.
 *   A filter change, a manual refresh or a retry lands immediately, pointer or
 *   no pointer -- otherwise a search box appears not to work whenever the mouse
 *   is resting over the list, which, the list being most of the screen, is most
 *   of the time.
 *
 * ===========================================================================
 * AND `pingMs` IS ALLOWED TO BE NULL
 *
 * It is rendered as an em dash and labelled "not measured yet". Never 0, never
 * a guess from the region, and -- because the order does not depend on it -- a
 * ping that resolves three seconds after its row appeared changes one cell and
 * moves nothing. The contract asks for exactly this and says why.
 */
import './lobby.css'
import './series.css'
import { lobbyService } from '../net'
import {
  LOBBY_MAX_PLAYERS, LOBBY_MIN_PLAYERS, REGIONS, SERIES_LENGTHS,
  type CreateLobbyOptions, type JoinError, type LobbyFilter, type LobbyMember,
  type LobbyRoom, type LobbyService, type LobbyStatus, type LobbySummary,
  type RaceStartPacket, type RegionId, type SeriesLength,
} from '../net/types'
import { SERIES_POINTS, seriesRanking, seriesTracks } from '../game/series'
import { CIRCUIT_TRACK_IDS } from '../game/circuit'
import { AVATAR_BY_ID, DEFAULT_AVATAR_ID, placeholderPortrait, portraitFor } from '../content/avatars'
import { CHASSIS_BY_ID } from '../content/chassis'
import { PILOTS_BY_ID } from '../content/pilots'
import { TRACKS, TRACKS_BY_ID } from '../content/tracks'
import { copyFor } from './trackCopy'
import {
  DEFAULT_DIFFICULTY, DIFFICULTIES, DIFFICULTY_SPECS, type Difficulty,
} from '../content/difficulty'

export type LobbyScreenId = 'browser' | 'create' | 'room'

export interface LobbyScreens {
  browser: HTMLElement
  create: HTMLElement
  room: HTMLElement
  /** One of the three screens has become visible. */
  enter(which: LobbyScreenId): void
  /** The player left multiplayer entirely. Stops the poll; does NOT leave the
   *  room -- a player who wanders into the garage is still in their lobby. */
  exit(): void
  dispose(): void
}

export interface LobbyDeps {
  /** Back out of multiplayer altogether. */
  onBack(): void
  /** Open the profile screen. */
  onProfile(): void
  /** Ask the front end to show one of our three screens. */
  goto(which: LobbyScreenId): void
  /** The host pressed Start, here or elsewhere. */
  onStart(packet: RaceStartPacket): void
  /** The car this player is bringing, published to the room on arrival. */
  loadout(): { chassisId: string; pilotId: string }
  /** The claimed display name, for the default lobby name. */
  playerName(): string
  /** The local account id, so a row can be marked as the player's own. */
  playerId(): string
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * How often the directory is asked again.
 *
 * The contract says "about every 4 seconds while the browser is on screen, and
 * not at all while it is not", and that is not a round number chosen for looks:
 * the mock's world ticks at 1600ms and a row's ping probe resolves between 350
 * and 2600ms after the row is first listed, so a poll much slower than this
 * leaves rows showing "—" long after their ping is known, and a poll much
 * faster is a request every second for a list that changes every 1.6.
 */
const POLL_MS = 4000

/** Debounce on the search box. One request per word, not one per keystroke. */
const SEARCH_DEBOUNCE_MS = 320

/**
 * How long the list stays still after it has been touched or scrolled.
 *
 * THE PIN'S OTHER HALF, AND THE ONE THAT MATTERS ON A PHONE. Hover does not
 * exist there, so "the row under the cursor" is not a thing -- but the bug is
 * worse rather than absent: you flick the list, pick a row, and between your
 * finger going down and the tap landing a poll has moved everything up by a row
 * and you have joined somebody else's lobby. A timed hold after any touch or
 * scroll covers exactly that gap.
 *
 * 2.5s is measured against the interaction, not against the poll: a flick, a
 * glance and a tap is comfortably inside it, and a list that has been left
 * alone for longer than that is one nobody is mid-decision on. It is shorter
 * than the 4s poll on purpose -- a held-back change is never held past the
 * arrival of the next one, so the pill never counts the same change twice.
 */
const TOUCH_HOLD_MS = 2500

/** Ping bands, milliseconds. Cosmetic, but the boundaries are the ones the
 *  input-delay arithmetic in net/mock.ts actually turns on. */
const PING_GOOD = 60
const PING_OK = 140

/**
 * Short region labels.
 *
 * `REGIONS` carries the long form ("North America — West") because that is what
 * belongs in a dropdown the player reads once. A browser row is eight columns
 * wide and a phone is 412px, so the row gets the short form. The ids are the
 * contract's; only the words are ours.
 */
const REGION_SHORT: Record<RegionId, string> = {
  'na-west': 'NA West',
  'na-east': 'NA East',
  sa: 'S America',
  'eu-west': 'EU West',
  'eu-east': 'EU East',
  apac: 'Asia Pac',
  oce: 'Oceania',
  // No spaces around the slash: at 412px this column is about fifty pixels and
  // "ME / Africa" spent nine of them on padding, then ellipsised the word that
  // carried the meaning.
  'me-af': 'ME/Africa',
}

const STATUS_LABEL: Record<LobbyStatus, string> = {
  open: 'Open',
  full: 'Full',
  racing: 'Racing',
  closed: 'Closed',
}

/**
 * Every `JoinError`, as a sentence.
 *
 * A Record over the union, for the same reason profile.ts holds one over
 * `NameError`: the contract bothered to name the error set on `join`'s
 * signature, and the payment on that is a compiler that refuses a build which
 * adds a sixth case and forgets to say anything about it.
 */
const JOIN_ERROR: Record<JoinError, string> = {
  notfound: 'That lobby has gone. The host closed it, or it expired.',
  full: 'That lobby filled up before you got there.',
  racing: 'That lobby started its race. Watch for it to come back.',
  badcode: 'That code does not match. Codes are four characters.',
  offline: 'The directory did not answer. Try again in a moment.',
}

/** Laps a lobby may be set to. */
const LAP_CHOICES = [1, 3, 5, 7, 10] as const

/**
 * WHY A SEGMENT OF FIVE VALUES RATHER THAN A STEPPER OVER 1..20.
 *
 * settings.ts already argued this case for its effect levels and the argument
 * is the same one: a segment is four taps the width of a quarter of the card on
 * a phone, it works under the gamepad reader (which moves DOM focus and presses
 * A -- something a stepper's repeat behaviour cannot use), and there is nothing
 * between 6 laps and 7 worth the extra control. The authored lap count of the
 * chosen circuit picks the starting value, so the common case is already right.
 */
function nearestLaps(want: number): number {
  let best: number = LAP_CHOICES[0]
  for (const n of LAP_CHOICES) {
    if (Math.abs(n - want) < Math.abs(best - want)) best = n
  }
  return best
}

/**
 * What each series length is, in the words a host reads before choosing.
 *
 * ONE IS "A SINGLE RACE" AND IS NEVER CALLED A SERIES ANYWHERE THE PLAYER CAN
 * SEE IT. The contract models it as a series of one so that there is a single
 * code path, and says outright that the UI is free to hide the round counter
 * when there is one round. This is the other half of that: a player who wants
 * one race must not have to understand that they are configuring a
 * championship of length 1 to get it. Underneath, the same fields.
 *
 * THE TIMES ARE THE ARGUMENT, not decoration. types.ts prices the full eight at
 * about forty minutes and says three and five are what people actually finish
 * together; a host deciding what to ask of seven strangers is deciding how long
 * to keep them, and the only honest way to help is to say how long.
 */
const SERIES_COPY: Record<SeriesLength, { label: string; sub: string }> = {
  1: { label: 'Single race', sub: 'one circuit, ~5 min' },
  3: { label: '3 rounds', sub: 'points series, ~15 min' },
  5: { label: '5 rounds', sub: 'points series, ~25 min' },
  8: { label: '8 rounds', sub: 'the Grand Circuit, ~40 min' },
}

/**
 * "15-12-10-8-6-4-2-1", written out from the table itself.
 *
 * Read from `SERIES_POINTS` rather than typed as a string, which is the same
 * reason game/series.ts re-exports it instead of copying it: a tuning change to
 * the ladder must not leave the create screen advertising the old one. The
 * shape is the argument a host is actually being shown -- a 3-point gap at the
 * front, a 1-point gap at the back -- so the numbers have to be the real ones.
 */
const SERIES_POINTS_LINE = SERIES_POINTS.join('-')

/** 1st, 2nd, 3rd… for a standings place. */
const ORD_PLACE: readonly string[] = [
  '—', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th',
]

const ordinal = (n: number): string => ORD_PLACE[n] ?? `${n}th`

/**
 * A SENTENCE THE ROOM SCREEN SHOWS ONCE, SET FROM OUTSIDE.
 *
 * game/main.ts ends a round, and three of the ways it can end need a word to
 * the player that only the room screen has anywhere to put: the round is over
 * and the series moved on, the round was VOID because the clients diverged, or
 * the round finished perfectly well without us. It cannot say any of it
 * itself -- it owns a race, not a lobby -- and it reaches the room by calling
 * `frontEnd.show('room')`, which lands in `enter('room')` below.
 *
 * So it leaves the sentence here first. A module-level slot rather than a
 * method on `LobbyScreens` because the Game holds a `FrontEnd` and never a
 * `LobbyScreens`, and threading one through ui/frontend.ts would be an edit to
 * a file this pass does not own. It is read once and cleared, so a stale
 * "round void" cannot reappear three rounds later.
 */
let pendingRoomNotice: { text: string; kind: 'ok' | 'bad' } | null = null

export function setRoomNotice(text: string, kind: 'ok' | 'bad' = 'ok'): void {
  pendingRoomNotice = text ? { text, kind } : null
}

// ---------------------------------------------------------------------------
// Small DOM helpers, same shape as the ones in frontend.ts
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls: string, parent?: Element, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  if (parent) parent.appendChild(node)
  return node
}

function button(cls: string, parent: Element, label: string): HTMLButtonElement {
  const b = el('button', cls, parent, label)
  b.type = 'button'
  return b
}

function head(root: HTMLElement, title: string, backLabel: string): {
  back: HTMLButtonElement; right: HTMLElement
} {
  const h = el('div', 'sg-head', root)
  const back = button('sg-btn sg-btn--ghost', h, backLabel)
  el('div', 'sg-head__title', h, title)
  const right = el('div', 'sglb__headright', h)
  return { back, right }
}

const trackName = (id: string): string => TRACKS_BY_ID[id]?.name ?? id
const carName = (id: string): string => CHASSIS_BY_ID[id]?.name ?? id
const pilotName = (id: string): string => PILOTS_BY_ID[id]?.name ?? id

/**
 * A ping cell's text and its band, in one place.
 *
 * NULL IS A STATE AND IT IS RENDERED AS ONE. `data-ping="unknown"` is on the
 * element as well as the dash, so a probe can assert the difference between
 * "we do not know" and "it is zero" without reading pixels -- which is the one
 * thing a screenshot genuinely cannot check.
 */
function paintPing(cell: HTMLElement, ms: number | null): void {
  if (ms == null) {
    cell.textContent = '—'
    cell.dataset.ping = 'unknown'
    cell.dataset.band = 'unknown'
    cell.title = 'Ping not measured yet — some hosts never answer a probe.'
    cell.setAttribute('aria-label', 'ping unknown')
    return
  }
  cell.textContent = Math.round(ms) + ' ms'
  cell.dataset.ping = String(Math.round(ms))
  cell.dataset.band = ms <= PING_GOOD ? 'good' : ms <= PING_OK ? 'ok' : 'poor'
  cell.title = 'Round trip to the host.'
  cell.setAttribute('aria-label', `ping ${Math.round(ms)} milliseconds`)
}

/** An avatar into a circle, with the same 404 fallback profile.ts uses. */
function avatarInto(host: HTMLElement, avatarId: string): void {
  const def = AVATAR_BY_ID.get(avatarId) ?? AVATAR_BY_ID.get(DEFAULT_AVATAR_ID)
  host.textContent = ''
  if (!def) return
  host.style.setProperty('--accent', def.accent)
  host.dataset.avatar = def.id
  const img = el('img', 'sglb__avatarImg', host)
  let tried = false
  img.alt = ''
  img.decoding = 'async'
  img.dataset.art = 'primary'
  img.addEventListener('error', () => {
    if (tried) return
    tried = true
    img.dataset.art = 'fallback'
    img.src = placeholderPortrait(def)
  })
  img.src = portraitFor(def)
}

// ---------------------------------------------------------------------------

/** Everything one directory row owns. Built once per lobby id, reused. */
interface Row {
  root: HTMLButtonElement
  name: HTMLElement
  host: HTMLElement
  region: HTMLElement
  ping: HTMLElement
  players: HTMLElement
  access: HTMLElement
  track: HTMLElement
  /** "R2/5", hidden entirely on a single race. Lives inside the track cell. */
  round: HTMLElement
  status: HTMLElement
  /** The last summary painted into it, so a press knows what it pressed. */
  data: LobbySummary
}

interface MemberRow {
  root: HTMLElement
  avatar: HTMLElement
  name: HTMLElement
  car: HTMLElement
  ping: HTMLElement
  state: HTMLElement
  kick: HTMLButtonElement
}

class LobbyScreensImpl implements LobbyScreens {
  readonly browser: HTMLElement
  readonly create: HTMLElement
  readonly room: HTMLElement

  private readonly deps: LobbyDeps

  /** The service, or the reason there is not one. See `service()`. */
  private svc: LobbyService | null = null
  private svcError = ''

  // --- browser ------------------------------------------------------------
  private readonly bStatus: HTMLElement
  private readonly bColHead: HTMLElement
  private readonly bList: HTMLElement
  private readonly bEmpty: HTMLElement
  private readonly bError: HTMLElement
  private readonly bErrorText: HTMLElement
  private readonly bErrorDetail: HTMLElement
  private readonly bLoading: HTMLElement
  private readonly bPill: HTMLButtonElement
  private readonly bNotice: HTMLElement
  private readonly bFootText: HTMLElement
  private readonly bCodeWrap: HTMLElement
  private readonly bCode: HTMLInputElement
  private readonly bJoin: HTMLButtonElement
  private readonly bSearchEl: HTMLInputElement
  private readonly bRegionEl: HTMLSelectElement
  private readonly bJoinable: HTMLButtonElement
  private readonly bRefresh: HTMLButtonElement
  private readonly bHost: HTMLButtonElement
  /** Shown in the browser head only while the player is already in a lobby. */
  private readonly bBackToRoom: HTMLButtonElement

  private readonly rows = new Map<string, Row>()
  /** Ids currently laid out, in order. The pin is a promise about this array. */
  private shown: string[] = []
  /** The newest directory the service has given us, ordered. */
  private model: LobbySummary[] = []
  private filter: LobbyFilter = { region: 'any', joinableOnly: false, search: '' }
  private chosen: string | null = null
  private pollTimer = 0
  private searchTimer = 0
  private reqSeq = 0
  private appliedSeq = 0
  private firstLoadDone = false
  private lastOkAt = 0
  private pendingStructure = 0
  private pointerInList = false
  /** Epoch ms until which a touch or a scroll holds the list still. */
  private holdUntil = 0
  private holdTimer = 0
  private joining = false
  private readonly hoverCapable =
    typeof matchMedia === 'function' ? matchMedia('(hover: hover)').matches : true

  // --- create -------------------------------------------------------------
  private readonly cName: HTMLInputElement
  private readonly cRegion: HTMLSelectElement
  private readonly cMax: HTMLButtonElement[] = []
  private readonly cVis: HTMLButtonElement[] = []
  private readonly cTracks: HTMLButtonElement[] = []
  private readonly cLaps: HTMLButtonElement[] = []
  private readonly cLens: HTMLButtonElement[] = []
  private readonly cTrackK: HTMLElement
  private readonly cSeriesHint: HTMLElement
  private readonly cLapHint: HTMLElement
  private readonly cOrder: HTMLElement
  private readonly cMsg: HTMLElement
  private readonly cGo: HTMLButtonElement
  private cMaxPlayers = LOBBY_MAX_PLAYERS
  private cPrivate = false
  private cTrackId = TRACKS[0].id
  private cLapCount = nearestLaps(TRACKS[0].laps)
  /** 1 is a single race, and is the default: the commonest thing a host wants
   *  is one race, and a create screen that defaults to forty minutes is one
   *  that gets backed out of. */
  private cSeries: SeriesLength = 1
  /**
   * How hard the AI filling the empty slots will drive.
   *
   * Normal by default and not the host's own single-race setting, because
   * this is a choice being made ON BEHALF OF everyone who joins. A host who
   * plays Expert alone would otherwise publish an Expert room without ever
   * deciding to, and the people who joined it would find out on the grid.
   */
  private cDifficulty: Difficulty = DEFAULT_DIFFICULTY
  private readonly cDiffs: HTMLButtonElement[] = []
  private readonly cDiffHint: HTMLElement
  private creating = false

  // --- room ---------------------------------------------------------------
  private readonly rName: HTMLElement
  private readonly rChips: HTMLElement
  private readonly rRound: HTMLElement
  private readonly rStand: HTMLElement
  private readonly rStandTitle: HTMLElement
  private readonly rStandAfter: HTMLElement
  private readonly rStandRows: HTMLElement
  private readonly rStandYou: HTMLElement
  private readonly rSideTitle: HTMLElement
  private readonly rOrder: HTMLElement
  private readonly rChangeK: HTMLElement
  private readonly rRegion: HTMLElement
  private readonly rAccess: HTMLElement
  private readonly rCodeWrap: HTMLElement
  private readonly rCode: HTMLElement
  private readonly rCopy: HTMLButtonElement
  private readonly rMembers: HTMLElement
  private readonly rAlone: HTMLElement
  private readonly rCount: HTMLElement
  private readonly rTrackName: HTMLElement
  private readonly rTrackWorld: HTMLElement
  private readonly rTrackHook: HTMLElement
  private readonly rTrackNote: HTMLElement
  private readonly rGuestNote: HTMLElement
  private readonly rHostOnly: HTMLElement
  private readonly rTrackList: HTMLElement
  private readonly rLaps: HTMLButtonElement[] = []
  private readonly rReady: HTMLButtonElement
  private readonly rStart: HTMLButtonElement
  private readonly rWhy: HTMLElement
  private readonly rMsg: HTMLElement
  private readonly memberRows = new Map<string, MemberRow>()
  private roomModel: LobbyRoom | null = null
  /**
   * Why the last room ended, written by `onClosed` and read once by whichever
   * screen gets there first. Empty when nothing has ended.
   *
   * IT OUTLIVES THE CALLBACK ON PURPOSE. A room can close while this whole
   * screen is off -- during a race, which is when host migration and rejoin
   * both fail -- and the sentence has to survive until somebody is looking.
   */
  private closedNotice = ''
  /** Set on arrival, consumed by the next paint. See scrollMembersToMe. */
  private scrollToMe = false
  private readyBusy = false
  private starting = false
  /** Which of the three screens is up, or null for none of them. */
  private on: LobbyScreenId | null = null

  constructor(deps: LobbyDeps) {
    this.deps = deps

    // =====================================================================
    // BROWSER
    // =====================================================================
    const b = el('div', 'sglb sglb--browser')
    this.browser = b
    const bHead = head(b, 'MULTIPLAYER', 'Back')
    bHead.back.addEventListener('click', () => this.deps.onBack())
    // A PLAYER WHO WANDERS OUT OF THEIR OWN LOBBY HAS TO BE ABLE TO GET BACK.
    // Leaving the room screen does not leave the room -- `leave()` is its own
    // call -- so without this the only route back would be finding your own row
    // in the directory and re-joining it, which the service would treat as a
    // second arrival.
    this.bBackToRoom = button('sg-btn sg-btn--small', bHead.right, 'Back to your lobby')
    this.bBackToRoom.hidden = true
    this.bBackToRoom.addEventListener('click', () => this.deps.goto('room'))
    const profBtn = button('sg-btn sg-btn--ghost sg-btn--small', bHead.right, 'Profile')
    profBtn.addEventListener('click', () => this.deps.onProfile())

    // --- filters ----------------------------------------------------------
    const bar = el('div', 'sglb__bar', b)
    const search = document.createElement('input')
    search.className = 'sglb__search'
    search.type = 'search'
    search.placeholder = 'Search lobby or host'
    search.autocomplete = 'off'
    search.spellcheck = false
    search.setAttribute('aria-label', 'Search lobby or host name')
    bar.appendChild(search)
    this.bSearchEl = search

    const region = document.createElement('select')
    region.className = 'sglb__select'
    region.setAttribute('aria-label', 'Region')
    const anyOpt = document.createElement('option')
    anyOpt.value = 'any'
    anyOpt.textContent = 'Every region'
    region.appendChild(anyOpt)
    for (const r of REGIONS) {
      const o = document.createElement('option')
      o.value = r.id
      o.textContent = r.label
      region.appendChild(o)
    }
    bar.appendChild(region)
    this.bRegionEl = region

    this.bJoinable = button('sglb__toggle', bar, 'Joinable only')
    this.bJoinable.setAttribute('aria-pressed', 'false')
    this.bRefresh = button('sg-btn sg-btn--ghost sg-btn--small', bar, 'Refresh')

    this.bNotice = el('div', 'sglb__notice', b, '')
    this.bNotice.hidden = true
    this.bNotice.setAttribute('role', 'status')

    // THE STATUS LINE AND THE PILL SHARE A ROW OF FIXED HEIGHT.
    //
    // The pill lived over the bottom of the list in the first cut and it was
    // wrong twice: it covered whichever row happened to be under it, and -- as
    // a real button on top of real buttons -- it SWALLOWED THE CLICK meant for
    // that row. A control that appears on its own and eats a press is worse
    // than the layout shift it was avoiding. Here it cannot cover anything, it
    // sits beside the sentence that explains it, and the row's min-height means
    // it still costs the list nothing to appear.
    const statusRow = el('div', 'sglb__statusrow', b)
    this.bStatus = el('div', 'sglb__status', statusRow, '')
    this.bStatus.setAttribute('role', 'status')
    this.bStatus.setAttribute('aria-live', 'polite')
    this.bPill = button('sglb__pill', statusRow, '')
    this.bPill.hidden = true
    // An explicit press beats the pin: the player asked for the new list and
    // is entitled to have it move.
    this.bPill.addEventListener('click', () => this.flush(true))

    const wrap = el('div', 'sglb__wrap', b)
    const colHead = el('div', 'sglb__colhead', wrap)
    this.bColHead = colHead
    for (const [cls, label] of [
      ['name', 'Lobby'], ['host', 'Host'], ['region', 'Region'], ['ping', 'Ping'],
      ['players', 'Players'], ['access', 'Access'], ['track', 'Circuit'],
      ['status', 'Status'],
    ] as const) {
      el('span', 'sglb__col sglb__col--' + cls, colHead, label)
    }

    this.bList = el('div', 'sglb__list', wrap)

    // THE THREE THINGS A LIST CAN BE INSTEAD OF A LIST. All three live in the
    // same box as the rows so none of them can appear beside them.
    this.bLoading = el('div', 'sglb__state sglb__state--loading', wrap)
    el('span', 'sglb__spin', this.bLoading)
    el('span', '', this.bLoading, 'Finding lobbies…')
    this.bLoading.hidden = true

    this.bEmpty = el('div', 'sglb__state sglb__state--empty', wrap, '')
    this.bEmpty.hidden = true

    this.bError = el('div', 'sglb__state sglb__state--error', wrap)
    this.bError.dataset.state = 'error'
    this.bErrorText = el('div', 'sglb__errText', this.bError, '')
    // THE PLAYER'S SENTENCE AND THE DEVELOPER'S, IN THAT ORDER AND IN DIFFERENT
    // TYPE. `lobbyService()` throws a message written for whoever misconfigured
    // the build, and it is a good message -- it names the file to read. It is
    // not, however, a thing to put in the same size as "Multiplayer is not
    // available in this build".
    this.bErrorDetail = el('div', 'sglb__errDetail', this.bError, '')
    const retry = button('sg-btn sg-btn--small', this.bError, 'Try again')
    retry.addEventListener('click', () => { void this.refresh('retry') })
    this.bError.hidden = true

    const foot = el('div', 'sglb__foot', b)
    this.bFootText = el('div', 'sglb__footText', foot, '')
    this.bCodeWrap = el('div', 'sglb__codeWrap', foot)
    this.bCodeWrap.hidden = true
    const code = document.createElement('input')
    code.className = 'sglb__code'
    code.maxLength = 4
    code.autocomplete = 'off'
    code.spellcheck = false
    code.placeholder = 'CODE'
    code.setAttribute('aria-label', 'Join code')
    this.bCodeWrap.appendChild(code)
    this.bCode = code
    this.bJoin = button('sg-btn sg-btn--gold sg-btn--small', foot, 'Join')
    this.bJoin.disabled = true
    this.bHost = button('sg-btn sg-btn--small', foot, 'Host a lobby')
    const hostBtn = this.bHost

    // =====================================================================
    // CREATE
    // =====================================================================
    const c = el('div', 'sglb sglb--create')
    this.create = c
    const cHead = head(c, 'HOST A LOBBY', 'Back')
    cHead.back.addEventListener('click', () => this.deps.goto('browser'))

    const cBody = el('div', 'sglb__form sg-panel', c)

    el('label', 'sglb__k', cBody, 'Lobby name')
    const cName = document.createElement('input')
    cName.className = 'sglb__in'
    cName.maxLength = 28
    cName.autocomplete = 'off'
    cName.spellcheck = false
    cName.setAttribute('aria-label', 'Lobby name')
    cBody.appendChild(cName)
    this.cName = cName

    el('label', 'sglb__k', cBody, 'Region')
    const cRegion = document.createElement('select')
    cRegion.className = 'sglb__select sglb__select--wide'
    cRegion.setAttribute('aria-label', 'Region')
    for (const r of REGIONS) {
      const o = document.createElement('option')
      o.value = r.id
      o.textContent = r.label
      cRegion.appendChild(o)
    }
    cBody.appendChild(cRegion)
    this.cRegion = cRegion
    // THE COPY DOES NOT PROMISE A ROUTE. types.ts is explicit that a region is
    // a hint: there is no game server in it, the connection is peer to peer to
    // wherever the host actually is, and the ping on a browser row is measured
    // against that host. Anything more confident here would be a promise the
    // architecture cannot keep.
    el('div', 'sglb__hint', cBody,
      'A hint about who you expect to play with, so people can filter for it. '
      + 'It does not route anything — everyone connects straight to you, wherever you are.')

    el('div', 'sglb__k', cBody, 'Players')
    const maxGrp = el('div', 'sglb__seg sglb__seg--wide', cBody)
    for (let n = LOBBY_MIN_PLAYERS; n <= LOBBY_MAX_PLAYERS; n++) {
      const btn = button('sglb__segBtn', maxGrp, String(n))
      btn.dataset.max = String(n)
      btn.addEventListener('click', () => { this.cMaxPlayers = n; this.paintCreate() })
      this.cMax.push(btn)
    }
    el('div', 'sglb__hint', cBody,
      `Between ${LOBBY_MIN_PLAYERS} and ${LOBBY_MAX_PLAYERS}. Empty seats on the `
      + 'grid are filled with AI cars, so the race is always eight.')

    el('div', 'sglb__k', cBody, 'Visibility')
    const visGrp = el('div', 'sglb__seg', cBody)
    for (const [priv, label] of [[false, 'Public'], [true, 'Private']] as const) {
      const btn = button('sglb__segBtn', visGrp, label)
      btn.dataset.private = String(priv)
      btn.addEventListener('click', () => { this.cPrivate = priv; this.paintCreate() })
      this.cVis.push(btn)
    }
    el('div', 'sglb__hint', cBody,
      'A private lobby is still listed — it just needs the four-character code '
      + 'you will be given. Friends still have to find the row.')

    // THE LENGTH COMES BEFORE THE CIRCUIT, because it changes what the circuit
    // question means: for a single race it is THE circuit, and for a series it
    // is only the opener with seven more behind it. Asking in the other order
    // makes a host pick a track and then discover it was one of five.
    el('div', 'sglb__k', cBody, 'Length')
    const lenGrp = el('div', 'sglbs__lenseg', cBody)
    for (const n of SERIES_LENGTHS) {
      const btn = button('sglbs__lenBtn', lenGrp, '')
      btn.dataset.series = String(n)
      el('span', 'sglbs__lenLabel', btn, SERIES_COPY[n].label)
      el('span', 'sglbs__lenSub', btn, SERIES_COPY[n].sub)
      btn.addEventListener('click', () => { this.cSeries = n; this.paintCreate() })
      this.cLens.push(btn)
    }
    this.cSeriesHint = el('div', 'sglb__hint', cBody, '')

    // THE AI FIELD. Below Length because it is a smaller decision, above the
    // circuit because it applies to every round of the series rather than to
    // one of them.
    el('div', 'sglb__k', cBody, 'Opponents')
    const diffGrp = el('div', 'sglb__seg', cBody)
    for (const d of DIFFICULTIES) {
      const btn = button('sglb__segBtn', diffGrp, DIFFICULTY_SPECS[d].label)
      btn.dataset.diff = d
      btn.addEventListener('click', () => { this.cDifficulty = d; this.paintCreate() })
      this.cDiffs.push(btn)
    }
    this.cDiffHint = el('div', 'sglb__hint', cBody, '')

    this.cTrackK = el('div', 'sglb__k', cBody, 'Circuit')
    const trkGrid = el('div', 'sglb__trackgrid', cBody)
    for (const t of TRACKS) {
      const btn = button('sglb__track', trkGrid, '')
      btn.dataset.track = t.id
      el('span', 'sglb__trackName', btn, t.name)
      el('span', 'sglb__trackLaps', btn, t.laps + ' laps')
      btn.addEventListener('click', () => {
        this.cTrackId = t.id
        this.cLapCount = nearestLaps(t.laps)
        this.paintCreate()
      })
      this.cTracks.push(btn)
    }

    // THE RUNNING ORDER, SHOWN BEFORE IT IS COMMITTED. The contract fixes it at
    // creation and gives "everyone can see what they signed up for" as one of
    // the three reasons; a host who cannot see it either has no way to know
    // what they are advertising.
    this.cOrder = el('div', 'sglbs__order', cBody)

    el('div', 'sglb__k', cBody, 'Laps')
    const lapGrp = el('div', 'sglb__seg', cBody)
    for (const n of LAP_CHOICES) {
      const btn = button('sglb__segBtn', lapGrp, String(n))
      btn.dataset.laps = String(n)
      btn.addEventListener('click', () => { this.cLapCount = n; this.paintCreate() })
      this.cLaps.push(btn)
    }
    // LAPS ARE PER ROUND AND THE SAME FOR ALL OF THEM, which the contract is
    // explicit about ("a 3-lap opener and a 7-lap finale is a fine idea and a
    // different feature"). Worth one line, because five rounds of ten laps is
    // an hour and a half and nothing else on the screen says so.
    this.cLapHint = el('div', 'sglb__hint', cBody, '')

    const cFoot = el('div', 'sglb__foot', c)
    this.cMsg = el('div', 'sglb__msg', cFoot, '')
    this.cMsg.setAttribute('role', 'status')
    this.cMsg.setAttribute('aria-live', 'polite')
    this.cGo = button('sg-btn sg-btn--gold sg-btn--start', cFoot, 'Create lobby')

    // =====================================================================
    // ROOM
    // =====================================================================
    const r = el('div', 'sglb sglb--room')
    this.room = r
    const rHead = head(r, 'LOBBY', 'Leave')
    rHead.back.addEventListener('click', () => { void this.leave() })

    const rTop = el('div', 'sglbr__top', r)
    this.rName = el('div', 'sglbr__name', rTop, '')
    this.rChips = el('div', 'sglbr__chips', rTop)
    // FIRST CHIP, BEFORE THE REGION. On round 3 of 5 it is the single most
    // important fact on the screen -- it says how much of the evening is left
    // and which table the next race feeds -- and a room that buried it after
    // "EU West" would be ordering the chips by how long they have existed.
    // Hidden outright on a single race: see the contract on length 1.
    this.rRound = el('span', 'sglb__chip sglbs__roundChip', this.rChips, '')
    this.rRound.hidden = true
    this.rRegion = el('span', 'sglb__chip', this.rChips, '')
    this.rAccess = el('span', 'sglb__chip', this.rChips, '')
    this.rCodeWrap = el('span', 'sglbr__codewrap', this.rChips)
    this.rCodeWrap.hidden = true
    el('span', 'sglbr__codeK', this.rCodeWrap, 'CODE')
    this.rCode = el('span', 'sglbr__code', this.rCodeWrap, '----')
    this.rCopy = button('sglbr__copy', this.rCodeWrap, 'Copy')

    const rBody = el('div', 'sglbr__body', r)

    const rPeople = el('div', 'sglbr__people sg-panel', rBody)
    const rpHead = el('div', 'sglbr__panelhead', rPeople)
    el('span', 'sglbr__panelTitle', rpHead, 'ON THE GRID')
    this.rCount = el('span', 'sglbr__count', rpHead, '')
    this.rMembers = el('div', 'sglbr__members', rPeople)
    // Its own line rather than sharing the message element: the advisory is a
    // standing fact about the room and the message is the answer to the last
    // thing the player did, so one must not be able to erase the other.
    this.rAlone = el('div', 'sglbr__alone', rPeople, '')
    this.rAlone.hidden = true

    /**
     * THE STANDINGS, BETWEEN THE PEOPLE AND THE CIRCUIT.
     *
     * A whole panel of its own rather than a line under the member list,
     * because between rounds it is what everybody in the room is looking at,
     * and because it has to hold eight rows with five numbers on each. It sits
     * in the people column so the two lists share a left edge: "who is here"
     * and "how they are doing" are the same eight names in a different order,
     * and putting them in two different columns makes the reader hop.
     *
     * IT DOES NOT EXIST AT ALL ON ROUND 1 OR IN A SINGLE RACE, which is not
     * the same as existing and being empty. An empty standings table before
     * anybody has raced is a promise of content that is not missing -- it has
     * not happened yet -- and on a single race it is a promise of a feature
     * that will never arrive.
     */
    this.rStand = el('div', 'sglbs__panel sg-panel', rBody)
    const stHead = el('div', 'sglbr__panelhead', this.rStand)
    this.rStandTitle = el('span', 'sglbr__panelTitle', stHead, 'STANDINGS')
    this.rStandAfter = el('span', 'sglbs__after', stHead, '')
    this.rStandRows = el('div', 'sglbs__rows', this.rStand)
    this.rStandYou = el('div', 'sglbs__you', this.rStand, '')
    this.rStand.hidden = true

    const rSide = el('div', 'sglbr__side sg-panel', rBody)
    this.rSideTitle = el('div', 'sglbr__panelTitle', rSide, 'CIRCUIT')
    this.rTrackName = el('div', 'sglbr__trackName', rSide, '')
    this.rTrackWorld = el('div', 'sglbr__trackWorld', rSide, '')
    // A GUEST GETS A PANEL WORTH READING. Without this the whole right-hand
    // column is one line of text and a lap count, because everything else in it
    // is host-only -- which looks like a panel that failed to load rather than
    // one that has nothing in it for you to change. The circuit's own copy is
    // already written and already used on the track screen; this is the third
    // place it earns its keep.
    this.rTrackHook = el('div', 'sglbr__trackHook', rSide, '')
    this.rTrackNote = el('div', 'sglbr__trackNote', rSide, '')
    this.rGuestNote = el('div', 'sglb__hint', rSide, '')
    // THE REST OF THE RUNNING ORDER, under the circuit that is next and ABOVE
    // the host's controls. Read-only for everybody, host included: the
    // contract fixes the order at creation so that it never has to be agreed
    // over the wire between rounds, and a control that appeared to reorder it
    // would be a control that lied.
    //
    // Above rather than below because this panel SCROLLS. Appended last, the
    // order sat under eight circuit buttons and a lap segment and was off the
    // bottom of the column on a 810px desktop -- present, correct, and never
    // seen by anybody who did not go looking.
    this.rOrder = el('div', 'sglbs__order sglbs__order--room', rSide)
    this.rOrder.hidden = true
    this.rHostOnly = el('div', 'sglbr__hostonly', rSide)
    this.rChangeK = el('div', 'sglb__k', this.rHostOnly, 'Change circuit')
    this.rTrackList = el('div', 'sglbr__tracklist', this.rHostOnly)
    for (const t of TRACKS) {
      const btn = button('sglbr__trackBtn', this.rTrackList, t.name)
      btn.dataset.track = t.id
      btn.addEventListener('click', () => { void this.setTrack(t.id, null) })
    }
    el('div', 'sglb__k', this.rHostOnly, 'Laps')
    const rLapGrp = el('div', 'sglb__seg', this.rHostOnly)
    for (const n of LAP_CHOICES) {
      const btn = button('sglb__segBtn', rLapGrp, String(n))
      btn.dataset.laps = String(n)
      btn.addEventListener('click', () => { void this.setTrack(null, n) })
      this.rLaps.push(btn)
    }
    // Changing the track clears everyone's ready, per the contract. Said out
    // loud so a host does not read a room full of cleared ticks as a bug.
    el('div', 'sglb__hint', this.rHostOnly,
      'Changing the circuit or the laps clears everybody’s ready — a ready you '
      + 'gave for one planet is not a ready for another.')

    const rFoot = el('div', 'sglb__foot sglbr__foot', r)
    this.rMsg = el('div', 'sglb__msg', rFoot, '')
    this.rMsg.setAttribute('role', 'status')
    this.rMsg.setAttribute('aria-live', 'polite')
    this.rWhy = el('div', 'sglbr__why', rFoot, '')
    this.rWhy.id = 'sglbr-why'
    // SAME SIZE AS START. For a guest, Ready is the only thing on this screen
    // they can actually do, and a small button beside a huge greyed one reads
    // as the opposite of the truth.
    this.rReady = button('sg-btn sg-btn--start sglbr__ready', rFoot, 'Ready')
    this.rStart = button('sg-btn sg-btn--gold sg-btn--start sglbr__start', rFoot, 'Start race')
    this.rStart.setAttribute('aria-describedby', 'sglbr-why')

    // =====================================================================
    // Wiring
    // =====================================================================
    search.addEventListener('input', () => {
      if (this.searchTimer) window.clearTimeout(this.searchTimer)
      this.searchTimer = window.setTimeout(() => {
        this.searchTimer = 0
        this.filter = { ...this.filter, search: search.value.trim() }
        this.filterChanged()
      }, SEARCH_DEBOUNCE_MS)
    })
    search.addEventListener('keydown', (e) => e.stopPropagation())
    region.addEventListener('change', () => {
      const v = region.value
      this.filter = { ...this.filter, region: v === 'any' ? 'any' : (v as RegionId) }
      this.filterChanged()
    })
    this.bJoinable.addEventListener('click', () => {
      const on = !this.filter.joinableOnly
      this.filter = { ...this.filter, joinableOnly: on }
      this.bJoinable.setAttribute('aria-pressed', on ? 'true' : 'false')
      this.bJoinable.classList.toggle('is-on', on)
      this.filterChanged()
    })
    this.bRefresh.addEventListener('click', () => { void this.refresh('manual') })
    this.bJoin.addEventListener('click', () => { void this.joinChosen() })
    this.bCode.addEventListener('input', () => {
      // Upper-cased on the way in. The mock's codes are upper-case and a player
      // reading one off a screen and typing it back in lower case is not making
      // a mistake worth punishing.
      const at = this.bCode.selectionStart
      this.bCode.value = this.bCode.value.toUpperCase()
      if (at !== null) this.bCode.setSelectionRange(at, at)
      this.paintFoot()
    })
    this.bCode.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void this.joinChosen() }
      e.stopPropagation()
    })
    hostBtn.addEventListener('click', () => this.deps.goto('create'))

    // THE PIN. Hover only where hover exists: on a touch screen `pointerover`
    // fires on a tap and never fires the matching `pointerleave` until the next
    // tap somewhere else, which would pin the list for ever.
    if (this.hoverCapable) {
      this.bList.addEventListener('pointerenter', () => { this.pointerInList = true })
      this.bList.addEventListener('pointerleave', () => {
        this.pointerInList = false
        this.flush()
      })
    }
    // ...and a touch or a scroll pins it for a moment on EVERY device, hover or
    // no hover. See TOUCH_HOLD_MS: this is the half of the pin that keeps a
    // phone from moving a row out from under a thumb mid-tap.
    this.bList.addEventListener('pointerdown', () => this.touch())
    this.bList.addEventListener('scroll', () => this.touch(), { passive: true })
    // Focus pins it on every device: a keyboard or pad player standing on a row
    // has exactly the same claim on it as a mouse hovering one.
    this.bList.addEventListener('focusout', (e) => {
      const to = e.relatedTarget
      if (to instanceof Node && this.bList.contains(to)) return
      this.flush()
    })

    this.cName.addEventListener('input', () => this.paintCreate())
    this.cName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void this.doCreate() }
      e.stopPropagation()
    })
    this.cRegion.addEventListener('change', () => this.paintCreate())
    this.cGo.addEventListener('click', () => { void this.doCreate() })

    this.rReady.addEventListener('click', () => { void this.toggleReady() })
    this.rStart.addEventListener('click', () => { void this.doStart() })
    this.rCopy.addEventListener('click', () => { void this.copyCode() })

    this.paintCreate()
    this.paintFoot()
  }

  // -------------------------------------------------------------------------
  // The service
  // -------------------------------------------------------------------------

  /**
   * The lobby service, or null and a reason.
   *
   * `lobbyService()` THROWS for the `live` profile, on purpose -- net/index.ts
   * would rather fail loudly than hand a build that asked for the real backend
   * a directory full of invented people. That is the right call and it makes
   * this a call site that must not assume. A screen that let the throw escape
   * would take the whole front end down on the way INTO multiplayer, from a
   * button on the title screen, which is the worst possible place to discover a
   * configuration problem.
   */
  private service(): LobbyService | null {
    if (this.svc || this.svcError) return this.svc
    try {
      const svc = lobbyService()
      svc.onRoom = (room) => this.onRoom(room)
      svc.onStart = (packet) => this.deps.onStart(packet)
      svc.onClosed = (reason, detail) => this.onClosed(reason, detail)
      this.svc = svc
    } catch (e) {
      this.svcError = e instanceof Error ? e.message : String(e)
    }
    return this.svc
  }

  // -------------------------------------------------------------------------
  // Screen lifecycle
  // -------------------------------------------------------------------------

  enter(which: LobbyScreenId): void {
    this.on = which
    if (which === 'browser') {
      this.bBackToRoom.hidden = this.service()?.current() == null
      this.startPoll()
      return
    }
    this.stopPoll()
    if (which === 'create') {
      // Prefilled from the claimed name, because a lobby called "Nova's lobby"
      // is a better default than an empty field the player has to answer before
      // the Create button will light up.
      if (!this.cName.value.trim()) this.cName.value = `${this.deps.playerName()}'s lobby`
      this.setMsg(this.cMsg, '', 'wait')
      this.paintCreate()
      return
    }
    // ROOM. `current()` is the contract's answer for a screen that was rebuilt
    // or navigated back into and has missed every push that fired meanwhile.
    const svc = this.service()
    const room = svc?.current() ?? null
    if (!room) {
      /**
       * THE COMMONEST WAY TO GET HERE IS NOT "YOU ARE NOT IN A LOBBY", AND
       * SAYING THAT THREW AWAY THE ONLY EXPLANATION THERE WAS.
       *
       * A room that ends mid-RACE fires `onClosed` while this screen is not on
       * -- the race is -- so the branch there that navigates does nothing and
       * all it leaves behind is the sentence. The race then ends, game/main.ts
       * walks back to the room, and this line used to answer a question nobody
       * asked: the player knows they are not in a lobby, they are looking at
       * the place it used to be. What they do not know is that the host left
       * and thirty seconds of reconnection did not reach whoever took over.
       *
       * So the closure's own sentence wins when there is one, and "you are not
       * in a lobby" is kept for the case it was actually written for: walking
       * into the room screen without ever having been in a room.
       */
      this.notice(this.takeClosedNotice() || 'You are not in a lobby.')
      // AND THE ROUND'S NOTICE GOES WITH THE ROOM IT WAS FOR. `setRoomNotice`
      // is how a void or abandoned round explains itself on the way back, and
      // it is read by the room screen -- which there is no longer one of.
      // Left standing it would surface over the NEXT room this player joins,
      // describing a round in a lobby that no longer exists.
      pendingRoomNotice = null
      this.deps.goto('browser')
      return
    }
    // THE ROUND THAT JUST ENDED GETS TO SAY WHY. Taken and cleared: a race
    // whose round was void must say so on the way back, and must not still be
    // saying it two rounds later. See `setRoomNotice`.
    if (pendingRoomNotice) {
      this.setMsg(this.rMsg, pendingRoomNotice.text, pendingRoomNotice.kind)
      pendingRoomNotice = null
    } else {
      this.setMsg(this.rMsg, '', 'wait')
    }
    this.scrollToMe = true
    this.paintRoom(room)
  }

  exit(): void {
    this.on = null
    this.stopPoll()
  }

  // -------------------------------------------------------------------------
  // The directory
  // -------------------------------------------------------------------------

  private startPoll(): void {
    if (this.pollTimer) return
    void this.refresh(this.firstLoadDone ? 'poll' : 'first')
    this.pollTimer = window.setInterval(() => { void this.refresh('poll') }, POLL_MS)
  }

  private stopPoll(): void {
    if (this.holdTimer) { window.clearTimeout(this.holdTimer); this.holdTimer = 0 }
    this.holdUntil = 0
    if (!this.pollTimer) return
    window.clearInterval(this.pollTimer)
    this.pollTimer = 0
  }

  /**
   * A filter the player just changed.
   *
   * Flushes the pin and resets the "first load" flag so the list shows its
   * loading state rather than silently holding the previous filter's rows while
   * the new ones are in the air -- which would read as a filter that did
   * nothing. This is the one moment a jump is correct: the player caused it.
   */
  private filterChanged(): void {
    this.pendingStructure = 0
    this.bPill.hidden = true
    void this.refresh('filter')
  }

  private async refresh(reason: 'first' | 'poll' | 'manual' | 'retry' | 'filter'): Promise<void> {
    const svc = this.service()
    if (!svc) {
      this.showError('Multiplayer is not available in this build.', this.svcError, false)
      return
    }
    const seq = ++this.reqSeq
    if (reason !== 'poll') this.bRefresh.disabled = true
    if (!this.firstLoadDone || reason === 'filter') this.showLoading()
    const res = await svc.list(this.filter)
    if (reason !== 'poll') this.bRefresh.disabled = false
    // RESPONSES OVERTAKE EACH OTHER. net/mock.ts measured 126 inversions in 276
    // pairs across 24 back-to-back calls, which is not the mock being unkind --
    // it is a fat-tailed latency distribution behaving like one. Without this
    // guard a slow poll landing after a fast one paints a list that is older
    // than the one already on screen, and the browser appears to flicker
    // backwards in time.
    if (seq <= this.appliedSeq) return
    this.appliedSeq = seq
    if (this.on !== 'browser') return

    if (!res.ok) {
      // A FAILURE DOES NOT EMPTY THE LIST. "Could not refresh" and "there are no
      // lobbies" are different facts and the second one is a lie. If there are
      // rows on screen they stay, and the status line says how old they are.
      if (this.shown.length > 0) {
        this.bStatus.dataset.kind = 'bad'
        this.bStatus.textContent =
          `Could not refresh (${res.error}). Showing the list from ${this.ago()}.`
        return
      }
      this.showError('The lobby directory did not answer.',
        `The request came back "${res.error}". Nothing is wrong with your lobby — `
        + 'the list is.', true)
      return
    }

    this.firstLoadDone = true
    this.lastOkAt = Date.now()
    // THE PIN ONLY HOLDS BACK CHANGES THE PLAYER DID NOT ASK FOR. A poll is
    // the world moving underneath them and is held; a filter, a manual refresh
    // or a retry is something they just did, and holding one of those back
    // produces a search box that appears not to work whenever the pointer
    // happens to be resting over the list -- which, since the list is most of
    // the screen, is most of the time.
    this.apply([...res.value].sort(byNameThenId), reason !== 'poll')
  }

  /**
   * Paint a directory answer, honouring the pin.
   *
   * @param force this answer is the player's own doing, so it lands whatever
   *        the pointer is over.
   */
  private apply(rows: readonly LobbySummary[], force = false): void {
    this.model = [...rows]
    const wantIds = rows.map((r) => r.id)

    if (rows.length === 0 && (force || !this.pinned())) {
      this.clearRows()
      this.showEmpty()
      this.pendingStructure = 0
      this.bPill.hidden = true
      return
    }

    const structural = !sameKeys(this.shown, wantIds)
    if (structural && !force && this.pinned()) {
      // IN-PLACE ONLY. Every row that is still there gets its new numbers; the
      // ones that went away say so where they stand instead of vanishing from
      // under the pointer, which is the same courtesy net/types.ts extends to a
      // `closed` lobby and for the same reason.
      const live = new Map(rows.map((r) => [r.id, r]))
      let gone = 0
      for (const id of this.shown) {
        const row = this.rows.get(id)
        if (!row) continue
        const next = live.get(id)
        if (next) {
          this.paintRow(row, next)
          row.root.classList.remove('is-gone')
        } else {
          gone++
          row.root.classList.add('is-gone')
          row.status.textContent = 'Gone'
          row.root.dataset.status = 'closed'
          row.root.disabled = true
        }
      }
      const added = wantIds.filter((id) => !this.rows.has(id)).length
      this.pendingStructure = added + gone
      this.bPill.textContent = this.pendingStructure === 1
        ? '1 change waiting'
        : `${this.pendingStructure} changes waiting`
      this.bPill.hidden = this.pendingStructure === 0
      this.paintStatus(rows.length, true)
      return
    }

    this.reconcile(rows)
    this.pendingStructure = 0
    this.bPill.hidden = true
    this.paintStatus(rows.length, false)
  }

  /** The pointer, the keyboard or a recent finger is standing on the list. */
  private pinned(): boolean {
    if (this.pointerInList) return true
    if (Date.now() < this.holdUntil) return true
    const a = document.activeElement
    if (!(a instanceof Element) || !this.bList.contains(a)) return false
    // `:focus-visible`, NOT `:focus`, AND THAT DISTINCTION IS THE WHOLE RULE.
    //
    // The focus half of the pin exists for the keyboard and the gamepad: a
    // player standing on a row with the arrows has the same claim on it as a
    // mouse hovering one. But a TAP also focuses a button, and on a phone
    // nothing takes that focus away again -- so counting plain `:focus` froze
    // the list permanently the first time anybody chose a row. `:focus-visible`
    // is the browser's own answer to "was this focus driven by a keyboard",
    // which is exactly the question being asked, and it leaves the tap case to
    // the timed hold where it belongs.
    try {
      return a.matches(':focus-visible')
    } catch {
      // A browser without :focus-visible. Pinning is the conservative answer:
      // a list that holds still too long is recoverable, one that moves under a
      // press is not.
      return true
    }
  }

  /**
   * Somebody touched or scrolled the list: hold it still for a beat.
   *
   * The timer is what lets go again. Unlike the hover pin -- which ends when
   * the pointer leaves, an event the browser will definitely deliver -- a touch
   * has no matching "finger left the screen for good", so the release has to be
   * scheduled or the list would freeze on the first tap and never recover.
   */
  private touch(): void {
    this.holdUntil = Date.now() + TOUCH_HOLD_MS
    if (this.holdTimer) window.clearTimeout(this.holdTimer)
    this.holdTimer = window.setTimeout(() => {
      this.holdTimer = 0
      this.flush()
    }, TOUCH_HOLD_MS + 50)
  }

  /**
   * Let the held-back structural changes through.
   *
   * @param force a press on the pill, which outranks the pin. Everything else
   *        is a release -- the pointer leaving, or focus going elsewhere -- and
   *        those have to re-check the OTHER half of the pin before they move
   *        anything, because a mouse can leave a list a keyboard is still
   *        standing in.
   */
  private flush(force = false): void {
    if (force) { this.holdUntil = 0 }
    if (this.pendingStructure === 0 || this.on !== 'browser') return
    if (!force && this.pinned()) return
    this.pendingStructure = 0
    this.bPill.hidden = true
    if (this.model.length === 0) {
      this.clearRows()
      this.showEmpty()
      return
    }
    this.reconcile(this.model)
    this.paintStatus(this.model.length, false)
  }

  /**
   * Bring the laid-out rows in line with the model, keyed by lobby id.
   *
   * Rows are MOVED, never rebuilt: a row that is already in the DOM keeps its
   * element, its hover, its focus and its scroll position. Only genuinely new
   * lobbies allocate, and only genuinely departed ones are removed.
   */
  private reconcile(rows: readonly LobbySummary[]): void {
    const wanted = new Set(rows.map((r) => r.id))
    for (const [id, row] of this.rows) {
      if (wanted.has(id)) continue
      row.root.remove()
      this.rows.delete(id)
      if (this.chosen === id) this.choose(null)
    }
    let prev: HTMLElement | null = null
    for (const s of rows) {
      let row = this.rows.get(s.id)
      if (!row) {
        row = this.buildRow(s)
        this.rows.set(s.id, row)
      }
      row.root.classList.remove('is-gone')
      this.paintRow(row, s)
      // insertBefore with the node that SHOULD follow it. Cheap when nothing
      // moved -- the browser no-ops an insert of a node already in place.
      const after: Node | null = prev ? prev.nextSibling : this.bList.firstChild
      if (after !== row.root) this.bList.insertBefore(row.root, after)
      prev = row.root
    }
    this.shown = rows.map((r) => r.id)
    this.bLoading.hidden = true
    this.bEmpty.hidden = true
    this.bError.hidden = true
    this.bList.hidden = false
    // The column header labels columns; with no rows under it there are none,
    // and a header floating over an error message is furniture.
    this.bColHead.hidden = false
    this.setControls(true)
  }

  private buildRow(s: LobbySummary): Row {
    const root = button('sglb__row', this.bList, '')
    root.dataset.lobby = s.id
    const name = el('span', 'sglb__cell sglb__col--name', root, '')
    const host = el('span', 'sglb__cell sglb__col--host', root, '')
    const region = el('span', 'sglb__cell sglb__col--region', root, '')
    const ping = el('span', 'sglb__cell sglb__col--ping', root, '')
    const players = el('span', 'sglb__cell sglb__col--players', root, '')
    const access = el('span', 'sglb__cell sglb__col--access', root, '')
    const trackCell = el('span', 'sglb__cell sglb__col--track', root, '')
    // TWO SPANS IN ONE CELL, not a ninth column and not one string. A column
    // would have to be reserved on every row for a field most rows do not
    // have, on a grid that is already eight wide at 412px; one string could
    // not be styled apart, and the round badge has to be quieter than the
    // circuit name or it reads as the more important of the two.
    const track = el('span', 'sglbs__rowTrack', trackCell, '')
    const round = el('span', 'sglbs__rowRound', trackCell, '')
    round.hidden = true
    const status = el('span', 'sglb__cell sglb__col--status', root, '')
    root.addEventListener('click', () => this.choose(s.id))
    return { root, name, host, region, ping, players, access, track, round, status, data: s }
  }

  /**
   * One row's fields.
   *
   * NOTHING IN HERE MAY CHANGE THE ROW'S HEIGHT. Every cell is text into a
   * fixed grid column, the ping column is sized in `ch` so a dash and "142 ms"
   * occupy the same width, and no element is added or removed. A row that grew
   * by a line when its status changed would shift every row below it -- which
   * is the bug the pin is fighting, arriving through the back door.
   */
  private paintRow(row: Row, s: LobbySummary): void {
    row.data = s
    row.name.textContent = s.name
    row.host.textContent = s.hostName
    row.region.textContent = REGION_SHORT[s.region] ?? s.region
    paintPing(row.ping, s.pingMs)
    row.players.textContent = `${s.players}/${s.maxPlayers}`
    row.access.textContent = s.private ? 'Private' : 'Public'
    row.access.dataset.access = s.private ? 'private' : 'public'
    /**
     * THE CIRCUIT, AND THE ROUND IF THERE IS ONE.
     *
     * A length-1 lobby says "Elkarim · 3L" and nothing else, which is what it
     * said before series existed and what the contract insists it keeps
     * saying: "Length 1 must still read as a single race." A series adds one
     * span, INSIDE the same cell and on the same line, because the row's
     * height is the one thing this list may never change -- see the header on
     * the pin, and lobby.css's own opening paragraph.
     */
    const isSeries = s.seriesLength > 1
    row.track.textContent = trackName(s.trackId) + ' · ' + s.laps + 'L'
    row.round.textContent = isSeries ? `R${s.seriesRound}/${s.seriesLength}` : ''
    row.round.hidden = !isSeries
    row.root.dataset.series = isSeries ? String(s.seriesLength) : ''
    row.status.textContent = STATUS_LABEL[s.status]
    row.root.dataset.status = s.status
    row.root.classList.toggle('is-mine', s.hostId === this.deps.playerId())
    row.root.classList.toggle('is-sel', this.chosen === s.id)
    // ONLY `closed` IS UNPRESSABLE. A full or racing lobby is left live on
    // purpose: the poll is four seconds behind the world, a seat can free up or
    // a race can end inside that window, and `JoinError` exists precisely so a
    // try that loses the race can be answered. A row that refuses to be pressed
    // is a row that can never be wrong and can never be right either.
    row.root.disabled = s.status === 'closed'
    row.root.setAttribute('aria-label',
      `${s.name}, hosted by ${s.hostName}, ${REGION_SHORT[s.region] ?? s.region}, `
      + `${s.players} of ${s.maxPlayers} players, ${s.private ? 'private' : 'public'}, `
      + `${trackName(s.trackId)}, ${s.laps} laps, `
      + (isSeries ? `round ${s.seriesRound} of ${s.seriesLength}, ` : '')
      + `${STATUS_LABEL[s.status]}, `
      + `ping ${s.pingMs == null ? 'unknown' : Math.round(s.pingMs) + ' milliseconds'}`)
  }

  private clearRows(): void {
    for (const row of this.rows.values()) row.root.remove()
    this.rows.clear()
    this.shown = []
    this.choose(null)
  }

  private choose(id: string | null): void {
    this.chosen = id
    for (const [key, row] of this.rows) row.root.classList.toggle('is-sel', key === id)
    this.bCode.value = ''
    this.paintFoot()
    const row = id ? this.rows.get(id) : null
    if (row?.data.private) {
      // Focus the code field: a private row that needs a code and does not put
      // the caret in it makes the player hunt for the one control that matters.
      try { this.bCode.focus({ preventScroll: true }) } catch { this.bCode.focus() }
    }
  }

  private paintFoot(): void {
    const row = this.chosen ? this.rows.get(this.chosen) : null
    const s = row?.data ?? null
    this.bCodeWrap.hidden = !s?.private
    if (!s) {
      this.bFootText.textContent = 'Choose a lobby to join, or host one of your own.'
      this.bFootText.dataset.kind = 'idle'
      this.bJoin.disabled = true
      return
    }
    const bits = [`${s.name} · ${s.hostName}`, `${s.players}/${s.maxPlayers}`,
      trackName(s.trackId)]
    if (s.private) bits.push('needs a code')
    this.bFootText.textContent = bits.join(' · ')
    this.bFootText.dataset.kind = 'chosen'
    this.bJoin.disabled = this.joining
      || (s.private && this.bCode.value.trim().length < 4)
  }

  private paintStatus(n: number, pinned: boolean): void {
    this.bStatus.dataset.kind = 'ok'
    const bits = [n === 1 ? '1 lobby' : `${n} lobbies`]
    bits.push('updated ' + this.ago())
    if (pinned) bits.push('holding still while you read')
    this.bStatus.textContent = bits.join(' · ')
  }

  private ago(): string {
    if (!this.lastOkAt) return 'just now'
    const s = Math.max(0, Math.round((Date.now() - this.lastOkAt) / 1000))
    return s <= 1 ? 'just now' : s + 's ago'
  }

  /** The filter bar and Host, on or off together. */
  private setControls(on: boolean): void {
    for (const c of [this.bSearchEl, this.bRegionEl]) c.disabled = !on
    for (const c of [this.bJoinable, this.bRefresh, this.bHost]) c.disabled = !on
  }

  private showLoading(): void {
    if (this.shown.length > 0) return
    this.bLoading.hidden = false
    this.bEmpty.hidden = true
    this.bError.hidden = true
    this.bList.hidden = true
    this.bColHead.hidden = true
    this.bStatus.dataset.kind = 'wait'
    this.bStatus.textContent = 'Asking the directory…'
  }

  private showEmpty(): void {
    const filtered = this.filter.region !== 'any' || this.filter.joinableOnly
      || (this.filter.search ?? '') !== ''
    this.bEmpty.textContent = filtered
      ? 'No lobbies match those filters. Widen them, or host one of your own.'
      : 'Nobody is hosting right now. Be the first — press Host a lobby.'
    this.bEmpty.dataset.state = filtered ? 'empty-filtered' : 'empty'
    this.bEmpty.hidden = false
    this.bLoading.hidden = true
    this.bError.hidden = true
    this.bList.hidden = true
    this.bColHead.hidden = true
    this.setControls(true)
    this.bStatus.dataset.kind = 'ok'
    this.bStatus.textContent = '0 lobbies · updated ' + this.ago()
  }

  /** @param retry whether trying again could plausibly help. */
  private showError(text: string, detail: string, retry: boolean): void {
    this.bErrorText.textContent = text
    this.bErrorDetail.textContent = detail
    this.bError.hidden = false
    // NOTHING ELSE ON THE SCREEN PRETENDS TO WORK. A filter bar over an error,
    // and a Host button that leads to a form whose Create can only fail, are
    // three more controls offering to do something the screen has just said it
    // cannot do. A failure that might pass -- a request that did not answer --
    // leaves them alone: filtering and hosting are both plausible next moves.
    this.setControls(retry)
    // ...and the join bar stops inviting a choice there is nothing to choose
    // from. "Choose a lobby to join, or host one of your own" over an error is
    // the screen contradicting itself in two places at once.
    this.chosen = null
    this.bCodeWrap.hidden = true
    this.bJoin.disabled = true
    this.bFootText.dataset.kind = retry ? 'idle' : 'bad'
    this.bFootText.textContent = retry
      ? 'Nothing to choose from until the directory answers.'
      : 'Single player and the Grand Circuit are unaffected.'
    // The button is the difference between "this build cannot do multiplayer"
    // and "that request failed"; offering a retry for the first would be
    // offering a button that can only ever fail.
    const btn = this.bError.querySelector('button')
    if (btn instanceof HTMLButtonElement) btn.hidden = !retry
    this.bLoading.hidden = true
    this.bEmpty.hidden = true
    this.bList.hidden = true
    this.bColHead.hidden = true
    this.bStatus.dataset.kind = 'bad'
    this.bStatus.textContent = 'The directory is unreachable.'
  }

  private notice(text: string): void {
    this.bNotice.textContent = text
    this.bNotice.hidden = text === ''
  }

  // -------------------------------------------------------------------------
  // Joining
  // -------------------------------------------------------------------------

  private async joinChosen(): Promise<void> {
    const id = this.chosen
    const svc = this.service()
    if (!id || !svc || this.joining) return
    const row = this.rows.get(id)
    this.joining = true
    this.bJoin.disabled = true
    this.notice('')
    this.bFootText.textContent = `Joining ${row?.data.name ?? 'lobby'}…`
    this.bFootText.dataset.kind = 'wait'
    const code = this.bCode.value.trim()
    const res = await svc.join(id, code || undefined)
    this.joining = false
    if (!res.ok) {
      // Every case, and the compiler checked the table.
      this.bFootText.textContent = JOIN_ERROR[res.error]
      this.bFootText.dataset.kind = 'bad'
      this.bJoin.disabled = false
      // A join that failed because the row was stale deserves fresh rows.
      if (res.error === 'notfound' || res.error === 'full' || res.error === 'racing') {
        void this.refresh('manual')
      }
      return
    }
    this.enterRoom(res.value)
  }

  private enterRoom(room: LobbyRoom): void {
    this.roomModel = room
    // IN A ROOM IS THE END OF THE LAST ROOM'S STORY. Held rather than dropped
    // on the way out, so this is where it stops being true.
    this.closedNotice = ''
    this.stopPoll()
    // The garage's choice follows the player into the lobby. Fire and forget:
    // `setLoadout` returns void and the push that follows is the truth.
    const car = this.deps.loadout()
    void this.service()?.setLoadout(car.chassisId, car.pilotId)
    this.scrollToMe = true
    this.paintRoom(room)
    this.deps.goto('room')
  }

  // -------------------------------------------------------------------------
  // Creating
  // -------------------------------------------------------------------------

  /** The circuits this create screen would commit, in running order. */
  private plannedTracks(): string[] {
    return seriesTracks(this.cTrackId, this.cSeries, CIRCUIT_TRACK_IDS)
  }

  private paintCreate(): void {
    for (const b of this.cMax) b.classList.toggle('is-on', b.dataset.max === String(this.cMaxPlayers))
    for (const b of this.cVis) b.classList.toggle('is-on', b.dataset.private === String(this.cPrivate))
    for (const b of this.cTracks) b.classList.toggle('is-on', b.dataset.track === this.cTrackId)
    for (const b of this.cLaps) b.classList.toggle('is-on', b.dataset.laps === String(this.cLapCount))
    for (const b of this.cLens) b.classList.toggle('is-on', b.dataset.series === String(this.cSeries))
    for (const b of this.cDiffs) b.classList.toggle('is-on', b.dataset.diff === this.cDifficulty)
    this.cDiffHint.textContent = DIFFICULTY_SPECS[this.cDifficulty].blurb

    const series = this.cSeries > 1
    // THE WORD "CIRCUIT" CHANGES MEANING WITH THE LENGTH, so the label does
    // too. Leaving it as "Circuit" above a list of eight when the host has
    // chosen five rounds reads as a contradiction they have to resolve.
    this.cTrackK.textContent = series ? 'Opening circuit' : 'Circuit'
    this.cSeriesHint.textContent = series
      ? `${this.cSeries} rounds, scored ${SERIES_POINTS_LINE}. Everybody keeps their `
        + 'grid slot for the whole series — a driver who leaves keeps their points and '
        + 'scores nothing for the rounds they miss.'
      : 'One race, one result. No points table and no rounds.'

    // The order, as rows, and only when there is an order to show. A one-round
    // "running order" is a list of one, which is the circuit button the host
    // just pressed said back to them.
    this.cOrder.hidden = !series
    if (series) {
      const ids = this.plannedTracks()
      this.cOrder.textContent = ''
      el('div', 'sglb__k', this.cOrder, 'Running order')
      const list = el('div', 'sglbs__orderList', this.cOrder)
      for (let i = 0; i < ids.length; i++) {
        const row = el('div', 'sglbs__orderRow', list)
        row.dataset.round = String(i + 1)
        el('span', 'sglbs__orderN', row, String(i + 1))
        el('span', 'sglbs__orderName', row, trackName(ids[i]))
        el('span', 'sglbs__orderWorld', row, copyFor(ids[i]).world)
      }
    }

    const rounds = series ? this.cSeries : 1
    const lap = (n: number): string => `${n} ${n === 1 ? 'lap' : 'laps'}`
    this.cLapHint.textContent = series
      ? `${lap(this.cLapCount)} in every round — ${lap(this.cLapCount * rounds)} of racing in all.`
      : 'How far the race runs.'

    const named = this.cName.value.trim().length > 0
    this.cGo.disabled = this.creating || !named
    if (!this.creating) {
      this.cGo.textContent = named
        ? (series ? `Create ${this.cSeries}-round lobby` : 'Create lobby')
        : 'Name it first'
    }
  }

  private async doCreate(): Promise<void> {
    const svc = this.service()
    if (!svc || this.creating) return
    const name = this.cName.value.trim()
    if (!name) return
    this.creating = true
    this.paintCreate()
    this.cGo.textContent = 'Creating…'
    this.setMsg(this.cMsg, 'Advertising your lobby…', 'wait')
    const opts: CreateLobbyOptions = {
      name,
      region: this.cRegion.value as RegionId,
      maxPlayers: this.cMaxPlayers,
      private: this.cPrivate,
      // A SINGLE RACE GOES DOWN THIS LINE TOO, as a series of one. There is no
      // `if (single)` anywhere in this screen and there is not meant to be:
      // the contract's whole argument for `length: 1` is that one shape means
      // one code path, and a UI that built a different options object for a
      // one-off would be the second path arriving through the front door.
      series: {
        length: this.cSeries,
        trackIds: this.plannedTracks(),
        laps: this.cLapCount,
        difficulty: this.cDifficulty,
      },
    }
    const res = await svc.create(opts)
    this.creating = false
    this.paintCreate()
    if (!res.ok) {
      this.setMsg(this.cMsg,
        `The directory would not take it (${res.error}). Nothing was created — try again.`,
        'bad')
      return
    }
    this.setMsg(this.cMsg, '', 'wait')
    this.enterRoom(res.value)
  }

  // -------------------------------------------------------------------------
  // The room
  // -------------------------------------------------------------------------

  private onRoom(room: LobbyRoom | null): void {
    if (!room) {
      this.roomModel = null
      if (this.on === 'room') this.deps.goto('browser')
      return
    }
    this.roomModel = room
    if (this.on === 'room') this.paintRoom(room)
  }

  /**
   * The room ended under us.
   *
   * `unreachable` IS ITS OWN SENTENCE AND THAT IS THE WHOLE REASON IT IS IN
   * THE ENUM. types.ts spells it out: between a tenth and a fifth of
   * peer-to-peer connections will not traverse NAT without a relay this
   * project does not have, which makes it the commonest way a real join fails,
   * and "that lobby ended unexpectedly" tells a player nothing they can act
   * on. `detail` carries whatever the transport actually knows.
   *
   * ------------------------------------------------------------------------
   * `detail` REPLACES THE SENTENCE RATHER THAN TRAILING IT IN BRACKETS, WHICH
   * IS A CHANGE AND IS WORTH THE PARAGRAPH.
   *
   * It used to render as `${text} (${detail})`, which was right when a detail
   * was a fragment -- the ICE state a connection died in, developer's type
   * under a player's sentence, the same split the browser's error block makes.
   * Host migration and rejoin changed what arrives. Both of `net/live.ts`'s
   * producers now pass a finished, player-facing account of what happened:
   *
   *   "Could not reach Ada, who took over when the host left. Thirty seconds
   *    was the whole budget and the race went on without us."
   *   "Could not get back to Ada in 30 seconds. Your car finished the round
   *    under the AI from the frame you went quiet."
   *
   * Prefixing the generic line to either is worse than useless. "The host
   * left, so that lobby closed" in front of the first one CONTRADICTS it --
   * the lobby did not close when the host left, that is the entire point of
   * migration, it closed thirty seconds later when the repair ran out -- and
   * the brackets frame the only sentence that describes this failure as an
   * aside to one that does not.
   *
   * The generic text is what remains when nothing more specific was said,
   * which is every mock closure and every `hostLeft` that really is just a
   * host leaving a lobby. Nothing is lost; the specific case stops being
   * overwritten by the general one.
   */
  private onClosed(reason: 'hostLeft' | 'kicked' | 'unreachable' | 'error', detail?: string): void {
    this.roomModel = null
    const text =
      reason === 'kicked' ? 'The host removed you from that lobby.'
        : reason === 'hostLeft' ? 'The host left, so that lobby closed. '
          + 'With no server in the middle, the host is the game.'
          : reason === 'unreachable' ? 'Your network and the host’s could not reach '
            + 'each other. Nothing is wrong with either of you — some pairs of '
            + 'connections cannot be introduced without a relay.'
            : 'That lobby ended unexpectedly.'
    const said = detail && detail.trim() ? detail.trim() : text
    /**
     * HELD AS WELL AS SHOWN, because this fires from the wire and the wire does
     * not care which screen is up. A room that ends mid-race closes while the
     * player is looking at a RACE: the branch below navigates nothing, the
     * notice is written to a browser screen nobody is on, and by the time they
     * walk back to it the round has put its own sentence up. So it is kept
     * until a screen actually reads it -- see `takeClosedNotice`.
     */
    this.closedNotice = said
    this.notice(said)
    if (this.on === 'room' || this.on === 'create') this.deps.goto('browser')
  }

  /**
   * Why the last room ended, once, or ''.
   *
   * TAKEN AND CLEARED, exactly as `pendingRoomNotice` is and for the same
   * reason: a closure is a thing that happened at a moment, and a screen still
   * explaining it two lobbies later is a screen that is wrong.
   */
  private takeClosedNotice(): string {
    const said = this.closedNotice
    this.closedNotice = ''
    return said
  }

  private paintRoom(room: LobbyRoom): void {
    this.roomModel = room
    const me = room.members.find((m) => m.playerId === room.localId) ?? null
    const isHost = me?.isHost === true

    this.rName.textContent = room.name
    this.rRegion.textContent = REGION_SHORT[room.region] ?? room.region
    this.rAccess.textContent = room.private ? 'Private' : 'Public'
    this.rAccess.dataset.access = room.private ? 'private' : 'public'
    // THE CODE IS THE HOST'S TO SHARE. Everyone in the room already got in, so
    // showing it to them is harmless; showing it to the host is the point,
    // because there is no other way for it to reach the friend it is for.
    this.rCodeWrap.hidden = room.joinCode == null
    if (room.joinCode) this.rCode.textContent = room.joinCode

    /**
     * WHERE THE SERIES IS.
     *
     * `round` counts rounds FINISHED, so the one coming next is `round + 1` and
     * `series.trackIds[round]` is the circuit it runs on -- the contract says
     * both in as many words, and everything below reads them and nothing
     * recomputes them. `over` is the state a five-round room spends its last
     * few minutes in: no next circuit, a final table, and a Start button that
     * has nothing left to start.
     */
    const len = room.series.length
    const isSeries = len > 1
    const over = room.round >= len
    const nextRound = Math.min(room.round + 1, len)
    const trackId = room.series.trackIds[Math.min(room.round, len - 1)] ?? ''
    const laps = room.series.laps

    this.rRound.hidden = !isSeries
    this.rRound.textContent = over ? `Series complete · ${len} rounds` : `Round ${nextRound} of ${len}`
    this.rRound.dataset.state = over ? 'over' : 'live'

    this.paintStandings(room, isSeries)

    const def = TRACKS_BY_ID[trackId]
    const copy = copyFor(trackId)
    // "CIRCUIT" ON A ONE-OFF, "ROUND 3" IN A SERIES. The panel answers a
    // different question in the two cases -- "where are we racing" versus
    // "what is next" -- and the title is the cheapest place to say which.
    this.rSideTitle.textContent = over ? 'THE SERIES' : isSeries ? `ROUND ${nextRound}` : 'CIRCUIT'
    this.rTrackName.textContent = over ? 'All rounds raced' : def ? def.name : trackId
    this.rTrackWorld.textContent = over
      ? `${len} rounds · ${laps} laps each`
      : `${copy.world} · ${laps} laps · ${copy.difficulty}`
    this.rTrackHook.textContent = over ? '' : copy.hook ? `"${copy.hook}"` : ''
    this.rTrackNote.textContent = over
      ? 'The table on the left is final. Leave when you are ready, or the host '
        + 'can host another.'
      : copy.note
    this.rGuestNote.textContent = isHost || over
      ? '' : `Only ${room.members.find((m) => m.isHost)?.name ?? 'the host'} can change this.`

    // The rest of the running order, rounds already raced included, so a
    // player who joined at round 3 can see what they missed and what is left.
    this.paintOrder(room, isSeries)

    for (const btn of this.rTrackList.querySelectorAll('button')) {
      const id = btn.dataset.track ?? ''
      btn.classList.toggle('is-on', id === trackId)
      // A CIRCUIT THAT IS ALREADY SOMEWHERE ELSE IN THE ORDER CANNOT BE
      // CHOSEN, because the contract promises no repeats and `setTrack` edits
      // one round rather than the plan. Greyed rather than hidden: the roster
      // is a fixed eight and a list that shrank as the series went on would
      // make the host hunt for a button that had moved.
      btn.disabled = id !== trackId && room.series.trackIds.includes(id)
      btn.title = btn.disabled ? 'Already in this series.' : ''
    }
    for (const b of this.rLaps) b.classList.toggle('is-on', b.dataset.laps === String(laps))
    this.rChangeK.textContent = isSeries ? `Change round ${nextRound}'s circuit` : 'Change circuit'
    // A host whose series is over has nothing left to configure. The controls
    // would all still work and would all change a race that is not going to
    // happen.
    this.rHostOnly.hidden = !isHost || over

    this.rCount.textContent = `${room.members.length}/${room.maxPlayers}`
    this.paintMembers(room, isHost)

    const ready = me?.ready === true
    // THE LABEL IS THE ACTION, NOT THE STATE. A button that says "NOT READY"
    // is unreadable in the only way that matters: you cannot tell whether it is
    // reporting where you are or offering to take you somewhere. The row
    // already carries the state, in a word, in the members list.
    this.rReady.textContent = ready ? 'Stand down' : 'Ready up'
    this.rReady.setAttribute('aria-pressed', ready ? 'true' : 'false')
    this.rReady.classList.toggle('sg-btn--ghost', ready)
    // A member who is still connecting CANNOT be ready -- the service says so
    // and will overwrite an optimistic tick with the truth, so the control says
    // so first rather than lying for a round trip.
    // ...and a series that is over has nothing left to be ready FOR. The
    // control would still work and would still publish a ready, for a round
    // that cannot start -- which is a button that responds and achieves
    // nothing, the worst of the three available behaviours.
    this.rReady.disabled = this.readyBusy || me == null || me.connecting || over
    // START IS SHOWN TO EVERYBODY, DISABLED, WITH THE REASON.
    //
    // Hiding it from a guest is the tidier-looking choice and it is the wrong
    // one: the question a guest actually has in a lobby is "what are we waiting
    // for", and a missing button answers nothing while a greyed one with
    // "Waiting on Kestrel, Tsu" beside it answers it exactly. The control being
    // unavailable is not a secret -- who it belongs to is the information.

    if (this.scrollToMe) {
      this.scrollToMe = false
      this.scrollMembersToMe(room.localId)
      // AND IN THE TABLE, which is the list a player arriving from a finished
      // round is actually looking for themselves in. Eight rows in a panel
      // that shows five means the commonest outcome -- being somewhere in the
      // middle -- puts you off the bottom, and "You are 6th" underneath is an
      // answer to a question you had to ask rather than a row you can read.
      const mine = this.rStandRows.querySelector('.sglbs__row.is-you')
      if (mine instanceof HTMLElement) {
        this.rStandRows.scrollTop = Math.max(0,
          mine.offsetTop - (this.rStandRows.clientHeight - mine.offsetHeight) / 2)
      }
    }

    const why = this.startBlock(room, me, isHost)
    this.rWhy.textContent = why
    this.rWhy.dataset.blocked = why ? 'yes' : 'no'
    this.rStart.disabled = this.starting || why !== ''
  }

  /**
   * The series table, or nothing at all.
   *
   * REBUILT RATHER THAN POOLED, deliberately, and it is the opposite call from
   * the one the directory rows get. That list is repainted every four seconds
   * by a poll and a rebuild there drops focus and kills a hover mid-click;
   * this one changes exactly once per round -- a push arrives, the table is
   * new -- and eight rows of five spans is not worth a pool that has to be
   * kept in step with a row count that can change when somebody joins.
   *
   * THE ORDER COMES FROM game/circuit.ts, through `seriesRanking`. Points,
   * countback, shared places and the total order that stops rows swapping
   * between two renders of the same data are all already argued and already
   * tested there; a lobby screen sorting its own table would be a second
   * answer to a question single player has settled.
   */
  private paintStandings(room: LobbyRoom, isSeries: boolean): void {
    const table = room.standings
    // Round 1 has no table yet, and a single race never will. Both are
    // "nothing has happened", not "nothing to show".
    const show = isSeries && table.length > 0 && room.round > 0
    this.rStand.hidden = !show
    if (!show) return

    const len = room.series.length
    const over = room.round >= len
    this.rStandTitle.textContent = over ? 'FINAL STANDINGS' : 'STANDINGS'
    this.rStandAfter.textContent = over ? `${len} rounds` : `after ${room.round} of ${len}`

    const ranked = seriesRanking(table)
    this.rStandRows.textContent = ''
    for (const r of ranked) {
      const row = table[r.entrant.id]
      if (!row) continue
      const node = el('div', 'sglbs__row', this.rStandRows)
      node.dataset.place = String(r.place)
      if (row.isLocal) node.classList.add('is-you')
      // AN EMPTY SEAT IS MARKED. A driver with no playerId is either an AI car
      // that has been on the grid all along or a person whose slot the AI
      // took over; either way the row stays, because the rounds they raced
      // happened. See types.ts on not deleting a driver mid-series.
      if (row.playerId === null) node.classList.add('is-ai')
      el('span', 'sglbs__place', node, ordinal(r.place))
      const who = el('span', 'sglbs__who', node)
      if (row.avatarId) avatarInto(el('span', 'sglbs__avatar', who), row.avatarId)
      el('span', 'sglbs__name', who, row.name)
      // ONE CELL PER ROUND, ZEROES INCLUDED, and a dash rather than a zero for
      // a round that has not been raced yet. "0" and "not yet" are different
      // facts and a table that printed the same glyph for both would be
      // telling a driver who missed round 2 and a driver who has not reached
      // round 4 the same thing.
      const runs = el('span', 'sglbs__runs', node)
      for (let n = 0; n < len; n++) {
        const pos = row.finishes[n]
        const cell = el('span', 'sglbs__run', runs, pos === undefined ? '·' : pos > 0 ? String(pos) : '—')
        cell.dataset.pos = pos ? String(pos) : pos === 0 ? 'none' : 'future'
        cell.title = pos === undefined
          ? `Round ${n + 1} has not been raced`
          : pos > 0 ? `Round ${n + 1}: ${ordinal(pos)}` : `Round ${n + 1}: no score`
      }
      el('span', 'sglbs__pts', node, String(r.points))
    }

    const me = ranked.find((r) => table[r.entrant.id]?.isLocal) ?? null
    this.rStandYou.textContent = me
      ? `You are ${ordinal(me.place)} on ${me.points} ${me.points === 1 ? 'point' : 'points'}.`
      : 'You are not in this table yet.'
  }

  /** The running order, with the round that is next marked. */
  private paintOrder(room: LobbyRoom, isSeries: boolean): void {
    this.rOrder.hidden = !isSeries
    if (!isSeries) return
    this.rOrder.textContent = ''
    el('div', 'sglb__k', this.rOrder, 'Running order')
    const list = el('div', 'sglbs__orderList', this.rOrder)
    for (let i = 0; i < room.series.trackIds.length; i++) {
      const row = el('div', 'sglbs__orderRow', list)
      row.dataset.round = String(i + 1)
      // Three states and they are all worth distinguishing: raced, next, and
      // still to come. A list where the only marked row is the current one
      // makes a player count backwards to work out what they have missed.
      row.dataset.state = i < room.round ? 'done' : i === room.round ? 'next' : 'todo'
      el('span', 'sglbs__orderN', row, String(i + 1))
      el('span', 'sglbs__orderName', row, trackName(room.series.trackIds[i]))
      el('span', 'sglbs__orderWorld', row, copyFor(room.series.trackIds[i]).world)
    }
  }

  /**
   * WHY START IS NOT AVAILABLE, IN ONE SENTENCE, OR '' WHEN IT IS.
   *
   * The reasons are in the order a host meets them, and every one of them is a
   * fact about the room rather than a guess: `start()` in the contract "fails if
   * anybody is unready or still connecting", host included, and a disabled
   * button with no reason next to it is the single most common way a lobby
   * screen wastes somebody's evening.
   *
   * NOTE WHAT IS DELIBERATELY NOT A REASON: being on your own. A one-person
   * lobby can genuinely start -- the other seven seats fill with AI -- so
   * refusing it here would be the UI inventing a rule the service does not
   * have. It gets an advisory line instead, in paintMembers.
   */
  private startBlock(room: LobbyRoom, me: LobbyMember | null, isHost: boolean): string {
    // A SERIES THAT IS OVER IS OVER, and it is the first thing asked because
    // every reason below it is about a race that is not going to happen.
    // Said the same way to the host and to a guest: nobody is waiting for
    // anybody, which is the one case where "what are we waiting for" has the
    // answer "nothing".
    if (room.round >= room.series.length && room.series.length > 1) {
      return 'Every round has been raced. The standings are final.'
    }
    if (!isHost) {
      const host = room.members.find((m) => m.isHost)
      const waiting = room.members.filter((m) => !m.ready || m.connecting).length
      const who = host ? host.name : 'the host'
      return waiting > 0
        ? `${who} starts the race — ${waiting} still to ready up.`
        : `Everyone is ready. Waiting for ${who} to start.`
    }
    if (room.status === 'racing') return 'This lobby is already racing.'
    const connecting = room.members.filter((m) => m.connecting)
    if (connecting.length > 0) {
      return connecting.length === 1
        ? `Waiting for ${connecting[0].name} to connect.`
        : `Waiting for ${connecting.length} players to connect.`
    }
    const unready = room.members.filter((m) => !m.ready)
    if (unready.length === 0) return ''
    if (unready.length === 1 && me && unready[0].playerId === me.playerId) {
      return 'Ready up yourself — hosting does not count as ready.'
    }
    // YOUR OWN NAME IS "you". A host reading "Waiting on Racer 6692" about
    // themselves has to work out that it is them, which is a puzzle a lobby
    // screen has no business setting.
    const names = unready.slice(0, 3)
      .map((m) => (me && m.playerId === me.playerId ? 'you' : m.name)).join(', ')
    const more = unready.length > 3 ? ` and ${unready.length - 3} more` : ''
    // "TO READY UP", NAMED. The earlier wording was "Waiting on you,
    // Ptarmigan." -- which names the people and never says what they have not
    // done, so a host reading it has to already know that Ready is the only
    // thing a lobby waits for. It also is not: the branch above waits for a
    // CONNECTION, and the two are different problems with different answers.
    // The guest's version of this line has always said "ready up"; this makes
    // the host's agree.
    return `Waiting for ${names}${more} to ready up.`
  }

  private paintMembers(room: LobbyRoom, isHost: boolean): void {
    const wanted = new Set(room.members.map((m) => m.playerId))
    for (const [id, row] of this.memberRows) {
      if (wanted.has(id)) continue
      row.root.remove()
      this.memberRows.delete(id)
    }
    let prev: HTMLElement | null = null
    for (const m of room.members) {
      let row = this.memberRows.get(m.playerId)
      if (!row) {
        row = this.buildMember(m.playerId)
        this.memberRows.set(m.playerId, row)
      }
      const isMe = m.playerId === room.localId
      avatarInto(row.avatar, m.avatarId)
      row.name.textContent = ''
      el('span', 'sglbr__who', row.name, m.name)
      if (m.isHost) el('span', 'sglbr__tag sglbr__tag--host', row.name, 'HOST')
      if (isMe) el('span', 'sg-you', row.name, 'YOU')
      row.car.textContent = `${carName(m.chassisId)} · ${pilotName(m.pilotId)}`
      // The host's own row is 0 by definition (they are the server), so it says
      // "host" rather than "0 ms", which would look like a measurement.
      if (m.isHost) {
        row.ping.textContent = 'host'
        row.ping.dataset.ping = 'host'
        row.ping.dataset.band = 'good'
        row.ping.setAttribute('aria-label', 'the host')
      } else {
        paintPing(row.ping, m.pingMs)
      }
      row.state.textContent = m.connecting ? 'Connecting' : m.ready ? 'Ready' : 'Not ready'
      row.state.dataset.state = m.connecting ? 'connecting' : m.ready ? 'ready' : 'unready'
      row.root.dataset.member = m.playerId
      row.root.classList.toggle('is-me', isMe)
      row.kick.hidden = !isHost || isMe
      row.kick.dataset.kick = m.playerId

      const after: Node | null = prev ? prev.nextSibling : this.rMembers.firstChild
      if (after !== row.root) this.rMembers.insertBefore(row.root, after)
      prev = row.root
    }
    // The advisory the start gate deliberately is not. See startBlock.
    const alone = room.members.length < LOBBY_MIN_PLAYERS
    this.rAlone.hidden = !alone
    this.rAlone.textContent = alone
      ? 'You are the only person here. The race will still run — the other seven '
        + 'cars will be AI.'
      : ''
  }

  /**
   * YOUR OWN ROW, ON SCREEN, WITHOUT SCROLLING FOR IT.
   *
   * The same problem the results standings already solved and the same answer:
   * at 412x915 a full eight-seat grid does not fit in the members panel and the
   * list opens at the top, so the player who arrives last -- which is always
   * the player who just joined -- lands on a list that does not contain them.
   * Centred rather than merely scrolled into view, because who you are sitting
   * between is most of what a lobby list is for.
   *
   * ON ARRIVAL ONLY, NOT ON EVERY PUSH. A room repaints every time anybody
   * readies up, and re-centring on each of those would drag the list out from
   * under a player who had scrolled somewhere else on purpose -- which is the
   * same class of rudeness the directory's pin exists to prevent.
   */
  private scrollMembersToMe(localId: string): void {
    requestAnimationFrame(() => {
      const row = this.memberRows.get(localId)?.root
      const host = this.rMembers
      if (!row || host.clientHeight <= 0 || !host.contains(row)) return
      host.scrollTop = Math.max(0, row.offsetTop - (host.clientHeight - row.offsetHeight) / 2)
    })
  }

  private buildMember(id: string): MemberRow {
    const root = el('div', 'sglbr__member', this.rMembers)
    root.dataset.member = id
    const avatar = el('span', 'sglb__avatar', root)
    const name = el('span', 'sglbr__mname', root)
    const car = el('span', 'sglbr__mcar', root)
    const ping = el('span', 'sglb__cell sglbr__mping', root)
    const state = el('span', 'sglbr__mstate', root)
    const kick = button('sglbr__kick', root, 'Kick')
    kick.hidden = true
    kick.addEventListener('click', () => { void this.kick(id) })
    return { root, avatar, name, car, ping, state, kick }
  }

  private async toggleReady(): Promise<void> {
    const svc = this.service()
    const room = this.roomModel
    if (!svc || !room) return
    const me = room.members.find((m) => m.playerId === room.localId)
    if (!me) return
    this.readyBusy = true
    // Rendered optimistically, exactly as the contract invites -- and the push
    // that follows overwrites it, which is how a refused ready (a member who is
    // still connecting) corrects itself without the screen having to guess.
    this.rReady.textContent = me.ready ? 'Ready up' : 'Stand down'
    this.rReady.disabled = true
    await svc.setReady(!me.ready)
    this.readyBusy = false
    const now = svc.current()
    if (now) this.paintRoom(now)
  }

  private async setTrack(trackId: string | null, laps: number | null): Promise<void> {
    const svc = this.service()
    const room = this.roomModel
    if (!svc || !room) return
    // The round COMING NEXT is the one `setTrack` edits, so the "leave it
    // alone" value for either argument is that round's, not round 1's.
    const at = Math.min(room.round, room.series.length - 1)
    const current = room.series.trackIds[at] ?? ''
    const res = await svc.setTrack(trackId ?? current, laps ?? room.series.laps)
    if (!res.ok) {
      this.setMsg(this.rMsg,
        res.error === 'notrack' && trackId && room.series.trackIds.includes(trackId)
          ? 'That circuit is already a round of this series.'
          : `Could not change the circuit (${res.error}).`, 'bad')
      return
    }
    this.paintRoom(res.value)
  }

  private async kick(playerId: string): Promise<void> {
    const svc = this.service()
    if (!svc) return
    await svc.kick(playerId)
    const now = svc.current()
    if (now) this.paintRoom(now)
  }

  private async doStart(): Promise<void> {
    const svc = this.service()
    if (!svc || this.starting) return
    this.starting = true
    this.rStart.disabled = true
    this.rStart.textContent = 'Starting…'
    const res = await svc.start()
    this.starting = false
    this.rStart.textContent = 'Start race'
    if (!res.ok) {
      this.setMsg(this.rMsg,
        res.error === 'notready'
          ? 'Somebody un-readied while that was in flight. Nothing started.'
          : `The race would not start (${res.error}).`, 'bad')
      const now = svc.current()
      if (now) this.paintRoom(now)
      return
    }
    // The host's copy of the packet arrives here AND through onStart. The
    // contract says so and asks the reader to be idempotent about it, which is
    // why nothing is done with `res.value` -- onStart already fired.
  }

  private async leave(): Promise<void> {
    const svc = this.service()
    this.roomModel = null
    this.notice('')
    if (svc) await svc.leave()
    this.deps.goto('browser')
  }

  private async copyCode(): Promise<void> {
    const code = this.roomModel?.joinCode
    if (!code) return
    try {
      await navigator.clipboard.writeText(code)
      this.rCopy.textContent = 'Copied'
    } catch {
      // Clipboard access is refused in plenty of contexts and the code is on
      // screen anyway, so this is a nicety that is allowed to fail quietly.
      this.rCopy.textContent = 'Read it out'
    }
    window.setTimeout(() => { this.rCopy.textContent = 'Copy' }, 1600)
  }

  private setMsg(host: HTMLElement, text: string, kind: 'ok' | 'bad' | 'wait'): void {
    host.textContent = text
    host.dataset.kind = kind
  }

  dispose(): void {
    this.stopPoll()
    if (this.searchTimer) { window.clearTimeout(this.searchTimer); this.searchTimer = 0 }
    this.svc?.dispose()
    this.svc = null
    for (const node of [this.browser, this.create, this.room]) {
      if (node.parentNode) node.parentNode.removeChild(node)
    }
  }
}

// ---------------------------------------------------------------------------

/** Name, then id. See the header: it is the only key nothing can change. */
function byNameThenId(a: LobbySummary, b: LobbySummary): number {
  const n = a.name.localeCompare(b.name)
  if (n !== 0) return n
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function createLobbyScreens(deps: LobbyDeps): LobbyScreens {
  return new LobbyScreensImpl(deps)
}
