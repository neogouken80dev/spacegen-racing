/**
 * THEME REGISTRY — how a track gets its planet.
 *
 * ---------------------------------------------------------------------------
 * WHY A REGISTRY IN THE ART LAYER, AND NOT A FIELD ON TrackDef.
 *
 * Three shapes were on the table.
 *
 *   (a) A `theme` field on TrackDef. Rejected on two counts, either of which
 *       is fatal. TrackDef lives in `src/sim/track.ts`: the sim would then
 *       carry a field it can never read, and every headless balance sweep and
 *       every unit fixture would have to name an art asset to construct a
 *       track. And the render layer's one standing rule is that it READS sim
 *       state and never writes it (`render/api.ts`) — a theme id authored in
 *       the sim is that rule pointed backwards. The art layer is downstream of
 *       content; it should look content up, not be looked up by it.
 *
 *   (b) One big record keyed by track id, inline in environment.ts. This is
 *       what is below, minus the file split — and the file split is the
 *       point. environment.ts was 1,450 lines of which about 700 were the
 *       Rustfall prop catalogue, and Cryostatic's is bigger. Two catalogues in
 *       one module means every art change to one track re-reads and risks the
 *       other, on a track that is gated and art-locked.
 *
 *   (c) Per-track modules behind a shared placement layer. Chosen. The split
 *       falls exactly where the code already divides: environment.ts owns the
 *       MACHINERY (a terrain height field derived from the ribbon's banked
 *       frame, a seeded corridor-relative scatter with clearance tests, the
 *       sky dome, the light rig, the particle layers, the fog), and a theme
 *       owns the CATALOGUE (what is being placed, how the ground is coloured,
 *       what is falling out of the sky, which beats get landmarks). The
 *       interface between them, `ThemeContext` in kit.ts, is deliberately
 *       narrow: a theme is handed the ground field it must sit on and the
 *       corridor it must stay out of, and cannot reach the scene, the
 *       renderer, or the sim.
 *
 * The practical test this shape had to pass: Rustfall must render the frame it
 * was signed off on. It does, because `themes/rustfall.ts` is its catalogue
 * moved across unedited — same geometry, same counts, same radii, same seed,
 * same placement order — and the placement engine it runs through is the same
 * code that ran before.
 *
 * A track with no theme gets Rustfall's. That is a deliberate, visible
 * fallback: a new planet dressed as a junkyard is instantly obviously wrong,
 * where a new planet with no props at all just looks unfinished and can ship.
 * ---------------------------------------------------------------------------
 */
import type { Theme } from './kit'
import { RUSTFALL_THEME } from './rustfall'
import { CRYOSTATIC_THEME } from './cryostatic'
import { AETHERION_THEME } from './aetherion'
import { HOLLOWCHOIR_THEME } from './hollowchoir'

const THEMES: Record<string, Theme> = {
  [RUSTFALL_THEME.id]: RUSTFALL_THEME,
  [CRYOSTATIC_THEME.id]: CRYOSTATIC_THEME,
  [AETHERION_THEME.id]: AETHERION_THEME,
  [HOLLOWCHOIR_THEME.id]: HOLLOWCHOIR_THEME,
}

export function themeFor(trackId: string): Theme {
  return THEMES[trackId] ?? RUSTFALL_THEME
}

export type { Theme } from './kit'
export * from './kit'
