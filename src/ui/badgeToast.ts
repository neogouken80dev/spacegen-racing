/**
 * badgeToast.ts — "BADGE EARNED", said once, quietly, and out of the way.
 * ---------------------------------------------------------------------------
 * Two presentations of one piece of news, because the two moments it arrives
 * in want opposite things:
 *
 *   TOAST   in the menus and on the results screen: a small card in the top
 *           corner -- the badge in its earned frame, the word, the name -- that
 *           holds for a few seconds and goes. Nothing in the menus is racing,
 *           so it can afford a medal and a sentence.
 *
 *   CHIP    mid-race, for the unlocks a race can prove before its flag (a clean
 *           lap, a third SINGULARITY release, a tier crossed). A pill, not a
 *           card, parked by game/main.ts in the band beside the lap chip that
 *           nothing else in the HUD uses -- NEVER over the racing line and
 *           never over the position, the lap, the minimap, the items or the
 *           gauge. It reports something already banked, like PLATING HELD
 *           does, so it is the quietest thing on the screen and it is gone in
 *           under three seconds.
 *
 * Reduced motion, whichever of the OS setting or the game's own toggle says so,
 * turns every entrance into a plain appearance. The text is in a polite live
 * region either way, so a screen reader hears the news without being
 * interrupted mid-sentence by it.
 */
import { ACHIEVEMENT_BY_ID, frameOfAchievement, newsOf } from '../content/achievements'
import { medalInto, paintMedal } from './achievements'

export interface BadgeToasts {
  readonly root: HTMLElement
  /**
   * A menu-side toast for achievements that just unlocked -- or, WHILE A RACE
   * IS UP (a chip host is set), the chip instead. News can arrive mid-race from
   * outside the race (a sync landing, a profile crossing Tycoon), and a card in
   * the top corner is exactly where the minimap is.
   */
  show(ids: readonly string[]): void
  /** The in-race chip, placed in the chip host. Nothing without one. */
  chip(ids: readonly string[]): void
  /**
   * Where the chip lives, and whether a race is up: game/main.ts hands over
   * the HUD's lap column at the start of a race and null when it ends.
   */
  setChipHost(host: HTMLElement | null): void
  /** Drop anything showing -- a race starting, a screen leaving. */
  clear(): void
  setReducedMotion(on: boolean): void
  dispose(): void
}

/** How long a toast stands, and a chip, in milliseconds. */
export const TOAST_MS = 4200
export const CHIP_MS = 2600
/**
 * ONE CARD PER PIECE OF NEWS, and at most two on screen. A burst of unlocks --
 * the flag of a good race, a profile arriving -- is one card that names the
 * first and counts the rest, because a stack of four cards down a phone's top
 * edge is the title, the tab strip and half the first row gone for four
 * seconds (photographed at 390x844 before this rule: exactly that). A second
 * burst while the first is up stacks under it; a third replaces the oldest.
 */
const MAX_CARDS = 2

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls: string, parent?: Element, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  if (parent) parent.appendChild(node)
  return node
}

class BadgeToastsImpl implements BadgeToasts {
  readonly root: HTMLElement
  private readonly stack: HTMLElement
  private readonly live: HTMLElement
  private chipHost: HTMLElement | null = null
  private chipEl: HTMLElement | null = null
  private chipTimer = 0
  private readonly timers = new Set<number>()
  private rm = false

  constructor(container: HTMLElement) {
    const root = el('div', 'sgach-toasts', container)
    this.root = root
    this.stack = el('div', 'sgach-toasts__stack', root)
    // One live region for both presentations, outside anything that hides,
    // so an announcement is never swallowed by a hidden parent -- the silent
    // half of the bug frontend.ts documents for its own live region.
    this.live = el('div', 'sg-sr', root)
    this.live.setAttribute('role', 'status')
    this.live.setAttribute('aria-live', 'polite')
    this.syncMotion()
  }

