/**
 * settings.ts — SpaceGen Racing settings + controls overlay.
 *
 * One full-screen modal, two tabs:
 *   Settings  every option the player can change, applied the moment it is
 *             touched. No Apply button, no confirmation, no modal-inside-modal.
 *   Controls  a drawn diagram of whatever the player is actually holding —
 *             a keyboard, or a phone — plus a plain-language table of what
 *             every action does.
 *
 * Rules this module follows:
 * - The DOM is built once in the constructor. open()/close() only toggle a
 *   class and refresh text; nothing is ever rebuilt.
 * - No layout is read. Ever. Visibility is decided from the DOM tree
 *   ([hidden] ancestors), never from offsetParent / offsetWidth.
 * - Pointer events only. No mouse-only handler anywhere.
 * - Every localStorage access is wrapped: it throws outright in partitioned
 *   and embedded contexts.
 */
import './styles.css'
import { fullscreenMode, isFullscreen, setFullscreen, onFullscreenChange, type FullscreenMode } from '../game/fullscreen'
import './settings.css'
import {
  DEFAULT_KEYMAP,
  type ControlScheme,
  type InputManager,
  type KeyAction,
} from '../game/input'
import type { QualityTier } from '../render/api'
import {
  CAMERA_LIMITS, DEFAULT_CAMERA_SETTINGS, normaliseCameraSettings,
  type CameraSettings,
} from '../game/camera'

export interface SettingsPanel {
  root: HTMLElement
  open(tab?: 'settings' | 'controls'): void
  close(): void
  readonly isOpen: boolean
  /** Host wires these; all default to no-ops. */
  onClose: () => void
  onQualityChange: (q: QualityTier) => void
  onReducedMotionChange: (on: boolean) => void
  /**
   * Glare and screen-effect strength, both 0..1, both 1 = the tuned look.
   * Feeds `PostFx.setIntensity`. Fired once on construction (so a stored
   * choice — or the reduced-motion default — is in force before the first
   * race) and again on every change.
   */
  onVfxIntensityChange: (glare: number, screen: number) => void
  /**
   * How much the encouragement callouts are allowed to say. Same contract as
   * the two above: fired once on construction so a stored choice is in force
   * before the first race, then on every change.
   */
  onCalloutChange: (level: CalloutLevel) => void
  /** Seed the faders from the audio system's own stored values. */
  setVolumes(v: { master: number; music: number; sfx: number; vo: number }): void
  /** A volume moved, or mute toggled. Values 0..1. */
  onVolumeChange: (v: { master?: number; music?: number; sfx?: number; vo?: number; muted?: boolean }) => void
  /**
   * The camera rig the player has dialled in. Same contract as the three
   * above: fired once on construction so a stored rig is in force before the
   * first frame of the first race, then on every change -- including while a
   * race is paused behind the panel, which is the only way to actually judge
   * a camera.
   */
  onCameraChange: (s: CameraSettings) => void
  dispose(): void
}

export interface SettingsHost {
  input: InputManager
  getQuality(): QualityTier
  getReducedMotion(): boolean
}

// ---------------------------------------------------------------------------
// Types + constants
// ---------------------------------------------------------------------------

type TabId = 'settings' | 'controls'
type DiagramId = 'keyboard' | 'touch'
type TouchScheme = 'tilt' | 'stick' | 'buttons'
type Side = 'left' | 'right'
type FxLevel = 'full' | 'soft' | 'low' | 'off'
/** Re-exported so the host can type its handler without importing ui/cheer. */
export type CalloutLevel = 'full' | 'key' | 'off'

const LS_KEY = 'spacegen.settings'

interface Stored {
  quality?: QualityTier
  reducedMotion?: boolean
  tab?: TabId
  diagram?: DiagramId | 'auto'
  preview?: TouchScheme
  tiltInvert?: boolean
  oneHandedSide?: Side
  /**
   * Absent means "never chosen", which is NOT the same as "Full": an unchosen
   * level follows the reduced-motion default (see FX_RM_*). persist() writes
   * these two keys only once the player has actually picked a level, so
   * changing any other setting cannot silently freeze them at whatever they
   * happened to be showing.
   */
  glare?: FxLevel
  screenFx?: FxLevel
  /** Same "absent means never chosen" rule as the two above. */
  callouts?: CalloutLevel
  /**
   * The player's camera rig. Partial and untrusted: a key that is missing,
   * out of range or not a number falls back to the authored default, so an
   * old or hand-edited blob can never produce an unusable frame. See
   * normaliseCameraSettings.
   */
  camera?: Partial<CameraSettings>
}

const QUALITIES: { id: QualityTier; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
]

/**
 * The visual-intensity ladder, shared by both effect controls.
 *
 * FOUR NAMED STEPS RATHER THAN A SLIDER. A slider looks like the obvious
 * shape for "0..1", and it is the wrong one here:
 *
 * - On a gamepad it is unreachable. The pad reader moves DOM focus and
 *   presses A; A on an <input type=range> does nothing to its value, so a
 *   slider would need a parallel, pad-only value model that no other control
 *   in this dialog has.
 * - On a phone in landscape it is a thumb-width drag along a bar that sits
 *   between two other rows, versus four targets the width of a quarter of the
 *   card.
 * - There is nothing between 0.62 and 0.66 worth choosing, and there IS a
 *   categorical difference at 0 — the bloom pass leaves the chain entirely.
 *   "Off" is a word; "drag it all the way to the left" is a discovery
 *   problem.
 * - Every other control in this panel is a segment or a switch, and they all
 *   already work on pointer, key and pad through one code path.
 */
const FX_LEVELS: { id: FxLevel; label: string }[] = [
  { id: 'full', label: 'Full' },
  { id: 'soft', label: 'Softer' },
  { id: 'low', label: 'Minimal' },
  { id: 'off', label: 'Off' },
]

/** Level -> the 0..1 the renderer wants. */
const FX_VALUE: Record<FxLevel, number> = {
  full: 1,
  soft: 0.6,
  low: 0.35,
  off: 0,
}

/**
 * The callout ladder. Three steps rather than four, because unlike the two
 * effect controls there is no continuum here: either every earned moment gets
 * a line, or only the ones that decide a race, or none.
 */
const CALLOUT_LEVELS: { id: CalloutLevel; label: string }[] = [
  { id: 'full', label: 'Full' },
  { id: 'key', label: 'Key only' },
  { id: 'off', label: 'Off' },
]

function isCalloutLevel(v: unknown): v is CalloutLevel {
  return v === 'full' || v === 'key' || v === 'off'
}

/**
 * Where the two controls start when the player has not chosen and reduced
 * motion is on. A reduced-motion player did not ask for a blooming, smeared
 * frame; they get a calmer one by default and can still move either control
 * anywhere, including back to Full.
 */
const FX_RM_GLARE: FxLevel = 'soft'
const FX_RM_SCREEN: FxLevel = 'low'

const TOUCH_SCHEMES: { id: TouchScheme; label: string }[] = [
  { id: 'tilt', label: 'Tilt' },
  { id: 'stick', label: 'Stick' },
  { id: 'buttons', label: 'Buttons' },
]

const DESK_SCHEMES: { id: ControlScheme; label: string }[] = [
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'gamepad', label: 'Gamepad' },
]

const SIDES: { id: Side; label: string }[] = [
  { id: 'left', label: 'Left' },
  { id: 'right', label: 'Right' },
]

/** Colour token per action, shared by the diagram, legend and table. */
const COLOR: Record<string, string> = {
  accelerate: 'var(--sg-green)',
  brake: 'var(--sg-red)',
  steer: 'var(--sg-cyan)',
  drift: 'var(--sg-violet)',
  item: 'var(--sg-gold)',
  itemBack: 'var(--sg-orange)',
  lift: 'var(--sg-blue)',
  lookBack: 'var(--sg-pink)',
  horn: 'var(--sg-white)',
  pause: 'var(--sg-dim)',
}

/** Which action each KeyAction paints on the keyboard diagram. */
const ACTION_GROUP: Record<KeyAction, string> = {
  accelerate: 'accelerate',
  brake: 'brake',
  steerLeft: 'steer',
  steerRight: 'steer',
  drift: 'drift',
  item: 'item',
  itemBack: 'itemBack',
  lift: 'lift',
  lookBack: 'lookBack',
  pause: 'pause',
}

const BIND_ROWS: { action: KeyAction; label: string }[] = [
  { action: 'accelerate', label: 'Accelerate' },
  { action: 'brake', label: 'Brake / reverse' },
  { action: 'steerLeft', label: 'Steer left' },
  { action: 'steerRight', label: 'Steer right' },
  { action: 'drift', label: 'Drift' },
  { action: 'item', label: 'Use item' },
  { action: 'itemBack', label: 'Fire item backward' },
  { action: 'lift', label: 'Lift (flight)' },
  { action: 'lookBack', label: 'Look behind' },
  { action: 'pause', label: 'Pause' },
]

interface ActRow {
  id: string
  name: string
  /** Live keymap actions to read the key column from. */
  keys: KeyAction[]
  /** Used when nothing in the keymap covers it (horn). */
  keyFallback?: string
  touch: string
  desc: string
}

