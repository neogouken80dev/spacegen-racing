/**
 * profile.ts — SpaceGen Racing player profile: identity, and the three things
 * a player owns.
 * ---------------------------------------------------------------------------
 * One head, one identity card, and a tabbed body:
 *
 *   IDENTITY   the portrait the player wears, the name they are claiming, what
 *              the account service will and will not do for them right now,
 *              and the wallet every page spends from. NOT a tab -- see below.
 *   PORTRAIT   all twenty-four portraits from content/avatars.ts, each one
 *              owned, buyable or locked-with-a-reason. Nothing is hidden.
 *   VEHICLE    the five chassis, with the live car turning above them.
 *   PILOT      the six pilots and the one thing each of them does.
 *
 * ===========================================================================
 * WHY THE GARAGE STILL EXISTS, AND WHAT IT SHARES WITH THIS SCREEN
 *
 * The garage is a step on the way to a race: pick a planet, pick a car, press
 * Start. This screen is a place you go on purpose. Both now offer the same
 * choice, which is exactly the situation that produces two ids that disagree,
 * so the rule is stated once and obeyed everywhere:
 *
 *   THERE IS ONE SELECTION. IT LIVES IN THE FRONT END.
 *
 * `FrontEndImpl.chassisId` / `.pilotId` are the only storage, `selectChassis`
 * and `selectPilot` are the only writers, and `LS_CHASSIS` / `LS_PILOT` are
 * the only persistence. This screen owns no copy of either: it READS through
 * `deps.loadout()` and WRITES through `deps.setLoadout()`, which is the front
 * end's own writer under a different name. The garage's cards and this
 * screen's tiles are two views of one field, so there is no version of "the
 * profile says Bulwark and the lobby says Solaire" available to happen.
 *
 * The rejected alternative was a profile DEFAULT that the garage could
 * override per race. It sounds accommodating and it is the bug: two values,
 * two writers, and no answer at all to "which one does a lobby member's
 * chassisId follow". See frontend.ts's note on publishLoadout() for what this
 * screen changing a car does to a room the player is sitting in.
 *
 * ===========================================================================
 * WHY IDENTITY IS NOT A TAB
 *
 * Three reasons, and each one is a bug avoided rather than a preference:
 *
 *   1. THE BANNERS GOVERN MORE THAN ONE PAGE. `offline` means no name can be
 *      claimed and nothing the ACCOUNT holds can be equipped or bought -- a
 *      portrait today, a livery next pass. A banner hidden behind a tab is a
 *      fact the screen knew and did not say, and the player finds it out by
 *      pressing something that then refuses. (What `offline` does NOT stop is
 *      picking a car: see the `held` parameter on `refuse`.)
 *   2. CREDITS ARE THE PRICE CONTEXT FOR EVERY SHOP ROW. A 4,000 cr portrait
 *      -- and, next pass, a 4,000 cr livery -- is only a decision next to a
 *      balance. Making the player flip tabs to compare the two numbers is
 *      making them hold one in their head.
 *   3. A HALF-TYPED NAME MUST SURVIVE A TAB PRESS. tabs.ts hides an off panel
 *      with `hidden`, deliberately, so nothing inside it stays focusable --
 *      which is right, and which would also mean an unsaved name field went
 *      away and came back empty-ish under the player. Outside the panels it
 *      cannot happen at all, rather than being made not to happen.
 *
 * ===========================================================================
 * THE THREE THINGS THIS SCREEN EXISTS TO GET RIGHT
 *
 * 1. `offline` AND `ephemeral` ARE DIFFERENT SENTENCES. The contract spends a
 *    paragraph on this (see `AccountService` in net/types.ts) and it is right:
 *    "the server is unreachable, so your name is not claimed and you cannot
 *    spend" and "this browser is blocking storage, so this profile disappears
 *    when you close the tab" are different facts with different fixes, both are
 *    common, and a single merged message is wrong in one of the two cases. They
 *    are two banners here, they can both be up at once, and neither is phrased
 *    in terms of the other.
 *
 * 2. EVERY `NameError` REACHES THE PLAYER. `NAME_ERROR` below is a
 *    `Record<NameError, string>`, so the compiler refuses a build that adds a
 *    sixth case and forgets the sentence for it -- which is the entire reason
 *    the contract bothered to name the error set on `setName`'s signature.
 *    tools/probe-lobby.mjs drives all five to the screen for real.
 *
 * 3. A LOCKED TILE IS NOT AN INERT TILE. Locked tiles stay pressable and answer
 *    with their requirement, because avatars.ts's whole argument for returning
 *    locked rows rather than hiding them is that the requirement sentence is
 *    what makes a shop honest rather than teasing. What a locked tile must
 *    never do is reach the thing that equips it -- the server would refuse and
 *    the player would get a network error where they should have got a reason.
 *    `refuse()` below is that guard, written once so every page has it,
 *    including the ones that do not exist yet.
 *
 * Built once in the constructor, like every other screen in this front end.
 * enter()/exit() refresh text and start/stop nothing heavier than a request --
 * with one exception, the vehicle page's WebGL context. See `syncPreview`.
 */
import './profile.css'
import { accountService } from '../net'
import {
  NAME_RULES,
  type AccountService, type AvatarDef, type NameError, type PlayerProfile,
} from '../net/types'
import {
  AVATARS, AVATAR_BY_ID, DEFAULT_AVATAR_ID, catalogueFor, placeholderPortrait,
  portraitFor, type AvatarStatus, type AvatarView,
} from '../content/avatars'
import { CHASSIS, CHASSIS_BY_ID } from '../content/chassis'
import { PILOTS, PILOTS_BY_ID } from '../content/pilots'
import type { QualityTier } from '../render/api'
import { createGaragePreview, type GaragePreview, type GaragePreviewOpts } from './garagePreview'
import { createTabs, type TabStrip } from './tabs'
import {
  FINISH_CREDITS, MAX_PER_RACE, REF_SCORE, SKILL_CREDITS,
} from '../score/wallet'

