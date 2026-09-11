/**
 * touchControls.ts — on-screen touch controls for SpaceGen Racing.
 *
 * Three player-selectable schemes, all of which keep Drift, Brake and Item as
 * chunky thumb-reachable buttons on the right edge:
 *
 *   'tilt'    device-orientation steering (default on phones)
 *   'stick'   floating virtual stick on the left half, origin set on touchdown
 *   'buttons' discrete left/right arrow pads plus explicit throttle/brake pads
 *
 * BRAKE IS NEVER TAKEN AWAY. Auto-accelerate is the default on a phone and it
 * means "you do not have to hold the gas", not "you cannot slow down", so the
 * Brake pad is on screen in every scheme and in both throttle modes. Gas is the
 * only conditional pad: with auto on it would do nothing the game is not
 * already doing for the player.
 *
 * Latency contract: every pointer event writes plain scalar fields
 * synchronously inside the handler. `sample()` only reads those fields, so a
 * touch is visible to the simulation on the very next sim step. Nothing here
 * routes through a framework, a rAF hop or a re-render.
 *
 * Layout contract with the HUD: `root` is a full-screen pointer-events:none
 * overlay. Only the actual control surfaces set pointer-events:auto, and the
 * controls live in the lower band so the HUD keeps its four corners.
 */
import type { InputFrame } from '../sim/types'
import { TUNING } from '../content/tuning'
import { clamp, damp, DEG, RAD } from '../sim/math'

export type TouchScheme = 'tilt' | 'stick' | 'buttons'

export interface TouchControls {
  root: HTMLElement
  sample(out: InputFrame): void
  setScheme(s: 'tilt' | 'stick' | 'buttons'): void
  setVisible(v: boolean): void
  dispose(): void

  // --- extensions used by the InputManager -------------------------------
  /** Only changes pad visibility; the manager owns the throttle override. */
  setAutoAccelerate(on: boolean): void
  setOneHanded(on: boolean, side?: 'left' | 'right'): void
  /** Show the Lift pad (flight chassis only). */
  setLiftEnabled(on: boolean): void
  setTiltInvert(on: boolean): void
  /** Capture the current holding angle as neutral. */
  calibrateTilt(): void
  /**
   * iOS 13+ needs DeviceOrientationEvent.requestPermission() called from
   * inside a user gesture. Pass `true` when we are inside one.
   */
  requestTiltPermission(fromGesture: boolean): void
  readonly tiltActive: boolean
  /** Fired when tilt is denied or missing so the host can fall back to stick. */
  onTiltUnavailable: (() => void) | null
  /** Fired on the first touch of any control surface. */
  onTouchActivity: (() => void) | null
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** The sim advances by this much per `sample()` call. Keeps ramps deterministic. */
const DT = TUNING.sim.dt

/**
 * Digital -> analog steering ramp, shared by the keyboard and by the touch
 * arrow pads. A key or a pad is a switch; the vehicle needs a wheel.
 *
 *   attack  0 -> full lock in 0.120s
 *   release full lock -> 0 in 0.070s   (releases faster than it engages so a
 *                                       drift arc can be trimmed, not sawed)
 *   cross   sign flip in 0.055s        (direction changes stay crisp)
 */
export const STEER_RAMP = {
  attackTime: 0.120,
  releaseTime: 0.070,
  crossTime: 0.055,
} as const

const ATTACK_RATE = 1 / STEER_RAMP.attackTime
const RELEASE_RATE = 1 / STEER_RAMP.releaseTime
const CROSS_RATE = 1 / STEER_RAMP.crossTime

/** Move `current` toward `target` at the rate the transition calls for. */
export function rampAxis(current: number, target: number, dt: number): number {
  if (current === target) return target
  let rate: number
  if (target === 0) {
    rate = RELEASE_RATE
  } else if (current !== 0 && ((current < 0) !== (target < 0))) {
    rate = CROSS_RATE
  } else if (Math.abs(target) < Math.abs(current)) {
    rate = RELEASE_RATE
  } else {
    rate = ATTACK_RATE
  }
  const step = rate * dt
  const d = target - current
  if (d > step) return current + step
  if (d < -step) return current - step
  return target
}

/**
 * Deadzone rescale with a soft shoulder. Blending smoothstep with linear gives
 * a gentle ramp out of the deadzone (no jolt as the stick leaves centre) while
 * keeping enough low-end slope for fine corrections and a true 1.0 at the rim.
 */
export function axisCurve(raw: number, deadzone: number): number {
  const a = raw < 0 ? -raw : raw
  if (a <= deadzone) return 0
  let n = (a - deadzone) / (1 - deadzone)
  if (n > 1) n = 1
  const s = n * n * (3 - 2 * n)
  const out = 0.6 * s + 0.4 * n
  return raw < 0 ? -out : out
}

/** Floating stick travel, CSS px, from origin to full lock. */
const STICK_RADIUS = 70
const STICK_DEADZONE = 0.10

/** Tilt steering, degrees of roll. */
const TILT_DEADZONE_DEG = 4
const TILT_FULL_DEG = 28
/** Smoothing half-life on the tilt signal — kills hand tremor, costs ~1 frame. */
const TILT_HALF_LIFE = 0.045
/** If the sensor never speaks within this long, treat tilt as unavailable. */
const TILT_PROBE_MS = 1500

// Control kinds. Plain numbers so the pointer map stays cheap.
const K_DRIFT = 1
const K_ITEM = 2
const K_BACK = 3
const K_GAS = 4
const K_BRAKE = 5
const K_LIFT = 6
const K_LOOK = 7
const K_ARROWS = 8
const K_STICK = 9
const K_CAL = 10
const K_HINT = 11
const K_COUNT = 12

interface DoeStatic {
  requestPermission?: () => Promise<string>
}

function doeStatic(): DoeStatic | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { DeviceOrientationEvent?: DoeStatic }).DeviceOrientationEvent
}

