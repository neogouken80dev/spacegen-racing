/**
 * input.ts — the single source of player intent for SpaceGen Racing.
 *
 * Keyboard, gamepad and three touch schemes all collapse into one InputFrame
 * per sim step. Keyboard and mobile are equal citizens here: neither is the
 * "real" control path with the other bolted on.
 *
 * Latency contract: every device handler writes plain scalar fields
 * synchronously. `sample()` reads them, mutates one module-scope frame and
 * returns it — no allocation, no closures, no framework in the path.
 */
import { emptyInput, type InputFrame } from '../sim/types'
import { TUNING } from '../content/tuning'
import { clamp } from '../sim/math'
import {
  createTouchControls, rampAxis, axisCurve, STEER_RAMP,
  type TouchControls, type TouchScheme,
} from './touchControls'

export type ControlScheme = 'keyboard' | 'gamepad' | 'tilt' | 'stick' | 'buttons'

export type KeyAction =
  | 'accelerate' | 'brake' | 'steerLeft' | 'steerRight'
  | 'drift' | 'item' | 'itemBack' | 'lift' | 'lookBack' | 'pause'

/** KeyboardEvent.code lists, so the map is layout independent. */
export type KeyMap = Record<KeyAction, string[]>

export interface InputManager {
  /** Called once per sim step. Allocation-free; the frame is reused. */
  sample(): InputFrame
  scheme: ControlScheme
  setScheme(s: ControlScheme): void
  readonly isTouch: boolean
  setAutoAccelerate(on: boolean): void
  /** Capture the player's current holding angle as tilt-neutral. */
  calibrateTilt(): void
  dispose(): void

  // --- accessibility / options -------------------------------------------
  readonly autoAccelerate: boolean
  setOneHanded(on: boolean, side?: 'left' | 'right'): void
  readonly oneHanded: boolean
  setTiltInvert(on: boolean): void
  setHaptics(on: boolean): void
  readonly haptics: boolean
  /** Show the Lift pad; the race sets this from the local chassis class. */
  setLiftEnabled(on: boolean): void
  /**
   * Show or hide the whole touch control layer without changing the chosen
   * scheme. The finish ceremony uses this: the car is under AI, so leaving a
   * live throttle and a drift button on screen invites the player to press
   * something that does nothing. Restoring it is a single call with `true`,
   * and a non-touch scheme is unaffected either way.
   */
  setPadsVisible(on: boolean): void

  // --- remapping ----------------------------------------------------------
  getKeyMap(): KeyMap
  setKeyBinding(action: KeyAction, codes: string[]): void
  resetKeyMap(): void
  /** Grab the next key press for a remap UI. Returns a cancel function. */
  captureKey(onKey: (code: string) => void): () => void

