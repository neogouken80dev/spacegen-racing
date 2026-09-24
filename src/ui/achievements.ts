/**
 * achievements.ts — SpaceGen Racing's badge wall: every badge, framed.
 * ---------------------------------------------------------------------------
 * One view, mounted twice: as a screen of its own in the front end (reached
 * from the title), and as a tab of the in-race settings panel -- Vince asked
 * for both places, and two copies of one widget is the only way the two
 * cannot drift apart. Each is built once and repainted from the store on
 * entry, the rule every screen in this front end follows.
 *
 *   GLOBAL    the twenty-two, grouped by category so the wall reads by colour
 *             the way the art was painted to.
 *   TRACKS    a circuit picker, and that circuit's eight.
 *
 * A tile is a real <button>: pointer, touch, Enter, Space and the pad's A all
 * reach the same click, which opens the detail card. That is this front end's
 * whole accessibility strategy (frontend.ts's header) and the reason a LOCKED
 * tile is not `disabled` -- a disabled tile is one a keyboard or controller
 * player cannot reach to read, and reading what a badge asks for is the point
 * of it being on the wall. profile.ts argues the same about its portraits.
 *
 * ===========================================================================
 * THE FRAME IS THE GAME'S, THE IMAGE IS THE ART'S
 *
 * One image per badge; the ring is drawn here from content/achievements.ts's
 * `FrameKind`: the circuit's two tones on a track badge, the highest metal on
 * a tiered one (prism sweeping the drift-tier colours, held still under
 * reduced motion), the difficulty colours round Front Runner, the category
 * colour round a single, and a neutral ring round anything locked. A locked
 * badge's art is desaturated and dimmed but not hidden -- the brief asked that
 * it stay recognisable, and a wall of blank circles teaches nobody anything.
 */
import './achievements.css'
import {
  ACH_CIRCUITS, ACHIEVEMENT_BY_ID, BADGES, BADGE_BY_ID, CATEGORIES, CATEGORY_COLOR,
  CATEGORY_LABEL, DIFFICULTY_COLOR, GLOBAL_BADGES, TRACK_BADGES, achievementsOf,
  badgeArtFor, badgeView, completion, frameOfAchievement, LAP_TARGETS, newsOf, standInBadge,
  trackAchId,
  type AchievementSnapshot, type BadgeDef, type BadgeView, type FrameKind, type ProfileCounts,
} from '../content/achievements'
import { DIFFICULTIES, DIFFICULTY_SPECS } from '../content/difficulty'
import { sharedAchievements, type AchievementStore } from '../score/progress'
import { createTabs, type TabStrip } from './tabs'

export type AchievementsPage = 'global' | 'tracks'

export interface AchievementsViewOptions {
  /**
   * `screen` builds its own head with a Back button, for the front end.
   * `panel` builds none, for the settings dialog, which has a head already.
   */
  mode: 'screen' | 'panel'
  onBack?: () => void
  /** Injectable for tests; defaults to the process-wide store. */
  store?: AchievementStore
}

export interface AchievementsView {
  readonly root: HTMLElement
  /** Re-read the store and repaint everything. Cheap; call on every entry. */
  refresh(): void
  /** A profile arrived: Tycoon, Collector and the win/race floors read it. */
  setProfile(p: ProfileCounts | null): void
  readonly page: AchievementsPage
  showPage(id: AchievementsPage): void
  readonly circuit: string
  selectCircuit(id: string): void
  readonly detailOpen: boolean
  /**
   * Where focus may go right now: the detail card while it is open, the whole
   * view otherwise. For a host whose own focus walk has to respect the card.
   */
  readonly focusRoot: HTMLElement
  openDetail(badgeId: string, trackId?: string | null): void
  /** Close the detail card if it is open. True when there was one to close. */
  closeDetail(): boolean
  /**
   * Scroll the open card's ladder a step up (-1) or down (1); true when it
   * moved. The card's one control is Close, so up and down have nothing else
   * to do there, and on a landscape phone the ladder runs past the fold. The
   * arrow keys reach it on their own; a host's pad walk calls this.
   */
  scrollDetail(dir: number): boolean
  setReducedMotion(on: boolean): void
  dispose(): void
}

// ---------------------------------------------------------------------------
// DOM helpers, as profile.ts writes them
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

