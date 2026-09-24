/**
 * SpaceGen Racing — THE AVATAR CATALOGUE.
 * ---------------------------------------------------------------------------
 * Twenty-four portraits, four ways to get one, and the arithmetic that decides
 * which of them a given profile may wear. Pure data and pure functions: no DOM,
 * no fetch, no storage, no imports from `src/game` or `src/ui`.
 *
 * THAT PURITY IS A REQUIREMENT, NOT TIDINESS. This module is read in three
 * places that have nothing else in common -- the picker in the browser, the
 * unit tests in Node, and eventually the account endpoint, which has to decide
 * whether a claimed unlock is real rather than trusting a client that says so.
 * One module all three can import is the only way those three answers cannot
 * disagree. A single `window.` in here would cost the third one.
 *
 * ===========================================================================
 * THE FOUR SOURCES, AND WHY THE SPLIT IS FOUR AND NOT A PRICE OF ZERO
 *
 *   starter (4)  owned from first launch. The picker is never empty, and a
 *                player who has never finished a race still has a face.
 *   shop    (10) bought outright. The bulk of the roster, because credits need
 *                somewhere to go every session or earning them stops meaning
 *                anything.
 *   rank    (5)  granted by passing a lifetime-`earned` threshold. No purchase
 *                step and no decision: these are the ones that say "you have
 *                been here a while", and a thing you could BUY does not say
 *                that about anybody.
 *   feat    (5)  granted by doing a specific thing, stated in `how` in the
 *                player's own words.
 *
 * `AvatarSource` is a discriminated union rather than a nullable price because
 * the UI renders the four cases completely differently -- a price tag, a
 * progress bar to a threshold, a sentence, or nothing at all -- and a price of
 * 0 meaning "free" would make three of those indistinguishable from the fourth.
 *
 * ===========================================================================
 * THE ART, AND WHAT STANDS IN FOR A PORTRAIT THAT HAS NOT ARRIVED
 *
 * The portraits live in `public/avatars/` as `<id>-<size>.webp` at every size
 * in `ART_SIZES` -- see `srcFor` below, which is the only place that path is
 * ever built. `artManifest.ts` lists the ids that actually have files, and is
 * written by tools/import-art.mjs from what is on disk, so this module knows
 * which faces exist without a single request.
 *
 * ART LANDS PER ID, NOT AS A BATCH. This used to be one `ART_READY` switch on
 * the argument that a roster half art and half generated marks reads as a bug.
 * The art then arrived twenty-three of twenty-four, and the switch would have
 * held twenty-three finished portraits hostage to one missing file. So the
 * rule is now per id, with the one case that argument really was about --
 * paying for a face that is not there -- handled directly: a SHOP avatar with
 * no art is not for sale until it has some (`artPending`). Anyone who already
 * owns one still wears it, drawn as its placeholder, because an unlock is not
 * something a missing file may take away.
 *
 * Every consumer calls `portraitFor(def, px)`; nobody reads `def.src` for
 * drawing. That is what lets a portrait be the right SIZE for where it is
 * shown -- a 20 px nameplate never downloads the 512 -- and what makes a new
 * file live everywhere at once the moment the manifest names it.
 */
import type { AvatarDef, AvatarSource, PlayerProfile } from '../net/types'
import { COMBO_MAX } from '../score/rules'
import { ART_SIZES, AVATAR_ART, type ArtSize } from './artManifest'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Published directory for the portraits, relative to the site root. */
export const AVATAR_DIR = 'avatars/'

/**
 * The ONE place an avatar's file path is constructed.
 *
 * Written as a function rather than typed out twenty-four times because the
 * failure mode of the alternative is silent: one `avatar/` for twenty-three
 * `avatars/`, a 404 that renders as a blank circle, and a picker that looks
 * merely ugly rather than broken. tests/wallet.test.ts asserts every entry
 * matches the convention anyway, so a later hand-edit past this helper is
 * caught too.
 *
 * `size` is one of the exported edge lengths; `def.src` is the largest, which
 * is what a caller that has no idea how big it will draw should get.
 */
export function srcFor(id: string, size: ArtSize = LARGEST): string {
  return AVATAR_DIR + id + '-' + size + '.webp'
}

const LARGEST: ArtSize = ART_SIZES[ART_SIZES.length - 1]