  // --- misc ---------------------------------------------------------------
  readonly hasGamepad: boolean
  /** True exactly once per Pause press (Escape / Start). */
  consumePause(): boolean
  onPause: (() => void) | null
  vibrate(durationMs: number, strong: number, weak: number): void
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** WASD and the arrow cluster are both live at all times. */
export const DEFAULT_KEYMAP: KeyMap = {
  accelerate: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  steerLeft: ['KeyA', 'ArrowLeft'],
  steerRight: ['KeyD', 'ArrowRight'],
  drift: ['ShiftLeft', 'ShiftRight', 'KeyZ'],
  item: ['Space', 'KeyX'],
  itemBack: ['KeyC'],
  lift: ['KeyE'],
  lookBack: ['KeyQ'],
  pause: ['Escape'],
}

const ACTIONS: KeyAction[] = [
  'accelerate', 'brake', 'steerLeft', 'steerRight',
  'drift', 'item', 'itemBack', 'lift', 'lookBack', 'pause',
]

// Action bits. Pause is edge-triggered and handled outside the mask.
const A_ACC = 1 << 0
const A_BRK = 1 << 1
const A_LEFT = 1 << 2
const A_RIGHT = 1 << 3
const A_DRIFT = 1 << 4
const A_ITEM = 1 << 5
const A_ITEMBACK = 1 << 6
const A_LIFT = 1 << 7
const A_LOOK = 1 << 8

const ACTION_BIT: Record<KeyAction, number> = {
  accelerate: A_ACC,
  brake: A_BRK,
  steerLeft: A_LEFT,
  steerRight: A_RIGHT,
  drift: A_DRIFT,
  item: A_ITEM,
  itemBack: A_ITEMBACK,
  lift: A_LIFT,
  lookBack: A_LOOK,
  pause: 0,
}

/** Keys the page must never act on itself during a race. */
const SWALLOW = new Set<string>([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab',
])

const DT = TUNING.sim.dt

/** Gamepad stick deadzone, with a smooth ramp out of it (see axisCurve). */
const PAD_DEADZONE = 0.12
const PAD_TRIGGER_DEADZONE = 0.05
/** Any axis or button past this counts as "the player picked up the pad". */
const PAD_WAKE = 0.35

/**
 * The sim consumes `item` as a level (race.ts fires whenever it is set), so the
 * manager emits a one-step pulse per press and a slow auto-repeat while held.
 * 0.32s is fast enough to dump a triple charge deliberately, slow enough that a
 * held button never empties a slot by accident.
 */
const ITEM_REPEAT = 0.32

const LS_KEY = 'sgr.input.v1'

// One frame for the whole module. Mutated and returned by every sample().
const FRAME: InputFrame = emptyInput()

// ---------------------------------------------------------------------------
// Storage — every access guarded; localStorage throws in private/partitioned
// contexts and inside some embedded webviews.
// ---------------------------------------------------------------------------

interface Persisted {
  scheme?: ControlScheme
  autoAccel?: boolean
  haptics?: boolean
  tiltInvert?: boolean
  oneHanded?: boolean
  oneHandedSide?: 'left' | 'right'
  keymap?: Partial<Record<string, string[]>>
}

function loadPersisted(): Persisted {
  let raw: string | null = null
  try { raw = localStorage.getItem(LS_KEY) } catch { return {} }
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Persisted
  } catch { return {} }
}

function savePersisted(p: Persisted): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(p)) } catch { /* non-fatal */ }
}

function isEditable(t: EventTarget | null): boolean {
  if (!t || typeof Element === 'undefined' || !(t instanceof Element)) return false
  const tag = t.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return (t as HTMLElement).isContentEditable === true
}

/** Focusable UI, where Tab must keep working for keyboard-only players. */
function isInteractive(t: EventTarget | null): boolean {
  if (!t || typeof Element === 'undefined' || !(t instanceof Element)) return false
  const tag = t.tagName
  if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return true
  if (t.getAttribute('role') === 'button') return true
  const ti = t.getAttribute('tabindex')
  return ti !== null && Number(ti) >= 0
}

function detectTouch(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  const coarse = typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false
  const touchy = (navigator.maxTouchPoints ?? 0) > 0 || 'ontouchstart' in window
  return coarse && touchy
}

function isTouchScheme(s: ControlScheme): s is TouchScheme {
  return s === 'tilt' || s === 'stick' || s === 'buttons'
}

function btnValue(gp: Gamepad, i: number): number {
  const b = gp.buttons[i]
  if (!b) return 0
  const v = typeof b.value === 'number' ? b.value : (b.pressed ? 1 : 0)
  return v > PAD_TRIGGER_DEADZONE ? (v > 1 ? 1 : v) : 0
}

function btnDown(gp: Gamepad, i: number): boolean {
  const b = gp.buttons[i]
  return b ? b.pressed === true : false
}

interface VibrationActuator {
  playEffect?: (type: string, params: {
    duration: number
    strongMagnitude: number
    weakMagnitude: number
    startDelay?: number
  }) => Promise<unknown>
}

/**
 * Published so a tuning UI can show the keyboard steering ramp. A key is a
 * switch and the vehicle needs a wheel: digital steering eases toward full
 * lock over `attackTime` and drops back faster, which is what lets a keyboard
 * player hold a clean drift arc instead of sawing the car in half.
 */
