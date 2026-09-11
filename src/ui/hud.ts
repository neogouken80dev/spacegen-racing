/**
 * SpaceGen Racing — race HUD.
 *
 * Contract: every element is built ONCE in createHud(). update() runs at
 * display rate and is only ever allowed to mutate textContent, style
 * transforms / opacity and CSS custom properties. No innerHTML, no
 * createElement, no querySelector past construction.
 *
 * Layout follows kart-racer convention because it is a solved readability
 * problem: position top-left, minimap top-right, item bottom-left, drift ring
 * bottom-right, charge bottom-centre, threats on the screen rim, transient
 * messages dead centre.
 *
 * On a compact / touch layout the two bottom instruments become one thing. A
 * landscape phone is 390-430 CSS px tall and the ring alone is a quarter of
 * that, so the ring flattens into a bar and joins the charge pill in a single
 * horizontal strip at bottom centre, between the two reserved thumb zones. Both
 * presentations are built here and CSS picks one; see .sg-hud__band in
 * styles.css. update() feeds both and never asks which is on screen.
 */
import './styles.css'
import type { ItemId, RaceState, RacerState } from '../sim/types'
import type { Track } from '../sim/track'
import { ITEMS, ITEM_ORDER } from '../content/items'
import { CHASSIS_BY_ID, getDerived, getLocomotion } from '../content/chassis'
import { TUNING } from '../content/tuning'

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/**
 * What the HUD needs to know to draw the finish card. `null` puts it away and
 * hands the racing instruments back.
 */
export interface FinishInfo {
  /** 1..N, the place the local racer actually took. */
  position: number
  /** Their total race time, seconds. */
  time: number
  /** How many cars are still out on the circuit. */
  stillRacing: number
  /** True once the skip guard has expired and the prompt means something. */
  canSkip: boolean
}

export interface Hud {
  root: HTMLElement
  update(state: RaceState, localId: number, track: Track, fps: number): void
  showCountdown(n: number | string): void
  /**
   * Enter or leave the finish ceremony. While it is set the driving
   * instruments are hidden — speed, drift ring, items, charge, lift and the
   * threat rim all describe a car the player is no longer steering, and a live
   * speedo on an AI-driven victory lap is a lie. The minimap stays, because
   * where the rest of the field is IS the interesting information while you
   * wait for it.
   */
  setFinish(info: FinishInfo | null): void
  /**
   * Tell the HUD that the callout layer has already announced this frame's
   * drift release, so the centre-screen boost flash stands down for it. Set
   * before update(); it is per-frame, never sticky.
   */
  setDriftReleaseTaken(taken: boolean): void
  /** The skip control, so the host can wire it to the results transition. */
  readonly skipButton: HTMLButtonElement
  dispose(): void
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ORD_NUM = ['-', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']
const ORD_SUF = ['', 'st', 'nd', 'rd', 'th', 'th', 'th', 'th', 'th', 'th', 'th', 'th', 'th']

/**
 * Drift tier names, indexed by RacerState.driftTier (0..3).
 *
 * These used to read MINI / SUPER / ULTRA / OMEGA, which is Mario Kart's
 * naming, not this game's. The design docs, the tuning comments and the
 * balance gate have all called tier 3 SINGULARITY since the drift rework; the
 * HUD was the one place still saying something else, and the callouts in
 * cheer.ts have to be able to name the rung the player just banked.
 */
const TIER_NAME = ['SPARK', 'FLARE', 'NOVA', 'SINGULARITY']
const TIER_COLOR = ['#3d8bff', '#b44dff', '#ffd23f', '#ffffff']

/**
 * How many COMPLETED laps the split list will show at once.
 *
 * The shipped race is three laps, so this is never reached: two finished laps
 * plus the live one is the whole widget. It exists so a longer race degrades
 * into something a driver can still read at 300 km/h instead of a column that
 * grows until it reaches the horizon — past this many laps the fastest one
 * pins to the top (it is the lap being chased) and the rest of the window is
 * the most recent laps.
 */
const SPLIT_ROWS = 4

const RING_R = 52
const RING_C = 2 * Math.PI * RING_R
const SPD_R = 38
const SPD_C = 2 * Math.PI * SPD_R
const SPD_ARC = SPD_C * (240 / 360)

/** Max drift charge = the last tier threshold. */
const DRIFT_MAX = TUNING.drift.tierTimes[TUNING.drift.tierTimes.length - 1]

/**
 * THE CROSSWIND INDICATOR.
 *
 * Reported from play on The Hollow Choir: "I didn't have any visual cues of
 * the crosswind to know what was going on." The blown debris in the world is
 * the primary cue; this is the one that cannot be missed, cannot be mistaken
 * for scenery, and survives a player who has turned reduced motion on.
 *
 * IT READS `RacerState.windPush`, which is the acceleration the sim ACTUALLY
 * applied to this racer this frame — already scaled by the chassis's
 * `fieldForceMult` and already capped against the friction budget. It is never
 * recomputed from `TrackSample.wind`: the cap folds in the chassis, the
 * surface, the vacuum and whether the car is airborne, and the HUD must agree
 * with the tyres rather than with the level file.
 *
 * SIGN IS SCREEN DIRECTION, and it happens to need no conversion. Positive
 * push is toward `TrackSample.right`, which is `forward x up`; the chase
 * camera's own screen-right basis vector is also `forward x up`. So a positive
 * push points the chevrons right because the car really is going right on
 * screen. (At yaw 0 both are world MINUS X. This repo has had that backwards
 * twice; it is written down here so the third time is caught.)
 */
const WIND_BARS = 4

/** |windPush| in m/s^2 at which each rung lights. */
const WIND_STEPS = [1.5, 5, 9, 12.5]

/**
 * Show / hide thresholds, m/s^2. Hysteresis, because a wind band ramps in and
 * out over ~70 m and the bake carves calm air around every item-box row: a
 * single threshold makes the widget blink on and off across those seams.
 */
const WIND_SHOW = 1.5
const WIND_HIDE = 0.9

/** Chevrons. Stroke only, so `currentColor` carries the lit state. */
const CHEV_L =
  '<svg class="sg-wind__chSvg" viewBox="0 0 12 16" aria-hidden="true">' +
  '<path d="M9 2 L3 8 L9 14" fill="none" stroke="currentColor" stroke-width="3" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>'
const CHEV_R =
  '<svg class="sg-wind__chSvg" viewBox="0 0 12 16" aria-hidden="true">' +
  '<path d="M3 2 L9 8 L3 14" fill="none" stroke="currentColor" stroke-width="3" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>'

const WARN_SLOTS = 4
const WARN_ITEMS: ItemId[] = [
  'railMissile', 'seekerMissile', 'alphaMissile', 'voidMine', 'gravityWell',
]

const ITEM_INDEX: Record<string, number> = {}
for (let i = 0; i < ITEM_ORDER.length; i++) ITEM_INDEX[ITEM_ORDER[i]] = i

// ---------------------------------------------------------------------------
// Item glyphs — authored inline, distinct silhouettes, readable at 40px.
// Shape carries identity; colour is a second channel only (colourblind-safe).
// ---------------------------------------------------------------------------

const ICON_BODY: Record<ItemId, string> = {
  // spiked disc
  voidMine:
    '<polygon points="24,4 28.4,13.38 38.14,9.86 34.62,19.6 44,24 34.62,28.4 38.14,38.14 28.4,34.62 24,44 19.6,34.62 9.86,38.14 13.38,28.4 4,24 13.38,19.6 9.86,9.86 19.6,13.38" fill="currentColor"/>' +
    '<circle cx="24" cy="24" r="6.6" fill="#070c18"/><circle cx="24" cy="24" r="2.8" fill="currentColor"/>',
  // rotary barrel cluster with a muzzle flare
  laserGatling:
    '<g fill="currentColor">' +
    '<rect x="5" y="17.5" width="19" height="13" rx="3"/>' +
    '<circle cx="12.5" cy="24" r="7.6" fill="#070c18"/><circle cx="12.5" cy="24" r="3.6"/>' +
    '<rect x="23" y="14.5" width="15" height="4.1" rx="2"/>' +
    '<rect x="23" y="21.9" width="18" height="4.2" rx="2"/>' +
    '<rect x="23" y="29.3" width="15" height="4.1" rx="2"/>' +
    '</g>' +
    '<g stroke="currentColor" stroke-width="3" stroke-linecap="round">' +
    '<path d="M41 24 H45.5"/><path d="M39.5 17 L43 13.8"/><path d="M39.5 31 L43 34.2"/></g>',
  // one fat arrow
  nitro:
    '<path d="M24 3 L41.5 24.5 H32.5 V44.5 H15.5 V24.5 H6.5 Z" fill="currentColor"/>',
  // three stacked chevrons
  nitroTriple:
    '<g fill="none" stroke="currentColor" stroke-width="5.6" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M9 20.5 L24 7 L39 20.5"/><path d="M9 32 L24 18.5 L39 32"/><path d="M9 43.5 L24 30 L39 43.5"/></g>',
  // dart between two straight rails
  railMissile:
    '<g stroke="currentColor" stroke-linecap="round" fill="none">' +
    '<path d="M9 10 V38" stroke-width="3.2" opacity="0.7"/><path d="M39 10 V38" stroke-width="3.2" opacity="0.7"/>' +
    '<path d="M24 25 V45" stroke-width="5.4"/></g>' +
    '<path d="M24 3 L33 27 L24 22 L15 27 Z" fill="currentColor"/>',
  // dart with twin curved exhausts
  seekerMissile:
    '<g stroke="currentColor" stroke-width="4.4" stroke-linecap="round" fill="none">' +
    '<path d="M24 24 C 24 33 32.5 35 35.5 44.5"/><path d="M24 24 C 24 33 15.5 35 12.5 44.5"/></g>' +
    '<path d="M24 3.5 L32.5 26 L24 21 L15.5 26 Z" fill="currentColor"/>',
  // reticle diamond with a locked bar
  alphaMissile:
    '<path d="M24 3 L45 24 L24 45 L3 24 Z" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linejoin="round"/>' +
    '<path d="M24 12 L34 30 H14 Z" fill="currentColor"/>' +
    '<path d="M15 36 H33" stroke="currentColor" stroke-width="3.6" stroke-linecap="round"/>',
  // concentric burst
  empBomb:
    '<circle cx="24" cy="24" r="5.4" fill="currentColor"/>' +
    '<g fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round">' +
    '<path d="M15.5 15.5 A 12 12 0 0 1 32.5 15.5"/><path d="M15.5 32.5 A 12 12 0 0 0 32.5 32.5"/>' +
    '<path d="M10.6 10.6 A 19 19 0 0 1 37.4 10.6"/><path d="M10.6 37.4 A 19 19 0 0 0 37.4 37.4"/></g>',
  // hexagon core
  overdriveCore:
    '<path d="M24 4 L41.3 14 L41.3 34 L24 44 L6.7 34 L6.7 14 Z" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linejoin="round"/>' +
    '<path d="M24 15 L31.8 19.5 L31.8 28.5 L24 33 L16.2 28.5 L16.2 19.5 Z" fill="currentColor"/>',
  // funnel
  gravityWell:
    '<g fill="none" stroke="currentColor" stroke-linecap="round">' +
    '<ellipse cx="24" cy="12.5" rx="19" ry="7.5" stroke-width="3.2"/>' +
    '<ellipse cx="24" cy="24" rx="12.5" ry="5" stroke-width="3"/>' +
    '<ellipse cx="24" cy="33" rx="6.5" ry="2.8" stroke-width="2.6"/></g>' +
    '<circle cx="24" cy="41.5" r="3.4" fill="currentColor"/>',
}

const BOLT_BODY =
  '<path d="M28 2 L10 27 H21.5 L18.5 46 L38 20 H25.5 Z" fill="currentColor"/>'

// ---------------------------------------------------------------------------
// Small builders (construction time only)
// ---------------------------------------------------------------------------

function hex(n: number): string {
  return '#' + (n & 0xffffff).toString(16).padStart(6, '0')
}

function div(cls: string, parent?: Element): HTMLDivElement {
  const d = document.createElement('div')
  d.className = cls
  if (parent) parent.appendChild(d)
  return d
}

function span(cls: string, parent?: Element, text?: string): HTMLSpanElement {
  const s = document.createElement('span')
  s.className = cls
  if (text !== undefined) s.textContent = text
  if (parent) parent.appendChild(s)
  return s
}

/** Parse authored markup into a live SVG element. Never called from update(). */
function svgFrom(markup: string): SVGSVGElement {
  const host = document.createElement('div')
  host.innerHTML = markup
  return host.firstElementChild as SVGSVGElement
}

const SVG_NS = 'http://www.w3.org/2000/svg'

function svgNode<K extends keyof SVGElementTagNameMap>(
  tag: K, cls: string, parent?: Element,
): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG_NS, tag)
  if (cls) n.setAttribute('class', cls)
  if (parent) parent.appendChild(n)
  return n
}

