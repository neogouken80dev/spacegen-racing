/**
 * SpaceGen Racing — front end.
 *
 * Five screens: title, track, garage, results, paused. Nothing stands between
 * load and the first race: the title screen is a logo and one huge PLAY button,
 * and the two setup screens run in the order a player thinks in — pick the
 * planet, then pick the car to take to it.
 *
 * Unlike the HUD this is not on the frame budget, but every node is still
 * built once and reused so a rematch never leaks DOM.
 *
 * Every control on every screen is a real <button>. That is the whole
 * accessibility strategy: pointer, touch, keyboard and gamepad all converge on
 * one click event, so there is no second interaction model to keep in sync.
 */
import './styles.css'
import type { RaceState, RacerState } from '../sim/types'
import { CHASSIS } from '../content/chassis'
import { PILOTS } from '../content/pilots'
import { TRACKS } from '../content/tracks'
import { Track, type SurfaceKind, type TrackDef } from '../sim/track'
import { copyFor, DIFFICULTY_RANK } from './trackCopy'

export type QualityTier = 'low' | 'medium' | 'high'
export type ScreenId = 'title' | 'track' | 'garage' | 'results' | 'paused'

export interface StartSelection {
  trackId: string
  chassisId: string
  pilotId: string
  quality: QualityTier
}

export interface FrontEnd {
  root: HTMLElement
  show(screen: ScreenId): void
  hide(): void
  onStart: (sel: StartSelection) => void
  onRematch: () => void
  /** Optional extras the host may wire; all default to no-ops. */
  onResume: () => void
  onRestart: () => void
  onQuit: () => void
  showResults(state: RaceState, localId: number): void
  dispose(): void
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

const LS_CHASSIS = 'sg.chassis'
const LS_PILOT = 'sg.pilot'
const LS_QUALITY = 'sg.quality'
const LS_TRACK = 'sg.track'

const ORD = ['-', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th']

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

  private screen: ScreenId = 'title'

  private trackId: string
  private chassisId: string
  private pilotId: string
  private quality: QualityTier

  private readonly trackCards: HTMLElement[] = []
  private readonly chassisCards: HTMLElement[] = []
  private readonly pilotCards: HTMLElement[] = []
  private readonly qualityBtns: HTMLElement[] = []

  private readonly detName: HTMLElement
  private readonly detNick: HTMLElement
  private readonly statFills: HTMLElement[] = []
  private readonly statVals: HTMLElement[] = []
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
  private readonly resTitle: HTMLElement
  private readonly resWhere: HTMLElement
  private readonly resTotal: HTMLElement
  private readonly resBest: HTMLElement

  private readonly playBtn: HTMLButtonElement
  private readonly toGarageBtn: HTMLButtonElement
  private readonly startBtn: HTMLButtonElement
  private readonly rematchBtn: HTMLButtonElement
  private readonly resumeBtn: HTMLButtonElement

  private readonly screens: Record<ScreenId, HTMLElement>

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
      card.addEventListener('click', () => this.selectChassis(def.id))
      this.chassisCards.push(card)
    }

    // detail column
    const dCol = el('div', 'sg-col sg-col--detail', grid)
    el('div', 'sg-col__title', dCol, 'Loadout')
    const detail = el('div', 'sg-detail', dCol)
    this.detName = el('div', 'sg-detail__name', detail)
    this.detNick = el('div', 'sg-detail__nick', detail)
    const stats = el('div', 'sg-stats', detail)
    for (let i = 0; i < STAT_KEYS.length; i++) {
      const row = el('div', 'sg-stat', stats)
      el('span', 'sg-stat__k', row, STAT_KEYS[i].label)
      const track = el('span', 'sg-stat__track', row)
      this.statFills.push(el('span', 'sg-stat__fill', track))
      this.statVals.push(el('span', 'sg-stat__v', row, '0'))
    }
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
    const controls = el('div', 'sg-controls', opts)
    this.fillControlHint(controls)
    this.startBtn = button('sg-btn sg-btn--gold sg-btn--start', opts, 'Start Race')

    // =====================================================================
    // RESULTS
    // =====================================================================
    const results = el('div', 'sg-screen sg-screen--results', root)
    this.resTitle = el('div', 'sg-results__title', results, 'RACE COMPLETE')
    this.resWhere = el('div', 'sg-results__where', results)
    const rowHost = el('div', 'sg-results__rows', results)
    for (let i = 0; i < MAX_ROWS; i++) {
      const row = el('div', 'sg-row', rowHost)
      const pos = el('span', 'sg-row__p', row, '-')
      const name = el('span', 'sg-row__name', row)
      const pilot = el('span', 'sg-row__pilot', name, '')
      const chassis = el('span', 'sg-row__chassis', name, '')
      const time = el('span', 'sg-row__time', row, '--:--.--')
      const best = el('span', 'sg-row__best', row, '')
      row.hidden = true
      this.rows.push({ root: row, pos, pilot, chassis, time, best })
    }
    const meta = el('div', 'sg-results__meta', results)
    const m1 = el('div', 'sg-meta', meta)
    el('div', 'sg-meta__k', m1, 'Total Time')
    this.resTotal = el('div', 'sg-meta__v', m1, '--:--.--')
    const m2 = el('div', 'sg-meta', meta)
    el('div', 'sg-meta__k', m2, 'Best Lap')
    this.resBest = el('div', 'sg-meta__v', m2, '--:--.--')
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