export const KEY_STEER_RAMP = STEER_RAMP

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface Bound { t: EventTarget; k: string; f: EventListener; c: boolean }

class InputManagerImpl implements InputManager {
  readonly isTouch: boolean

  onPause: (() => void) | null = null

  private cur: ControlScheme
  private lastTouchScheme: TouchScheme = 'tilt'
  private readonly touch: TouchControls
  private readonly target: HTMLElement
  private readonly bounds: Bound[] = []
  private disposed = false

  // --- keyboard -----------------------------------------------------------
  private keymap: KeyMap
  private codeBits = new Map<string, number>()
  private pauseCodes = new Set<string>()
  private held = new Set<string>()
  private mask = 0
  private keySteer = 0
  private capture: ((code: string) => void) | null = null

  // --- gamepad ------------------------------------------------------------
  private padIndex = -1
  private padPresent = false
  private padAxis = 0
  private padDigital = 0
  private padDpadSteer = 0
  private padThrottle = 0
  private padBrake = 0
  private padDrift = false
  private padItem = false
  private padBack = false
  private padLift = false
  private padLook = false
  private padStart = false
  private raf = 0

  // --- options ------------------------------------------------------------
  private autoAccel: boolean
  private hapticsOn = true
  private oneHandedOn = false
  private oneHandedSide: 'left' | 'right' = 'right'
  private tiltInvert = false

  // --- edge state ---------------------------------------------------------
  private itemHeldPrev = false
  private itemTimer = 0
  private pausePending = false

  constructor(target: HTMLElement, uiLayer: HTMLElement) {
    this.target = target
    this.isTouch = detectTouch()

    const p = loadPersisted()
    this.keymap = this.mergeKeyMap(p.keymap)
    this.rebuildLookup()

    this.autoAccel = typeof p.autoAccel === 'boolean' ? p.autoAccel : this.isTouch
    this.hapticsOn = typeof p.haptics === 'boolean' ? p.haptics : true
    this.tiltInvert = p.tiltInvert === true
    this.oneHandedOn = p.oneHanded === true
    this.oneHandedSide = p.oneHandedSide === 'left' ? 'left' : 'right'

    this.touch = createTouchControls(uiLayer)
    this.touch.setAutoAccelerate(this.autoAccel)
    this.touch.setTiltInvert(this.tiltInvert)
    this.touch.setOneHanded(this.oneHandedOn, this.oneHandedSide)
    this.touch.onTiltUnavailable = (): void => {
      // Permission denied, or no sensor: drop to the floating stick silently.
      if (isTouchScheme(this.cur)) this.applyScheme('stick', true)
    }
    this.touch.onTouchActivity = (): void => {
      if (this.cur === 'gamepad' || this.cur === 'keyboard') {
        this.applyScheme(this.lastTouchScheme, false)
      }
    }

    // Auto-detect: coarse pointer -> tilt with the on-screen controls up,
    // otherwise keyboard with them hidden.
    const stored = p.scheme
    const initial: ControlScheme = stored && isValidScheme(stored)
      ? stored
      : (this.isTouch ? 'tilt' : 'keyboard')
    this.cur = 'keyboard'
    this.applyScheme(initial, false)

    // Page-level hygiene: no scroll, no zoom, no long-press menu on the canvas.
    target.style.touchAction = 'none'
    if (!target.hasAttribute('tabindex')) target.tabIndex = -1
    this.on(target, 'contextmenu', swallow, { passive: false })
    this.on(target, 'dblclick', swallow, { passive: false })
    this.on(target, 'gesturestart', swallow, { passive: false })
    this.on(target, 'pointerdown', this.onTargetPointer, { passive: false })

    const win = typeof window !== 'undefined' ? window : null
    if (win) {
      this.on(win, 'keydown', this.onKeyDown, { passive: false })
      this.on(win, 'keyup', this.onKeyUp, { passive: false })
      this.on(win, 'blur', this.onBlur)
      this.on(win, 'gamepadconnected', this.onPadConnected)
      this.on(win, 'gamepaddisconnected', this.onPadDisconnected)
      if (typeof win.requestAnimationFrame === 'function') {
        this.raf = win.requestAnimationFrame(this.tick)
      }
      const nav = typeof navigator !== 'undefined' ? navigator : null
      if (nav && typeof nav.getGamepads === 'function') {
        const pads = nav.getGamepads()
        for (let i = 0; i < pads.length; i++) if (pads[i]) { this.padPresent = true; break }
      }
    }
  }

