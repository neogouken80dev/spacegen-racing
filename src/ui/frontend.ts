/**
 * SpaceGen Racing — front end.
 *
 * Ten screens: title, track, garage, results, paused, the four multiplayer
 * ones — the lobby browser, hosting a lobby, the room, and the player profile
 * — and the achievements wall (ui/achievements.ts, which owns it the way
 * ui/profile.ts owns the profile). Nothing stands between load and the first race: the title
 * screen is a logo and one huge PLAY button, and the two setup screens run in
 * the order a player thinks in — pick the planet, then pick the car to take to
 * it.
 *
 * THE FOUR MULTIPLAYER SCREENS LIVE IN ui/lobby.ts AND ui/profile.ts, and this
 * file owns only the containers they are dropped into and the rules for moving
 * between them. That is the same split the settings overlay took: a screen with
 * its own state machine and its own stylesheet does not belong inside the file
 * that switches screens, or that file becomes the place every feature lands.
 *
 * NOTHING MULTIPLAYER STARTS AT BOOT. `net/index.ts` is explicit that creating
 * a service attaches to the mock world and starts its clock, and that "nothing
 * should begin because a module was named". So the lobby screens build their
 * DOM in the constructor and reach for a service only when one of them is
 * actually shown, and the profile loads on its first entry rather than on the
 * title screen — a player who never presses Multiplayer never starts a
 * directory ticking.
 *
 * Unlike the HUD this is not on the frame budget, but every node is still
 * built once and reused so a rematch never leaks DOM. The exceptions are the
 * two vehicle previews -- the garage's, below, and the profile's Vehicle page
 * -- which really do run a render loop and really do hold a WebGL context of
 * their own, and are therefore built and torn down with the thing being
 * looked at rather than with the front end. Neither is ever alive at the same
 * time as the other or as a race. See ui/garagePreview.ts.
 *
 * THE CAR IS CHOSEN IN TWO PLACES AND STORED IN ONE. The garage is a step on
 * the way to a race; the profile's Vehicle and Pilot pages are somewhere you
 * go on purpose. `chassisId` and `pilotId` below are the only storage either
 * of them has, `selectChassis` / `selectPilot` are the only writers, and the
 * profile reaches them through the `loadout` / `setLoadout` pair it is
 * constructed with. ui/profile.ts's header argues the alternatives; this file
 * is the one holding the field.
 *
 * Every control on every screen is a real <button>. That is the whole
 * accessibility strategy: pointer, touch, keyboard and gamepad all converge on
 * one click event, so there is no second interaction model to keep in sync.
 */
import './styles.css'
import type { RaceState, RacerState } from '../sim/types'
import { CHASSIS } from '../content/chassis'
import type { ScoreEntry } from '../score/api'
import { createTabs, type TabStrip } from './tabs'
import { RECORD_ORDER, type RecordId, type TrackRecords } from '../score/records'
import type { GlobalBoard } from '../score/global'
import { PILOTS } from '../content/pilots'
import { TRACKS } from '../content/tracks'
import { Track, type SurfaceKind, type TrackDef } from '../sim/track'
import { copyFor, DIFFICULTY_RANK } from './trackCopy'
import { createGaragePreview, type GaragePreview } from './garagePreview'
import {
  CIRCUIT_ROUNDS, isComplete, pointsFor, roundsDone, standings, trackIdForRound,
  type CircuitState,
} from '../game/circuit'
import {
  asDifficulty, DEFAULT_DIFFICULTY, DIFFICULTIES, DIFFICULTY_SPECS, type Difficulty,
} from '../content/difficulty'
import { createLobbyScreens, type LobbyScreenId, type LobbyScreens } from './lobby'
import { createProfileScreen, type Loadout, type ProfileScreen } from './profile'
import { createAchievementsView, fillUnlockStrip, type AchievementsView } from './achievements'
import { lobbyService } from '../net'
import type { PlayerProfile, RaceStartPacket } from '../net/types'
import { cue } from '../audio/cues'

export type QualityTier = 'low' | 'medium' | 'high'
/**
 * Every screen this front end can be showing.
 *
 * The four multiplayer ids are spelled as they are because `show()` is what the
 * host calls and a host reading `show('lobbyNew')` should not have to guess
 * whether that is the browser or the create form.
 */
export type ScreenId =
  | 'title' | 'track' | 'garage' | 'results' | 'paused'
  | 'lobby' | 'lobbyNew' | 'room' | 'profile' | 'achievements'

export interface StartSelection {
  trackId: string
  chassisId: string
  pilotId: string
  quality: QualityTier
  /**
   * How hard the AI field drives, for THIS race.
   *
   * Carried on the selection rather than read from storage by the game,
   * because the garage screen is where the player chose it and a second read
   * somewhere else is a second chance to disagree. It IS persisted -- see
   * `selectDifficulty` -- so the choice survives a reload; the storage is the
   * default for the next visit, not the source for this race.
   */
  difficulty: Difficulty
}

export interface FrontEnd {
  root: HTMLElement
  /**
   * The track currently chosen, including the one restored from storage before
   * the player has touched anything. Read by the host to start fetching that
   * circuit's music while the player is still in the menus.
   */
  readonly selectedTrackId: string
  /**
   * The car and pilot currently chosen, restored-from-storage value included.
   *
   * Same contract as selectedTrackId and added for the same reason: the host
   * has to build a circuit's grid around whatever the player is driving BEFORE
   * they press Start, and the only other way to learn it is to wait for
   * onStart -- which is one screen too late.
   */
  readonly selectedChassisId: string
  readonly selectedPilotId: string
  show(screen: ScreenId): void
  hide(): void
  onStart: (sel: StartSelection) => void
  onRematch: () => void
  /** Optional extras the host may wire; all default to no-ops. */
  onResume: () => void
  onRestart: () => void
  onQuit: () => void
  /** Start a Grand Circuit from round 1, discarding any saved one. */
  onCircuitNew: () => void
  /** Resume the saved Grand Circuit at the round it left off. */
  onCircuitResume: () => void
  /**
   * Fired on every screen change, hide() included (which reports null).
   *
   * The host needs this because the title screen is no longer just a panel: it
   * has a live race running behind it, and the thing that owns that race is the
   * Game, not the front end. Rather than let the Game poll for "is the title up"
   * every frame, the front end says so once, when it changes.
   */
  onScreen: (screen: ScreenId | null) => void
  /**
   * @param trackId the circuit this race was actually run on. Optional only
   *        for compatibility: the front end's own remembered selection is the
   *        right answer for a single race and the WRONG one in circuit mode,
   *        where the series picks the track and the track screen is skipped --
   *        which put "ELKARIM — JUNKYARD PLANET" over a result from Namaresh.
   */
  showResults(state: RaceState, localId: number, run?: RunScore | null, trackId?: string): void
  /**
   * Fill the top-ten panel. Separate from showResults because the store is
   * async by design -- a local board answers instantly, a server one will not,
   * and the screen has to be able to appear before the board has arrived
   * rather than waiting on it.
   */
  setBoard(rows: readonly ScoreEntry[], rank: number, qualifies: boolean): void
  /**
   * Fill the track-records page. `broken` are the records this race just took,
   * which get highlighted and put a marker on the tab.
   */
  setRecords(records: TrackRecords, broken: readonly RecordId[]): void
  /** Fill the global page. An offline board renders as a stated fact. */
  setGlobal(board: GlobalBoard): void
  /**
   * The Grand Circuit, or null for no circuit at all.
   *
   * ONE ENTRY POINT FOR EVERY SCREEN THE CIRCUIT TOUCHES, because they have to
   * agree: the title screen's Continue button, the garage head, the primary
   * button on the results screen and whether the Circuit standings page exists
   * are four views of the same fact, and four setters is four chances for them
   * to disagree. Call it whenever the circuit changes; it is idempotent.
   */
  setCircuit(status: CircuitStatus | null): void
  /** The player named a qualifying run. */
  onSaveScore: (name: string) => void
  /**
   * A multiplayer race is starting.
   *
   * Fires for EVERY client, the host included, from `LobbyService.onStart` --
   * which is why the host's own press of Start does not also fire it. The
   * contract says the host receives the packet through both the return value
   * and the push and asks the reader to be idempotent; the simplest way to be
   * idempotent is to listen to one of them, and the push is the one every
   * client shares.
   *
   * The packet carries the seed, the ordered grid, `localPlayerId` and the
   * lockstep input delay -- everything `Race` needs and nothing it does not.
   * See `RaceStartPacket` in net/types.ts.
   */
  onMultiplayerStart: (packet: RaceStartPacket) => void
  /**
   * The player's account, whenever it changes.
   *
   * Wired so the host can put a claimed name and a chosen avatar on the local
   * car's nameplate without reaching into `net/` itself. Fires on the first
   * load and on every change after it -- and NEVER before the player has opened
   * a multiplayer screen, because nothing loads an account until they do.
   */
  onProfileChange: (profile: PlayerProfile) => void
  /**
   * What the race on the results screen unlocked, for its NEW BADGES strip.
   * Empty hides the strip. Separate from showResults for the reason setBoard
   * is: the host decides it after the round is banked, and a results screen
   * that waited on it would be a results screen that waited.
   */
  setUnlocks(ids: readonly string[]): void
  /** The achievement store changed: repaint the wall if it is showing. */
  refreshAchievements(): void
  /**
   * The game's own reduced-motion toggle. The OS setting reaches the
   * stylesheet by itself; this is for the in-game one, which a media query
   * cannot see -- the badge wall's prism ring is the one thing here it stops.
   */
  setReducedMotion(on: boolean): void
  dispose(): void
}

/** What the finished run scored, handed over for display. */
export interface RunScore {
  score: number
  bestCombo: number
}

/** Everything the front end needs to know about the Grand Circuit. */
export interface CircuitStatus {
  state: CircuitState
  /** The player's grid slot, which is also their racer id in every round. */
  localId: number
  /**
   * True while the player is IN the circuit -- racing its rounds, looking at
   * its standings. False for a saved circuit sitting on the title screen
   * waiting to be resumed, which must not put a Circuit page on the results of
   * an unrelated single race.
   */
  active: boolean
}

// ---------------------------------------------------------------------------

const STAT_KEYS: { k: keyof typeof CHASSIS[0]['stats']; label: string }[] = [
  { k: 'topSpeed', label: 'Top Spd' },
  { k: 'accel', label: 'Accel' },
  { k: 'grip', label: 'Grip' },
  { k: 'handling', label: 'Handling' },
  { k: 'drift', label: 'Drift' },
  { k: 'mass', label: 'Mass' },
]

const LOCO_NOTE: Record<string, string> = {
  grounded:
    'GROUNDED — full surface grip and the most forgiving drift charge. Cannot cross gaps.',
  hover:
    'HOVER — ignores surface friction, clears small gaps, but gets shoved much harder by hits and fields.',
  flight:
    'FLIGHT — spends Lift to leave the track entirely. Weakest grip, widest lines, its own route.',
}

const QUALITIES: QualityTier[] = ['low', 'medium', 'high']
const MAX_ROWS = 8

/**
 * The screens whose arrow keys walk the controls rather than doing nothing.
 *
 * All of them are screens whose main content is a LIST of buttons -- the track
 * and chassis cards, the lobby rows, the twenty-four portraits. The results and
 * pause screens are deliberately out: their arrow keys belong to the tab strip
 * and to nothing, respectively.
 */
const ARROW_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>([
  'track', 'garage', 'lobby', 'lobbyNew', 'room', 'profile', 'achievements',
])

const LS_CHASSIS = 'sg.chassis'
const LS_PILOT = 'sg.pilot'
const LS_QUALITY = 'sg.quality'
/** Shared with game/main.ts, which reads the same key at boot so the field
 *  and the segment cannot disagree about what was last chosen. */
const LS_DIFFICULTY = 'sg.difficulty'
const LS_TRACK = 'sg.track'

const ORD = ['-', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th']

/**
 * The standings entrance, mirrored from the `sgRowIn` rule in styles.css.
 *
 * Duplicated rather than read back because this file has to know when the last
 * row has landed -- to drop the class that plays it, and to decide when the
 * circuit auto-switch is allowed to take the screen. Two numbers in two files
 * is worth less than a getComputedStyle on every result.
 */
const ROW_STAGGER_MS = 150
const ROW_ENTER_MS = 420

/**
 * HOW LONG THE RACE RESULT GETS BEFORE THE STANDINGS TAKE OVER.
 *
 * Vince asked for the results screen to open on the race and then switch
 * itself to the circuit table, which means picking a number, and the number is
 * derived rather than felt: the standings rows land on a stagger of
 * ROW_STAGGER_MS each, last place first, so the winner's row settles at
 * (8-1)*150 + 420 = 1470ms after the screen appears. Switching before that
 * pulls the table away mid-animation and the player never sees the finish they
 * just earned.
 *
 * 3000ms leaves 1530ms of a fully settled table -- measured against reading a
 * single highlighted row, not the whole eight -- which is why the highlight
 * work and this number are the same feature. Anything past about 4s and the
 * player has started reaching for Next Race and the switch feels like a
 * misclick they did not make.
 *
 * History: 1800ms first, which landed 330ms after the winner's row and read as
 * a glitch; 3000 since.
 */
const CIRCUIT_AUTOSWITCH_MS = 3000

// --- track preview ---------------------------------------------------------

/**
 * Ink per surface for the route preview. Held here as `var()` references rather
 * than as literals, the same way settings.ts holds its per-action colours, so
 * every hue in the front end still resolves through one token table in
 * styles.css.
 */
const SURFACE_INK: Record<SurfaceKind, string> = {
  tarmac: 'var(--sg-surf-tarmac)',
  metal: 'var(--sg-surf-metal)',
  gravel: 'var(--sg-surf-gravel)',
  oil: 'var(--sg-surf-oil)',
  ice: 'var(--sg-surf-ice)',
  snow: 'var(--sg-surf-snow)',
  boost: 'var(--sg-surf-boost)',
}

const SURFACE_LABEL: Record<SurfaceKind, string> = {
  tarmac: 'Tarmac',
  metal: 'Plate metal',
  gravel: 'Gravel',
  oil: 'Oil slick',
  ice: 'Polished ice',
  snow: 'Packed snow',
  boost: 'Boost strip',
}

const SVG_NS = 'http://www.w3.org/2000/svg'

// --- gamepad menu navigation ----------------------------------------------

const PAD_L = 1 << 0
const PAD_R = 1 << 1
const PAD_U = 1 << 2
const PAD_D = 1 << 3
const PAD_A = 1 << 4
const PAD_B = 1 << 5
/** Stick past this counts as a direction press. Well clear of any drift. */
const PAD_AXIS = 0.55
const PAD_POLL_MS = 60
/** Hold-to-repeat, tuned like a text cursor: deliberate first, then quick. */
const PAD_DELAY_MS = 400
const PAD_REPEAT_MS = 140

/** Everything the detail panel needs about a circuit, derived once per track. */
interface TrackPreview {
  svg: SVGSVGElement
  /** Lap length in metres. */
  lengthM: number
  /** How much of the lap sits on each surface, biggest share first. */
  mix: { kind: SurfaceKind; frac: number }[]
  /** Hazards and features worth a chip, already worded for the player. */
  features: string[]
  /** Elevation sparkline over one lap, plus its range in metres. */
  elevation: SVGSVGElement
  climbM: number
}

// ---------------------------------------------------------------------------

function hex(n: number): string {
  return '#' + (n & 0xffffff).toString(16).padStart(6, '0')
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls: string, parent?: Element, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = cls
  if (text !== undefined) node.textContent = text
  if (parent) parent.appendChild(node)
  return node
}

function button(cls: string, parent: Element, label: string): HTMLButtonElement {
  const b = el('button', cls, parent, label)
  b.type = 'button'
  return b
}

function fmtTime(t: number): string {
  if (!isFinite(t) || t <= 0) return '--:--.--'
  const m = Math.floor(t / 60)
  const s = Math.floor(t - m * 60)
  const cs = Math.floor((t * 100) % 100)
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s + '.' + (cs < 10 ? '0' : '') + cs
}

function readStore(key: string, fallback: string): string {
  try {
    const v = window.localStorage.getItem(key)
    return v === null ? fallback : v
  } catch {
    return fallback
  }
}

function writeStore(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* private mode / blocked storage — selection just does not persist */
  }
}

