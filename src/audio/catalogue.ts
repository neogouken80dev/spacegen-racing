/**
 * SpaceGen Racing — the sound catalogue.
 * ---------------------------------------------------------------------------
 * One table. Every sound the game can make, what bus it answers to, how often
 * it is allowed to repeat, and either the file it plays or the synth recipe
 * that stands in for one.
 *
 * EVERY EVENT SOUND IS A RECORDING.
 *
 * The table shipped for months as synth recipes -- filtered noise and swept
 * oscillators -- so that the whole path (event, planner, voice limiter,
 * panner, bus, output) was exercised from the first run rather than waiting on
 * a hundred deliveries. That was the right way round, and the swap it was
 * built for has now happened: 42 of the 45 entries below play files cut from
 * the Gamemaster Pro Sound Collection by `tools/build-sfx.mjs`, which records
 * the trim and loudness decision behind each one. The whole pack is ~343 kB.
 * (This header said 41 of 43 for a while after launchBog landed, and every
 * other comment in the module that counted repeated it. tests/audio.test.ts
 * now pins the count, so the next entry has to update this line to pass.)
 *
 * THREE ENTRIES ARE SYNTH, AND SHOULD STAY THAT WAY.
 *
 * `scrapeWall` and `scrapeCar` are SUSTAINED: their gain and their filter
 * cut-off are both driven every frame from the contact force, so a graze
 * hisses and a lean roars, continuously, from one voice. A recording is a
 * fixed spectrum; swapping these for files would cost that whole dimension and
 * buy a loop point to worry about. The engine is the same argument and goes
 * the other way -- see `AudioStage.setEngine`, where a sampled jet loop plays
 * at a rate driven by revs, with the oscillator engine kept as the fallback.
 *
 * `lockOn` is not a sound effect at all but an instrument: a clean blip that
 * repeats faster, and higher, as a homing missile closes. A recording would be
 * a file to download for what an oscillator does exactly.
 *
 * WHAT `level` IS FOR
 *
 * The mix sits in `level`, NOT in the source. It used to live inside
 * `SynthRecipe.gain`, where only the synth path could read it, so the first
 * pass at this swap silently dropped the entire mix and left every sound
 * playing at full bus level. The numbers below are the ones the synth recipes
 * carried, preserved exactly.
 *
 * THE minGap COLUMN IS THE IMPORTANT ONE
 *
 * `wall` and `bump` fire on EVERY contact frame by design (see RacerEvent in
 * sim/types.ts -- it is what lets the VFX scale a scrape against a crash with
 * no second threshold). Most of that is absorbed by routing contacts to a
 * sustained scrape voice instead of a one-shot, but everything else needs a
 * floor too: one missile catching three cars in one frame should be one sound,
 * not three stacked on top of each other 10 dB hot.
 */
import type { ItemId } from '../sim/types'
import { TUNING } from '../content/tuning'
import type { SoundDef, SoundId, SynthRecipe } from './api'

/**
 * A recorded sound. The file lives in `public/audio/sfx/` and is built by
 * `tools/build-sfx.mjs` from the Gamemaster Pro Sound Collection -- see that
 * script for the trim and loudness decisions behind each one.
 */
const f = (
  url: string,
  level: number,
  bus: SoundDef['bus'],
  minGap: number,
  maxVoices: number,
  extra: Partial<SoundDef> = {},
): SoundDef => ({
  source: { kind: 'file', url },
  level, bus, minGap, maxVoices, ...extra,
})

/** Shorthand, because the table is long and the shape is always the same. */
const s = (
  recipe: SynthRecipe,
  bus: SoundDef['bus'],
  minGap: number,
  maxVoices: number,
  extra: Partial<SoundDef> = {},
): SoundDef => ({
  source: { kind: 'synth', recipe },
  bus, minGap, maxVoices, ...extra,
})

