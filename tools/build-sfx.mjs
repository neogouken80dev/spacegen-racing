/**
 * BUILD THE SFX PACK.
 *
 * Takes the Gamemaster Pro Sound Collection sources, trims each to the part of
 * it this game actually wants, peak-normalises them to a common ceiling, and
 * writes mono mp3s into public/audio/sfx/.
 *
 * WHY EVERY ENTRY CARRIES A TRIM AND NOT JUST A FILENAME.
 *
 * A library sound is authored to be heard on its own. A game sound is heard
 * eight cars deep, under music, forty times a lap. Measured across these
 * sources, the mismatch is mostly LENGTH and ONSET: sci-fi_explosion_05 runs
 * 3.2s, sci-fi_vehicle_thrusters_engage_02 runs 5.4s with its swell starting
 * half a second in, and the gatling fires ten rounds a second so anything past
 * about 120ms is still sounding when the next round starts. The `from`/`len`
 * columns below were each set from a measurement of where that file's energy
 * actually is (tools/probe-sfx.mjs prints the same numbers), not from the
 * catalogue's nominal duration and not from the filename.
 *
 * LOUDNESS FIRST, WITH A PEAK CEILING -- AND WHY NOT PEAK ALONE.
 *
 * The first version of this normalised every file to a common -3 dBFS peak,
 * on the stated reasoning that it would leave catalogue.ts's `gain` column
 * meaning the MIX rather than a per-file correction. Measuring the output
 * showed it did the opposite, twice over:
 *
 *   - `ffmpeg -af volumedetect` reported `max_volume: 0.0 dB` for all 42
 *     sources. Not a coincidence: these are mastered at full scale, the mono
 *     downmix pushes them past it, and the measurement saturates. Every file
 *     therefore got the same -3 dB and ELEVEN of the outputs clipped, peaking
 *     as high as 1.39.
 *   - Even without the clipping, equal peaks do not mean equal loudness. The
 *     RMS spread across the pack was 20 dB, from -5.4 (boost-2) to -25.3
 *     (finish) -- so the gain column would have been carrying a 20 dB per-file
 *     correction, which is exactly what it was supposed to stop carrying.
 *
 * So: normalise to a common RMS over the trimmed region, and clamp the gain so
 * the peak never crosses the ceiling. A hard transient like a UI click hits the
 * ceiling first and lands quieter in RMS terms, which is correct -- a click IS
 * quieter than a sustained thruster at the same peak. Measurement is done on
 * decoded FLOAT samples, in this script, because the integer-domain meter
 * cannot see above full scale.
 *
 *   node tools/build-sfx.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = '/mnt/user-data/uploads/prosoundcollection_audio/prosoundcollection/Gamemaster Audio - Pro Sound Collection v1.3 - 16bit 48k'
const OUT = 'public/audio/sfx'
mkdirSync(OUT, { recursive: true })

/** Loudness target, in dBFS RMS over the trimmed region. */
const RMS_DB = -18
/**
 * Peak ceiling, in dBFS. Gain is clamped so nothing crosses it.
 *
 * -1.5 rather than -1 because a lossy encoder does not preserve peaks: the
 * decoded signal overshoots the input. Measured, at -1 dB exactly one file
 * (ui-select, a 50ms click and therefore peak-limited rather than RMS-limited)
 * came back at 1.0115. The headroom is the encoder's, not taste.
 */
const CEIL_DB = -1.5
/**
 * Bitrate. Mono, and these are short.
 *
 * 64k was the first choice and it measurably damaged the bright material:
 * `finish` carries 27.5% of its energy above 11 kHz and 64 kbps kept 7.2% of
 * it. 96 kbps keeps 16.1%, and the whole pack still lands around a third of a
 * megabyte, so there is nothing to buy by going lower.
 */
const KBPS = 96

