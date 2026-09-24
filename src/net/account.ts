/**
 * SpaceGen Racing — ACCOUNTS. The protocol, and the browser half of it.
 * ---------------------------------------------------------------------------
 * `AccountService` from ./types.ts, implemented against a real endpoint:
 * `handleAccount` is everything the server decides, `LiveAccountService` is the
 * client that calls it, and `netlify/functions/account.mts` is the forty lines
 * of HTTP and Blobs in between.
 *
 * ===========================================================================
 * WHY THE SERVER LOGIC IS IN src/ AND NOT IN THE FUNCTION
 *
 * The same argument netlify.toml already makes for the leaderboard importing
 * src/score/verify.ts, and net/signalProtocol.ts makes at greater length: logic
 * that only exists inside a deployed function is logic that can only be tested
 * by deploying. `handleAccount` takes its storage, its clock, its id source and
 * its hash as arguments, so every branch below runs in tests/account.test.ts
 * against a Map, in under a millisecond, with no Netlify and no network.
 *
 * IT IS ONE FILE RATHER THAN TWO ONLY BECAUSE THE PASS WAS SCOPED THAT WAY.
 * signalProtocol.ts/signal.ts split the same seam across two modules and that
 * is the tidier shape; splitting this one is a pure file move (`handleAccount`
 * and everything above it into `accountProtocol.ts`, the class and everything
 * below it staying here) and should happen the next time anybody is in here.
 * Nothing in the client half imports the server half, so Vite drops it from the
 * bundle and a browser never ships the handler.
 *
 * ===========================================================================
 * WHAT AN ACCOUNT IS, AND WHAT A LOST SECRET COSTS
 *
 * types.ts calls it ANONYMOUS BUT OWNED: no email, no password, no signup
 * screen. First launch asks the server to mint an id and a secret; the secret
 * lives on the device and authenticates every later call. The player never sees
 * either.
 *
 * THE SECRET IS NOT RECOVERABLE AND CANNOT BE MADE RECOVERABLE. Recovery means
 * proving you are the same person through some channel, and the only channel an
 * anonymous account has is the device holding the secret. Anything else -- an
 * email, a recovery code the player writes down, a question -- is the signup
 * screen arriving by the back door, which is the thing that was refused.
 *
 * So: CLEARING SITE DATA IS DELETING THE ACCOUNT. A new device or a cleared
 * browser mints a NEW id with a new default name; the credits, the unlocks and
 * the claimed name stay with the old account for ever. That is a real cost and
 * it should be said in the UI rather than discovered -- the profile screen's
 * `ephemeral` banner is the right place and the wording is in the report.
 *
 * It is a survivable cost because of what it is priced in: at ~80 credits a
 * race (src/score/wallet.ts), a wiped account is a few evenings, not a
 * purchase. It would NOT be survivable the day anything here is bought with
 * money, and that is the day this scheme has to grow a real sign-in -- which
 * types.ts already anticipated: attaching an email to an existing id is a
 * migration of one column rather than of everybody's progress.
 *
 * ===========================================================================
 * WHAT THIS ENDPOINT KNOWS ABOUT A RACE: NOTHING
 *
 * `award` is handed a number of credits by the client that just raced, and
 * there is no way for the server to tell a real one from an invented one. The
 * leaderboard has exactly this problem and its header is candid about it; this
 * one is worse, because a leaderboard row is bragging and a credit is spendable.
 *
 * SO THIS FILE DOES NOT CLAIM TO VALIDATE ANYTHING. What it actually does, in
 * the order the defences bite:
 *
 *   1. IT BOUNDS ONE RACE. `MAX_PER_RACE` (200, from wallet.ts, imported rather
 *      than copied) is the most a single post can pay. A client that posts a
 *      billion is paid 200 and the clamp is recorded.
 *   2. IT BOUNDS THE RATE. Races take 160-280 seconds (measured, see wallet.ts)
 *      so awards have a physical ceiling. `AWARD_MIN_GAP_MS` and
 *      `AWARD_PER_HOUR` enforce a pace no honest player can exceed and no
 *      forger can beat. Together with (1) that is a hard ceiling of
 *      AWARD_PER_HOUR * MAX_PER_RACE = 2,400 credits an hour, against a
 *      10,250-credit shop: the fastest possible forgery is about four and a
 *      half hours of posting, not one request.
 *   3. IT RECORDS. Every account carries its last `AWARD_LOG` awards and counts
 *      how many posts were clamped or refused for pace. Not to enforce
 *      anything -- to make "this account has been clamped four hundred times" a
 *      fact on the record for the day somebody looks, rather than an archaeology
 *      project across function logs that have rotated away.
 *   4. IT DERIVES EVERY UNLOCK AND ACCEPTS NONE -- NO LONGER QUITE TRUE; see
 *      below for exactly where the line moved. A client cannot post "and I
 *      unlocked Old Guard". Rank avatars come from `ranksEarned(earned)` and
 *      the two counter-implied feats from `featsFromProfile({races, wins})`,
 *      both computed here from this server's own numbers; shop avatars come
 *      from `buy`, where this server holds the balance.
 *
 * WHAT IS LEFT OVER IS THE BALANCE ITSELF, AND IT IS NOT VERIFIED. The board is
 * labelled UNVERIFIED where players can see it; the same sentence belongs on
 * the profile screen, and asking for it is in the report. The honest fix is the
 * same one the leaderboard is waiting for -- re-simulating a submitted input
 * trace -- and `award`'s signature in types.ts is already shaped for it.
 *
 * ===========================================================================
 * ACHIEVEMENTS, AND THE TRUST CHANGE THEY BRING
 *
 * `achieve` posts a device's whole achievement snapshot (content/achievements
 * .ts): the ids it claims to have earned and its lifetime counters. This
 * server can check the SHAPE of that and nothing about its truth -- it has
 * never seen a race. So, candidly, in the order the defences bite:
 *
 *   1. IDS ARE VALIDATED against the catalogue. An id this build does not
 *      know is dropped and counted (`achRejected`).
 *   2. ONLY EVIDENCE IS ACCEPTED AS A CLAIM. A clean lap, a win on Expert, a
 *      x16 combo: one race proved it and only the client saw the race. Tier,
 *      profile and set-of-others achievements (Knockouts silver, Tycoon, World
 *      Tour) are NOT taken from the post -- they are re-derived here from this
 *      record's own counters and profile, every read.
 *   3. COUNTERS ARE BOUNDED PER POST. Each may rise by at most its per-race
 *      ceiling (`COUNTER_CEILING`, measured) times the number of races that
 *      could physically have been driven since the last accepted post -- one
 *      per AWARD_MIN_GAP_MS of wall clock, at most AWARD_PER_HOUR of them. New
 *      evidence claims are bounded the same way (ACH_EVIDENCE_PER_RACE per
 *      race). The excess is not refused, it is DEFERRED: the device posts its
 *      whole snapshot every time, so what one post could not carry the next
 *      one will, once the clock has moved. Clamps are counted (`achClamped`).
 *   4. THE RATE IS LIMITED like `award`'s -- ACH_MIN_GAP_MS apart, at most
 *      ACH_PER_HOUR an hour, refusals counted -- on a ledger of its own, so an
 *      achievement sync can never cost the race its credits.
 *   5. MERGES CANNOT GO DOWN. Union and max: a post can add, never remove.
 *
 * AND THE LINE THAT MOVED. Four feat portraits now hang off synced state --
 * Singularity Hand off Combo King, Half Million off High Roller, Grand
 * Champion off Grand Champion, Iron Run off `mark:ironrun` -- and `toProfile`
 * derives them from what this record holds (`featsFromUnlocks`). Those
 * achievements are EVIDENCE, so those four portraits are now CLIENT-CLAIMED,
 * exactly as the balance is: a forger who lies can own them. That is the
 * price of granting them at all -- before this, nobody could own them, because
 * `award` was never told a combo, a score or a standing -- and it is bounded
 * the way everything else here is: per post, per hour, and on the record.
 * Flag Bearer is unchanged (a win is still a counter this server owns), and
 * the rank ladder and the shop still derive nothing from a client's word.
 *
 * The honest fix is the same one again: replaying a submitted input trace
 * would let this server SEE the combo, and `achieve` would then carry the
 * trace instead of the claim.
 */
import {
  AVATAR_BY_ID, DEFAULT_AVATAR_ID, STARTER_IDS, PRICES,
  artPending, featsFromProfile, ownsAvatar, priceOf, ranksEarned,
} from '../content/avatars'
import {
  ACHIEVEMENTS, COUNTERS, COUNTER_CEILING, asSnapshot, featsFromUnlocks, isClaimable,
  isKnownId, isMark, withDerived,
  type AchievementSnapshot, type Counters,
} from '../content/achievements'
import { MAX_PER_RACE } from '../score/wallet'
import {
  NAME_RULES,
  type AccountService, type AchievementSync, type NameError, type PlayerProfile, type Result,
} from './types'

/** Where the function is mounted. Imported by the client so there is one path. */
export const ACCOUNT_PATH = '/api/account'

/**
 * Account id length, in characters of `ALPHABET`.
 *
 * Sixteen symbols of a 32-symbol alphabet is 80 bits. An id is not a secret --
 * it is on every lobby row, because net/index.ts builds the live peer id out of
 * it -- so this is sized against accidental collision rather than against
 * guessing, and 80 bits is far past the point where a birthday collision is
 * worth thinking about.
 */
export const ID_CHARS = 16