export const CATALOGUE: Record<SoundId, SoundDef> = {
  // --- driving -------------------------------------------------------------
  // The boost ladder climbs in pitch AND in length, so a Singularity sounds
  // like more than a Spark rather than just louder. Same escalation the rings,
  // the sparks and the callout copy already use.
  //
  // POSITIONAL, WHICH ONLY MATTERS FOR OTHER CARS. `emit` never pans the
  // player's own sounds, so yours still arrive flat and dead centre. Another
  // car's boost used to arrive flat too, at the same level as yours: over six
  // measured AI races the field fired 235 boosts that played flat at >= 0.5
  // gain against 154 of the player's own, with nothing -- no direction, no
  // level step -- to tell the two apart. The planner also trims another car's
  // boost to 0.6 of yours; see OTHER_CAR in plan.ts.
  boost0: f('audio/sfx/boost-0.mp3', 0.35, 'sfx', 0.10, 2, { vary: 0.10, positional: true }),
  boost1: f('audio/sfx/boost-1.mp3', 0.45, 'sfx', 0.10, 2, { vary: 0.08, positional: true }),
  boost2: f('audio/sfx/boost-2.mp3', 0.55, 'sfx', 0.10, 2, { vary: 0.06, positional: true }),
  boost3: f('audio/sfx/boost-3.mp3', 0.70, 'sfx', 0.10, 2, { vary: 0.04, positional: true }),

  driftStart: f('audio/sfx/drift-start.mp3', 0.22, 'sfx', 0.15, 2, { vary: 0.12 }),
  // Each rung banked. Quiet on purpose: it fires up to four times per slide and
  // the loud moment is the release. The planner raises its pitch a whole tone
  // per rung, so the ladder can be heard climbing -- see the drift-tier block
  // in plan.ts, which is also the first thing that ever played this file.
  // `vary` is half what it was for the same reason: a +/-6% spread is wider
  // than the 12% step between rungs, and two neighbours could land on one note.
  driftTier: f('audio/sfx/drift-tier.mp3', 0.20, 'sfx', 0.12, 3, { vary: 0.03 }),
  driftRelease: f('audio/sfx/drift-release.mp3', 0.40, 'sfx', 0.10, 2, { vary: 0.08 }),

  land: f('audio/sfx/land.mp3', 0.40, 'sfx', 0.10, 3, { vary: 0.12, positional: true }),
  landClean: f('audio/sfx/land-clean.mp3', 0.35, 'sfx', 0.20, 2, { vary: 0.05 }),
  ramp: f('audio/sfx/ramp.mp3', 0.30, 'sfx', 0.15, 2, { vary: 0.10, positional: true }),

  // Sustained. Their gain is driven every frame, never triggered -- minGap and
  // maxVoices are formalities here, the planner never emits them as plays.
  scrapeWall: s({ shape: 'noise', freq: 2200, dur: 1.0, gain: 0.30, q: 2.2 }, 'sfx', 0, 1),
  scrapeCar: s({ shape: 'noise', freq: 1300, dur: 1.0, gain: 0.26, q: 1.6 }, 'sfx', 0, 1),
  crashWall: f('audio/sfx/crash-wall.mp3', 0.65, 'sfx', 0.18, 2, { vary: 0.10, positional: true }),
  crashCar: f('audio/sfx/crash-car.mp3', 0.50, 'sfx', 0.14, 2, { vary: 0.12, positional: true }),

  // --- items ---------------------------------------------------------------
  pickup: f('audio/sfx/pickup.mp3', 0.34, 'sfx', 0.08, 3, { vary: 0.05, positional: true }),
  charge: f('audio/sfx/charge.mp3', 0.22, 'sfx', 0.06, 3, { vary: 0.08, positional: true }),

  fireMissile: f('audio/sfx/fire-missile.mp3', 0.45, 'sfx', 0.10, 3, { vary: 0.07, positional: true }),
  fireSeeker: f('audio/sfx/fire-seeker.mp3', 0.42, 'sfx', 0.10, 3, { vary: 0.07, positional: true }),
  fireAlpha: f('audio/sfx/fire-alpha.mp3', 0.62, 'sfx', 0.20, 2, { vary: 0.04, positional: true }),
  fireRail: f('audio/sfx/fire-rail.mp3', 0.44, 'sfx', 0.10, 3, { vary: 0.06, positional: true }),
  fireMine: f('audio/sfx/fire-mine.mp3', 0.34, 'sfx', 0.15, 2, { vary: 0.06, positional: true }),
  fireEmp: f('audio/sfx/fire-emp.mp3', 0.55, 'sfx', 0.20, 2, { vary: 0.05, positional: true }),
  fireWell: f('audio/sfx/fire-well.mp3', 0.55, 'sfx', 0.25, 2, { vary: 0.04, positional: true }),
  // THE SPOOL-UP, NOT THE RATTLE. This used to be described as the ten-rounds-
  // a-second rattle, and it cannot be: it answers the `fire` event, which the
  // sim pushes ONCE when the item is triggered (race.ts useItem). The rounds
  // themselves are `beamFire`, pushed per round by stepGatling, and that entry
  // below is the rattle. The high voice count here is harmless headroom.
  fireGatling: f('audio/sfx/fire-gatling.mp3', 0.20, 'sfx', 0.045, 6, { vary: 0.18, positional: true }),
  // Positional for the same reason as the boosts above: another car's nitro
  // was arriving flat, at full level, indistinguishable from your own.
  fireNitro: f('audio/sfx/nitro.mp3', 0.50, 'sfx', 0.10, 2, { vary: 0.06, positional: true }),

  // One per gatling round: this IS the rattle. Ten a second against the 0.4 s
  // default hold and three voices lets about two rounds in three sound --
  // measured, 100 of the player's 155 over six AI races -- which still reads as
  // automatic fire.
  beamFire: f('audio/sfx/beam-fire.mp3', 0.20, 'sfx', 0.08, 3, { vary: 0.10, positional: true }),
  beamHit: f('audio/sfx/beam-hit.mp3', 0.18, 'sfx', 0.05, 5, { vary: 0.20, positional: true }),
  // The one item event in the game that takes sustained skill. It gets a sound
  // that lands like an achievement rather than an impact -- when it is YOURS.
  // When another car breaks a third car, the same achievement is somebody
  // else's and plays positionally, trimmed, like their boosts.
  beamBreak: f('audio/sfx/beam-break.mp3', 0.62, 'sfx', 0.30, 1, { vary: 0.03, positional: true }),

  hitLight: f('audio/sfx/hit-light.mp3', 0.55, 'sfx', 0.12, 3, { vary: 0.10, positional: true }),
  hitHeavy: f('audio/sfx/hit-heavy.mp3', 0.75, 'sfx', 0.20, 2, { vary: 0.06, positional: true }),
  hitEmp: f('audio/sfx/hit-emp.mp3', 0.60, 'sfx', 0.20, 2, { vary: 0.06, positional: true }),

  // An absorb is the pilot doing its job, so both of these are bright and
  // pleasant -- the opposite read from the hit they replaced. See the note on
  // the guard/ward events in sim/types.ts. (A guard used to be followed, in the
  // same frame, by a full crashWall: the plating eats the impact but the wall
  // event still reports its whole force. The planner drops the crash now.)
  guard: f('audio/sfx/guard.mp3', 0.45, 'sfx', 0.20, 2, { vary: 0.05, positional: true }),
  ward: f('audio/sfx/ward.mp3', 0.45, 'sfx', 0.20, 2, { vary: 0.05, positional: true }),

  /**
   * THE LOCK-ON TONE. A homing missile -- seeker or Alpha -- has the player,
   * and the planner repeats this faster and higher as it closes (see the
   * lock-on block in plan.ts). Synth, on purpose: see the header.
   *
   * A triangle at A6 with a fifth above it: bright enough to cut through a
   * full field of engines, short enough (70 ms) that ten a second at the
   * urgent end is still a series of blips rather than a drone. `minGap` 0.08
   * is under the fastest interval the planner asks for (0.11 s), so it never
   * eats a beep the planner meant, and still stops a 120 Hz display doubling
   * one.
   */
  lockOn: s({ shape: 'tone', freq: 1760, dur: 0.07, gain: 0.26, attack: 0.002, harm: 0.35, harmonic: 1.5 },
    'sfx', 0.08, 2),

  // --- race ----------------------------------------------------------------
  countdown: f('audio/sfx/countdown.mp3', 0.50, 'sfx', 0.40, 1),
  countdownGo: f('audio/sfx/countdown-go.mp3', 0.70, 'sfx', 0.40, 1),
  lap: f('audio/sfx/lap.mp3', 0.40, 'sfx', 0.50, 1),
  lapFinal: f('audio/sfx/lap-final.mp3', 0.55, 'sfx', 0.50, 1),
  finish: f('audio/sfx/finish.mp3', 0.75, 'sfx', 1.0, 1),
  // Cryostatic's lake giving way on lap 3. Loud, low and once.
  crack: f('audio/sfx/crack.mp3', 0.80, 'sfx', 2.0, 1),
  /**
   * The bog, and the only made sound in the pack: boost-2's own thruster --
   * what a PERFECT start plays -- dropped a fifth and cut off. See the note in
   * tools/build-sfx.mjs for why it is not one of the two power-downs.
   *
   * 0.55 rather than the 0.70 countdownGo carries, because it lands ON the GO
   * every time (a jump start is early by definition) and this is the one sound
   * in the game that is deliberately under another. The two are two octaves
   * apart -- 46-342 Hz against 546-988 -- so being quieter does not make it
   * inaudible, it makes it the floor instead of the fight.
   */
  launchBog: f('audio/sfx/launch-bog.mp3', 0.55, 'sfx', 1.0, 1),

  // --- front end -----------------------------------------------------------
  uiMove: f('audio/sfx/ui-move.mp3', 0.18, 'sfx', 0.04, 2, { vary: 0.04 }),
  uiSelect: f('audio/sfx/ui-select.mp3', 0.30, 'sfx', 0.06, 2),
  uiBack: f('audio/sfx/ui-back.mp3', 0.26, 'sfx', 0.06, 2),
  uiStart: f('audio/sfx/ui-start.mp3', 0.50, 'sfx', 0.30, 1),
}