  show(ids: readonly string[]): void {
    const list = newsOf(ids)
    if (list.length === 0) return
    if (this.chipHost) { this.chip(list); return }
    this.say(list)
    this.card(list)
  }

  chip(ids: readonly string[]): void {
    const list = newsOf(ids)
    if (list.length === 0 || !this.chipHost) return
    this.say(list)
    const a = ACHIEVEMENT_BY_ID.get(list[0])
    if (!a) return
    if (this.chipEl) this.chipEl.remove()
    const chip = el('div', 'sgach-chipToast', this.chipHost)
    chip.dataset.rm = this.rm ? 'on' : 'off'
    const m = medalInto(chip, a.badge, 26)
    paintMedal(m, frameOfAchievement(a), true)
    el('span', 'sgach-chipToast__name', chip, a.name.split(' · ')[0].toUpperCase())
    if (list.length > 1) el('span', 'sgach-chipToast__more', chip, `+${list.length - 1}`)
    this.chipEl = chip
    if (this.chipTimer) window.clearTimeout(this.chipTimer)
    this.chipTimer = window.setTimeout(() => {
      this.chipTimer = 0
      chip.remove()
      if (this.chipEl === chip) this.chipEl = null
    }, CHIP_MS)
  }

  setChipHost(host: HTMLElement | null): void {
    // A chip still standing belongs to the race that just ended -- including
    // on a restart, where the host is the same element and the race is not.
    if (this.chipTimer) { window.clearTimeout(this.chipTimer); this.chipTimer = 0 }
    if (this.chipEl) { this.chipEl.remove(); this.chipEl = null }
    this.chipHost = host
  }

  clear(): void {
    for (const t of this.timers) window.clearTimeout(t)
    this.timers.clear()
    this.stack.textContent = ''
    if (this.chipTimer) { window.clearTimeout(this.chipTimer); this.chipTimer = 0 }
    if (this.chipEl) { this.chipEl.remove(); this.chipEl = null }
  }

  setReducedMotion(on: boolean): void {
    this.rm = on
    this.syncMotion()
  }

  dispose(): void {
    this.clear()
    this.root.remove()
  }

  // -------------------------------------------------------------------------

  private syncMotion(): void {
    this.root.dataset.rm = this.rm ? 'on' : 'off'
  }

  /** One sentence for everything that just unlocked, whichever way it is shown. */
  private say(list: readonly string[]): void {
    const names = list.map((id) => ACHIEVEMENT_BY_ID.get(id)?.name ?? id)
    this.live.textContent = names.length === 1
      ? `Badge earned: ${names[0]}.`
      : `${names.length} badges earned: ${names.join(', ')}.`
  }

  /** One card for one burst: the first badge named, the rest counted. */
  private card(list: readonly string[]): void {
    const a = ACHIEVEMENT_BY_ID.get(list[0])
    if (!a) return
    // The oldest goes first when a third burst arrives. See MAX_CARDS.
    while (this.stack.childElementCount >= MAX_CARDS && this.stack.firstElementChild) {
      this.stack.firstElementChild.remove()
    }
    const card = el('div', 'sgach-toast', this.stack)
    const m = medalInto(card, a.badge, 36)
    paintMedal(m, frameOfAchievement(a), true)
    const text = el('div', 'sgach-toast__text', card)
    el('div', 'sgach-toast__eyebrow', text,
      list.length === 1 ? 'BADGE EARNED' : `${list.length} BADGES EARNED`)
    el('div', 'sgach-toast__name', text, a.name)
    if (list.length > 1) {
      const rest = list.length - 1
      el('div', 'sgach-toast__more', text, `+ ${rest} more ${rest === 1 ? 'badge' : 'badges'}`)
    }
    this.expire(card, TOAST_MS)
  }

  private expire(card: HTMLElement, ms: number): void {
    const t = window.setTimeout(() => {
      this.timers.delete(t)
      card.remove()
    }, ms)
    this.timers.add(t)
  }
}

export function createBadgeToasts(container: HTMLElement): BadgeToasts {
  return new BadgeToastsImpl(container)
}