const HAS_ART: ReadonlySet<string> = new Set(AVATAR_ART)

/** Whether this avatar's portrait is in public/avatars/. */
export function hasArt(id: string): boolean {
  return HAS_ART.has(id)
}

/**
 * The smallest exported size that covers `px` device pixels.
 *
 * Callers pass what they will DRAW in device pixels -- CSS size times the
 * pixel ratio -- and get the file that is at least that big, so a picker tile
 * on a 3x phone gets the 256 rather than a smeared 128, and a nameplate never
 * pulls the 512.
 */
export function artSizeFor(px: number): ArtSize {
  for (const n of ART_SIZES) if (n >= px) return n
  return LARGEST
}

/**
 * What to actually draw for an avatar at `px` device pixels. Every consumer
 * calls this; nobody draws `def.src` directly, which is what makes a new file
 * in public/avatars/ live on every screen at once.
 */
export function portraitFor(a: AvatarDef, px: number = LARGEST): string {
  return hasArt(a.id) ? srcFor(a.id, artSizeFor(px)) : placeholderPortrait(a)
}

/**
 * A shop avatar whose portrait has not been delivered.
 *
 * Not for sale until it is: a price tag on a placeholder is asking for credits
 * in exchange for a promise. It is still listed, with its price, as coming --
 * a shop that silently loses a row reads as a bug, and one that says a face is
 * on its way is a reason to come back. Owners keep it regardless (see the
 * header).
 */
export function artPending(id: string): boolean {
  const a = AVATAR_BY_ID.get(id)
  return !!a && a.source.kind === 'shop' && !hasArt(id)
}

// ---------------------------------------------------------------------------
// The placeholder portrait
// ---------------------------------------------------------------------------

/**
 * A procedural stand-in, as an inline SVG data URI.
 *
 * SVG RATHER THAN CANVAS, because a canvas needs a document and this module is
 * imported by tests and by the server. A data URI drops into the same `src`
 * attribute a PNG would, so no consumer has to know which one it got.
 *
 * IT IS MEANT TO LOOK UNFINISHED. The dashed ring and the hatching are there so
 * that nobody -- us, Vince, or a screenshot in a review -- mistakes a generated
 * mark for shipped art and stops chasing the portrait it stands in for. It is
 * also what a portrait falls back to if its file fails to load. What it is NOT is
 * identical across the roster: the initials and the four-dot constellation are
 * derived from the id, so all twenty-four are distinguishable at picker size
 * and the layout can be judged today.
 */
export function placeholderPortrait(a: Pick<AvatarDef, 'id' | 'name' | 'accent'>): string {
  const accent = xml(a.accent)
  const dots = constellation(a.id)
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" ' +
    'height="64" role="img" aria-label="' + xml(a.name) + ' placeholder portrait">' +
    '<rect width="64" height="64" fill="#0b1016"/>' +
    '<circle cx="32" cy="32" r="21" fill="' + accent + '" opacity="0.16"/>' +
    '<path d="M6 42 L42 6 M22 58 L58 22" stroke="' + accent +
    '" stroke-width="1.5" opacity="0.22"/>' +
    '<circle cx="32" cy="32" r="27" fill="none" stroke="' + accent +
    '" stroke-width="2" stroke-dasharray="4 5" opacity="0.85"/>' +
    dots.map((d) =>
      '<rect x="' + d[0] + '" y="' + d[1] + '" width="3" height="3" fill="' +
      accent + '" opacity="0.8"/>').join('') +
    '<text x="32" y="40" text-anchor="middle" font-family="monospace" ' +
    'font-size="21" font-weight="700" fill="' + accent + '">' +
    xml(initials(a.name)) + '</text>' +
    '</svg>'
  // encodeURIComponent, not base64: `#` in a colour would otherwise truncate
  // the URI at the fragment, and btoa does not exist everywhere this runs.
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
}