/** Which fire sound an item uses. One place, so a new item fails loudly here. */
export const FIRE_SOUND: Record<ItemId, SoundId> = {
  railMissile: 'fireRail',
  seekerMissile: 'fireSeeker',
  alphaMissile: 'fireAlpha',
  laserGatling: 'fireGatling',
  voidMine: 'fireMine',
  empBomb: 'fireEmp',
  gravityWell: 'fireWell',
  nitro: 'fireNitro',
  nitroTriple: 'fireNitro',
  overdriveCore: 'fireNitro',
}

/**
 * Which impact sound an item lands with.
 *
 * Alpha and the EMP get their own because both are events the whole field
 * notices; everything else divides into "that hurt" and "that really hurt".
 */
export const HIT_SOUND: Record<ItemId, SoundId> = {
  railMissile: 'hitLight',
  seekerMissile: 'hitLight',
  alphaMissile: 'hitHeavy',
  laserGatling: 'hitLight',
  voidMine: 'hitHeavy',
  empBomb: 'hitEmp',
  gravityWell: 'hitHeavy',
  nitro: 'hitLight',
  nitroTriple: 'hitLight',
  overdriveCore: 'hitLight',
}

/** The boost ladder, indexed by drift tier. Clamped by the caller. */
export const BOOST_SOUND: readonly SoundId[] = ['boost0', 'boost1', 'boost2', 'boost3']

/**
 * The standing start, by grade -- and two thirds of it is the boost ladder.
 *
 * A graded launch banks a REAL drift-tier boost (sim/race.ts applyLaunch), it
 * just does not push a `boost` event to say so, which is why the mechanic was
 * silent for months. So the honest sound for it is the sound that tier already
 * makes everywhere else in the game: a player who has drifted knows what a
 * tier-2 boost sounds like, and hearing it at the lights says "you just banked
 * a Nova" in a vocabulary they have already been taught. Read from TUNING, so
 * a retune of the launch tiers moves the sound with the boost rather than
 * leaving the two describing different sizes of the same event.
 *
 * The jump start cannot borrow anything, because nothing in the game means
 * "stalled on the grid". It has its own recording.
 */
const launchTier = (t: number): SoundId =>
  BOOST_SOUND[t < 0 ? 0 : t > BOOST_SOUND.length - 1 ? BOOST_SOUND.length - 1 : t | 0]

export const LAUNCH_SOUND: Record<'perfect' | 'good' | 'jump', SoundId> = {
  perfect: launchTier(TUNING.boost.launchPerfectTier),
  good: launchTier(TUNING.boost.launchGoodTier),
  jump: 'launchBog',
}