interface ResultRow {
  root: HTMLElement
  pos: HTMLElement
  pilot: HTMLElement
  chassis: HTMLElement
  time: HTMLElement
  best: HTMLElement
  /** The "YOU" chip. Shown on exactly one row. */
  you: HTMLElement
}

// ---------------------------------------------------------------------------
// Route preview
// ---------------------------------------------------------------------------

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K, cls: string, parent?: Element,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  if (cls) node.setAttribute('class', cls)
  if (parent) parent.appendChild(node)
  return node
}

/** `M x y L x y ...`, optionally closed. Two decimals is well under a pixel. */
function pathData(xs: number[], ys: number[], idx: number[], close: boolean): string {
  let d = ''
  for (let i = 0; i < idx.length; i++) {
    const k = idx[i]
    d += (i === 0 ? 'M' : 'L') + xs[k].toFixed(2) + ' ' + ys[k].toFixed(2)
  }
  return close ? d + 'Z' : d
}

/**
 * Draw the lap the way the in-race minimap draws it — same rotation (start
 * straight running up the frame), same casing / body / hairline stacking — and
 * then colour the body by surface, which is the one thing the 150px minimap has
 * no room to say. On Cryostatic that turns "two surfaces, one racing line" from
 * a claim into something the player can read off the map before committing.
 *
 * The whole thing is derived from the baked Track, not from the authored nodes:
 * the sim's own Catmull-Rom is the only definition of where the road goes, and
 * re-deriving it here would be a second, quietly diverging one.
 */
function buildPreview(def: TrackDef): TrackPreview {
  const track = new Track(def)
  const s = track.samples
  const n = s.length

  // Match hud.ts bakeMap: rotate so the start straight runs up the frame.
  const t0 = s[0].tangent
  const ang = Math.atan2(-t0.x, t0.z)
  const ca = Math.cos(ang), sa = Math.sin(ang)
  const xs = new Array<number>(n)
  const ys = new Array<number>(n)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let i = 0; i < n; i++) {
    const p = s[i].pos
    const u = -(p.x * ca + p.z * sa)
    const v = -(-p.x * sa + p.z * ca)
    xs[i] = u; ys[i] = v
    if (u < minX) minX = u
    if (u > maxX) maxX = u
    if (v < minY) minY = v
    if (v > maxY) maxY = v
  }

  // The viewBox is in metres, so stroke widths are too: scale them off the
  // bounding box and every track reads at the same visual weight.
  const bw = Math.max(1, maxX - minX)
  const bh = Math.max(1, maxY - minY)
  const road = Math.max(bw, bh) * 0.036
  const pad = road * 1.4
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'sg-trk__svg')
  svg.setAttribute('viewBox',
    `${(minX - pad).toFixed(1)} ${(minY - pad).toFixed(1)} ` +
    `${(bw + pad * 2).toFixed(1)} ${(bh + pad * 2).toFixed(1)}`)
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  svg.setAttribute('aria-hidden', 'true')

  const all: number[] = []
  for (let i = 0; i < n; i++) all.push(i)

  const casing = svgEl('path', 'sg-trk__casing', svg)
  casing.setAttribute('d', pathData(xs, ys, all, true))
  casing.setAttribute('stroke-width', (road * 1.34).toFixed(2))

  // Runs of one surface, walked from the start line. A boost strip wins over
  // whatever it is painted on: it is what the player is looking for.
  const kindAt = (i: number): SurfaceKind => (s[i].boost ? 'boost' : s[i].surface)
  const tally = new Map<SurfaceKind, number>()
  for (let i = 0; i < n; i++) {
    const k = kindAt(i)
    tally.set(k, (tally.get(k) ?? 0) + 1)
  }
  let runStart = 0
  for (let i = 1; i <= n; i++) {
    const same = i < n && kindAt(i) === kindAt(runStart)
    if (same) continue
    const kind = kindAt(runStart)
    const idx: number[] = []
    // Reach one sample into the next run so consecutive runs butt together
    // instead of leaving a hairline of casing between them.
    for (let k = runStart; k <= Math.min(i, n - 1); k++) idx.push(k)
    if (i >= n) idx.push(0)
    const p = svgEl('path', 'sg-trk__road', svg)
    p.setAttribute('d', pathData(xs, ys, idx, false))
    p.setAttribute('stroke-width', road.toFixed(2))
    p.style.setProperty('--ink', SURFACE_INK[kind])
    runStart = i
  }

  // Fragile shelves, overlaid dashed. Cryostatic's lake is the only user today
  // and the dashes are the point: this is the part of the lap that leaves.
  let fragStart = -1
  for (let i = 0; i <= n; i++) {
    const frag = i < n && s[i].fragile
    if (frag && fragStart < 0) fragStart = i
    if (!frag && fragStart >= 0) {
      const idx: number[] = []
      for (let k = fragStart; k < i; k++) idx.push(k)
      const p = svgEl('path', 'sg-trk__frag', svg)
      p.setAttribute('d', pathData(xs, ys, idx, false))
      p.setAttribute('stroke-width', (road * 0.92).toFixed(2))
      p.setAttribute('stroke-dasharray', (road * 0.85).toFixed(2) + ' ' + (road * 0.7).toFixed(2))
      fragStart = -1
    }
  }

  const line = svgEl('path', 'sg-trk__line', svg)
  line.setAttribute('d', pathData(xs, ys, all, true))
  line.setAttribute('stroke-width', Math.max(0.6, road * 0.14).toFixed(2))
  // The viewBox is metres and the projection is a pure rotation, so the lap
  // length IS the path length in user units — no getTotalLength() needed, which
  // would mean measuring a node that may not be laid out yet.
  line.style.setProperty('--len', track.length.toFixed(1))

  // Ramp decks: one marker per authored deck, at its midpoint.
  let rampStart = -1
  for (let i = 0; i <= n; i++) {
    const on = i < n && s[i].ramp > 0
    if (on && rampStart < 0) rampStart = i
    if (!on && rampStart >= 0) {
      const mid = (rampStart + i - 1) >> 1
      const dot = svgEl('circle', 'sg-trk__ramp', svg)
      dot.setAttribute('cx', xs[mid].toFixed(2))
      dot.setAttribute('cy', ys[mid].toFixed(2))
      dot.setAttribute('r', (road * 0.42).toFixed(2))
      rampStart = -1
    }
  }

  // Start / finish tick, perpendicular to the start tangent — the same gold
  // bar the minimap draws, so the two frames read as the same object.
  const s0 = s[0]
  const rx = -(s0.right.x * ca + s0.right.z * sa)
  const ry = -(-s0.right.x * sa + s0.right.z * ca)
  const rl = Math.hypot(rx, ry) || 1
  const ex = (rx / rl) * road * 0.85
  const ey = (ry / rl) * road * 0.85
  const tick = svgEl('path', 'sg-trk__tick', svg)
  tick.setAttribute('d',
    `M${(xs[0] - ex).toFixed(2)} ${(ys[0] - ey).toFixed(2)}` +
    `L${(xs[0] + ex).toFixed(2)} ${(ys[0] + ey).toFixed(2)}`)
  tick.setAttribute('stroke-width', (road * 0.28).toFixed(2))

  // Surface mix. "Two surfaces, one racing line" is a claim about proportions,
  // so the panel states the proportions.
  const mix = Array.from(tally, ([kind, count]) => ({ kind, frac: count / n }))
  mix.sort((a, b) => b.frac - a.frac)

  // Elevation over one lap, normalised into a unit box and stretched by the
  // stylesheet. Drawn from the same baked samples, so a climb on the profile is
  // a climb the car actually does.
  let loY = Infinity, hiY = -Infinity
  for (let i = 0; i < n; i++) {
    const y = s[i].pos.y
    if (y < loY) loY = y
    if (y > hiY) hiY = y
  }
  const span = Math.max(0.5, hiY - loY)
  const elev = document.createElementNS(SVG_NS, 'svg')
  elev.setAttribute('class', 'sg-trk__elevSvg')
  elev.setAttribute('viewBox', '0 0 100 30')
  elev.setAttribute('preserveAspectRatio', 'none')
  elev.setAttribute('aria-hidden', 'true')
  // ~90 columns is plenty for a sparkline and keeps the path string short.
  const step = Math.max(1, Math.floor(n / 90))
  let dTop = ''
  for (let i = 0; i < n; i += step) {
    const x = (i / n) * 100
    const y = 28 - ((s[i].pos.y - loY) / span) * 25
    dTop += (dTop === '' ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2)
  }
  const fill = svgEl('path', 'sg-trk__elevFill', elev)
  fill.setAttribute('d', dTop + 'L100 30L0 30Z')
  const stroke = svgEl('path', 'sg-trk__elevLine', elev)
  stroke.setAttribute('d', dTop)

  // Features, worded for a player rather than for the authoring format.
  const nodes = def.nodes
  const features: string[] = []
  if (nodes.some((v) => (v.ramp ?? 0) > 0)) features.push('Jumps')
  if (nodes.some((v) => v.boost)) features.push('Boost strips')
  if (nodes.some((v) => v.bounce)) features.push('Bounce walls')
  if (nodes.some((v) => v.open)) features.push('Open edges')
  if (nodes.some((v) => Math.abs(v.wind ?? 0) > 0)) features.push('Crosswind')
  if (nodes.some((v) => v.fragile)) features.push('Collapsing ice')

  return {
    svg, lengthM: track.length, mix, features,
    elevation: elev, climbM: hiY - loY,
  }
}

// ---------------------------------------------------------------------------

class FrontEndImpl implements FrontEnd {
  readonly root: HTMLElement

  onStart: (sel: StartSelection) => void = () => {}
  onRematch: () => void = () => {}
  onResume: () => void = () => {}
  onRestart: () => void = () => {}
  onQuit: () => void = () => {}
  onScreen: (screen: ScreenId | null) => void = () => {}
  onCircuitNew: () => void = () => {}
  onCircuitResume: () => void = () => {}
  onMultiplayerStart: (packet: RaceStartPacket) => void = () => {}
  onProfileChange: (profile: PlayerProfile) => void = () => {}

  private screen: ScreenId = 'title'

  private trackId: string
  private chassisId: string
  private pilotId: string
  private quality: QualityTier

  private readonly trackCards: HTMLElement[] = []
  private readonly chassisCards: HTMLElement[] = []
  private readonly pilotCards: HTMLElement[] = []
  private readonly qualityBtns: HTMLElement[] = []
  private readonly difficultyBtns: HTMLButtonElement[] = []
  private difficultyHint!: HTMLElement
  private difficulty: Difficulty = DEFAULT_DIFFICULTY

  private readonly detName: HTMLElement
  private readonly detNick: HTMLElement
  /**
   * The live car + pilot above the stat bars. Owns a WebGL context of its own,
   * which is exactly why it is asked to show() and hide() rather than merely
   * being display:none'd with the screen -- see ui/garagePreview.ts.
   */
  private readonly preview: GaragePreview
  private readonly statFills: HTMLElement[] = []
  /** The yellow pilot segment sitting on the end of each chassis bar. */
  private readonly statBonus: HTMLElement[] = []
  /** The pilot's own figure, printed beside the chassis one. */
  private readonly statBVals: HTMLElement[] = []
  private readonly statVals: HTMLElement[] = []
  private detPerk!: HTMLElement
  private detPerkName!: HTMLElement
  private detPerkText!: HTMLElement
  private readonly detNote: HTMLElement

  private readonly trkName: HTMLElement
  private readonly trkWorld: HTMLElement
  private readonly trkHook: HTMLElement
  private readonly trkMap: HTMLElement
  private readonly trkFacts: HTMLElement
  private readonly trkDiff: HTMLElement
  private readonly trkLength: HTMLElement
  private readonly trkLaps: HTMLElement
  private readonly trkBar: HTMLElement
  private readonly trkLegend: HTMLElement
  private readonly trkFeatures: HTMLElement
  private readonly trkClimb: HTMLElement
  private readonly trkElev: HTMLElement
  private readonly trkNote: HTMLElement
  /** Built on first view of a track, then kept: the bake is not free. */
  private readonly previews = new Map<string, TrackPreview>()