function attr(n: Element, map: Record<string, string | number>): void {
  for (const k in map) n.setAttribute(k, String(map[k]))
}

function itemIcon(id: ItemId): SVGSVGElement {
  return svgFrom(
    '<svg class="sg-icon" viewBox="0 0 48 48" aria-hidden="true" focusable="false" ' +
      'style="color:' + hex(ITEMS[id].color) + '">' + ICON_BODY[id] + '</svg>',
  )
}

function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value
}

function fmtTime(t: number): string {
  if (!isFinite(t) || t <= 0) return '00:00.00'
  const m = Math.floor(t / 60)
  const s = Math.floor(t - m * 60)
  const cs = Math.floor((t * 100) % 100)
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s + '.' + (cs < 10 ? '0' : '') + cs
}

/**
 * A lap split, as a racer reads one: `1:02.48`. No leading zero on the minute,
 * because a design-target lap is 55-75s and `01:02.48` spends a character
 * saying "not ten minutes yet".
 */
function fmtLap(t: number): string {
  if (!isFinite(t) || t <= 0) return '--:--.--'
  const m = Math.floor(t / 60)
  const s = Math.floor(t - m * 60)
  const cs = Math.floor((t * 100) % 100)
  return m + ':' + (s < 10 ? '0' : '') + s + '.' + (cs < 10 ? '0' : '') + cs
}

/**
 * The lap IN PROGRESS, to a tenth. Deliberately coarser than the finished
 * splits above it: a centisecond digit ticking a hundred times a second in the
 * corner of the eye is movement, and this widget sits in the periphery while
 * the player is looking at the road. A tenth still says "am I on it", and it
 * also tells the two kinds of row apart at a glance — a short number is
 * provisional, a long one is banked.
 */
function fmtLive(t: number): string {
  if (!isFinite(t) || t < 0) return '0:00.0'
  const m = Math.floor(t / 60)
  const s = Math.floor(t - m * 60)
  const d = Math.floor((t * 10) % 10)
  return m + ':' + (s < 10 ? '0' : '') + s + '.' + d
}

/** Gap to the fastest lap, always positive by construction: `+1.84`. */
function fmtGap(d: number): string {
  if (!isFinite(d) || d <= 0) return ''
  return '+' + (d > 99.99 ? '99.9' : d.toFixed(2))
}

// ---------------------------------------------------------------------------
// Sub-widget records, allocated once
// ---------------------------------------------------------------------------

interface SlotUi {
  root: HTMLElement
  box: HTMLElement
  glow: HTMLElement
  icons: SVGSVGElement[]
  empty: HTMLElement
  pips: HTMLElement[]
  name: HTMLElement
  shown: number
  pop: number
  rouletteAcc: number
  rouletteIdx: number
  wasRoulette: boolean
  lastItem: ItemId | null
}

interface WarnUi {
  root: HTMLElement
  icons: SVGSVGElement[]
  shown: number
  active: boolean
  lastRot: number
}

/** One line of the lap-split list: `2  1:02.48  +1.84`. */
interface SplitRowUi {
  root: HTMLElement
  n: HTMLElement
  t: HTMLElement
  d: HTMLElement
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

class HudImpl implements Hud {
  readonly root: HTMLElement

  // top left
  private readonly posWrap: HTMLElement
  private readonly posEl: HTMLElement
  private readonly posNum: HTMLElement
  private readonly posOrd: HTMLElement
  private readonly lapCur: HTMLElement
  private readonly lapTot: HTMLElement

  // lap splits, directly under the position block
  private readonly splitRows: SplitRowUi[] = []
  private readonly splitLive: SplitRowUi
  /** Which completed lap each visible row is showing. Preallocated. */
  private readonly splitIdx = new Int32Array(SPLIT_ROWS)

  // top right
  private readonly mapCanvas: HTMLCanvasElement
  private readonly mapCtx: CanvasRenderingContext2D | null
  private readonly mapOff: HTMLCanvasElement
  private readonly clockEl: HTMLElement
  private readonly fpsEl: HTMLElement

  // items
  private readonly slots: SlotUi[] = []

  // gauge
  private readonly gauge: HTMLElement
  private readonly ringFill: SVGCircleElement
  private readonly ringSnap: SVGCircleElement
  private readonly spdFill: SVGCircleElement
  private readonly spdText: HTMLElement
  private readonly tierText: HTMLElement
  /** Compact-layout restatement of the drift ring. Same numbers, flat. */
  private readonly barFill: HTMLElement
  private readonly barTier: HTMLElement