/** The pixel ratio, clamped: nothing is drawn sharper than 3x. */
function devicePixels(): number {
  const r = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  return Math.min(3, Math.max(1, r))
}

// ---------------------------------------------------------------------------
// The medal: art in a ring. Shared with the results strip and the toasts.
// ---------------------------------------------------------------------------

export interface Medal {
  root: HTMLElement
  ring: HTMLElement
  art: HTMLImageElement
}

/**
 * A badge's art inside the ring the game draws.
 *
 * `cssPx` is the size the host draws it at, and times the pixel ratio it picks
 * the file (`badgeArtFor` -> `artSizeFor`), exactly as `portraitInto` does for
 * a portrait: a 56px tile on a 3x phone fetches the 256, the detail card the
 * 512, and neither pays for the other.
 *
 * A file that fails to load falls back to the badge's stand-in -- the same
 * guard profile.ts puts on a portrait, for the same reason: one missing file in
 * a deploy is a blank circle in a grid of thirty, which reads as a layout bug.
 *
 * `sizedByCss` hands the drawn size to the stylesheet (a tile's medal shrinks
 * on a small screen); `cssPx` is then the LARGEST it is drawn at, which is the
 * size the file has to cover. Otherwise `cssPx` is the size, set inline.
 */
export function medalInto(
  host: HTMLElement, badgeId: string, cssPx: number, sizedByCss = false,
): Medal {
  const root = el('span', 'sgach-medal', host)
  if (!sizedByCss) root.style.setProperty('--m', cssPx + 'px')
  const ring = el('span', 'sgach-medal__ring', root)
  ring.setAttribute('aria-hidden', 'true')
  const art = el('img', 'sgach-medal__art', root)
  art.alt = ''
  art.decoding = 'async'
  art.draggable = false
  art.addEventListener('error', () => {
    // Keyed on the badge the image is CURRENTLY showing, because the detail
    // card reuses one medal for every badge it opens; a stand-in that itself
    // failed (it cannot -- it is inline -- but a guard costs one compare) is
    // left alone rather than retried for ever.
    const id = art.dataset.badge ?? badgeId
    const fallback = standInBadge(id)
    if (art.dataset.art === 'fallback' && art.src === fallback) return
    art.dataset.art = 'fallback'
    art.src = fallback
  })
  setMedalArt({ root, ring, art }, badgeId, cssPx)
  return { root, ring, art }
}

/** Point a medal at a badge's art for a given CSS size. */
export function setMedalArt(m: Medal, badgeId: string, cssPx: number): void {
  m.art.dataset.badge = badgeId
  delete m.art.dataset.art
  m.art.src = badgeArtFor(badgeId, cssPx * devicePixels())
}