  private readonly rows: ResultRow[] = []
  /** The standings scroller. Short viewports shrink it and scroll inside it. */
  private rowHost!: HTMLElement
  private readonly resTitle: HTMLElement
  private readonly resWhere: HTMLElement
  private readonly resTotal: HTMLElement
  private readonly resBest: HTMLElement
  private readonly resCombo: HTMLElement
  private readonly resScore: HTMLElement
  private readonly resRank: HTMLElement
  private readonly nameRow: HTMLElement
  private readonly nameInput: HTMLInputElement
  private readonly nameSave: HTMLButtonElement
  private readonly boardWrap: HTMLElement
  private readonly boardRows: HTMLElement
  private readonly recWrap: HTMLElement
  private readonly recRows: HTMLElement
  private readonly gloWrap: HTMLElement
  private readonly gloRows: HTMLElement
  private readonly gloNote: HTMLElement
  private readonly tabs: TabStrip
  private readonly boardNote: HTMLElement

  // --- Grand Circuit ------------------------------------------------------
  private readonly cirWrap: HTMLElement
  private readonly cirTitle: HTMLElement
  private readonly cirYou: HTMLElement
  private readonly cirRows: HTMLElement
  private readonly cirNote: HTMLElement
  /** Polite announcement of the auto-switch. See armCircuitSwitch(). */
  private readonly cirLive: HTMLElement
  private readonly circuitBtn: HTMLButtonElement
  private readonly circuitNewBtn: HTMLButtonElement
  private readonly circuitLine: HTMLElement
  private circuit: CircuitStatus | null = null
  /** The player's standings row, so opening the page can bring it into view. */
  private cirYouRow: HTMLElement | null = null
  /** window.setTimeout handle for the auto-switch, 0 when nothing is pending. */
  private switchTimer = 0
  /** Drops the row entrance class once the last row has landed. */
  private rowsInTimer = 0
  /** Set the moment the player touches the tab strip; disarms the switch. */
  private tabTouched = false
  /** The garage head's resting text, restored when the circuit is not on. */
  private readonly garageHeadTitle: HTMLElement
  /** "Discard standings?" state on the New-circuit button. */
  private discardArmed = 0

  // --- achievements -------------------------------------------------------
  /** The badge wall. The settings dialog mounts a second copy; see its file. */
  private readonly achView: AchievementsView
  /** The results screen's NEW BADGES strip. Hidden when the race earned none. */
  private readonly unlockStrip: HTMLElement

  // --- multiplayer --------------------------------------------------------
  private readonly lobby: LobbyScreens
  private readonly profile: ProfileScreen
  /** True once ui/lobby.ts has been entered, and therefore once a lobby
   *  service exists to publish a changed loadout to. See publishLoadout(). */
  private multiplayerLive = false
  private readonly multiBtn: HTMLButtonElement
  private readonly multiLine: HTMLElement

  private readonly playBtn: HTMLButtonElement
  private readonly toGarageBtn: HTMLButtonElement
  private readonly startBtn: HTMLButtonElement
  private readonly rematchBtn: HTMLButtonElement
  private readonly resumeBtn: HTMLButtonElement

  private readonly screens: Record<ScreenId, HTMLElement>

  /** Where the profile screen's Back button goes. See its `onBack`. */
  private profileFrom: ScreenId = 'title'

  private readonly onKey: (e: KeyboardEvent) => void

  // Gamepad menu navigation. See padPoll().
  private padTimer = 0
  private padPrev = 0
  private padRepeat = 0
  private padDir = 0

  constructor(container: HTMLElement) {
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative'
    }

    const stored = readStore(LS_CHASSIS, CHASSIS[0].id)
    this.chassisId = CHASSIS.some((c) => c.id === stored) ? stored : CHASSIS[0].id
    const storedP = readStore(LS_PILOT, PILOTS[0].id)
    this.pilotId = PILOTS.some((p) => p.id === storedP) ? storedP : PILOTS[0].id
    const storedQ = readStore(LS_QUALITY, 'medium') as QualityTier
    this.quality = QUALITIES.indexOf(storedQ) >= 0 ? storedQ : 'medium'
    // asDifficulty does the validating, so a hand-edited value lands on
    // Normal rather than on undefined.
    this.difficulty = asDifficulty(readStore(LS_DIFFICULTY, DEFAULT_DIFFICULTY))
    // Same contract as the chassis and the pilot: the last circuit raced is the
    // one already selected next time, so a rematch is one button.
    const storedT = readStore(LS_TRACK, TRACKS[0].id)
    this.trackId = TRACKS.some((t) => t.id === storedT) ? storedT : TRACKS[0].id

    const root = el('div', 'sg-fe')
    this.root = root
    root.dataset.screen = 'title'
    el('div', 'sg-fe__grid', root)
    el('div', 'sg-fe__grain', root)

    // =====================================================================
    // TITLE — logo, one button, nothing in the way
    // =====================================================================
    const title = el('div', 'sg-screen sg-screen--title', root)
    const logo = el('div', 'sg-logo', title)
    el('div', 'sg-logo__main', logo, 'SPACEGEN')
    const sub = el('div', 'sg-logo__sub', logo)
    el('span', 'sg-logo__rule', sub)
    el('span', '', sub, 'RACING')
    el('span', 'sg-logo__rule sg-logo__rule--r', sub)
    this.playBtn = button('sg-btn sg-btn--huge', title, 'Play')
    // THE CIRCUIT IS A SECOND MODE, NOT A SETTING ON THE FIRST.
    //
    // A single race is still one button and nothing in front of it, which is
    // the contract this screen has always had. The circuit sits below it as
    // its own block with its own state line, so a returning player sees where
    // they got to without opening anything -- and a player who only ever wants
    // one race never has to read past PLAY.
    const cirBlock = el('div', 'sg-title__circuit', title)
    this.circuitBtn = button('sg-btn sg-btn--gold sg-btn--wide', cirBlock, 'Grand Circuit')
    this.circuitLine = el('div', 'sg-title__cline', cirBlock, '')
    this.circuitNewBtn = button('sg-btn sg-btn--ghost sg-btn--small', cirBlock, 'New circuit')
    this.circuitNewBtn.hidden = true
    // MULTIPLAYER IS A THIRD MODE AND IT GETS THE SAME SHAPE AS THE SECOND.
    //
    // One wide button, one state line under it, one quiet ghost button beside
    // it -- exactly the block the Grand Circuit already occupies. Copying the
    // shape rather than inventing one is what stops this reading as bolted on:
    // the title screen now has PLAY, and below it two modes that look like each
    // other and not like PLAY.
    //
    // The state line is deliberately STATIC until a profile exists. Reading the
    // player's name here would mean loading an account on the title screen, and
    // an account load is what starts the mock world's clock -- for every player,
    // including the ones who only ever press PLAY. See the file header.
    const mpBlock = el('div', 'sg-title__multi', title)
    this.multiBtn = button('sg-btn sg-btn--violet sg-btn--wide', mpBlock, 'Multiplayer')
    this.multiLine = el('div', 'sg-title__cline', mpBlock,
      'Up to 8 players · you host, everyone connects to you')
    // THE ACCOUNT'S TWO DOORS, SIDE BY SIDE. Achievements sit beside Profile
    // rather than in a row of their own because they are the same kind of
    // place -- somewhere you go on purpose to look at what you have -- and
    // because a fourth full-width row would push the launch hint off an
    // 844x390 phone. One row of two quiet buttons costs no height at all.
    const acctRow = el('div', 'sg-title__acct', mpBlock)
    const titleProfileBtn = button('sg-btn sg-btn--ghost sg-btn--small', acctRow, 'Profile')
    const titleAchBtn = button('sg-btn sg-btn--ghost sg-btn--small', acctRow, 'Achievements')
    titleAchBtn.dataset.open = 'achievements'
    el('div', 'sg-hint', title, 'Enter or Space to launch')

    // =====================================================================
    // TRACK — pick the planet before the car
    // =====================================================================
    const trackScr = el('div', 'sg-screen sg-screen--track', root)
    const tHead = el('div', 'sg-head', trackScr)
    const tBack = button('sg-btn sg-btn--ghost', tHead, 'Back')
    el('div', 'sg-head__title', tHead, 'TRACK')
    const tSpacer = el('div', '', tHead)
    tSpacer.style.width = '1px'

    const tGrid = el('div', 'sg-tracks', trackScr)

    const tCol = el('div', 'sg-col sg-col--circuits', tGrid)
    el('div', 'sg-col__title', tCol, 'Circuits')
    const tList = el('div', 'sg-list', tCol)
    for (let i = 0; i < TRACKS.length; i++) {
      const def = TRACKS[i]
      const c = copyFor(def.id)
      const card = button('sg-card sg-card--track', tList, '')
      // The track's ID on the element. Harnesses used to find this card by its
      // DISPLAY NAME, which meant renaming the four circuits broke the smoke
      // test -- a rename is a content change and should not be able to do that.
      // An id is a key and does not move; the name is allowed to.
      card.dataset.track = def.id
      const chip = el('span', 'sg-card__chip', card)
      chip.style.setProperty('--c1', hex(def.palette.a))
      chip.style.setProperty('--c2', hex(def.palette.c))
      const body = el('span', 'sg-card__body', card)
      el('span', 'sg-card__name', body, def.name)
      el('span', 'sg-card__sub', body, c.world)
      const tag = el('span', 'sg-card__tag', card, c.difficulty)
      tag.dataset.diff = c.difficulty.toLowerCase()
      card.addEventListener('click', () => this.selectTrack(def.id))
      this.trackCards.push(card)
    }

    // Route column. The garage puts its read-out in the middle and the two
    // pickable lists either side; the track screen keeps that shape, with the
    // map where the stat bars sit.
    const rCol = el('div', 'sg-col sg-col--route', tGrid)
    el('div', 'sg-col__title', rCol, 'Route')
    this.trkMap = el('div', 'sg-trk__map', rCol)

    const bCol = el('div', 'sg-col sg-col--brief', tGrid)
    el('div', 'sg-col__title', bCol, 'Briefing')
    const tDetail = el('div', 'sg-detail sg-detail--track', bCol)
    this.trkName = el('div', 'sg-detail__name', tDetail)
    this.trkWorld = el('div', 'sg-trk__world', tDetail)
    this.trkHook = el('div', 'sg-detail__nick', tDetail)
    this.trkFacts = el('div', 'sg-trk__facts', tDetail)
    this.trkDiff = this.fact(this.trkFacts, 'Difficulty')
    this.trkLength = this.fact(this.trkFacts, 'Lap')
    this.trkLaps = this.fact(this.trkFacts, 'Laps')
    el('div', 'sg-trk__label', tDetail, 'Surface mix')
    this.trkBar = el('div', 'sg-trk__bar', tDetail)
    this.trkLegend = el('div', 'sg-trk__chips sg-trk__chips--surf', tDetail)
    el('div', 'sg-trk__label', tDetail, 'Features')
    this.trkFeatures = el('div', 'sg-trk__chips', tDetail)
    const elevHead = el('div', 'sg-trk__label sg-trk__label--row', tDetail)
    el('span', '', elevHead, 'Elevation')
    this.trkClimb = el('span', 'sg-trk__climb', elevHead)
    this.trkElev = el('div', 'sg-trk__elev', tDetail)
    this.trkNote = el('div', 'sg-detail__note', tDetail)

    const tOpts = el('div', 'sg-opts', trackScr)
    const tHint = el('div', 'sg-controls', tOpts)
    this.fillPickHint(tHint)
    this.toGarageBtn = button('sg-btn sg-btn--gold sg-btn--start', tOpts, 'To Garage')

    // =====================================================================
    // GARAGE
    // =====================================================================
    const garage = el('div', 'sg-screen sg-screen--garage', root)
    const head = el('div', 'sg-head', garage)
    const backBtn = button('sg-btn sg-btn--ghost', head, 'Back')
    const headTitle = el('div', 'sg-head__title', head)
    headTitle.textContent = 'GARAGE'
    this.garageHeadTitle = headTitle
    const headSpacer = el('div', '', head)
    headSpacer.style.width = '1px'

    const grid = el('div', 'sg-garage', garage)

    // chassis column
    const cCol = el('div', 'sg-col sg-col--chassis', grid)
    el('div', 'sg-col__title', cCol, 'Chassis')
    const cList = el('div', 'sg-list', cCol)
    for (let i = 0; i < CHASSIS.length; i++) {
      const def = CHASSIS[i]
      const card = button('sg-card', cList, '')
      const chip = el('span', 'sg-card__chip', card)
      chip.style.setProperty('--c1', hex(def.colorPrimary))
      chip.style.setProperty('--c2', hex(def.colorSecondary))
      const body = el('span', 'sg-card__body', card)
      el('span', 'sg-card__name', body, def.name)
      el('span', 'sg-card__sub', body, def.nickname)
      const tag = el('span', 'sg-card__tag', card, def.locomotion)
      tag.dataset.loco = def.locomotion
      // Addressable by ID. A probe that picks this card by matching its
      // visible text picks by a label that art and copy passes both move, and
      // this repo has already lost a pass to a probe that matched a row by
      // substring and drove the wrong control.
      card.dataset.chassis = def.id
      card.addEventListener('click', () => this.selectChassis(def.id))
      this.chassisCards.push(card)
    }

    // detail column. The preview sits at the TOP of it and the stat bars run
    // underneath: the car is what a player is choosing and the numbers are the
    // argument for the choice, so the numbers go second. The two pickable
    // lists either side keep the position and the width they always had.
    const dCol = el('div', 'sg-col sg-col--detail', grid)
    el('div', 'sg-col__title', dCol, 'Loadout')
    this.preview = createGaragePreview(dCol, {
      chassisId: this.chassisId,
      pilotId: this.pilotId,
      tier: this.quality,
    })
    const detail = el('div', 'sg-detail', dCol)
    this.detName = el('div', 'sg-detail__name', detail)
    this.detNick = el('div', 'sg-detail__nick', detail)
    const stats = el('div', 'sg-stats', detail)
    for (let i = 0; i < STAT_KEYS.length; i++) {
      const row = el('div', 'sg-stat', stats)
      el('span', 'sg-stat__k', row, STAT_KEYS[i].label)
      const track = el('span', 'sg-stat__track', row)
      this.statFills.push(el('span', 'sg-stat__fill', track))
      // AFTER the fill in document order so it paints over the end of it.
      this.statBonus.push(el('span', 'sg-stat__bonus', track))
      const vwrap = el('span', 'sg-stat__v', row, '0')
      this.statVals.push(vwrap)
      this.statBVals.push(el('span', 'sg-stat__b', vwrap))
    }
    this.detPerk = el('div', 'sg-detail__perk', detail)
    this.detPerkName = el('b', '', this.detPerk)
    this.detPerkText = el('span', '', this.detPerk)
    this.detNote = el('div', 'sg-detail__note', detail)