/**
 * Secret length.
 *
 * Thirty-two symbols is 160 bits of crypto randomness. THAT NUMBER IS WHY THE
 * SERVER STORES A PLAIN SHA-256 OF IT AND NOT A PASSWORD HASH. Argon2 and
 * friends exist to make each guess expensive because human-chosen passwords
 * come from a small space; a 160-bit random string has no small space to search,
 * so a slow KDF would buy nothing and cost a CPU-second per request. What the
 * hash IS for is that a leaked copy of the blob store is then not a leaked set
 * of credentials -- which is the realistic failure, and the reason the raw
 * secret is never written down on this side.
 */
export const SECRET_CHARS = 32

/**
 * No O/0 and no I/1, as in netlify/functions/signal.mts.
 *
 * Ids are not read aloud the way a join code is, so the confusable pairs matter
 * less here -- but they turn up in bug reports, support messages and screenshots
 * of devtools, and one alphabet across the project is worth more than four bits
 * of entropy per character.
 */
export const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * Shortest gap between two awards on one account, milliseconds.
 *
 * NOT A GUESS: wallet.ts's measurement puts a finished race at 159-280 seconds,
 * and `Wallet.bank` only fires `onBank` when the payout is positive, which only
 * happens on a finish. So no honest client can reach this floor -- thirty
 * seconds is five times inside the shortest race ever measured, which leaves
 * room for a future sprint circuit without a code change while still refusing a
 * script.
 */
export const AWARD_MIN_GAP_MS = 30_000

/** Awards accepted per account per `AWARD_WINDOW_MS`. Twelve races an hour is
 *  a three-hundred-second race back to back with no breaks; nobody plays like
 *  that, and a forger who does is capped at 2,400 credits for the hour. */
export const AWARD_PER_HOUR = 12
export const AWARD_WINDOW_MS = 3_600_000

/** How many recent awards an account carries. Two hours of the cap above, so
 *  the window question can always be answered from the record itself. */
export const AWARD_LOG = 24

/**
 * Achievement syncs: the same gap and the same hourly cap as awards, on a
 * ledger of their own.
 *
 * THE SAME NUMBERS, because the honest client posts one after every race --
 * finished or quit -- and races are what AWARD_MIN_GAP_MS is already measured
 * against. A LEDGER OF THEIR OWN, because a finished race posts BOTH, a second
 * apart, and a shared ledger would refuse whichever came second: an
 * achievement sync must never cost the race its credits, or the other way
 * round. score/progress.ts mirrors the gap on the client so an honest device
 * holds its post rather than earning a refusal on the record for it.
 */
export const ACH_MIN_GAP_MS = AWARD_MIN_GAP_MS
export const ACH_PER_HOUR = AWARD_PER_HOUR

/**
 * The most NEW evidence achievements one race can prove.
 *
 * Counted, not guessed: eight track badges, one Front Runner, Untouchable,
 * Comeback, Photo Finish, Iron Will, Clean Sweep, Combo King, High Roller,
 * Grand Champion, and the two marks -- nineteen, and one race cannot actually
 * reach all of them (Untouchable and Iron Will exclude each other). Twenty is
 * the bound per race of allowance.
 */
export const ACH_EVIDENCE_PER_RACE = 20

/**
 * Tries a read-modify-write gets before giving up.
 *
 * Every mutation below is a compare-and-swap against the record's ETag (see
 * `AccountStore`), so a lost update is DETECTED rather than silently taken.
 * Three is generous: a collision needs two writes to one account inside one
 * round trip, which means the same player in two tabs, and the second attempt
 * already sees the first one's result.
 */
export const MUTATE_TRIES = 3

/** Record shape version. Bumped when the SHAPE changes; unknown content (an
 *  avatar id that was retired) is filtered on the way out instead. */
export const RECORD_VERSION = 1

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * FOUR METHODS, AND TWO OF THEM ARE CONDITIONAL. THIS IS THE WHOLE DESIGN.
 *
 * net/signalProtocol.ts says, in as many words, "no compare-and-swap, no
 * transactions, no atomic append", and builds every safety property it needs
 * out of key layout instead. That was true of the three-method slice it uses
 * and it is NOT true of Netlify Blobs, which since v7 takes conditions on a
 * write and reports back whether the write happened:
 *
 *     store.setJSON(key, v, { onlyIfNew: true })   -> { modified, etag }
 *     store.setJSON(key, v, { onlyIfMatch: etag }) -> { modified, etag }
 *
 * `onlyIfNew` is create-if-absent and `onlyIfMatch` is compare-and-swap, and
 * between them they are exactly the primitive a name claim needs. So this
 * interface exposes them as `create` and `replace` rather than as a `set` with
 * options, because a caller that can reach an unconditional write will
 * eventually use one, and the one unconditional write in this file is the one
 * that would give two players the same name.
 *
 * `replace` takes a nullable etag because `getWithMetadata` declares its own
 * etag optional. A null tag means the store could not give us one and the write
 * degrades to unconditional -- documented at the call site, and the reason
 * `mutate` re-reads rather than trusting what it wrote.
 */
export interface AccountStore {
  /** The value at `key` with its ETag, or null when the key is empty. */
  get(key: string): Promise<{ value: unknown; etag: string | null } | null>
  /** Write only if the key does not exist. True when this call created it. */
  create(key: string, value: unknown): Promise<boolean>
  /** Write only if the key still carries `etag`. True when this call wrote it.
   *  A null `etag` writes unconditionally; see the note above. */
  replace(key: string, value: unknown, etag: string | null): Promise<boolean>
  del(key: string): Promise<void>
}

const acctKey = (id: string): string => `acct/${id}`

/**
 * The name index key.
 *
 * LOWERCASED, because names are claimed case-insensitively: two players called
 * `Nova` and `nova` in one race is a nameplate bug wearing a uniqueness
 * constraint. net/mock.ts's `nameKey` says the same thing about the same rule,
 * and the two have to agree or the mock and the server disagree about what
 * "taken" means.
 */
export const nameKey = (name: string): string => `name/${name.trim().toLowerCase()}`

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** One entry in the anti-farm ledger. */
export interface AwardEntry {
  at: number
  paid: number
}

/**
 * An account, as the server stores it.
 *
 * `owned` HOLDS ONLY WHAT CANNOT BE DERIVED -- shop purchases and the three
 * evidence feats. Ranks and the two counter-implied feats are recomputed on
 * every read from `earned`, `races` and `wins`, which is the licence
 * content/avatars.ts explicitly grants ("the server may materialise any of
 * these into `unlocked` whenever it likes") and which means a lost write cannot
 * un-rank a player who is demonstrably ranked.
 */
export interface AccountRecord {
  v: number
  id: string
  /** SHA-256 of the device secret, hex. The secret itself is never stored. */
  secretHash: string
  name: string
  avatarId: string
  owned: string[]
  credits: number
  earned: number
  races: number
  wins: number
  createdAt: number
  /** Last successful authenticated call. Not read by anything today; written
   *  so a future name-expiry sweep does not need a migration first. */
  seenAt: number
  awards: AwardEntry[]
  /** Posts clamped by MAX_PER_RACE, and posts refused for pace. Forensics. */
  clamped: number
  refused: number
  /**
   * CLAIMED achievement ids and marks -- evidence only, validated. Tier,
   * profile and set-of-others achievements are never stored here; they are
   * derived on every read (`achievementsOf`). See the header.
   */
  ach: string[]
  /** Lifetime achievement counters, each bounded per post. */
  achCounters: Counters
  /** The last accepted sync: the clock the per-post allowance is measured on. */
  achAt: number
  /** Recent accepted syncs, newest first, for the pace limiter. */
  achSyncs: number[]
  /** Syncs clamped by a bound, refused for pace, and ids dropped as unknown. */
  achClamped: number
  achRefused: number
  achRejected: number
}

/** What the name index holds. The `at` is for the same future sweep. */
export interface NameClaim {
  id: string
  at: number
}

// ---------------------------------------------------------------------------
// Sanitising
// ---------------------------------------------------------------------------
//
// Everything below assumes the body is hostile, because it is a public POST.
// The rule is signalProtocol.ts's, which is the leaderboard's: CLAMP RATHER
// THAN REJECT wherever a clamp has an obvious right answer, and reject only
// where there is no honest default.

const num = (v: unknown, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : d

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)

/** Ids we minted, and only ids we minted. Length is pinned rather than bounded
 *  because every id this server ever issued is exactly `ID_CHARS` long, so
 *  anything else is a forgery or a bug and both deserve the same answer. */
export const idOk = (v: unknown): v is string =>
  typeof v === 'string' && v.length === ID_CHARS && /^[A-Z2-9]+$/.test(v)

const secretOk = (v: unknown): v is string =>
  typeof v === 'string' && v.length === SECRET_CHARS && /^[A-Z2-9]+$/.test(v)

/**
 * The `NameError`s a name's own text can produce.
 *
 * NARROWER THAN `NameError`, AND THE COMPILER SHOULD KNOW IT. `taken` needs the
 * index and `offline` needs the network, so neither can come out of a pure
 * check of a string -- and typing this as the full union would force every
 * caller to handle two cases that cannot arrive, or to widen its own error type
 * to include `offline`, which is what `AccountError` correctly refuses.
 *
 * `Extract` rather than a fresh union of three literals, so that renaming a
 * case in types.ts breaks this line rather than silently leaving it behind.
 */
export type NameShapeError = Extract<NameError, 'short' | 'long' | 'charset'>