/** Up to two initials, from the first two words of the name. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => w.length > 0)
  if (words.length === 0) return '??'
  const first = words[0][0]
  const second = words.length > 1 ? words[1][0] : words[0][1] ?? ''
  return (first + second).toUpperCase()
}

/** FNV-1a. Small, stable, and the same answer in every runtime. */
function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** Four corner marks, present or absent by four bits of the id's hash. */
function constellation(id: string): [number, number][] {
  const h = hash32(id)
  // Inside the dashed ring rather than on it: rendered, the two collided and
  // the marks disappeared into the dashes, which cost them the only job they
  // have -- telling two avatars with the same initials apart.
  const spots: [number, number][] = [[15, 15], [46, 15], [15, 46], [46, 46]]
  const out = spots.filter((_, i) => ((h >> i) & 1) === 1)
  // Never draw none: an empty constellation makes two different ids look the
  // same, which is the one thing this is for.
  return out.length > 0 ? out : [spots[h % 4]]
}

/** Minimal XML escaping. The roster is plain ASCII, but the generator is not
 *  allowed to assume a future entry will be. */
function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// Prices and thresholds
// ---------------------------------------------------------------------------

/**
 * THE PRICE CURVE, AND THE MEASUREMENT IT IS DERIVED FROM.
 *
 * A typical finished race pays about 80 credits -- that number is measured, not
 * guessed, and the measurement is written out in full at the top of
 * `src/score/wallet.ts`. Everything below is stated in races at that rate:
 *
 *      250   ~3 races     the first thing you buy, inside one sitting
 *      500   ~6 races     an evening
 *    1,000  ~13 races     a week of casual play
 *    2,000  ~25 races
 *    4,000  ~50 races     the chase item; one of these exists
 *
 * IT DOUBLES, AND THE DOUBLING IS THE POINT. Each tier costs twice the last,
 * so it also costs twice as many RACES as the last, which means the ladder
 * reads the same whether a player counts in credits or in evenings. A linear
 * ladder (250/500/750/1000) would have every tier feel like the same purchase
 * with a bigger number on it, and the top of the shop would arrive in a
 * fortnight with nothing left to want.
 *
 * Clearing the entire shop is 10,250 credits, about 128 races. That is the
 * figure to argue with if the shop ever feels like a grind -- not the
 * individual prices.
 */
export const PRICES = {
  cheap: 250,
  low: 500,
  mid: 1000,
  high: 2000,
  chase: 4000,
} as const

/**
 * RANK THRESHOLDS, read against lifetime `earned` -- never against `credits`.
 *
 * Spending must not cost you a rank. Reading the spendable balance would mean a
 * player who buys an avatar watches a rank portrait re-lock itself, which is
 * indefensible, and it is exactly why `PlayerProfile` carries both numbers.
 *
 * Same doubling ladder as the prices, for the same reason, and at ~80 credits a
 * race that puts them at roughly 25 / 63 / 125 / 250 / 500 races. The top one
 * is deliberately most of a season: it is the only thing on the roster that
 * cannot be bought, hurried, or got lucky into.
 */
export const RANKS = {
  pacer: 2000,
  keeper: 5000,
  apex: 10000,
  veteran: 20000,
  old: 40000,
} as const

// ---------------------------------------------------------------------------
// Feats
// ---------------------------------------------------------------------------

/**
 * WHAT A FEAT MAY BE, AND WHY THIS LIST IS SHORT.
 *
 * Every one of these is decided from numbers the game ALREADY produces at the
 * flag. That constraint threw out the better-sounding half of the list --
 * "win from the back of the grid" (the sim carries no starting position),
 * "shunt three cars in a lap" (`Scorer` totals knocks into the score and keeps
 * no count), "no wall contact for a whole race" (`wall` events are consumed
 * frame by frame and never tallied). A feat the game cannot observe is a lie
 * printed under a portrait, so none of those are here.
 *
 * What IS observable, and where it comes from:
 *
 *   position, finished   `RacerState.position` / `.finished`, the same pair
 *                        `circuit.ts` reads to award championship points.
 *   score, bestCombo     `Scorer.score` / `Scorer.bestCombo`, which already
 *                        travel to the board and to `RunRecord`.
 *   circuit standing     `champion()` and the local row from `standings()` in
 *                        `src/game/circuit.ts`.
 *
 * The thresholds are measured. Across 192 finishes driven headlessly (eight
 * circuits x three seeds x eight cars, `Scorer` run over the real event stream)
 * the ninetieth percentile score was 452,682 and the highest seen was 848,682 --
 * so 500,000 in one race sits just above nine races in ten and is reachable in
 * a genuinely good one. Best combo was at the x16 ceiling in the top tenth of
 * runs, which makes the combo feat hard but not exotic.
 */