    // pilot column
    const pCol = el('div', 'sg-col sg-col--pilot', grid)
    el('div', 'sg-col__title', pCol, 'Pilot')
    const pList = el('div', 'sg-list', pCol)
    for (let i = 0; i < PILOTS.length; i++) {
      const def = PILOTS[i]
      const card = button('sg-card', pList, '')
      const chip = el('span', 'sg-card__chip', card)
      chip.style.setProperty('--c1', hex(def.shell))
      chip.style.setProperty('--c2', hex(def.accent))
      const body = el('span', 'sg-card__body', card)
      el('span', 'sg-card__name', body, def.name)
      el('span', 'sg-card__sub', body, def.read)
      card.addEventListener('click', () => this.selectPilot(def.id))
      this.pilotCards.push(card)
    }

    // options row
    const opts = el('div', 'sg-opts', garage)
    const seg = el('div', 'sg-seg', opts)
    el('span', 'sg-seg__k', seg, 'Quality')
    const segGrp = el('div', 'sg-seg__grp', seg)
    for (let i = 0; i < QUALITIES.length; i++) {
      const q = QUALITIES[i]
      const b = button('sg-seg__btn', segGrp, q)
      b.addEventListener('click', () => this.selectQuality(q))
      this.qualityBtns.push(b)
    }
    // OPPONENTS SITS BESIDE QUALITY, NOT ON THE TRACK SCREEN.
    //
    // Both are things you set once and rarely change, both are about how this
    // race will go rather than about which race it is, and this is the last
    // screen before the grid -- so a player who has just seen the circuit and
    // picked a car is looking at exactly the decision "how hard should this
    // be". The track screen is a choice of PLACE; putting a difficulty
    // segment on it would ask the same question eight times.
    const diffWrap = el('div', 'sg-opts__diff', opts)
    const diffSeg = el('div', 'sg-seg', diffWrap)
    el('span', 'sg-seg__k', diffSeg, 'Opponents')
    const diffGrp = el('div', 'sg-seg__grp', diffSeg)
    for (const d of DIFFICULTIES) {
      const b = button('sg-seg__btn', diffGrp, DIFFICULTY_SPECS[d].label)
      b.dataset.diff = d
      b.addEventListener('click', () => this.selectDifficulty(d))
      this.difficultyBtns.push(b)
    }
    // UNDER THE SEGMENT, NOT AT THE FOOT OF THE ROW. The first pass put this
    // in `.sg-opts` directly, which is a wrapping flex row, so it took a line
    // of its own at the bottom left -- a sentence about the Opponents control
    // sitting under the keyboard hints, five hundred pixels from the buttons
    // it describes. It read as a footnote. Wrapped with its own segment it
    // reads as the label it is.
    this.difficultyHint = el('div', 'sg-opts__hint', diffWrap, '')

    const controls = el('div', 'sg-controls', opts)
    this.fillControlHint(controls)
    this.startBtn = button('sg-btn sg-btn--gold sg-btn--start', opts, 'Start Race')

    // =====================================================================
    // RESULTS
    // =====================================================================
    const results = el('div', 'sg-screen sg-screen--results', root)
    this.resTitle = el('div', 'sg-results__title', results, 'RACE COMPLETE')
    this.resWhere = el('div', 'sg-results__where', results)

    // TWO PAGES, AND ROOM FOR MORE. The strip is generic (see ui/tabs.ts):
    // adding a third page is one entry in this array plus code that fills the
    // element `tabs.panel(id)` hands back. Nothing below counts the tabs.
    //
    // The CTA row deliberately sits OUTSIDE the panels: Rematch is the action
    // this screen exists for, and burying it on a page the player might have
    // navigated away from would mean a tab click can hide the way forward.
    this.tabs = createTabs(results, [
      { id: 'results', label: 'Results' },
      { id: 'circuit', label: 'Circuit' },
      { id: 'records', label: 'Records' },
      { id: 'global', label: 'Global' },
    ])
    const tabResults = this.tabs.panel('results')
    const tabCircuit = this.tabs.panel('circuit')
    const tabRecords = this.tabs.panel('records')
    const tabGlobal = this.tabs.panel('global')
    // ABSENT UNTIL THERE IS A CIRCUIT. Not empty -- see tabs.ts setPresent.
    // A Circuit page on a single race would be a page that has nothing to say,
    // and a tab that opens onto nothing is worse than no tab.
    this.tabs.setPresent('circuit', false)
    // A tab the player chose is a tab the player keeps. See armCircuitSwitch.
    this.tabs.onUserSelect = () => {
      this.tabTouched = true
      this.cancelCircuitSwitch()
    }
    // A hidden panel has no layout, so the standings cannot be scrolled to the
    // player's row until the page is actually opened. See scrollStandingsToYou.
    this.tabs.onSelect = (id) => {
      if (id === 'circuit') this.scrollStandingsToYou()
    }

    const rowHost = el('div', 'sg-results__rows', tabResults)
    this.rowHost = rowHost
    for (let i = 0; i < MAX_ROWS; i++) {
      const row = el('div', 'sg-row', rowHost)
      const pos = el('span', 'sg-row__p', row, '-')
      const name = el('span', 'sg-row__name', row)
      const pilotWrap = el('span', 'sg-row__pilot', name)
      const pilot = el('span', 'sg-row__who', pilotWrap, '')
      // THE "YOU" AFFORDANCE, AND WHY IT IS A WORD.
      //
      // The bug Vince reported is that the player cannot tell which line is
      // theirs, and the row already had a cyan tint -- so the tint is not the
      // answer. A word is: it survives greyscale, it survives every form of
      // colour blindness, it survives a photograph of a phone screen in
      // daylight, and it is the one channel a screen reader can also read. The
      // tint, the rail and the weight are the three that make it findable
      // without reading; this is the one that makes it unambiguous once found.
      const youTag = el('span', 'sg-you', pilotWrap, 'YOU')
      youTag.hidden = true
      const chassis = el('span', 'sg-row__chassis', name, '')
      const time = el('span', 'sg-row__time', row, '--:--.--')
      const best = el('span', 'sg-row__best', row, '')
      row.hidden = true
      this.rows.push({ root: row, pos, pilot, chassis, time, best, you: youTag })
    }
    const meta = el('div', 'sg-results__meta', tabResults)
    const m1 = el('div', 'sg-meta', meta)
    el('div', 'sg-meta__k', m1, 'Total Time')
    this.resTotal = el('div', 'sg-meta__v', m1, '--:--.--')
    const m2 = el('div', 'sg-meta', meta)
    el('div', 'sg-meta__k', m2, 'Best Lap')
    this.resBest = el('div', 'sg-meta__v', m2, '--:--.--')
    const m3 = el('div', 'sg-meta', meta)
    el('div', 'sg-meta__k', m3, 'Best Combo')
    this.resCombo = el('div', 'sg-meta__v', m3, '×1.0')

    // --- the run score, and the board -------------------------------------
    // Its own block rather than a fourth `sg-meta` cell: the score is the one
    // number this screen is now ABOUT, and giving it the same weight as "best
    // lap" would bury the thing the player just spent a race building.
    const scoreWrap = el('div', 'sg-results__score', tabResults)
    el('div', 'sg-score-k', scoreWrap, 'RUN SCORE')
    this.resScore = el('div', 'sg-score-v', scoreWrap, '0')
    this.resRank = el('div', 'sg-score-rank', scoreWrap, '')
    this.resRank.hidden = true

    // NEW BADGES, directly under the score: what the race earned, beside
    // what it scored. On the Results page rather than above the tabs so it
    // costs the other three pages nothing, and hidden -- not empty -- on the
    // races that earned none, which is most of them.
    this.unlockStrip = el('div', 'sgach-strip', tabResults)
    this.unlockStrip.hidden = true

    // Name entry, shown ONLY when the run actually made the board. Asking every
    // player for a name after every race, most of which do not place, is the
    // arcade convention that does not survive contact with a game you can
    // restart in two seconds.
    this.nameRow = el('div', 'sg-results__name', tabResults)
    this.nameRow.hidden = true
    el('label', 'sg-name__k', this.nameRow, 'NAME')
    this.nameInput = document.createElement('input')
    this.nameInput.className = 'sg-name__in'
    this.nameInput.maxLength = 12
    this.nameInput.autocomplete = 'off'
    this.nameInput.spellcheck = false
    this.nameInput.setAttribute('aria-label', 'Name for the leaderboard')
    this.nameRow.appendChild(this.nameInput)
    this.nameSave = button('sg-btn sg-btn--small', this.nameRow, 'Save')

    // --- CIRCUIT PAGE -----------------------------------------------------
    // The championship table. Same section shape as the other three pages --
    // one title, one column of rows, one note -- so the four read as one
    // screen rather than as a bolted-on mode.
    this.cirWrap = el('div', 'sg-results__circuit sg-panel sg-table', tabCircuit)
    this.cirTitle = el('div', 'sg-board__title', this.cirWrap, 'GRAND CIRCUIT')
    // THE SENTENCE, ABOVE THE TABLE. "You are 3rd on 34 points, 4 behind
    // AEGIS" is the thing a player actually wants from a standings screen, and
    // reading it out of eight rows is work. It is also the text the live region
    // announces, so a screen-reader user gets the same answer the sighted
    // player gets from the highlight.
    this.cirYou = el('div', 'sg-circuit__you', this.cirWrap, '')
    this.cirRows = el('div', 'sg-crows', this.cirWrap)
    this.cirNote = el('div', 'sg-board__note', this.cirWrap, '')
    // Off-screen, polite, and OUTSIDE the panels so it is never inside a
    // `hidden` subtree -- a live region in a hidden panel announces nothing,
    // which is the silent half of this bug class.
    this.cirLive = el('div', 'sg-sr', results, '')
    this.cirLive.setAttribute('aria-live', 'polite')
    this.cirLive.setAttribute('role', 'status')

    // --- RECORDS PAGE -----------------------------------------------------
    // The four bests first and the board second, because they answer different
    // questions: a record is "what is possible here, and in what car", the
    // board is "whose runs were best". The first is the one a driver reads to
    // decide what to go and try.
    this.recWrap = el('div', 'sg-results__records sg-panel sg-table', tabRecords)
    el('div', 'sg-board__title', this.recWrap, 'TRACK RECORDS')
    this.recRows = el('div', 'sg-rec__rows', this.recWrap)

    this.boardWrap = el('div', 'sg-results__board sg-panel sg-table', tabRecords)
    el('div', 'sg-board__title', this.boardWrap, 'TOP 10 — THIS TRACK')
    this.boardRows = el('div', 'sg-board__rows', this.boardWrap)
    // Stated plainly rather than implied. A player who believes they are on a
    // global ladder and is not has been misled by us, and this board is one
    // browser profile on one machine until the server pass lands.
    this.boardNote = el('div', 'sg-board__note', this.boardWrap,
      'Saved on this device only.')
    this.boardNote.hidden = false
    // --- GLOBAL PAGE ------------------------------------------------------
    // Same section shape as the other two -- one title, one column of rows,
    // one note underneath -- so the three pages read as one screen.
    this.gloWrap = el('div', 'sg-results__global sg-panel sg-table', tabGlobal)
    el('div', 'sg-board__title', this.gloWrap, 'FASTEST LAPS — WORLDWIDE')
    this.gloRows = el('div', 'sg-board__rows', this.gloWrap)
    this.gloNote = el('div', 'sg-board__note', this.gloWrap, '')

    const cta = el('div', 'sg-results__cta', results)
    this.rematchBtn = button('sg-btn sg-btn--gold sg-btn--huge', cta, 'Rematch')
    const toGarage = button('sg-btn sg-btn--ghost', cta, 'Garage')
    const resTrack = button('sg-btn sg-btn--ghost', cta, 'Track')

    // =====================================================================
    // PAUSED
    // =====================================================================
    const paused = el('div', 'sg-screen sg-screen--paused', root)
    el('div', 'sg-paused__title', paused, 'PAUSED')
    const stack = el('div', 'sg-stack', paused)
    this.resumeBtn = button('sg-btn sg-btn--huge', stack, 'Resume')
    const restartBtn = button('sg-btn sg-btn--ghost', stack, 'Restart Race')
    const pauseTrack = button('sg-btn sg-btn--ghost', stack, 'Change Track')
    const quitBtn = button('sg-btn sg-btn--ghost', stack, 'Back to Garage')

    // =====================================================================
    // MULTIPLAYER — four containers, two modules
    //
    // The screens are built here and filled by ui/lobby.ts and ui/profile.ts.
    // This file gives them a `.sg-screen` to live in (so the existing
    // data-screen switch, the safe-area padding and the arrow-key focus walk
    // all apply to them unchanged) and nothing else.
    // =====================================================================
    const lobbyScr = el('div', 'sg-screen sg-screen--lobby', root)
    const lobbyNewScr = el('div', 'sg-screen sg-screen--lobbyNew', root)
    const roomScr = el('div', 'sg-screen sg-screen--room', root)
    const profileScr = el('div', 'sg-screen sg-screen--profile', root)

    // =====================================================================
    // ACHIEVEMENTS -- a container, and ui/achievements.ts inside it, on the
    // terms the profile and the lobby take: the module owns its screen and
    // its stylesheet, and this file owns only the switch.
    // =====================================================================
    const achScr = el('div', 'sg-screen sg-screen--achievements', root)
    this.achView = createAchievementsView({
      mode: 'screen',
      onBack: () => { this.backCue(); this.show('title') },
    })
    achScr.appendChild(this.achView.root)