/**
 * `NAME_RULES`, applied in the order the player will understand.
 *
 * DUPLICATED FROM net/mock.ts's `checkNameShape` RATHER THAN IMPORTED, for the
 * reason net/live.ts gives about `inputDelayFor`: mock.ts is the mock, and a
 * live code path that imports from it is one refactor away from shipping a
 * mock. The rules themselves are not duplicated -- both read `NAME_RULES` out
 * of types.ts, which is the thing that must not drift.
 *
 * Length before charset, because "too short" is a more useful thing to be told
 * about "a" than "that character is not allowed", which is what the pattern
 * would say: a one-character name fails the pattern too, since it demands an
 * alphanumeric at each end and "a" has only one end.
 */
export function checkNameShape(name: string): NameShapeError | null {
  if (name.length < NAME_RULES.min) return 'short'
  if (name.length > NAME_RULES.max) return 'long'
  if (!NAME_RULES.pattern.test(name)) return 'charset'
  return null
}

/**
 * A stored record, or null if the key holds something this build cannot read.
 *
 * Untrusted in exactly the way signalProtocol.ts's `asRecord` is untrusted: an
 * older build, a half-finished write, a hand-edited blob. An avatar id that no
 * longer exists is DROPPED rather than rejected -- losing a retired portrait is
 * a smaller harm than losing the whole account, which is the same call
 * content/avatars.ts makes about a retired pilot id.
 */
export function asRecord(raw: unknown): AccountRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (num(r.v, -1) !== RECORD_VERSION) return null
  if (!idOk(r.id)) return null
  const secretHash = str(r.secretHash)
  if (!/^[0-9a-f]{64}$/.test(secretHash)) return null
  const name = str(r.name)
  if (checkNameShape(name) !== null) return null
  const owned: string[] = []
  if (Array.isArray(r.owned)) {
    for (const a of r.owned) {
      const id = str(a)
      if (id && AVATAR_BY_ID.has(id) && !owned.includes(id)) owned.push(id)
    }
  }
  const awards: AwardEntry[] = []
  if (Array.isArray(r.awards)) {
    for (const a of r.awards) {
      if (!a || typeof a !== 'object') continue
      const e = a as Record<string, unknown>
      const at = num(e.at, 0)
      if (at <= 0) continue
      awards.push({ at, paid: Math.max(0, Math.floor(num(e.paid, 0))) })
    }
  }
  const credits = Math.max(0, Math.floor(num(r.credits, 0)))
  return {
    v: RECORD_VERSION,
    id: r.id,
    secretHash,
    name,
    avatarId: str(r.avatarId, DEFAULT_AVATAR_ID),
    owned,
    credits,
    /**
     * LIFETIME EARNINGS ARE NOT BOUNDED BELOW BY THE BALANCE, and an earlier
     * cut of this line clamped them to it on the theory that a lost write must
     * never demote a ranked player. That theory is wrong, and the test that
     * caught it is worth keeping: a NEW ACCOUNT IS GIVEN `PRICES.cheap`
     * CREDITS IT DID NOT EARN, so `credits: 250, earned: 0` is the correct
     * opening state and the clamp turned every first race into a 250-credit
     * head start up the rank ladder.
     *
     * net/mock.ts's `readProfile` makes the same call in the same words --
     * `Math.max(0, num(o.earned, 0))` and nothing else -- which is what the two
     * implementations of one contract agreeing looks like.
     */
    earned: Math.max(0, Math.floor(num(r.earned, 0))),
    races: Math.max(0, Math.floor(num(r.races, 0))),
    wins: Math.max(0, Math.floor(num(r.wins, 0))),
    createdAt: Math.max(0, num(r.createdAt, 0)),
    seenAt: Math.max(0, num(r.seenAt, 0)),
    awards: awards.sort((a, b) => b.at - a.at).slice(0, AWARD_LOG),
    clamped: Math.max(0, Math.floor(num(r.clamped, 0))),
    refused: Math.max(0, Math.floor(num(r.refused, 0))),
    /**
     * THE ACHIEVEMENT FIELDS ARE ADDITIVE, AND THAT IS WHY `v` DID NOT MOVE.
     *
     * RECORD_VERSION is "bumped when the SHAPE changes", and a bump makes this
     * function return null for every record written before it -- which
     * `handleAccount` reports as `nosuch`, and which the client answers by
     * minting a NEW account. Bumping here would have deleted every player's
     * credits, unlocks and claimed name to add a field. These are read with
     * the default a brand new account has (nothing earned, never synced), so a
     * record from before this pass is exactly an account that has not synced
     * yet, which is what it is.
     *
     * Untrusted like the rest: claims go through the catalogue's sanitiser,
     * and a stored id that is no longer claimable (a badge re-classified as
     * derived) is dropped here rather than being trusted forever.
     */
    ...readAchievementFields(r),
  }
}

/** The achievement half of `asRecord`. See the note at its call site. */
function readAchievementFields(r: Record<string, unknown>): Pick<AccountRecord,
  'ach' | 'achCounters' | 'achAt' | 'achSyncs' | 'achClamped' | 'achRejected' | 'achRefused'> {
  const { snap } = asSnapshot({ unlocked: r.ach, counters: r.achCounters })
  const syncs: number[] = []
  if (Array.isArray(r.achSyncs)) {
    for (const t of r.achSyncs) {
      const at = num(t, 0)
      if (at > 0) syncs.push(at)
    }
  }
  return {
    ach: snap.unlocked.filter(isClaimable),
    achCounters: snap.counters,
    achAt: Math.max(0, num(r.achAt, 0)),
    achSyncs: syncs.sort((a, b) => b - a).slice(0, AWARD_LOG),
    achClamped: Math.max(0, Math.floor(num(r.achClamped, 0))),
    achRejected: Math.max(0, Math.floor(num(r.achRejected, 0))),
    achRefused: Math.max(0, Math.floor(num(r.achRefused, 0))),
  }
}

/** A stored name claim, or null. */
function asClaim(raw: unknown): NameClaim | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!idOk(r.id)) return null
  return { id: r.id, at: Math.max(0, num(r.at, 0)) }
}

/**
 * The record as the contract's `PlayerProfile`.
 *
 * THE DERIVED UNLOCKS ARE MATERIALISED HERE AND NOWHERE ELSE, so there is
 * exactly one expression in the project that answers "what does this account
 * own" on the server's authority. `avatarId` is re-checked against the result
 * because `PlayerProfile` documents it as always being one of `unlocked`, and
 * this is the function that makes that true rather than hoping it is.
 */
export function toProfile(rec: AccountRecord): PlayerProfile {
  const unlocked = new Set<string>(STARTER_IDS)
  for (const id of rec.owned) unlocked.add(id)
  for (const id of ranksEarned(rec.earned)) unlocked.add(id)
  for (const id of featsFromProfile({ races: rec.races, wins: rec.wins })) unlocked.add(id)
  // THE FEATS THE ACHIEVEMENTS GRANT, derived here on the same terms as the
  // ranks: from what this record holds, on every read, never stored. The
  // counters are folded in so Race Wins bronze (Flag Bearer) follows the
  // achievement counter as well as `wins`. See the header for what this does
  // to the trust model -- these are the four portraits that are now claimed.
  const ach = withDerived({ unlocked: rec.ach, counters: rec.achCounters })
  for (const id of featsFromUnlocks(ach.unlocked)) unlocked.add(id)
  return {
    id: rec.id,
    name: rec.name,
    avatarId: unlocked.has(rec.avatarId) ? rec.avatarId : DEFAULT_AVATAR_ID,
    unlocked: [...unlocked],
    credits: rec.credits,
    earned: rec.earned,
    races: rec.races,
    wins: rec.wins,
  }
}

/**
 * The account's whole achievement wall: what it claimed, what its counters
 * imply, and what its profile implies (Tycoon from `earned`, Collector from
 * portraits owned, and `wins`/`races` as floors under the race counters).
 *
 * Derived on every read, never stored, for the reason `toProfile` derives
 * ranks: a derived unlock is a fact about numbers this record already holds,
 * and storing it would be a second copy that a lost write could disagree with.
 */
export function achievementsOf(rec: AccountRecord): AchievementSnapshot {
  const p = toProfile(rec)
  return withDerived(
    { unlocked: [...rec.ach], counters: { ...rec.achCounters } },
    { unlocked: p.unlocked, earned: p.earned, credits: p.credits, races: p.races, wins: p.wins },
  )
}

/**
 * Races that could physically have been driven since the last accepted sync:
 * one per AWARD_MIN_GAP_MS of wall clock, at least one and at most
 * AWARD_PER_HOUR.
 *
 * Measured from `achAt`, or from account creation for a first sync. The same
 * floor `award` uses, and for the same reason: no honest race is shorter than
 * five of these gaps, so this overstates what an honest player can have done,
 * and a lobby race of ten laps -- five times as long -- is still inside it.
 *
 * A clock that went backwards (a future `achAt`) is one race, not zero and not
 * an infinity: see `pacedOut` for the same trade on the award ledger.
 */
export function achAllowance(rec: AccountRecord, now: number): number {
  const since = now - (rec.achAt > 0 ? rec.achAt : rec.createdAt)
  const n = Math.floor(since / AWARD_MIN_GAP_MS)
  return Math.max(1, Math.min(AWARD_PER_HOUR, Number.isFinite(n) ? n : 1))
}