const ACTS: ActRow[] = [
  {
    id: 'accelerate',
    name: 'Accelerate',
    keys: ['accelerate'],
    touch: 'GAS pad',
    desc: 'Hold to open the throttle. With Auto-accelerate on you never touch it — the ship drives, you only steer.',
  },
  {
    id: 'brake',
    name: 'Brake / reverse',
    keys: ['brake'],
    touch: 'BRAKE pad',
    desc: 'Tap to scrub speed into a corner you overcooked; hold at a standstill to back out of a wall.',
  },
  {
    id: 'steer',
    name: 'Steer',
    keys: ['steerLeft', 'steerRight'],
    touch: 'Tilt / stick / ◀ ▶ pads',
    desc: 'Ease into it. A stab of full lock washes off speed; a held line keeps it.',
  },
  {
    id: 'drift',
    name: 'Drift',
    keys: ['drift'],
    touch: 'DRIFT',
    desc: 'Hold through a corner to charge a boost — the longer the drift, the bigger the boost.',
  },
  {
    id: 'item',
    name: 'Use item',
    keys: ['item'],
    touch: 'ITEM',
    desc: 'Fires what is in your slot straight ahead. Hold it down to dump a triple charge one shot at a time.',
  },
  {
    id: 'itemBack',
    name: 'Fire item backward',
    keys: ['itemBack'],
    touch: 'BACK',
    desc: 'Same item, out the back — for whoever is sitting on your tail. Braking while you fire does it too.',
  },
  {
    id: 'lift',
    name: 'Lift',
    keys: ['lift'],
    touch: 'LIFT',
    desc: 'Flight chassis only: burns your Lift meter to leave the track entirely and cut your own line.',
  },
  {
    id: 'lookBack',
    name: 'Look behind',
    keys: ['lookBack'],
    touch: 'LOOK',
    desc: 'Swings the camera round so you can see what is about to hit you.',
  },
  
  {
    id: 'pause',
    name: 'Pause',
    keys: ['pause'],
    touch: 'HUD pause control',
    desc: 'Freezes the race and opens the pause menu — and this panel.',
  },
]

/** The note under the phone, one per touch scheme. */
const PHONE_NOTE: Record<TouchScheme, string> = {
  tilt:
    'Held in landscape. Steering is the device itself — roll it. RE-CENTRE, bottom left, ' +
    'takes whatever angle you happen to be holding and calls that straight ahead. ' +
    'The right thumb keeps drift, brake and items.',
  stick:
    'Held in landscape. Touch down anywhere in the left zone and a stick appears under your ' +
    'thumb — it is placed where you land, so you never have to find it mid-corner. ' +
    'The right thumb keeps drift, brake and items.',
  buttons:
    'Held in landscape. Discrete ◀ ▶ pads steer from the bottom left, GAS joins BRAKE in the ' +
    'right cluster, and drift and items stay under the right thumb.',
}

const PAD_ROWS: [string, string][] = [
  ['RT', 'Accelerate'],
  ['LT', 'Brake / reverse'],
  ['Left stick', 'Steer'],
  ['A / Cross', 'Drift — hold to charge a boost'],
  ['X / Square', 'Use item'],
  ['X + LT', 'Fire item backward (or pull the stick back)'],
  ['LB', 'Lift — flight chassis only'],
  ['RS click', 'Look behind'],
  ['Start', 'Pause'],
]

// --- keyboard diagram ------------------------------------------------------

interface Cap {
  code: string
  label: string
  u: number
}

function cap(code: string, u = 1, label?: string): Cap {
  return { code, label: label ?? keyLabel(code), u }
}

const KEY_LABEL: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Space: 'Space',
  Escape: 'Esc',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Bksp',
  CapsLock: 'Caps',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  ControlLeft: 'Ctrl',
  ControlRight: 'Ctrl',
  AltLeft: 'Alt',
  AltRight: 'Alt',
  MetaLeft: 'Meta',
  MetaRight: 'Menu',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
}

function keyLabel(code: string): string {
  const m = KEY_LABEL[code]
  if (m !== undefined) return m
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6)
  return code
}

/** ANSI-ish rows, each summing to 15 units so every row lines up. */
const KB_ROWS: Cap[][] = [
  [cap('Escape'), cap('', 14, '')],
  [
    cap('Backquote'), cap('Digit1'), cap('Digit2'), cap('Digit3'), cap('Digit4'),
    cap('Digit5'), cap('Digit6'), cap('Digit7'), cap('Digit8'), cap('Digit9'),
    cap('Digit0'), cap('Minus'), cap('Equal'), cap('Backspace', 2),
  ],
  [
    cap('Tab', 1.5), cap('KeyQ'), cap('KeyW'), cap('KeyE'), cap('KeyR'),
    cap('KeyT'), cap('KeyY'), cap('KeyU'), cap('KeyI'), cap('KeyO'),
    cap('KeyP'), cap('BracketLeft'), cap('BracketRight'), cap('Backslash', 1.5),
  ],
  [
    cap('CapsLock', 1.75), cap('KeyA'), cap('KeyS'), cap('KeyD'), cap('KeyF'),
    cap('KeyG'), cap('KeyH'), cap('KeyJ'), cap('KeyK'), cap('KeyL'),
    cap('Semicolon'), cap('Quote'), cap('Enter', 2.25),
  ],
  [
    cap('ShiftLeft', 2.25), cap('KeyZ'), cap('KeyX'), cap('KeyC'), cap('KeyV'),
    cap('KeyB'), cap('KeyN'), cap('KeyM'), cap('Comma'), cap('Period'),
    cap('Slash'), cap('ShiftRight', 2.75),
  ],
  [
    cap('ControlLeft', 1.25), cap('MetaLeft', 1.25), cap('AltLeft', 1.25),
    cap('Space', 7.5), cap('AltRight', 1.25), cap('MetaRight', 1.25),
    cap('ControlRight', 1.25),
  ],
]

const ARROW_ROWS: Cap[][] = [
  [cap('', 1, ''), cap('ArrowUp'), cap('', 1, '')],
  [cap('ArrowLeft'), cap('ArrowDown'), cap('ArrowRight')],
]

const FOCUSABLE =
  'button:not([disabled]):not([tabindex="-1"]), [href], input:not([disabled]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// --- gamepad navigation ----------------------------------------------------
// Same bitmask, thresholds and repeat feel as the front end's poller, so a pad
// behaves identically in the menus and in this dialog.

const PAD_L = 1 << 0
const PAD_R = 1 << 1
const PAD_U = 1 << 2
const PAD_D = 1 << 3
const PAD_A = 1 << 4
const PAD_B = 1 << 5
const PAD_AXIS = 0.55
const PAD_POLL_MS = 60
const PAD_DELAY_MS = 400
const PAD_REPEAT_MS = 140
/** Pad ticks between refreshes of the "gamepad connected" pill. */
const PAD_PILL_EVERY = 16

// ---------------------------------------------------------------------------
// Storage — every access guarded.
// ---------------------------------------------------------------------------

function load(): Stored {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(LS_KEY)
  } catch {
    return {}
  }
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Stored
  } catch {
    return {}
  }
}

function save(s: Stored): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s))
  } catch {
    /* non-fatal: private mode, partitioned storage, embedded webview */
  }
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  parent?: Element,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  if (parent) parent.appendChild(node)
  return node
}

function btn(cls: string, parent: Element, text?: string): HTMLButtonElement {
  const b = el('button', cls, parent, text)
  b.type = 'button'
  return b
}

/**
 * Wire a plain button so pointer, key and pad all reach it.
 *
 * The pointer path is `pointerup`, which a native <button> does NOT synthesise
 * from Space or Enter — so a button given only that handler is mouse and touch
 * only, however focusable it looks. Every segmented control and switch in here
 * already pairs the two; this does the same for the one-shot buttons.
 */
function onPress(b: HTMLButtonElement, run: () => void): void {
  b.addEventListener('pointerup', (ev) => {
    if ((ev as PointerEvent).button !== 0) return
    run()
  })
  b.addEventListener('keydown', (ev) => {
    const e = ev as KeyboardEvent
    if (e.key !== ' ' && e.key !== 'Enter') return
    e.preventDefault()
    e.stopPropagation()
    run()
  })
}

function isQuality(v: unknown): v is QualityTier {
  return v === 'low' || v === 'medium' || v === 'high'
}

function isTouchScheme(s: ControlScheme): s is TouchScheme {
  return s === 'tilt' || s === 'stick' || s === 'buttons'
}

function isFxLevel(v: unknown): v is FxLevel {
  return v === 'full' || v === 'soft' || v === 'low' || v === 'off'
}

/** Visible = not inside anything carrying [hidden]. Costs no layout. */
function isVisible(node: HTMLElement): boolean {
  return node.closest('[hidden]') === null
}

// ---------------------------------------------------------------------------
// A radio-style segmented control. Roving tabindex + arrow keys.
// ---------------------------------------------------------------------------

interface Seg<T extends string> {
  root: HTMLElement
  set(value: T): void
  setDisabled(value: T, off: boolean): void
  buttons: Map<T, HTMLButtonElement>
}

/**
 * A labelled volume slider.
 *
 * The first continuous control in this panel -- everything else is a segmented
 * choice. Volume is the one setting where discrete steps are actively worse:
 * "Music: Low / Mid / High" cannot express "audible but under the engines",
 * which is exactly where most players want it.
 *
 * `input` rather than `change` so dragging is live and the player hears what
 * they are setting while they set it, which is the whole point of a fader.
 */
function makeSlider(
  parent: Element,
  id: string,
  label: string,
  onInput: (v: number) => void,
): HTMLInputElement {
  const row = el('div', 'sgset-row', parent)
  const lab = el('label', 'sgset-row__k', row, label)
  lab.htmlFor = id
  const wrap = el('div', 'sgset-slider', row)
  const input = el('input', 'sgset-slider__in', wrap) as HTMLInputElement
  input.type = 'range'
  input.id = id
  input.min = '0'
  input.max = '100'
  input.step = '1'
  const read = el('span', 'sgset-slider__v', wrap, '0')
  input.addEventListener('input', () => {
    const v = Number(input.value) / 100
    read.textContent = String(Math.round(v * 100))
    onInput(v)
  })
  return input
}