export interface CircuitEvidence {
  /** `champion(state)` returned the local entrant outright -- not a tie. */
  won: boolean
  /** Rounds the local entrant has a result for: the standings row's `rounds`. */
  rounds: number
  /** Rounds entered and not finished: the standings row's `dnf`. */
  dnf: number
}

/** Everything a finished race offers the feat tests. */
export interface RaceFeatEvidence {
  /** `RacerState.finished` for the local racer. A DNF earns nothing. */
  finished: boolean
  /** Final position, 1-based. */
  position: number
  /** `Scorer.score` at the flag. */
  score: number
  /** `Scorer.bestCombo` for the run. */
  bestCombo: number
  /** Set only on the race that completed a Grand Circuit; null otherwise. */
  circuit: CircuitEvidence | null
}

/** The lifetime counters a feat may be re-derived from. */
export type ProfileCounters = Pick<PlayerProfile, 'races' | 'wins'>

/**
 * Rounds in a Grand Circuit.
 *
 * Copied rather than imported: `src/game/circuit.ts` reads `window.localStorage`
 * and importing it here would drag the browser into a module the server has to
 * be able to load. tests/wallet.test.ts asserts this equals `CIRCUIT_ROUNDS`,
 * so the copy cannot drift without a red test.
 */
export const FEAT_CIRCUIT_ROUNDS = 8

/** A single race score that earns `halfmillion`. See the measurement above. */
export const FEAT_SCORE = 500000

interface FeatSpec {
  /** The avatar this feat unlocks. */
  id: string
  /** Shown to the player verbatim, and the same string as the source's `how`. */
  how: string
  /** Decided from one finished race. */
  test: (ev: RaceFeatEvidence) => boolean
  /**
   * Re-derived from the lifetime counters, where that is possible.
   *
   * SELF-HEALING WHERE IT CAN BE. An unlock is a flag on a profile, and flags
   * get lost -- a failed write, a profile minted offline and reconciled later,
   * a server pass that rebuilds accounts. Two of these feats are implied by
   * counters the profile already keeps, so they are re-granted on sight rather
   * than mourned. The other three genuinely cannot be: nothing in a profile
   * remembers a combo.
   */
  fromProfile?: (p: ProfileCounters) => boolean
}

export const FEATS: readonly FeatSpec[] = [
  {
    id: 'flagbearer',
    how: 'Win a race.',
    test: (ev) => ev.finished && ev.position === 1,
    fromProfile: (p) => p.wins >= 1,
  },
  {
    id: 'singularity',
    // Built from COMBO_MAX so a re-tune of the ceiling moves the sentence and
    // the test together. A feat whose copy says x16 while its test wants x20 is
    // a support ticket nobody can reproduce.
    how: `Reach a ×${COMBO_MAX} combo in a single race.`,
    test: (ev) => ev.bestCombo >= COMBO_MAX,
  },
  {
    id: 'halfmillion',
    how: 'Score 500,000 points in a single race.',
    test: (ev) => ev.finished && ev.score >= FEAT_SCORE,
  },
  {
    id: 'laurel',
    how: 'Win the Grand Circuit.',
    test: (ev) => ev.circuit !== null && ev.circuit.won,
  },
  {
    id: 'ironrun',
    how: 'Finish all eight rounds of a Grand Circuit.',
    // Rounds AND no DNF: `standings()` counts a round the player retired from,
    // so `rounds` alone would pay out for eight starts rather than eight
    // finishes -- which is the opposite of what the sentence promises.
    test: (ev) => ev.circuit !== null
      && ev.circuit.rounds >= FEAT_CIRCUIT_ROUNDS
      && ev.circuit.dnf === 0,
  },
]

const FEAT_BY_ID = new Map<string, FeatSpec>(FEATS.map((f) => [f.id, f]))

/**
 * Which feat avatars this race just earned. Ids, in roster order, possibly
 * empty -- and possibly ones the player already owns, which the caller filters
 * because "already had it" is the caller's question, not this one's.
 */
export function featsEarned(ev: RaceFeatEvidence): string[] {
  return FEATS.filter((f) => f.test(ev)).map((f) => f.id)
}