/**
 * Fold one post into a record's achievements, BOUNDED. Pure: the handler
 * below commits what this returns.
 *
 * Counters: union-by-max, but a counter may rise by at most its per-race
 * ceiling times the allowance. Claims: only claimable ids (evidence and
 * marks), at most ACH_EVIDENCE_PER_RACE new ones per race of allowance, taken
 * in catalogue order so the same over-full post always keeps the same ones.
 * Everything over a bound is left out of THIS post, flagged as a clamp, and
 * accepted on a later one -- the device posts its whole snapshot every time.
 */
export function mergeAchievementPost(
  rec: AccountRecord, posted: AchievementSnapshot, now: number,
): { ach: string[]; counters: Counters; clamped: boolean; ignored: number } {
  const allowance = achAllowance(rec, now)
  let clamped = false
  const counters: Counters = { ...rec.achCounters }
  for (const k of COUNTERS) {
    const prev = rec.achCounters[k] ?? 0
    const want = posted.counters[k] ?? 0
    if (want <= prev) continue
    const cap = prev + COUNTER_CEILING[k] * allowance
    counters[k] = Math.min(want, cap)
    if (want > cap) clamped = true
  }

  const have = new Set(rec.ach)
  const fresh = posted.unlocked.filter((id) => isClaimable(id) && !have.has(id))
  // Derived and tier ids are legitimate and simply not ours to take: counted
  // as ignored rather than rejected, because a well-behaved client sends them.
  const ignored = posted.unlocked.filter((id) => !isClaimable(id)).length
  // Catalogue order, marks last, so a clamp is deterministic.
  const order = new Map<string, number>(ACHIEVEMENTS.map((a, i) => [a.id, i]))
  fresh.sort((a, b) => (order.get(a) ?? (isMark(a) ? 1e6 : 2e6)) - (order.get(b) ?? (isMark(b) ? 1e6 : 2e6)))
  const room = ACH_EVIDENCE_PER_RACE * allowance
  if (fresh.length > room) clamped = true
  const ach = [...rec.ach, ...fresh.slice(0, room)].filter(isKnownId)
  return { ach, counters, clamped, ignored }
}

/** May this account sync achievements right now? `pacedOut` on its own ledger. */
function achPacedOut(rec: AccountRecord, now: number): boolean {
  const recent = rec.achSyncs.filter((t) => now - t < AWARD_WINDOW_MS)
  const last = recent[0]
  if (last !== undefined && last <= now && now - last < ACH_MIN_GAP_MS) return true
  return recent.length >= ACH_PER_HOUR
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

export type AccountRequest =
  /** No auth: this is the call that issues the credential. */
  | { op: 'mint'; name?: string }
  | { op: 'load'; id: string; secret: string }
  | { op: 'name'; id: string; secret: string; name: string }
  | { op: 'avatar'; id: string; secret: string; avatarId: string }
  | { op: 'buy'; id: string; secret: string; avatarId: string }
  | { op: 'award'; id: string; secret: string; credits: number; won: boolean }
  /** A device's whole achievement snapshot. Untrusted; see the header. */
  | { op: 'achieve'; id: string; secret: string; progress: unknown }

/**
 * Everything that can come back other than a profile.
 *
 * A UNION OF STRING LITERALS RATHER THAN `string`, so the client's mapping from
 * a wire error to a `NameError` or to a shop sentence is checked rather than
 * hoped for. `NameError`'s four server-decidable cases are in here verbatim;
 * `offline` is not, because it is a statement about the client's own network
 * that the server is by definition in no position to make.
 */
export type AccountError =
  /** The body was not a request this build understands. */
  | 'bad-body'
  /** No such account. The device holds a credential this server never issued
   *  -- a wiped store, or an id from the mock. The client mints a new one. */
  | 'nosuch'
  /** The id exists and the secret does not match it. Should be impossible;
   *  see the client, which treats it as a bug rather than as a state. */
  | 'badsecret'
  | 'short' | 'long' | 'charset' | 'taken'
  /** No avatar with that id in this build's catalogue. */
  | 'unknown'
  /** Real, but this account has not earned it. */
  | 'locked'
  /** Already owned, so there is nothing to buy. */
  | 'owned'
  /** A rank or feat portrait, which is not for sale at any price. */
  | 'notforsale'
  /** The balance does not cover it. */
  | 'credits'
  /** A payout that was not a number, or was negative. */
  | 'invalid'
  /** Awards arriving faster than races can be driven. See AWARD_MIN_GAP_MS. */
  | 'pace'
  /** Too many writes to one account at once; the client may retry. */
  | 'busy'

export type AccountResponse =
  | { ok: true; op: 'mint'; id: string; secret: string; profile: PlayerProfile }
  | { ok: true; op: 'load' | 'name' | 'avatar' | 'buy' | 'award'; profile: PlayerProfile }
  | { ok: true; op: 'achieve'; profile: PlayerProfile; progress: AchievementSnapshot }
  | { ok: false; error: AccountError | 'rate-limited' | 'server' }

const err = (e: AccountError): AccountResponse => ({ ok: false, error: e })

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * SHA-256 of a string, hex.
 *
 * `crypto.subtle` rather than a hand-rolled hash: it is in Node 22 (which
 * netlify.toml pins) and in every browser, and a hash somebody wrote themselves
 * is a hash nobody has checked. Injected into `handleAccount` rather than called
 * from it so a test can substitute something instant and deterministic.
 */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  let out = ''
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * Compare two hex digests without leaking where they first differ.
 *
 * The realistic attack on a 160-bit random secret is not timing -- there is no
 * search space to walk toward -- so this is belt and braces rather than a
 * defence anybody is relying on. It costs one loop and it means the question
 * never has to be asked again.
 */
export function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * Take `key` for `id`, or say who already has it.
 *
 * THIS IS THE ONE FUNCTION THE WHOLE NAME SCHEME RESTS ON, so it is worth being
 * explicit about why it is not the leaderboard's read-modify-write.
 *
 * leaderboard.mts rewrites a board whole and accepts that two players finishing
 * in the same instant can lose one of the two writes, on the grounds that "at
 * this size that is a row, not a corruption". That reasoning is right about a
 * board and WRONG ABOUT A NAME. A lost row is one player missing from one
 * top-ten; a lost name claim is two accounts that both believe they are Vince,
 * in a game whose nameplates, lobby rows and results tables all assume they are
 * not -- and unlike a missing row, it is permanent and it gets worse.
 *
 * A read-then-write would be exactly that bug: two requests both read "free",
 * both write, both succeed, and the second write is the only one anybody can
 * see. No amount of re-reading fixes it, because the window is between the read
 * and the write and there is no way to make that window zero from outside.
 *
 * `create` closes it from INSIDE the store. Netlify Blobs takes `onlyIfNew` on
 * a write and reports whether the write happened, so exactly one of any number
 * of simultaneous claimants gets `true` and the rest get `false` -- not because
 * this code was careful about ordering, but because the store refuses the second
 * write. That is a real guarantee and it is the only real guarantee in this
 * file. tests/account.test.ts pins it with two claims that provably interleave,
 * and pins that the test has teeth by running the same case against a store
 * whose `create` is the naive read-then-write and watching both claims win.
 *
 * Returns the owner's id: `id` itself when the claim is ours (including when it
 * already was, which makes a retry after a lost response a no-op), or somebody
 * else's when it is taken.
 */
export async function claimName(
  store: AccountStore, key: string, id: string, now: number,
): Promise<string> {
  if (await store.create(key, { id, at: now } satisfies NameClaim)) return id
  // Somebody holds it. Possibly us, from a call whose response never arrived.
  const held = asClaim((await store.get(key))?.value)
  // A key that exists but holds something unreadable is a claim this build
  // cannot honour and cannot safely steal. Refusing is the conservative
  // answer: the name stays unavailable until somebody looks at the blob.
  return held?.id ?? ''
}

/**
 * Give a name back, but only if it is still ours.
 *
 * THE CHECK IS NOT PARANOIA ABOUT A RACE -- there is no race, because `create`
 * cannot hand the key to anybody else while we hold it. It is about the ONE
 * caller that can be wrong: a `setName` that claimed a new name, failed to
 * commit the record, and is now releasing. That path must release the NEW claim
 * (which it does own) and must not touch the OLD one, and passing the wrong key
 * to the wrong call is the kind of mistake a guard turns into a no-op instead of
 * into a stolen name.
 */
async function releaseName(store: AccountStore, key: string, id: string): Promise<void> {
  const held = asClaim((await store.get(key))?.value)
  if (held?.id === id) await store.del(key)
}

/**
 * A name for a brand new account, when they did not bring a usable one.
 *
 * `Racer 1234` fits `NAME_RULES` exactly: eleven characters, alphanumeric at
 * both ends, one separator with nothing doubled. Nine thousand of them against
 * a game this size is loose enough that the loop almost never runs twice, and
 * the fallback after `MINT_NAME_TRIES` uses the account's own id, which cannot
 * collide with anything because no two accounts share one.
 */
const MINT_NAME_TRIES = 8

async function mintName(
  store: AccountStore, id: string, want: string, now: number, rand: () => number,
): Promise<string | null> {
  const tries: string[] = []
  const trimmed = want.trim()
  // The name they asked for goes first, if it is shaped like a name at all. A
  // new player who typed something into the leaderboard months ago should not
  // have to introduce themselves to the same game twice.
  if (checkNameShape(trimmed) === null) tries.push(trimmed)
  for (let i = 0; i < MINT_NAME_TRIES; i++) {
    tries.push(`Racer ${1000 + Math.floor(rand() * 9000)}`)
  }
  // `Racer` plus six characters of the id is twelve, which is NAME_RULES.max on
  // the nose, and the id is unique, so this cannot be taken by anybody else.
  tries.push(`Racer ${id.slice(0, 6)}`)
  for (const name of tries) {
    if (await claimName(store, nameKey(name), id, now) === id) return name
  }
  return null
}