    this.lobby = createLobbyScreens({
      onBack: () => { this.backCue(); this.show('title') },
      onProfile: () => this.show('profile'),
      goto: (which: LobbyScreenId) => {
        this.show(which === 'browser' ? 'lobby' : which === 'create' ? 'lobbyNew' : 'room')
      },
      onStart: (packet) => this.onMultiplayerStart(packet),
      // The garage's choice travels into the lobby rather than being asked for
      // a second time. A player who picked a car three screens ago has already
      // answered this question.
      loadout: () => ({ chassisId: this.chassisId, pilotId: this.pilotId }),
      playerName: () => this.profile.profile?.name ?? 'Racer',
      playerId: () => this.profile.profile?.id ?? '',
    })
    lobbyScr.appendChild(this.lobby.browser)
    lobbyNewScr.appendChild(this.lobby.create)
    roomScr.appendChild(this.lobby.room)

    this.profile = createProfileScreen({
      // BACK GOES WHERE YOU CAME FROM, and the two ways in are the title screen
      // and the lobby browser. Remembered rather than guessed: a player who
      // opened the profile from a lobby list and is returned to the title has
      // lost the lobby they were looking at.
      onBack: () => { this.backCue(); this.show(this.profileFrom) },
      // ONE SELECTION, TWO DOORS ONTO IT. The profile's Vehicle and Pilot
      // pages are not a second place a chassis id is stored -- they read this
      // field and write it back through the same two methods the garage's
      // cards call. There is deliberately no setter on the profile screen for
      // the front end to push into and no copy on the profile side to get out
      // of step; see the header of ui/profile.ts for why the alternative --
      // a profile "default" the garage could override -- is the bug rather
      // than the feature.
      loadout: () => ({ chassisId: this.chassisId, pilotId: this.pilotId }),
      setLoadout: (next) => this.setLoadout(next),
      quality: () => this.quality,
    })
    profileScr.appendChild(this.profile.root)
    this.profile.onProfile = (p) => {
      // The title screen's multiplayer line picks up the claimed name the
      // moment there is one -- which is after the first visit, not at boot.
      this.multiLine.textContent =
        `Playing as ${p.name} · up to 8 players · you host, everyone connects to you`
      this.onProfileChange(p)
      // Tycoon and Collector are read off the account, so the wall repaints
      // whenever one arrives -- AFTER the host has had it, so a store the host
      // has just folded it into is the store the wall reads.
      this.achView.setProfile(p)
    }

    this.screens = {
      title, track: trackScr, garage, results, paused,
      lobby: lobbyScr, lobbyNew: lobbyNewScr, room: roomScr, profile: profileScr,
      achievements: achScr,
    }

    // =====================================================================
    // Wiring
    // =====================================================================

    // THE MENU SOUNDS. uiMove / uiSelect / uiBack / uiStart were cut, levelled
    // and downloaded by every player and never once cued, because nothing in
    // this file could reach the audio system (see audio/cues.ts for how it can
    // now). Every control here is a real <button>, so one delegated listener
    // hears every press from every input -- pointer, touch, Enter and the pad's
    // A, which dispatches a click -- including the lobby's and the profile's
    // buttons, which live inside this root.
    //
    // A button says which cue it is with `data-sfx`; anything unmarked is a
    // plain select. The four that launch a race -- Start, Rematch, the Grand
    // Circuit and Restart -- are `start`, and the four that step back out of
    // a flow are `back`. Back is ALSO reachable without a button (Escape,
    // the pad's B, the lobby and profile screens' own handlers), so those call
    // `backCue()` themselves, and it stamps `cuedAt` so this listener does not
    // add a select on top of the same press.
    for (const b of [this.startBtn, this.rematchBtn, this.circuitBtn, restartBtn]) b.dataset.sfx = 'start'
    for (const b of [tBack, backBtn, pauseTrack, quitBtn]) b.dataset.sfx = 'back'
    root.addEventListener('click', (e) => {
      const b = e.target instanceof Element ? e.target.closest('button') : null
      if (!b || !root.contains(b)) return
      if (performance.now() - this.cuedAt < 40) return
      const k = b.dataset.sfx
      cue(k === 'start' ? 'uiStart' : k === 'back' ? 'uiBack' : 'uiSelect')
    })