/** CSS rotation of the page content relative to the device's natural axes. */
function screenAngleDeg(): number {
  if (typeof window === 'undefined') return 0
  const so = typeof screen !== 'undefined' ? screen.orientation : undefined
  if (so && typeof so.angle === 'number') return so.angle
  const legacy = (window as unknown as { orientation?: number }).orientation
  return typeof legacy === 'number' ? legacy : 0
}

/**
 * Signed steering roll in degrees, positive = "right edge down" = steer right.
 *
 * DeviceOrientationEvent angles are always in the device's fixed frame, never
 * the screen's, so the axis that carries a left/right roll depends on how the
 * page is rotated. Rather than pick one axis, project world-up into device
 * coordinates and take its component along the *screen's* right vector:
 *
 *   up_device      = (-sin g * cos b,  sin b,  cos g * cos b)
 *   screenRight    = ( cos t, -sin t, 0)          t = screen orientation angle
 *
 * This reduces to gamma in portrait and to beta in landscape, which is what
 * the hardware actually reports, and it stays continuous across rotations.
 */
export function tiltRollDeg(betaDeg: number, gammaDeg: number, screenDeg: number): number {
  const b = betaDeg * DEG
  const g = gammaDeg * DEG
  const t = screenDeg * DEG
  const ux = -Math.sin(g) * Math.cos(b)
  const uy = Math.sin(b)
  const s = Math.cos(t) * ux - Math.sin(t) * uy
  return Math.asin(clamp(-s, -1, 1)) * RAD
}

// ---------------------------------------------------------------------------
// Styling — bold kart-racer HUD: chunky, semi-transparent, glowing.
// ---------------------------------------------------------------------------

const STYLE_ID = 'sgtc-style'