// ---------------------------------------------------------------------------
// Reading and mutating an account
// ---------------------------------------------------------------------------

interface Loaded {
  rec: AccountRecord
  etag: string | null
}

async function readAccount(store: AccountStore, id: string): Promise<Loaded | null> {
  if (!idOk(id)) return null
  const got = await store.get(acctKey(id))
  if (!got) return null
  const rec = asRecord(got.value)
  return rec ? { rec, etag: got.etag } : null
}

/**
 * Authenticate, apply a change, and commit it as a compare-and-swap.
 *
 * `change` returns the next record or an error, and is called AGAIN on every
 * retry against a freshly read record -- which is the entire reason a mutation
 * is expressed as a function rather than as an object to merge. A `buy` that
 * computed the new balance once and re-wrote it on retry would spend the same
 * credits twice against whatever the record says now; recomputing means the
 * affordability check runs against the record the write is actually racing.
 *
 * THE RETRY IS NOT A LOCK AND DOES NOT PRETEND TO BE. It is optimistic
 * concurrency: the write carries the ETag the read saw, the store refuses it if
 * anything else got there first, and we go round again. After `MUTATE_TRIES`
 * the client is told `busy` rather than being given a lost update, which is the
 * distinction that matters -- a lost update here is somebody's credits.
 */
async function mutate(
  store: AccountStore,
  id: string,
  secret: string,
  hash: (s: string) => Promise<string>,
  change: (rec: AccountRecord) => AccountRecord | AccountError,
): Promise<AccountRecord | AccountError> {
  if (!idOk(id) || !secretOk(secret)) return 'badsecret'
  const digest = await hash(secret)
  for (let attempt = 0; attempt < MUTATE_TRIES; attempt++) {
    const loaded = await readAccount(store, id)
    if (!loaded) return 'nosuch'
    if (!sameDigest(loaded.rec.secretHash, digest)) return 'badsecret'
    const next = change(loaded.rec)
    if (typeof next === 'string') return next
    if (await store.replace(acctKey(id), next, loaded.etag)) return next
  }
  return 'busy'
}

// ---------------------------------------------------------------------------
// Awards
// ---------------------------------------------------------------------------

/** Awards on this record inside the last `AWARD_WINDOW_MS`. */
function recentAwards(rec: AccountRecord, now: number): AwardEntry[] {
  return rec.awards.filter((a) => now - a.at < AWARD_WINDOW_MS)
}

/**
 * May this account be paid right now?
 *
 * Two questions, and they refuse different things. The GAP refuses a burst: a
 * script posting in a loop is stopped at the second post. The HOURLY CAP refuses
 * a patient script that respects the gap -- thirty seconds apart for an hour is
 * a hundred and twenty posts, which the cap cuts to twelve.
 *
 * Neither of them refuses a player. The shortest race ever measured is five
 * times the gap, and twelve races an hour is more than anybody plays.
 */