    this.playBtn.addEventListener('click', () => this.show('track'))
    this.multiBtn.addEventListener('click', () => this.show('lobby'))
    titleProfileBtn.addEventListener('click', () => this.show('profile'))
    titleAchBtn.addEventListener('click', () => this.show('achievements'))
    tBack.addEventListener('click', () => this.show('title'))
    this.toGarageBtn.addEventListener('click', () => this.show('garage'))
    // Back out of the garage to the track list, not to the title: the two setup
    // screens are one flow and Back should walk it, not leave it.
    backBtn.addEventListener('click', () => this.show('track'))
    this.startBtn.addEventListener('click', () => {
      this.onStart({
        trackId: this.trackId,
        chassisId: this.chassisId,
        pilotId: this.pilotId,
        quality: this.quality,
        difficulty: this.difficulty,
      })
    })
    this.rematchBtn.addEventListener('click', () => this.onRematch())
    // The gold button on the title screen: resume if there is something to
    // resume, otherwise begin. One button, because "Grand Circuit" and
    // "Continue Circuit" are the same intent and the state line says which.
    this.circuitBtn.addEventListener('click', () => {
      if (this.circuit && !isComplete(this.circuit.state) && roundsDone(this.circuit.state) > 0) {
        this.onCircuitResume()
      } else {
        this.onCircuitNew()
      }
    })
    // DISCARDING FIVE ROUNDS OF STANDINGS TAKES TWO PRESSES.
    //
    // This is the only destructive control in the front end and it sits one
    // button away from the one a returning player wants, so a mis-tap on a
    // phone would silently throw away half an hour of racing. The second press
    // is the confirmation; the label says so, and it disarms itself after four
    // seconds so the button is never left sitting in a scary state.
    this.circuitNewBtn.addEventListener('click', () => {
      if (this.discardArmed) {
        window.clearTimeout(this.discardArmed)
        this.discardArmed = 0
        this.circuitNewBtn.textContent = 'New circuit'
        this.onCircuitNew()
        return
      }
      this.circuitNewBtn.textContent = 'Discard standings? Press again'
      this.discardArmed = window.setTimeout(() => {
        this.discardArmed = 0
        this.circuitNewBtn.textContent = 'New circuit'
      }, 4000)
    })
    const saveName = (): void => {
      // Trimmed, capped and upper-cased here rather than trusted: this string
      // goes straight into a row the board renders as text for every later run.
      const name = this.nameInput.value.trim().slice(0, 12).toUpperCase() || 'PILOT'
      try { window.localStorage.setItem(FrontEndImpl.LS_NAME, name) } catch { /* blocked */ }
      this.nameRow.hidden = true
      this.onSaveScore(name)
    }
    this.nameSave.addEventListener('click', saveName)
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveName() }
      // The results screen binds Enter and the arrows to its own buttons, so a
      // player typing a name would otherwise trigger a rematch mid-word.
      e.stopPropagation()
    })
    toGarage.addEventListener('click', () => this.show('garage'))
    // Both mid-race exits reach the track list directly. Anything the garage is
    // reachable from, the track list is reachable from — otherwise changing
    // circuit for a rematch means walking back through a screen you did not
    // want, and nobody does it.
    resTrack.addEventListener('click', () => this.show('track'))
    this.resumeBtn.addEventListener('click', () => this.onResume())
    restartBtn.addEventListener('click', () => this.onRestart())
    pauseTrack.addEventListener('click', () => {
      this.onQuit()
      this.show('track')
    })
    quitBtn.addEventListener('click', () => {
      this.onQuit()
      this.show('garage')
    })

    this.onKey = (e: KeyboardEvent) => {
      if (this.root.classList.contains('is-hidden')) return
      if (e.key === 'Escape') {
        // An open badge card is one step deeper than the screen it sits on,
        // so Escape closes the card and stops there. The card handles its own
        // Escape while focus is inside it; this is for when it is not.
        if (this.screen === 'achievements' && this.achView.closeDetail()) {
          e.preventDefault()
          this.backCue()
          return
        }
        const back = this.escapeTarget()
        if (back) {
          e.preventDefault()
          this.backCue()
          this.show(back)
        }
        return
      }
      // A caret beats a menu. Arrows inside a text field move the caret and
      // inside a <select> change the value, and the focus walk below would do
      // BOTH -- which is how a region dropdown ends up changing region and
      // jumping the focus out of itself on one keypress.
      const from = e.target
      if (from instanceof HTMLInputElement || from instanceof HTMLSelectElement
        || from instanceof HTMLTextAreaElement) return
      // Arrow keys walk the list a keyboard player is standing in. Tab still
      // does what Tab has always done; this is the shortcut, not the mechanism.
      if (!ARROW_SCREENS.has(this.screen)) return
      const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
      if (dir === 0) return
      const vertical = e.key === 'ArrowDown' || e.key === 'ArrowUp'
      if (this.moveFocus(vertical ? 0 : dir, vertical ? dir : 0)) e.preventDefault()
    }
    window.addEventListener('keydown', this.onKey)

    container.appendChild(root)

    this.selectTrack(this.trackId)
    this.selectChassis(this.chassisId)
    this.selectPilot(this.pilotId)
    this.selectQuality(this.quality)
    this.selectDifficulty(this.difficulty)
  }

  /** One `KEY / value` block in the circuit panel. Returns the value node. */
  private fact(host: HTMLElement, label: string): HTMLElement {
    const wrap = el('div', 'sg-fact', host)
    el('div', 'sg-fact__k', wrap, label)
    return el('div', 'sg-fact__v', wrap)
  }

  // -------------------------------------------------------------------------

  show(screen: ScreenId): void {
    this.screen = screen
    this.root.dataset.screen = screen
    this.root.classList.remove('is-hidden')
    // Leaving the results screen cancels a pending auto-switch. Without this a
    // player who hit Next Race inside the three seconds would come back from
    // the race to find the previous timer had moved the tab under them.
    if (screen !== 'results') this.cancelCircuitSwitch()
    // The route bake is deferred to the first view so it never sits between
    // page load and the title screen.
    if (screen === 'track') this.refreshTrack()
    // The preview's WebGL context exists for exactly as long as the garage is
    // the screen being looked at, and not one frame longer. Every other screen
    // -- including the pause menu, which sits over a live race -- takes it
    // down, so no second context is ever alive while the game is rendering.
    if (screen === 'garage') this.preview.show()
    else this.preview.hide()
    // Only two screens reach the profile, and Back has to walk the way in.
    if (screen === 'title' || screen === 'lobby') this.profileFrom = screen
    // THE WALL IS REPAINTED ON EVERY ENTRY, the rule every screen here keeps,
    // and the account is primed on the way in: Tycoon and Collector are read
    // off it. That is a load -- and so, on the mock, the world's clock -- which
    // is the same trade the profile screen makes on its own entry and for the
    // same reason: this is somewhere the player chose to go, and an account
    // wall that could not show the account would be the wrong wall.
    if (screen === 'achievements') {
      this.achView.refresh()
      this.profile.prime()
    } else {
      this.achView.closeDetail()
    }
    // The multiplayer screens own a poll and a request, so they are told before
    // the host is -- and they are allowed to redirect: entering the room with
    // no room sends us straight back to the browser, and when that happens the
    // nested show() has already done everything below and this one must not do
    // it again for a screen that is no longer up.
    if (!this.syncMultiplayer(screen)) return
    this.onScreen(screen)
    // Focus the primary action so Enter / Space always does the obvious thing.
    // The multiplayer screens do not have one: a lobby browser's primary action
    // is "choose a row", which is not a button until a row is chosen, so they
    // take the first control on the screen and let the arrows walk from there.
    const target =
      screen === 'title' ? this.playBtn
        : screen === 'track' ? this.toGarageBtn
          : screen === 'garage' ? this.startBtn
            : screen === 'results' ? this.rematchBtn
              : screen === 'paused' ? this.resumeBtn
                : this.focusables()[0] ?? null
    if (target) {
      try {
        target.focus({ preventScroll: true })
      } catch {
        target.focus()
      }
    }
    this.padStart()
  }

  /**
   * Start and stop the two multiplayer modules for this screen.
   *
   * @returns false when entering the screen redirected us somewhere else, so
   *          the caller knows its own show() has been superseded.
   */
  private syncMultiplayer(screen: ScreenId): boolean {
    if (screen === 'profile') this.profile.enter()
    else this.profile.exit()
    const which: LobbyScreenId | null =
      screen === 'lobby' ? 'browser'
        : screen === 'lobbyNew' ? 'create'
          : screen === 'room' ? 'room' : null
    if (!which) {
      this.lobby.exit()
      return true
    }
    // The profile is what gives the lobby a name and an id to mark your own
    // rows with, so it is loaded on the way into multiplayer rather than being
    // waited for. Idempotent: it only loads once.
    this.profile.prime()
    // ui/lobby.ts builds the lobby service on its way into any of its three
    // screens, so from here on there is one to talk to and publishLoadout()
    // is allowed to reach for it. Latched rather than cleared on exit: the
    // service outlives the screen, and so does the room the player is still
    // a member of -- `exit()` says as much in its own comment.
    this.multiplayerLive = true
    this.lobby.enter(which)
    return this.screen === screen
  }

  hide(): void {
    this.root.classList.add('is-hidden')
    this.preview.hide()
    this.onScreen(null)
    this.padStop()
    const active = document.activeElement
    if (active instanceof HTMLElement && this.root.contains(active)) active.blur()
  }

  get selectedTrackId(): string { return this.trackId }
  get selectedChassisId(): string { return this.chassisId }
  get selectedPilotId(): string { return this.pilotId }

  onSaveScore: (name: string) => void = () => {}

  /** Remembered so a returning player is not retyping their name every race. */
  private static readonly LS_NAME = 'sg.name'


  /** Display name for a chassis id, falling back to the id itself. */
  private static carName(id: string): string {
    const c = CHASSIS.find((x) => x.id === id)
    return c ? c.name : (id || '—')
  }

  private static pilotName(id: string): string {
    const p = PILOTS.find((x) => x.id === id)
    return p ? p.name : ''
  }

  /**
   * A record's value, in its own units. Two of these are times and two are not,
   * which is exactly the distinction that makes a single formatter wrong.
   */
  private static recordValue(id: RecordId, v: number): string {
    if (id === 'fastestLap' || id === 'fastestRace') return fmtTime(v)
    if (id === 'bestCombo') return '×' + (v >= 10 ? v.toFixed(0) : v.toFixed(1))
    return Math.round(v).toLocaleString()
  }

  setRecords(records: TrackRecords, broken: readonly RecordId[]): void {
    this.recRows.textContent = ''
    // Every record gets a row whether or not it has been set. An empty table on
    // a fresh install tells the player nothing about what is being tracked;
    // four dashes tell them exactly what there is to go and take.
    for (const { id, label } of RECORD_ORDER) {
      const e = records[id]
      const row = el('div', 'sg-rec__row', this.recRows)
      if (broken.includes(id)) row.classList.add('is-new')
      el('span', 'sg-rec__k', row, label)
      el('span', 'sg-rec__v', row, e ? FrontEndImpl.recordValue(id, e.value) : '—')
      // THE CAR IS PART OF THE RECORD. "Fastest lap is 49.08" is trivia;
      // "49.08 in a Bulwark" is a claim a player can go and argue with.
      el('span', 'sg-rec__car', row, e ? FrontEndImpl.carName(e.chassisId) : '')
      const who = e
        ? [FrontEndImpl.pilotName(e.pilotId), e.name].filter(Boolean).join(' · ')
        : ''
      el('span', 'sg-rec__who', row, who)
      if (broken.includes(id)) el('span', 'sg-rec__new', row, 'NEW')
    }
    if (broken.length > 0) this.tabs.setMarked('records', true)
  }


  setGlobal(board: GlobalBoard): void {
    this.gloRows.textContent = ''
    if (board.status === 'loading') {
      el('div', 'sg-board__empty', this.gloRows, 'Reading the board…')
      this.gloNote.textContent = ''
      return
    }
    if (board.status !== 'ok') {
      // Said plainly. A board that silently shows nothing is indistinguishable
      // from a board nobody has set a time on, and the player deserves to know
      // which of those they are looking at.
      el('div', 'sg-board__empty', this.gloRows, 'Global board unreachable.')
      this.gloNote.textContent = 'Your times are still saved on this device.'
      return
    }
    if (board.rows.length === 0) {
      el('div', 'sg-board__empty', this.gloRows, 'No times on this circuit yet.')
    }
    for (let i = 0; i < board.rows.length; i++) {
      const e = board.rows[i]
      const row = el('div', 'sg-board__row', this.gloRows)
      if (board.rank > 0 && i === board.rank - 1) row.classList.add('is-you')
      el('span', 'sg-board__n', row, String(i + 1))
      el('span', 'sg-board__name', row, e.name || '---')
      el('span', 'sg-board__car', row, FrontEndImpl.carName(e.chassisId))
      el('span', 'sg-board__score', row, fmtTime(e.lap))
    }
    // The honest caveat. Runs are posted by a web page and bounds-checked, not
    // proven; saying so is cheaper than implying a trust the board lacks.
    this.gloNote.textContent = board.rows.length > 0
      ? 'Unverified — times are submitted by players.'
      : ''
    if (board.rank > 0) this.tabs.setMarked('global', true)
  }

  setBoard(rows: readonly ScoreEntry[], rank: number, qualifies: boolean): void {
    this.boardRows.textContent = ''
    if (rows.length === 0) {
      const empty = el('div', 'sg-board__empty', this.boardRows,
        'No runs yet. Finish a race to open the board.')
      empty.hidden = false
    }
    for (let i = 0; i < rows.length; i++) {
      const e = rows[i]
      const row = el('div', 'sg-board__row', this.boardRows)
      // `rank` is 1-based and 0 when the run did not place, so this marks the
      // row the player just earned rather than whichever row happens to match
      // their score -- two runs can tie, and highlighting both would be a lie.
      if (rank > 0 && i === rank - 1) row.classList.add('is-you')
      el('span', 'sg-board__n', row, String(i + 1))
      el('span', 'sg-board__name', row, e.name)
      // The vehicle, not the combo. Best combo has its own record row above
      // now, and four columns is as many as survives a phone width.
      el('span', 'sg-board__car', row, FrontEndImpl.carName(e.chassisId))
      el('span', 'sg-board__score', row, e.score.toLocaleString())
    }
    this.nameRow.hidden = !qualifies
    if (qualifies) {
      try {
        this.nameInput.value = window.localStorage.getItem(FrontEndImpl.LS_NAME) || ''
      } catch { this.nameInput.value = '' }
    }
    if (rank > 0 || qualifies) this.tabs.setMarked('records', true)
    if (rank > 0) {
      this.resRank.textContent = rank === 1
        ? 'NEW BEST ON THIS TRACK'
        : 'RANK ' + rank + ' OF 10'
      this.resRank.hidden = false
    } else {
      this.resRank.hidden = true
    }
  }

  // -------------------------------------------------------------------------
  // THE GRAND CIRCUIT
  // -------------------------------------------------------------------------

  setCircuit(status: CircuitStatus | null): void {
    this.circuit = status
    const active = status !== null && status.active
    // The page exists exactly while the circuit does.
    this.tabs.setPresent('circuit', active)
    if (!active) this.cancelCircuitSwitch()

    // --- the title screen's circuit block ---------------------------------
    const saved = status !== null && roundsDone(status.state) > 0
    const done = status ? roundsDone(status.state) : 0
    const over = status !== null && isComplete(status.state)
    if (saved && !over) {
      this.circuitBtn.textContent = 'Continue Circuit'
      const rows = standings(status!.state)
      const me = rows.find((r) => r.entrant.id === status!.localId)
      const place = me ? (ORD[me.place] || String(me.place)) : '-'
      this.circuitLine.textContent =
        `Round ${done + 1} of ${CIRCUIT_ROUNDS} · you are ${place} on ${me ? me.points : 0} pts`
      this.circuitNewBtn.hidden = false
    } else {
      this.circuitBtn.textContent = 'Grand Circuit'
      this.circuitLine.textContent = over
        ? `Circuit complete · ${CIRCUIT_ROUNDS} rounds`
        : `${CIRCUIT_ROUNDS} rounds · every circuit · points for every place`
      // Nothing to lose once the series is over, so the confirm-to-discard
      // button is not offered -- the gold button above already starts a fresh
      // one and a confirmation nobody needs is a control that teaches players
      // to click through confirmations.
      this.circuitNewBtn.hidden = true
    }
    // Never leave the confirm half-pressed across a state change.
    if (this.discardArmed) {
      window.clearTimeout(this.discardArmed)
      this.discardArmed = 0
      this.circuitNewBtn.textContent = 'New circuit'
    }

    // --- the garage, which is where a round is entered from ---------------
    if (active && !over) {
      const next = done
      const def = TRACKS.find((t) => t.id === trackIdForRound(next))
      this.garageHeadTitle.textContent =
        `GARAGE — ROUND ${next + 1}/${CIRCUIT_ROUNDS}` + (def ? ' · ' + def.name.toUpperCase() : '')
      this.startBtn.textContent = `Start Round ${next + 1}`
    } else {
      this.garageHeadTitle.textContent = 'GARAGE'
      this.startBtn.textContent = 'Start Race'
    }

    // --- the primary button on the results screen -------------------------
    // Rematch is the wrong word inside a series: the next round is a different
    // circuit, and "Rematch" would read as re-running the one just finished.
    this.rematchBtn.textContent = !active ? 'Rematch' : over ? 'Done' : 'Next Race'

    if (active) this.fillStandings(status!)
  }

  /**
   * Draw the championship table.
   *
   * Rebuilt from scratch on each call rather than pooled the way the standings
   * rows are: this runs once per race, not once per frame, and eight rows of
   * five spans is not worth the bookkeeping of a pool that has to be kept in
   * sync with a row count that can change.
   */
  private fillStandings(status: CircuitStatus): void {
    const { state, localId } = status
    const rows = standings(state)
    const done = roundsDone(state)
    const over = isComplete(state)
    const last = state.rounds[done - 1] ?? null
    const lastDef = last ? TRACKS.find((t) => t.id === last.trackId) : null

    this.cirTitle.textContent = over
      ? 'GRAND CIRCUIT — FINAL'
      : `GRAND CIRCUIT — ROUND ${done} OF ${CIRCUIT_ROUNDS}`

    const me = rows.find((r) => r.entrant.id === localId) ?? null
    const meIdx = me ? rows.indexOf(me) : -1
    if (me) {
      const place = ORD[me.place] || String(me.place)
      if (over) {
        this.cirYou.textContent = me.place === 1
          ? `CHAMPION — ${me.points} points`
          : `Finished ${place} on ${me.points} points`
      } else if (meIdx > 0) {
        // The gap that matters when you are not leading: the car in front.
        const ahead = rows[meIdx - 1]
        const gap = ahead.points - me.points
        this.cirYou.textContent = `You are ${place} on ${me.points} pts · `
          + (gap === 0
            ? `level with ${FrontEndImpl.pilotName(ahead.entrant.pilotId)}`
            : `${gap} behind ${FrontEndImpl.pilotName(ahead.entrant.pilotId)}`)
      } else {
        const chase = rows[1]
        const gap = chase ? me.points - chase.points : 0
        this.cirYou.textContent = `You lead on ${me.points} pts`
          + (chase && gap > 0
            ? ` · ${gap} clear of ${FrontEndImpl.pilotName(chase.entrant.pilotId)}`
            : '')
      }
    } else {
      this.cirYou.textContent = ''
    }

    this.cirRows.textContent = ''
    let youRow: HTMLElement | null = null
    for (const r of rows) {
      const row = el('div', 'sg-crow', this.cirRows)
      const isYou = r.entrant.id === localId
      if (isYou) {
        youRow = row
        row.setAttribute('aria-current', 'true')
      }
      row.classList.toggle('is-you', isYou)
      row.classList.toggle('is-win', r.place === 1)
      el('span', 'sg-crow__p', row, String(r.place))
      const name = el('span', 'sg-crow__name', row)
      const who = el('span', 'sg-crow__pilot', name)
      el('span', 'sg-crow__who', who, FrontEndImpl.pilotName(r.entrant.pilotId) || 'UNIT')
      if (isYou) el('span', 'sg-you', who, 'YOU')
      el('span', 'sg-crow__chassis', name, FrontEndImpl.carName(r.entrant.chassisId))
      // What this round did to the table. A standings screen that only shows
      // totals cannot answer "did I just gain or lose ground", which is the
      // question a player arrives with.
      const f = last ? last.finishes.find((x) => x.id === r.entrant.id) : null
      const gained = f ? pointsFor(f.position, f.finished) : 0
      const gain = el('span', 'sg-crow__gain', row,
        f ? (f.finished ? '+' + gained : 'DNF') : '')
      if (f && !f.finished) gain.classList.add('is-dnf')
      el('span', 'sg-crow__pts', row, String(r.points))
    }

    this.cirNote.textContent = over
      ? 'Points: 15-12-10-8-6-4-2-1 by place. A car that does not finish scores nothing.'
      : (lastDef ? `Last round: ${lastDef.name}. ` : '')
        + `Next: ${TRACKS.find((t) => t.id === trackIdForRound(done))?.name ?? '—'}.`

    this.cirYouRow = youRow
    this.scrollStandingsToYou()
  }

  /**
   * YOUR ROW, ON SCREEN, WITHOUT SCROLLING FOR IT.
   *
   * Exactly the problem the race standings already solved, and the same
   * answer, for the same measured reason: at 915x412 only five of the eight
   * rows fit and the list opens at the top, so a player lying 8th arrives at a
   * table that does not contain them. Centred rather than merely scrolled into
   * view, so the cars either side are visible too -- a championship position
   * means nothing without the ones it is being taken from.
   *
   * CALLED FROM TWO PLACES, and it needs both. A hidden tab panel is
   * `display: none`, so at fill time the rows report clientHeight 0 and the
   * arithmetic silently resolves to "scroll to the top" -- which is the bug,
   * not the fix. So it also runs when the page is actually opened, whether
   * that was the auto-switch or a click. scrollTop is clamped by the browser,
   * so it is a no-op wherever everything already fits.
   */
  private scrollStandingsToYou(): void {
    const row = this.cirYouRow
    if (!row) return
    requestAnimationFrame(() => {
      const host = this.cirRows
      if (!host || host.clientHeight <= 0 || !host.contains(row)) return
      host.scrollTop = Math.max(0, row.offsetTop - (host.clientHeight - row.offsetHeight) / 2)
    })
  }

  /**
   * AUTO-SWITCH TO THE STANDINGS, WITHOUT TAKING THE SCREEN OFF THE PLAYER.
   *
   * Vince asked for the race result first and the circuit table "automatically"
   * second. Three things make that a courtesy rather than a hijack:
   *
   *   1. IT DOES NOT MOVE FOCUS. tabs.ts only focuses a button from its own
   *      arrow-key handler; select() changes `aria-selected` and which panel is
   *      hidden and nothing else. Moving focus on a timer is the hostile
   *      version of this pattern -- a player mid-way through tabbing to Next
   *      Race would be thrown somewhere they did not go.
   *   2. IT LOSES TO THE PLAYER, ALWAYS. Any click or arrow press on the strip
   *      sets `tabTouched` and cancels the pending switch for this results
   *      screen. Choosing a page is a statement, and the screen does not argue.
   *   3. IT WILL NOT FIRE INTO A FOCUSED TABLIST. If focus is sitting on a tab
   *      button when the timer comes up -- a keyboard player exploring the
   *      strip -- the switch is abandoned, because changing the selection under
   *      a focused tablist is the case where "focus did not move" stops being a
   *      good enough defence.
   *
   * The tab is marked either way, so a player whose switch was cancelled still
   * sees that there is something new behind it.
   */
  private armCircuitSwitch(): void {
    this.cancelCircuitSwitch()
    this.tabTouched = false
    if (!this.tabs.isPresent('circuit')) return
    this.tabs.setMarked('circuit', true)
    this.switchTimer = window.setTimeout(() => {
      this.switchTimer = 0
      if (this.tabTouched) return
      if (this.screen !== 'results') return
      if (this.tabs.selected !== 'results') return
      const active = document.activeElement
      if (active instanceof HTMLElement && active.getAttribute('role') === 'tab') return
      this.tabs.select('circuit')
      // Said out loud, once, for anyone who cannot see the panel change.
      this.cirLive.textContent = 'Circuit standings. ' + this.cirYou.textContent
    }, CIRCUIT_AUTOSWITCH_MS)
  }

  private cancelCircuitSwitch(): void {
    if (!this.switchTimer) return
    window.clearTimeout(this.switchTimer)
    this.switchTimer = 0
  }

  /**
   * Play the standings entrance once, for THIS result.
   *
   * See the `.sg-row.is-in` block in styles.css for why the animation is on a
   * class rather than on the row: leaving it there meant every return to this
   * tab replayed it, and a replayed entrance is a table that is not there.
   *
   * Removing and re-adding the class is also what restarts it on a rematch,
   * which is what the per-row `style.animation = 'none'` dance used to do --
   * one reflow for the whole list now instead of eight.
   */
  private playRowEntrance(n: number): void {
    if (this.rowsInTimer) { window.clearTimeout(this.rowsInTimer); this.rowsInTimer = 0 }
    for (const row of this.rows) row.root.classList.remove('is-in')
    // One forced reflow, so the browser sees the class genuinely leave and
    // come back rather than coalescing the two into no change at all.
    void this.rowHost.offsetWidth
    for (let i = 0; i < n; i++) this.rows[i].root.classList.add('is-in')
    // The winner's row is the last to land: (n-1) staggers plus its own run.
    const settled = Math.max(0, n - 1) * ROW_STAGGER_MS + ROW_ENTER_MS
    this.rowsInTimer = window.setTimeout(() => {
      this.rowsInTimer = 0
      for (const row of this.rows) row.root.classList.remove('is-in')
    }, settled + 120)
  }

  showResults(state: RaceState, localId: number, run?: RunScore | null, trackId?: string): void {
    const racers = state.racers
    const order: RacerState[] = racers.slice()
    order.sort((a, b) => (a.position - b.position) || (b.totalS - a.totalS))

    const n = Math.min(order.length, MAX_ROWS)
    let local: RacerState | null = null
    for (let i = 0; i < racers.length; i++) if (racers[i].id === localId) local = racers[i]

    for (let i = 0; i < MAX_ROWS; i++) {
      const row = this.rows[i]
      if (i >= n) {
        row.root.hidden = true
        continue
      }
      const r = order[i]
      const chassisDef = CHASSIS.find((c) => c.id === r.chassisId)
      const pilotDef = PILOTS.find((p) => p.id === r.pilotId)
      const place = r.position > 0 && r.position < ORD.length ? ORD[r.position] : String(r.position)
      row.pos.textContent = place
      row.pilot.textContent = pilotDef ? pilotDef.name : 'UNIT'
      row.chassis.textContent = chassisDef ? chassisDef.name : r.chassisId
      row.time.textContent = r.finished ? fmtTime(r.finishTime) : 'DNF'
      row.best.textContent = r.bestLap > 0 ? 'best ' + fmtTime(r.bestLap) : ''
      const isYou = r.id === localId
      row.root.classList.toggle('is-you', isYou)
      row.root.classList.toggle('is-win', r.position === 1)
      row.you.hidden = !isYou
      // A screen reader gets the same fact the chip gives a sighted player,
      // rather than having to infer it from a colour it cannot see.
      if (isYou) row.root.setAttribute('aria-current', 'true')
      else row.root.removeAttribute('aria-current')
      row.root.hidden = false
      // Last place lands first, the winner lands last.
      row.root.style.setProperty('--d', ((n - 1 - i) * ROW_STAGGER_MS) + 'ms')
    }
    this.playRowEntrance(n)

    // YOUR ROW, ON SCREEN, WITHOUT SCROLLING FOR IT.
    //
    // On a short viewport the standings list is the element that gives way --
    // it shrinks and scrolls so the title, the tabs and the buttons stay put.
    // At 844x390, a phone held the way people actually hold a racing game,
    // that leaves room for about two and a half rows out of eight, and the
    // list opens at the top. Finishing 8th then means the one row the player
    // actually cares about is the one they cannot see.
    //
    // Centred rather than merely scrolled into view, so the finishing order
    // either side of them is visible too -- a position means nothing without
    // the cars it was taken from. `scrollTop` is clamped by the browser, so
    // this is a no-op when everything already fits.
    const localRow = local ? this.rows[order.findIndex((r) => r.id === localId)] : null

    // The circuit this race was run on, which in circuit mode is NOT the one
    // the track screen remembers -- the series picks it and that screen is
    // skipped. Falls back to the selection so a caller that does not say still
    // gets the behaviour it had.
    const ranOn = trackId ?? this.trackId
    const def = TRACKS.find((t) => t.id === ranOn)
    const c = copyFor(ranOn)
    this.resWhere.textContent = def
      ? (c.world ? def.name + ' — ' + c.world : def.name)
      : ''

    if (local) {
      this.resTitle.textContent = local.finished
        ? 'YOU FINISHED ' + (ORD[local.position] || String(local.position)).toUpperCase()
        : 'RACE COMPLETE'
      this.resTotal.textContent = local.finished ? fmtTime(local.finishTime) : fmtTime(state.time)
      this.resBest.textContent = fmtTime(local.bestLap)
    } else {
      this.resTitle.textContent = 'RACE COMPLETE'
      this.resTotal.textContent = fmtTime(state.time)
      this.resBest.textContent = '--:--.--'
    }

    this.resScore.textContent = run ? run.score.toLocaleString() : '0'
    this.resCombo.textContent = run
      ? '×' + (run.bestCombo >= 10 ? run.bestCombo.toFixed(0) : run.bestCombo.toFixed(1))
      : '×1.0'
    // The board and the rank are filled by setBoard() when the store answers.
    // Cleared here so a rematch never shows the PREVIOUS run's placing for the
    // moment before the new one arrives.
    this.resRank.hidden = true
    this.nameRow.hidden = true
    // Always open on the race that just happened, whichever page was left
    // selected last time. select() also clears that page's marker.
    this.tabs.select('results')
    // And, if this race was a circuit round, hand the screen over to the
    // standings a moment later. Armed AFTER the select above, so the timer
    // cannot be cancelled by its own setup. See armCircuitSwitch.
    this.cirLive.textContent = ''
    this.armCircuitSwitch()

    this.show('results')

    // AFTER show(), and a frame later. The screen is `display: none` until
    // show() runs, so a hidden element reports clientHeight 0 and offsetTop 0
    // and the arithmetic below silently resolves to "scroll to the top" --
    // which is exactly what it did on the first attempt, on every viewport.
    if (localRow && !localRow.root.hidden) {
      requestAnimationFrame(() => {
        const host = this.rowHost
        const row = localRow.root
        if (!host || !row || host.clientHeight <= 0) return
        // Centred rather than merely scrolled into view, so the finishing
        // order either side is visible too -- a position means nothing
        // without the cars it was taken from. scrollTop is clamped by the
        // browser, so this is a no-op wherever everything already fits.
        host.scrollTop = Math.max(0, row.offsetTop - (host.clientHeight - row.offsetHeight) / 2)
      })
    }
  }

  setUnlocks(ids: readonly string[]): void {
    fillUnlockStrip(this.unlockStrip, ids)
  }

  refreshAchievements(): void {
    // Only while it is the screen up: the wall is repainted on every entry
    // anyway, and a repaint nobody can see is thirty tiles of wasted DOM.
    if (this.screen === 'achievements' && !this.root.classList.contains('is-hidden')) {
      this.achView.refresh()
    }
  }

  setReducedMotion(on: boolean): void {
    this.achView.setReducedMotion(on)
    this.unlockStrip.dataset.rm = on ? 'on' : 'off'
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey)
    this.achView.dispose()
    this.cancelCircuitSwitch()
    if (this.discardArmed) { window.clearTimeout(this.discardArmed); this.discardArmed = 0 }
    if (this.rowsInTimer) { window.clearTimeout(this.rowsInTimer); this.rowsInTimer = 0 }
    this.preview.dispose()
    this.lobby.dispose()
    this.profile.dispose()
    this.padStop()
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root)
  }

  // -------------------------------------------------------------------------

  private selectTrack(id: string): void {
    this.trackId = id
    writeStore(LS_TRACK, id)
    for (let i = 0; i < this.trackCards.length; i++) {
      this.trackCards[i].classList.toggle('is-sel', TRACKS[i].id === id)
    }
    if (this.screen === 'track') this.refreshTrack()
  }

  private refreshTrack(): void {
    const def = TRACKS.find((t) => t.id === this.trackId) ?? TRACKS[0]
    const c = copyFor(def.id)

    this.trkName.textContent = def.name
    this.trkWorld.textContent = c.world
    this.trkHook.textContent = c.hook ? '"' + c.hook + '"' : ''
    this.trkNote.textContent = c.note

    let pv = this.previews.get(def.id)
    if (!pv) {
      pv = buildPreview(def)
      this.previews.set(def.id, pv)
    }
    // Replay the route sweep only when the map genuinely changes — re-picking
    // the circuit you are already on should not redraw it. The animation is
    // carried by a class the way settings.ts carries its dialog entrance, so
    // the resting state — no class — is the fully drawn map. Nothing here can
    // leave the panel blank if the animation does not run.
    if (this.trkMap.firstChild !== pv.svg) {
      this.trkMap.textContent = ''
      this.trkMap.appendChild(pv.svg)
      this.trkMap.classList.remove('is-in')
      void this.trkMap.clientWidth
      this.trkMap.classList.add('is-in')
    }

    const rank = DIFFICULTY_RANK[c.difficulty]
    this.trkDiff.textContent = ''
    const pips = el('span', 'sg-pips', this.trkDiff)
    pips.dataset.diff = c.difficulty.toLowerCase()
    for (let i = 0; i < 3; i++) {
      el('span', 'sg-pips__p', pips).classList.toggle('is-on', i < rank)
    }
    el('span', 'sg-fact__word', this.trkDiff, c.difficulty)

    this.trkLength.textContent = (pv.lengthM / 1000).toFixed(2) + ' km'
    this.trkLaps.textContent = String(def.laps)

    this.trkBar.textContent = ''
    this.trkLegend.textContent = ''
    for (const m of pv.mix) {
      const pct = Math.round(m.frac * 100)
      const seg = el('span', 'sg-trk__seg', this.trkBar)
      seg.style.setProperty('--ink', SURFACE_INK[m.kind])
      seg.style.setProperty('--w', (m.frac * 100).toFixed(2) + '%')
      const chip = el('span', 'sg-chip sg-chip--surf', this.trkLegend)
      chip.style.setProperty('--ink', SURFACE_INK[m.kind])
      el('span', '', chip, SURFACE_LABEL[m.kind])
      el('span', 'sg-chip__pct', chip, pct + '%')
    }
    this.trkFeatures.textContent = ''
    for (const f of pv.features) el('span', 'sg-chip', this.trkFeatures, f)

    this.trkClimb.textContent = '+' + Math.round(pv.climbM) + ' m'
    if (this.trkElev.firstChild !== pv.elevation) {
      this.trkElev.textContent = ''
      this.trkElev.appendChild(pv.elevation)
    }
  }

  /**
   * THE ONE WRITER, for both halves and for both screens.
   *
   * The garage's cards call `selectChassis` / `selectPilot` directly because
   * each of them changes one half; the profile changes either half through
   * here because it hands over a whole `Loadout`. Both end in the same two
   * methods, which are the only things in the program that assign these
   * fields, so there is exactly one copy of the answer and exactly one place
   * that persists it.
   *
   * Guarded on equality so a repaint is not a write: the profile re-reads and
   * re-sends the unchanged half on every press, and without this each one
   * would touch localStorage twice and re-publish an unchanged loadout to a
   * lobby room.
   */
  private setLoadout(next: Loadout): void {
    if (next.chassisId !== this.chassisId) this.selectChassis(next.chassisId)
    if (next.pilotId !== this.pilotId) this.selectPilot(next.pilotId)
  }

  private selectChassis(id: string): void {
    this.chassisId = id
    writeStore(LS_CHASSIS, id)
    for (let i = 0; i < this.chassisCards.length; i++) {
      this.chassisCards[i].classList.toggle('is-sel', CHASSIS[i].id === id)
    }
    this.refreshDetail()
    this.publishLoadout()
  }

  private selectPilot(id: string): void {
    this.pilotId = id
    writeStore(LS_PILOT, id)
    for (let i = 0; i < this.pilotCards.length; i++) {
      this.pilotCards[i].classList.toggle('is-sel', PILOTS[i].id === id)
    }
    this.refreshDetail()
    this.publishLoadout()
  }

  /**
   * CHANGING YOUR CAR WHILE SITTING IN A LOBBY.
   *
   * ui/lobby.ts publishes the loadout ONCE, from `enterRoom`, which was
   * exactly right while the garage was the only way to choose one: you passed
   * through it on the way in and could not reach it again without leaving the
   * room. The profile is reachable from the lobby browser by a button on the
   * lobby's own head, so "I joined in the Solaire, then went and picked the
   * Bulwark" is now an ordinary thing to do -- and without this the room would
   * go on showing the Solaire to seven other people, and `RaceStartPacket`
   * would put the Solaire on the grid.
   *
   * Fire-and-follow, per the contract's note on `setLoadout`: the return is
   * void and the `onRoom` push that follows is the truth. lobby.ts is already
   * subscribed to that push and repaints the member row from it, so this file
   * does not touch the lobby screens at all.
   *
   * THE GUARD IS NOT AN OPTIMISATION. `lobbyService()` CREATES the service on
   * first call, and creating one attaches to the mock world and starts its
   * clock -- the cost net/index.ts is lazy precisely to avoid. A player who
   * has never opened a multiplayer screen must not start a directory ticking
   * by picking a car, so this only ever runs once ui/lobby.ts has been
   * entered, which is the moment it builds the service itself. `current()`
   * then answers whether there is actually a room to tell.
   */
  private publishLoadout(): void {
    if (!this.multiplayerLive) return
    try {
      const svc = lobbyService()
      if (!svc.current()) return
      void svc.setLoadout(this.chassisId, this.pilotId)
    } catch {
      // A service that will not build is the lobby screen's problem to
      // report, not a reason a chassis cannot be selected.
    }
  }

  /**
   * Pick the AI difficulty, paint the segment, and remember it.
   *
   * Written through immediately rather than on Start, so a player who opens
   * the garage, sets Expert and then backs out to the title screen has still
   * set Expert. The alternative -- commit on Start -- loses the choice for
   * anyone who changes their mind about the CAR after changing it about the
   * difficulty, which is most people.
   */
  private selectDifficulty(d: Difficulty): void {
    this.difficulty = d
    writeStore(LS_DIFFICULTY, d)
    for (const b of this.difficultyBtns) b.classList.toggle('is-sel', b.dataset.diff === d)
    this.difficultyHint.textContent = DIFFICULTY_SPECS[d].blurb
  }

  private selectQuality(q: QualityTier): void {
    this.quality = q
    writeStore(LS_QUALITY, q)
    for (let i = 0; i < this.qualityBtns.length; i++) {
      this.qualityBtns[i].classList.toggle('is-sel', QUALITIES[i] === q)
    }
    // The quality control is on this screen, so it should be answerable on
    // this screen: the preview rebuilds at the chosen tier and the player can
    // see what LOW actually costs them before they commit to a race.
    this.preview.setQuality(q)
  }

  private refreshDetail(): void {
    const def = CHASSIS.find((c) => c.id === this.chassisId) ?? CHASSIS[0]
    const pilot = PILOTS.find((p) => p.id === this.pilotId) ?? PILOTS[0]
    this.detName.textContent = def.name
    this.detNick.textContent = '"' + def.nickname + '"'
    for (let i = 0; i < STAT_KEYS.length; i++) {
      const key = STAT_KEYS[i].k
      const v = def.stats[key]
      const add = pilot.stats[key] ?? 0
      // The chassis bar is unchanged: the pilot EXTENDS it rather than
      // rescaling it, so a player comparing two chassis is comparing the same
      // quantity whichever pilot happens to be selected.
      const base = Math.max(0, Math.min(1, v / 10))
      this.statFills[i].style.setProperty('--v', String(base))
      // Clamped against the same 0..10 ceiling the sim clamps to, so the yellow
      // can never draw past the end of the track on a roster-max stat.
      const top = Math.max(0, Math.min(1, (v + add) / 10))
      const seg = Math.max(0, top - base)
      this.statBonus[i].hidden = add <= 0
      this.statBonus[i].style.setProperty('--o', String(base))
      // A visible floor, so +0.5 is a sliver rather than a sub-pixel nothing.
      this.statBonus[i].style.setProperty('--b', String(seg > 0 ? Math.max(0.015, seg) : 0))
      this.statVals[i].firstChild!.textContent = String(v)
      this.statBVals[i].textContent = add > 0 ? '+' + add.toFixed(1) : ''
    }
    // Four of the six pilots keep most of their value in an ability, which has
    // no bar to extend. Said in words rather than given an invented gauge.
    this.detPerkName.textContent = pilot.name
    this.detPerkText.textContent = pilot.perk
    this.detNote.textContent =
      LOCO_NOTE[def.locomotion] + '  //  PILOT ' + pilot.name + ' — ' + pilot.read
    // One place for both halves of the selection. selectChassis and selectPilot
    // both land here, so the car in the box can never disagree with the card
    // that is lit up in either list.
    this.preview.setSelection(def.id, pilot.id)
  }

  /**
   * How to work THIS screen, in the language of whatever the player is holding.
   * The garage's hint explains how to drive; on the track list the useful thing
   * to say is how to move the selection, because that is the only interaction
   * on it and on a pad it is not a click.
   */
  private fillPickHint(host: HTMLElement): void {
    const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
    if (touch) {
      // Deliberately does NOT repeat the primary button's label. A hint that
      // quotes the button it is pointing at gives the screen two elements with
      // the same words, and the wrong one is the one that comes first.
      host.appendChild(document.createTextNode('Tap a circuit to read its briefing'))
      return
    }
    el('span', 'sg-key', host, '↑ ↓')
    host.appendChild(document.createTextNode(' or '))
    el('span', 'sg-key', host, 'D-PAD')
    host.appendChild(document.createTextNode(' choose · '))
    el('span', 'sg-key', host, 'ENTER')
    host.appendChild(document.createTextNode(' / '))
    el('span', 'sg-key', host, 'A')
    host.appendChild(document.createTextNode(' confirm · '))
    el('span', 'sg-key', host, 'ESC')
    host.appendChild(document.createTextNode(' / '))
    el('span', 'sg-key', host, 'B')
    host.appendChild(document.createTextNode(' back'))
  }

  // -------------------------------------------------------------------------
  // Focus navigation — shared by the arrow keys and the gamepad
  // -------------------------------------------------------------------------

  /** Every enabled button on the screen that is currently up. */
  private focusables(): HTMLButtonElement[] {
    // An open badge card is modal: the walk stays inside it, or a pad's
    // right-press would carry focus onto a tile behind the scrim.
    const host = this.screen === 'achievements' && this.achView.detailOpen
      ? this.achView.focusRoot
      : this.screens[this.screen]
    const all = host.querySelectorAll<HTMLButtonElement>('button:not([disabled])')
    const out: HTMLButtonElement[] = []
    for (let i = 0; i < all.length; i++) {
      if (!all[i].hasAttribute('hidden')) out.push(all[i])
    }
    return out
  }

  /**
   * Move focus one step along (dx, dy) in screen space.
   *
   * Spatial rather than DOM-order because the garage is three columns wide: a
   * player pressing right off a chassis card means the pilot list, not "the
   * next node in the tree", and no ordering of the markup makes both axes come
   * out right. Rects are read only on an actual press — a handful per input,
   * on a screen that is not on the frame budget.
   */
  private moveFocus(dx: number, dy: number): boolean {
    const list = this.focusables()
    if (list.length === 0) return false
    const active = document.activeElement
    const cur = active instanceof HTMLElement && list.indexOf(active as HTMLButtonElement) >= 0
      ? (active as HTMLButtonElement) : null
    if (!cur) {
      list[0].focus()
      // The tick of the selection moving. Only for the arrow keys and the pad,
      // which is everything that calls this: a pointer does not move focus
      // before it presses, so it hears the press and nothing else.
      cue('uiMove')
      return true
    }
    const a = cur.getBoundingClientRect()
    const ax = a.left + a.width * 0.5
    const ay = a.top + a.height * 0.5
    // A candidate only counts as "that way" once its centre clears the current
    // element's own half-extent along the axis. A bare `> 0` test is not enough:
    // a selected card carries `translateX(3px)`, which put every one of its
    // unselected column-mates three pixels to the LEFT of it — so pressing left
    // from the selected pilot walked down the pilot list instead of crossing to
    // the chassis column, and the mistake was invisible in a static screenshot.
    const gate = Math.max(6, (dx !== 0 ? a.width : a.height) * 0.5)
    let best: HTMLButtonElement | null = null
    let bestScore = Infinity
    let wrap: HTMLButtonElement | null = null
    let wrapScore = Infinity
    for (let i = 0; i < list.length; i++) {
      const n = list[i]
      if (n === cur) continue
      const b = n.getBoundingClientRect()
      if (b.width === 0 && b.height === 0) continue
      const vx = b.left + b.width * 0.5 - ax
      const vy = b.top + b.height * 0.5 - ay
      const along = vx * dx + vy * dy
      const across = Math.abs(vx * -dy + vy * dx)
      if (along <= gate) {
        // Furthest thing behind us, kept for the wrap below. Across is weighted
        // the same as along here, so a wrap prefers the far end of the column
        // it is already in over the far corner of the screen.
        const w = along + across
        if (w < wrapScore) { wrapScore = w; wrap = n }
        continue
      }
      // Off-axis is penalised hard, so "down" never jumps to a neighbouring
      // column just because it happens to be slightly lower.
      const score = along + across * 2.6
      if (score < bestScore) { bestScore = score; best = n }
    }
    // Nothing ahead: wrap to the far side. Screens focus their primary action
    // on entry and the primary action sits in the bottom corner, so without
    // this the very first press a pad or arrow-key player makes — down — is a
    // dead end, and the lists are only reachable by guessing another direction.
    if (!best) best = wrap
    if (!best) return false
    try {
      best.focus({ preventScroll: false })
    } catch {
      best.focus()
    }
    cue('uiMove')
    return true
  }

  // -------------------------------------------------------------------------
  // Gamepad
  //
  // game/input.ts owns the pad during a race and knows nothing about menus, so
  // the front end reads the pad itself while it is up. It only ever moves DOM
  // focus and dispatches a click, which is why every screen — including the
  // garage, which never had pad support — gets it from this one place instead
  // of growing a parallel selection model.
  //
  // Polled on a timer rather than rAF: menus are idle, and a pad that is not
  // there costs one navigator.getGamepads() every 60ms.
  // -------------------------------------------------------------------------

  private padStart(): void {
    if (this.padTimer !== 0 || typeof window === 'undefined') return
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return
    // Seed the edge state so a button already held when the screen appears —
    // the A that just released a drift, say — is not read as a fresh press.
    this.padPrev = this.padBits()
    this.padDir = 0
    this.padRepeat = 0
    this.padTimer = window.setInterval(this.padPoll, PAD_POLL_MS)
  }

  private padStop(): void {
    if (this.padTimer === 0) return
    window.clearInterval(this.padTimer)
    this.padTimer = 0
  }

  /** Direction + face buttons squashed into one bitmask. */
  private padBits(): number {
    const pads = navigator.getGamepads()
    let bits = 0
    for (let i = 0; i < pads.length; i++) {
      const gp = pads[i]
      if (!gp || !gp.connected) continue
      const x = gp.axes.length > 0 ? gp.axes[0] : 0
      const y = gp.axes.length > 1 ? gp.axes[1] : 0
      const down = (k: number): boolean => {
        const b = gp.buttons[k]
        return b ? b.pressed === true : false
      }
      if (down(14) || x < -PAD_AXIS) bits |= PAD_L
      if (down(15) || x > PAD_AXIS) bits |= PAD_R
      if (down(12) || y < -PAD_AXIS) bits |= PAD_U
      if (down(13) || y > PAD_AXIS) bits |= PAD_D
      if (down(0)) bits |= PAD_A
      if (down(1)) bits |= PAD_B
    }
    return bits
  }

  private padPoll = (): void => {
    if (this.root.classList.contains('is-hidden')) return
    const bits = this.padBits()
    const rising = bits & ~this.padPrev
    this.padPrev = bits

    const dir = (bits & PAD_L) !== 0 ? PAD_L
      : (bits & PAD_R) !== 0 ? PAD_R
        : (bits & PAD_U) !== 0 ? PAD_U
          : (bits & PAD_D) !== 0 ? PAD_D : 0

    if (dir === 0) {
      this.padDir = 0
      this.padRepeat = 0
    } else if (dir !== this.padDir) {
      this.padDir = dir
      this.padRepeat = PAD_DELAY_MS
      this.padNudge(dir)
    } else {
      this.padRepeat -= PAD_POLL_MS
      if (this.padRepeat <= 0) {
        this.padRepeat = PAD_REPEAT_MS
        this.padNudge(dir)
      }
    }

    if ((rising & PAD_A) !== 0) {
      const active = document.activeElement
      if (active instanceof HTMLElement && this.root.contains(active)) active.click()
      else this.focusables()[0]?.focus()
    } else if ((rising & PAD_B) !== 0) {
      this.padBack()
    }
  }

  private padNudge(dir: number): void {
    // A badge card open: up and down scroll its ladder, as the arrow keys do.
    if ((dir === PAD_U || dir === PAD_D) && this.screen === 'achievements' && this.achView.detailOpen) {
      this.achView.scrollDetail(dir === PAD_U ? -1 : 1)
      return
    }
    if (dir === PAD_L) this.moveFocus(-1, 0)
    else if (dir === PAD_R) this.moveFocus(1, 0)
    else if (dir === PAD_U) this.moveFocus(0, -1)
    else this.moveFocus(0, 1)
  }

  /** B is Escape: the same one step back the keyboard takes. */
  private padBack(): void {
    if (this.screen === 'paused') { this.backCue(); this.onResume(); return }
    if (this.screen === 'achievements' && this.achView.closeDetail()) { this.backCue(); return }
    const back = this.escapeTarget()
    if (back) { this.backCue(); this.show(back) }
  }

  /**
   * When a handler last played its own cue, so the delegated click listener in
   * the constructor does not add a select on top of the same press.
   */
  private cuedAt = -1

  /** A step back that did not come from a `data-sfx="back"` button. */
  private backCue(): void {
    this.cuedAt = performance.now()
    cue('uiBack')
  }

  /**
   * One step back from wherever we are, or null for nowhere to go.
   *
   * THE ROOM STEPS BACK TO THE BROWSER WITHOUT LEAVING THE LOBBY. Backing out
   * of a screen and leaving a lobby are different intentions, and conflating
   * them means a mis-pressed Escape throws away a room the player was waiting
   * in. Leaving has its own button, on the room's own head, and it is the only
   * thing in the front end that calls `LobbyService.leave`.
   */
  private escapeTarget(): ScreenId | null {
    switch (this.screen) {
      case 'garage': return 'track'
      case 'track': return 'title'
      case 'lobby': return 'title'
      case 'lobbyNew': return 'lobby'
      case 'room': return 'lobby'
      case 'profile': return this.profileFrom
      case 'achievements': return 'title'
      default: return null
    }
  }

  private fillControlHint(host: HTMLElement): void {
    const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
    if (touch) {
      host.appendChild(document.createTextNode('Steer left thumb · '))
      el('span', 'sg-key', host, 'DRIFT')
      host.appendChild(document.createTextNode(' and '))
      el('span', 'sg-key', host, 'ITEM')
      host.appendChild(document.createTextNode(' right thumb'))
      return
    }
    el('span', 'sg-key', host, 'W A S D')
    host.appendChild(document.createTextNode(' drive · '))
    el('span', 'sg-key', host, 'SHIFT')
    host.appendChild(document.createTextNode(' drift · '))
    el('span', 'sg-key', host, 'SPACE')
    host.appendChild(document.createTextNode(' item · '))
    el('span', 'sg-key', host, 'ESC')
    host.appendChild(document.createTextNode(' pause'))
  }
}

// ---------------------------------------------------------------------------

export function createFrontEnd(container: HTMLElement): FrontEnd {
  return new FrontEndImpl(container)
}