/** Paint a medal's frame and its earned state. */
export function paintMedal(m: Medal, frame: FrameKind, earned: boolean): void {
  const r = m.root
  r.dataset.state = earned ? 'earned' : 'locked'
  r.dataset.frame = frame.kind === 'tier' ? frame.tier : frame.kind
  r.style.removeProperty('--glow')
  r.style.removeProperty('--ground')
  r.style.removeProperty('--ring')
  switch (frame.kind) {
    case 'track':
      r.style.setProperty('--glow', frame.glow)
      r.style.setProperty('--ground', frame.ground)
      break
    case 'single':
      r.style.setProperty('--ring', frame.color)
      break
    case 'difficulty':
      // Four segments, one per difficulty, lit in its colour when won.
      DIFFICULTIES.forEach((d, i) => {
        r.style.setProperty(`--d${i}`, frame.won.includes(d) ? DIFFICULTY_COLOR[d] : 'var(--sgach-unlit)')
      })
      break
    default:
      break
  }
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

interface Tile {
  root: HTMLButtonElement
  badge: BadgeDef
  medal: Medal
  name: HTMLElement
  tag: HTMLElement
  how: HTMLElement
  bar: HTMLElement
  fill: HTMLElement
  prog: HTMLElement
}

/** The largest a tile draws its medal; .sgach-tile .sgach-medal sizes it. */
const TILE_MEDAL_PX = 64
/** The same for the detail card's medal; .sgach__cardHead .sgach-medal. */
const CARD_MEDAL_PX = 132

function buildTile(grid: HTMLElement, b: BadgeDef): Tile {
  const root = button('sgach-tile', grid, '')
  root.dataset.badge = b.id
  root.style.setProperty('--cat', CATEGORY_COLOR[b.category])
  const medal = medalInto(root, b.id, TILE_MEDAL_PX, true)
  const text = el('span', 'sgach-tile__text', root)
  // THE TAG RIDES ABOVE THE NAME, NOT BESIDE IT. Beside it, on a four-across
  // desktop wall, SILVER / LOCKED / EARNED took the width the name needed and
  // twelve of twenty-two names printed as "Front R...", "Races ...": the
  // badge's own name was the thing the layout gave away. As an eyebrow the tag
  // costs one short line and the name gets the whole column, wrapping to two.
  const tag = el('span', 'sgach-tile__tag', text, '')
  const name = el('span', 'sgach-tile__name', text, b.name)
  const how = el('span', 'sgach-tile__how', text, '')
  const bar = el('span', 'sgach-tile__bar', text)
  const fill = el('span', 'sgach-tile__fill', bar)
  const prog = el('span', 'sgach-tile__prog', text, '')
  return { root, badge: b, medal, name, tag, how, bar, fill, prog }
}

function paintTile(t: Tile, v: BadgeView): void {
  t.root.dataset.state = v.earned ? 'earned' : 'locked'
  t.root.dataset.complete = v.complete ? '1' : '0'
  paintMedal(t.medal, v.frame, v.earned)
  t.tag.textContent = v.tag
  t.how.textContent = v.how
  t.prog.textContent = v.progressText
  // A bar only where there is partial credit worth showing -- the same rule
  // profile.ts applies to a portrait, and for the same reason: a single that
  // is simply not yet done has no "37%", and a creeping bar would imply one.
  const partial = v.progressText !== '' && !v.complete
  t.bar.hidden = !partial
  t.prog.hidden = v.progressText === ''
  t.fill.style.setProperty('--v', v.progress.toFixed(3))
  t.root.setAttribute('aria-label',
    `${t.badge.name}, ${v.tag.toLowerCase()}. ${v.how}${v.progressText ? ' ' + v.progressText + '.' : ''}`)
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

const PAGES: readonly { id: AchievementsPage; label: string }[] = [
  { id: 'global', label: 'Global' },
  { id: 'tracks', label: 'Tracks' },
]

class AchievementsViewImpl implements AchievementsView {
  readonly root: HTMLElement
  private readonly store: AchievementStore
  private profile: ProfileCounts | null = null
  private readonly tabs: TabStrip
  private readonly summary: HTMLElement
  private readonly summaryFill: HTMLElement
  private readonly globalTiles: Tile[] = []
  private readonly catCounts = new Map<string, HTMLElement>()
  private readonly trackTiles: Tile[] = []
  private readonly chips = new Map<string, { root: HTMLButtonElement; count: HTMLElement }>()
  private readonly circuitName: HTMLElement
  private readonly circuitCount: HTMLElement
  private cur: string = ACH_CIRCUITS[0].id

  // --- detail card ---------------------------------------------------------
  private readonly detail: HTMLElement
  private readonly dCard: HTMLElement
  private readonly dMedal: Medal
  private readonly dName: HTMLElement
  private readonly dCat: HTMLElement
  private readonly dHow: HTMLElement
  private readonly dBar: HTMLElement
  private readonly dFill: HTMLElement
  private readonly dProg: HTMLElement
  private readonly dList: HTMLElement
  private listSize: ResizeObserver | null = null
  private readonly dClose: HTMLButtonElement
  private detailFrom: HTMLElement | null = null
  private detailBadge = ''
  private detailTrack: string | null = null

  constructor(opts: AchievementsViewOptions) {
    this.store = opts.store ?? sharedAchievements()
    const root = el('div', 'sgach')
    root.dataset.mode = opts.mode
    this.root = root

    if (opts.mode === 'screen') {
      // The same head every front-end screen has: Back, title, and a spacer
      // so the title centres. See frontend.ts's track screen.
      const head = el('div', 'sg-head', root)
      const back = button('sg-btn sg-btn--ghost', head, 'Back')
      back.dataset.sfx = 'back'
      el('div', 'sg-head__title', head, 'ACHIEVEMENTS')
      const spacer = el('div', '', head)
      spacer.style.width = '1px'
      back.addEventListener('click', () => opts.onBack?.())
    }

    const top = el('div', 'sgach__summary', root)
    this.summary = el('div', 'sgach__summaryText', top, '')
    this.summary.setAttribute('role', 'status')
    const sbar = el('div', 'sgach__summaryBar', top)
    this.summaryFill = el('div', 'sgach__summaryFill', sbar)

    const pagesHost = el('div', 'sgach__pages', root)
    this.tabs = createTabs(pagesHost, PAGES)
    // Addressable by id rather than by visible label, as profile.ts does it:
    // a probe that matched a label would break on a copy pass.
    const tabBtns = this.tabs.root.querySelectorAll<HTMLElement>('.sg-tab')
    PAGES.forEach((p, i) => { if (tabBtns[i]) tabBtns[i].dataset.tab = p.id })

    // --- GLOBAL -------------------------------------------------------------
    const g = el('div', 'sgach__page', this.tabs.panel('global'))
    g.dataset.page = 'global'
    for (const cat of CATEGORIES) {
      const badges = GLOBAL_BADGES.filter((b) => b.category === cat)
      if (badges.length === 0) continue
      const sec = el('section', 'sgach__cat', g)
      sec.style.setProperty('--cat', CATEGORY_COLOR[cat])
      const h = el('div', 'sgach__catHead', sec)
      el('h3', 'sgach__catTitle', h, CATEGORY_LABEL[cat])
      this.catCounts.set(cat, el('div', 'sgach__catCount', h, ''))
      const grid = el('div', 'sgach__grid', sec)
      for (const b of badges) {
        const t = buildTile(grid, b)
        t.root.addEventListener('click', () => this.openDetail(b.id, null, t.root))
        this.globalTiles.push(t)
      }
    }

    // --- TRACKS -------------------------------------------------------------
    const tp = el('div', 'sgach__page', this.tabs.panel('tracks'))
    tp.dataset.page = 'tracks'
    const picker = el('div', 'sgach__circuits', tp)
    picker.setAttribute('role', 'group')
    picker.setAttribute('aria-label', 'Circuit')
    for (const c of ACH_CIRCUITS) {
      const chip = button('sgach-chip', picker, '')
      chip.dataset.circuit = c.id
      chip.style.setProperty('--glow', c.glow)
      chip.style.setProperty('--ground', c.ground)
      el('span', 'sgach-chip__ring', chip).setAttribute('aria-hidden', 'true')
      el('span', 'sgach-chip__name', chip, c.name)
      const count = el('span', 'sgach-chip__count', chip, '')
      chip.addEventListener('click', () => this.selectCircuit(c.id))
      this.chips.set(c.id, { root: chip, count })
    }
    const ch = el('div', 'sgach__circuitHead', tp)
    this.circuitName = el('h3', 'sgach__circuitName', ch, '')
    this.circuitCount = el('div', 'sgach__catCount', ch, '')
    const tgrid = el('div', 'sgach__grid', tp)
    for (const b of TRACK_BADGES) {
      const t = buildTile(tgrid, b)
      t.root.addEventListener('click', () => this.openDetail(b.id, this.cur, t.root))
      this.trackTiles.push(t)
    }

    // --- DETAIL -------------------------------------------------------------
    // Inside the view rather than a document-level modal, so it lives and
    // dies with whichever host the view is mounted in -- the front end's
    // screen or the settings dialog -- and inherits that host's focus rules.
    this.detail = el('div', 'sgach__detail', root)
    this.detail.hidden = true
    const scrim = el('div', 'sgach__detailScrim', this.detail)
    scrim.addEventListener('click', () => this.closeDetail())
    const card = el('div', 'sgach__card sg-panel', this.detail)
    this.dCard = card
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-modal', 'true')
    card.setAttribute('aria-label', 'Badge detail')
    const cardHead = el('div', 'sgach__cardHead', card)
    this.dMedal = medalInto(cardHead, 'track-victory', CARD_MEDAL_PX, true)
    const cardText = el('div', 'sgach__cardText', cardHead)
    this.dCat = el('div', 'sgach__cardCat', cardText, '')
    this.dName = el('div', 'sgach__cardName', cardText, '')
    this.dHow = el('div', 'sgach__cardHow', cardText, '')
    this.dBar = el('div', 'sgach-tile__bar sgach__cardBar', cardText)
    this.dFill = el('span', 'sgach-tile__fill', this.dBar)
    this.dProg = el('div', 'sgach__cardProg', cardText, '')
    this.dList = el('ul', 'sgach__list', card)
    // Which ends of the ladder have more past them, for the stylesheet's fade:
    // on a landscape phone the list can stop exactly on a row boundary, and a
    // clean edge there reads as the end of the ladder (photographed: six
    // circuits of eight, and nothing to say two more were below).
    this.dList.addEventListener('scroll', () => this.syncListEdge(), { passive: true })
    if (typeof ResizeObserver === 'function') {
      this.listSize = new ResizeObserver(() => this.syncListEdge())
      this.listSize.observe(this.dList)
    }
    this.dClose = button('sg-btn sg-btn--ghost sgach__close', card, 'Close')
    this.dClose.dataset.sfx = 'back'
    this.dClose.addEventListener('click', () => this.closeDetail())
    // ESCAPE CLOSES THE CARD, NOT THE SCREEN BEHIND IT. Stopped here so the
    // front end's window listener and the settings dialog's own handler never
    // see it -- each would otherwise take the player a whole screen further
    // back than they asked. Tab is kept inside the card for the same reason.
    this.detail.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        this.closeDetail()
      } else if (e.key === 'Tab') {
        // One focusable control, so Tab has nowhere else to go. Stopped so the
        // settings dialog's focus trap does not walk out of the card.
        e.preventDefault()
        e.stopPropagation()
        this.dClose.focus()
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'PageUp' || e.key === 'PageDown') {
        // Up and down scroll the ladder, the one part of the card that moves.
        // Focus is on Close, outside the list, so the browser's own arrow
        // scrolling would never reach it.
        e.preventDefault()
        e.stopPropagation()
        this.scrollDetail(e.key === 'ArrowUp' || e.key === 'PageUp' ? -1 : 1)
      } else if (e.key.startsWith('Arrow')) {
        // The front end walks focus spatially on the arrows, and the tiles
        // behind the scrim are still laid out. Nothing in the card uses left
        // or right, so they simply go no further.
        e.stopPropagation()
      }
    })

    this.refresh()
  }

  get page(): AchievementsPage { return this.tabs.selected as AchievementsPage }
  get circuit(): string { return this.cur }
  get detailOpen(): boolean { return !this.detail.hidden }
  get focusRoot(): HTMLElement { return this.detail.hidden ? this.root : this.detail }

  showPage(id: AchievementsPage): void { this.tabs.select(id) }

  setProfile(p: ProfileCounts | null): void {
    this.profile = p
    this.refresh()
  }

  setReducedMotion(on: boolean): void {
    this.root.dataset.rm = on ? 'on' : 'off'
  }

  selectCircuit(id: string): void {
    if (!ACH_CIRCUITS.some((c) => c.id === id)) return
    this.cur = id
    this.refresh()
  }

  refresh(): void {
    const s = this.store.snapshot
    const p = this.profile ?? this.store.knownProfile
    const all = completion(s)
    this.summary.textContent = `${all.earned} of ${all.total} achievements earned`
    this.summaryFill.style.setProperty('--v', (all.earned / all.total).toFixed(3))

    for (const t of this.globalTiles) paintTile(t, badgeView(t.badge, s, p))
    for (const cat of CATEGORIES) {
      const host = this.catCounts.get(cat)
      if (!host) continue
      const ids = BADGES.filter((b) => b.category === cat && b.kind !== 'track').flatMap((b) => achievementsOf(b.id))
      const n = ids.filter((a) => s.unlocked.includes(a.id)).length
      host.textContent = `${n} / ${ids.length}`
    }

    const c = ACH_CIRCUITS.find((x) => x.id === this.cur) ?? ACH_CIRCUITS[0]
    for (const t of this.trackTiles) paintTile(t, badgeView(t.badge, s, p, c.id))
    for (const [id, chip] of this.chips) {
      const done = completion(s, id)
      chip.count.textContent = `${done.earned}/${done.total}`
      const on = id === c.id
      chip.root.classList.toggle('is-on', on)
      chip.root.setAttribute('aria-pressed', on ? 'true' : 'false')
      const name = ACH_CIRCUITS.find((x) => x.id === id)?.name ?? id
      chip.root.setAttribute('aria-label', `${name}, ${done.earned} of ${done.total} earned`)
    }
    this.circuitName.textContent = c.name
    const here = completion(s, c.id)
    this.circuitCount.textContent = `${here.earned} / ${here.total}`

    if (this.detailOpen) this.fillDetail(s, p)
  }

  openDetail(badgeId: string, trackId: string | null = null, from?: HTMLElement): void {
    if (!BADGE_BY_ID.has(badgeId)) return
    this.detailBadge = badgeId
    this.detailTrack = trackId
    this.detailFrom = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    this.detail.hidden = false
    this.fillDetail(this.store.snapshot, this.profile ?? this.store.knownProfile)
    // Opened at the top of its ladder, with focus on Close without scrolling
    // anything to reach it: on a landscape phone a plain focus() scrolled the
    // card to the button and cut the badge's name off (photographed). The
    // stylesheet now keeps the head and Close fixed and scrolls the list.
    this.dList.scrollTop = 0
    this.syncListEdge()
    this.dClose.focus({ preventScroll: true })
  }

  closeDetail(): boolean {
    if (this.detail.hidden) return false
    this.detail.hidden = true
    const back = this.detailFrom
    this.detailFrom = null
    if (back && back.isConnected) back.focus()
    return true
  }

  scrollDetail(dir: number): boolean {
    if (this.detail.hidden || dir === 0) return false
    const l = this.dList
    const before = l.scrollTop
    // Most of what shows, so every press brings new rows up and keeps one of
    // the old ones to read them against. Instant, which is also what reduced
    // motion asks for.
    l.scrollTop = before + Math.sign(dir) * Math.max(44, Math.round(l.clientHeight * 0.7))
    return l.scrollTop !== before
  }

  /** `data-edge` on the ladder: none, down, up or both -- where more rows are. */
  private syncListEdge(): void {
    const l = this.dList
    if (this.detail.hidden) return
    const more = l.scrollHeight - l.clientHeight - l.scrollTop > 1
    const less = l.scrollTop > 1
    const edge = more && less ? 'both' : more ? 'down' : less ? 'up' : 'none'
    if (l.dataset.edge !== edge) l.dataset.edge = edge
  }

  private fillDetail(s: AchievementSnapshot, p: ProfileCounts | null): void {
    const b = BADGE_BY_ID.get(this.detailBadge)
    if (!b) return
    const v = badgeView(b, s, p, this.detailTrack)
    if (this.dMedal.art.dataset.badge !== b.id) setMedalArt(this.dMedal, b.id, CARD_MEDAL_PX)
    paintMedal(this.dMedal, v.frame, v.earned)
    const circuit = b.kind === 'track' ? ACH_CIRCUITS.find((c) => c.id === this.detailTrack) : null
    this.dName.textContent = circuit ? `${b.name} · ${circuit.name}` : b.name
    this.dCat.textContent = `${CATEGORY_LABEL[b.category]} · ${v.tag}`
    // On the whole card, so its eyebrow AND its bar wear the category.
    this.dCard.style.setProperty('--cat', CATEGORY_COLOR[b.category])
    this.dHow.textContent = v.how
    this.dProg.textContent = v.progressText
    this.dProg.hidden = v.progressText === ''
    this.dBar.hidden = v.progressText === '' || v.complete
    this.dFill.style.setProperty('--v', v.progress.toFixed(3))

    // THE WHOLE LADDER, not just the next rung: every tier with its number,
    // every difficulty, or every circuit this badge can be earned on -- so the
    // card answers "where have I got this" as well as "what is next".
    this.dList.textContent = ''
    // The stylesheet sizes the name column by what goes in it: a circuit's
    // name, or one short tier word.
    this.dList.dataset.kind = b.kind
    const have = new Set(s.unlocked)
    if (b.kind === 'track') {
      // Each circuit in its own two tones -- the ring the badge wears there --
      // and no sentence, which would be the same "Win a race." eight times.
      // Lap Record is the exception: its sentence IS the target.
      for (const c of ACH_CIRCUITS) {
        const a = ACHIEVEMENT_BY_ID.get(trackAchId(b.id, c.id))
        if (!a) continue
        const detail = b.id === 'track-laprecord' ? `under ${LAP_TARGETS[c.id].toFixed(1)}\u00a0s` : ''
        this.listRow(c.name, detail, have.has(a.id), c.id === this.detailTrack,
          { glow: c.glow, ground: c.ground })
      }
    } else if (b.kind === 'difficulty') {
      // Each difficulty in its own colour, which is how the ring above reads.
      for (const d of DIFFICULTIES) {
        this.listRow(DIFFICULTY_SPECS[d].label, '', have.has(`${b.id}:${d}`), false,
          { color: DIFFICULTY_COLOR[d] })
      }
    } else if (b.kind === 'tiered') {
      for (const a of achievementsOf(b.id)) {
        const earned = have.has(a.id) || v.tier >= a.tier
        this.listRow(a.name.split(' · ')[1] ?? a.name, a.how, earned, false, null)
      }
    }
    this.dList.hidden = this.dList.childElementCount === 0
    this.syncListEdge()
  }

  private listRow(
    label: string, detail: string, earned: boolean, current: boolean,
    swatch: { glow: string; ground: string } | { color: string } | null,
  ): void {
    const li = el('li', 'sgach__row', this.dList)
    li.dataset.state = earned ? 'earned' : 'locked'
    if (current) li.classList.add('is-current')
    if (!detail) li.classList.add('is-bare')
    el('span', 'sgach__rowMark', li, earned ? '✓' : '').setAttribute('aria-hidden', 'true')
    const name = el('span', 'sgach__rowName', li)
    if (swatch) {
      const sw = el('span', 'sgach__rowSwatch', name)
      sw.setAttribute('aria-hidden', 'true')
      if ('color' in swatch) {
        sw.style.setProperty('--glow', swatch.color)
        sw.style.setProperty('--ground', swatch.color)
      } else {
        sw.style.setProperty('--glow', swatch.glow)
        sw.style.setProperty('--ground', swatch.ground)
      }
    }
    name.appendChild(document.createTextNode(label))
    el('span', 'sgach__rowHow', li, detail)
    el('span', 'sgach__rowState', li, earned ? 'Earned' : 'Locked')
  }

  dispose(): void {
    this.tabs.dispose()
    this.listSize?.disconnect()
    this.listSize = null
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root)
  }
}

