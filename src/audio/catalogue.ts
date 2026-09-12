/**
 * SpaceGen Racing — the sound catalogue.
 * ---------------------------------------------------------------------------
 * One table. Every sound the game can make, what bus it answers to, how often
 * it is allowed to repeat, and either the file it plays or the synth recipe
 * that stands in for one.
 *
 * WHY EVERYTHING SHIPS AS SYNTH
 *
 * There are no audio assets in this project. A system that could only play
 * files would be unshippable and untestable until somebody delivers a hundred
 * recordings, and every bug in it would be found months later by whoever
 * finally wired the assets up. Every entry below is audible today, which means
 * the whole path -- event, planner, voice limiter, panner, bus, output -- is
 * exercised on the first run.
 *
 * The placeholders are not trying to sound good. They are trying to be
 * DISTINGUISHABLE, so that "the gatling is firing when it should not be" is
 * something you can hear rather than something you have to instrument. Several
 * of them may never need to become files at all: a filtered noise burst costs
 * zero bytes on a PWA and can vary per play, which a 40 kB wav cannot.
 *
 * TO SHIP A REAL SOUND, change one line:
 *
 *     boost2: { ...,  source: { kind: 'file', url: 'audio/boost-2.mp3' } },
 *
 * Nothing else in the codebase knows the difference. Put the file under
 * `public/audio/` and the service worker caches it with the rest of /assets.
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
import type { SoundDef, SoundId, SynthRecipe } from './api'

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
  boost0: s({ shape: 'noise', freq: 900, freqTo: 2400, dur: 0.30, gain: 0.35, q: 1.2 }, 'sfx', 0.10, 2, { vary: 0.10 }),
  boost1: s({ shape: 'noise', freq: 800, freqTo: 3000, dur: 0.42, gain: 0.45, q: 1.4 }, 'sfx', 0.10, 2, { vary: 0.08 }),
  boost2: s({ shape: 'noise', freq: 700, freqTo: 3800, dur: 0.58, gain: 0.55, q: 1.6 }, 'sfx', 0.10, 2, { vary: 0.06 }),
  boost3: s({ shape: 'noise', freq: 600, freqTo: 4800, dur: 0.80, gain: 0.70, q: 1.9 }, 'sfx', 0.10, 2, { vary: 0.04 }),

  driftStart: s({ shape: 'noise', freq: 1600, dur: 0.16, gain: 0.22, q: 3.0 }, 'sfx', 0.15, 2, { vary: 0.12 }),
  // Each rung banked. Quiet on purpose: it fires up to four times per slide and
  // the loud moment is the release.
  driftTier: s({ shape: 'tone', freq: 660, freqTo: 880, dur: 0.14, gain: 0.20, harm: 0.3 }, 'sfx', 0.12, 3, { vary: 0.06 }),
  driftRelease: s({ shape: 'zap', freq: 320, freqTo: 1400, dur: 0.26, gain: 0.40 }, 'sfx', 0.10, 2, { vary: 0.08 }),

  land: s({ shape: 'thud', freq: 150, freqTo: 60, dur: 0.22, gain: 0.40 }, 'sfx', 0.10, 3, { vary: 0.12, positional: true }),
  landClean: s({ shape: 'tone', freq: 520, freqTo: 780, dur: 0.28, gain: 0.35, harm: 0.45 }, 'sfx', 0.20, 2, { vary: 0.05 }),
  ramp: s({ shape: 'noise', freq: 400, freqTo: 1200, dur: 0.24, gain: 0.30, q: 0.9 }, 'sfx', 0.15, 2, { vary: 0.10, positional: true }),

  // Sustained. Their gain is driven every frame, never triggered -- minGap and
  // maxVoices are formalities here, the planner never emits them as plays.
  scrapeWall: s({ shape: 'noise', freq: 2200, dur: 1.0, gain: 0.30, q: 2.2 }, 'sfx', 0, 1),
  scrapeCar: s({ shape: 'noise', freq: 1300, dur: 1.0, gain: 0.26, q: 1.6 }, 'sfx', 0, 1),
  crashWall: s({ shape: 'thud', freq: 220, freqTo: 55, dur: 0.34, gain: 0.65 }, 'sfx', 0.18, 2, { vary: 0.10, positional: true }),
  crashCar: s({ shape: 'thud', freq: 260, freqTo: 80, dur: 0.26, gain: 0.50 }, 'sfx', 0.14, 2, { vary: 0.12, positional: true }),

  // --- items ---------------------------------------------------------------
  pickup: s({ shape: 'tone', freq: 880, freqTo: 1320, dur: 0.18, gain: 0.34, harm: 0.5 }, 'sfx', 0.08, 3, { vary: 0.05, positional: true }),
  charge: s({ shape: 'tone', freq: 1180, dur: 0.10, gain: 0.22, harm: 0.35 }, 'sfx', 0.06, 3, { vary: 0.08, positional: true }),

  fireMissile: s({ shape: 'zap', freq: 1400, freqTo: 260, dur: 0.34, gain: 0.45 }, 'sfx', 0.10, 3, { vary: 0.07, positional: true }),
  fireSeeker: s({ shape: 'zap', freq: 1100, freqTo: 420, dur: 0.40, gain: 0.42 }, 'sfx', 0.10, 3, { vary: 0.07, positional: true }),
  fireAlpha: s({ shape: 'zap', freq: 700, freqTo: 180, dur: 0.62, gain: 0.62 }, 'sfx', 0.20, 2, { vary: 0.04, positional: true }),
  fireRail: s({ shape: 'zap', freq: 2200, freqTo: 500, dur: 0.22, gain: 0.44 }, 'sfx', 0.10, 3, { vary: 0.06, positional: true }),
  fireMine: s({ shape: 'tone', freq: 320, freqTo: 220, dur: 0.24, gain: 0.34, harm: 0.6 }, 'sfx', 0.15, 2, { vary: 0.06, positional: true }),
  fireEmp: s({ shape: 'noise', freq: 500, freqTo: 180, dur: 0.55, gain: 0.55, q: 0.7 }, 'sfx', 0.20, 2, { vary: 0.05, positional: true }),
  fireWell: s({ shape: 'thud', freq: 180, freqTo: 42, dur: 0.75, gain: 0.55 }, 'sfx', 0.25, 2, { vary: 0.04, positional: true }),
  // The gatling fires ten rounds a second and they are SUPPOSED to stack into a
  // rattle -- that is what the weapon is. Short, quiet, high voice count, and
  // a real minGap so a 120Hz display cannot double it.
  fireGatling: s({ shape: 'noise', freq: 2600, dur: 0.07, gain: 0.20, q: 4.0 }, 'sfx', 0.045, 6, { vary: 0.18, positional: true }),
  fireNitro: s({ shape: 'noise', freq: 700, freqTo: 3200, dur: 0.45, gain: 0.50, q: 1.5 }, 'sfx', 0.10, 2, { vary: 0.06 }),

  beamFire: s({ shape: 'tone', freq: 1500, dur: 0.12, gain: 0.20, harm: 0.7 }, 'sfx', 0.08, 3, { vary: 0.10, positional: true }),
  beamHit: s({ shape: 'noise', freq: 3200, dur: 0.06, gain: 0.18, q: 5.0 }, 'sfx', 0.05, 5, { vary: 0.20, positional: true }),
  // The one item event in the game that takes sustained skill. It gets a sound
  // that lands like an achievement rather than an impact.
  beamBreak: s({ shape: 'zap', freq: 300, freqTo: 1800, dur: 0.50, gain: 0.62 }, 'sfx', 0.30, 1, { vary: 0.03 }),

  hitLight: s({ shape: 'thud', freq: 240, freqTo: 70, dur: 0.30, gain: 0.55 }, 'sfx', 0.12, 3, { vary: 0.10, positional: true }),
  hitHeavy: s({ shape: 'thud', freq: 170, freqTo: 45, dur: 0.55, gain: 0.75 }, 'sfx', 0.20, 2, { vary: 0.06, positional: true }),
  hitEmp: s({ shape: 'noise', freq: 380, freqTo: 120, dur: 0.60, gain: 0.60, q: 0.6 }, 'sfx', 0.20, 2, { vary: 0.06, positional: true }),

  // An absorb is the pilot doing its job, so both of these are bright and
  // pleasant -- the opposite read from the hit they replaced. See the note on
  // the guard/ward events in sim/types.ts.
  guard: s({ shape: 'tone', freq: 420, freqTo: 630, dur: 0.30, gain: 0.45, harm: 0.8 }, 'sfx', 0.20, 2, { vary: 0.05, positional: true }),
  ward: s({ shape: 'tone', freq: 700, freqTo: 1050, dur: 0.34, gain: 0.45, harm: 0.6 }, 'sfx', 0.20, 2, { vary: 0.05, positional: true }),

  // --- race ----------------------------------------------------------------
  countdown: s({ shape: 'tone', freq: 440, dur: 0.18, gain: 0.50, harm: 0.2 }, 'sfx', 0.40, 1),
  countdownGo: s({ shape: 'tone', freq: 880, dur: 0.45, gain: 0.70, harm: 0.5 }, 'sfx', 0.40, 1),
  lap: s({ shape: 'tone', freq: 620, freqTo: 930, dur: 0.30, gain: 0.40, harm: 0.4 }, 'sfx', 0.50, 1),
  lapFinal: s({ shape: 'tone', freq: 740, freqTo: 1480, dur: 0.55, gain: 0.55, harm: 0.6 }, 'sfx', 0.50, 1),
  finish: s({ shape: 'zap', freq: 400, freqTo: 1600, dur: 0.90, gain: 0.75 }, 'sfx', 1.0, 1),
  // Cryostatic's lake giving way on lap 3. Loud, low and once.
  crack: s({ shape: 'thud', freq: 300, freqTo: 38, dur: 1.20, gain: 0.80 }, 'sfx', 2.0, 1),

  // --- front end -----------------------------------------------------------
  uiMove: s({ shape: 'tone', freq: 760, dur: 0.055, gain: 0.18 }, 'sfx', 0.04, 2, { vary: 0.04 }),
  uiSelect: s({ shape: 'tone', freq: 980, freqTo: 1470, dur: 0.13, gain: 0.30, harm: 0.4 }, 'sfx', 0.06, 2),
  uiBack: s({ shape: 'tone', freq: 700, freqTo: 460, dur: 0.13, gain: 0.26 }, 'sfx', 0.06, 2),
  uiStart: s({ shape: 'zap', freq: 500, freqTo: 1500, dur: 0.40, gain: 0.50 }, 'sfx', 0.30, 1),
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