const CSS = `
.sgtc{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:5;
  touch-action:none;-webkit-user-select:none;user-select:none;
  -webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;
  font-family:ui-sans-serif,system-ui,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --pl:max(16px,env(safe-area-inset-left,0px));
  --pr:max(16px,env(safe-area-inset-right,0px));
  --pb:max(18px,env(safe-area-inset-bottom,0px));
  --cy:126 240 255;--mg:255 94 200;--am:255 198 94;--gn:125 255 155;--rd:255 110 110}
.sgtc *{box-sizing:border-box;margin:0}
.sgtc.off{display:none!important}

.sgtc-btn{--a:var(--cy);position:relative;pointer-events:auto;touch-action:none;
  display:flex;align-items:center;justify-content:center;text-align:center;
  line-height:1.05;padding:2px;border-radius:999px;
  border:2px solid rgb(var(--a) / .55);
  background:radial-gradient(circle at 50% 32%,rgb(var(--a) / .30),rgb(var(--a) / .06) 62%,rgba(6,12,26,.46) 100%);
  box-shadow:0 0 20px rgb(var(--a) / .26),inset 0 0 24px rgb(var(--a) / .16),0 6px 18px rgba(0,0,0,.36);
  color:rgb(var(--a));font-weight:800;font-size:12px;letter-spacing:.10em;
  text-shadow:0 0 10px rgb(var(--a) / .8);
  -webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);
  transition:transform .07s ease-out,box-shadow .09s ease-out,background .09s ease-out,border-color .09s ease-out;
  will-change:transform}
.sgtc-btn.on{transform:scale(.92);border-color:rgb(var(--a) / .98);
  background:radial-gradient(circle at 50% 32%,rgb(var(--a) / .62),rgb(var(--a) / .22) 62%,rgba(6,12,26,.5) 100%);
  box-shadow:0 0 36px rgb(var(--a) / .55),inset 0 0 30px rgb(var(--a) / .34),0 2px 10px rgba(0,0,0,.4)}

.sgtc-right{position:absolute;right:var(--pr);bottom:var(--pb);pointer-events:none;
  display:flex;flex-direction:column-reverse;align-items:flex-end;gap:12px}
.sgtc-row{display:flex;flex-direction:row-reverse;align-items:flex-end;gap:12px;pointer-events:none}
.sgtc-left{position:absolute;left:var(--pl);bottom:var(--pb);display:flex;gap:14px;pointer-events:none}

.sgtc-drift{width:86px;height:86px;font-size:13px;--a:var(--mg)}
.sgtc-item{width:76px;height:76px;--a:var(--cy)}
.sgtc-gas{width:74px;height:74px;--a:var(--gn)}
.sgtc-brake{width:72px;height:72px;--a:var(--rd)}
.sgtc-back{width:52px;height:52px;font-size:10px;--a:var(--cy)}
.sgtc-look{width:52px;height:52px;font-size:10px;--a:var(--am)}
.sgtc-lift{width:52px;height:52px;font-size:10px;--a:var(--am)}
.sgtc-arrow{width:82px;height:82px;font-size:26px;letter-spacing:0;--a:var(--cy)}
.sgtc-cal{width:60px;height:60px;font-size:9px;--a:var(--am);
  position:absolute;left:var(--pl);bottom:var(--pb)}

/* BRAKE has no visibility rule at all -- it is always on screen. The auto
   throttle in input.ts already stands down the moment brake passes 0.15, so the
   pad has always worked in auto mode; it simply was not drawn, which left the
   default phone setup with no way to slow down on purpose. GAS is the one pad
   that is conditional, because with auto on it is a no-op. */
.sgtc-gas{display:none}
.sgtc[data-accel="manual"] .sgtc-gas,
.sgtc[data-scheme="buttons"] .sgtc-gas{display:flex}
.sgtc-lift{display:none}
.sgtc[data-lift="on"] .sgtc-lift{display:flex}
.sgtc-left{display:none}
.sgtc[data-scheme="buttons"] .sgtc-left{display:flex}
.sgtc-cal{display:none}
.sgtc[data-scheme="tilt"][data-tilt="on"] .sgtc-cal{display:flex}

.sgtc-zone{position:absolute;left:0;bottom:0;width:52%;height:64%;
  pointer-events:auto;touch-action:none;display:none}
.sgtc[data-scheme="stick"] .sgtc-zone{display:block}
.sgtc[data-scheme="tilt"][data-tilt="off"] .sgtc-zone{display:block}
.sgtc-base,.sgtc-knob{position:absolute;left:0;top:0;border-radius:50%;
  pointer-events:none;opacity:0;transition:opacity .13s ease-out}
.sgtc-base{width:150px;height:150px;margin:-75px 0 0 -75px;
  border:2px solid rgb(var(--cy) / .32);
  background:radial-gradient(circle,rgba(10,26,48,.36),rgba(10,26,48,.04) 72%);
  box-shadow:inset 0 0 30px rgb(var(--cy) / .18)}
.sgtc-knob{width:68px;height:68px;margin:-34px 0 0 -34px;
  border:2px solid rgb(var(--cy) / .85);
  background:radial-gradient(circle at 50% 34%,rgb(var(--cy) / .55),rgba(10,26,48,.55));
  box-shadow:0 0 26px rgb(var(--cy) / .5)}
.sgtc-zone.live .sgtc-base,.sgtc-zone.live .sgtc-knob{opacity:1}

/* --- bottom-left teaching stack ---------------------------------------------
   The steering zone is the lower LEFT of the screen, so the thing that explains
   it belongs in that corner rather than floating over the racing line. Two
   pieces, stacked, bottom-aligned:

     .sgtc-pad   a watermark of the thumb zone. It is deliberately drawn as an
                 unfilled outline at low opacity and is pointer-events:none, so
                 it reads as a diagram of where the thumb goes rather than as a
                 button to press -- and, more importantly, so a thumb landing on
                 it goes straight through to the live steering zone underneath.

     .sgtc-hint  the tilt notice, which IS a button (it is the user gesture iOS
                 needs before it will hand over the orientation sensor).

   WHAT THE WATERMARK SAYS. The left zone is a floating stick that reads its
   HORIZONTAL travel only (see bindStick: dx steers, dy moves the knob and
   nothing else). There is no throttle or brake on this axis in any of the three
   schemes. So the graphic is a left/right axis and nothing else, and the
   sub-label names where forward and slowing down actually come from. Both
   variants of that line end in "BRAKE >", because the brake pad is on the
   opposite edge in both throttle modes; only the gas half changes. */
.sgtc-lh{position:absolute;left:var(--pl);bottom:var(--pb);display:none;
  flex-direction:column;align-items:flex-start;gap:8px;pointer-events:none;
  max-width:min(52vw,300px)}
.sgtc[data-scheme="stick"] .sgtc-lh,
.sgtc[data-scheme="tilt"][data-tilt="off"] .sgtc-lh{display:flex}

/* CONTRAST WITHOUT A PANEL. A flat opacity on the whole block reads beautifully
   on Rustfall's night road and disappears completely on Cryostatic's lit snow
   or a blown-out white frame -- and a CSS drop-shadow filter cannot save it,
   because the shadow is derived from the source alpha and fades with it. So the
   dimming is per-stroke, at full alpha, over a soft radial scrim that has no
   edge and no border: on a dark surface it is invisible, on a bright one it is
   the only reason the diagram survives. It stays a watermark either way. */
.sgtc-pad{display:flex;flex-direction:column;align-items:flex-start;gap:2px;
  color:rgb(var(--cy))}
.sgtc-pad__svg{display:block;width:var(--padsz,86px);height:var(--padsz,86px);
  background:radial-gradient(closest-side,rgba(4,9,18,.46),rgba(4,9,18,0) 84%)}
.sgtc-pad__ring{fill:none;stroke:currentColor;stroke-width:2.5;opacity:.36;
  stroke-dasharray:7 9;stroke-linecap:round}
.sgtc-pad__axis{fill:none;stroke:currentColor;stroke-width:2.5;opacity:.32;
  stroke-linecap:round}
.sgtc-pad__arrow{fill:none;stroke:currentColor;stroke-width:5;opacity:.62;
  stroke-linecap:round;stroke-linejoin:round}
.sgtc-pad__knob{fill:rgba(6,14,28,.5);stroke:currentColor;stroke-width:2.5;
  opacity:.55}
.sgtc-pad__lbl{font-size:9px;font-weight:800;letter-spacing:.20em;
  color:rgb(var(--cy) / .72);
  text-shadow:0 1px 2px rgba(0,0,0,.95),0 0 9px rgba(0,0,0,.9)}
.sgtc-pad__sub{font-size:8px;font-weight:700;letter-spacing:.14em;
  color:rgb(var(--cy) / .56);display:none;white-space:nowrap;
  text-shadow:0 1px 2px rgba(0,0,0,.95),0 0 9px rgba(0,0,0,.9)}
/* The arrow means "the pads are over there", so it has to follow them: the
   one-handed LEFT layout puts the action cluster on the left and moves this
   whole block to the right, and an arrow still pointing right would be sending
   the player to the empty corner. */
.sgtc-pad__arw{display:inline-block}
.sgtc.oh.ohl .sgtc-pad__arw{transform:scaleX(-1)}
.sgtc[data-accel="auto"] .sgtc-pad__auto{display:block}
.sgtc[data-accel="manual"] .sgtc-pad__man{display:block}

.sgtc-hint{display:flex;align-items:center;min-height:44px;
  padding:9px 14px;border-radius:14px;pointer-events:auto;touch-action:none;
  border:2px solid rgb(var(--am) / .5);background:rgba(8,16,32,.5);
  color:rgb(var(--am));font-size:11px;font-weight:800;letter-spacing:.08em;
  line-height:1.25;
  text-shadow:0 0 10px rgb(var(--am) / .7);box-shadow:0 0 22px rgb(var(--am) / .22);
  -webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
.sgtc[data-scheme="stick"] .sgtc-hint{display:none}

.sgtc-tiltbar{position:absolute;left:50%;bottom:calc(var(--pb) + 4px);
  transform:translateX(-50%);width:184px;height:6px;border-radius:3px;display:none;
  background:rgba(8,16,32,.5);box-shadow:inset 0 0 0 1px rgb(var(--cy) / .28)}
.sgtc[data-scheme="tilt"][data-tilt="on"] .sgtc-tiltbar{display:block}
.sgtc-tiltmark{position:absolute;left:50%;top:50%;width:20px;height:20px;
  margin:-10px 0 0 -10px;border-radius:50%;background:rgb(var(--cy) / .85);
  box-shadow:0 0 16px rgb(var(--cy) / .8);will-change:transform}

.sgtc.oh .sgtc-zone{left:auto;right:0;width:62%;height:74%}
.sgtc.oh.ohl .sgtc-zone{left:0;right:auto}
.sgtc.oh .sgtc-left{left:auto;right:var(--pr);bottom:calc(var(--pb) + 268px)}
.sgtc.oh.ohl .sgtc-left{right:auto;left:var(--pl)}
.sgtc.oh.ohl .sgtc-right{right:auto;left:var(--pl);align-items:flex-start}
.sgtc.oh.ohl .sgtc-row{flex-direction:row}
.sgtc.oh.ohl .sgtc-cal{left:auto;right:var(--pr)}
/* One-handed LEFT puts the action cluster in this corner, so the whole
   teaching stack moves out of its way -- same swap the notice alone used to
   make, now applied to the block that contains it. */
.sgtc.oh.ohl .sgtc-lh{left:auto;right:var(--pl);align-items:flex-end}

@media (max-height:430px){
  .sgtc-drift{width:74px;height:74px}
  .sgtc-item{width:66px;height:66px}
  .sgtc-gas{width:64px;height:64px}
  .sgtc-brake{width:62px;height:62px}
  .sgtc-back,.sgtc-look,.sgtc-lift{width:48px;height:48px;font-size:9px}
  .sgtc-arrow{width:72px;height:72px}
  .sgtc-right{gap:10px}
  .sgtc-row{gap:10px}
  .sgtc.oh .sgtc-left{bottom:calc(var(--pb) + 232px)}
  /* A landscape phone is ~390-430px tall and the teaching stack is the tallest
     thing in the corner. Shrink the diagram, not the notice. */
  .sgtc-lh{gap:5px;max-width:min(40vw,244px)}
  .sgtc-pad{--padsz:62px;gap:0}
  .sgtc-pad__lbl{font-size:8px;letter-spacing:.16em}
  .sgtc-hint{min-height:0;padding:7px 12px;font-size:10px}
}
/* Portrait: the action cluster is a tall stack up the right edge and the HUD's
   instrument strip has to lift clear of it, so the teaching block cannot also
   be a tall column in the opposite corner. Lay it out as a row instead -- same
   two pieces, half the height. */
@media (orientation:portrait){
  /* PORTRAIT PUTS THE HUD'S INSTRUMENT BAND AT ROW 2's HEIGHT. styles.css lifts
     the band by 116px -- one pad plus this layer's bottom inset -- which clears
     the BOTTOM row of pads and nothing above it, so the inner column of row 2
     lands on the band's right end and covers the boost count. That was already
     true of the Brake pad when it lived in row 2; it is the Gas pad's slot now.
     Row 1 is the corner the thumb rests in and must not move, so the clearance
     goes between the rows instead: in column-reverse a margin under row 2 opens
     the gap above row 1 and carries row 3 with it. Only when Gas is actually on
     screen -- with auto throttle on, row 2 is one Item pad well clear of the
     band's right edge and there is nothing to move out of the way. */
  .sgtc[data-accel="manual"] .sgtc-row:nth-child(2),
  .sgtc[data-scheme="buttons"] .sgtc-row:nth-child(2){margin-bottom:48px}
  .sgtc-lh{flex-direction:row;align-items:flex-end;gap:10px;
    max-width:min(64vw,320px)}
  .sgtc-pad{--padsz:62px}
  .sgtc-pad__lbl{font-size:8px;letter-spacing:.14em}
  .sgtc-hint{min-height:0;padding:8px 12px;font-size:10px}
}

@media (prefers-reduced-motion:reduce){
  .sgtc-btn{transition:none}
  .sgtc-base,.sgtc-knob{transition:none}
}
`

function injectStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  const s = doc.createElement('style')
  s.id = STYLE_ID
  s.textContent = CSS
  doc.head.appendChild(s)
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface Bound { t: EventTarget; k: string; f: EventListener; c: boolean }

class TouchControlsImpl implements TouchControls {
  readonly root: HTMLElement

  onTiltUnavailable: (() => void) | null = null
  onTouchActivity: (() => void) | null = null

  // --- raw control state, written synchronously by pointer handlers -------
  private dDrift = false
  private dItem = false
  private dBack = false
  private dGas = false
  private dBrake = false
  private dLift = false
  private dLook = false
  private dArrowL = false
  private dArrowR = false

  private padSteer = 0
  private stickSteer = 0
  private tiltTarget = 0
  private tiltSteer = 0

  private scheme: TouchScheme = 'tilt'
  private autoAccel = true
  private oneHanded = false
  private tiltInvert = false
  private tiltCenter = 0
  private tiltNeedsCentre = true
  private tiltOn = false
  private tiltState: 'idle' | 'asking' | 'waiting' | 'active' | 'off' = 'idle'
  private tiltProbe = 0
  private lastMarkPx = -9999

  // --- pointer bookkeeping ------------------------------------------------
  private readonly pointers = new Map<number, number>()
  private readonly counts = new Int8Array(K_COUNT)
  private stickId = -1
  private stickOx = 0
  private stickOy = 0
  private zoneLeft = 0
  private zoneTop = 0
  private arrowId = -1
  private arrowSplit = 0
  private arrowLo = 0
  private arrowHi = 0

  private readonly bounds: Bound[] = []
  private readonly kindEls: (HTMLElement | null)[] = new Array<HTMLElement | null>(K_COUNT).fill(null)
  private disposed = false

  // --- elements -----------------------------------------------------------
  private readonly zone: HTMLElement
  private readonly base: HTMLElement
  private readonly knob: HTMLElement
  private readonly arrowL: HTMLElement
  private readonly arrowR: HTMLElement
  private readonly tiltMark: HTMLElement
  private readonly btnEls: HTMLElement[] = []