  private on(t: EventTarget, k: string, f: EventListener, opts?: AddEventListenerOptions): void {
    t.addEventListener(k, f, opts)
    this.bounds.push({ t, k, f, c: opts?.capture === true })
  }

  // -------------------------------------------------------------------------
  // Key map
  // -------------------------------------------------------------------------

  private mergeKeyMap(stored: Partial<Record<string, string[]>> | undefined): KeyMap {
    const out = {} as KeyMap
    for (let i = 0; i < ACTIONS.length; i++) {
      const a = ACTIONS[i]
      const def = DEFAULT_KEYMAP[a]
      const s = stored ? stored[a] : undefined
      out[a] = Array.isArray(s) && s.every((c) => typeof c === 'string') && s.length > 0
        ? s.slice()
        : def.slice()
    }
    return out
  }

  private rebuildLookup(): void {
    this.codeBits.clear()
    this.pauseCodes.clear()
    for (let i = 0; i < ACTIONS.length; i++) {
      const a = ACTIONS[i]
      const bit = ACTION_BIT[a]
      const codes = this.keymap[a]
      for (let j = 0; j < codes.length; j++) {
        const c = codes[j]
        if (a === 'pause') { this.pauseCodes.add(c); continue }
        this.codeBits.set(c, (this.codeBits.get(c) ?? 0) | bit)
      }
    }
    this.recomputeMask()
  }

  /** Cheap: only ever runs on a key event, never inside sample(). */
  private recomputeMask(): void {
    let m = 0
    this.held.forEach((c) => { m |= this.codeBits.get(c) ?? 0 })
    this.mask = m
  }

  getKeyMap(): KeyMap {
    const out = {} as KeyMap
    for (let i = 0; i < ACTIONS.length; i++) out[ACTIONS[i]] = this.keymap[ACTIONS[i]].slice()
    return out
  }

  setKeyBinding(action: KeyAction, codes: string[]): void {
    this.keymap[action] = codes.slice()
    this.held.clear()
    this.rebuildLookup()
    this.persist()
  }

  resetKeyMap(): void {
    this.keymap = this.mergeKeyMap(undefined)
    this.held.clear()
    this.rebuildLookup()
    this.persist()
  }