function makeSeg<T extends string>(
  parent: Element,
  label: string,
  items: { id: T; label: string }[],
  onPick: (v: T) => void,
): Seg<T> {
  const root = el('div', 'sgset-seg', parent)
  root.setAttribute('role', 'radiogroup')
  root.setAttribute('aria-label', label)
  const buttons = new Map<T, HTMLButtonElement>()
  const order: T[] = []

  const pick = (v: T): void => {
    const b = buttons.get(v)
    if (!b || b.getAttribute('aria-disabled') === 'true') return
    onPick(v)
  }

  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const b = btn('sgset-seg__btn', root, it.label)
    b.setAttribute('role', 'radio')
    b.setAttribute('aria-checked', 'false')
    b.tabIndex = i === 0 ? 0 : -1
    b.addEventListener('pointerup', (ev) => {
      if ((ev as PointerEvent).button !== 0) return
      pick(it.id)
    })
    // Keyboard activation: Space/Enter fire click, never a pointer event.
    b.addEventListener('keydown', (ev) => {
      const e = ev as KeyboardEvent
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        pick(it.id)
      }
    })
    buttons.set(it.id, b)
    order.push(it.id)
  }

  root.addEventListener('keydown', (ev) => {
    const e = ev as KeyboardEvent
    let d = 0
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') d = 1
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') d = -1
    else return
    e.preventDefault()
    e.stopPropagation()
    const active = document.activeElement
    let i = order.findIndex((id) => buttons.get(id) === active)
    if (i < 0) i = 0
    for (let step = 0; step < order.length; step++) {
      i = (i + d + order.length) % order.length
      const nb = buttons.get(order[i])
      if (nb && nb.getAttribute('aria-disabled') !== 'true') {
        nb.focus()
        pick(order[i])
        return
      }
    }
  })

  const set = (value: T): void => {
    buttons.forEach((b, id) => {
      const on = id === value
      b.setAttribute('aria-checked', on ? 'true' : 'false')
      b.tabIndex = on ? 0 : -1
    })
    // Nothing matched (e.g. gamepad active while the touch group is shown):
    // keep the first button reachable by Tab.
    if (!buttons.has(value)) {
      const first = buttons.get(order[0])
      if (first) first.tabIndex = 0
    }
  }

  const setDisabled = (value: T, off: boolean): void => {
    const b = buttons.get(value)
    if (!b) return
    b.setAttribute('aria-disabled', off ? 'true' : 'false')
  }

  return { root, set, setDisabled, buttons }
}

// ---------------------------------------------------------------------------
// A NUMBER ROW: minus, the value, plus.
//
// The panel's other controls are segments of 3-4 named steps, and there is a
// long note above FX_LEVELS explaining why a slider was the wrong shape for
// them. Every word of it still applies here -- a gamepad cannot move an
// <input type=range> at all, because the pad reader works by moving DOM focus
// and pressing A -- but a camera rig is genuinely a continuum where 9.0 and
// 10.5 are both worth having, so named steps are not the answer either.
//
// A stepper is the shape that satisfies both. It is two ordinary buttons, so
// it inherits pointer, keyboard and pad support through the exact code path
// every other control here already uses. It shows the NUMBER, which matters
// for a setting a player is going to want to tell somebody else about. And it
// is two fat targets on a phone rather than a thumb-width drag between two
// other rows.
//
// THE VALUE GRID IS ANCHORED ON THE MINIMUM, and every default sits on it --
// asserted in camera.test.ts. A default that is not reachable by stepping is
// a trap: nudge it once and the frame the game shipped with is gone for good.
// ---------------------------------------------------------------------------

interface StepperRow {
  row: HTMLElement
  set(v: number): void
  readonly buttons: HTMLButtonElement[]
}

function makeStepper(
  parent: Element,
  label: string,
  sub: string,
  range: readonly [number, number, number],
  fmt: (v: number) => string,
  get: () => number,
  onChange: (v: number) => void,
): StepperRow {
  const [lo, hi, step] = range
  const row = el('div', 'sgset-row', parent)
  const txt = el('div', 'sgset-row__txt', row)
  el('div', 'sgset-row__k', txt, label)
  if (sub) el('div', 'sgset-row__sub', txt, sub)

  const grp = el('div', 'sgset-step', row)
  grp.setAttribute('role', 'group')
  grp.setAttribute('aria-label', label)

  const bump = (dir: number): void => {
    // Snap to the grid first, so a stored value from an older build with a
    // different step lands somewhere reachable instead of carrying its offset
    // forward forever.
    const n = Math.round((get() - lo) / step)
    const next = Math.min(hi, Math.max(lo, lo + (n + dir) * step))
    // Floating point: 1.2 + 12 * 0.2 is 3.5999999999999996.
    onChange(Math.round(next * 1e6) / 1e6)
  }

  const mk = (cls: string, text: string, dir: number, aria: string): HTMLButtonElement => {
    const b = btn(`sgset-step__btn ${cls}`, grp, text)
    b.setAttribute('aria-label', `${aria} ${label}`)
    b.addEventListener('pointerup', (ev) => {
      if ((ev as PointerEvent).button !== 0) return
      bump(dir)
    })
    b.addEventListener('keydown', (ev) => {
      const e = ev as KeyboardEvent
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        bump(dir)
      }
    })
    return b
  }

  const minus = mk('sgset-step__btn--dn', '\u2212', -1, 'Decrease')
  const out = el('div', 'sgset-step__val', grp)
  out.setAttribute('role', 'status')
  out.setAttribute('aria-live', 'off')
  const plus = mk('sgset-step__btn--up', '+', 1, 'Increase')

  // Arrow keys anywhere in the group, matching makeSeg's behaviour so the two
  // control types feel identical under a keyboard.
  grp.addEventListener('keydown', (ev) => {
    const e = ev as KeyboardEvent
    let d = 0
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') d = 1
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') d = -1
    else return
    e.preventDefault()
    e.stopPropagation()
    bump(d)
  })

  const set = (v: number): void => {
    out.textContent = fmt(v)
    // At an end stop the button is marked aria-disabled, which ALSO takes it
    // out of focusables() -- so a pad walking the dialog steps over it rather
    // than stopping on a control that cannot do anything. That is the same
    // treatment makeSeg gives a disabled segment, deliberately.
    minus.setAttribute('aria-disabled', v <= lo + 1e-9 ? 'true' : 'false')
    plus.setAttribute('aria-disabled', v >= hi - 1e-9 ? 'true' : 'false')
    grp.setAttribute('aria-valuenow', String(v))
  }
  return { row, set, buttons: [minus, plus] }
}

// ---------------------------------------------------------------------------
// A labelled switch row.
// ---------------------------------------------------------------------------

interface SwitchRow {
  row: HTMLElement
  input: HTMLButtonElement
  set(on: boolean): void
}

function makeSwitchRow(
  parent: Element,
  label: string,
  sub: string,
  onToggle: (on: boolean) => void,
): SwitchRow {
  const row = el('div', 'sgset-row', parent)
  const txt = el('div', 'sgset-row__txt', row)
  el('div', 'sgset-row__k', txt, label)
  if (sub) el('div', 'sgset-row__sub', txt, sub)
  const b = btn('sgset-sw', row)
  b.setAttribute('role', 'switch')
  b.setAttribute('aria-checked', 'false')
  b.setAttribute('aria-label', label)
  b.addEventListener('pointerup', (ev) => {
    if ((ev as PointerEvent).button !== 0) return
    onToggle(b.getAttribute('aria-checked') !== 'true')
  })
  b.addEventListener('keydown', (ev) => {
    const e = ev as KeyboardEvent
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      onToggle(b.getAttribute('aria-checked') !== 'true')
    }
  })
  const set = (on: boolean): void => {
    b.setAttribute('aria-checked', on ? 'true' : 'false')
  }
  return { row, input: b, set }
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

class SettingsPanelImpl implements SettingsPanel {
  readonly root: HTMLElement

  onClose: () => void = (): void => {}
  onQualityChange: (q: QualityTier) => void = (): void => {}
  onReducedMotionChange: (on: boolean) => void = (): void => {}
  onVfxIntensityChange: (glare: number, screen: number) => void = (): void => {}
  onCalloutChange: (level: CalloutLevel) => void = (): void => {}
  onVolumeChange: (v: { master?: number; music?: number; sfx?: number; vo?: number; muted?: boolean }) => void = (): void => {}
  private volMaster!: HTMLInputElement
  private volMusic!: HTMLInputElement
  private volSfx!: HTMLInputElement
  private volVo!: HTMLInputElement

  /**
   * Seeded from the audio module rather than from this panel's own store.
   *
   * The audio system reads its volumes at boot, before this panel is built, so
   * it is the owner. This only reflects them -- two sources of truth for a
   * volume is how a player ends up with a muted game and a slider showing 80%.
   */
  setVolumes(v: { master: number; music: number; sfx: number; vo: number }): void {
    const set = (el2: HTMLInputElement, n: number): void => {
      el2.value = String(Math.round(Math.max(0, Math.min(1, n)) * 100))
      const read = el2.parentElement?.querySelector('.sgset-slider__v')
      if (read) read.textContent = el2.value
    }
    set(this.volMaster, v.master)
    set(this.volMusic, v.music)
    set(this.volSfx, v.sfx)
    set(this.volVo, v.vo)
  }
  onCameraChange: (s: CameraSettings) => void = (): void => {}

  private readonly host: SettingsHost
  private readonly container: HTMLElement
  private readonly dialog: HTMLElement

  private stored: Stored
  private openFlag = false
  private tab: TabId = 'settings'
  private diagram: DiagramId = 'keyboard'
  private diagramMode: DiagramId | 'auto' = 'auto'
  private preview: TouchScheme = 'tilt'
  private quality: QualityTier
  private swFull!: SwitchRow
  private fsMode: FullscreenMode = 'unsupported'
  private offFsChange: (() => void) | null = null
  private reducedMotion: boolean
  private tiltInvert: boolean
  private oneHandedSide: Side
  /** null = never chosen, so it tracks the reduced-motion default. */
  private glareLevel: FxLevel | null = null
  private calloutLevel: CalloutLevel | null = null
  private screenLevel: FxLevel | null = null
  private disposed = false

