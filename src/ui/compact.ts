/**
 * THE COMPACT-HUD SWITCH.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A MEDIA QUERY.
 *
 * The HUD has two layouts. The desktop one puts a 214px speedometer ring in
 * the bottom-right corner and the item slots in a top corner, both of which
 * are fine when the player's hands are on a keyboard and nowhere near the
 * glass. The compact one flattens the ring into a horizontal strip along the
 * bottom centre and moves the item slots to the left edge, because on a touch
 * device the two bottom corners belong to thumbs.
 *
 * Which one you want is decided by WHERE THE PLAYER'S HANDS ARE, and a media
 * query cannot see hands. It sees pixels, and it was asking
 * `max-width: 860px OR max-height: 540px` -- a landscape phone. A tablet in
 * landscape is 1024-1366px wide and 768-1024px tall, so it matched neither and
 * got the desktop layout WITH the touch controls drawn over it: the speedo
 * cluster sat underneath the accelerator, and the item slots were in a corner
 * a driver cannot look at.
 *
 * CSS cannot OR a media query with a class, so the condition moves here, which
 * is the only place that knows both halves of it. The stylesheet asks for
 * `.sg-compact` and this decides when that is true.
 * ---------------------------------------------------------------------------
 */

/** The viewport half of the condition: a phone-shaped window, touch or not. */
const SMALL = '(max-width: 860px), (max-height: 540px)'

export interface CompactLayout {
  /**
   * Re-evaluate now. Call it whenever the control scheme changes -- a player
   * switching to Touch in the settings panel must see the HUD re-lay
   * immediately, not at the next resize.
   */
  refresh(): void
  dispose(): void
  /** What the class currently is. Exposed for probes and tests. */
  readonly active: boolean
}

/**
 * @param touchActive reads whether the on-screen pads are currently shown.
 *        A function rather than a boolean because the scheme changes at
 *        runtime and this module must never hold a stale copy of it.
 */
export function installCompactLayout(touchActive: () => boolean): CompactLayout {
  let on = false
  let mq: MediaQueryList | null = null
  try {
    mq = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(SMALL)
      : null
  } catch {
    mq = null
  }

  const apply = (): void => {
    let want = false
    try {
      want = (mq?.matches ?? false) || touchActive()
    } catch {
      // A throwing scheme getter must not take the HUD with it: fall back to
      // the viewport alone, which is the answer that was right before this
      // module existed.
      want = mq?.matches ?? false
    }
    if (want === on) return
    on = want
    try {
      document.documentElement.classList.toggle('sg-compact', want)
    } catch { /* no document: tests, SSR */ }
  }

  const onChange = (): void => apply()
  // `change` is the modern spelling; addListener is the one iOS 13 shipped and
  // this game's device floor still includes hardware that never left it.
  try {
    if (mq?.addEventListener) mq.addEventListener('change', onChange)
    else if (mq && 'addListener' in mq) {
      (mq as unknown as { addListener(cb: () => void): void }).addListener(onChange)
    }
  } catch { /* not supported here, and the resize below still covers it */ }
  // A rotation can change which of the two clauses matches without firing the
  // media query in some embedded webviews, so the resize is a belt as well.
  try { window.addEventListener('resize', onChange, { passive: true }) } catch { /* none */ }

  apply()

  return {
    refresh: apply,
    get active(): boolean { return on },
    dispose(): void {
      try {
        if (mq?.removeEventListener) mq.removeEventListener('change', onChange)
        else if (mq && 'removeListener' in mq) {
          (mq as unknown as { removeListener(cb: () => void): void }).removeListener(onChange)
        }
      } catch { /* ignore */ }
      try { window.removeEventListener('resize', onChange) } catch { /* ignore */ }
      try { document.documentElement.classList.remove('sg-compact') } catch { /* ignore */ }
    },
  }
}