/** Feats implied by the profile's own counters. See `fromProfile` above. */
export function featsFromProfile(p: ProfileCounters): string[] {
  return FEATS.filter((f) => f.fromProfile?.(p) === true).map((f) => f.id)
}

// ---------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------

const starter = (): AvatarSource => ({ kind: 'starter' })
const shop = (price: number): AvatarSource => ({ kind: 'shop', price })
const rank = (earned: number): AvatarSource => ({ kind: 'rank', earned })
const feat = (id: string): AvatarSource => ({
  kind: 'feat',
  // Read back out of FEATS so the sentence under the portrait and the test that
  // grants it are the same string, not two strings that agree today.
  how: FEAT_BY_ID.get(id)?.how ?? '',
})

function def(id: string, name: string, source: AvatarSource, accent: string): AvatarDef {
  return { id, name, source, src: srcFor(id), accent }
}

/**
 * ORDER IS THE PICKER'S ORDER: starters, then the shop by price, then the rank
 * ladder, then the feats. It is a progression a player can read top to bottom
 * -- what you have, what you can buy, what time gives you, what skill gives you
 * -- and it is stable, so a portrait never moves under the cursor.
 *
 * THE ACCENTS HAVE A JOB, AND ARE READ FROM THE ART. Each one is the ring on
 * the picker and the edge of the nameplate at 24px while a car goes past at
 * 60 m/s, so they are spread around the wheel and kept clear of the HUD's own
 * reds and ambers. Each portrait was painted with its accent as the rim light
 * and the halo behind the head, and these are the colours the finished art
 * actually glows -- checked against it by tools/import-art.mjs, which measures
 * each portrait's halo and flags any accent more than 30 degrees of hue away.
 * The four that moved when the art landed were the four whose character
 * changed: the dockhand (bay blue to toxic green), the storm ninja (gold to
 * electric indigo), and small corrections to the nomad's sand and the
 * pirate's rust.
 *
 * FIVE NAMES CHANGED WITH THE ART, AND NO ID DID. Bay Dockhand, Ember Hand,
 * Neon Saint, Storm Wright and Set Pacer became Dead Dockhand, Ember Oni, Neon
 * Count, Storm Ninja and El Pacer, because the portraits are a zombie, an oni,
 * a vampire, a ninja and a luchador. The ids are what saved profiles and the
 * account server point at, so they stay exactly as they were.
 */
export const AVATARS: readonly AvatarDef[] = [
  // --- starter: four faces nobody has to earn -------------------------------
  def('cadet', 'Rookie Cadet', starter(), '#8fa3b8'),
  def('wrench', 'Pit Wrench', starter(), '#d08a3c'),
  def('nomad', 'Dust Nomad', starter(), '#c49a5e'),
  def('marshal', 'Track Marshal', starter(), '#4fb3a4'),

  // --- shop: the bulk of the roster ----------------------------------------
  def('ferrypilot', 'Ferry Pilot', shop(PRICES.cheap), '#7b8fd6'),
  def('scrapjack', 'Scrap Jack', shop(PRICES.cheap), '#b0552c'),
  def('dockhand', 'Dead Dockhand', shop(PRICES.cheap), '#6fbf73'),
  def('emberhand', 'Ember Oni', shop(PRICES.low), '#e2663a'),
  def('frostwarden', 'Frost Warden', shop(PRICES.low), '#86c8f0'),
  def('tidecaller', 'Tide Caller', shop(PRICES.low), '#2f9c8a'),
  def('neonsaint', 'Neon Count', shop(PRICES.mid), '#ff4fa3'),
  def('stormwright', 'Storm Ninja', shop(PRICES.mid), '#6a7cff'),
  def('hollowcantor', 'Hollow Cantor', shop(PRICES.high), '#b06fe0'),
  def('voidsmith', 'Void Smith', shop(PRICES.chase), '#e8e2d0'),

  // --- rank: lifetime earnings, no purchase step ---------------------------
  def('pacer', 'El Pacer', rank(RANKS.pacer), '#9bd45e'),
  def('linekeeper', 'Line Keeper', rank(RANKS.keeper), '#58c7d8'),
  def('apexrunner', 'Apex Runner', rank(RANKS.apex), '#f2a93b'),
  def('veteran', 'Circuit Veteran', rank(RANKS.veteran), '#c86bf0'),
  def('oldguard', 'Old Guard', rank(RANKS.old), '#e6d27a'),

  // --- feat: one specific thing, done ---------------------------------------
  def('flagbearer', 'Flag Bearer', feat('flagbearer'), '#f5c542'),
  def('singularity', 'Singularity Hand', feat('singularity'), '#7de0ff'),
  def('halfmillion', 'Half Million', feat('halfmillion'), '#ffd166'),
  def('laurel', 'Grand Champion', feat('laurel'), '#ffb703'),
  def('ironrun', 'Iron Run', feat('ironrun'), '#9aa7b0'),
]