    this.screens = {
      title, track: trackScr, garage, results, paused,
    }

    // =====================================================================
    // Wiring
    // =====================================================================
    this.playBtn.addEventListener('click', () => this.show('track'))
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
      })
    })
    this.rematchBtn.addEventListener('click', () => this.onRematch())
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
        if (this.screen === 'garage') {
          e.preventDefault()
          this.show('track')
        } else if (this.screen === 'track') {
          e.preventDefault()
          this.show('title')
        }
        return
      }
      // Arrow keys walk the list a keyboard player is standing in. Tab still
      // does what Tab has always done; this is the shortcut, not the mechanism.
      if (this.screen !== 'track' && this.screen !== 'garage') return
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
    // The route bake is deferred to the first view so it never sits between
    // page load and the title screen.
    if (screen === 'track') this.refreshTrack()
    // Focus the primary action so Enter / Space always does the obvious thing.
    const target =
      screen === 'title' ? this.playBtn
        : screen === 'track' ? this.toGarageBtn
          : screen === 'garage' ? this.startBtn
            : screen === 'results' ? this.rematchBtn
              : this.resumeBtn
    try {
      target.focus({ preventScroll: true })
    } catch {
      target.focus()
    }
    this.padStart()
  }

  hide(): void {
    this.root.classList.add('is-hidden')
    this.padStop()
    const active = document.activeElement
    if (active instanceof HTMLElement && this.root.contains(active)) active.blur()
  }

  showResults(state: RaceState, localId: number): void {
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
      row.root.classList.toggle('is-you', r.id === localId)
      row.root.classList.toggle('is-win', r.position === 1)
      row.root.hidden = false
      // Last place lands first, the winner lands last.
      row.root.style.setProperty('--d', ((n - 1 - i) * 150) + 'ms')
      // Restart the entrance animation on every rematch.
      row.root.style.animation = 'none'
      void row.root.offsetWidth
      row.root.style.animation = ''
    }

    const def = TRACKS.find((t) => t.id === this.trackId)
    const c = copyFor(this.trackId)
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

    this.show('results')
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey)
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

  private selectChassis(id: string): void {
    this.chassisId = id
    writeStore(LS_CHASSIS, id)
    for (let i = 0; i < this.chassisCards.length; i++) {
      this.chassisCards[i].classList.toggle('is-sel', CHASSIS[i].id === id)
    }
    this.refreshDetail()
  }

  private selectPilot(id: string): void {
    this.pilotId = id
    writeStore(LS_PILOT, id)
    for (let i = 0; i < this.pilotCards.length; i++) {
      this.pilotCards[i].classList.toggle('is-sel', PILOTS[i].id === id)
    }
    this.refreshDetail()
  }

  private selectQuality(q: QualityTier): void {
    this.quality = q
    writeStore(LS_QUALITY, q)
    for (let i = 0; i < this.qualityBtns.length; i++) {
      this.qualityBtns[i].classList.toggle('is-sel', QUALITIES[i] === q)
    }
  }

  private refreshDetail(): void {
    const def = CHASSIS.find((c) => c.id === this.chassisId) ?? CHASSIS[0]
    const pilot = PILOTS.find((p) => p.id === this.pilotId) ?? PILOTS[0]
    this.detName.textContent = def.name
    this.detNick.textContent = '"' + def.nickname + '"'
    for (let i = 0; i < STAT_KEYS.length; i++) {
      const v = def.stats[STAT_KEYS[i].k]
      this.statFills[i].style.setProperty('--v', String(Math.max(0, Math.min(1, v / 10))))
      this.statVals[i].textContent = String(v)
    }
    this.detNote.textContent =
      LOCO_NOTE[def.locomotion] + '  //  PILOT ' + pilot.name + ' — ' + pilot.read
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
    const host = this.screens[this.screen]
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
    if (dir === PAD_L) this.moveFocus(-1, 0)
    else if (dir === PAD_R) this.moveFocus(1, 0)
    else if (dir === PAD_U) this.moveFocus(0, -1)
    else this.moveFocus(0, 1)
  }

  /** B is Escape: the same one step back the keyboard takes. */
  private padBack(): void {
    if (this.screen === 'garage') this.show('track')
    else if (this.screen === 'track') this.show('title')
    else if (this.screen === 'paused') this.onResume()
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