// name            folder                     source file                                    from   len   kbps  rate
//
// `rate` is a PLAYBACK-RATE change applied before the trim maths: 0.55 means
// the sample is played back at 55% speed, which drops it 10.4 semitones and
// makes it 1/0.55 times as long. `from`/`len` stay in SOURCE seconds either
// way, so the numbers in this table always describe the region of the original
// file that was taken; only the output is longer. One entry uses it.
const PACK = [
  // --- the boost ladder: climbs in size and in length --------------------
  ['boost-0',      'Sci-Fi', 'sci-fi_small_spaceship_jet_blast_02.wav',            0.10, 0.40],
  ['boost-1',      'Sci-Fi', 'sci-fi_small_spaceship_jet_blast_01.wav',            0.08, 0.55],
  ['boost-2',      'Sci-Fi', 'sci-fi_vehicle_thrusters_engage_large_01.wav',       0.20, 0.80],
  ['boost-3',      'Sci-Fi', 'sci-fi_vehicle_thrusters_engage_02.wav',             0.15, 1.10],
  ['nitro',        'Sci-Fi', 'sci-fi_vehicle_thrusters_engage_01.wav',             0.20, 0.95],

  // --- drift --------------------------------------------------------------
  // The skid's energy peaks 0.23s in, so a trim from zero would catch only the
  // quiet onset and the cue would read as nothing happening.
  ['drift-start',  'Vehicles_Engines_Motors', 'tyre_skid_06.wav',                  0.16, 0.42],
  // Fires up to four times per slide: short, dark, and already quiet at source
  // (peak 0.67) so it sits under the engine rather than on top of it.
  ['drift-tier',   'Sci-Fi', 'sci-fi_scan_target_02.wav',                          0.00, 0.23],
  ['drift-release','Sci-Fi', 'sci-fi_power_up_03.wav',                             0.02, 0.50],

  // --- contact ------------------------------------------------------------
  ['land',         'User_Interface_Menu', 'ui_stamp_01.wav',                       0.00, 0.28],
  ['land-clean',   'Collectibles_Items_Powerup', 'collect_item_sparkle_pop_08.wav',0.06, 0.55],
  ['ramp',         'User_Interface_Menu', 'ui_menu_button_scroll_whoosh_01.wav',   0.00, 0.19],
  ['crash-wall',   'Sci-Fi', 'sci-fi_explosion_02.wav',                            0.02, 0.55],
  ['crash-car',    'Sci-Fi', 'sci-fi_shield_power_on_impact_02.wav',               0.00, 0.40],

  // --- items --------------------------------------------------------------
  ['pickup',       'Collectibles_Items_Powerup', 'collect_item_17.wav',            0.00, 0.17],
  ['charge',       'Sci-Fi', 'sci-fi_beep_computer_ui_03.wav',                     0.00, 0.13],
  ['fire-missile', 'Sci-Fi Weapons', 'sci-fi_weapon_deep_blaster_shot_01.wav',     0.00, 0.50],
  ['fire-seeker',  'Sci-Fi Weapons', 'sci-fi_weapon_plasma_pistol_01.wav',         0.00, 0.48],
  ['fire-alpha',   'Sci-Fi Weapons', 'sci-fi_weapon_rifle_large_shot_02.wav',      0.00, 0.90],
  ['fire-rail',    'Sci-Fi Weapons', 'sci-fi_weapon_laser_small_04.wav',           0.00, 0.22],
  // Ten rounds a second: anything past ~120ms is still sounding when the next
  // round starts, and the rattle turns into a wash.
  ['fire-gatling', 'Sci-Fi Weapons', 'sci-fi_weapon_laser_small_fun_05.wav',       0.00, 0.12],
  ['fire-mine',    'Sci-Fi', 'sci-fi_device_item_power_up_flash_03.wav',           0.06, 0.50],
  ['fire-emp',     'Sci-Fi', 'sci-fi_power_down_01.wav',                           0.04, 0.75],
  // A gravity well IS a sub rumble -- 100% of this file's energy is under
  // 200 Hz, which is exactly wrong for a UI chirp and exactly right here.
  ['fire-well',    'Sci-Fi', 'sci-fi_sub_bass_rumble_01.wav',                      0.55, 1.10],
  ['beam-fire',    'Sci-Fi Weapons', 'sci-fi_weapon_laser_small_06.wav',           0.00, 0.16],
  ['beam-hit',     'Sci-Fi', 'sci-fi_spark_electric_device_active_03.wav',         0.00, 0.13],
  ['beam-break',   'Sci-Fi', 'sci-fi_shield_power_deflect_boom_02.wav',            0.00, 1.00],
  ['hit-light',    'Sci-Fi Weapons', 'sci-fi_weapon_blaster_laser_boom_small_02.wav', 0.00, 0.42],
  ['hit-heavy',    'Sci-Fi', 'sci-fi_explosion_04.wav',                            0.00, 0.75],
  ['hit-emp',      'Sci-Fi', 'sci-fi_electric_pulse_power_down_01.wav',            0.00, 0.85],
  ['guard',        'Sci-Fi', 'sci-fi_shield_power_deflect_block_01.wav',           0.00, 0.60],
  ['ward',         'Sci-Fi', 'sci-fi_shield_device_small_02.wav',                  0.02, 0.60],

  // --- race ---------------------------------------------------------------
  ['countdown',    'Sci-Fi', 'sci-fi_beep_computer_ui_06.wav',                     0.00, 0.11],
  ['countdown-go', 'Sci-Fi', 'sci-fi_power_up_02.wav',                             0.00, 0.90],
  ['lap',          'Sci-Fi', 'sci-fi_power_up_11.wav',                             0.00, 0.55],
  ['lap-final',    'Sci-Fi', 'sci-fi_alarm_warning_loop_02.wav',                   0.00, 0.31],
  ['finish',       'Sci-Fi', 'sci-fi_power_up_08.wav',                             0.00, 1.60],
  // Cryostatic's lake giving way. The largest, lowest thing in the pack.
  ['crack',        'Sci-Fi', 'sci-fi_explosion_05.wav',                            0.00, 1.60],
  /**
   * THE BOG. A jump start, and the only sound in the pack that is made rather
   * than found.
   *
   * It is boost-2's OWN source -- the thruster a PERFECT start plays -- taken
   * from the same point in the file and then dropped a fifth and stretched by
   * `rate`, so what the player hears is literally the ignition they were
   * reaching for, failing to catch. Nothing in the collection means "stalled":
   * the two power-downs are an EMP hit and an EMP launch already, and giving
   * this the EMP's voice would have it say something that did not happen.
   *
   * 0.28s of source at rate 0.55 is 0.51s out, deliberately shorter than the
   * 0.80s bog it announces -- the sound is the engine failing, not the time
   * spent stopped.
   *
   * IT HAS TO SHARE THE FRAME WITH countdown-go, every time, because a jump
   * start fires BEFORE the lights by definition. Measured centroid per 120ms:
   * countdown-go runs 546-988 Hz, this runs 46-38-229-342 Hz. They are a
   * couple of octaves apart for the whole of the overlap, which is what keeps
   * two sounds in one moment legible as two sounds.
   */
  ['launch-bog',   'Sci-Fi', 'sci-fi_vehicle_thrusters_engage_large_01.wav',        0.20, 0.28, undefined, 0.55],

  // --- front end ----------------------------------------------------------
  ['ui-move',      'User_Interface_Menu', 'ui_button_simple_click_06.wav',         0.00, 0.05],
  ['ui-select',    'User_Interface_Menu', 'ui_menu_button_click_24.wav',           0.00, 0.05],
  ['ui-back',      'User_Interface_Menu', 'ui_menu_button_cancel_01.wav',          0.00, 0.40],
  ['ui-start',     'User_Interface_Menu', 'ui_menu_button_confirm_02.wav',         0.00, 0.60],

  // --- the engine ---------------------------------------------------------
  // The only LOOP in the pack, and the only sound that is playing every frame
  // of every race on every car. Taken whole rather than trimmed: the loop
  // points are found at run time the same way the music's are.
  ['engine',       'Sci-Fi', 'sci-fi_vehicle_spaceship_jet_engine_loop2.wav',      0.00, 2.67, 128],
]

