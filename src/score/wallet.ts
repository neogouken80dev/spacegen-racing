/**
 * SpaceGen Racing — THE WALLET.
 * ---------------------------------------------------------------------------
 * What a finished race pays, what the player has, and what happens when they
 * spend it. The payout arithmetic is pure and lives at the top; the balance is
 * a local CACHE of something the server will own, and lives at the bottom
 * behind guarded storage.
 *
 * ===========================================================================
 * THE MEASUREMENT THIS IS DERIVED FROM, BECAUSE A GUESS WOULD HAVE BEEN WRONG
 * BY TWO ORDERS OF MAGNITUDE
 *
 * The game had no currency before this file, so there was nothing to tune
 * against and every coefficient here had to come from somewhere. I ran the real
 * simulation headlessly -- eight circuits x three seeds x eight cars, 192
 * finished runs -- with the real `Scorer` fed the real event stream, and read
 * the scores off:
 *
 *      min  34,810     p10  67,372     median 267,436
 *      p90 452,682     max 848,682     mean   270,795
 *
 *      race length 159-280s, median 198s
 *
 * And the per-circuit medians, which is the number that actually shapes this:
 *
 *      Elkarim      425,956 in 162.6s        Namaresh    214,152 in 202.0s
 *      Ashkar       423,375 in 268.0s        Meridian    156,315 in 263.5s
 *      Centurion    347,170 in 191.7s        Zhen-9      130,434 in 273.7s
 *      Frosthelm    334,957 in 182.9s        Halcyon      47,778 in 182.2s
 *
 * Underneath all of that is a floor the AI never shows, because the AI drifts:
 * a player who never slides at all scores only placement, which for three laps
 * is 3 x LAP_PLACE + TRACK_PLACE at a combo of 1 -- 9,000 for a win and 1,600
 * for last.
 *
 * SO THE RANGE A PAYOUT HAS TO DIGEST IS ABOUT 1,600 TO 850,000: five hundred
 * to one. Anything linear in score pays either 30 credits or 30,000 and there
 * is no coefficient that fixes it -- which is exactly why this is measured
 * first and priced second.
 *
 * ===========================================================================
 * THE CURVE
 *
 *      credits = (FINISH + SKILL * sqrt(score / REF)) * repeat,
 *                capped, rounded, and zero unless the race was FINISHED.
 *
 * A SQUARE ROOT, because it turns 500:1 into 22:1. `REF` is the measured median
 * race, so the median race pays almost exactly `FINISH + SKILL` and the numbers
 * below can be read as "how much better or worse than a normal race was this".
 * Against the measurement above the whole distribution lands at:
 *
 *      no-drift last place    25      p10 race    51
 *      no-drift win           31      median      82
 *      a poor race            42      p90        101
 *                                     best seen  131
 *
 * A TYPICAL FINISHED RACE PAYS ABOUT 80 CREDITS. That is the number the shop
 * and the rank ladder in `src/content/avatars.ts` are priced against, and the
 * two files have to be re-checked together if either moves:
 *
 *      250 credits  ~3 races        2,000 credits  ~25 races
 *      500 credits  ~6 races        4,000 credits  ~50 races
 *    1,000 credits ~13 races        the whole shop ~128 races
 *
 *      rank 1  2,000 earned  ~25 races      rank 4  20,000  ~250 races
 *      rank 2  5,000 earned  ~63 races      rank 5  40,000  ~500 races
 *      rank 3 10,000 earned ~125 races
 *
 * Three races for the first thing you want and fifty for the last thing you
 * want is a shape a designer would recognise. Three hundred races for the first
 * thing would not be, and neither would three.
 *
 * ===========================================================================
 * THERE IS NO SEPARATE TERM FOR FINISHING POSITION, AND THAT IS DELIBERATE
 *
 * Winning already pays. `TRACK_PLACE` in `rules.ts` is 6,000 for a win against
 * 850 for eighth, `LAP_PLACE` is 1,000 against 250, and the combo multiplies
 * both -- so placement is inside `score` before this function ever sees it.
 * Adding a position bonus here would pay for the same finish twice and quietly
 * re-weight an economy the scoring system already balanced: the whole argument
 * in `rules.ts` is that placement must pay real points WITHOUT becoming the
 * entire score, and a second helping in credits undoes exactly that.
 *
 * It also keeps the banking seam honest. The one object every finished race
 * already builds is `RunRecord`, and it carries no position -- so a payout that
 * needed one would need a second call site in `main.ts` to go and fetch it.
 *
 * `award(credits, { won })` still carries the win flag, because the SERVER
 * wants it: `PlayerProfile.wins` is a counter the profile screen shows and the
 * `flagbearer` feat is re-derived from. It is identity, not payment.
 *
 * ===========================================================================
 * WHY THIS IS NOT A RATCHET ON REPLAYING THE EASIEST TRACK
 *
 * Three things, and the third is the one that actually settles it.
 *
 * 1. IT PAYS ONLY ON A FINISH. A DNF is worth nothing, whatever it scored. The
 *    cheapest farm in a drift-scored game is not a track at all -- it is one
 *    corner: slide for forty seconds, quit, restart, repeat, and never drive a
 *    lap. Requiring the flag makes the whole race the unit of payment. It is
 *    the same call `circuit.ts` makes for championship points, for the same
 *    reason: get it home first.
 *
 * 2. THE SQUARE ROOT FLATTENS THE CIRCUITS. Raw score per minute across the
 *    eight ranges from 157,000 (Elkarim) to 15,700 (Halcyon Bay) -- ten to one.
 *    After the root, the CREDIT rate ranges from 36.3/min to 13.9/min, which is
 *    2.6 to 1. Choosing a circuit still matters a little, which is honest: a
 *    longer, richer race should pay more than a short easy one.
 *
 * 3. REPEATS PAY LESS, AND THE DAMPING IS BIGGER THAN THE GAP IT CLOSES. Of
 *    your last three finishes, the more of them were on THIS circuit, the less
 *    this one pays: x1.00, x0.75, x0.55, x0.40. Grinding the best-paying
 *    circuit therefore settles at 36.3 x 0.40 = 14.5 credits a minute, which is
 *    below the 22.2 a minute of simply rotating the roster. The ratchet is not
 *    blunted, it is inverted -- the grind is the worst-paying way to play.
 *
 * What this deliberately does NOT do is stop anybody replaying a favourite
 * circuit. It stops that being the OPTIMAL thing to do. A player who only ever
 * drives Zhen-9 still earns, at 40%, and nothing is ever refused.
 *
 * ===========================================================================
 * THE BALANCE IS A CACHE. THE SERVER OWNS IT.
 *
 * `AccountService.award(credits, { won })` in `src/net/types.ts` is already
 * shaped for a server that recomputes the payout from evidence and returns the
 * authoritative profile. Until it exists, this holds the number locally so the
 * shop works offline and on the first launch. Two rules keep that from
 * hardening into an assumption:
 *
 *   - `onBank` fires with every payout, so the account layer can forward it to
 *     `award()` without this module knowing that the network exists;
 *   - `adopt()` overwrites both numbers with the server's, no reconciliation
 *     and no argument. The client's copy is never the source of truth, so there
 *     is nothing to reconcile.
 *
 * EVERY STORAGE ACCESS IS WRAPPED, INCLUDING THE PROPERTY LOOKUP. In a
 * partitioned or private context `window.localStorage` throws on the access
 * itself, not merely on the read -- the same note is in `game/circuit.ts`,
 * `ui/settings.ts` and `game/input.ts`. A wallet that takes the game down in a
 * private window is infinitely worse than a wallet that forgets a balance.
 */