/** The one car-and-pilot choice, as this screen reads and writes it. */
export interface Loadout {
  chassisId: string
  pilotId: string
}

export interface ProfileScreen {
  /** The element the front end drops into its screen container. */
  root: HTMLElement
  /** The screen is now visible: refresh from the server. */
  enter(): void
  /**
   * Load the account if it has never been loaded, and do nothing otherwise.
   *
   * For the front end's way INTO multiplayer. The lobby needs a claimed name
   * and an account id before it can default a lobby name or mark the player's
   * own rows, and it should not have to wait for somebody to open this screen
   * to get them. Idempotent, and it is the ONLY thing that may create an
   * account service before the player has asked for one -- see the note about
   * boot cost in frontend.ts's header.
   */
  prime(): void
  /** The screen is no longer visible. */
  exit(): void
  /** The profile as last seen, or null before the first load resolves. */
  readonly profile: PlayerProfile | null
  /** Which page is open. For the host, and for a probe. */
  readonly tab: PageId
  /** Open a page. Ignored for a page that does not exist. */
  showTab(id: PageId): void
  /** Fired on every profile change, including the first load. */
  onProfile: (p: PlayerProfile) => void
  dispose(): void
}

export interface ProfileDeps {
  /** Where the Back button goes. */
  onBack(): void
  /**
   * The car and pilot in force. READ EVERY TIME, never cached here: the
   * garage writes the same field and this screen must not hold a stale copy
   * of it. See the header.
   */
  loadout(): Loadout
  /** Ask the front end to change it. The front end is the only writer. */
  setLoadout(next: Loadout): void
  /** The render tier the garage is set to, so the box here costs the same. */
  quality(): QualityTier
  /** Injectable, so tests and probes can have this screen without a GPU. */
  makeStage?: GaragePreviewOpts['makeStage']
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export type PageId = 'portrait' | 'vehicle' | 'pilot'

/**
 * THE STRIP IS DATA, and adding a page is an entry here plus the code that
 * fills `this.page(id).grid`. ui/tabs.ts hard-codes no count: the strip wraps,
 * the arrow keys walk whatever exists, and the panels come from this array.
 *
 * `lede` is not decoration. Three of the words on this screen -- portrait,
 * pilot, and the face painted on the pilot -- are near enough to each other
 * that a player can reasonably wonder which one they are choosing. One line
 * per page saying WHERE the choice shows up settles it cheaper than renaming
 * anything.
 */
const PAGES: readonly { id: PageId; label: string; title: string; lede: string }[] = [
  {
    id: 'portrait',
    label: 'Portrait',
    title: 'PORTRAITS',
    lede: 'Your face in a lobby list and on the nameplate over your car.',
  },
  {
    id: 'vehicle',
    label: 'Vehicle',
    title: 'CHASSIS',
    lede: 'The car you race. The garage has its numbers; this is which one it is.',
  },
  {
    id: 'pilot',
    label: 'Pilot',
    title: 'PILOTS',
    lede: 'Who sits in it, and the one thing they do that the stat bars cannot show.',
  },
]

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/**
 * One sentence per `NameError`, and the compiler holds the file to it.
 *
 * A `Record<NameError, string>` rather than a switch with a default: a switch
 * with a default compiles happily when the union grows, and the sixth case then
 * arrives at the player as whatever the default says. This does not build.
 *
 * The wording tracks `checkNameShape`'s order in net/mock.ts -- length first,
 * then charset -- because that is the order the player will meet them in and a
 * message about allowed characters for the name "a" would be true and useless.
 */
const NAME_ERROR: Record<NameError, string> = {
  short: `Too short — at least ${NAME_RULES.min} characters.`,
  long: `Too long — at most ${NAME_RULES.max} characters.`,
  charset:
    'Letters and digits, with single spaces, dots, dashes or underscores between them.',
  taken: 'Somebody already has that name. Try another.',
  offline: 'The server did not answer, so the name was not claimed. Your old one still stands.',
}

/**
 * The failures `setAvatar` and `buyAvatar` can hand back.
 *
 * These are `Result<T, string>` in the contract rather than a named union --
 * deliberately, because unlike `NameError` they are mostly conditions the UI
 * has already prevented and the list is the mock's business, not the screen's.
 * So this is a lookup with a fallback rather than a Record: an unknown code
 * gets a sentence, not a blank.
 */
const SHOP_ERROR: Record<string, string> = {
  offline: 'The server is out of reach, so nothing can be spent or equipped right now.',
  unreachable: 'The server did not answer. Nothing was spent — try again.',
  notloaded: 'Your profile has not finished loading yet.',
  locked: 'That portrait is not unlocked yet.',
  credits: 'Not enough credits for that one.',
  owned: 'You already own that one.',
  notforsale: 'That portrait is not for sale at any price — it has to be earned.',
  unknown: 'That portrait is not in this build.',
  invalid: 'The server refused that.',
}

const shopError = (code: string): string =>
  SHOP_ERROR[code] ?? `The server refused that (${code}).`

/**
 * What the locomotion of a chassis actually costs and buys.
 *
 * SHORTER THAN THE GARAGE'S. frontend.ts's `LOCO_NOTE` is the full paragraph
 * and belongs there, next to the six stat bars it is arguing with. Here the
 * job is to tell twelve tiles apart, so it is one clause per mode.
 */
const LOCO_LINE: Record<string, string> = {
  grounded: 'Grounded — full grip, the kindest drift, and it cannot cross a gap.',
  hover: 'Hover — ignores the surface and clears small gaps; gets shoved much harder.',
  flight: 'Flight — spends Lift to leave the track entirely. Its own route, its own risk.',
}

/** Thousands separators without building an Intl formatter per call. */
function comma(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** #rrggbb from the 0xRRGGBB integers content/ stores its colours as. */
function hex(n: number): string {
  return '#' + n.toString(16).padStart(6, '0')
}

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

/**
 * A portrait that survives its own art going missing.
 *
 * `portraitFor` hands back a generated data URI today and a real PNG path the
 * day `ART_READY` flips, and the flip is exactly when a 404 becomes possible:
 * one file missing from `public/avatars/` renders as an empty circle in a grid
 * of twenty-four, which reads as a layout bug rather than as a missing file.
 * So the error handler swaps in the placeholder that the same module already
 * knows how to draw -- the picker degrades to how it looks today instead of to
 * a hole -- and marks the element so a probe can tell the two apart.
 *
 * `tried` guards against an error handler that re-fires on its own replacement,
 * which would be an infinite loop rather than a fallback.
 */
function portraitInto(host: HTMLElement, def: AvatarDef): HTMLImageElement {
  const img = el('img', 'sgpf__art', host)
  let tried = false
  img.decoding = 'async'
  img.alt = ''
  img.dataset.art = 'primary'
  img.addEventListener('error', () => {
    if (tried) return
    tried = true
    img.dataset.art = 'fallback'
    img.src = placeholderPortrait(def)
  })
  img.src = portraitFor(def)
  return img
}

/** The garage's two-colour card chip, at tile size. A car has no photograph. */
function chipInto(host: HTMLElement, c1: number, c2: number): HTMLElement {
  const chip = el('span', 'sgpf__chip', host)
  chip.style.setProperty('--c1', hex(c1))
  chip.style.setProperty('--c2', hex(c2))
  return chip
}

// ---------------------------------------------------------------------------
// Tiles
//
// ONE TILE, THREE CATALOGUES, AND ROOM FOR THE FOURTH. Every page on this
// screen is a grid of the same button: a piece of art, a name, a corner tag, a
// requirement sentence and a progress bar. That is not tidiness for its own
// sake -- it is what makes "a swatch row drops in" true. A paint catalogue is
// a `TileView` per swatch and one `addGrid()` call, not a new page type.
// ---------------------------------------------------------------------------

/** What a tile looks like right now, whatever kind of thing it stands for. */
interface TileView {
  /** The same three states `AvatarView` uses, because they are the only three. */
  status: AvatarStatus
  /** The sentence under the name. Empty for nothing left to say. */
  requirement: string
  /** 0..1. A bar is drawn only for a genuine partial -- see `paintTile`. */
  progress: number
  /** The corner label: a price, RANK, FEAT, a locomotion, the equipped word. */
  tag: string
  /** This is the one in use. */
  equipped: boolean
}

interface Tile {
  root: HTMLButtonElement
  id: string
  /** For the accessible name and for the message line. */
  label: string
  req: HTMLElement
  bar: HTMLElement
  tag: HTMLElement
}

/**
 * Draw one tile.
 *
 * Deliberately dumb: everything that needed a decision was made by whoever
 * built the `TileView`. The page-specific knowledge -- what a price reads as,
 * what the word for "equipped" is on this page -- lives with the page, so a
 * new catalogue cannot get the SHAPE wrong, only its own wording.
 */
function paintTile(tile: Tile, v: TileView): void {
  const t = tile.root
  t.dataset.status = v.status
  t.classList.toggle('is-on', v.equipped)
  if (v.equipped) t.setAttribute('aria-current', 'true')
  else t.removeAttribute('aria-current')

  tile.req.textContent = v.requirement
  tile.tag.textContent = v.tag

  // A bar only where partial credit is a real thing. avatars.ts returns 0 for
  // a feat precisely because a creeping bar would imply one.
  const showBar = v.status !== 'owned' && v.progress > 0 && v.progress < 1
  tile.bar.hidden = !showBar
  tile.bar.style.setProperty('--v', v.progress.toFixed(3))

  // The accessible name carries the state and the reason, because the tick,
  // the ring and the tag are all things a screen reader cannot see.
  const state = v.equipped ? 'in use' : v.status
  t.setAttribute('aria-label',
    `${tile.label}, ${state}${v.requirement ? '. ' + v.requirement : ''}`)
}

// ---------------------------------------------------------------------------

/** One page's furniture. The grid is filled by whoever asked for the page. */
interface Page {
  id: PageId
  root: HTMLElement
  count: HTMLElement
  msg: HTMLElement
  /** Where the selected thing is described in full. */
  now: HTMLElement
  grid: HTMLElement
  /**
   * =========================================================================
   * PAINT AND TRIM DROP IN HERE.
   * =========================================================================
   * Empty today, and `:empty { display: none }` in profile.css so it costs
   * nothing until it is used. The next pass adds liveries to the vehicle page
   * and colour schemes to the pilot page, bought with credits, in the same
   * four-source shape avatars already use (`AvatarSource` in net/types.ts:
   * starter / shop / rank / feat). The whole of adding one is:
   *
   *     const paint = this.addGrid(this.page('vehicle').more, 'PAINT', 'paint')
   *     for (const p of LIVERIES) this.addTile(paint, { ... })
   *
   * and a `TileView` per swatch in `apply()`. Nothing on this page has to
   * move, the tab does not have to be rebuilt, and the locked-cannot-equip
   * guard (`refuse`) is already the shared one every grid goes through.
   *
   * It goes AFTER the chassis grid rather than beside it because paint is a
   * second catalogue of a second kind of thing, with its own head, its own
   * count and its own "what is locked" sentence -- the same relationship the
   * portraits page has to nothing, which is why that page's `more` stays
   * empty.
   */
  more: HTMLElement
}

class ProfileScreenImpl implements ProfileScreen {
  readonly root: HTMLElement
  onProfile: (p: PlayerProfile) => void = () => {}

  private readonly deps: ProfileDeps

  /**
   * The account service, created on FIRST USE and not before.
   *
   * `accountService()` builds the mock account service, and building one asks
   * net/index.ts for the shared world -- which seeds a directory and starts a
   * 1600ms clock. Doing that in a field initialiser would mean every player who
   * launches the game and presses PLAY pays for a multiplayer world they never
   * open. net/index.ts makes exactly this argument for its own laziness; this
   * is the call site honouring it.
   */
  private acct: AccountService | null = null
  private p: PlayerProfile | null = null

  private readonly portrait: HTMLElement
  private readonly portraitName: HTMLElement
  private readonly nameInput: HTMLInputElement
  private readonly claimBtn: HTMLButtonElement
  private readonly nameMsg: HTMLElement
  private readonly offlineBox: HTMLElement
  private readonly ephemeralBox: HTMLElement
  private readonly retryBtn: HTMLButtonElement
  private readonly credits: HTMLElement
  private readonly earned: HTMLElement
  private readonly races: HTMLElement
  private readonly wins: HTMLElement

  private readonly tabs: TabStrip
  private readonly pages = new Map<PageId, Page>()
  private readonly avatarTiles: Tile[] = []
  private readonly chassisTiles: Tile[] = []
  private readonly pilotTiles: Tile[] = []

  /**
   * The live car, on the vehicle page and nowhere else.
   *
   * THE SECOND WIDGET, AND THE RULE IT INHERITS. ui/garagePreview.ts allocates
   * a WebGL context on show() and destroys it on hide() so that no second
   * context is ever alive while a race is rendering. This one is held to a
   * STRICTER version of that rule: it exists only while the vehicle page is
   * the open page on a visible profile screen, which is a subset of "the
   * profile is up". Rebuilding it on a tab press costs a few milliseconds;
   * leaving a context alive behind a tab nobody is looking at costs a phone.
   */
  private readonly preview: GaragePreview
  private visible = false

  /** The tile with a buy half-pressed, and the timer that disarms it. */
  private armedId = ''
  private armTimer = 0
  /** True while a request this screen made is in flight. */
  private busy = false
  /** True once prime() has fired its one load, so a second call is free. */
  private priming = false

  constructor(deps: ProfileDeps) {
    this.deps = deps
    const root = el('div', 'sgpf')
    this.root = root

    const head = el('div', 'sg-head', root)
    const back = button('sg-btn sg-btn--ghost', head, 'Back')
    el('div', 'sg-head__title', head, 'PROFILE')
    const spacer = el('div', '', head)
    spacer.style.width = '1px'
    back.addEventListener('click', () => deps.onBack())

    const body = el('div', 'sgpf__body', root)

    // --- identity, which is every page's context and therefore not a page --
    const me = el('div', 'sgpf__me sg-panel', body)
    const face = el('div', 'sgpf__face', me)
    this.portrait = el('div', 'sgpf__portrait', face)
    const faceText = el('div', 'sgpf__facetext', face)
    this.portraitName = el('div', 'sgpf__wearing', faceText, '')
    el('div', 'sgpf__wearingK', faceText, 'Wearing')

    el('label', 'sgpf__k', me, 'Display name')
    const nameRow = el('div', 'sgpf__namerow', me)
    const input = document.createElement('input')
    input.className = 'sgpf__in'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.setAttribute('aria-label', 'Display name')
    // DELIBERATELY LONGER THAN THE RULE. Capping the field at NAME_RULES.max
    // makes `long` unreachable, which means the one error the player is most
    // likely to earn is the one the screen can never say -- they would simply
    // find their typing ignored at the twelfth character with no explanation.
    // Overshooting is allowed so it can be answered.
    input.maxLength = NAME_RULES.max + 8
    nameRow.appendChild(input)
    this.nameInput = input
    this.claimBtn = button('sg-btn sg-btn--small', nameRow, 'Claim')
    this.nameMsg = el('div', 'sgpf__msg sgpf__msg--name', me, '')
    this.nameMsg.setAttribute('role', 'status')
    this.nameMsg.setAttribute('aria-live', 'polite')

    // TWO BANNERS, NEVER ONE. See the header.
    this.offlineBox = el('div', 'sgpf__flag sgpf__flag--offline', me)
    this.offlineBox.dataset.state = 'offline'
    this.offlineBox.hidden = true
    el('b', '', this.offlineBox, 'Offline. ')
    this.offlineBox.appendChild(document.createTextNode(
      'The account server is out of reach, so this name is not claimed and '
      + 'credits cannot be spent. Racing works as normal.'))
    this.retryBtn = button('sg-btn sg-btn--small sg-btn--ghost', this.offlineBox, 'Try again')
    this.retryBtn.addEventListener('click', () => { void this.refresh() })

    this.ephemeralBox = el('div', 'sgpf__flag sgpf__flag--ephemeral', me)
    this.ephemeralBox.dataset.state = 'ephemeral'
    this.ephemeralBox.hidden = true
    el('b', '', this.ephemeralBox, 'Not saved on this device. ')
    this.ephemeralBox.appendChild(document.createTextNode(
      'This browser is blocking storage — a private window usually does — so '
      + 'this profile disappears when you close the tab.'))

    const wallet = el('div', 'sgpf__wallet', me)
    this.credits = this.stat(wallet, 'Credits', 'sgpf__stat--credits')
    this.earned = this.stat(wallet, 'Earned', '')
    this.races = this.stat(wallet, 'Races', '')
    this.wins = this.stat(wallet, 'Wins', '')
    // Where the money comes from, in the player's own units. Read off
    // score/wallet.ts rather than typed, so a re-tune of the economy moves this
    // sentence with it instead of leaving a confident lie on the screen.
    el('div', 'sgpf__note', me,
      `${FINISH_CREDITS} credits for finishing, up to ${SKILL_CREDITS} more for a `
      + `${comma(REF_SCORE)}-point race, ${MAX_PER_RACE} at the very most. `
      + 'Racing the same circuit over and over pays less each time.')

    // --- the pages --------------------------------------------------------
    // The strip and the panels are ui/tabs.ts's, unchanged: a real tablist
    // with arrow keys and `hidden` panels, which is also what keeps a hidden
    // page's twenty-four buttons out of the front end's focus walk.
    const pagesHost = el('div', 'sgpf__pages', body)
    this.tabs = createTabs(pagesHost, PAGES.map((p) => ({ id: p.id, label: p.label })))
    // ADDRESSABLE BY ID, NOT BY VISIBLE TEXT. tabs.ts gives its buttons a
    // generated DOM id; a probe that picked a tab by matching its label would
    // be picking by a string a copy pass moves, and this repo has already lost
    // a pass to a probe that matched a row by substring and drove the wrong
    // control. The buttons are in spec order because nothing here ever calls
    // setPresent(), which is the only thing that reorders them.
    const tabBtns = this.tabs.root.querySelectorAll<HTMLElement>('.sg-tab')
    PAGES.forEach((spec, i) => { if (tabBtns[i]) tabBtns[i].dataset.tab = spec.id })

    for (const spec of PAGES) {
      this.pages.set(spec.id, this.buildPage(this.tabs.panel(spec.id), spec))
    }

    // --- portraits --------------------------------------------------------
    // ROSTER ORDER, WHICH IS THE PICKER'S ORDER. avatars.ts sorts `AVATARS`
    // starters -> shop by price -> rank ladder -> feats precisely so this grid
    // reads top to bottom as what you have, what you can buy, what time gives
    // you and what skill gives you -- and so a portrait never moves.
    const pGrid = this.page('portrait').grid
    for (const def of AVATARS) {
      const tile = this.addTile(pGrid, {
        kind: 'avatar', id: def.id, label: def.name, accent: def.accent,
        art: (host) => { portraitInto(host, def) },
      })
      tile.root.addEventListener('click', () => this.pressAvatar(def.id))
      this.avatarTiles.push(tile)
    }

    // --- vehicle ----------------------------------------------------------
    // The live car goes ABOVE the grid, for the reason the garage puts it
    // above the stat bars: the car is the thing being chosen and everything
    // else on the page is the argument for the choice.
    const vPage = this.page('vehicle')
    const prevSlot = el('div', 'sgpf__prev')
    vPage.root.insertBefore(prevSlot, vPage.now)
    // ONE DEBUG HANDLE, TWO BOXES, AND THE GARAGE'S IS THE ONE THE PROBES
    // MEAN. garagePreview.ts publishes `window.__GARAGE_PREVIEW__` from its
    // constructor, and probe-garage, probe-pilots and probe-vehicle all read
    // it to measure frames drawn and to park the turntable at a repeatable
    // yaw -- on the GARAGE screen. This is the second such widget in the
    // process and it is built after the garage's, so left alone it would
    // silently take the handle over and all three probes would be measuring a
    // box that is hidden and drawing nothing. Whatever held it keeps it.
    const w = window as unknown as { __GARAGE_PREVIEW__?: unknown }
    const heldHandle = typeof window !== 'undefined' ? w.__GARAGE_PREVIEW__ : undefined
    const start = deps.loadout()
    this.preview = createGaragePreview(prevSlot, {
      chassisId: start.chassisId,
      pilotId: start.pilotId,
      tier: deps.quality(),
      makeStage: deps.makeStage,
    })
    if (typeof window !== 'undefined' && heldHandle !== undefined) {
      w.__GARAGE_PREVIEW__ = heldHandle
    }

    for (const def of CHASSIS) {
      const tile = this.addTile(vPage.grid, {
        kind: 'chassis', id: def.id, label: def.name,
        accent: hex(def.colorPrimary),
        art: (host) => { chipInto(host, def.colorPrimary, def.colorSecondary) },
      })
      tile.root.addEventListener('click', () => this.pressChassis(def.id))
      this.chassisTiles.push(tile)
    }

    // --- pilot ------------------------------------------------------------
    const lPage = this.page('pilot')
    for (const def of PILOTS) {
      const tile = this.addTile(lPage.grid, {
        kind: 'pilot', id: def.id, label: def.name,
        accent: hex(def.accent),
        art: (host) => { chipInto(host, def.shell, def.accent) },
      })
      tile.root.addEventListener('click', () => this.pressPilot(def.id))
      this.pilotTiles.push(tile)
    }

    // The context follows the open page, not the screen. See `preview`.
    this.tabs.onSelect = () => this.syncPreview()

    this.claimBtn.addEventListener('click', () => { void this.claim() })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void this.claim() }
      // The front end binds Enter and the arrows to its own buttons, so a
      // player typing a name would otherwise be driving the menu mid-word.
      e.stopPropagation()
    })
  }

  private stat(host: HTMLElement, label: string, extra: string): HTMLElement {
    const wrap = el('div', 'sgpf__stat ' + extra, host)
    el('div', 'sgpf__statK', wrap, label)
    return el('div', 'sgpf__statV', wrap, '—')
  }

  private buildPage(
    host: HTMLElement, spec: { id: PageId; title: string; lede: string },
  ): Page {
    const root = el('div', 'sgpf__page sg-panel', host)
    root.dataset.page = spec.id
    const pickHead = el('div', 'sgpf__pickhead', root)
    el('div', 'sgpf__pickTitle', pickHead, spec.title)
    const count = el('div', 'sgpf__pickCount', pickHead, '')
    el('div', 'sgpf__lede', root, spec.lede)
    const now = el('div', 'sgpf__now', root, '')
    const msg = el('div', 'sgpf__msg sgpf__msg--pick', root, '')
    msg.setAttribute('role', 'status')
    msg.setAttribute('aria-live', 'polite')
    const grid = el('div', 'sgpf__grid', root)
    const more = el('div', 'sgpf__more', root)
    return { id: spec.id, root, count, msg, now, grid, more }
  }

  private page(id: PageId): Page {
    const p = this.pages.get(id)
    if (!p) throw new Error(`no profile page "${id}"`)
    return p
  }

  private addTile(grid: HTMLElement, spec: {
    kind: 'avatar' | 'chassis' | 'pilot'
    id: string
    label: string
    accent: string
    art: (host: HTMLElement) => void
  }): Tile {
    const root = button('sgpf__tile', grid, '')
    root.dataset.kind = spec.kind
    // `data-item` is the generic handle every page shares; `data-avatar`,
    // `data-chassis` and `data-pilot` are the specific ones the rest of the
    // front end already spells that way (see the garage's cards).
    root.dataset.item = spec.id
    root.dataset[spec.kind] = spec.id
    root.style.setProperty('--accent', spec.accent)
    const art = el('span', 'sgpf__tileArt', root)
    spec.art(art)
    const check = el('span', 'sgpf__tick', root, '')
    check.setAttribute('aria-hidden', 'true')
    el('span', 'sgpf__tileName', root, spec.label)
    const tag = el('span', 'sgpf__tileTag', root, '')
    const bar = el('span', 'sgpf__tileBar', root)
    el('span', 'sgpf__tileFill', bar)
    const req = el('span', 'sgpf__tileReq', root, '')
    return { root, id: spec.id, label: spec.label, req, bar, tag }
  }

  get profile(): PlayerProfile | null { return this.p }
  get tab(): PageId { return this.tabs.selected as PageId }

  showTab(id: PageId): void {
    this.tabs.select(id)
  }

  private account(): AccountService {
    if (!this.acct) {
      this.acct = accountService()
      this.acct.onChange = (p) => this.apply(p)
    }
    return this.acct
  }

  prime(): void {
    if (this.p || this.priming) return
    this.priming = true
    void this.refresh()
  }

  // -------------------------------------------------------------------------

  /**
   * REFRESHED ON EVERY ENTRY, NOT ONLY ON THE FIRST.
   *
   * `load()` is the only refresh the contract has, and the profile genuinely
   * changes behind this screen: `award()` banks a race's credits from the
   * results screen, which can unlock ranks and feats. A picker that was built
   * once at boot would still be showing the portraits the player had before
   * their last three races.
   *
   * It is also the documented way back from `offline` -- "Calling it again is a
   * RETRY: it re-rolls the connection" -- which is what the banner's own button
   * does, and what makes an offline profile a state a player can leave.
   *
   * THE LOADOUT IS RE-READ HERE TOO, and that is the whole of keeping this
   * screen in step with the garage: the garage can only be visited while this
   * one is not, so every change it made is waiting at the next enter().
   */
  enter(): void {
    this.visible = true
    this.disarm()
    this.preview.setQuality(this.deps.quality())
    this.paintLoadout()
    this.syncPreview()
    void this.refresh()
  }

  exit(): void {
    this.visible = false
    this.disarm()
    this.syncPreview()
  }

  /** The WebGL context exists for exactly one page of one screen. */
  private syncPreview(): void {
    if (this.visible && this.tabs.selected === 'vehicle') this.preview.show()
    else this.preview.hide()
  }

  private async refresh(): Promise<void> {
    this.retryBtn.disabled = true
    const p = await this.account().load()
    this.retryBtn.disabled = false
    this.apply(p)
  }

  /** Every render of an ACCOUNT change goes through here. */
  private apply(p: PlayerProfile): void {
    this.p = p
    const worn = AVATAR_BY_ID.get(p.avatarId) ?? AVATAR_BY_ID.get(DEFAULT_AVATAR_ID)
    if (worn) {
      this.portrait.textContent = ''
      this.portrait.style.setProperty('--accent', worn.accent)
      this.portrait.dataset.avatar = worn.id
      portraitInto(this.portrait, worn)
      this.portraitName.textContent = worn.name
    }

    // The field is not stamped over while the player is typing in it -- a
    // background refresh landing mid-edit must not eat their input.
    if (document.activeElement !== this.nameInput) this.nameInput.value = p.name

    const acct = this.account()
    this.offlineBox.hidden = !acct.offline
    this.ephemeralBox.hidden = !acct.ephemeral
    // Nothing can be claimed or spent without a server, and a control that
    // looks live and always fails is worse than one that says why.
    this.claimBtn.disabled = this.busy || acct.offline
    this.nameInput.disabled = acct.offline

    this.credits.textContent = comma(p.credits)
    this.earned.textContent = comma(p.earned)
    this.races.textContent = comma(p.races)
    this.wins.textContent = comma(p.wins)

    const cat = catalogueFor(p)
    const byId = new Map<string, AvatarView>(cat.all.map((v) => [v.def.id, v]))
    for (const tile of this.avatarTiles) {
      const v = byId.get(tile.id)
      if (v) paintTile(tile, avatarView(v, p.avatarId))
    }
    this.page('portrait').count.textContent =
      `${cat.owned.length} of ${cat.all.length} unlocked · ${cat.buyable.length} to buy now`

    this.onProfile(p)
  }

  /**
   * Every render of a LOADOUT change goes through here.
   *
   * Separate from `apply` because the two have different clocks: an account
   * arrives from a request, a loadout is a field the front end already holds.
   * Reading `deps.loadout()` rather than caching is the point -- see the
   * header. Nothing in this method writes.
   */
  private paintLoadout(): void {
    const { chassisId, pilotId } = this.deps.loadout()
    const car = CHASSIS_BY_ID[chassisId] ?? CHASSIS[0]
    const pilot = PILOTS_BY_ID[pilotId] ?? PILOTS[0]

    for (const tile of this.chassisTiles) {
      const def = CHASSIS_BY_ID[tile.id]
      if (!def) continue
      const on = def.id === car.id
      paintTile(tile, {
        status: 'owned',
        requirement: def.nickname,
        progress: 1,
        tag: on ? 'RACING' : def.locomotion.toUpperCase(),
        equipped: on,
      })
    }
    for (const tile of this.pilotTiles) {
      const def = PILOTS_BY_ID[tile.id]
      if (!def) continue
      const on = def.id === pilot.id
      paintTile(tile, {
        status: 'owned',
        requirement: def.perk,
        progress: 1,
        tag: on ? 'SEATED' : def.archetype.toUpperCase(),
        equipped: on,
      })
    }

    // THE HONEST ANSWER TO "WHAT IS LOCKED HERE". Nothing is, and saying so is
    // the same courtesy the portraits page pays by showing its locked rows
    // rather than hiding them. It is also a design statement worth writing
    // down where a player can read it: a chassis is a balance decision (see
    // content/tuning.ts on how few stat points separate the roster) and
    // selling one would be selling a win rate. What credits will buy on this
    // page is paint.
    this.page('vehicle').count.textContent =
      `${CHASSIS.length} chassis · all unlocked`
    this.page('pilot').count.textContent =
      `${PILOTS.length} pilots · all unlocked`

    this.page('vehicle').now.textContent =
      `${car.name} — "${car.nickname}". ${LOCO_LINE[car.locomotion] ?? ''}`
    this.page('pilot').now.textContent = `${pilot.name} — ${pilot.perk}`

    this.preview.setSelection(car.id, pilot.id)
  }

  // -------------------------------------------------------------------------

  private async claim(): Promise<void> {
    if (this.busy) return
    const wanted = this.nameInput.value.trim()
    // RE-CLAIMING YOUR OWN NAME IS NOT SHORT-CIRCUITED. Both the mock's
    // `claim()` and a real unique index answer "yes, still yours" for it, and
    // it is the only way to retry after an `offline` rejection without having
    // to invent a different name to do it with.
    this.busy = true
    this.claimBtn.disabled = true
    this.setMsg(this.nameMsg, 'Claiming…', 'wait')
    const res = await this.account().setName(wanted)
    this.busy = false
    if (res.ok) {
      this.setMsg(this.nameMsg, `Claimed. You are ${res.value.name}.`, 'ok')
      this.apply(res.value)
      return
    }
    // The exhaustive part. NAME_ERROR is a Record over the union, so every case
    // that exists has a sentence and a new one cannot be added without one.
    this.setMsg(this.nameMsg, NAME_ERROR[res.error], 'bad')
    this.nameMsg.dataset.name = res.error
    // Re-enable whatever the failure left disabled, and put the offline banner
    // up if that is what we just learned.
    if (this.p) this.apply(this.p)
    else this.claimBtn.disabled = false
  }

  /**
   * THE GUARD EVERY PAGE GOES THROUGH, INCLUDING THE UNWRITTEN ONES.
   *
   * Two refusals, in this order, and both answered from what the screen
   * already knows rather than after a round trip:
   *
   *   offline  for anything the account HOLDS (see `held`), the server would
   *            refuse and the banner two inches up already says why. Spending
   *            two hundred milliseconds to be told again is a worse version
   *            of a fact that is already on the screen.
   *   locked   the answer would be a network-shaped error where the player
   *            should have been handed the requirement they are two hundred
   *            credits short of.
   *
   * @param held whether the ACCOUNT holds this choice. A portrait does: it
   *        lives on the server, it is bought there and worn there, and with
   *        the server out of reach there is nothing to be done about it. A
   *        chassis does not: it is a `localStorage` key this device owns, it
   *        costs nothing, and the garage will happily change it with the
   *        account server on fire -- so refusing it here because an unrelated
   *        service is down would be this screen inventing a restriction the
   *        rest of the game does not have. Liveries, when they land, pass
   *        true; they are bought with credits and the server holds them.
   * @returns true when the press has been answered and must go no further.
   */
  private refuse(page: Page, id: string, label: string, view: TileView, held: boolean): boolean {
    if (held && this.account().offline) {
      this.disarm()
      this.setMsg(page.msg, SHOP_ERROR.offline, 'bad')
      return true
    }
    if (view.status === 'locked') {
      this.disarm()
      this.setMsg(page.msg, `${label} — ${view.requirement}`, 'bad')
      // The ID, not the name: a probe matching on a display string is a probe
      // a copy pass breaks. `setMsg` clears this, so it is set after it.
      page.msg.dataset.refused = id
      return true
    }
    return false
  }

  private pressAvatar(id: string): void {
    const p = this.p
    const def = AVATAR_BY_ID.get(id)
    if (!p || !def) return
    const v = catalogueFor(p).all.find((x) => x.def.id === id)
    if (!v) return
    const page = this.page('portrait')
    const view = avatarView(v, p.avatarId)

    // THE SHARED GUARD, and the portraits page is the one that exercises both
    // halves of it for real: a portrait is held by the account, so an
    // unreachable server refuses, and a portrait can be locked, so a locked
    // one never reaches `setAvatar`.
    if (this.refuse(page, id, def.name, view, true)) return

    if (view.status === 'owned') {
      this.disarm()
      if (p.avatarId === id) {
        this.setMsg(page.msg, `Already wearing ${def.name}.`, 'ok')
        return
      }
      void this.equip(id)
      return
    }
    // Buyable. TWO PRESSES, like the front end's discard-standings button and
    // for the same reason: this is the only control in the game that spends
    // something, it sits in a grid of twenty-four identical targets, and a
    // mis-tap on a phone would cost four thousand credits.
    if (this.armedId === id) {
      this.disarm()
      void this.buy(id)
      return
    }
    this.arm(id, def.name, view)
  }

  /**
   * Change the car. ONE LINE OF ACTUAL WORK, and that is the point.
   *
   * There is no local field to update and nothing to persist here: the write
   * goes to the front end, the front end stores it, writes it to
   * localStorage, repaints the garage, re-publishes it to any lobby room the
   * player is sitting in -- and this screen repaints from the same read every
   * other reader uses. A second copy of the id would be a second thing to
   * forget to update.
   */
  private pressChassis(id: string): void {
    const def = CHASSIS_BY_ID[id]
    if (!def) return
    const page = this.page('vehicle')
    const cur = this.deps.loadout()
    // Nothing is lockable on this page today, and `held` is false because a
    // chassis is a device key rather than an account one -- picking a car
    // works with the account server on fire, exactly as it does in the
    // garage. The guard still runs, because the day a livery IS locked this
    // is already the line that stops it reaching the writer.
    const view: TileView = {
      status: 'owned', requirement: def.nickname, progress: 1, tag: '',
      equipped: def.id === cur.chassisId,
    }
    if (this.refuse(page, id, def.name, view, false)) return
    if (cur.chassisId === id) {
      this.setMsg(page.msg, `Already racing the ${def.name}.`, 'ok')
      return
    }
    this.deps.setLoadout({ chassisId: id, pilotId: cur.pilotId })
    this.paintLoadout()
    // SHORT, BECAUSE THE LINE ABOVE IT JUST CHANGED TOO. `paintLoadout` has
    // already rewritten the `now` line with this car's name, nickname and
    // locomotion note, and a confirmation that repeats all three puts the
    // same sentence on the screen twice, one line apart -- which reads as a
    // rendering fault rather than as an answer.
    this.setMsg(page.msg, `Now racing the ${def.name}.`, 'ok')
  }

  private pressPilot(id: string): void {
    const def = PILOTS_BY_ID[id]
    if (!def) return
    const page = this.page('pilot')
    const cur = this.deps.loadout()
    const view: TileView = {
      status: 'owned', requirement: def.perk, progress: 1, tag: '',
      equipped: def.id === cur.pilotId,
    }
    if (this.refuse(page, id, def.name, view, false)) return
    if (cur.pilotId === id) {
      this.setMsg(page.msg, `${def.name} is already in the seat.`, 'ok')
      return
    }
    this.deps.setLoadout({ chassisId: cur.chassisId, pilotId: id })
    this.paintLoadout()
    // Short, for the same reason as the chassis above: the perk is already on
    // the `now` line by the time this is read.
    this.setMsg(page.msg, `${def.name} takes the seat.`, 'ok')
  }

  private arm(id: string, name: string, view: TileView): void {
    this.disarm()
    this.armedId = id
    const tile = this.avatarTiles.find((t) => t.id === id)
    if (tile) {
      tile.root.classList.add('is-armed')
      tile.tag.textContent = 'PRESS AGAIN'
    }
    this.setMsg(this.page('portrait').msg,
      `${name} — ${view.requirement} Press again to confirm.`, 'wait')
    this.armTimer = window.setTimeout(() => this.disarm(), 4000)
  }

  private disarm(): void {
    if (this.armTimer) { window.clearTimeout(this.armTimer); this.armTimer = 0 }
    if (!this.armedId) return
    const tile = this.avatarTiles.find((t) => t.id === this.armedId)
    this.armedId = ''
    if (tile && this.p) {
      const v = catalogueFor(this.p).all.find((x) => x.def.id === tile.id)
      tile.root.classList.remove('is-armed')
      if (v) paintTile(tile, avatarView(v, this.p.avatarId))
    }
  }

  private async equip(id: string): Promise<void> {
    if (this.busy) return
    this.busy = true
    const page = this.page('portrait')
    this.setMsg(page.msg, 'Changing portrait…', 'wait')
    const res = await this.account().setAvatar(id)
    this.busy = false
    if (res.ok) {
      this.apply(res.value)
      this.setMsg(page.msg, `Now wearing ${AVATAR_BY_ID.get(id)?.name ?? id}.`, 'ok')
      return
    }
    this.setMsg(page.msg, shopError(res.error), 'bad')
  }

  private async buy(id: string): Promise<void> {
    if (this.busy) return
    this.busy = true
    const page = this.page('portrait')
    this.setMsg(page.msg, 'Buying…', 'wait')
    const res = await this.account().buyAvatar(id)
    this.busy = false
    if (res.ok) {
      this.apply(res.value)
      // `buyAvatar` equips what it sold, per the contract's note, so the
      // message says both -- a player who is told only "bought" then looks for
      // the second step that does not exist.
      this.setMsg(page.msg,
        `Bought ${AVATAR_BY_ID.get(id)?.name ?? id}. You are wearing it. `
        + `${comma(res.value.credits)} credits left.`, 'ok')
      return
    }
    this.setMsg(page.msg, shopError(res.error), 'bad')
  }

  private setMsg(host: HTMLElement, text: string, kind: 'ok' | 'bad' | 'wait'): void {
    host.textContent = text
    host.dataset.kind = kind
    delete host.dataset.name
    delete host.dataset.refused
  }

  dispose(): void {
    this.disarm()
    this.preview.dispose()
    this.tabs.dispose()
    if (this.acct) this.acct.onChange = () => {}
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root)
  }
}

/**
 * An `AvatarView` from content/avatars.ts as a `TileView`.
 *
 * The only page-specific knowledge on the portraits page, kept in one function
 * so the tile painter stays ignorant of what a price is.
 */
function avatarView(v: AvatarView, wornId: string): TileView {
  const worn = v.def.id === wornId
  const src = v.def.source
  return {
    status: v.status,
    requirement: v.requirement,
    progress: v.progress,
    tag: v.status === 'owned'
      ? (worn ? 'WORN' : 'OWNED')
      : src.kind === 'shop' ? comma(src.price) + ' cr'
        : src.kind === 'rank' ? 'RANK'
          : 'FEAT',
    equipped: worn,
  }
}

export function createProfileScreen(deps: ProfileDeps): ProfileScreen {
  return new ProfileScreenImpl(deps)
}