/**
 * Peak and RMS of the decoded region, in dBFS, measured on FLOAT samples.
 *
 * Decoding to f32le and measuring here rather than asking ffmpeg's own meter,
 * because the integer meter clamps at 0 dB and these sources go past it once
 * downmixed -- which is how the first version of this script shipped eleven
 * clipped files while reporting a tidy -3 dB for every one of them.
 */
function measure(args) {
  const buf = execFileSync('ffmpeg', [...args, '-f', 'f32le', '-'],
    { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] })
  const x = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4))
  let peak = 0, sum = 0
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; sum += x[i] * x[i] }
  const rms = Math.sqrt(sum / Math.max(1, x.length))
  const dB = (v) => 20 * Math.log10(Math.max(v, 1e-9))
  return { peakDb: dB(peak), rmsDb: dB(rms) }
}

/**
 * Trim, gain, de-click and encode one sound.
 *
 * The fades are not taste -- trimming mid-waveform leaves a step, and a step is
 * a click on every play. 4ms in, and out over the last 45ms or a fifth of the
 * file, whichever is shorter.
 */
function encode(src, dst, from, len, gainDb, kbps, rate = 1) {
  // THE FADES ARE IN OUTPUT TIME, AND `len` IS IN SOURCE TIME. Identical while
  // rate is 1, and not once it is not: a 0.28s trim played at 0.55 is 0.51s of
  // audio, so a fade placed at `len - fadeOut` would fire 0.23s early and take
  // the body of the sound with it.
  const out = len / rate
  const fadeOut = Math.max(0.012, Math.min(0.045, out * 0.22))
  // The rate change goes FIRST so everything after it -- the gain, both fades
  // -- is measured against the stretched signal. `aresample` puts the stream
  // back to 48k for the encoder; without it the container claims the sample
  // rate `asetrate` invented.
  const af = []
  if (rate !== 1) af.push(`asetrate=${Math.round(48000 * rate)}`, 'aresample=48000')
  af.push(
    `volume=${gainDb.toFixed(3)}dB`,
    'afade=t=in:st=0:d=0.004',
    `afade=t=out:st=${Math.max(0, out - fadeOut).toFixed(4)}:d=${fadeOut.toFixed(4)}`,
  )
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-ss', String(from), '-t', String(len), '-i', src,
    '-ac', '1', '-ar', '48000',
    '-af', af.join(','),
    '-c:a', 'libmp3lame', '-b:a', `${kbps}k`,
    dst,
  ])
}