  constructor(container: HTMLElement) {
    const doc = container.ownerDocument
    injectStyle(doc)

    const root = doc.createElement('div')
    root.className = 'sgtc off'
    root.dataset.scheme = 'tilt'
    root.dataset.tilt = 'off'
    root.dataset.accel = 'auto'
    root.dataset.lift = 'off'
    this.root = root

    // Steering surface (floating stick) — left half of the lower band.
    this.zone = mk(doc, 'div', 'sgtc-zone', root)
    this.base = mk(doc, 'div', 'sgtc-base', this.zone)
    this.knob = mk(doc, 'div', 'sgtc-knob', this.zone)

    // Right-edge action cluster. Row order is bottom-up; each row is laid out
    // right-to-left so the first child sits in the outer lower corner.
    //
    // TWO COLUMNS, TWO JOBS. The outer column is the corner the thumb rests in:
    // DRIFT, then ITEM above it, then BACK. The column inboard of it is the
    // pedals: BRAKE, then GAS directly above it. That gives the arrangement the
    // controls actually need:
    //
    //   * BRAKE sits immediately inboard of DRIFT, the shortest move on the
    //     cluster, because braking mid-slide (and ITEM + BRAKE, which fires an
    //     item backwards) are things you do WHILE drifting.
    //   * GAS and BRAKE share a column and are never wanted at the same time,
    //     so one digit works them like pedals and never has to leave DRIFT to
    //     find the throttle.
    //   * Nothing moves when the player turns auto-accelerate off. GAS appears
    //     in the empty slot above BRAKE; DRIFT, BRAKE and ITEM keep the exact
    //     positions they had, so muscle memory survives the switch.
    //
    // In the one-handed LEFT layout the rows flip to `row` (see .oh.ohl) and
    // the whole thing mirrors: BRAKE ends up immediately inboard of DRIFT on
    // that side too, which is the same relationship, not a different one.
    const right = mk(doc, 'div', 'sgtc-right', root)
    const row1 = mk(doc, 'div', 'sgtc-row', right)
    const row2 = mk(doc, 'div', 'sgtc-row', right)
    const row3 = mk(doc, 'div', 'sgtc-row', right)
    this.mkBtn(doc, 'sgtc-drift', 'DRIFT', row1, K_DRIFT)
    this.mkBtn(doc, 'sgtc-brake', 'BRAKE', row1, K_BRAKE)
    this.mkBtn(doc, 'sgtc-item', 'ITEM', row2, K_ITEM)
    this.mkBtn(doc, 'sgtc-gas', 'GAS', row2, K_GAS)
    this.mkBtn(doc, 'sgtc-back', 'BACK', row3, K_BACK)
    this.mkBtn(doc, 'sgtc-look', 'LOOK', row3, K_LOOK)
    this.mkBtn(doc, 'sgtc-lift', 'LIFT', row3, K_LIFT)

    // Discrete steering pads, bottom-left, 'buttons' scheme only.
    const left = mk(doc, 'div', 'sgtc-left', root)
    this.arrowL = this.mkBtn(doc, 'sgtc-arrow', '◀', left, 0)
    this.arrowR = this.mkBtn(doc, 'sgtc-arrow', '▶', left, 0)
    this.bindArrows(left)

    // Tilt affordances.
    this.mkBtn(doc, 'sgtc-cal', 'RE-CENTRE', root, K_CAL)

    // Bottom-left teaching stack: thumb-zone watermark over the tilt notice.
    // Built once, never touched again -- everything that varies (which scheme,
    // auto or manual throttle) is already a data-attribute on the root, so CSS
    // does the switching and no code runs per frame.
    const lh = mk(doc, 'div', 'sgtc-lh', root)
    const pad = mk(doc, 'div', 'sgtc-pad', lh)
    mkSvg(doc, PAD_SVG, pad)
    mk(doc, 'div', 'sgtc-pad__lbl', pad).textContent = 'SLIDE TO STEER'
    mkSub(doc, pad, 'sgtc-pad__auto', 'GAS: AUTO / BRAKE ')
    mkSub(doc, pad, 'sgtc-pad__man', 'GAS / BRAKE ')
    const hint = mk(doc, 'div', 'sgtc-hint', lh)
    hint.textContent = 'TAP TO ENABLE TILT STEERING'
    hint.setAttribute('role', 'button')
    this.bindMomentary(hint, K_HINT)
    const bar = mk(doc, 'div', 'sgtc-tiltbar', root)
    this.tiltMark = mk(doc, 'div', 'sgtc-tiltmark', bar)

    this.bindStick()

    // Kill scroll, pull-to-refresh, double-tap zoom and long-press menus.
    this.on(root, 'contextmenu', preventer, { passive: false })
    this.on(root, 'dblclick', preventer, { passive: false })
    this.on(root, 'selectstart', preventer, { passive: false })
    this.on(root, 'touchstart', this.onTouchRaw, { passive: false })
    this.on(root, 'touchmove', this.onTouchRaw, { passive: false })

    const win = doc.defaultView
    if (win) {
      this.on(win, 'pointerup', this.onGlobalUp)
      this.on(win, 'pointercancel', this.onGlobalUp)
      this.on(win, 'lostpointercapture', this.onGlobalUp)
      this.on(win, 'blur', this.onBlur)
      this.on(win, 'resize', this.onGeomChange)
      this.on(win, 'orientationchange', this.onGeomChange)
    }

    container.appendChild(root)
  }

  // -------------------------------------------------------------------------
  // Construction helpers
  // -------------------------------------------------------------------------

  private on(t: EventTarget, k: string, f: EventListener, opts?: AddEventListenerOptions): void {
    t.addEventListener(k, f, opts)
    this.bounds.push({ t, k, f, c: opts?.capture === true })
  }

  private mkBtn(doc: Document, cls: string, label: string, parent: HTMLElement, kind: number): HTMLElement {
    const b = mk(doc, 'div', 'sgtc-btn ' + cls, parent)
    b.textContent = label
    b.setAttribute('role', 'button')
    b.setAttribute('aria-label', label)
    this.btnEls.push(b)
    if (kind === K_CAL || kind === K_HINT) this.bindMomentary(b, kind)
    else if (kind > 0) this.bindHold(b, kind)
    return b
  }