import { DEFAULT_DIFFICULTY, DIFFICULTY_SPECS, type Difficulty } from '../content/difficulty'


/** Flat credits for getting it home at all, before the repeat multiplier. */
export const FINISH_CREDITS = 20

/** Credits a median-scoring race adds on top of `FINISH_CREDITS`. */
export const SKILL_CREDITS = 60

/** The measured median score of a finished race. See the header. */
export const REF_SCORE = 250000

/**
 * A hard ceiling on one race.
 *
 * NOT EXPECTED TO BIND: the best of 192 measured runs pays 131. It is here so
 * that a future scoring change, a new circuit that scores strangely, or an
 * outright exploit is a BOUNDED economy bug rather than an unbounded one --
 * the difference between a player who is ahead and a player for whom the shop
 * has ceased to exist.
 */
export const MAX_PER_RACE = 200

/** How many recent finishes the repeat damping looks at. */
export const REPEAT_WINDOW = 3

/**
 * Multiplier by how many of the last `REPEAT_WINDOW` finishes were on this same
 * circuit. Index 0 is "none of them".
 *
 * Full pay needs four different circuits in a row, which with eight on the
 * roster is a rotation rather than a chore. It bottoms out at 0.40 instead of
 * at zero because a player who loves one circuit is not cheating, and a payout
 * that reaches zero would read as a punishment rather than as a preference.
 */