  // --- element handles ----------------------------------------------------
  private readonly tabBtns = new Map<TabId, HTMLButtonElement>()
  private readonly panels = new Map<TabId, HTMLElement>()
  private readonly touchSeg: Seg<TouchScheme>
  private readonly deskSeg: Seg<ControlScheme>
  private readonly touchSchemeRow: HTMLElement
  private readonly deskSchemeRow: HTMLElement
  private readonly padPill: HTMLElement
  private readonly qualitySeg: Seg<QualityTier>
  private readonly glareSeg: Seg<FxLevel>
  private readonly calloutSeg: Seg<CalloutLevel>
  private readonly screenSeg: Seg<FxLevel>
  private readonly fxNote: HTMLElement
  private readonly sideSeg: Seg<Side>
  private readonly sideRow: HTMLElement
  private readonly previewSeg: Seg<TouchScheme>
  private readonly diagramSeg: Seg<DiagramId>
  private readonly autoTag: HTMLElement
  private readonly swAuto: SwitchRow
  private readonly swInvert: SwitchRow
  private readonly swRM: SwitchRow
  private readonly swOne: SwitchRow
  private readonly swHap: SwitchRow
  private readonly camSteppers: { key: keyof CameraSettings; st: StepperRow }[] = []
  private readonly camReset: HTMLButtonElement
  private readonly tiltRows: HTMLElement[] = []
  private readonly bindSection: HTMLElement
  private readonly bindSlots: { action: KeyAction; slot: number; b: HTMLButtonElement }[] = []
  private readonly bindExtra = new Map<KeyAction, HTMLElement>()
  private readonly caps = new Map<string, HTMLElement[]>()
  private readonly kbView: HTMLElement
  private readonly touchView: HTMLElement
  private readonly phone: HTMLElement
  private readonly phoneNote: HTMLElement
  private readonly actKeyCells = new Map<string, HTMLElement>()
  private readonly actTouchCells = new Map<string, HTMLElement>()

  // --- transient ----------------------------------------------------------
  private camera: CameraSettings = { ...DEFAULT_CAMERA_SETTINGS }
  private capturing: (() => void) | null = null
  private capturingBtn: HTMLButtonElement | null = null
  private prevFocus: HTMLElement | null = null
  private padTimer = 0
  private padPrev = 0
  private padDir = 0
  private padRepeat = 0
  private padTick = 0

  constructor(container: HTMLElement, host: SettingsHost) {
    this.container = container
    this.host = host
    this.stored = load()

    const input = host.input
    this.quality = isQuality(this.stored.quality) ? this.stored.quality : host.getQuality()
    this.reducedMotion =
      typeof this.stored.reducedMotion === 'boolean'
        ? this.stored.reducedMotion
        : host.getReducedMotion()
    this.camera = normaliseCameraSettings(this.stored.camera)
    this.tiltInvert = this.stored.tiltInvert === true
    this.oneHandedSide = this.stored.oneHandedSide === 'left' ? 'left' : 'right'
    this.glareLevel = isFxLevel(this.stored.glare) ? this.stored.glare : null
    this.calloutLevel = isCalloutLevel(this.stored.callouts) ? this.stored.callouts : null
    this.screenLevel = isFxLevel(this.stored.screenFx) ? this.stored.screenFx : null
    this.tab = this.stored.tab === 'controls' ? 'controls' : 'settings'
    this.diagramMode =
      this.stored.diagram === 'keyboard' || this.stored.diagram === 'touch'
        ? this.stored.diagram
        : 'auto'
    this.preview =
      this.stored.preview === 'stick' || this.stored.preview === 'buttons'
        ? this.stored.preview
        : 'tilt'

    // ---- shell -----------------------------------------------------------
    const root = el('div', 'sgset')
    root.hidden = true
    this.root = root
    const scrim = el('div', 'sgset__scrim', root)
    scrim.addEventListener('pointerup', (ev) => {
      if ((ev as PointerEvent).button !== 0) return
      this.close()
    })

    const dialog = el('div', 'sgset__dialog', root)
    this.dialog = dialog
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-label', 'Settings and controls')
    dialog.tabIndex = -1
    dialog.addEventListener('keydown', this.onKeyDown)

    // ---- header ----------------------------------------------------------
    const head = el('div', 'sgset__head', dialog)
    const title = el('div', 'sgset__title', head)
    title.appendChild(document.createTextNode('SPACE'))
    el('span', '', title, 'GEN')
    title.appendChild(document.createTextNode(' OPTIONS'))

    const tabs = el('div', 'sgset__tabs', head)
    tabs.setAttribute('role', 'tablist')
    tabs.setAttribute('aria-label', 'Options sections')
    tabs.addEventListener('keydown', this.onTabKey)
    const mkTab = (id: TabId, label: string): void => {
      const b = btn('sgset__tab', tabs, label)
      b.id = 'sgset-tab-' + id
      b.setAttribute('role', 'tab')
      b.setAttribute('aria-selected', 'false')
      b.setAttribute('aria-controls', 'sgset-panel-' + id)
      b.tabIndex = -1
      b.addEventListener('pointerup', (ev) => {
        if ((ev as PointerEvent).button !== 0) return
        this.setTab(id)
      })
      b.addEventListener('keydown', (ev) => {
        const e = ev as KeyboardEvent
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
          this.setTab(id)
        }
      })
      this.tabBtns.set(id, b)
    }
    mkTab('settings', 'Settings')
    mkTab('controls', 'Controls')

    const closeBtn = btn('sgset__close', head, '✕')
    closeBtn.setAttribute('aria-label', 'Close options')
    onPress(closeBtn, () => this.close())

    // ---- body ------------------------------------------------------------
    const body = el('div', 'sgset__body', dialog)

    const setPanel = el('div', 'sgset__panel', body)
    setPanel.id = 'sgset-panel-settings'
    setPanel.setAttribute('role', 'tabpanel')
    setPanel.setAttribute('aria-labelledby', 'sgset-tab-settings')
    setPanel.tabIndex = -1
    this.panels.set('settings', setPanel)

    const ctlPanel = el('div', 'sgset__panel', body)
    ctlPanel.id = 'sgset-panel-controls'
    ctlPanel.setAttribute('role', 'tabpanel')
    ctlPanel.setAttribute('aria-labelledby', 'sgset-tab-controls')
    ctlPanel.tabIndex = -1
    this.panels.set('controls', ctlPanel)

    // =====================================================================
    // SETTINGS TAB
    // =====================================================================
    const grid = el('div', 'sgset__grid', setPanel)

    // --- Controls ---------------------------------------------------------
    const secCtl = el('div', 'sgset-sec', grid)
    el('div', 'sgset-sec__title', secCtl, 'Controls')

    this.touchSchemeRow = el('div', 'sgset-row', secCtl)
    const tTxt = el('div', 'sgset-row__txt', this.touchSchemeRow)
    el('div', 'sgset-row__k', tTxt, 'Control scheme')
    el('div', 'sgset-row__sub', tTxt, 'How you steer on a touch screen.')
    this.touchSeg = makeSeg<TouchScheme>(
      this.touchSchemeRow,
      'Touch control scheme',
      TOUCH_SCHEMES,
      (v) => {
        input.setScheme(v)
        this.preview = v
        this.persist()
        this.sync()
      },
    )

    this.deskSchemeRow = el('div', 'sgset-row', secCtl)
    const dTxt = el('div', 'sgset-row__txt', this.deskSchemeRow)
    el('div', 'sgset-row__k', dTxt, 'Control scheme')
    const padLine = el('div', 'sgset-row__sub sgset-row__sub--pill', dTxt)
    padLine.appendChild(document.createTextNode('Gamepad '))
    this.padPill = el('span', 'sgset-pill', padLine, 'Not connected')
    this.deskSeg = makeSeg<ControlScheme>(
      this.deskSchemeRow,
      'Control scheme',
      DESK_SCHEMES,
      (v) => {
        input.setScheme(v)
        this.persist()
        this.sync()
      },
    )

    // --- Driving ----------------------------------------------------------
    const secDrive = el('div', 'sgset-sec', grid)
    el('div', 'sgset-sec__title', secDrive, 'Driving')

    this.swAuto = makeSwitchRow(
      secDrive,
      'Auto-accelerate',
      'The throttle stays open. You only steer, brake and drift.',
      (on) => {
        input.setAutoAccelerate(on)
        this.persist()
        this.sync()
      },
    )

    this.swInvert = makeSwitchRow(
      secDrive,
      'Invert tilt',
      'Flip which way the ship turns when you roll the device.',
      (on) => {
        this.tiltInvert = on
        input.setTiltInvert(on)
        this.persist()
        this.sync()
      },
    )
    this.tiltRows.push(this.swInvert.row)

    const calRow = el('div', 'sgset-row', secDrive)
    const cTxt = el('div', 'sgset-row__txt', calRow)
    el('div', 'sgset-row__k', cTxt, 'Calibrate tilt')
    el('div', 'sgset-row__sub', cTxt, 'Hold the device how you race, then set it as centre.')
    const calBtn = btn('sgset-mini', calRow, 'Re-centre')
    onPress(calBtn, () => {
      input.calibrateTilt()
      this.flash(calBtn, 'Centred')
    })
    this.tiltRows.push(calRow)

    // --- Accessibility ----------------------------------------------------
    // ---- Camera ----------------------------------------------------------
    //
    // Six numbers rather than three presets. A chase camera is the one part
    // of this game where "correct" is a matter of the player's eyes and the
    // size of their screen: the same rig that reads as planted on a 27-inch
    // monitor reads as claustrophobic on a phone held at arm's length, and
    // the amount of camera movement a person can take before they feel ill
    // varies more between two people than between two of these tracks.
    //
    // Every row states the units and the default, and the whole group has one
    // reset, because the fastest way to ruin a camera is to change four things
    // and not remember which.
    const secCam = el('div', 'sgset-sec', grid)
    el('div', 'sgset-sec__title', secCam, 'Camera')

    const camRow = (
      key: keyof CameraSettings,
      label: string,
      sub: string,
      fmt: (v: number) => string,
    ): void => {
      const st = makeStepper(
        secCam, label, sub, CAMERA_LIMITS[key], fmt,
        () => this.camera[key],
        (v) => {
          this.camera = normaliseCameraSettings({ ...this.camera, [key]: v })
          this.onCameraChange(this.camera)
          this.persist()
          this.sync()
        },
      )
      this.camSteppers.push({ key, st })
    }