export function createAchievementsView(opts: AchievementsViewOptions): AchievementsView {
  return new AchievementsViewImpl(opts)
}

// ---------------------------------------------------------------------------
// The results screen's strip
// ---------------------------------------------------------------------------

/**
 * "NEW BADGES": what this race unlocked, in one row under the result.
 *
 * Built as a function the front end calls with a host and a list, rather than
 * as part of the view, because it belongs to the RESULTS screen's life cycle
 * (filled on every showResults, empty and absent on most races) and not to
 * the wall's. Each entry is the badge's own medal in the frame this
 * particular achievement earned -- Elkarim's ring for Clean Lap on Elkarim,
 * silver for Knockouts silver -- so the strip says WHAT was earned at a
 * glance, not just that something was.
 */
export function fillUnlockStrip(host: HTMLElement, ids: readonly string[]): void {
  host.textContent = ''
  // As news: two tiers of one badge crossed in one race is one entry, the
  // higher. See `newsOf`.
  const list = newsOf(ids)
  host.hidden = list.length === 0
  if (list.length === 0) return
  const head = el('div', 'sgach-strip__head', host)
  el('span', 'sgach-strip__title', head, list.length === 1 ? 'NEW BADGE' : 'NEW BADGES')
  el('span', 'sgach-strip__count', head, String(list.length))
  const row = el('ul', 'sgach-strip__row', host)
  row.setAttribute('aria-label', `${list.length} new ${list.length === 1 ? 'badge' : 'badges'}`)
  for (const id of list) {
    const a = ACHIEVEMENT_BY_ID.get(id)
    if (!a) continue
    const li = el('li', 'sgach-strip__item', row)
    li.title = a.name
    // Sized by the stylesheet (44px; smaller on a landscape phone), with art
    // picked for the larger.
    const m = medalInto(li, a.badge, 44, true)
    paintMedal(m, frameOfAchievement(a), true)
    // The badge, then what distinguishes this one -- the circuit, the tier,
    // the difficulty -- on a line of its own. As one string it broke at the
    // middle dot on a narrow item ("Races Finished" / "· Bronze").
    const [badge, qualifier] = a.name.split(' · ')
    const nm = el('span', 'sgach-strip__name', li)
    el('span', 'sgach-strip__badge', nm, badge)
    if (qualifier) el('span', 'sgach-strip__qual', nm, qualifier)
  }
}