export const AVATAR_BY_ID: ReadonlyMap<string, AvatarDef> =
  new Map(AVATARS.map((a) => [a.id, a]))

/** Owned by every profile from the first launch. `PlayerProfile.unlocked` is
 *  documented as always containing these; this is the list it means. */
export const STARTER_IDS: readonly string[] =
  AVATARS.filter((a) => a.source.kind === 'starter').map((a) => a.id)

/**
 * What a brand new profile wears.
 *
 * The first starter rather than a random one: a new player's face should be the
 * same in the screenshot, the tutorial and the bug report. They can change it
 * in the picker, which is the point of the picker.
 */
export const DEFAULT_AVATAR_ID = STARTER_IDS[0]

// ---------------------------------------------------------------------------
// The query the UI asks
// ---------------------------------------------------------------------------

/**
 * Enough of a profile to answer every question below.
 *
 * Structural rather than the whole `PlayerProfile` so a caller with a partial
 * profile -- the offline one, a test, the server mid-transaction -- can ask
 * without inventing an id and a name it does not have.
 */
export type ProfileLike =
  Pick<PlayerProfile, 'unlocked' | 'credits' | 'earned'> & Partial<ProfileCounters>

/** Owned outright; affordable right now; visible but not yet available. */
export type AvatarStatus = 'owned' | 'buyable' | 'locked'

export interface AvatarView {
  def: AvatarDef
  status: AvatarStatus
  /**
   * The player-facing sentence for what this takes. Empty when owned.
   *
   * Composed here rather than in the UI so the picker, the nameplate tooltip
   * and the profile screen cannot each phrase the same rule differently -- and
   * so the rule and the sentence are edited in one place when a price moves.
   */
  requirement: string
  /** Credits still to find, for a shop avatar out of reach. 0 otherwise. */
  shortBy: number
  /**
   * How close this is to being available, 0..1, for a bar under the portrait.
   *
   * Credits over price for a shop row, lifetime earnings over threshold for a
   * rank row, 1 for anything owned, and 0 for a feat -- a feat has no partial
   * credit, and a bar that crept along would imply one.
   */
  progress: number
}

export interface AvatarCatalogue {
  all: readonly AvatarView[]
  owned: readonly AvatarView[]
  buyable: readonly AvatarView[]
  locked: readonly AvatarView[]
}

const owns = (p: ProfileLike, id: string): boolean =>
  p.unlocked.indexOf(id) >= 0

/**
 * Does this profile own this avatar?
 *
 * OWNERSHIP IS DERIVED WHERE IT CAN BE, AND STORED WHERE IT CANNOT.
 *
 *   starter  always. Never depends on a flag having been written.
 *   rank     whenever lifetime `earned` clears the threshold, flag or no flag.
 *            A rank is a fact about a number the profile already carries, so
 *            reading the flag instead would let a lost write un-rank a player
 *            who is demonstrably ranked.
 *   feat     the stored flag, plus the two that lifetime counters imply.
 *   shop     the stored flag only. A purchase IS the flag.
 *
 * The server may materialise any of these into `unlocked` whenever it likes;
 * doing so changes no answer here, which is what makes it safe to do lazily.
 */
export function ownsAvatar(p: ProfileLike, id: string): boolean {
  const a = AVATAR_BY_ID.get(id)
  if (!a) return false
  if (a.source.kind === 'starter') return true
  if (owns(p, id)) return true
  if (a.source.kind === 'rank') return p.earned >= a.source.earned
  if (a.source.kind === 'feat' && p.races !== undefined && p.wins !== undefined) {
    return FEAT_BY_ID.get(id)?.fromProfile?.({ races: p.races, wins: p.wins }) === true
  }
  return false
}