    camRow('distance', 'Distance', 'How far behind the car the camera sits.',
      (v) => `${v.toFixed(1)} m`)
    camRow('height', 'Height', 'How high above it.',
      (v) => `${v.toFixed(1)} m`)
    camRow(
      'angle', 'Angle',
      'How far down the camera looks. Lower puts the car nearer the middle of '
      + 'the screen and shows more road ahead.',
      (v) => `${v.toFixed(1)}°`,
    )
    camRow(
      'tracking', 'Tracking buffer',
      'How loosely the camera follows. Low bolts the car to one spot on the '
      + 'screen. High lets it drift around that spot and swing wide through '
      + 'corners before the camera catches up.',
      (v) => (v <= 0.001 ? 'Locked' : `${Math.round(v * 100)}%`),
    )
    camRow(
      'shake', 'Impact shake',
      'How hard the camera is knocked when you hit something. Boosting does '
      + 'not use this — for that, see Boost effect below.',
      (v) => (v <= 0.001 ? 'Off' : `${Math.round(v * 100)}%`),
    )
    camRow(
      'boost', 'Boost camera kick',
      'How hard the camera lunges and the lens opens on a boost or drift '
      + 'release. This is the part that can be disorienting — turning it down '
      + 'does not touch the tunnel vision below.',
      (v) => (v <= 0.001 ? 'Off' : `${Math.round(v * 100)}%`),
    )
    camRow(
      'tunnel', 'Tunnel vision',
      'The dark closing in from the edges, the speed streaks and the blur on '
      + 'a boost. Nothing moves, so turn this up as far as you like — it is '
      + 'the effect without the lurch.',
      (v) => (v <= 0.001 ? 'Off' : `${Math.round(v * 100)}%`),
    )