let total = 0
const report = []
for (const [name, folder, file, from, len, kbps, rate = 1] of PACK) {
  const src = join(SRC, folder, file)
  if (!existsSync(src)) { console.error(`MISSING SOURCE: ${src}`); process.exitCode = 1; continue }
  const dst = join(OUT, `${name}.mp3`)

  // Pass 1: how loud, and how peaky, is the trimmed region once it is mono?
  // MEASURED THROUGH THE RATE CHANGE, not around it. `asetrate` is a resample,
  // so it moves both the peak and the RMS of the region being measured; taking
  // the numbers off the untouched source would price the gain for a signal
  // that is not the one being encoded.
  const rateAf = rate !== 1 ? ['-af', `asetrate=${Math.round(48000 * rate)},aresample=48000`] : []
  const base = ['-v', 'error', '-ss', String(from), '-t', String(len), '-i', src, '-ac', '1', '-ar', '48000', ...rateAf]
  const { peakDb, rmsDb } = measure(base)
  // Loudness target, clamped so the peak stays under the ceiling.
  const gainDb = Math.min(RMS_DB - rmsDb, CEIL_DB - peakDb).toFixed(3)
  const limitedByPeak = (CEIL_DB - peakDb) < (RMS_DB - rmsDb)

  // Pass 2: normalise, de-click, encode.
  encode(src, dst, from, len, +gainDb, kbps ?? KBPS, rate)
  // MATCH THE LOUDNESS OF WHAT THE ENCODER PRODUCED, not of what went in.
  //
  // A lossy encoder discards energy, so the decoded RMS lands below the target
  // by an amount that depends on the material -- measured, 1.3 dB for the
  // brightest file in the pack and near zero for the darkest. Encoding once
  // and trusting the input gain leaves the pack unevenly balanced in exactly
  // the way this normalisation exists to prevent. So: measure the output, and
  // if it missed, correct the gain by the error and encode again. One pass is
  // enough because the loss is essentially constant for a given file.
  let finalGain = +gainDb
  if (!limitedByPeak) {
    const got = measure(['-v', 'error', '-i', dst, '-ac', '1', '-ar', '48000']).rmsDb
    const err = RMS_DB - got
    if (Math.abs(err) > 0.25) {
      finalGain = +gainDb + err
      // Never at the cost of the ceiling: a correction that would clip is
      // capped, and the file is then treated as peak-limited like any other.
      const capped = Math.min(finalGain, CEIL_DB - peakDb)
      encode(src, dst, from, len, capped, kbps ?? KBPS, rate)
      finalGain = capped
    }
  }

  const bytes = statSync(dst).size
  total += bytes
  report.push({ name, src: file, from, len, peakDb: +peakDb.toFixed(1), rmsDb: +rmsDb.toFixed(1),
    gainDb: +finalGain.toFixed(2), limitedByPeak, kb: +(bytes / 1024).toFixed(1) })
}