  /** Held button: down sets the flag, up/cancel clears it. Multitouch safe. */
  private bindHold(b: HTMLElement, kind: number): void {
    this.kindEls[kind] = b
    const down = (ev: Event): void => {
      const e = ev as PointerEvent
      e.preventDefault()
      if (this.pointers.has(e.pointerId)) return
      this.pointers.set(e.pointerId, kind)
      try { b.setPointerCapture(e.pointerId) } catch { /* capture is best effort */ }
      if (++this.counts[kind] === 1) {
        b.classList.add('on')
        this.setKind(kind, true)
      }
      this.activity()
    }
    const up = (ev: Event): void => {
      const e = ev as PointerEvent
      e.preventDefault()
      if (this.pointers.get(e.pointerId) !== kind) return
      this.pointers.delete(e.pointerId)
      try { b.releasePointerCapture(e.pointerId) } catch { /* already gone */ }
      if (--this.counts[kind] <= 0) {
        this.counts[kind] = 0
        b.classList.remove('on')
        this.setKind(kind, false)
      }
    }
    this.on(b, 'pointerdown', down, { passive: false })
    this.on(b, 'pointerup', up, { passive: false })
    this.on(b, 'pointercancel', up, { passive: false })
  }

  /** Momentary button: fires once on press, no held state. */
  private bindMomentary(b: HTMLElement, kind: number): void {
    const down = (ev: Event): void => {
      const e = ev as PointerEvent
      e.preventDefault()
      b.classList.add('on')
      this.setKind(kind, true)
      this.activity()
      const clear = (): void => { b.classList.remove('on') }
      window.setTimeout(clear, 110)
    }
    this.on(b, 'pointerdown', down, { passive: false })
  }

  /**
   * The two arrow pads share one capture on their container so a thumb can
   * slide from one to the other without lifting.
   */
  private bindArrows(host: HTMLElement): void {
    const apply = (x: number): void => {
      const l = x < this.arrowSplit && x >= this.arrowLo - 30
      const r = x >= this.arrowSplit && x <= this.arrowHi + 30
      if (l !== this.dArrowL) { this.dArrowL = l; this.arrowL.classList.toggle('on', l) }
      if (r !== this.dArrowR) { this.dArrowR = r; this.arrowR.classList.toggle('on', r) }
    }
    const down = (ev: Event): void => {
      const e = ev as PointerEvent
      e.preventDefault()
      if (this.arrowId >= 0) return
      const a = this.arrowL.getBoundingClientRect()
      const b = this.arrowR.getBoundingClientRect()
      this.arrowLo = Math.min(a.left, b.left)
      this.arrowHi = Math.max(a.right, b.right)
      this.arrowSplit = (a.right + b.left) * 0.5
      this.arrowId = e.pointerId
      this.pointers.set(e.pointerId, K_ARROWS)
      try { host.setPointerCapture(e.pointerId) } catch { /* best effort */ }
      apply(e.clientX)
      this.activity()
    }
    const move = (ev: Event): void => {
      const e = ev as PointerEvent
      if (e.pointerId !== this.arrowId) return
      e.preventDefault()
      apply(e.clientX)
    }
    const up = (ev: Event): void => {
      const e = ev as PointerEvent
      if (e.pointerId !== this.arrowId) return
      e.preventDefault()
      this.arrowId = -1
      this.pointers.delete(e.pointerId)
      try { host.releasePointerCapture(e.pointerId) } catch { /* already gone */ }
      this.clearArrows()
    }
    this.on(host, 'pointerdown', down, { passive: false })
    this.on(host, 'pointermove', move, { passive: false })
    this.on(host, 'pointerup', up, { passive: false })
    this.on(host, 'pointercancel', up, { passive: false })
  }