    const resetRow = el('div', 'sgset-row', secCam)
    const rTxt = el('div', 'sgset-row__txt', resetRow)
    el('div', 'sgset-row__k', rTxt, 'Reset camera')
    el('div', 'sgset-row__sub', rTxt, 'Back to the frame the game ships with.')
    this.camReset = btn('sgset-step__btn sgset-step__btn--wide', resetRow, 'RESET')
    this.camReset.setAttribute('aria-label', 'Reset camera to defaults')
    const doReset = (): void => {
      this.camera = { ...DEFAULT_CAMERA_SETTINGS }
      this.onCameraChange(this.camera)
      this.persist()
      this.sync()
    }
    this.camReset.addEventListener('pointerup', (ev) => {
      if ((ev as PointerEvent).button !== 0) return
      doReset()
    })
    this.camReset.addEventListener('keydown', (ev) => {
      const e = ev as KeyboardEvent
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        doReset()
      }
    })
    el(
      'div', 'sgset-note', secCam,
      'Changes apply straight away. Open this during a race — pause, '
      + 'adjust, and you can see the new frame behind the panel.',
    )

    const secA11y = el('div', 'sgset-sec', grid)
    el('div', 'sgset-sec__title', secA11y, 'Accessibility')

    this.swRM = makeSwitchRow(
      secA11y,
      'Reduced motion',
      'Cuts screen shake, flashes and camera swings. Also starts Glare and ' +
        'Speed effects lower, until you set them yourself.',
      (on) => {
        this.reducedMotion = on
        this.root.dataset.rm = on ? 'on' : 'off'
        this.onReducedMotionChange(on)
        // Either effect the player has not chosen follows this, so the two
        // segments below move with the switch.
        this.emitVfx()
        this.persist()
        this.sync()
      },
    )

    this.swOne = makeSwitchRow(
      secA11y,
      'One-handed layout',
      'Moves every touch control to a single side of the screen.',
      (on) => {
        input.setOneHanded(on, this.oneHandedSide)
        this.persist()
        this.sync()
      },
    )

    this.sideRow = el('div', 'sgset-row', secA11y)
    const sTxt = el('div', 'sgset-row__txt', this.sideRow)
    el('div', 'sgset-row__k', sTxt, 'Controls side')
    el('div', 'sgset-row__sub', sTxt, 'Which hand holds the phone.')
    this.sideSeg = makeSeg<Side>(this.sideRow, 'One-handed side', SIDES, (v) => {
      this.oneHandedSide = v
      input.setOneHanded(input.oneHanded, v)
      this.persist()
      this.sync()
    })

    this.swHap = makeSwitchRow(
      secA11y,
      'Haptics',
      'Rumble on hits, boosts and pickups, where the device supports it.',
      (on) => {
        input.setHaptics(on)
        this.persist()
        this.sync()
      },
    )

    /**
     * AUDIO.
     *
     * Four faders rather than one, and the VO fader is the reason. Callout
     * voices are the first thing a player turns off in any racer -- they are
     * the most repetitive sound in the game by a wide margin -- and a single
     * master would make that choice cost them the music and the engines too.
     *
     * Volumes live in their own localStorage key (`sg.audio`, owned by the
     * audio module) rather than in this panel's `Stored`, because the audio
     * system has to read them before the settings panel exists: the context is
     * built at boot and a player who muted last session must not get one frame
     * of full-volume engines while this panel is still being constructed.
     */
    const secAud = el('div', 'sgset-sec', grid)
    el('div', 'sgset-sec__title', secAud, 'Audio')
    this.volMaster = makeSlider(secAud, 'sgset-vol-master', 'Master', (v) => {
      this.onVolumeChange({ master: v })
    })
    this.volMusic = makeSlider(secAud, 'sgset-vol-music', 'Music', (v) => {
      this.onVolumeChange({ music: v })
    })
    this.volSfx = makeSlider(secAud, 'sgset-vol-sfx', 'Effects', (v) => {
      this.onVolumeChange({ sfx: v })
    })
    this.volVo = makeSlider(secAud, 'sgset-vol-vo', 'Voice', (v) => {
      this.onVolumeChange({ vo: v })
    })
    makeSeg<'on' | 'off'>(secAud, 'Sound', [
      { id: 'on', label: 'On' }, { id: 'off', label: 'Muted' },
    ], (v) => { this.onVolumeChange({ muted: v === 'off' }) })

    // --- Graphics ---------------------------------------------------------
    const secGfx = el('div', 'sgset-sec', grid)
    el('div', 'sgset-sec__title', secGfx, 'Graphics')

    /**
     * FULLSCREEN. Lives here, above Quality, because it is the first thing a
     * player on a phone wants and the last thing they think to look for.
     *
     * THE ROW SAYS SOMETHING DIFFERENT ON EACH PLATFORM, and that is the whole
     * point of it being three states rather than a switch that sometimes does
     * nothing. iPhone Safari has no Fullscreen API for anything that is not a
     * <video> -- see the header of game/fullscreen.ts -- so on an iPhone the
     * honest answer is Add to Home Screen, which our manifest already answers
     * with "display": "fullscreen". Telling the player that beats a dead
     * switch, and beats the scroll-the-toolbar-away trick, which is not
     * fullscreen and cannot be turned off again.
     */
    this.fsMode = fullscreenMode()
    this.swFull = makeSwitchRow(
      secGfx,
      'Fullscreen',
      this.fsMode === 'available'
        ? 'Fills the screen and hides the browser bars. Works during a race too.'
        : this.fsMode === 'standalone'
          ? 'Already fullscreen: SpaceGen is installed and running without browser bars.'
          : 'Safari on iPhone cannot do this from a web page. Share \u2192 Add to Home '
            + 'Screen, then open SpaceGen from the icon and it runs fullscreen.',
      (on) => {
        if (this.fsMode !== 'available') return
        // The API can refuse -- it wants a real user gesture and a browser may
        // decide this one is too far removed. setFullscreen reports what the
        // state ACTUALLY became, so the switch follows reality rather than
        // the request. sync() re-reads it either way.
        void setFullscreen(on).then(() => this.sync())
      },
    )
    if (this.fsMode !== 'available') {
      this.swFull.input.disabled = true
      this.swFull.row.classList.add('is-locked')
    }
    // Escape, F11, the Android back gesture and the OS can all end fullscreen
    // without going through the switch. Without this the toggle would sit
    // there saying ON while the browser bars are plainly back.
    this.offFsChange = onFullscreenChange(() => this.sync())

    const qRow = el('div', 'sgset-row', secGfx)
    const qTxt = el('div', 'sgset-row__txt', qRow)
    el('div', 'sgset-row__k', qTxt, 'Quality')
    el('div', 'sgset-row__sub', qTxt, 'Shadows, particles, scenery and post effects.')
    this.qualitySeg = makeSeg<QualityTier>(qRow, 'Graphics quality', QUALITIES, (v) => {
      this.quality = v
      this.onQualityChange(v)
      this.persist()
      this.sync()
    })
    el(
      'div',
      'sgset-note',
      secGfx,
      'Quality also adapts on its own: if the frame rate drops the game steps down a tier to keep the race smooth.',
    )

    // --- How hard the picture is to read ---------------------------------
    // Deliberately NOT part of Quality. Quality is what the device can
    // afford; these two are what the player can stand to look at, and the
    // strongest machine in the world can still want the glare down.
    //
    // Stacked rows: four steps plus a label do not fit side by side in a
    // 300px column, and a full-width segment gives a phone four fat targets
    // instead of four narrow ones.
    const glareRow = el('div', 'sgset-row sgset-row--stack', secGfx)
    const glTxt = el('div', 'sgset-row__txt', glareRow)
    el('div', 'sgset-row__k', glTxt, 'Glare')
    el(
      'div',
      'sgset-row__sub',
      glTxt,
      'How far bright light spills over everything around it — boost flames, ' +
        'sparks, sun. Turn it down if the track disappears into the white.',
    )
    this.glareSeg = makeSeg<FxLevel>(glareRow, 'Glare', FX_LEVELS, (v) => {
      this.glareLevel = v
      this.emitVfx()
      this.persist()
      this.sync()
    })

    const screenRow = el('div', 'sgset-row sgset-row--stack', secGfx)
    const scTxt = el('div', 'sgset-row__txt', screenRow)
    el('div', 'sgset-row__k', scTxt, 'Speed effects')
    el(
      'div',
      'sgset-row__sub',
      scTxt,
      'Blur, streaks, colour fringing and the shudder of a hit, laid over the ' +
        'whole picture. Turn it down if fast corners feel smeared.',
    )
    this.screenSeg = makeSeg<FxLevel>(screenRow, 'Speed effects', FX_LEVELS, (v) => {
      this.screenLevel = v
      this.emitVfx()
      this.persist()
      this.sync()
    })

    // In this section for the same reason the two above are: it is not about
    // what the machine can afford, it is about what the player can stand to
    // have laid over the road. Text on the racing line is the same failure as
    // glare on the racing line, so it gets the same kind of control.
    const callRow = el('div', 'sgset-row sgset-row--stack', secGfx)
    const caTxt = el('div', 'sgset-row__txt', callRow)
    el('div', 'sgset-row__k', caTxt, 'Callouts')
    el(
      'div',
      'sgset-row__sub',
      caTxt,
      'Short lines of encouragement over the top of the track when you bank a ' +
        'drift tier, take a place or land a jump. Key only keeps the ones that ' +
        'change a race — the lead, an overtake, a chain — plus a Nova or ' +
        'Singularity release, and drops everything below.',
    )
    this.calloutSeg = makeSeg<CalloutLevel>(callRow, 'Callouts', CALLOUT_LEVELS, (v) => {
      this.calloutLevel = v
      this.onCalloutChange(v)
      this.persist()
      this.sync()
    })

    this.fxNote = el('div', 'sgset-note', secGfx)

    // --- Key bindings (desktop only) --------------------------------------
    // Outside the column block: it is one wide list, not a card.
    const secBind = el('div', 'sgset-sec', setPanel)
    this.bindSection = secBind
    const bindHead = el('div', 'sgset-row', secBind)
    bindHead.style.borderTop = '0'
    const bTxt = el('div', 'sgset-row__txt', bindHead)
    el('div', 'sgset-sec__title', bTxt, 'Key bindings')
    el('div', 'sgset-row__sub', bTxt, 'Pick a key to rebind it. Escape cancels.')
    const resetBtn = btn('sgset-mini', bindHead, 'Reset to defaults')
    onPress(resetBtn, () => {
      this.endCapture()
      input.resetKeyMap()
      this.sync()
      this.flash(resetBtn, 'Reset')
    })

    const bindGrid = el('div', 'sgset-binds', secBind)
    for (let i = 0; i < BIND_ROWS.length; i++) {
      const r = BIND_ROWS[i]
      const row = el('div', 'sgset-bind', bindGrid)
      el('div', 'sgset-bind__k', row, r.label)
      const slots = el('div', 'sgset-bind__slots', row)
      for (let s = 0; s < 2; s++) {
        const b = btn('sgset-cap', slots, '—')
        b.setAttribute('aria-label', r.label + ' binding ' + String(s + 1))
        b.addEventListener('pointerup', (ev) => {
          if ((ev as PointerEvent).button !== 0) return
          this.beginCapture(r.action, s, b)
        })
        b.addEventListener('keydown', (ev) => {
          const e = ev as KeyboardEvent
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault()
            e.stopPropagation()
            this.beginCapture(r.action, s, b)
          }
        })
        this.bindSlots.push({ action: r.action, slot: s, b })
      }
      const extra = el('span', 'sgset-cap sgset-cap--static', slots, '')
      extra.hidden = true
      this.bindExtra.set(r.action, extra)
    }

    // =====================================================================
    // CONTROLS TAB
    // =====================================================================
    const bar = el('div', 'sgset-bar', ctlPanel)
    el('div', 'sgset-bar__k', bar, 'Showing')
    this.diagramSeg = makeSeg<DiagramId>(
      bar,
      'Which controls to show',
      [
        { id: 'keyboard', label: 'Keyboard' },
        { id: 'touch', label: 'Touch' },
      ],
      (v) => {
        this.diagramMode = v
        this.diagram = v
        this.persist()
        this.sync()
      },
    )
    this.autoTag = el('div', 'sgset-bar__auto', bar, 'Detected from your device.')

    // --- keyboard view ----------------------------------------------------
    this.kbView = el('div', 'sgset__panel', ctlPanel)

    const kb = el('div', 'sgset-kb', this.kbView)
    kb.setAttribute('aria-hidden', 'true')
    const kbMain = el('div', 'sgset-kb__main', kb)
    for (let r = 0; r < KB_ROWS.length; r++) {
      const rowEl = el('div', 'sgset-kb__row', kbMain)
      this.buildCaps(KB_ROWS[r], rowEl)
    }
    const kbArrows = el('div', 'sgset-kb__arrows', kb)
    for (let r = 0; r < ARROW_ROWS.length; r++) {
      const rowEl = el('div', 'sgset-kb__row', kbArrows)
      this.buildCaps(ARROW_ROWS[r], rowEl)
    }

    const leg = el('div', 'sgset-leg', this.kbView)
    for (let i = 0; i < ACTS.length; i++) {
      const a = ACTS[i]
      const item = el('div', 'sgset-leg__i', leg)
      const sw = el('span', 'sgset-leg__sw', item)
      sw.style.setProperty('--c', COLOR[a.id] ?? 'var(--sg-cyan)')
      el('span', 'sgset-leg__n', item, a.name)
    }

    const kbSplit = el('div', 'sgset-split sgset-split--kb', this.kbView)
    const kbActs = el('div', 'sgset-sec sgset-sec--acts', kbSplit)
    el('div', 'sgset-sec__title', kbActs, 'What every action does')
    this.buildActs(kbActs, 'key')

    const padSec = el('div', 'sgset-sec', kbSplit)
    el('div', 'sgset-sec__title', padSec, 'Gamepad')
    const padList = el('div', 'sgset-pad', padSec)
    for (let i = 0; i < PAD_ROWS.length; i++) {
      el('span', 'sgset-pad__b', padList, PAD_ROWS[i][0])
      el('span', 'sgset-pad__a', padList, PAD_ROWS[i][1])
    }
    el(
      'div',
      'sgset-note',
      padSec,
      'Any pad works. Pick one up mid-race and the game switches to it on the first button press; touch a key and it switches back.',
    )

    // --- touch view -------------------------------------------------------
    this.touchView = el('div', 'sgset__panel', ctlPanel)

    const tBar = el('div', 'sgset-bar', this.touchView)
    el('div', 'sgset-bar__k', tBar, 'Scheme')
    this.previewSeg = makeSeg<TouchScheme>(
      tBar,
      'Touch scheme shown in the diagram',
      TOUCH_SCHEMES,
      (v) => {
        this.preview = v
        this.persist()
        this.sync()
      },
    )

    const tSplit = el('div', 'sgset-split sgset-split--touch', this.touchView)
    const phoneWrap = el('div', '', tSplit)
    this.phone = this.buildPhone(phoneWrap)
    this.phoneNote = el('div', 'sgset-note', phoneWrap)

    const tActs = el('div', 'sgset-sec sgset-sec--acts', tSplit)
    el('div', 'sgset-sec__title', tActs, 'What every action does')
    this.buildActs(tActs, 'touch')

    // ---- go --------------------------------------------------------------
    this.root.dataset.rm = this.reducedMotion ? 'on' : 'off'
    this.restoreToHost()
    this.sync()
    container.appendChild(root)
  }

  // -------------------------------------------------------------------------
  // Construction helpers
  // -------------------------------------------------------------------------

  private buildCaps(row: Cap[], parent: HTMLElement): void {
    for (let i = 0; i < row.length; i++) {
      const c = row[i]
      // slot carries the width (and half a gap of padding); the child is the
      // visible cap, so every row measures exactly 15 units across.
      const slot = el('div', c.code ? 'sgset-key' : 'sgset-key sgset-key--void', parent)
      slot.style.setProperty('--u', String(c.u))
      const k = el('div', 'sgset-key__c', slot, c.label)
      if (!c.code) continue
      const list = this.caps.get(c.code)
      if (list) list.push(k)
      else this.caps.set(c.code, [k])
    }
  }

  private buildActs(parent: HTMLElement, mode: 'key' | 'touch'): void {
    const wrap = el('div', 'sgset-acts', parent)
    const head = el('div', 'sgset-act sgset-act--head', wrap)
    el('span', 'sgset-act__sw', head).style.setProperty('--c', 'transparent')
    el('span', 'sgset-act__n', head, 'Action')
    el('span', 'sgset-act__c', head, mode === 'key' ? 'Keys' : 'Touch')
    el('span', 'sgset-act__d', head, 'What it does')
    for (let i = 0; i < ACTS.length; i++) {
      const a = ACTS[i]
      const row = el('div', 'sgset-act', wrap)
      const sw = el('span', 'sgset-act__sw', row)
      sw.style.setProperty('--c', COLOR[a.id] ?? 'var(--sg-cyan)')
      el('span', 'sgset-act__n', row, a.name)
      const c = el(
        'span',
        mode === 'key' ? 'sgset-act__c' : 'sgset-act__c sgset-act__c--touch',
        row,
        mode === 'key' ? '' : a.touch,
      )
      if (mode === 'key') this.actKeyCells.set(a.id, c)
      else this.actTouchCells.set(a.id, c)
      el('span', 'sgset-act__d', row, a.desc)
    }
  }

  private buildPhone(parent: HTMLElement): HTMLElement {
    const phone = el('div', 'sgset-phone', parent)
    phone.setAttribute('aria-hidden', 'true')
    phone.dataset.scheme = 'tilt'
    phone.dataset.accel = 'auto'
    const screen = el('div', 'sgset-phone__screen', phone)
    el('div', 'sgset-phone__cam', phone)

    const zone = (cls: string, label: string): void => {
      el('div', 'sgset-z ' + cls, screen, label)
    }
    zone('sgset-z--drift', 'DRIFT')
    zone('sgset-z--gas', 'GAS')
    zone('sgset-z--item', 'ITEM')
    zone('sgset-z--brake', 'BRAKE')
    zone('sgset-z--back', 'BACK')
    zone('sgset-z--look', 'LOOK')
    zone('sgset-z--lift', 'LIFT')
    zone('sgset-z--arrowL', '◀')
    zone('sgset-z--arrowR', '▶')
    zone('sgset-z--cal', 'RE-CENTRE')

    const stick = el('div', 'sgset-phone__stick', screen)
    el('div', 'sgset-phone__stickTxt', stick, 'STICK — TOUCH DOWN ANYWHERE IN HERE')
    el('div', 'sgset-phone__knob', stick)

    el('div', 'sgset-phone__tiltbar', screen)

    const tilt = el('div', 'sgset-phone__tilt', screen)
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 48 30')
    svg.setAttribute('class', 'sgset-phone__tiltIcon')
    svg.setAttribute('fill', 'none')
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    p.setAttribute('d', 'M6 22 A20 20 0 0 1 42 22')
    p.setAttribute('stroke', 'currentColor')
    p.setAttribute('stroke-width', '3')
    p.setAttribute('stroke-linecap', 'round')
    svg.appendChild(p)
    const a1 = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    a1.setAttribute('d', 'M10 15 L6 22 L1.5 16')
    a1.setAttribute('stroke', 'currentColor')
    a1.setAttribute('stroke-width', '3')
    a1.setAttribute('stroke-linecap', 'round')
    a1.setAttribute('stroke-linejoin', 'round')
    svg.appendChild(a1)
    const a2 = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    a2.setAttribute('d', 'M38 15 L42 22 L46.5 16')
    a2.setAttribute('stroke', 'currentColor')
    a2.setAttribute('stroke-width', '3')
    a2.setAttribute('stroke-linecap', 'round')
    a2.setAttribute('stroke-linejoin', 'round')
    svg.appendChild(a2)
    tilt.appendChild(svg)
    el('div', 'sgset-phone__tiltTxt', tilt, 'Roll the device to steer')

    return phone
  }

  // -------------------------------------------------------------------------
  // Visual intensity
  // -------------------------------------------------------------------------

  /** What the Glare control is actually set to right now. */
  private effGlare(): FxLevel {
    if (this.glareLevel !== null) return this.glareLevel
    return this.reducedMotion ? FX_RM_GLARE : 'full'
  }

  /** What the Speed effects control is actually set to right now. */
  private effScreen(): FxLevel {
    if (this.screenLevel !== null) return this.screenLevel
    return this.reducedMotion ? FX_RM_SCREEN : 'full'
  }

  /**
   * What the Callouts control is actually set to. Unlike the two effect
   * controls this does NOT drop a step under reduced motion: the callouts have
   * no motion to reduce (cheer.ts fades them and nothing else), and silently
   * withholding praise from a player who asked for less movement would be
   * answering a question they did not ask.
   */
  private effCallouts(): CalloutLevel {
    return this.calloutLevel ?? 'full'
  }

  /**
   * Hand the renderer the pair. Safe to call as often as we like — PostFx
   * treats it as four number writes — so it goes out on every change rather
   * than being batched or deferred to a close.
   */
  private emitVfx(): void {
    this.onVfxIntensityChange(FX_VALUE[this.effGlare()], FX_VALUE[this.effScreen()])
  }

  /**
   * Push anything we persisted ourselves back into the systems that own it.
   * Input-side settings apply now; quality and reduced motion go through the
   * host callbacks, which are wired synchronously after this constructor
   * returns — so they are flushed on the microtask right after.
   */
  private restoreToHost(): void {
    const s = this.stored
    if (s.tiltInvert === true) this.host.input.setTiltInvert(true)
    if (s.oneHandedSide && this.host.input.oneHanded) {
      this.host.input.setOneHanded(true, s.oneHandedSide)
    }
    const wantQ = isQuality(s.quality) ? s.quality : null
    const wantRM = typeof s.reducedMotion === 'boolean' ? s.reducedMotion : null
    queueMicrotask((): void => {
      if (this.disposed) return
      if (wantQ !== null && wantQ !== this.host.getQuality()) this.onQualityChange(wantQ)
      if (wantRM !== null && wantRM !== this.host.getReducedMotion()) {
        this.onReducedMotionChange(wantRM)
      }
      // Always, even with nothing stored: on a reduced-motion device the
      // default is not the renderer's default, and the very first race has to
      // start at the level the panel is showing rather than at Full.
      this.emitVfx()
      this.onCalloutChange(this.effCallouts())
      // Always, even with nothing stored: the rig has to be in force before
      // the first frame, and ChaseCamera's own default is the authored one
      // only until someone has dialled something in.
      this.onCameraChange(this.camera)
    })
  }

  // -------------------------------------------------------------------------
  // State -> DOM. Called after every change; never reads layout.
  // -------------------------------------------------------------------------

  private sync(): void {
    const input = this.host.input
    const scheme = input.scheme
    const touch = input.isTouch

    // --- camera -----------------------------------------------------------
    for (const { key, st } of this.camSteppers) st.set(this.camera[key])
    // The reset is dead while nothing has moved, so the row reads as state
    // rather than as a button that might do something.
    const stock = (Object.keys(DEFAULT_CAMERA_SETTINGS) as (keyof CameraSettings)[])
      .every((k) => this.camera[k] === DEFAULT_CAMERA_SETTINGS[k])
    this.camReset.setAttribute('aria-disabled', stock ? 'true' : 'false')

    // --- tabs -------------------------------------------------------------
    this.tabBtns.forEach((b, id) => {
      const on = id === this.tab
      b.setAttribute('aria-selected', on ? 'true' : 'false')
      b.tabIndex = on ? 0 : -1
    })
    this.panels.forEach((p, id) => {
      p.hidden = id !== this.tab
    })

    // --- scheme -----------------------------------------------------------
    this.touchSchemeRow.hidden = !touch
    this.deskSchemeRow.hidden = touch
    if (isTouchScheme(scheme)) this.touchSeg.set(scheme)
    this.deskSeg.set(scheme)
    const pad = input.hasGamepad
    this.padPill.textContent = pad ? 'Connected' : 'Press a button'
    this.padPill.classList.toggle('is-on', pad)

    // --- driving ----------------------------------------------------------
    this.swAuto.set(input.autoAccelerate)
    this.swInvert.set(this.tiltInvert)
    const tiltOn = scheme === 'tilt'
    for (let i = 0; i < this.tiltRows.length; i++) this.tiltRows[i].hidden = !tiltOn

    // --- accessibility ----------------------------------------------------
    this.swRM.set(this.reducedMotion)
    this.swFull.set(this.fsMode === 'standalone' ? true : isFullscreen())
    this.swOne.set(input.oneHanded)
    this.sideSeg.set(this.oneHandedSide)
    this.sideRow.classList.toggle('is-off', !input.oneHanded)
    this.sideSeg.buttons.forEach((b) => {
      b.setAttribute('aria-disabled', input.oneHanded ? 'false' : 'true')
    })
    this.swHap.set(input.haptics)

    // --- graphics ---------------------------------------------------------
    // The LIVE tier, not this.quality: the adaptive scaler steps the game down
    // on its own and never tells this panel, so a player who was auto-dropped
    // to Low was being shown the tier they picked instead of the one running.
    // this.quality stays the persisted preference, restored on the next load.
    const liveTier = this.host.getQuality()
    this.qualitySeg.set(liveTier)
    this.glareSeg.set(this.effGlare())
    this.screenSeg.set(this.effScreen())
    this.calloutSeg.set(this.effCallouts())
    // Low builds no post chain at all, so say so rather than letting two
    // controls silently do nothing.
    this.fxNote.textContent =
      liveTier === 'low'
        ? 'Low quality skips these effects entirely, so these two do nothing until quality goes back up.'
        : 'Glare off also removes the bloom pass from the chain — the cheapest the game ever draws.'

    // --- bindings ---------------------------------------------------------
    this.bindSection.hidden = touch
    this.syncBindings()

    // --- controls tab -----------------------------------------------------
    this.diagram = this.diagramMode === 'auto' ? this.detectDiagram() : this.diagramMode
    this.diagramSeg.set(this.diagram)
    this.autoTag.hidden = this.diagramMode !== 'auto'
    this.kbView.hidden = this.diagram !== 'keyboard'
    this.touchView.hidden = this.diagram !== 'touch'
    this.previewSeg.set(this.preview)
    this.phone.dataset.scheme = this.preview
    this.phone.dataset.accel = input.autoAccelerate ? 'auto' : 'manual'
    this.phoneNote.textContent = PHONE_NOTE[this.preview]
  }

  /** Which diagram matches the device, when the player has not overridden it. */
  private detectDiagram(): DiagramId {
    const input = this.host.input
    if (isTouchScheme(input.scheme)) return 'touch'
    if (input.scheme === 'keyboard' || input.scheme === 'gamepad') return 'keyboard'
    return input.isTouch ? 'touch' : 'keyboard'
  }

  private syncBindings(): void {
    const map = this.host.input.getKeyMap()

    // slots
    for (let i = 0; i < this.bindSlots.length; i++) {
      const s = this.bindSlots[i]
      if (s.b === this.capturingBtn) continue
      const code = map[s.action][s.slot]
      s.b.textContent = code ? keyLabel(code) : '—'
      s.b.classList.toggle('is-empty', !code)
    }
    this.bindExtra.forEach((node, action) => {
      const n = map[action].length - 2
      node.hidden = n <= 0
      if (n > 0) node.textContent = '+' + String(n)
    })

    // keyboard diagram
    this.caps.forEach((list) => {
      for (let i = 0; i < list.length; i++) {
        list[i].classList.remove('is-hot')
        list[i].style.removeProperty('--hot')
      }
    })
    const paint = (code: string, colour: string): void => {
      const list = this.caps.get(code)
      if (!list) return
      for (let i = 0; i < list.length; i++) {
        list[i].classList.add('is-hot')
        list[i].style.setProperty('--hot', colour)
      }
    }
    for (const action of Object.keys(ACTION_GROUP) as KeyAction[]) {
      const colour = COLOR[ACTION_GROUP[action]] ?? 'var(--sg-cyan)'
      const codes = map[action]
      for (let i = 0; i < codes.length; i++) paint(codes[i], colour)
    }

    // actions table, keys column
    for (let i = 0; i < ACTS.length; i++) {
      const a = ACTS[i]
      const cell = this.actKeyCells.get(a.id)
      if (!cell) continue
      if (a.keys.length === 0) {
        cell.textContent = a.keyFallback ?? '—'
        continue
      }
      const parts: string[] = []
      for (let k = 0; k < a.keys.length; k++) {
        const codes = map[a.keys[k]]
        for (let c = 0; c < codes.length; c++) {
          const lbl = keyLabel(codes[c])
          if (parts.indexOf(lbl) < 0) parts.push(lbl)
        }
      }
      cell.textContent = parts.join('  /  ')
    }
  }

  private persist(): void {
    this.stored = {
      quality: this.quality,
      reducedMotion: this.reducedMotion,
      tab: this.tab,
      diagram: this.diagramMode,
      preview: this.preview,
      tiltInvert: this.tiltInvert,
      oneHandedSide: this.oneHandedSide,
    }
    // Only once actually chosen. JSON.stringify drops undefined, so an
    // unchosen level stays absent from the record and keeps following the
    // reduced-motion default however many other settings get written.
    if (this.glareLevel !== null) this.stored.glare = this.glareLevel
    if (this.screenLevel !== null) this.stored.screenFx = this.screenLevel
    if (this.calloutLevel !== null) this.stored.callouts = this.calloutLevel
    // Only the keys that differ from the authored rig. A player who has never
    // opened the Camera section stores nothing for it, so a later retune of
    // the defaults reaches them -- which is the whole point of shipping a
    // default rather than a starting value.
    const cam: Partial<CameraSettings> = {}
    for (const k of Object.keys(DEFAULT_CAMERA_SETTINGS) as (keyof CameraSettings)[]) {
      if (this.camera[k] !== DEFAULT_CAMERA_SETTINGS[k]) cam[k] = this.camera[k]
    }
    if (Object.keys(cam).length > 0) this.stored.camera = cam
    save(this.stored)
  }

  private flash(b: HTMLButtonElement, text: string): void {
    const old = b.textContent ?? ''
    if (b.dataset.flashing === '1') return
    b.dataset.flashing = '1'
    b.textContent = text
    window.setTimeout((): void => {
      if (this.disposed) return
      b.textContent = old
      b.dataset.flashing = '0'
    }, 900)
  }

  // -------------------------------------------------------------------------
  // Key capture
  // -------------------------------------------------------------------------

  private beginCapture(action: KeyAction, slot: number, b: HTMLButtonElement): void {
    this.endCapture()
    this.capturingBtn = b
    b.classList.add('is-capturing')
    b.classList.remove('is-empty')
    b.textContent = 'Press a key…'
    b.focus()
    this.capturing = this.host.input.captureKey((code: string): void => {
      this.capturing = null
      this.capturingBtn = null
      b.classList.remove('is-capturing')
      this.applyBinding(action, slot, code)
      this.syncBindings()
      b.focus()
    })
  }

  private endCapture(): void {
    if (this.capturing) {
      this.capturing()
      this.capturing = null
    }
    const b = this.capturingBtn
    this.capturingBtn = null
    if (b) {
      b.classList.remove('is-capturing')
      this.syncBindings()
    }
  }

  private applyBinding(action: KeyAction, slot: number, code: string): void {
    const cur = this.host.input.getKeyMap()[action]
    const next: string[] = []
    const n = Math.max(cur.length, slot + 1)
    for (let i = 0; i < n; i++) {
      const v = i === slot ? code : cur[i] ?? ''
      if (!v) continue
      if (i !== slot && v === code) continue // no duplicate inside one action
      next.push(v)
    }
    this.host.input.setKeyBinding(action, next.length > 0 ? next : DEFAULT_KEYMAP[action].slice())
  }

  // -------------------------------------------------------------------------
  // Keyboard handling — focus trap, Escape, tab arrows
  // -------------------------------------------------------------------------

  private onKeyDown = (ev: Event): void => {
    const e = ev as KeyboardEvent

    // While capturing a binding, only Escape is ours; everything else has to
    // reach the InputManager's window listener untouched.
    if (this.capturing) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        this.endCapture()
      }
      return
    }

    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      this.close()
      return
    }

    if (e.key !== 'Tab') return
    const list = this.focusables()
    if (list.length === 0) return
    e.preventDefault()
    e.stopPropagation()
    const active = document.activeElement
    let i = -1
    for (let n = 0; n < list.length; n++) {
      if (list[n] === active) {
        i = n
        break
      }
    }
    const step = e.shiftKey ? -1 : 1
    const next = i < 0 ? (e.shiftKey ? list.length - 1 : 0) : (i + step + list.length) % list.length
    list[next].focus()
  }

  private onTabKey = (ev: Event): void => {
    const e = ev as KeyboardEvent
    const order: TabId[] = ['settings', 'controls']
    let d = 0
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') d = 1
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') d = -1
    else if (e.key === 'Home') d = -99
    else if (e.key === 'End') d = 99
    else return
    e.preventDefault()
    e.stopPropagation()
    let i = order.indexOf(this.tab)
    if (d === -99) i = 0
    else if (d === 99) i = order.length - 1
    else i = (i + d + order.length) % order.length
    this.setTab(order[i])
    const b = this.tabBtns.get(order[i])
    if (b) b.focus()
  }

  private focusables(): HTMLElement[] {
    const all = this.dialog.querySelectorAll<HTMLElement>(FOCUSABLE)
    const out: HTMLElement[] = []
    for (let i = 0; i < all.length; i++) {
      const n = all[i]
      if (n.hasAttribute('hidden')) continue
      if (n.getAttribute('aria-disabled') === 'true') continue
      if (!isVisible(n)) continue
      out.push(n)
    }
    return out
  }

  private setTab(id: TabId): void {
    if (this.tab === id) return
    this.tab = id
    this.endCapture()
    this.persist()
    this.sync()
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  get isOpen(): boolean {
    return this.openFlag
  }

  open(tab?: TabId): void {
    if (this.disposed) return
    if (tab && tab !== this.tab) {
      this.tab = tab
      this.persist()
    }
    const active = document.activeElement
    this.prevFocus = active instanceof HTMLElement ? active : null
    this.openFlag = true
    this.root.hidden = false
    this.root.classList.add('is-open')
    this.sync()
    // Focus the dialog itself: the label is announced, Tab walks into the
    // content, and no control wears a ring it did not earn.
    this.dialog.focus()
    this.padStart()
  }

  close(): void {
    if (!this.openFlag) return
    this.openFlag = false
    this.endCapture()
    this.root.classList.remove('is-open')
    this.root.hidden = true
    this.padStop()
    const p = this.prevFocus
    this.prevFocus = null
    if (p && p.isConnected) p.focus()
    this.onClose()
  }

  // -------------------------------------------------------------------------
  // Gamepad
  //
  // A pad has to reach every control in here, and the dialog already has a
  // complete keyboard model: Tab walks the trap, arrows step a segmented
  // control or the tab strip, Space/Enter activate, Escape closes or cancels a
  // rebind. So the pad is translated INTO that model rather than given a
  // parallel one — the poller synthesises the key event the same press would
  // have produced and lets the existing handlers do the work. Anything added
  // to this panel later is pad-navigable the moment it is keyboard-navigable,
  // which is the property that stopped being true the last time a control grew
  // its own input path.
  //
  // The synthetic events carry `key` and no `code`, which is exactly what
  // makes them safe to let bubble: InputManager's window listener dispatches
  // on `e.code`, finds '' in neither the bindings nor the pause set, and drops
  // them. Nothing can leave a steering key stuck on behind the modal.
  // -------------------------------------------------------------------------

  private padStart(): void {
    if (this.padTimer !== 0 || typeof window === 'undefined') return
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return
    // Seed the edge state: the A that opened this panel may still be held.
    this.padPrev = this.padBits()
    this.padDir = 0
    this.padRepeat = 0
    this.padTick = 0
    this.padTimer = window.setInterval(this.pollPad, PAD_POLL_MS)
  }

  private padStop(): void {
    if (this.padTimer === 0) return
    window.clearInterval(this.padTimer)
    this.padTimer = 0
  }

  /** Directions + A/B squashed into one bitmask across every connected pad. */
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

  /** Fire a keydown at the focused control, or at the dialog if none is. */
  private padKey(key: string, shift = false): void {
    const active = document.activeElement
    const target =
      active instanceof HTMLElement && this.dialog.contains(active) ? active : this.dialog
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true, cancelable: true }),
    )
  }

  private pollPad = (): void => {
    if (!this.openFlag) return

    // Pads only appear to the page after a button press, so the connected pill
    // has to be re-read while the panel is up. Once a second is plenty; it
    // rides this timer rather than a second one.
    this.padTick++
    if (this.padTick >= PAD_PILL_EVERY) {
      this.padTick = 0
      const pad = this.host.input.hasGamepad
      if (pad !== this.padPill.classList.contains('is-on')) {
        this.padPill.textContent = pad ? 'Connected' : 'Press a button'
        this.padPill.classList.toggle('is-on', pad)
      }
    }

    const bits = this.padBits()
    const rising = bits & ~this.padPrev
    this.padPrev = bits

    // Mid-rebind the panel is waiting on a real keypress from a real keyboard,
    // and a synthetic one would be captured as the new binding. B cancels;
    // everything else on the pad is inert until it is over.
    if (this.capturing) {
      if ((rising & PAD_B) !== 0) this.endCapture()
      this.padDir = 0
      return
    }

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

    if ((rising & PAD_A) !== 0) this.padActivate()
    else if ((rising & PAD_B) !== 0) this.close()
  }

  /**
   * A presses whatever has focus. Every control in this dialog activates on a
   * Space keydown, so that is what A becomes; the click() is a fallback for
   * anything that ignores the key, and cannot double-fire because a control
   * that handled Space called preventDefault and dispatchEvent returned false.
   */
  private padActivate(): void {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !this.dialog.contains(active)) {
      this.focusables()[0]?.focus()
      return
    }
    const ok = active.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
    )
    if (ok) active.click()
  }

  /**
   * Up/down walk the dialog (Tab order); left/right work the control that has
   * focus. That split is what the layout asks for: every row is label-left,
   * control-right, so "along the list" is vertical and "along this control" is
   * horizontal, and it matches what the same presses do on a keyboard.
   */
  private padNudge(dir: number): void {
    if (dir === PAD_U) this.padKey('Tab', true)
    else if (dir === PAD_D) this.padKey('Tab', false)
    else if (dir === PAD_L) this.padKey('ArrowLeft')
    else this.padKey('ArrowRight')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.endCapture()
    this.padStop()
    this.offFsChange?.()
    this.offFsChange = null
    this.dialog.removeEventListener('keydown', this.onKeyDown)
    if (this.root.parentNode === this.container) this.container.removeChild(this.root)
    this.openFlag = false
  }
}

export function createSettingsPanel(
  container: HTMLElement,
  host: SettingsHost,
): SettingsPanel {
  return new SettingsPanelImpl(container, host)
}