  // charge
  private readonly chargeWrap: HTMLElement
  private readonly chargeNum: HTMLElement
  private readonly chargeSegs: HTMLElement[] = []

  // lift
  private readonly liftWrap: HTMLElement

  // crosswind
  private readonly windWrap: HTMLElement
  /** [0] = the left-pointing ladder, [1] = the right-pointing one. */
  private readonly windCh: HTMLElement[][] = []

  // warnings
  private readonly warns: WarnUi[] = []

  // finish ceremony
  private readonly finWrap: HTMLElement
  private readonly finPlace: HTMLElement
  private readonly finOrd: HTMLElement
  private readonly finTime: HTMLElement
  private readonly finField: HTMLElement
  readonly skipButton: HTMLButtonElement
  private finOn = false
  private driftReleaseTaken = false
  private lastFinPos = -1
  private lastFinTime = -1
  private lastFinField = -2
  private lastCanSkip: boolean | null = null

  // centre
  private readonly countEl: HTMLElement
  private readonly bannerEl: HTMLElement
  private readonly boostEl: HTMLElement
  private readonly splitEl: HTMLElement
  private readonly spinEl: HTMLElement
  private readonly spinTxt: HTMLElement

  // --- cached per-frame state ---------------------------------------------
  private lastNow = 0
  private lastPos = -1
  private lastLap = -1
  private lastSplitCount = -1
  private lastSplitBest = -1
  private lastLiveTenth = -1
  private lastLiveOn = false
  private lastTier = -2
  private lastCharges = -1
  private lastRingColor = ''
  private lastRingOff = -1
  private lastSpdOff = -1
  private lastLift = -1
  private lastSpdTxt = -1
  private lastClock = -1
  private lastFps = -1
  private fpsAcc = 0
  private lastChassis = ''
  private topSpeed = 60
  private isFlight = false
  private liftCap = 1
  private windOn = false
  /** 0 until the first update, so the first frame always writes the class. */
  private windDir = 0
  private lastWindBars = -1

  // viewport size, refreshed on resize only — never read from layout in update()
  private viewW = 1280
  private viewH = 720

  // transient timers
  private flashT = 0
  private snapT = 0
  private countT = 0
  private bannerT = 0
  private boostT = 0
  private splitT = 0
  private shakeT = 0
  private spinPhase = 0
  private blinkPhase = 0

  // minimap bake
  private mapTrack: Track | null = null
  private mapDirty = true
  private mapW = 0
  private mapH = 0
  private mapDpr = 1
  private mScale = 1
  private mOx = 0
  private mOy = 0
  private mAng = 0
  private mCos = 1
  private mSin = 0
  private px = 0
  private py = 0

  private reduced = false
  private readonly ro: ResizeObserver | null
  private readonly mq: MediaQueryList | null
  private readonly onMq: () => void
  private readonly onResize: () => void

  constructor(container: HTMLElement) {
    // The HUD is absolutely positioned; make sure it has something to hang off.
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative'
    }

    const root = div('sg-hud')
    this.root = root
    div('sg-hud__grain', root)

    // --- TOP LEFT: position + lap ----------------------------------------
    this.posWrap = div('sg-hud__pos', root)
    this.posEl = div('sg-pos', this.posWrap)
    this.posNum = span('sg-pos__num', this.posEl, '-')
    this.posOrd = span('sg-pos__ord', this.posEl, '')
    const lap = div('sg-lap', this.posWrap)
    span('sg-lap__label', lap, 'LAP')
    this.lapCur = span('sg-lap__cur', lap, '1')
    span('sg-lap__sep', lap, '/')
    this.lapTot = span('sg-lap__tot', lap, '3')

    // --- LAP SPLITS, directly under the lap chip -------------------------
    // One row per completed lap, oldest at the top, so the column grows
    // downward in the same order the race happened. The fastest lap is green
    // with a green left rule — the same chip language as the LAP x/3 above it,
    // and the same hue the centre-screen split toast already uses to mean
    // "best". Every other row carries its gap to that fastest lap, which is
    // the one comparison a driver can make in a glance and which is exact
    // because both numbers are finished laps.
    //
    // Rows are built ONCE, here. update() only ever sets text and `hidden`.
    const splits = div('sg-splits', this.posWrap)
    for (let i = 0; i < SPLIT_ROWS; i++) this.splitRows.push(this.buildSplitRow(splits, ''))
    // The lap in progress. Dimmer, coarser (tenths) and never carrying a gap:
    // an in-flight lap clock compared against a finished best lap is not a
    // delta, it is two unrelated numbers subtracted, and this HUD has no
    // sector data to make it mean anything. It exists so the widget is on
    // screen from the green light instead of appearing a minute into the race.
    this.splitLive = this.buildSplitRow(splits, ' sg-split--live')

    // --- TOP RIGHT: minimap ----------------------------------------------
    const mapWrap = div('sg-hud__map', root)
    const mapFrame = div('sg-map__frame', mapWrap)
    this.mapCanvas = document.createElement('canvas')
    this.mapCanvas.className = 'sg-map__canvas'
    mapFrame.appendChild(this.mapCanvas)
    this.mapCtx = this.mapCanvas.getContext('2d')
    this.mapOff = document.createElement('canvas')
    const meta = div('sg-map__meta', mapWrap)
    this.clockEl = span('sg-map__clock', meta, '00:00.00')
    this.fpsEl = span('sg-map__fps', meta, '60')

    // --- BOTTOM LEFT: item slots -----------------------------------------
    const items = div('sg-hud__items', root)
    this.slots.push(this.buildSlot(items, false))
    this.slots.push(this.buildSlot(items, true))
    this.slots[1].root.hidden = true

    // --- BOTTOM INSTRUMENTS ------------------------------------------------
    // The gauge and the charge pill share one wrapper so the compact layout can
    // lay them out as a single horizontal strip. On desktop the wrapper is
    // `display: contents`, which means it contributes no box at all and both
    // children stay exactly what they were: direct grid items of the HUD, in
    // areas br and bc. Nothing about the desktop layout moves.
    const band = div('sg-hud__band', root)

    // --- BOTTOM RIGHT: speed arc + drift ring -----------------------------
    this.gauge = div('sg-hud__gauge', band)
    const gsvg = svgNode('svg', 'sg-gauge__svg', this.gauge)
    attr(gsvg, { viewBox: '0 0 120 120', 'aria-hidden': 'true' })
    this.ring(gsvg, 'sg-gauge__ringTrack', RING_R, -90, 0)
    this.ring(gsvg, 'sg-gauge__ringBase', RING_R, -90, 0)
    this.ringSnap = this.ring(gsvg, 'sg-gauge__ringSnap', RING_R, -90, RING_C)
    this.ringFill = this.ring(gsvg, 'sg-gauge__ringFill', RING_R, -90, RING_C)
    // Tier boundary ticks, generated from the tuning table so the ring always
    // tells the truth about where the boundaries sit.
    const times = TUNING.drift.tierTimes
    for (let i = 0; i < times.length; i++) {
      const a = (-90 + (times[i] / DRIFT_MAX) * 360) * (Math.PI / 180)
      const c = Math.cos(a), s = Math.sin(a)
      attr(svgNode('line', 'sg-gauge__tick', gsvg), {
        x1: (60 + c * 45).toFixed(2), y1: (60 + s * 45).toFixed(2),
        x2: (60 + c * 59).toFixed(2), y2: (60 + s * 59).toFixed(2),
      })
    }
    this.ring(gsvg, 'sg-gauge__spdTrack', SPD_R, 150, 0, SPD_ARC)
    this.spdFill = this.ring(gsvg, 'sg-gauge__spdFill', SPD_R, 150, SPD_ARC, SPD_ARC)
    const readout = div('sg-gauge__readout', this.gauge)
    this.spdText = div('sg-gauge__spd', readout)
    this.spdText.textContent = '0'
    div('sg-gauge__unit', readout).textContent = 'KM/H'
    this.tierText = div('sg-gauge__tier', readout)

    // The drift ladder, said again horizontally, for compact / touch layouts.
    // A 214px ring is a quarter of a landscape phone's height; this is the same
    // fraction, the same tier boundaries and the same tier colour in about 20px
    // of it. Built here, displayed by CSS: exactly one of the two is ever on
    // screen, and update() feeds both without knowing which.
    const bar = div('sg-gauge__bar', this.gauge)
    this.barTier = div('sg-gauge__barTier', bar)
    const barTrack = div('sg-gauge__barTrack', bar)
    this.barFill = div('sg-gauge__barFill', barTrack)
    // Same table the ring's ticks come from. The last entry IS the end of the
    // bar, so it needs no mark of its own.
    for (let i = 0; i < times.length - 1; i++) {
      div('sg-gauge__barTick', barTrack).style.left =
        ((times[i] / DRIFT_MAX) * 100).toFixed(2) + '%'
    }