/** The price of a shop avatar, or 0 for anything not bought with credits. */
export function priceOf(id: string): number {
  const s = AVATAR_BY_ID.get(id)?.source
  return s?.kind === 'shop' ? s.price : 0
}

/**
 * May this profile buy this avatar right now?
 *
 * False for an avatar already owned, for one that is not for sale at any price,
 * and for one the balance does not cover. The wallet enforces the balance again
 * on the way out -- see `Wallet.spend` -- because a check and a spend that are
 * separate calls can always be separated by something.
 */
export function canBuy(p: ProfileLike, id: string): boolean {
  const a = AVATAR_BY_ID.get(id)
  if (!a || a.source.kind !== 'shop') return false
  if (ownsAvatar(p, id)) return false
  if (artPending(id)) return false
  return p.credits >= a.source.price
}

/** Rank avatars this lifetime total has earned, in roster order. */
export function ranksEarned(earned: number): string[] {
  return AVATARS.filter((a) => a.source.kind === 'rank' && earned >= a.source.earned)
    .map((a) => a.id)
}

/** Thousands separators, without building an Intl formatter per call. */
function comma(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function viewOf(p: ProfileLike, a: AvatarDef): AvatarView {
  if (ownsAvatar(p, a.id)) {
    return { def: a, status: 'owned', requirement: '', shortBy: 0, progress: 1 }
  }
  switch (a.source.kind) {
    case 'shop': {
      const price = a.source.price
      if (artPending(a.id)) {
        return {
          def: a, status: 'locked',
          requirement: `Arriving soon — ${comma(price)} credits.`,
          shortBy: 0, progress: 0,
        }
      }
      const short = Math.max(0, price - p.credits)
      return {
        def: a,
        status: short > 0 ? 'locked' : 'buyable',
        requirement: short > 0
          ? `Buy for ${comma(price)} credits — ${comma(short)} to go.`
          : `Buy for ${comma(price)} credits.`,
        shortBy: short,
        // Progress toward affording it, so a locked shop row can show a bar
        // instead of a flat "no". It is the same question a rank row asks.
        progress: price > 0 ? Math.max(0, Math.min(1, p.credits / price)) : 1,
      }
    }
    case 'rank': {
      const need = a.source.earned
      const short = Math.max(0, need - p.earned)
      return {
        def: a,
        status: 'locked',
        requirement: `Earn ${comma(need)} credits in total — ${comma(short)} to go.`,
        shortBy: 0,
        progress: need > 0 ? Math.max(0, Math.min(1, p.earned / need)) : 1,
      }
    }
    case 'feat':
      return {
        def: a, status: 'locked', requirement: a.source.how, shortBy: 0, progress: 0,
      }
    default:
      // A starter is owned by everyone and was answered above. Reaching here
      // means the union grew and this switch did not.
      return { def: a, status: 'owned', requirement: '', shortBy: 0, progress: 1 }
  }
}

/**
 * The whole picker, in one pass: what is owned, what can be bought now, and
 * what is visible but out of reach with the reason why.
 *
 * LOCKED AVATARS ARE RETURNED, NOT HIDDEN. A shop the player cannot see is a
 * shop that gives them no reason to earn anything, and a rank portrait only
 * works as a goal if the goal is on screen. The `requirement` sentence is what
 * makes that honest rather than teasing.
 */
export function catalogueFor(p: ProfileLike): AvatarCatalogue {
  const all = AVATARS.map((a) => viewOf(p, a))
  return {
    all,
    owned: all.filter((v) => v.status === 'owned'),
    buyable: all.filter((v) => v.status === 'buyable'),
    locked: all.filter((v) => v.status === 'locked'),
  }
}

/**
 * The avatar a profile should actually be wearing.
 *
 * Falls back to the default when the stored choice is unknown or no longer
 * owned -- an id from an older build, a feat flag that did not survive, a
 * hand-edited profile. `PlayerProfile.avatarId` is documented as always being
 * one of `unlocked`, and this is the function that makes that true rather than
 * hoping it is.
 */
export function wornAvatar(p: ProfileLike, avatarId: string): AvatarDef {
  if (ownsAvatar(p, avatarId)) {
    const a = AVATAR_BY_ID.get(avatarId)
    if (a) return a
  }
  return AVATAR_BY_ID.get(DEFAULT_AVATAR_ID) as AvatarDef
}