// VERIFY WHAT WAS ACTUALLY WRITTEN, not what was asked for.
//
// The first version of this script reported a tidy -3 dB for all 42 files and
// wrote eleven clipped ones. The report is not the evidence; the decoded output
// is. Anything that clips, or lands far from the loudness target without the
// peak ceiling explaining why, fails the build.
let bad = 0
for (const r of report) {
  const { peakDb, rmsDb } = measure(['-v', 'error', '-i', join(OUT, `${r.name}.mp3`), '-ac', '1', '-ar', '48000'])
  r.outPeakDb = +peakDb.toFixed(1)
  r.outRmsDb = +rmsDb.toFixed(1)
  if (peakDb > -0.1) { console.error(`CLIPPED: ${r.name} at ${r.outPeakDb} dB`); bad++ }
  // Peak-limited files are deliberately quieter than the target; everything
  // else should be within a dB of it.
  if (!r.limitedByPeak && Math.abs(rmsDb - RMS_DB) > 1.0) {
    console.error(`OFF TARGET: ${r.name} at ${r.outRmsDb} dB RMS, wanted ${RMS_DB}`); bad++
  }
}

report.sort((a, b) => b.kb - a.kb)
console.log(report.map((r) =>
  `${r.name.padEnd(14)} ${String(r.kb).padStart(6)} kB ${String(r.len).padStart(5)}s  ` +
  `src peak ${String(r.peakDb).padStart(6)} rms ${String(r.rmsDb).padStart(6)}  ` +
  `gain ${String(r.gainDb).padStart(7)}${r.limitedByPeak ? ' (peak-limited)' : ''}`).join('\n'))
console.log(`\n${report.length} files, ${(total / 1024).toFixed(1)} kB total`)
const peaks = report.map((r) => r.outPeakDb)
console.log(`decoded: worst peak ${Math.max(...peaks).toFixed(1)} dBFS, ` +
  `RMS ${Math.min(...report.map((r) => r.outRmsDb)).toFixed(1)}..${Math.max(...report.map((r) => r.outRmsDb)).toFixed(1)} dBFS`)
if (bad) { console.error(`\nFAIL: ${bad} problem(s) in the encoded output.`); process.exit(1) }
console.log('OK: nothing clips, loudness is on target.')
