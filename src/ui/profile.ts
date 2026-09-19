/**
 * profile.ts — SpaceGen Racing player profile + avatar picker.
 * ---------------------------------------------------------------------------
 * One screen, two halves:
 *
 *   IDENTITY   the portrait the player wears, the name they are claiming, what
 *              the account service will and will not do for them right now, and
 *              the wallet the picker spends from.
 *   PICKER     all twenty-four portraits from content/avatars.ts, each one
 *              owned, buyable or locked-with-a-reason. Nothing is hidden.
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
 * 3. A LOCKED PORTRAIT IS NOT AN INERT TILE. Locked tiles stay pressable and
 *    answer with their requirement, because avatars.ts's whole argument for
 *    returning locked rows rather than hiding them is that the requirement
 *    sentence is what makes a shop honest rather than teasing. What a locked
 *    tile must never do is reach `setAvatar` -- the server would refuse it and
 *    the player would get a network error where they should have got a reason.
 *
 * Built once in the constructor, like every other screen in this front end.
 * enter()/exit() refresh text and start/stop nothing heavier than a request.
 */
import './profile.css'
import { accountService } from '../net'
import {
  NAME_RULES,
  type AccountService, type AvatarDef, type NameError, type PlayerProfile,
} from '../net/types'
import {
  AVATARS, AVATAR_BY_ID, DEFAULT_AVATAR_ID, catalogueFor, placeholderPortrait,
  portraitFor, type AvatarView,
} from '../content/avatars'
import {
  FINISH_CREDITS, MAX_PER_RACE, REF_SCORE, SKILL_CREDITS,
} from '../score/wallet'

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
  /** Fired on every profile change, including the first load. */
  onProfile: (p: PlayerProfile) => void
  dispose(): void
}

export interface ProfileDeps {
  /** Where the Back button goes. */
  onBack(): void
}

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