    // --- BOTTOM CENTRE: charge pickups ------------------------------------
    this.chargeWrap = div('sg-hud__charge', band)
    const bolt = svgFrom(
      '<svg class="sg-charge__icon" viewBox="0 0 48 48" aria-hidden="true">' + BOLT_BODY + '</svg>',
    )
    this.chargeWrap.appendChild(bolt)
    this.chargeNum = span('sg-charge__num', this.chargeWrap, '0')
    const cbar = div('sg-charge__bar', this.chargeWrap)
    for (let i = 0; i < TUNING.boost.chargeMax; i++) {
      this.chargeSegs.push(div('sg-charge__seg', cbar))
    }

    // --- RIGHT EDGE: lift (flight only) -----------------------------------
    this.liftWrap = div('sg-hud__lift', root)
    div('sg-lift__label', this.liftWrap).textContent = 'LIFT'
    const liftTrack = div('sg-lift__track', this.liftWrap)
    div('sg-lift__fill', liftTrack)
    this.liftWrap.hidden = true

    // --- LOWER CENTRE: crosswind ------------------------------------------
    // Grid area `mc`, bottom-aligned: it sits directly above whatever is in
    // the bottom-centre cell — the charge pill on desktop, the whole
    // instrument strip on a phone — on BOTH layouts, without being a child of
    // either. The compact band is 40 px tall on a 412 px-wide frame and every
    // element in it has already been fought for; putting a fifth thing inside
    // it is how that strip reaches the thumb clusters.
    //
    // Both ladders are built and exactly one is ever visible. The hidden side
    // keeps its box (visibility, not display) so the pill does not change
    // width when the wind changes sign, which on Aetherion's rotunda it does.
    this.windWrap = div('sg-hud__wind', root)
    const windL = div('sg-wind__arrows sg-wind__arrows--l', this.windWrap)
    div('sg-wind__label', this.windWrap).textContent = 'WIND'
    const windR = div('sg-wind__arrows sg-wind__arrows--r', this.windWrap)
    const windHosts = [windL, windR]
    for (let s = 0; s < 2; s++) {
      const row: HTMLElement[] = []
      for (let i = 0; i < WIND_BARS; i++) {
        const c = div('sg-wind__ch', windHosts[s])
        c.appendChild(svgFrom(s === 0 ? CHEV_L : CHEV_R))
        row.push(c)
      }
      this.windCh.push(row)
    }
    this.windWrap.hidden = true

    // --- SCREEN EDGE: incoming warnings -----------------------------------
    const warnHost = div('sg-hud__warns', root)
    for (let i = 0; i < WARN_SLOTS; i++) this.warns.push(this.buildWarn(warnHost))

    // --- CENTRE: transients ------------------------------------------------
    const centre = div('sg-hud__centre', root)
    this.countEl = div('sg-ctr sg-ctr__count', centre)
    this.countEl.hidden = true
    this.bannerEl = div('sg-ctr sg-ctr__banner', centre)
    this.bannerEl.textContent = 'FINAL LAP'
    this.bannerEl.hidden = true
    this.boostEl = div('sg-ctr sg-ctr__boost', centre)
    this.boostEl.hidden = true
    this.splitEl = div('sg-ctr sg-ctr__split', centre)
    this.splitEl.hidden = true
    this.spinEl = div('sg-ctr sg-ctr__spin', centre)
    this.spinTxt = div('sg-ctr__spinTxt', this.spinEl)
    this.spinTxt.textContent = 'SPUN OUT'
    this.spinEl.hidden = true

    // --- FINISH CEREMONY ---------------------------------------------------
    // Two pieces, deliberately at opposite ends of the frame so the middle --
    // where the car is, and the whole point of the shot -- stays empty.
    // The card sits high; the skip prompt sits low, in the thumb band on a
    // phone and under the eye on a desktop.
    this.finWrap = div('sg-fin', root)
    const card = div('sg-fin__card', this.finWrap)
    div('sg-fin__label', card).textContent = 'FINISHED'
    const place = div('sg-fin__place', card)
    this.finPlace = span('sg-fin__num', place, '-')
    this.finOrd = span('sg-fin__ord', place, '')
    this.finTime = div('sg-fin__time', card)
    this.finTime.textContent = '--:--.--'
    this.finField = div('sg-fin__field', this.finWrap)
    this.finField.textContent = ''
    const skip = document.createElement('button')
    skip.type = 'button'
    skip.className = 'sg-fin__skip'
    skip.textContent = 'Results'
    // The only pointer-enabled thing in the HUD. Everything else in here is
    // pointer-events:none so it can never swallow a touch meant for the road;
    // this one has to be pressable, and only while the ceremony is up.
    skip.addEventListener('pointerdown', (e) => { e.stopPropagation() })
    this.skipButton = skip
    this.finWrap.appendChild(skip)
    this.finWrap.hidden = true

    container.appendChild(root)

    // Redraw the baked minimap whenever the canvas box changes.
    this.ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => { this.mapDirty = true })
      : null
    if (this.ro) this.ro.observe(this.mapCanvas)

    // Viewport size is cached here so update() never touches the layout path.
    this.viewW = window.innerWidth || 1280
    this.viewH = window.innerHeight || 720
    this.onResize = () => {
      this.viewW = window.innerWidth || 1280
      this.viewH = window.innerHeight || 720
      this.mapDirty = true
    }
    window.addEventListener('resize', this.onResize, { passive: true })
    window.addEventListener('orientationchange', this.onResize, { passive: true })

    this.mq = typeof matchMedia === 'function'
      ? matchMedia('(prefers-reduced-motion: reduce)')
      : null
    this.reduced = this.mq ? this.mq.matches : false
    this.onMq = () => { this.reduced = this.mq ? this.mq.matches : false }
    if (this.mq && this.mq.addEventListener) this.mq.addEventListener('change', this.onMq)