  /** Floating stick: the origin is wherever the thumb lands, not a fixed spot. */
  private bindStick(): void {
    const z = this.zone
    const down = (ev: Event): void => {
      const e = ev as PointerEvent
      e.preventDefault()
      if (this.stickId >= 0) return
      const r = z.getBoundingClientRect()
      this.zoneLeft = r.left
      this.zoneTop = r.top
      this.stickId = e.pointerId
      this.stickOx = e.clientX
      this.stickOy = e.clientY
      this.pointers.set(e.pointerId, K_STICK)
      try { z.setPointerCapture(e.pointerId) } catch { /* best effort */ }
      z.classList.add('live')
      const lx = e.clientX - this.zoneLeft
      const ly = e.clientY - this.zoneTop
      this.base.style.transform = 'translate3d(' + lx + 'px,' + ly + 'px,0)'
      this.knob.style.transform = 'translate3d(' + lx + 'px,' + ly + 'px,0)'
      this.stickSteer = 0
      this.activity()
    }
    const move = (ev: Event): void => {
      const e = ev as PointerEvent
      if (e.pointerId !== this.stickId) return
      e.preventDefault()
      let dx = e.clientX - this.stickOx
      let dy = e.clientY - this.stickOy
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len > STICK_RADIUS) {
        const k = STICK_RADIUS / len
        dx *= k
        dy *= k
        // Drag the origin along so a long swipe never runs out of travel.
        this.stickOx = e.clientX - dx
        this.stickOy = e.clientY - dy
        const bx = this.stickOx - this.zoneLeft
        const by = this.stickOy - this.zoneTop
        this.base.style.transform = 'translate3d(' + bx + 'px,' + by + 'px,0)'
      }
      this.stickSteer = axisCurve(dx / STICK_RADIUS, STICK_DEADZONE)
      const kx = this.stickOx + dx - this.zoneLeft
      const ky = this.stickOy + dy - this.zoneTop
      this.knob.style.transform = 'translate3d(' + kx + 'px,' + ky + 'px,0)'
    }
    const up = (ev: Event): void => {
      const e = ev as PointerEvent
      if (e.pointerId !== this.stickId) return
      e.preventDefault()
      this.stickId = -1
      this.pointers.delete(e.pointerId)
      try { z.releasePointerCapture(e.pointerId) } catch { /* already gone */ }
      z.classList.remove('live')
      this.stickSteer = 0
    }
    this.on(z, 'pointerdown', down, { passive: false })
    this.on(z, 'pointermove', move, { passive: false })
    this.on(z, 'pointerup', up, { passive: false })
    this.on(z, 'pointercancel', up, { passive: false })
  }

  // -------------------------------------------------------------------------
  // State plumbing
  // -------------------------------------------------------------------------

  private setKind(kind: number, on: boolean): void {
    switch (kind) {
      case K_DRIFT: this.dDrift = on; break
      case K_ITEM: this.dItem = on; break
      case K_BACK: this.dBack = on; break
      case K_GAS: this.dGas = on; break
      case K_BRAKE: this.dBrake = on; break
      case K_LIFT: this.dLift = on; break
      case K_LOOK: this.dLook = on; break
      case K_CAL: if (on) this.calibrateTilt(); break
      case K_HINT: if (on) this.requestTiltPermission(true); break
      default: break
    }
  }

  private activity(): void {
    const cb = this.onTouchActivity
    if (cb) cb()
  }

  private clearArrows(): void {
    if (this.dArrowL) { this.dArrowL = false; this.arrowL.classList.remove('on') }
    if (this.dArrowR) { this.dArrowR = false; this.arrowR.classList.remove('on') }
  }

  private clearAll(): void {
    this.pointers.clear()
    this.counts.fill(0)
    for (let i = 0; i < this.btnEls.length; i++) this.btnEls[i].classList.remove('on')
    this.dDrift = false; this.dItem = false; this.dBack = false
    this.dGas = false; this.dBrake = false; this.dLift = false; this.dLook = false
    this.dArrowL = false; this.dArrowR = false
    this.padSteer = 0
    this.stickSteer = 0
    this.stickId = -1
    this.arrowId = -1
    this.zone.classList.remove('live')
  }

  private onTouchRaw = (e: Event): void => {
    // Anything that reaches the overlay started on a control surface: stop the
    // browser from scrolling, rubber-banding or zooming the page mid-race.
    if (e.cancelable) e.preventDefault()
  }

  private onGlobalUp = (ev: Event): void => {
    const e = ev as PointerEvent
    const kind = this.pointers.get(e.pointerId)
    if (kind === undefined) return
    this.pointers.delete(e.pointerId)
    if (kind === K_STICK) {
      this.stickId = -1
      this.zone.classList.remove('live')
      this.stickSteer = 0
    } else if (kind === K_ARROWS) {
      this.arrowId = -1
      this.clearArrows()
    } else if (kind > 0 && kind < K_COUNT) {
      if (--this.counts[kind] <= 0) {
        this.counts[kind] = 0
        this.setKind(kind, false)
        const el = this.kindEls[kind]
        if (el) el.classList.remove('on')
      }
    }
  }

  private onBlur = (): void => { this.clearAll() }

  private onGeomChange = (): void => {
    this.clearAll()
    this.tiltNeedsCentre = true
  }

  // -------------------------------------------------------------------------
  // Tilt steering
  // -------------------------------------------------------------------------

  private permOk = false
  private orientAttached = false
  private lastRawDeg = 0

  get tiltActive(): boolean { return this.tiltOn }

  requestTiltPermission(fromGesture: boolean): void {
    if (this.disposed || this.tiltOn || this.tiltState === 'asking') return
    const d = doeStatic()
    if (!d) { this.tiltFailed(); return }
    if (this.permOk) { this.attachOrient(); return }
    if (typeof d.requestPermission === 'function') {
      // iOS 13+: this MUST run inside a user gesture, so if we are not in one
      // we stay idle and let the on-screen hint (a real tap) drive it.
      if (!fromGesture) { this.tiltState = 'idle'; return }
      this.tiltState = 'asking'
      d.requestPermission().then((res: string): void => {
        if (this.disposed) return
        if (res === 'granted') { this.permOk = true; this.attachOrient() } else { this.tiltFailed() }
      }).catch((): void => {
        // Usually "requires a user gesture" — stay idle so a tap can retry.
        if (!this.disposed) this.tiltState = 'idle'
      })
      return
    }
    this.permOk = true
    this.attachOrient()
  }

  private attachOrient(): void {
    if (this.orientAttached) return
    const win = this.root.ownerDocument.defaultView
    if (!win) { this.tiltFailed(); return }
    this.orientAttached = true
    this.tiltState = 'waiting'
    this.tiltNeedsCentre = true
    win.addEventListener('deviceorientation', this.onOrient)
    // Some browsers expose the API on hardware that never reports. Give the
    // sensor a moment, then fall back rather than leaving the player stranded.
    this.tiltProbe = win.setTimeout((): void => {
      if (!this.disposed && this.tiltState === 'waiting') this.tiltFailed()
    }, TILT_PROBE_MS)
  }

  private detachOrient(): void {
    if (!this.orientAttached) return
    this.orientAttached = false
    const win = this.root.ownerDocument.defaultView
    if (win) {
      win.removeEventListener('deviceorientation', this.onOrient)
      if (this.tiltProbe) { win.clearTimeout(this.tiltProbe); this.tiltProbe = 0 }
    }
    this.tiltOn = false
    this.tiltSteer = 0
    this.tiltTarget = 0
    this.root.dataset.tilt = 'off'
    if (this.tiltState === 'waiting' || this.tiltState === 'active') this.tiltState = 'idle'
  }

  private tiltFailed(): void {
    this.detachOrient()
    this.tiltState = 'off'
    const cb = this.onTiltUnavailable
    if (cb) cb()
  }

  private onOrient = (ev: Event): void => {
    const e = ev as DeviceOrientationEvent
    if (e.beta === null && e.gamma === null) return
    if (this.tiltProbe) {
      const win = this.root.ownerDocument.defaultView
      if (win) win.clearTimeout(this.tiltProbe)
      this.tiltProbe = 0
    }
    if (!this.tiltOn) {
      this.tiltOn = true
      this.tiltState = 'active'
      this.root.dataset.tilt = 'on'
    }
    const raw = tiltRollDeg(e.beta ?? 0, e.gamma ?? 0, screenAngleDeg())
    this.lastRawDeg = raw
    if (this.tiltNeedsCentre) { this.tiltNeedsCentre = false; this.tiltCenter = raw }
    let a = raw - this.tiltCenter
    if (this.tiltInvert) a = -a
    const t = axisCurve(a / TILT_FULL_DEG, TILT_DEADZONE_DEG / TILT_FULL_DEG)
    this.tiltTarget = t
    // Cheap, event-rate-only indicator update. Never touched from sample().
    const px = Math.round(t * 82)
    if (px !== this.lastMarkPx) {
      this.lastMarkPx = px
      this.tiltMark.style.transform = 'translateX(' + px + 'px)'
    }
  }

  calibrateTilt(): void {
    this.tiltNeedsCentre = true
    this.tiltCenter = this.lastRawDeg
    this.tiltTarget = 0
    this.tiltSteer = 0
  }

  setTiltInvert(on: boolean): void { this.tiltInvert = on }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  /** Allocation-free: reads scalars written by the pointer/sensor handlers. */
  sample(out: InputFrame): void {
    let steer = 0
    const s = this.scheme
    if (s === 'tilt') {
      if (this.tiltOn) {
        this.tiltSteer = damp(this.tiltSteer, this.tiltTarget, TILT_HALF_LIFE, DT)
        steer = this.tiltSteer
      } else {
        // Tilt not granted yet: the floating stick stays live so the player is
        // never left without steering.
        steer = this.stickSteer
      }
    } else if (s === 'stick') {
      steer = this.stickSteer
    } else {
      const target = (this.dArrowL ? -1 : 0) + (this.dArrowR ? 1 : 0)
      this.padSteer = rampAxis(this.padSteer, target, DT)
      steer = this.padSteer
    }
    out.steer = steer
    out.throttle = this.dGas ? 1 : 0
    out.brake = this.dBrake ? 1 : 0
    out.drift = this.dDrift
    out.item = this.dItem || this.dBack
    out.itemBack = this.dBack || (this.dItem && this.dBrake)
    out.lift = this.dLift
    out.lookBack = this.dLook
  }

  setScheme(s: 'tilt' | 'stick' | 'buttons'): void {
    if (this.scheme !== s) {
      this.scheme = s
      this.root.dataset.scheme = s
      this.clearAll()
    }
    // Idempotent on purpose: the host may (re)select 'tilt' while the field
    // already reads 'tilt', and that must still arm the sensor.
    if (s === 'tilt') this.requestTiltPermission(false)
    else this.detachOrient()
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('off', !v)
    if (!v) this.clearAll()
  }

  setAutoAccelerate(on: boolean): void {
    this.autoAccel = on
    this.root.dataset.accel = on ? 'auto' : 'manual'
  }

  setOneHanded(on: boolean, side?: 'left' | 'right'): void {
    this.oneHanded = on
    this.root.classList.toggle('oh', on)
    this.root.classList.toggle('ohl', on && side === 'left')
  }

  setLiftEnabled(on: boolean): void { this.root.dataset.lift = on ? 'on' : 'off' }

  /** Exposed for a settings UI that wants to reflect current state. */
  get state(): { scheme: TouchScheme; autoAccel: boolean; oneHanded: boolean } {
    return { scheme: this.scheme, autoAccel: this.autoAccel, oneHanded: this.oneHanded }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.detachOrient()
    for (let i = 0; i < this.bounds.length; i++) {
      const b = this.bounds[i]
      b.t.removeEventListener(b.k, b.f, b.c)
    }
    this.bounds.length = 0
    this.pointers.clear()
    this.onTiltUnavailable = null
    this.onTouchActivity = null
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root)
  }
}