/** Thousands separators without building an Intl formatter per call. */
function comma(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
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

// ---------------------------------------------------------------------------

interface Tile {
  root: HTMLButtonElement
  def: AvatarDef
  name: HTMLElement
  req: HTMLElement
  bar: HTMLElement
  tag: HTMLElement
}

class ProfileScreenImpl implements ProfileScreen {
  readonly root: HTMLElement
  onProfile: (p: PlayerProfile) => void = () => {}

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
  private readonly pickCount: HTMLElement
  private readonly pickMsg: HTMLElement
  private readonly tiles: Tile[] = []

  /** The tile with a buy half-pressed, and the timer that disarms it. */
  private armedId = ''
  private armTimer = 0
  /** True while a request this screen made is in flight. */
  private busy = false
  /** True once prime() has fired its one load, so a second call is free. */
  private priming = false

  constructor(deps: ProfileDeps) {
    const root = el('div', 'sgpf')
    this.root = root

    const head = el('div', 'sg-head', root)
    const back = button('sg-btn sg-btn--ghost', head, 'Back')
    el('div', 'sg-head__title', head, 'PROFILE')
    const spacer = el('div', '', head)
    spacer.style.width = '1px'
    back.addEventListener('click', () => deps.onBack())

    const body = el('div', 'sgpf__body', root)

    // --- identity ---------------------------------------------------------
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
    this.nameMsg = el('div', 'sgpf__msg', me, '')
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

    // --- picker -----------------------------------------------------------
    const pick = el('div', 'sgpf__pick sg-panel', body)
    const pickHead = el('div', 'sgpf__pickhead', pick)
    el('div', 'sgpf__pickTitle', pickHead, 'PORTRAITS')
    this.pickCount = el('div', 'sgpf__pickCount', pickHead, '')
    this.pickMsg = el('div', 'sgpf__msg sgpf__msg--pick', pick, '')
    this.pickMsg.setAttribute('role', 'status')
    this.pickMsg.setAttribute('aria-live', 'polite')
    const grid = el('div', 'sgpf__grid', pick)

    // ROSTER ORDER, WHICH IS THE PICKER'S ORDER. avatars.ts sorts `AVATARS`
    // starters -> shop by price -> rank ladder -> feats precisely so this grid
    // reads top to bottom as what you have, what you can buy, what time gives
    // you and what skill gives you -- and so a portrait never moves.
    for (const def of AVATARS) {
      const tile = button('sgpf__tile', grid, '')
      tile.dataset.avatar = def.id
      tile.style.setProperty('--accent', def.accent)
      const art = el('span', 'sgpf__tileArt', tile)
      portraitInto(art, def)
      const check = el('span', 'sgpf__tick', tile, '')
      check.setAttribute('aria-hidden', 'true')
      const name = el('span', 'sgpf__tileName', tile, def.name)
      const tag = el('span', 'sgpf__tileTag', tile, '')
      const bar = el('span', 'sgpf__tileBar', tile)
      el('span', 'sgpf__tileFill', bar)
      const req = el('span', 'sgpf__tileReq', tile, '')
      tile.addEventListener('click', () => this.pressTile(def.id))
      this.tiles.push({ root: tile, def, name, req, bar, tag })
    }

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

  get profile(): PlayerProfile | null { return this.p }

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
   */
  enter(): void {
    this.disarm()
    void this.refresh()
  }

  exit(): void {
    this.disarm()
  }

  private async refresh(): Promise<void> {
    this.retryBtn.disabled = true
    const p = await this.account().load()
    this.retryBtn.disabled = false
    this.apply(p)
  }

  /** Every render goes through here, whoever caused the change. */
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
    for (const tile of this.tiles) {
      const v = byId.get(tile.def.id)
      if (!v) continue
      this.paintTile(tile, v, p.avatarId)
    }
    this.pickCount.textContent =
      `${cat.owned.length} of ${cat.all.length} unlocked · ${cat.buyable.length} to buy now`

    this.onProfile(p)
  }

  private paintTile(tile: Tile, v: AvatarView, wornId: string): void {
    const t = tile.root
    t.dataset.status = v.status
    const worn = v.def.id === wornId
    t.classList.toggle('is-worn', worn)
    if (worn) t.setAttribute('aria-current', 'true')
    else t.removeAttribute('aria-current')

    tile.req.textContent = v.requirement
    const src = v.def.source
    tile.tag.textContent = v.status === 'owned'
      ? (worn ? 'WORN' : 'OWNED')
      : src.kind === 'shop' ? comma(src.price) + ' cr'
        : src.kind === 'rank' ? 'RANK'
          : 'FEAT'
    // A bar only where partial credit is a real thing. avatars.ts returns 0 for
    // a feat precisely because a creeping bar would imply one.
    const showBar = v.status !== 'owned' && v.progress > 0 && v.progress < 1
    tile.bar.hidden = !showBar
    tile.bar.style.setProperty('--v', v.progress.toFixed(3))

    // The accessible name carries the state and the reason, because the tick,
    // the ring and the tag are all things a screen reader cannot see.
    const state = worn ? 'worn' : v.status
    t.setAttribute('aria-label',
      `${v.def.name}, ${state}${v.requirement ? '. ' + v.requirement : ''}`)
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

  private pressTile(id: string): void {
    const p = this.p
    const def = AVATAR_BY_ID.get(id)
    if (!p || !def) return
    const view = catalogueFor(p).all.find((v) => v.def.id === id)
    if (!view) return

    // OFFLINE IS ANSWERED HERE, NOT AFTER A ROUND TRIP. The server would refuse
    // both of these and the banner above already says why, so spending two
    // hundred milliseconds to be told again is a worse version of a fact the
    // screen is already displaying.
    if (this.account().offline) {
      this.disarm()
      this.setMsg(this.pickMsg, SHOP_ERROR.offline, 'bad')
      return
    }

    if (view.status === 'locked') {
      // THE ONE THING A LOCKED TILE MUST NOT DO is ask the server to equip it.
      // The answer would be a network-shaped error where the player should have
      // been handed the requirement they are two hundred credits short of.
      this.disarm()
      this.setMsg(this.pickMsg, `${def.name} — ${view.requirement}`, 'bad')
      this.pickMsg.dataset.refused = id
      return
    }
    if (view.status === 'owned') {
      this.disarm()
      if (p.avatarId === id) {
        this.setMsg(this.pickMsg, `Already wearing ${def.name}.`, 'ok')
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
    this.arm(id, view)
  }

  private arm(id: string, view: AvatarView): void {
    this.disarm()
    this.armedId = id
    const tile = this.tiles.find((t) => t.def.id === id)
    if (tile) {
      tile.root.classList.add('is-armed')
      tile.tag.textContent = 'PRESS AGAIN'
    }
    this.setMsg(this.pickMsg,
      `${view.def.name} — ${view.requirement} Press again to confirm.`, 'wait')
    this.armTimer = window.setTimeout(() => this.disarm(), 4000)
  }

  private disarm(): void {
    if (this.armTimer) { window.clearTimeout(this.armTimer); this.armTimer = 0 }
    if (!this.armedId) return
    const tile = this.tiles.find((t) => t.def.id === this.armedId)
    this.armedId = ''
    if (tile && this.p) {
      const v = catalogueFor(this.p).all.find((x) => x.def.id === tile.def.id)
      tile.root.classList.remove('is-armed')
      if (v) this.paintTile(tile, v, this.p.avatarId)
    }
  }

  private async equip(id: string): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.setMsg(this.pickMsg, 'Changing portrait…', 'wait')
    const res = await this.account().setAvatar(id)
    this.busy = false
    if (res.ok) {
      this.apply(res.value)
      this.setMsg(this.pickMsg, `Now wearing ${AVATAR_BY_ID.get(id)?.name ?? id}.`, 'ok')
      return
    }
    this.setMsg(this.pickMsg, shopError(res.error), 'bad')
  }

  private async buy(id: string): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.setMsg(this.pickMsg, 'Buying…', 'wait')
    const res = await this.account().buyAvatar(id)
    this.busy = false
    if (res.ok) {
      this.apply(res.value)
      // `buyAvatar` equips what it sold, per the contract's note, so the
      // message says both -- a player who is told only "bought" then looks for
      // the second step that does not exist.
      this.setMsg(this.pickMsg,
        `Bought ${AVATAR_BY_ID.get(id)?.name ?? id}. You are wearing it. `
        + `${comma(res.value.credits)} credits left.`, 'ok')
      return
    }
    this.setMsg(this.pickMsg, shopError(res.error), 'bad')
  }

  private setMsg(host: HTMLElement, text: string, kind: 'ok' | 'bad' | 'wait'): void {
    host.textContent = text
    host.dataset.kind = kind
    delete host.dataset.name
    delete host.dataset.refused
  }

  dispose(): void {
    this.disarm()
    if (this.acct) this.acct.onChange = () => {}
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root)
  }
}

export function createProfileScreen(deps: ProfileDeps): ProfileScreen {
  return new ProfileScreenImpl(deps)
}