  captureKey(onKey: (code: string) => void): () => void {
    this.capture = onKey
    return (): void => { if (this.capture === onKey) this.capture = null }
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  private onKeyDown = (ev: Event): void => {
    const e = ev as KeyboardEvent
    if (isEditable(e.target)) return
    if (this.capture) {
      e.preventDefault()
      const cb = this.capture
      this.capture = null
      cb(e.code)
      return
    }
    // Arrows and Space must never scroll the page mid-race. Tab is only
    // swallowed when nothing focusable is focused, so a keyboard-only player
    // can still tab through menus and the HUD.
    if (SWALLOW.has(e.code) && (e.code !== 'Tab' || !isInteractive(e.target))) e.preventDefault()
    if (e.repeat) return
    if (this.pauseCodes.has(e.code)) {
      this.pausePending = true
      const cb = this.onPause
      if (cb) cb()
    }
    const bits = this.codeBits.get(e.code)
    if (bits === undefined && !this.pauseCodes.has(e.code)) return
    this.held.add(e.code)
    this.recomputeMask()
    // A pad player who reaches for the keyboard gets the keyboard back. Touch
    // schemes are never stolen by a stray keypress — the controls would vanish.
    if (this.cur === 'gamepad' && bits !== undefined) this.applyScheme('keyboard', false)
  }

  private onKeyUp = (ev: Event): void => {
    const e = ev as KeyboardEvent
    if (SWALLOW.has(e.code) && (e.code !== 'Tab' || !isInteractive(e.target))) e.preventDefault()
    if (this.held.delete(e.code)) this.recomputeMask()
  }

  private onBlur = (): void => {
    this.held.clear()
    this.mask = 0
    this.keySteer = 0
    this.padThrottle = 0
    this.padBrake = 0
    this.padAxis = 0
    this.padDigital = 0
    this.padDrift = false
    this.padItem = false
    this.padBack = false
    this.padLift = false
    this.padLook = false
  }

  private onTargetPointer = (ev: Event): void => {
    const e = ev as PointerEvent
    // First real gesture: the only moment iOS will let us ask for the sensor.
    if (this.cur === 'tilt' && !this.touch.tiltActive) this.touch.requestTiltPermission(true)
    if (e.pointerType === 'touch' && this.isTouch && !isTouchScheme(this.cur)) {
      this.applyScheme(this.lastTouchScheme, false)
    }
  }

  // -------------------------------------------------------------------------
  // Gamepad — polled on rAF so sample() stays allocation-free
  // (navigator.getGamepads() builds a fresh array on every call).
  // -------------------------------------------------------------------------

  private onPadConnected = (): void => { this.padPresent = true }

  private onPadDisconnected = (ev: Event): void => {
    const e = ev as GamepadEvent
    if (e.gamepad && e.gamepad.index === this.padIndex) this.padIndex = -1
    const nav = typeof navigator !== 'undefined' ? navigator : null
    let any = false
    if (nav && typeof nav.getGamepads === 'function') {
      const pads = nav.getGamepads()
      for (let i = 0; i < pads.length; i++) if (pads[i]) { any = true; break }
    }
    this.padPresent = any
    if (!any) {
      this.onBlur()
      if (this.cur === 'gamepad') {
        this.applyScheme(this.isTouch ? this.lastTouchScheme : 'keyboard', false)
      }
    }
  }

  private tick = (): void => {
    if (this.disposed) return
    this.raf = window.requestAnimationFrame(this.tick)
    this.pollPad()
  }

  private pollPad(): void {
    const nav = typeof navigator !== 'undefined' ? navigator : null
    if (!nav || typeof nav.getGamepads !== 'function') return
    const pads = nav.getGamepads()
    let gp: Gamepad | null = this.padIndex >= 0 ? pads[this.padIndex] ?? null : null
    if (!gp || !gp.connected) {
      gp = null
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i]
        if (p && p.connected) { gp = p; this.padIndex = i; break }
      }
    }
    if (!gp) { this.padIndex = -1; return }
    this.padPresent = true

    const rawX = gp.axes.length > 0 ? gp.axes[0] : 0
    const rawY = gp.axes.length > 1 ? gp.axes[1] : 0
    this.padAxis = axisCurve(rawX, PAD_DEADZONE)

    const dLeft = btnDown(gp, 14)
    const dRight = btnDown(gp, 15)
    this.padDigital = (dLeft ? -1 : 0) + (dRight ? 1 : 0)

    this.padThrottle = btnValue(gp, 7)   // RT
    this.padBrake = btnValue(gp, 6)      // LT
    this.padDrift = btnDown(gp, 0)       // A / Cross
    this.padItem = btnDown(gp, 2)        // X / Square
    this.padLift = btnDown(gp, 4)        // LB
    this.padLook = btnDown(gp, 11)       // R3
    // "Aim behind" modifier: stick down, or the d-pad down.
    this.padBack = rawY > 0.5 || btnDown(gp, 13)

    const start = btnDown(gp, 9)         // Start / Options
    if (start && !this.padStart) {
      this.pausePending = true
      const cb = this.onPause
      if (cb) cb()
    }
    this.padStart = start

