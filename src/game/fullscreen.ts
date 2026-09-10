/**
 * FULLSCREEN — one small module, because the platform story is not one story.
 *
 * ---------------------------------------------------------------------------
 * THE THING WORTH KNOWING BEFORE READING ANY OF THIS.
 *
 * iPhone Safari does not implement the Fullscreen API for anything that is not
 * a `<video>`. Not a canvas, not a div, not the document. It is not a prefix
 * away and it is not a permission: `document.fullscreenEnabled` is false and
 * `requestFullscreen` is undefined, and the WebKit request for it
 * (bug 212934) has been open for years. Any "fullscreen button" that claims to
 * work there is either doing the scroll-the-toolbar-away trick -- which is not
 * fullscreen, does not survive a rotation and cannot be turned off -- or it is
 * quietly doing nothing.
 *
 * So this module does not pretend. It reports one of three states and lets the
 * UI say something true about each:
 *
 *   'available'   the Fullscreen API works here. Desktop, Android Chrome,
 *                 Android Firefox, iPadOS Safari (which DOES have it).
 *   'standalone'  the page is already running without browser chrome, because
 *                 it was installed. The manifest already says
 *                 `"display": "fullscreen"`, so an installed SpaceGen is
 *                 fullscreen by construction and the toggle has nothing to do.
 *   'unsupported' iPhone Safari in a tab. The honest answer is Add to Home
 *                 Screen, which lands the player in 'standalone' above.
 *
 * That is the whole reason this is a module rather than four lines in the
 * settings panel: the states are what the UI has to explain, and getting them
 * from feature detection rather than from user-agent sniffing is what keeps it
 * right when Apple eventually ships it.
 * ---------------------------------------------------------------------------
 */

export type FullscreenMode = 'available' | 'standalone' | 'unsupported'

/**
 * The vendor-prefixed shapes we still have to speak. Safari on macOS and
 * iPadOS carried `webkit` prefixes well past the point the spec settled, and
 * this game's floor includes devices that shipped with those builds.
 */
interface PrefixedDocument extends Document {
  webkitFullscreenElement?: Element | null
  webkitFullscreenEnabled?: boolean
  webkitExitFullscreen?: () => Promise<void> | void
}
interface PrefixedElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void
}
/** iOS Safari's own answer to "am I installed", which predates display-mode. */
interface StandaloneNavigator extends Navigator {
  standalone?: boolean
}

function doc(): PrefixedDocument {
  return document as PrefixedDocument
}

/**
 * Installed and running without browser chrome.
 *
 * Checked in both directions on purpose. `display-mode: fullscreen` is what
 * our own manifest asks for, `standalone` is what a browser may give instead
 * (and what iOS gives for Add to Home Screen), and `navigator.standalone` is
 * the iOS-only flag that predates either. Any of the three means the player is
 * already looking at a chrome-free screen.
 */
export function isStandalone(): boolean {
  try {
    if (typeof window === 'undefined') return false
    const nav = navigator as StandaloneNavigator
    if (nav.standalone === true) return true
    if (typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(display-mode: fullscreen)').matches
      || window.matchMedia('(display-mode: standalone)').matches
  } catch {
    return false
  }
}

/** Does the Fullscreen API exist and is it allowed in this context? */
export function isSupported(): boolean {
  try {
    if (typeof document === 'undefined') return false
    const d = doc()
    // `fullscreenEnabled` is false inside an iframe without allowfullscreen,
    // which is a real deployment (the artifact preview), so it is checked
    // rather than assumed from the method existing.
    if (d.fullscreenEnabled) return true
    if (d.webkitFullscreenEnabled) return true
    return false
  } catch {
    return false
  }
}

export function fullscreenMode(): FullscreenMode {
  if (isSupported()) return 'available'
  if (isStandalone()) return 'standalone'
  return 'unsupported'
}

export function isFullscreen(): boolean {
  try {
    const d = doc()
    return !!(d.fullscreenElement || d.webkitFullscreenElement)
  } catch {
    return false
  }
}

/**
 * Turn it on or off. Returns what the state ACTUALLY is afterwards, not what
 * was asked for.
 *
 * Every call site has to treat this as a request that can be refused, because
 * it can: the API demands a user gesture, and a browser that decides this call
 * is too far from a real tap rejects the promise. Swallowing that and flipping
 * the switch anyway is how a UI ends up lying about its own state, so the
 * caller gets the truth back and syncs to it.
 */
export async function setFullscreen(on: boolean): Promise<boolean> {
  const d = doc()
  try {
    if (on) {
      const target = document.documentElement as PrefixedElement
      if (target.requestFullscreen) await target.requestFullscreen()
      else if (target.webkitRequestFullscreen) await target.webkitRequestFullscreen()
      else return isFullscreen()
      // Best effort, and deliberately not awaited into the result: Android
      // Chrome can lock the orientation once fullscreen, desktop rejects it,
      // and iPadOS throws. A refusal here must not read as a failed toggle --
      // the player asked for fullscreen, not for a rotation.
      void lockLandscape()
    } else {
      if (d.exitFullscreen) await d.exitFullscreen()
      else if (d.webkitExitFullscreen) await d.webkitExitFullscreen()
    }
  } catch {
    // Rejected: no gesture, disallowed by permissions policy, or already in
    // the requested state. Fall through and report the real state.
  }
  return isFullscreen()
}

/** Android-only in practice. Never throws into the caller. */
async function lockLandscape(): Promise<void> {
  try {
    const o = screen.orientation as ScreenOrientation & {
      lock?: (o: string) => Promise<void>
    }
    if (typeof o?.lock === 'function') await o.lock('landscape')
  } catch {
    /* not supported here, and that is fine */
  }
}

/**
 * Fires whenever fullscreen changes for ANY reason -- including the ones the
 * game did not initiate: Escape, F11, the Android back gesture, or the OS
 * taking it away. Returns an unsubscribe.
 *
 * This is the half that is easy to skip and the half that makes the switch
 * honest. Without it, a player who presses Escape is left looking at a toggle
 * that still says ON.
 */
export function onFullscreenChange(cb: () => void): () => void {
  const events = ['fullscreenchange', 'webkitfullscreenchange']
  for (const e of events) document.addEventListener(e, cb)
  return () => { for (const e of events) document.removeEventListener(e, cb) }
}