function pacedOut(rec: AccountRecord, now: number): boolean {
  const recent = recentAwards(rec, now)
  const last = recent[0]
  // A record whose newest award is in the FUTURE is a clock that went backwards
  // between two function invocations, which happens. Treat it as no gap rather
  // than as an infinite one -- refusing a real player for a year because of a
  // skewed clock is a far worse failure than paying one race early.
  if (last && last.at <= now && now - last.at < AWARD_MIN_GAP_MS) return true
  return recent.length >= AWARD_PER_HOUR
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

/**
 * Handle one account request.
 *
 * Pure but for the store, the clock, the id source and the hash, all injected,
 * so every branch below is reachable from a unit test in under a millisecond.
 * The shape is net/signalProtocol.ts's `handleSignal` deliberately: one switch,
 * one return per case, and no I/O that is not through `store`.
 *
 * `rand` is here for exactly one thing -- the generated default name -- and is
 * injected for exactly one reason: a test that wants to force a name collision
 * needs to know which name will be tried.
 */
export async function handleAccount(
  store: AccountStore,
  req: AccountRequest,
  now: number,
  newToken: (len: number) => string,
  hash: (s: string) => Promise<string> = sha256Hex,
  rand: () => number = Math.random,
): Promise<AccountResponse> {
  if (!req || typeof req !== 'object' || typeof req.op !== 'string') return err('bad-body')

  switch (req.op) {
    // -----------------------------------------------------------------------
    case 'mint': {
      const id = newToken(ID_CHARS)
      const secret = newToken(SECRET_CHARS)
      if (!idOk(id) || !secretOk(secret)) return err('bad-body')

      // THE NAME IS CLAIMED BEFORE THE RECORD IS WRITTEN, and if no name can be
      // had the account is not created at all. An account with no claimed name
      // is the one state `PlayerProfile` has no room for -- it documents `name`
      // as "Unique, claimed" -- and writing one would push the problem into
      // every screen that reads a profile.
      const name = await mintName(store, id, str(req.name), now, rand)
      if (name === null) return err('taken')

      const rec: AccountRecord = {
        v: RECORD_VERSION,
        id,
        secretHash: await hash(secret),
        name,
        avatarId: DEFAULT_AVATAR_ID,
        owned: [],
        // EXACTLY ONE CHEAP PORTRAIT, read from the price table rather than
        // typed as a number so it cannot drift from the shop it is priced
        // against. net/mock.ts mints the same starting balance and gives the
        // full argument: a shop that is a wall of locked rows on first sight
        // teaches nothing, and a balance that buys two teaches the wrong thing.
        credits: PRICES.cheap,
        earned: 0,
        races: 0,
        wins: 0,
        createdAt: now,
        seenAt: now,
        awards: [],
        clamped: 0,
        refused: 0,
        ach: [],
        achCounters: {},
        achAt: 0,
        achSyncs: [],
        achClamped: 0,
        achRefused: 0,
        achRejected: 0,
      }
      // `create`, not a plain write. An id collision at 80 bits is not going to
      // happen, but if it ever did, the loser of the race would silently
      // inherit the winner's account -- and a conditional write turns that from
      // a catastrophe into a failed mint the client retries.
      if (!await store.create(acctKey(id), rec)) {
        await releaseName(store, nameKey(name), id)
        return err('busy')
      }
      return { ok: true, op: 'mint', id, secret, profile: toProfile(rec) }
    }

    // -----------------------------------------------------------------------
    case 'load': {
      // A load is a mutation because it stamps `seenAt`, and it goes through
      // the same CAS as everything else rather than through a cheaper path:
      // `mutate` is where authentication lives, and a second way in is a second
      // thing to get wrong.
      const out = await mutate(store, req.id, req.secret, hash,
        (rec) => ({ ...rec, seenAt: now }))
      return typeof out === 'string' ? err(out) : { ok: true, op: 'load', profile: toProfile(out) }
    }

    // -----------------------------------------------------------------------
    case 'name': {
      const wanted = str(req.name).trim()
      // Shape first, and WITHOUT touching the store. A malformed name should
      // not cost a blob read, and every `NameError` the player can be told
      // about comes out of this one call so an exhaustive switch over the five
      // of them is reachable in the UI.
      const shape = checkNameShape(wanted)
      if (shape) return err(shape)
      if (!idOk(req.id) || !secretOk(req.secret)) return err('badsecret')

      // Authenticate BEFORE claiming. A claim made on an unauthenticated
      // request would let anybody squat every name in the game by posting ids
      // they do not own -- and the claim would then have to be unwound, which
      // is the sort of cleanup that gets skipped on the failure path.
      const before = await readAccount(store, req.id)
      if (!before) return err('nosuch')
      if (!sameDigest(before.rec.secretHash, await hash(req.secret))) return err('badsecret')

      const nextKey = nameKey(wanted)
      const prevKey = nameKey(before.rec.name)

      // A CHANGE OF CASE IS FREE, and falls out rather than being special-cased:
      // `Vince` and `vince` are the same key, we already hold it, `claimName`
      // says so, and the only thing left to do is re-write the record with the
      // new spelling.
      const owner = await claimName(store, nextKey, req.id, now)
      if (owner !== req.id) return err('taken')

      const out = await mutate(store, req.id, req.secret, hash,
        (rec) => ({ ...rec, name: wanted, seenAt: now }))
      if (typeof out === 'string') {
        // The claim went through and the record did not. Release what we just
        // took -- it is unambiguously ours and nothing else can have it -- so a
        // failed rename does not leave a name reserved for nobody.
        if (nextKey !== prevKey) await releaseName(store, nextKey, req.id)
        return err(out)
      }

      /**
       * ACQUIRE THE NEW NAME, COMMIT, THEN RELEASE THE OLD ONE. The order is the
       * whole correctness argument and it is worth writing down, because the
       * other order reads just as naturally and is wrong.
       *
       * Releasing first would mean a crash between the two writes leaves the
       * account holding a name the index says is FREE -- so the next player to
       * want it gets it, and now two accounts answer to one name, which is the
       * exact failure this whole scheme exists to prevent.
       *
       * This order's crash leaves the account holding TWO names, one of which
       * nothing points at. That is a leak, not a collision: the namespace is one
       * name smaller and nobody is hurt, and it even self-heals, because the
       * stale key still names this account and so this account's own later claim
       * of it succeeds idempotently.
       *
       * Leak rather than double-allocate, every time.
       */
      if (nextKey !== prevKey) await releaseName(store, prevKey, req.id)
      return { ok: true, op: 'name', profile: toProfile(out) }
    }

    // -----------------------------------------------------------------------
    case 'avatar': {
      const avatarId = str(req.avatarId)
      const out = await mutate(store, req.id, req.secret, hash, (rec) => {
        if (!AVATAR_BY_ID.has(avatarId)) return 'unknown'
        // `ownsAvatar` against the materialised profile rather than a look in
        // `owned`: a rank the player has demonstrably earned is theirs whether
        // or not a flag was ever written, and refusing to let them wear it
        // because of a lost write would be the server calling its own record a
        // liar. content/avatars.ts makes this argument at length.
        if (!ownsAvatar(toProfile(rec), avatarId)) return 'locked'
        return { ...rec, avatarId, seenAt: now }
      })
      return typeof out === 'string' ? err(out) : { ok: true, op: 'avatar', profile: toProfile(out) }
    }

    // -----------------------------------------------------------------------
    case 'buy': {
      const avatarId = str(req.avatarId)
      const out = await mutate(store, req.id, req.secret, hash, (rec) => {
        const def = AVATAR_BY_ID.get(avatarId)
        if (!def) return 'unknown'
        if (ownsAvatar(toProfile(rec), avatarId)) return 'owned'
        // A rank or feat avatar is not for sale at any price, and saying so is
        // more useful than saying the price is missing. The KIND is checked
        // rather than the price, because `priceOf` returns 0 for exactly those
        // and a free shop item would otherwise be unbuyable.
        if (def.source.kind !== 'shop') return 'notforsale'
        // A portrait that has not been delivered is listed as coming and not
        // sold: `canBuy` already keeps the button dark, and this is the check
        // that holds when a client skips the button. Same build, same
        // manifest, so the two cannot disagree about which face is missing.
        if (artPending(avatarId)) return 'notforsale'
        const price = priceOf(avatarId)
        // THE ONLY PLACE THE BALANCE IS ENFORCED, and it runs inside the CAS so
        // that a second tab cannot spend the same credits. `canBuy` in the UI
        // decides whether a button is lit; this decides whether money moves,
        // and between the two there is a click and a round trip.
        if (rec.credits < price) return 'credits'
        return {
          ...rec,
          credits: rec.credits - price,
          owned: rec.owned.includes(avatarId) ? rec.owned : [...rec.owned, avatarId],
          // Bought it, wear it. Anything else means a second call the UI would
          // have to remember to make.
          avatarId,
          seenAt: now,
        }
      })
      return typeof out === 'string' ? err(out) : { ok: true, op: 'buy', profile: toProfile(out) }
    }

    // -----------------------------------------------------------------------
    case 'award': {
      const asked = num(req.credits, -1)
      if (asked < 0) return err('invalid')
      const won = req.won === true

      /**
       * Set by the LAST run of `change`, which is the one that committed.
       *
       * A refusal cannot be reported by returning an error from `change`,
       * because that would abandon the write -- and the write is the point: a
       * refusal has to be COUNTED or the evidence of the thing worth detecting
       * is the one thing that is not recorded. So the record is committed with
       * the counter bumped and the flag carries the verdict back out.
       */
      let refused = false

      const out = await mutate(store, req.id, req.secret, hash, (rec) => {
        refused = pacedOut(rec, now)
        if (refused) {
          // A single refusal is a player with two tabs open; four hundred of
          // them is somebody to look at.
          return { ...rec, refused: rec.refused + 1, seenAt: now }
        }
        /**
         * THE CLAMP, AND THE ONLY THING IT PROMISES.
         *
         * `MAX_PER_RACE` is imported from src/score/wallet.ts rather than
         * copied, which is the same reason netlify.toml gives for the
         * leaderboard importing src/score/verify.ts: two copies of a bound
         * drift, and the day the payout curve is re-tuned the server must move
         * with it or start refusing honest races.
         *
         * What it promises is that one post pays at most 200 credits. What it
         * does NOT promise -- and nothing here does -- is that the 200 was
         * earned. See the header.
         */
        const paid = Math.min(Math.floor(asked), MAX_PER_RACE)
        const clamped = Math.floor(asked) > MAX_PER_RACE
        const awards = [{ at: now, paid }, ...rec.awards].slice(0, AWARD_LOG)
        return {
          ...rec,
          credits: rec.credits + paid,
          // Lifetime earnings, which is what the rank ladder reads. It only
          // ever goes up: spending must not cost a rank.
          earned: rec.earned + paid,
          races: rec.races + 1,
          wins: rec.wins + (won ? 1 : 0),
          awards,
          clamped: rec.clamped + (clamped ? 1 : 0),
          seenAt: now,
        }
      })
      if (typeof out === 'string') return err(out)
      // Refused AFTER the commit, so the client is never told a race was banked
      // when it was not, and the refusal is on the record either way.
      if (refused) return err('pace')
      return { ok: true, op: 'award', profile: toProfile(out) }
    }

    // -----------------------------------------------------------------------
    case 'achieve': {
      // The sanitiser drops what this build does not know, item by item, and
      // says how many; the rest of the post is still honoured. A body with no
      // `progress` at all is an empty post, which is a pure read -- how a new
      // device fetches the wall another one earned.
      const { snap: posted, dropped } = asSnapshot(req.progress)
      // Same shape as `award`'s: a refusal is COMMITTED (counted) and then
      // reported, so the thing worth detecting is the thing on the record.
      let refused = false
      const out = await mutate(store, req.id, req.secret, hash, (rec) => {
        refused = achPacedOut(rec, now)
        if (refused) return { ...rec, achRefused: rec.achRefused + 1, seenAt: now }
        const m = mergeAchievementPost(rec, posted, now)
        return {
          ...rec,
          ach: m.ach,
          achCounters: m.counters,
          achAt: now,
          achSyncs: [now, ...rec.achSyncs].slice(0, AWARD_LOG),
          achClamped: rec.achClamped + (m.clamped ? 1 : 0),
          achRejected: rec.achRejected + dropped,
          seenAt: now,
        }
      })
      if (typeof out === 'string') return err(out)
      if (refused) return err('pace')
      return { ok: true, op: 'achieve', profile: toProfile(out), progress: achievementsOf(out) }
    }
  }

  return err('bad-body')
}

// ---------------------------------------------------------------------------
// ===========================================================================
// THE CLIENT
// ===========================================================================
// ---------------------------------------------------------------------------

/**
 * The two-method slice of Storage this module needs.
 *
 * An interface rather than `Storage` so a test can hand in a Map and so the
 * "storage throws" case can be built rather than waited for. Deliberately the
 * same shape as net/mock.ts's `StorageLike`, so a test fixture written for one
 * works against the other.
 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
}

/**
 * The device's storage, or null if there is not one.
 *
 * EVERY ACCESS IS WRAPPED, AND SO IS THE LOOKUP ITSELF. In a partitioned
 * iframe, a private window and several embedded webviews, `localStorage` throws
 * on the PROPERTY ACCESS -- before any method is called -- and in some of those
 * it then throws again on getItem and setItem individually. game/circuit.ts,
 * ui/settings.ts, game/input.ts and net/mock.ts all carry the same note and the
 * same double guard. An account that takes the game down in a private window is
 * strictly worse than one that does not persist.
 */
function deviceStorage(): StorageLike | null {
  try {
    const s = (globalThis as { localStorage?: StorageLike }).localStorage
    return s ?? null
  } catch {
    return null
  }
}

function readKey(store: StorageLike | null, key: string): string | null {
  if (!store) return null
  try {
    return store.getItem(key)
  } catch {
    return null
  }
}

function writeKey(store: StorageLike | null, key: string, value: string): boolean {
  if (!store) return false
  try {
    store.setItem(key, value)
    return true
  } catch {
    return false
  }
}

/**
 * THE LIVE ACCOUNT HAS ITS OWN KEY AND DOES NOT SHARE THE MOCK'S.
 *
 * net/mock.ts owns `sg.account`, and a build that can be flipped between `mock`
 * and `live` with a URL parameter would otherwise have the two of them
 * overwriting each other's credential -- so `?net=live` would quietly destroy
 * the mock profile somebody was developing against, and `?net=mock` would write
 * an `acct-3` over a real device secret and lose an account for ever. Separate
 * keys, and the mock's is read here exactly once and only for a name hint.
 */
const LS_ACCOUNT = 'sg.acct'
/** The mock's key, read-only, for the name a developer or a returning player
 *  has already been using. Never written. */
const LS_MOCK_ACCOUNT = 'sg.account'
/** The name the player typed for the leaderboard, owned by ui/frontend.ts.
 *  Read here, never written, so a returning player's first live profile is
 *  already called what their lap times are called. */
const LS_LEGACY_NAME = 'sg.name'

/** Stored payload version. Bumped when the SHAPE changes. */
const STORE_VERSION = 1

/**
 * What the device remembers.
 *
 * `provisional` IS THE OFFLINE-FIRST-LAUNCH CASE and is the reason this is not
 * simply the credential. A player whose first ever launch is on a train has no
 * id and no secret -- the server was never reached to issue them -- but they
 * still picked up a profile with a name on it, and that profile has to survive
 * a reload or the train is a game with no identity at all. So it is written
 * with `provisional: true` and no credential, and the next successful launch
 * mints for real and carries the name across as a preference.
 */
interface StoredAccount {
  v: number
  provisional?: boolean
  id?: string
  secret?: string
  profile?: PlayerProfile
}

export interface LiveAccountOptions {
  /** Where the function is. Overridden by a probe. */
  endpoint?: string
  fetchImpl?: typeof fetch
  /** `undefined` means the device's localStorage; `null` means nowhere, which
   *  is what a blocked context degrades to and what a test passes. */
  storage?: StorageLike | null
  /** Injected so a test does not have to own a crypto implementation. */
  randomName?: () => string
}

/** A local id, for a profile the server has never seen. Prefixed so that it is
 *  obvious in a log that it was never issued, and kept inside the character set
 *  net/index.ts needs for a live peer id. */
function localId(): string {
  let out = 'local-'
  try {
    const b = new Uint8Array(8)
    crypto.getRandomValues(b)
    for (const x of b) out += ALPHABET[x % ALPHABET.length]
  } catch {
    for (let i = 0; i < 8; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  }
  return out
}

/**
 * A profile for a player the server has not met.
 *
 * NOT A STUB AND NOT AN ERROR STATE. types.ts is explicit: a player who opens
 * the game on a train should still get their name over their car in a single
 * player race. So this is a complete, usable `PlayerProfile` -- the starters,
 * the starting balance, a name -- and the only things that do not work are the
 * two that genuinely cannot without a server: claiming the name, and spending.
 *
 * The balance is the real starting balance rather than zero, because
 * src/score/wallet.ts keeps its own local copy and `adopt()`s the server's the
 * moment one is reachable. Showing zero here would be showing a number that is
 * about to change for a reason the player cannot see.
 */
function localProfile(name: string): PlayerProfile {
  return {
    id: localId(),
    name,
    avatarId: DEFAULT_AVATAR_ID,
    unlocked: [...STARTER_IDS],
    credits: PRICES.cheap,
    earned: 0,
    races: 0,
    wins: 0,
  }
}

/**
 * The live account service.
 *
 * SHAPED LIKE `LiveLobbyService`: a class, options in the constructor, handlers
 * as assignable fields, one private `post` that never throws, and every public
 * method returning a `Result` rather than rejecting. types.ts's argument for
 * that is in its `Result` comment -- a thrown exception gives every caller a
 * second failure channel to forget about -- and net/signal.ts's `post` is the
 * model this one follows.
 */
export class LiveAccountService implements AccountService {
  onChange: (p: PlayerProfile) => void = () => {}

  private readonly endpoint: string
  private readonly fetchImpl: typeof fetch
  private readonly store: StorageLike | null
  private readonly randomName: () => string

  private profile: PlayerProfile | null = null
  private id = ''
  private secret = ''
  private isOffline = false
  /**
   * Has anything about this profile actually reached the device?
   *
   * `ephemeral` IS THE NEGATION OF THIS, AND IT TOOK TWO TRIES TO GET THE
   * PREDICATE RIGHT. The contract's sentence is "this browser is blocking
   * storage, so this profile disappears when you close the tab", so the
   * question is whether the profile SURVIVES -- not whether the most recent
   * write landed, and not whether a server credential exists.
   *
   * Two cases kill the obvious answers:
   *
   *   A DEVICE WHOSE STORAGE FILLS UP still reads back the credential it wrote
   *   last week. Its account survives a reload perfectly; only the cached
   *   profile snapshot goes stale, and that is re-fetched on the next load.
   *   Flipping this off on a failed write would put a false "not saved on this
   *   device" banner in front of somebody whose account is fine.
   *
   *   A PLAYER WHOSE FIRST EVER LAUNCH IS OFFLINE has no credential at all --
   *   nothing was minted, because nothing could be. But their provisional
   *   profile IS written, so their name comes back after a reload and is
   *   claimed on the next successful launch. They are OFFLINE, which is a
   *   different banner, and calling them ephemeral as well would be two wrong
   *   sentences instead of one right one.
   *
   * So: set once anything is successfully read back from, or written to, the
   * device's key -- and never cleared, because whatever was written is still
   * there.
   */
  private persisted = false
  private disposed = false

  constructor(opts: LiveAccountOptions = {}) {
    this.endpoint = opts.endpoint ?? ACCOUNT_PATH
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a))
    this.store = opts.storage === undefined ? deviceStorage() : opts.storage
    this.randomName = opts.randomName
      ?? (() => `Racer ${1000 + Math.floor(Math.random() * 9000)}`)
  }

  get offline(): boolean { return this.isOffline }
  get ephemeral(): boolean { return !this.persisted }

  dispose(): void { this.disposed = true }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  /**
   * One POST, and the only way this service talks to anything.
   *
   * A FAILURE IS A VALUE, NOT AN EXCEPTION, exactly as net/signal.ts's `post`
   * decides. Everything above this line has a `Result` to fill in and a screen
   * to keep up; a thrown fetch would give all of them a second failure channel.
   * A network error and a body that is not JSON are the same answer -- the
   * server did not speak -- and `offline` is what that is called.
   */
  private async post(req: AccountRequest): Promise<AccountResponse> {
    if (this.disposed) return { ok: false, error: 'server' }
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      })
      const body = await res.json().catch(() => null) as AccountResponse | null
      if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean') {
        return { ok: false, error: 'server' }
      }
      return body
    } catch {
      return { ok: false, error: 'server' }
    }
  }

  /**
   * Did the answer come back at all?
   *
   * `server` and `rate-limited` are the two errors that mean "the endpoint did
   * not do the thing and it was nothing to do with the request", which is what
   * `offline` means to the player. Every other error is a real, considered
   * answer to a real question, and treating one of those as offline would put
   * the profile screen into its offline banner because somebody typed a name
   * that was taken.
   */
  private static unreachable(e: AccountResponse): boolean {
    return !e.ok && (e.error === 'server' || e.error === 'rate-limited')
  }

  // -------------------------------------------------------------------------
  // Device storage
  // -------------------------------------------------------------------------

  private restore(): StoredAccount | null {
    const raw = readKey(this.store, LS_ACCOUNT)
    if (!raw) return null
    try {
      const p = JSON.parse(raw) as StoredAccount
      if (!p || typeof p !== 'object') return null
      if (p.v !== STORE_VERSION) return null
      return p
    } catch {
      return null
    }
  }

  private persist(payload: StoredAccount): void {
    if (writeKey(this.store, LS_ACCOUNT, JSON.stringify(payload))) this.persisted = true
  }

  /**
   * Can this device actually remember a secret?
   *
   * ASKED BEFORE MINTING, AND THAT IS THE WHOLE REASON IT EXISTS. A private
   * window that mints a server account writes a secret it will lose when the
   * tab closes -- so the account becomes unreachable the moment it is created,
   * and the NAME IT CLAIMED IS GONE FOR EVER. Do that once per private-window
   * launch and the namespace bleeds out, permanently, for accounts nobody will
   * ever log into again.
   *
   * So the device proves it can remember BEFORE the server issues anything. A
   * round trip through storage -- write, read back, compare -- is the only
   * honest test, because `setItem` succeeding is not the same as the value
   * being there afterwards in a browser that is quietly discarding writes.
   *
   * The canary is written to the real key, which is safe because this is only
   * ever called when the key holds nothing we want.
   */
  private storageWorks(): boolean {
    const token = `probe-${Math.random().toString(36).slice(2)}`
    if (!writeKey(this.store, LS_ACCOUNT, JSON.stringify({ v: 0, probe: token }))) return false
    const back = readKey(this.store, LS_ACCOUNT)
    if (back === null) return false
    try {
      return (JSON.parse(back) as { probe?: string }).probe === token
    } catch {
      return false
    }
  }

  /**
   * The name a new account would like to have.
   *
   * In order: the provisional profile from an offline first launch, then the
   * mock's profile (a developer flipping `?net=live` keeps their name), then the
   * leaderboard name from ui/frontend.ts, then a generated one. A returning
   * player should not have to introduce themselves to the same game twice, and
   * every one of these is a place they already did.
   */
  private preferredName(saved: StoredAccount | null): string {
    const tries: string[] = []
    if (saved?.profile?.name) tries.push(saved.profile.name)
    const mock = readKey(this.store, LS_MOCK_ACCOUNT)
    if (mock) {
      try {
        const p = JSON.parse(mock) as { profile?: { name?: unknown } }
        if (typeof p?.profile?.name === 'string') tries.push(p.profile.name)
      } catch { /* the mock's payload is not ours to be strict about */ }
    }
    const legacy = readKey(this.store, LS_LEGACY_NAME)
    if (legacy) tries.push(legacy)
    for (const t of tries) {
      if (checkNameShape(t.trim()) === null) return t.trim()
    }
    return this.randomName()
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** Adopt a server profile. The server's copy always wins; there is nothing to
   *  reconcile, which is the same rule `Wallet.adopt` states. */
  private commit(p: PlayerProfile, credential: boolean): PlayerProfile {
    this.profile = p
    this.isOffline = false
    if (credential) {
      this.persist({ v: STORE_VERSION, id: this.id, secret: this.secret, profile: p })
    }
    if (!this.disposed) this.onChange(p)
    return p
  }

  /** Fall back to a device-local profile. `offline` becomes true and stays true
   *  until a later call succeeds -- which is the documented way out of it. */
  private goOffline(p: PlayerProfile, provisional: boolean): PlayerProfile {
    this.profile = p
    this.isOffline = true
    if (provisional) this.persist({ v: STORE_VERSION, provisional: true, profile: p })
    if (!this.disposed) this.onChange(p)
    return p
  }

  // -------------------------------------------------------------------------
  // The contract
  // -------------------------------------------------------------------------

  /**
   * LOAD NEVER REJECTS, per the contract.
   *
   * Calling it again is a RETRY -- it re-attempts the connection, and a
   * successful second call clears `offline`. There is nothing else in the
   * contract that could clear it, which is why ui/profile.ts's "Try again"
   * button calls exactly this.
   *
   * THE FOUR WAYS IN, in the order they are tried:
   *
   *   1. A CREDENTIAL. Post `load`. Success is the normal path; `nosuch` and
   *      `badsecret` fall through to minting (see below); anything else is the
   *      server being unreachable, so the cached profile is used offline.
   *   2. NO CREDENTIAL AND STORAGE IS BLOCKED. Do NOT mint -- see
   *      `storageWorks`. A local profile, `ephemeral` true, `offline` FALSE.
   *      That pair is not a contradiction and it is the contract's point: the
   *      server is fine, this browser is not, and they are different sentences.
   *   3. NO CREDENTIAL, STORAGE FINE. Mint.
   *   4. MINT FAILED. A provisional local profile, `offline` true, persisted so
   *      the name survives a reload and can be claimed on the next launch.
   */
  async load(): Promise<PlayerProfile> {
    const saved = this.restore()

    if (saved && !saved.provisional && idOk(saved.id) && secretOk(saved.secret)) {
      this.id = saved.id
      this.secret = saved.secret
      // READING IT BACK IS THE PROOF. A record that came out of storage is a
      // record that is in storage, whatever any later write does.
      this.persisted = true
      const res = await this.post({ op: 'load', id: this.id, secret: this.secret })
      if (res.ok && res.op === 'load') return this.commit(res.profile, true)
      if (LiveAccountService.unreachable(res)) {
        // The device's cached copy, which is the whole reason it is cached.
        return this.goOffline(saved.profile ?? localProfile(this.preferredName(saved)), false)
      }
      /**
       * `nosuch` or `badsecret`. BOTH MEAN THE CREDENTIAL IS UNUSABLE and the
       * only way forward is a new account -- there is no recovery channel, by
       * design, and pretending otherwise would be the signup screen arriving by
       * the back door.
       *
       * `nosuch` is expected and benign: a store that was wiped in development,
       * or a device carrying an id the mock minted. `badsecret` is NOT expected
       * and should never happen in a shipped build, so it is logged loudly --
       * it means either a storage corruption or a bug in this file, and
       * silently minting over it would destroy the evidence along with the
       * account.
       */
      if (!res.ok && res.error === 'badsecret') {
        console.warn('account: stored secret rejected; minting a new account')
      }
      this.id = ''
      this.secret = ''
      // `persisted` is deliberately NOT cleared here. The credential is dead,
      // but it was READ from this device a moment ago, so storage demonstrably
      // works -- and that is the only thing `ephemeral` is a statement about.
    }

    const want = this.preferredName(saved)

    // Storage first. See `storageWorks` for why a mint must not happen without
    // somewhere to put the secret.
    if (!this.storageWorks()) {
      // EPHEMERAL, AND NOT OFFLINE. The server is fine; this browser is not.
      // No mint, so no account and no name claimed -- see `storageWorks`.
      this.persisted = false
      this.profile = localProfile(want)
      this.isOffline = false
      if (!this.disposed) this.onChange(this.profile)
      return this.profile
    }

    const res = await this.post({ op: 'mint', name: want })
    if (res.ok && res.op === 'mint') {
      this.id = res.id
      this.secret = res.secret
      return this.commit(res.profile, true)
    }
    return this.goOffline(saved?.profile ?? localProfile(want), true)
  }

  /**
   * Take a name.
   *
   * EVERY REJECTION THE PLAYER CAN BE GIVEN COMES BACK FROM THIS ONE CALL, which
   * is what makes ui/profile.ts's exhaustive `Record<NameError, string>`
   * possible. Shape errors are decided by the server so there is one
   * implementation of `NAME_RULES` in force rather than two that agree today.
   *
   * `offline` CARRIES MORE THAN ONE SENTENCE AND THE UI MUST DISAMBIGUATE IT.
   * `NameError` has no case for "this browser cannot hold an account", which is
   * a real and common state (every private window) and is NOT the server being
   * unreachable. Until the contract grows a case for it -- asked for in the
   * report -- the rule is: a caller that gets `offline` must check `ephemeral`
   * before choosing its wording. ui/profile.ts already renders the two banners
   * separately, so it has the flag in hand.
   */
  async setName(name: string): Promise<Result<PlayerProfile, NameError>> {
    const trimmed = name.trim()
    if (!this.profile || !this.id || !this.secret) {
      return { ok: false, error: 'offline' }
    }
    const res = await this.post({
      op: 'name', id: this.id, secret: this.secret, name: trimmed,
    })
    if (res.ok && res.op === 'name') return { ok: true, value: this.commit(res.profile, true) }
    if (!res.ok) {
      switch (res.error) {
        case 'short': case 'long': case 'charset': case 'taken':
          // A refusal is not a disconnection: the server answered, so `offline`
          // must not be set by it. A screen that fell into its offline banner
          // because a name was taken would be telling the player the wrong
          // thing about the wrong system.
          return { ok: false, error: res.error }
        default:
          break
      }
    }
    this.isOffline = true
    return { ok: false, error: 'offline' }
  }

  async setAvatar(avatarId: string): Promise<Result<PlayerProfile>> {
    return this.mutating({ op: 'avatar', id: this.id, secret: this.secret, avatarId })
  }

  /** Spends credits. Fails rather than going negative -- and the balance it
   *  fails against is the server's, not the one on screen. */
  async buyAvatar(avatarId: string): Promise<Result<PlayerProfile>> {
    return this.mutating({ op: 'buy', id: this.id, secret: this.secret, avatarId })
  }

  /**
   * Bank what a finished race paid.
   *
   * THE CLIENT PROPOSES AND THE SERVER DISPOSES, with the emphasis on what
   * "disposes" does and does not mean here -- the server clamps this number,
   * paces it and records it, and cannot tell whether it is true. The file header
   * argues that at length. What the client must NOT do is treat its own number
   * as banked: the profile that comes back is the authority, and `Wallet.adopt`
   * exists precisely so the local cache can be overwritten by it without
   * argument.
   *
   * AN OFFLINE AWARD IS DROPPED RATHER THAN QUEUED, deliberately. A queue that
   * replays on reconnect is a client posting a burst of races at once, which is
   * exactly the shape the pace limit exists to refuse -- so the queue would be
   * rejected on arrival, having spent the intervening time convincing the player
   * the credits were safe. src/score/wallet.ts already keeps a local balance
   * through the outage and hands it over on the next successful load, which is
   * the same outcome with none of the lying.
   */
  async award(credits: number, finished: { won: boolean }): Promise<Result<PlayerProfile>> {
    return this.mutating({
      op: 'award',
      id: this.id,
      secret: this.secret,
      credits: Math.max(0, Math.floor(Number.isFinite(credits) ? credits : 0)),
      won: finished.won === true,
    })
  }

  /**
   * Post the device's whole achievement snapshot and take the merged one back.
   *
   * THE PROFILE THAT COMES BACK IS ADOPTED like every other answer, because a
   * synced achievement can grant a feat portrait and the server is the one
   * that says so. The PROGRESS is handed to the caller to merge rather than
   * adopted: unlike a balance, progress merges (union and max), and the
   * device's copy can legitimately be AHEAD of what one bounded post was
   * allowed to carry. See score/progress.ts.
   *
   * Offline is a value, as everywhere else in this class, and costs nothing:
   * the device keeps its snapshot and the next sync carries all of it.
   */
  async syncAchievements(progress: AchievementSnapshot): Promise<Result<AchievementSync>> {
    if (!this.profile || !this.id || !this.secret) return { ok: false, error: 'offline' }
    const res = await this.post({ op: 'achieve', id: this.id, secret: this.secret, progress })
    if (res.ok && res.op === 'achieve') {
      const profile = this.commit(res.profile, true)
      return { ok: true, value: { profile, progress: asSnapshot(res.progress).snap } }
    }
    if (!res.ok && LiveAccountService.unreachable(res)) {
      this.isOffline = true
      return { ok: false, error: 'offline' }
    }
    return { ok: false, error: !res.ok ? res.error : 'server' }
  }

  /**
   * The three authenticated mutations, which differ only in their request.
   *
   * The error goes back as the wire's own string so ui/profile.ts's shop
   * sentences can switch on `credits`, `locked`, `owned` and the rest -- the
   * `Result<T>` half of the contract is deliberately `string`-typed, which is
   * what lets these through without a second enum to maintain.
   */
  private async mutating(req: AccountRequest): Promise<Result<PlayerProfile>> {
    if (!this.profile || !this.id || !this.secret) return { ok: false, error: 'offline' }
    const res = await this.post(req)
    if (res.ok && res.op !== 'mint') return { ok: true, value: this.commit(res.profile, true) }
    if (!res.ok && LiveAccountService.unreachable(res)) {
      this.isOffline = true
      return { ok: false, error: 'offline' }
    }
    return { ok: false, error: !res.ok ? res.error : 'server' }
  }
}