export const REPEAT_DAMP: readonly number[] = [1.0, 0.75, 0.55, 0.40]

/**
 * What the wallet needs from a finished race.
 *
 * Structurally a subset of `RunRecord` in `records.ts`, deliberately: that is
 * the one object every finished race already builds, and banking from it means
 * no new call site and no new plumbing through `main.ts`.
 *
 * `raceTime` IS THE DNF DISCRIMINATOR. main.ts already writes
 * `local.finished ? local.finishTime : 0`, so a zero here means the car did not
 * cross the line -- and that is the fact this payout turns on. Anything that
 * builds a `PayoutRun` by hand has to honour the same convention.
 */
export interface PayoutRun {
  trackId: string
  score: number
  raceTime: number
  /**
   * The field this was raced against. Optional, and Normal when absent.
   *
   * Optional because `PayoutRun` is deliberately a structural subset of
   * `RunRecord` and several tests build one by hand; a required field here
   * would break all of them to say "Normal", which is what absent already
   * means. `RunRecord` itself requires it, so nothing on the real path can
   * forget it.
   */
  difficulty?: Difficulty
  /** Epoch ms. Optional, and used only to refuse an accidental double bank. */
  at?: number
}

/** A payout, broken out so the results screen can show its parts. */
export interface Payout {
  /** What was actually banked. Integer, never negative. */
  credits: number
  /** The flat finish component, before damping. */
  finish: number
  /** The score component, before damping. */
  skill: number
  /** The repeat multiplier that was applied, 0.40..1. */
  repeat: number
  /** The difficulty multiplier, 0.70..1.80. Broken out so the results screen
   *  can show WHY an Expert run paid what it did. */
  difficulty: number
  /** True if `MAX_PER_RACE` bound. Worth showing, and worth investigating. */
  capped: boolean
}

const NOTHING: Payout = {
  credits: 0, finish: 0, skill: 0, repeat: 1, difficulty: 1, capped: false,
}

/**
 * The repeat multiplier for racing `trackId` given the recent finishes.
 *
 * `history` is most-recent-first and may be longer than the window; only the
 * first `REPEAT_WINDOW` entries count, so the caller never has to trim it.
 */
export function repeatFactor(trackId: string, history: readonly string[]): number {
  let n = 0
  const end = Math.min(history.length, REPEAT_WINDOW)
  for (let i = 0; i < end; i++) if (history[i] === trackId) n++
  const i = Math.min(n, REPEAT_DAMP.length - 1)
  return REPEAT_DAMP[i]
}

/**
 * What one finished race is worth. Pure, and the only place the curve lives.
 *
 * A DNF, a negative score and a score that is not a number all pay nothing
 * rather than throwing: this is called from a results screen that has already
 * decided to exist, and an exception here would take it down over a number.
 */