    if (this.cur !== 'gamepad') {
      let woke = this.padThrottle > 0.25 || this.padBrake > 0.25
      if (!woke) {
        for (let i = 0; i < gp.axes.length && i < 4; i++) {
          const a = gp.axes[i]
          if (a > PAD_WAKE || a < -PAD_WAKE) { woke = true; break }
        }
      }
      if (!woke) {
        for (let i = 0; i < gp.buttons.length; i++) {
          if (btnDown(gp, i)) { woke = true; break }
        }
      }
      if (woke) this.applyScheme('gamepad', false)
    }
  }

  vibrate(durationMs: number, strong: number, weak: number): void {
    if (!this.hapticsOn || this.padIndex < 0) return
    const nav = typeof navigator !== 'undefined' ? navigator : null
    if (!nav || typeof nav.getGamepads !== 'function') return
    const gp = nav.getGamepads()[this.padIndex]
    if (!gp) return
    const act = (gp as unknown as { vibrationActuator?: VibrationActuator }).vibrationActuator
    if (!act || typeof act.playEffect !== 'function') return
    act.playEffect('dual-rumble', {
      duration: durationMs,
      strongMagnitude: clamp(strong, 0, 1),
      weakMagnitude: clamp(weak, 0, 1),
      startDelay: 0,
    }).catch((): void => { /* not every actuator honours dual-rumble */ })
  }

  // -------------------------------------------------------------------------
  // Sampling
  // -------------------------------------------------------------------------

  sample(): InputFrame {
    const f = FRAME
    f.steer = 0
    f.throttle = 0
    f.brake = 0
    f.drift = false
    f.item = false
    f.itemBack = false
    f.lift = false
    f.lookBack = false

    // The keyboard ramp advances every step whatever the active scheme, so
    // swapping devices mid-race never leaves a wheel stuck at half lock.
    const kt = ((this.mask & A_LEFT) !== 0 ? -1 : 0) + ((this.mask & A_RIGHT) !== 0 ? 1 : 0)
    this.keySteer = rampAxis(this.keySteer, kt, DT)

    switch (this.cur) {
      case 'keyboard': this.readKeyboard(f); break
      case 'gamepad': this.readPad(f); break
      default: this.touch.sample(f); break
    }

    // race.ts fires an item whenever `item` is set, so convert the held level
    // into a single-step pulse with a slow auto-repeat.
    if (f.item) {
      if (!this.itemHeldPrev) {
        this.itemHeldPrev = true
        this.itemTimer = ITEM_REPEAT
      } else {
        this.itemTimer -= DT
        if (this.itemTimer <= 0) this.itemTimer = ITEM_REPEAT
        else f.item = false
      }
    } else {
      this.itemHeldPrev = false
    }

    if (this.autoAccel && f.brake < 0.15 && f.throttle < 1) f.throttle = 1

    f.steer = clamp(f.steer, -1, 1)
    f.throttle = clamp(f.throttle, 0, 1)
    f.brake = clamp(f.brake, 0, 1)
    return f
  }

  private readKeyboard(f: InputFrame): void {
    const m = this.mask
    f.steer = this.keySteer
    f.throttle = (m & A_ACC) !== 0 ? 1 : 0
    f.brake = (m & A_BRK) !== 0 ? 1 : 0
    f.drift = (m & A_DRIFT) !== 0
    f.item = (m & A_ITEM) !== 0 || (m & A_ITEMBACK) !== 0
    // Backward: the dedicated key, or brake + item held together.
    f.itemBack = (m & A_ITEMBACK) !== 0 || ((m & A_ITEM) !== 0 && (m & A_BRK) !== 0)
    f.lift = (m & A_LIFT) !== 0
    f.lookBack = (m & A_LOOK) !== 0
  }

  private readPad(f: InputFrame): void {
    let steer: number
    if (this.padAxis !== 0) {
      this.padDpadSteer = 0
      steer = this.padAxis
    } else {
      this.padDpadSteer = rampAxis(this.padDpadSteer, this.padDigital, DT)
      steer = this.padDpadSteer
    }
    f.steer = steer
    f.throttle = this.padThrottle
    f.brake = this.padBrake
    f.drift = this.padDrift
    f.item = this.padItem
    f.itemBack = this.padItem && (this.padBack || this.padBrake > 0.5)
    f.lift = this.padLift
    f.lookBack = this.padLook
  }

  consumePause(): boolean {
    if (!this.pausePending) return false
    this.pausePending = false
    return true
  }

  // -------------------------------------------------------------------------
  // Scheme + options
  // -------------------------------------------------------------------------

  get scheme(): ControlScheme { return this.cur }
  set scheme(s: ControlScheme) { this.applyScheme(s, true) }
  setScheme(s: ControlScheme): void { this.applyScheme(s, true) }

  private lastNonPad: ControlScheme = 'keyboard'

  private applyScheme(s: ControlScheme, persist: boolean): void {
    if (!isValidScheme(s)) return
    if (this.cur !== s) {
      this.cur = s
      if (s !== 'gamepad') this.lastNonPad = s
      if (isTouchScheme(s)) {
        this.lastTouchScheme = s
        this.touch.setScheme(s)
        this.touch.setVisible(true)
      } else {
        this.touch.setVisible(false)
      }
      this.keySteer = 0
      this.padDpadSteer = 0
    }
    if (persist) this.persist()
  }

  get autoAccelerate(): boolean { return this.autoAccel }

  setAutoAccelerate(on: boolean): void {
    this.autoAccel = on
    this.touch.setAutoAccelerate(on)
    this.persist()
  }

  get oneHanded(): boolean { return this.oneHandedOn }

  setOneHanded(on: boolean, side?: 'left' | 'right'): void {
    this.oneHandedOn = on
    if (side) this.oneHandedSide = side
    this.touch.setOneHanded(on, this.oneHandedSide)
    this.persist()
  }

  setTiltInvert(on: boolean): void {
    this.tiltInvert = on
    this.touch.setTiltInvert(on)
    this.persist()
  }

  get haptics(): boolean { return this.hapticsOn }

  setHaptics(on: boolean): void {
    this.hapticsOn = on
    this.persist()
  }

  setLiftEnabled(on: boolean): void { this.touch.setLiftEnabled(on) }

  setPadsVisible(on: boolean): void {
    this.touch.setVisible(on && isTouchScheme(this.cur))
  }

  calibrateTilt(): void { this.touch.calibrateTilt() }

  get hasGamepad(): boolean { return this.padPresent }

  private persist(): void {
    savePersisted({
      scheme: this.cur === 'gamepad' ? this.lastNonPad : this.cur,
      autoAccel: this.autoAccel,
      haptics: this.hapticsOn,
      tiltInvert: this.tiltInvert,
      oneHanded: this.oneHandedOn,
      oneHandedSide: this.oneHandedSide,
      keymap: this.keymap,
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.raf && typeof window !== 'undefined') window.cancelAnimationFrame(this.raf)
    this.raf = 0
    for (let i = 0; i < this.bounds.length; i++) {
      const b = this.bounds[i]
      b.t.removeEventListener(b.k, b.f, b.c)
    }
    this.bounds.length = 0
    this.held.clear()
    this.capture = null
    this.onPause = null
    this.touch.dispose()
    this.target.style.touchAction = ''
  }
}

function swallow(e: Event): void {
  if (e.cancelable) e.preventDefault()
}

function isValidScheme(s: string): s is ControlScheme {
  return s === 'keyboard' || s === 'gamepad' || s === 'tilt' || s === 'stick' || s === 'buttons'
}

/**
 * @param target  the render canvas — gesture suppression and the touch/gamepad
 *                hand-back tap live here.
 * @param uiLayer the DOM layer the on-screen controls are appended to.
 */
export function createInput(target: HTMLElement, uiLayer: HTMLElement): InputManager {
  return new InputManagerImpl(target, uiLayer)
}