    this.lastNow = performance.now()
  }

  // -------------------------------------------------------------------------
  // Construction helpers
  // -------------------------------------------------------------------------

  /**
   * One ring of the gauge. `dash` is the visible arc length; the pattern's
   * second value is huge so the dash can never wrap around the circle.
   */
  private ring(
    host: SVGElement, cls: string, r: number, rot: number, offset: number, dash?: number,
  ): SVGCircleElement {
    const c = svgNode('circle', cls, host)
    attr(c, { cx: 60, cy: 60, r, transform: 'rotate(' + rot + ' 60 60)' })
    if (dash !== undefined || offset > 0) {
      const len = dash !== undefined ? dash : 2 * Math.PI * r
      attr(c, { 'stroke-dasharray': len.toFixed(2) + ' 10000' })
    }
    if (offset > 0) attr(c, { 'stroke-dashoffset': offset.toFixed(2) })
    return c
  }

  private buildSlot(parent: HTMLElement, alt: boolean): SlotUi {
    const root = div('sg-slot' + (alt ? ' sg-slot--alt' : ''), parent)
    const box = div('sg-slot__box', root)
    const glow = div('sg-slot__glow', box)
    const empty = div('sg-slot__empty', box)
    empty.textContent = '?'
    const iconHost = div('sg-slot__icons', box)
    const icons: SVGSVGElement[] = []
    for (let i = 0; i < ITEM_ORDER.length; i++) {
      const svg = itemIcon(ITEM_ORDER[i])
      svg.style.display = 'none'
      iconHost.appendChild(svg)
      icons.push(svg)
    }
    const pipRow = div('sg-slot__pips', root)
    const pips: HTMLElement[] = []
    for (let i = 0; i < 3; i++) pips.push(div('sg-pip', pipRow))
    pipRow.hidden = true
    const name = div('sg-slot__name', root)
    name.textContent = ''
    return {
      root, box, glow, icons, empty, pips, name,
      shown: -1, pop: 0, rouletteAcc: 0, rouletteIdx: 0,
      wasRoulette: false, lastItem: null,
    }
  }

  private buildSplitRow(parent: HTMLElement, extra: string): SplitRowUi {
    const root = div('sg-split' + extra, parent)
    const r: SplitRowUi = {
      root,
      n: span('sg-split__n', root, ''),
      t: span('sg-split__t', root, ''),
      d: span('sg-split__d', root, ''),
    }
    root.hidden = true
    return r
  }

  private buildWarn(parent: HTMLElement): WarnUi {
    const root = div('sg-warn', parent)
    root.appendChild(
      svgFrom(
        '<svg class="sg-warn__arc" viewBox="0 0 100 44" aria-hidden="true">' +
          '<path d="M8 38 Q50 2 92 38"/></svg>',
      ),
    )
    const host = div('sg-warn__icons', root)
    const icons: SVGSVGElement[] = []
    for (let i = 0; i < WARN_ITEMS.length; i++) {
      const svg = itemIcon(WARN_ITEMS[i])
      svg.style.display = 'none'
      host.appendChild(svg)
      icons.push(svg)
    }
    root.hidden = true
    return { root, icons, shown: -1, active: false, lastRot: 9999 }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  showCountdown(n: number | string): void {
    const label = typeof n === 'number' ? (n > 0 ? String(n) : 'GO!') : n
    setText(this.countEl, label)
    this.countEl.classList.toggle('is-go', label === 'GO!' || label === 'GO')
    this.countEl.hidden = false
    this.countT = label === 'GO!' || label === 'GO' ? 1.0 : 0.92
  }

  setFinish(info: FinishInfo | null): void {
    const on = info !== null
    if (on !== this.finOn) {
      this.finOn = on
      this.finWrap.hidden = !on
      this.root.classList.toggle('is-ceremony', on)
      if (on) {
        // Anything mid-animation belongs to the race that just ended. The
        // countdown is on this list because update() stops running the centre
        // block during the ceremony, so a GO! that has not finished fading --
        // which on a software renderer takes ten wall seconds, since the HUD
        // clamps its own dt to 0.1 -- would freeze on screen for the whole shot.
        this.countT = 0; this.countEl.hidden = true
        this.boostT = 0; this.boostEl.hidden = true
        this.splitT = 0; this.splitEl.hidden = true
        this.bannerT = 0; this.bannerEl.hidden = true
        this.spinEl.hidden = true
        for (let i = 0; i < this.warns.length; i++) {
          this.warns[i].active = false
          this.warns[i].root.hidden = true
        }
      } else {
        this.lastFinPos = -1
        this.lastFinTime = -1
        this.lastFinField = -2
        this.lastCanSkip = null
      }
    }
    if (!info) return

    const p = info.position < 1 ? 1 : info.position > 12 ? 12 : info.position
    if (p !== this.lastFinPos) {
      this.lastFinPos = p
      setText(this.finPlace, ORD_NUM[p])
      setText(this.finOrd, ORD_SUF[p])
      // Gold for a win, silver-white for a podium, plain ink otherwise. Colour
      // is the second channel; the number is the first.
      this.finWrap.dataset.rank = p === 1 ? 'win' : p <= 3 ? 'podium' : 'ran'
    }
    const cs = Math.floor(info.time * 100)
    if (cs !== this.lastFinTime) {
      this.lastFinTime = cs
      setText(this.finTime, fmtTime(info.time))
    }
    if (info.stillRacing !== this.lastFinField) {
      this.lastFinField = info.stillRacing
      setText(this.finField, info.stillRacing > 0
        ? (info.stillRacing === 1 ? '1 car still out' : info.stillRacing + ' cars still out')
        : 'Field is in')
    }
    if (info.canSkip !== this.lastCanSkip) {
      this.lastCanSkip = info.canSkip
      this.skipButton.disabled = !info.canSkip
    }
  }

  /**
   * Suppress the centre-screen boost flash for THIS frame's drift release,
   * because the callout layer has already announced it — up in the sky band,
   * off the racing line, and by name. Set once per frame by the host, before
   * update(), and never sticky: everything else that raises a boost still
   * flashes, and so does every release when the callouts are off.
   */
  setDriftReleaseTaken(taken: boolean): void {
    this.driftReleaseTaken = taken
  }

  update(state: RaceState, localId: number, track: Track, fps: number): void {
    const now = performance.now()
    let dt = (now - this.lastNow) * 0.001
    this.lastNow = now
    if (!(dt > 0)) dt = 0
    if (dt > 0.1) dt = 0.1

    const r = this.local(state, localId)
    if (!r) return

    if (this.lastChassis !== r.chassisId) {
      this.lastChassis = r.chassisId
      this.topSpeed = getDerived(r.chassisId, r.pilotId).topSpeed
      const loco = getLocomotion(r.chassisId)
      this.isFlight = loco.liftCapacity > 0
      this.liftCap = loco.liftCapacity > 0 ? loco.liftCapacity : 1
      this.liftWrap.hidden = !this.isFlight
    }

    // During the ceremony the only live widget is the minimap: it is the one
    // thing that still describes something happening (the field coming in).
    // Everything else describes a car the player is not driving, so it is
    // frozen where it stood rather than animated over an AI's inputs.
    if (this.finOn) {
      this.updateMap(state, track, r)
      return
    }

    this.updateEvents(r)
    this.updatePosition(r, state)
    this.updateSplits(r, state)
    this.updateItems(r, dt)
    this.updateGauge(r, dt)
    this.updateCharge(r, dt)
    this.updateLift(r, dt)
    this.updateWind(r)
    this.updateWarnings(r, state)
    this.updateCentre(r, state, dt)
    this.updateMap(state, track, r)
    this.updateClock(state, fps, dt)
  }

  dispose(): void {
    if (this.ro) this.ro.disconnect()
    if (this.mq && this.mq.removeEventListener) this.mq.removeEventListener('change', this.onMq)
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('orientationchange', this.onResize)
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root)
  }

  // -------------------------------------------------------------------------
  // Frame work
  // -------------------------------------------------------------------------

  private local(state: RaceState, localId: number): RacerState | null {
    const racers = state.racers
    for (let i = 0; i < racers.length; i++) if (racers[i].id === localId) return racers[i]
    return racers.length > 0 ? racers[0] : null
  }

  /** Events are cleared by the sim every step, so read them opportunistically. */
  private updateEvents(r: RacerState): void {
    const ev = r.events
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i]
      if (e.t === 'boost') {
        // A drift release the callout layer has taken is announced once, by
        // it. This flash sits at ~57% of the frame height, which is straight
        // across the car and the road at chase-camera framing, and printing
        // "FLARE BOOST" there while "CLEAN FLARE" is already up in the sky is
        // both redundant and the exact readability failure the callouts were
        // written to avoid.
        if (this.driftReleaseTaken && r.boostSource === 'drift') continue
        const tier = e.tier < 0 ? 0 : e.tier > 3 ? 3 : e.tier
        setText(this.boostEl, TIER_NAME[tier] + ' BOOST')
        this.boostEl.style.setProperty('--bc', TIER_COLOR[tier])
        this.boostEl.hidden = false
        this.boostT = 0.85
      } else if (e.t === 'lap') {
        const best = r.bestLap > 0 && e.time <= r.bestLap + 1e-6
        // Same format as the row this lap is about to occupy in the top-left
        // list. The toast and the list are the same fact said twice, once
        // loudly and once for keeps; they should not disagree about how many
        // digits a lap has.
        setText(this.splitEl, 'LAP ' + e.lap + '   ' + fmtLap(e.time))
        this.splitEl.classList.toggle('is-best', best)
        this.splitEl.hidden = false
        this.splitT = 2.6
      }
    }
  }

  private updatePosition(r: RacerState, state: RaceState): void {
    const p = r.position < 0 ? 0 : r.position > 12 ? 12 : r.position
    if (p !== this.lastPos) {
      // No flash for grid shuffling before the lights go out.
      if (this.lastPos > 0 && state.phase === 'racing') {
        this.flashT = 0.55
        this.posEl.style.setProperty('--sg-flash', p < this.lastPos ? '#7dffb4' : '#ff9db0')
      }
      this.lastPos = p
      setText(this.posNum, ORD_NUM[p])
      setText(this.posOrd, ORD_SUF[p])
    }

    const lapCur = r.lap + 1 > state.totalLaps ? state.totalLaps : r.lap + 1
    if (lapCur !== this.lastLap) {
      // Entering the last lap fires the banner (unless we started there).
      if (this.lastLap > 0 && lapCur === state.totalLaps && state.totalLaps > 1) {
        this.bannerT = 2.3
      }
      this.lastLap = lapCur
      setText(this.lapCur, String(lapCur))
      setText(this.lapTot, String(state.totalLaps))
      this.posWrap.classList.toggle('is-final', lapCur >= state.totalLaps && state.totalLaps > 1)
    }
  }

  /**
   * The lap-split list.
   *
   * Two clocks with two jobs. The finished rows are a RECORD: written once when
   * a lap closes, precise to a centisecond, and never touched again until the
   * fastest lap changes under them (which re-labels every gap, so the whole
   * block is rewritten on that event and on no other). The live row is an
   * INSTRUMENT: it reruns every frame the tenths digit moves.
   *
   * Everything here is read straight off `RacerState`, so a restart — where
   * `lapTimes` goes back to empty — trips the change detector on its own and
   * empties the list. There is no reset path to forget to call.
   */
  private updateSplits(r: RacerState, state: RaceState): void {
    const times = r.lapTimes
    const n = times.length
    const best = r.bestLap

    if (n !== this.lastSplitCount || best !== this.lastSplitBest) {
      this.lastSplitCount = n
      this.lastSplitBest = best

      // Choose the window. Everything fits until the race is longer than the
      // widget; past that the fastest lap is pinned to row 0 and the rest of
      // the window is the most recent laps, so the two things a driver wants —
      // the target and where they are right now — are both always on screen.
      let count = 0
      if (n <= SPLIT_ROWS) {
        for (let i = 0; i < n; i++) this.splitIdx[count++] = i
      } else {
        let bi = 0
        for (let i = 1; i < n; i++) if (times[i] < times[bi]) bi = i
        const start = bi >= n - SPLIT_ROWS ? n - SPLIT_ROWS : n - (SPLIT_ROWS - 1)
        if (bi < start) this.splitIdx[count++] = bi
        for (let i = start; i < n; i++) this.splitIdx[count++] = i
      }

      for (let s = 0; s < SPLIT_ROWS; s++) {
        const row = this.splitRows[s]
        if (s >= count) {
          if (!row.root.hidden) row.root.hidden = true
          continue
        }
        const i = this.splitIdx[s]
        const t = times[i]
        const isBest = best > 0 && t <= best + 1e-6
        setText(row.n, String(i + 1))
        setText(row.t, fmtLap(t))
        // The fastest lap shows no gap: it IS the reference, and the green is
        // already saying so. One less number on screen for the same meaning.
        setText(row.d, isBest ? '' : fmtGap(t - best))
        row.root.classList.toggle('is-best', isBest)
        // A pinned row is not adjacent to the one below it. Say so, rather
        // than letting laps 1 and 7 sit together looking consecutive.
        row.root.classList.toggle('is-skip', s + 1 < count && this.splitIdx[s + 1] > i + 1)
        if (row.root.hidden) row.root.hidden = false
      }
    }

    // --- the lap in progress ------------------------------------------------
    // Nothing to time once this racer is done: the finish card owns the total
    // and the results table owns the rest.
    const live = !r.finished && state.phase !== 'finished' && r.lap < state.totalLaps
    if (live !== this.lastLiveOn) {
      this.lastLiveOn = live
      this.splitLive.root.hidden = !live
      // Forget the last race's tenth, so a rematch cannot open on a stale
      // number for the 100ms it takes the new clock to cross a boundary.
      this.lastLiveTenth = -1
    }
    if (!live) return
    setText(this.splitLive.n, String(n + 1))
    // Same arithmetic the sim uses to close a lap (race.ts resolveLaps), so
    // the running number and the split it eventually becomes are the same
    // clock rather than two that nearly agree.
    let prev = 0
    for (let i = 0; i < n; i++) prev += times[i]
    const cur = state.time - prev
    const tenth = Math.floor(cur * 10)
    if (tenth !== this.lastLiveTenth) {
      this.lastLiveTenth = tenth
      setText(this.splitLive.t, fmtLive(cur))
    }
  }

  private updateItems(r: RacerState, dt: number): void {
    this.slotFrame(this.slots[0], r.item, r.rouletteTime, r.itemCharges, dt)

    const wantAlt = r.position >= TUNING.items.secondSlotFromPosition || r.itemSlot2 !== null
    if (this.slots[1].root.hidden === wantAlt) this.slots[1].root.hidden = !wantAlt
    // A queued slot-2 item is always at full stock, so Nitro x3 shows three pips.
    if (wantAlt) this.slotFrame(this.slots[1], r.itemSlot2, 0, 3, dt)
  }

  private slotFrame(
    s: SlotUi, item: ItemId | null, roulette: number, charges: number, dt: number,
  ): void {
    if (roulette > 0) {
      // Cycle fast through every possible item, then settle.
      s.rouletteAcc += dt
      const step = 0.055
      while (s.rouletteAcc >= step) {
        s.rouletteAcc -= step
        s.rouletteIdx = (s.rouletteIdx + 1) % ITEM_ORDER.length
      }
      this.showSlotIcon(s, s.rouletteIdx)
      s.wasRoulette = true
      if (s.lastItem !== null) { s.lastItem = null; setText(s.name, '') }
      const pr = s.pips[0].parentElement as HTMLElement
      if (!pr.hidden) pr.hidden = true
      return
    }

    if (s.wasRoulette) {
      // Settle pop on the frame the roulette lands.
      s.wasRoulette = false
      s.pop = 1
    }

    if (item !== s.lastItem) {
      s.lastItem = item
      if (item) {
        this.showSlotIcon(s, ITEM_INDEX[item])
        s.glow.style.setProperty('--ic', hex(ITEMS[item].color))
        setText(s.name, ITEMS[item].name)
        s.empty.hidden = true
      } else {
        this.showSlotIcon(s, -1)
        s.glow.style.removeProperty('--ic')
        setText(s.name, '')
        s.empty.hidden = false
      }
    }

    // Nitro x3 shows its remaining charges as pips.
    const pipRow = s.pips[0].parentElement as HTMLElement
    const wantPips = item === 'nitroTriple'
    if (pipRow.hidden === wantPips) pipRow.hidden = !wantPips
    if (wantPips) {
      for (let i = 0; i < s.pips.length; i++) {
        const on = i < charges
        if (s.pips[i].classList.contains('is-on') !== on) s.pips[i].classList.toggle('is-on', on)
      }
    }

    if (s.pop > 0) {
      s.pop = s.pop - dt / 0.28
      if (s.pop < 0) s.pop = 0
      s.box.style.setProperty('--pop', this.reduced ? '0' : s.pop.toFixed(3))
      s.glow.style.setProperty('--pop', s.pop.toFixed(3))
    }
  }

  private showSlotIcon(s: SlotUi, idx: number): void {
    if (s.shown === idx) return
    if (s.shown >= 0) s.icons[s.shown].style.display = 'none'
    if (idx >= 0) {
      s.icons[idx].style.display = ''
      s.empty.hidden = true
    } else {
      s.empty.hidden = false
    }
    s.shown = idx
  }

  private updateGauge(r: RacerState, dt: number): void {
    // --- drift charge ring (the widget that teaches drift) ----------------
    let f = r.driftCharge / DRIFT_MAX
    if (f < 0) f = 0
    if (f > 1) f = 1
    const off = Math.round(RING_C * (1 - f) * 10) / 10
    if (off !== this.lastRingOff) {
      this.lastRingOff = off
      this.ringFill.style.strokeDashoffset = String(off)
      this.ringSnap.style.strokeDashoffset = String(off)
      // Same change detector, so the flat bar costs one extra style write on
      // the frames the ring was already being written to and nothing on the
      // frames it was not. scaleX rather than width: no layout, no reflow.
      this.barFill.style.transform = 'scaleX(' + f.toFixed(4) + ')'
    }

    const tier = r.driftTier
    if (tier !== this.lastTier) {
      if (tier > this.lastTier && tier >= 0) this.snapT = 1
      this.lastTier = tier
      const color = tier >= 0 ? TIER_COLOR[tier > 3 ? 3 : tier] : 'rgba(122,190,255,0.55)'
      if (color !== this.lastRingColor) {
        this.lastRingColor = color
        this.gauge.style.setProperty('--ring', color)
      }
      const name = tier >= 0 ? TIER_NAME[tier > 3 ? 3 : tier] : ''
      setText(this.tierText, name)
      setText(this.barTier, name)
    }

    if (this.snapT > 0) {
      this.snapT -= dt / 0.32
      if (this.snapT < 0) this.snapT = 0
      this.gauge.style.setProperty('--snap', this.reduced ? '0' : this.snapT.toFixed(3))
    }

    // --- speed arc ---------------------------------------------------------
    const vx = r.vel.x, vz = r.vel.z
    const speed = Math.sqrt(vx * vx + vz * vz)
    const maxShown = this.topSpeed * (1 + TUNING.drift.tierBoost[3])
    let sf = speed / maxShown
    if (sf < 0) sf = 0
    if (sf > 1) sf = 1
    const soff = Math.round(SPD_ARC * (1 - sf) * 10) / 10
    if (soff !== this.lastSpdOff) {
      this.lastSpdOff = soff
      this.spdFill.style.strokeDashoffset = String(soff)
    }

    const kmh = Math.round(speed * 3.6)
    if (kmh !== this.lastSpdTxt) {
      this.lastSpdTxt = kmh
      setText(this.spdText, String(kmh))
    }

    const boosting = r.boostTime > 0
    if (this.gauge.classList.contains('is-boost') !== boosting) {
      this.gauge.classList.toggle('is-boost', boosting)
    }
  }

  private updateCharge(r: RacerState, dt: number): void {
    if (r.charges !== this.lastCharges) {
      const dropped = r.charges < this.lastCharges && this.lastCharges >= 0
      this.lastCharges = r.charges
      setText(this.chargeNum, String(r.charges))
      for (let i = 0; i < this.chargeSegs.length; i++) {
        const on = i < r.charges
        if (this.chargeSegs[i].classList.contains('is-on') !== on) {
          this.chargeSegs[i].classList.toggle('is-on', on)
        }
      }
      if (dropped) {
        this.shakeT = 1
        this.chargeWrap.classList.add('is-drop')
      }
    }

    if (this.shakeT > 0) {
      this.shakeT -= dt / 0.45
      if (this.shakeT < 0) this.shakeT = 0
      if (this.reduced) {
        this.chargeWrap.style.setProperty('--shake', '0')
      } else {
        const amp = this.shakeT * this.shakeT * 9
        this.chargeWrap.style.setProperty(
          '--shake', (Math.sin(this.shakeT * 46) * amp).toFixed(2),
        )
      }
      if (this.shakeT === 0) this.chargeWrap.classList.remove('is-drop')
    }
  }

  private updateLift(r: RacerState, dt: number): void {
    if (!this.isFlight) return
    let f = r.lift / this.liftCap
    if (f < 0) f = 0
    if (f > 1) f = 1
    const q = Math.round(f * 200) / 200
    if (q !== this.lastLift) {
      this.lastLift = q
      this.liftWrap.style.setProperty('--lift', String(q))
      const low = q < 0.25
      if (this.liftWrap.classList.contains('is-low') !== low) {
        this.liftWrap.classList.toggle('is-low', low)
        if (!low) this.liftWrap.style.removeProperty('--blink')
      }
    }
    if (this.lastLift < 0.25 && !this.reduced) {
      this.blinkPhase += dt * 9
      this.liftWrap.style.setProperty(
        '--blink', (0.45 + 0.55 * Math.abs(Math.sin(this.blinkPhase))).toFixed(2),
      )
    }
  }

  /**
   * The crosswind indicator. See WIND_BARS for what it reads and why.
   *
   * No dt, no timers, no easing: this is the one channel that must not lag.
   * `windPush` already carries the gust envelope, so the ladder breathes on
   * its own, and the hysteresis on WIND_SHOW / WIND_HIDE is the only smoothing
   * there is.
   */
  private updateWind(r: RacerState): void {
    const push = r.windPush
    const mag = push < 0 ? -push : push
    const on = this.windOn ? mag >= WIND_HIDE : mag >= WIND_SHOW
    if (on !== this.windOn) {
      this.windOn = on
      this.windWrap.hidden = !on
    }
    if (!on) return

    const dir = push >= 0 ? 1 : -1
    if (dir !== this.windDir) {
      this.windDir = dir
      this.windWrap.classList.toggle('is-right', dir > 0)
      this.windWrap.classList.toggle('is-left', dir < 0)
    }

    let bars = 0
    while (bars < WIND_STEPS.length && mag >= WIND_STEPS[bars]) bars++
    if (bars !== this.lastWindBars) {
      this.lastWindBars = bars
      for (let s = 0; s < 2; s++) {
        const row = this.windCh[s]
        for (let i = 0; i < row.length; i++) {
          const lit = i < bars
          if (row[i].classList.contains('is-on') !== lit) row[i].classList.toggle('is-on', lit)
        }
      }
    }
  }

  /**
   * Directional threat arcs on the screen rim. Bearing is relative to the
   * local racer's facing: straight up is dead ahead, straight down is behind.
   */
  private updateWarnings(r: RacerState, state: RaceState): void {
    const w = this.viewW
    const h = this.viewH
    const compact = w < 860 || h < 540
    const rx = w * (compact ? 0.33 : 0.39)
    const ry = h * (compact ? 0.33 : 0.39)

    const sinY = Math.sin(r.yaw), cosY = Math.cos(r.yaw)
    let n = 0

    const projectiles = state.projectiles
    for (let i = 0; i < projectiles.length && n < WARN_SLOTS; i++) {
      const p = projectiles[i]
      if (!p.alive || p.ownerId === r.id) continue
      const dx = p.pos.x - r.pos.x, dz = p.pos.z - r.pos.z
      const d2 = dx * dx + dz * dz
      if (d2 > 150 * 150) continue
      const kind = p.kind === 'rail' ? 0 : p.kind === 'seeker' ? 1 : 2
      this.placeWarn(this.warns[n], kind, dx, dz, sinY, cosY, rx, ry)
      n++
    }

    const fields = state.fields
    for (let i = 0; i < fields.length && n < WARN_SLOTS; i++) {
      const f = fields[i]
      if (!f.alive || f.ownerId === r.id) continue
      if (f.kind === 'mine' && f.armDelay > 0) continue
      const dx = f.pos.x - r.pos.x, dz = f.pos.z - r.pos.z
      const d2 = dx * dx + dz * dz
      if (d2 > 42 * 42) continue
      this.placeWarn(this.warns[n], f.kind === 'mine' ? 3 : 4, dx, dz, sinY, cosY, rx, ry)
      n++
    }

    for (let i = n; i < WARN_SLOTS; i++) {
      const wn = this.warns[i]
      if (wn.active) { wn.active = false; wn.root.hidden = true }
    }
  }

  private placeWarn(
    wn: WarnUi, kind: number, dx: number, dz: number,
    sinY: number, cosY: number, rx: number, ry: number,
  ): void {
    // Local frame: forward = (sin yaw, cos yaw); screen right = -x when facing +z.
    const fwd = dx * sinY + dz * cosY
    const side = dz * sinY - dx * cosY
    const a = Math.atan2(side, fwd) // 0 = ahead, +pi/2 = right, pi = behind
    const tx = Math.sin(a) * rx
    const ty = -Math.cos(a) * ry
    const deg = a * (180 / Math.PI)
    const q = Math.round(deg * 2) / 2
    if (q !== wn.lastRot) {
      wn.lastRot = q
      wn.root.style.transform =
        'translate3d(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px,0) rotate(' + q + 'deg)'
    }
    if (wn.shown !== kind) {
      if (wn.shown >= 0) wn.icons[wn.shown].style.display = 'none'
      wn.icons[kind].style.display = ''
      wn.shown = kind
      wn.root.style.setProperty('--wc', hex(ITEMS[WARN_ITEMS[kind]].color))
    }
    // Counter-rotate the glyph so it stays upright on the rim.
    const host = wn.icons[kind].parentElement as HTMLElement
    host.style.transform = 'rotate(' + (-q) + 'deg)'
    if (!wn.active) { wn.active = true; wn.root.hidden = false }
  }

  private updateCentre(r: RacerState, state: RaceState, dt: number): void {
    // countdown -----------------------------------------------------------
    if (state.phase === 'countdown') {
      const n = Math.ceil(state.countdown - TUNING.race.lightInterval * 0.6)
      const label = n > 0 ? String(n) : 'GO!'
      if (label !== this.countEl.textContent) this.showCountdown(n > 0 ? n : 'GO!')
    }
    if (this.countT > 0) {
      this.countT -= dt
      if (this.countT < 0) this.countT = 0
      const k = this.countT > 0.55 ? 1 : this.countT / 0.55
      this.countEl.style.setProperty('--k', k.toFixed(3))
      if (this.countT === 0) this.countEl.hidden = true
    }

    // final lap -----------------------------------------------------------
    if (this.bannerT > 0) {
      this.bannerT -= dt
      if (this.bannerT < 0) this.bannerT = 0
      this.bannerEl.hidden = false
      const k = this.bannerT > 1.9 ? (2.3 - this.bannerT) / 0.4 : Math.min(1, this.bannerT / 0.5)
      this.bannerEl.style.setProperty('--k', k.toFixed(3))
      this.bannerEl.style.setProperty('--s', this.reduced ? '1' : (0.9 + 0.1 * k).toFixed(3))
      if (this.bannerT === 0) this.bannerEl.hidden = true
    }

    // boost tier flash -----------------------------------------------------
    if (this.boostT > 0) {
      this.boostT -= dt
      if (this.boostT < 0) this.boostT = 0
      const k = Math.min(1, this.boostT / 0.4)
      this.boostEl.style.setProperty('--k', k.toFixed(3))
      this.boostEl.style.setProperty('--s', this.reduced ? '1' : (1 + (1 - k) * 0.28).toFixed(3))
      if (this.boostT === 0) this.boostEl.hidden = true
    }

    // lap split ------------------------------------------------------------
    if (this.splitT > 0) {
      this.splitT -= dt
      if (this.splitT < 0) this.splitT = 0
      this.splitEl.style.setProperty('--k', Math.min(1, this.splitT / 0.5).toFixed(3))
      if (this.splitT === 0) this.splitEl.hidden = true
    }

    // spin-out -------------------------------------------------------------
    const spinning = r.spinTime > 0
    if (spinning) {
      this.spinEl.hidden = false
      this.spinEl.style.setProperty('--k', Math.min(1, r.spinTime).toFixed(3))
      if (!this.reduced) {
        this.spinPhase = (this.spinPhase + dt * 420) % 360
        this.spinTxt.style.setProperty('--spin', (Math.sin(this.spinPhase * 0.0175) * 8).toFixed(1))
      }
    } else if (!this.spinEl.hidden) {
      this.spinEl.hidden = true
    }

    // position flash pop ---------------------------------------------------
    if (this.flashT > 0) {
      this.flashT -= dt
      if (this.flashT < 0) this.flashT = 0
      const k = this.flashT / 0.55
      this.posWrap.style.setProperty('--f', k.toFixed(3))
      if (!this.reduced) {
        this.posEl.style.transform = 'scale(' + (1 + 0.14 * k * k).toFixed(3) + ')'
      }
      if (this.flashT === 0) {
        this.posEl.style.removeProperty('transform')
        this.posEl.style.removeProperty('--sg-flash')
      }
    }
  }

  private updateClock(state: RaceState, fps: number, dt: number): void {
    const cs = Math.floor(state.time * 100)
    if (cs !== this.lastClock) {
      this.lastClock = cs
      setText(this.clockEl, fmtTime(state.time))
    }
    this.fpsAcc += dt
    if (this.fpsAcc > 0.35) {
      this.fpsAcc = 0
      const f = Math.round(fps)
      if (f !== this.lastFps) {
        this.lastFps = f
        setText(this.fpsEl, f + ' FPS')
      }
    }
  }

  // -------------------------------------------------------------------------
  // Minimap
  // -------------------------------------------------------------------------

  private updateMap(state: RaceState, track: Track, local: RacerState): void {
    const ctx = this.mapCtx
    if (!ctx) return
    if (this.mapDirty || this.mapTrack !== track) this.bakeMap(track)
    if (this.mapW <= 0 || this.mapH <= 0) return

    const w = this.mapW, h = this.mapH, dpr = this.mapDpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(this.mapOff, 0, 0, w, h)

    // item boxes: small squares
    const boxes = state.itemBoxes
    ctx.fillStyle = 'rgba(120,240,255,0.9)'
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]
      if (!b.active) continue
      this.project(b.pos.x, b.pos.z)
      ctx.fillRect(this.px - 1.6, this.py - 1.6, 3.2, 3.2)
    }

    // deployed fields: mines are diamonds, wells are rings
    const fields = state.fields
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i]
      if (!f.alive) continue
      this.project(f.pos.x, f.pos.z)
      const x = this.px, y = this.py
      if (f.kind === 'mine') {
        ctx.fillStyle = '#b44dff'
        ctx.beginPath()
        ctx.moveTo(x, y - 3.4)
        ctx.lineTo(x + 3.4, y)
        ctx.lineTo(x, y + 3.4)
        ctx.lineTo(x - 3.4, y)
        ctx.closePath()
        ctx.fill()
      } else {
        ctx.strokeStyle = '#8f6bff'
        ctx.lineWidth = 1.8
        ctx.beginPath()
        ctx.arc(x, y, 4.6, 0, Math.PI * 2)
        ctx.stroke()
      }
    }

    // racers
    const racers = state.racers
    for (let i = 0; i < racers.length; i++) {
      const rr = racers[i]
      if (rr === local) continue
      this.project(rr.pos.x, rr.pos.z)
      ctx.fillStyle = this.chassisColor(rr.chassisId)
      ctx.beginPath()
      ctx.arc(this.px, this.py, 3.4, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(0,0,0,0.7)'
      ctx.lineWidth = 1
      ctx.stroke()
    }

    // local player: bigger, outlined, with a heading nose
    this.project(local.pos.x, local.pos.z)
    const lx = this.px, ly = this.py
    // Map-space heading: the projection rotates the world by mAng.
    const a = local.yaw + this.mAng
    ctx.fillStyle = this.chassisColor(local.chassisId)
    ctx.beginPath()
    ctx.arc(lx, ly, 5.2, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.moveTo(lx - Math.sin(a) * 9.5, ly - Math.cos(a) * 9.5)
    ctx.lineTo(lx - Math.sin(a + 2.5) * 4.6, ly - Math.cos(a + 2.5) * 4.6)
    ctx.lineTo(lx - Math.sin(a - 2.5) * 4.6, ly - Math.cos(a - 2.5) * 4.6)
    ctx.closePath()
    ctx.fill()
  }

  private project(x: number, z: number): void {
    // u is negated so the map matches what the player sees: with forward
    // = (sin yaw, 0, cos yaw), screen-right is world -X, so world +X belongs
    // on the LEFT of the map. Without this the minimap is a mirror image and
    // every corner reads the wrong way.
    const u = -(x * this.mCos + z * this.mSin)
    const v = -x * this.mSin + z * this.mCos
    this.px = u * this.mScale + this.mOx
    this.py = -v * this.mScale + this.mOy
  }

  private readonly colorCache = new Map<string, string>()
  private chassisColor(id: string): string {
    let c = this.colorCache.get(id)
    if (c === undefined) {
      const def = CHASSIS_BY_ID[id]
      c = hex(def ? def.colorPrimary : 0xcccccc)
      this.colorCache.set(id, c)
    }
    return c
  }

  /** Bake the static centreline once per track / resize. */
  private bakeMap(track: Track): void {
    this.mapDirty = false
    this.mapTrack = track
    const w = Math.round(this.mapCanvas.clientWidth)
    const h = Math.round(this.mapCanvas.clientHeight)
    this.mapW = w
    this.mapH = h
    if (w <= 0 || h <= 0) { this.mapDirty = true; return }
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    this.mapDpr = dpr
    this.mapCanvas.width = Math.round(w * dpr)
    this.mapCanvas.height = Math.round(h * dpr)
    this.mapOff.width = this.mapCanvas.width
    this.mapOff.height = this.mapCanvas.height

    const samples = track.samples
    if (samples.length === 0) return

    // Rotate so the start straight runs up the map.
    const t0 = samples[0].tangent
    const ang = Math.atan2(-t0.x, t0.z)
    this.mAng = ang
    this.mCos = Math.cos(ang)
    this.mSin = Math.sin(ang)

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i].pos
      const u = -(p.x * this.mCos + p.z * this.mSin)
      const v = -(-p.x * this.mSin + p.z * this.mCos)
      if (u < minX) minX = u
      if (u > maxX) maxX = u
      if (v < minY) minY = v
      if (v > maxY) maxY = v
    }
    const pad = 9
    const sx = (w - pad * 2) / Math.max(1e-3, maxX - minX)
    const sy = (h - pad * 2) / Math.max(1e-3, maxY - minY)
    this.mScale = Math.min(sx, sy)
    this.mOx = pad + (w - pad * 2 - (maxX - minX) * this.mScale) * 0.5 - minX * this.mScale
    this.mOy = pad + (h - pad * 2 - (maxY - minY) * this.mScale) * 0.5 - minY * this.mScale

    const c = this.mapOff.getContext('2d')
    if (!c) return
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    c.clearRect(0, 0, w, h)

    c.beginPath()
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i].pos
      this.project(p.x, p.z)
      if (i === 0) c.moveTo(this.px, this.py); else c.lineTo(this.px, this.py)
    }
    c.closePath()
    c.lineJoin = 'round'
    c.lineCap = 'round'
    c.strokeStyle = 'rgba(3,7,16,0.92)'
    c.lineWidth = 7.5
    c.stroke()
    c.strokeStyle = 'rgba(34,211,255,0.32)'
    c.lineWidth = 5
    c.stroke()
    c.strokeStyle = 'rgba(190,235,255,0.9)'
    c.lineWidth = 1.5
    c.stroke()

    // start / finish tick, perpendicular to the start tangent
    const s0 = samples[0]
    this.project(s0.pos.x, s0.pos.z)
    const gx = this.px, gy = this.py
    this.project(s0.pos.x + s0.right.x * 9, s0.pos.z + s0.right.z * 9)
    const ex = this.px - gx, ey = this.py - gy
    c.strokeStyle = '#ffd23f'
    c.lineWidth = 3
    c.beginPath()
    c.moveTo(gx - ex, gy - ey)
    c.lineTo(gx + ex, gy + ey)
    c.stroke()
  }
}

// ---------------------------------------------------------------------------

export function createHud(container: HTMLElement): Hud {
  return new HudImpl(container)
}