export function payout(run: PayoutRun, history: readonly string[] = []): Payout {
  if (!run || typeof run.trackId !== 'string') return NOTHING
  if (!Number.isFinite(run.raceTime) || run.raceTime <= 0) return NOTHING
  const score = Number.isFinite(run.score) ? Math.max(0, run.score) : 0
  const skill = SKILL_CREDITS * Math.sqrt(score / REF_SCORE)
  const repeat = repeatFactor(run.trackId, history)
  // DIFFICULTY MULTIPLIES BEFORE THE CAP, NOT AFTER.
  //
  // `MAX_PER_RACE` bounds what one race can be worth, and that bound is a
  // property of the economy rather than of the field -- so an Expert run big
  // enough to reach it is capped at the same number an Easy one would be,
  // which is what a cap is for. Multiplying afterwards would let Expert earn
  // 1.8x the ceiling and quietly turn one cap into four.
  //
  // The real work happens at the other end. Easy pays 0.70 because a field
  // that brakes early for you is otherwise the correct way to farm credits,
  // and a ladder whose bottom rung pays best is a ladder nobody climbs.
  const diff = DIFFICULTY_SPECS[run.difficulty ?? DEFAULT_DIFFICULTY].payout
  const raw = (FINISH_CREDITS + skill) * repeat * diff
  const capped = raw > MAX_PER_RACE
  return {
    credits: Math.max(0, Math.round(Math.min(raw, MAX_PER_RACE))),
    finish: FINISH_CREDITS,
    skill,
    repeat,
    difficulty: diff,
    capped,
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const LS_KEY = 'sg.wallet'

/**
 * Format version. Bumped when the SHAPE changes, which drops an old wallet
 * rather than misreading it.
 *
 *   1  credits + lifetime earned + the recent-circuit ring + the last bank key.
 */
const VERSION = 1

interface Stored {
  v: number
  /** Spendable. */
  c: number
  /** Lifetime earned, which the rank ladder reads. Never decreases. */
  e: number
  /** Recent finishes, most recent first, at most REPEAT_WINDOW of them. */
  h: string[]
  /** The last banked run's key, so a reload cannot pay for it twice. */
  k: string
}

/**
 * Read a string from storage, or null for every reason it might not be there.
 *
 * The property access is inside the try on purpose. See the header.
 */
function readRaw(): string | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage.getItem(LS_KEY)
  } catch {
    return null
  }
}

function writeRaw(value: string): void {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(LS_KEY, value)
  } catch {
    /* quota, private mode, partitioned storage. The credits were still earned
       for this session; they simply will not be there next time. Never fatal,
       and never worth an exception in front of a results screen. */
  }
}

const num = (v: unknown, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : d

/**
 * Rebuild a wallet from whatever was in storage.
 *
 * Untrusted, like every other store in `src/score`: an older build, a
 * half-written value, a hand-edited balance. A hand-edited balance is not a
 * threat worth engineering against while the board is local -- the only person
 * a local cheat deceives is themselves -- but a STRING where a number should be
 * is, because it propagates into arithmetic and turns a balance into NaN, which
 * then survives every comparison and makes everything unaffordable forever.
 */
function sanitise(raw: unknown): Stored | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (num(r.v, -1) !== VERSION) return null
  const credits = Math.max(0, Math.floor(num(r.c, 0)))
  const earned = Math.max(credits, Math.floor(num(r.e, credits)))
  const h = Array.isArray(r.h)
    ? r.h.filter((x): x is string => typeof x === 'string').slice(0, REPEAT_WINDOW)
    : []
  return { v: VERSION, c: credits, e: earned, h, k: typeof r.k === 'string' ? r.k : '' }
}

/** The key that identifies one banked race. Empty when it cannot be formed. */
function keyOf(run: PayoutRun): string {
  return Number.isFinite(run.at) ? `${run.trackId}|${Math.round(run.score)}|${run.at}` : ''
}

// ---------------------------------------------------------------------------
// The wallet
// ---------------------------------------------------------------------------

export interface WalletSnapshot {
  credits: number
  earned: number
  /** Recent finishes, most recent first. Drives the repeat damping. */
  history: readonly string[]
}

export class Wallet {
  private credits = 0
  private earned = 0
  private history: string[] = []
  private lastKey = ''

  /** Fired on every change, from any cause. */
  onChange: (s: WalletSnapshot) => void = () => {}

  /**
   * Fired with every payout, so the account layer can forward it to
   * `AccountService.award()`. The wallet never calls the network itself: it
   * has no business knowing the network exists, and a results screen must not
   * wait on one.
   */
  onBank: (payout: Payout, run: PayoutRun) => void = () => {}

  constructor(load = true) {
    if (load) this.load()
  }

  get balance(): number { return this.credits }
  get lifetime(): number { return this.earned }
  get recent(): readonly string[] { return this.history }

  snapshot(): WalletSnapshot {
    return { credits: this.credits, earned: this.earned, history: [...this.history] }
  }