/**
 * The thumb-zone watermark.
 *
 * A dashed stick base, a knob, and ONE axis: left/right. That is the whole of
 * what the left zone does -- `bindStick` steers on `dx` and throws `dy` away --
 * so the diagram has no vertical arm to imply otherwise.
 */
const PAD_SVG =
  '<svg class="sgtc-pad__svg" viewBox="0 0 120 120" aria-hidden="true" focusable="false">' +
  '<circle class="sgtc-pad__ring" cx="60" cy="60" r="46"/>' +
  '<line class="sgtc-pad__axis" x1="30" y1="60" x2="90" y2="60"/>' +
  '<path class="sgtc-pad__arrow" d="M33 47 L21 60 L33 73"/>' +
  '<path class="sgtc-pad__arrow" d="M87 47 L99 60 L87 73"/>' +
  '<circle class="sgtc-pad__knob" cx="60" cy="60" r="14"/>' +
  '</svg>'

/** Construction-time only: parse authored markup into a live SVG element. */
function mkSvg(doc: Document, markup: string, parent: HTMLElement): SVGSVGElement {
  const host = doc.createElement('div')
  host.innerHTML = markup
  const el = host.firstElementChild as SVGSVGElement
  parent.appendChild(el)
  return el
}

/**
 * One line of the watermark's sub-label, with the "over there" arrow as its own
 * element so the one-handed LEFT layout can mirror it (see .sgtc-pad__arw).
 */
function mkSub(doc: Document, parent: HTMLElement, cls: string, text: string): HTMLElement {
  const row = mk(doc, 'div', 'sgtc-pad__sub ' + cls, parent)
  row.textContent = text
  mk(doc, 'span', 'sgtc-pad__arw', row).textContent = '▶'
  return row
}

function mk(doc: Document, tag: string, cls: string, parent: HTMLElement | null): HTMLElement {
  const e = doc.createElement(tag)
  e.className = cls
  if (parent) parent.appendChild(e)
  return e
}

function preventer(e: Event): void {
  if (e.cancelable) e.preventDefault()
}

export function createTouchControls(container: HTMLElement): TouchControls {
  return new TouchControlsImpl(container)
}