  /**
   * Bank a finished race. Returns what it paid, which may be zero.
   *
   * IDEMPOTENT WHERE IT CAN BE. `publishScore()` runs once per race today, but
   * "once" is a property of a call site rather than of this function, and a
   * results screen that is re-entered, a rematch that reuses a state, or a
   * reload mid-ceremony would all pay twice. The last banked run's key is
   * stored, so an exact repeat is refused across reloads as well as within a
   * session. A run with no `at` cannot form a key and is never deduplicated --
   * stated here rather than discovered later.
   */
  bank(run: PayoutRun): Payout {
    const key = keyOf(run)
    if (key !== '' && key === this.lastKey) return NOTHING
    const p = payout(run, this.history)
    if (p.credits <= 0) return p
    this.credits += p.credits
    this.earned += p.credits
    this.history.unshift(run.trackId)
    if (this.history.length > REPEAT_WINDOW) this.history.length = REPEAT_WINDOW
    this.lastKey = key
    this.save()
    this.onBank(p, run)
    this.onChange(this.snapshot())
    return p
  }

  /**
   * Spend. Returns false and changes nothing if the balance does not cover it.
   *
   * THE BALANCE CANNOT GO NEGATIVE, and this is the only place that is
   * enforced, which is why `canBuy()` in `content/avatars.ts` checking the same
   * thing is not redundant: that one decides whether a button is enabled, this
   * one decides whether money moves, and between the two there is a click, a
   * network round trip and a second tab.
   *
   * A non-positive or non-finite cost is refused rather than treated as free:
   * nothing in the catalogue is bought for nothing, so a zero here is a caller
   * bug and silently succeeding would hide it.
   */
  spend(cost: number): boolean {
    if (!Number.isFinite(cost) || cost <= 0) return false
    if (cost > this.credits) return false
    this.credits -= cost
    this.save()
    this.onChange(this.snapshot())
    return true
  }

  /**
   * Take the server's numbers. No merge, no max, no argument.
   *
   * The local copy is a cache and the server is authority, so a disagreement is
   * settled by replacement. Merging would mean a client that stayed open
   * through a server correction could put the corrected credits back.
   */
  adopt(p: { credits: number; earned: number }): void {
    this.credits = Math.max(0, Math.floor(num(p.credits, this.credits)))
    this.earned = Math.max(this.credits, Math.floor(num(p.earned, this.earned)))
    this.save()
    this.onChange(this.snapshot())
  }

  /** Wipe it. Used by the settings screen's reset, and by tests. */
  reset(): void {
    this.credits = 0
    this.earned = 0
    this.history = []
    this.lastKey = ''
    this.save()
    this.onChange(this.snapshot())
  }

  private load(): void {
    const raw = readRaw()
    if (!raw) return
    try {
      const s = sanitise(JSON.parse(raw))
      if (!s) return
      this.credits = s.c
      this.earned = s.e
      this.history = s.h
      this.lastKey = s.k
    } catch {
      // Malformed JSON. An empty wallet is a correct answer; a thrown error in
      // a constructor is not, because it takes the whole front end with it.
    }
  }

  private save(): void {
    const s: Stored = {
      v: VERSION, c: this.credits, e: this.earned, h: this.history, k: this.lastKey,
    }
    try {
      writeRaw(JSON.stringify(s))
    } catch {
      /* JSON.stringify cannot realistically throw on this shape, but the cost
         of being wrong about that is a results screen that does not appear. */
    }
  }
}

/**
 * A wallet loaded from storage. One per caller is fine -- they would fight over
 * the same key, which is why the banking path uses the shared one below.
 */
export function createWallet(): Wallet {
  return new Wallet()
}

let shared: Wallet | null = null

/**
 * THE PROCESS-WIDE WALLET.
 *
 * A singleton because there is exactly one balance and two instances would
 * each hold half the truth and overwrite each other's saves. Created lazily so
 * that importing this module does not touch storage -- tests, the server and
 * the build all import it without ever wanting a balance.
 */
export function sharedWallet(): Wallet {
  if (!shared) shared = new Wallet()
  return shared
}

/**
 * Bank a finished race into the shared wallet.
 *
 * This exists so that the one place a finished race is already handed over --
 * `RecordStore.submit`, called unconditionally from `main.ts` for every race --
 * can bank it in one line, without `main.ts` growing a currency it did not ask
 * for. See the note at that call site in `records.ts`.
 */
export function bankRun(run: PayoutRun): Payout {
  return sharedWallet().bank(run)
}

/** Exported for tests: the shared wallet is process state and has to be
 *  droppable between cases, or they leak into each other. */
export function resetSharedWallet(): void {
  shared = null
}
