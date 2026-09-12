/**
 * THE CIRCUITS WERE RENAMED; THEIR IDS WERE NOT.
 *
 *   id            display name       file / symbol
 *   rustfall      Elkarim            rustfall.ts   / RUSTFALL
 *   cryostatic    Frosthelm          cryostatic.ts / CRYOSTATIC
 *   aetherion     Namaresh           aetherion.ts  / AETHERION
 *   hollowchoir   Centurion Prime    hollowchoir.ts / HOLLOWCHOIR
 *
 * Only `name` moved, and that is deliberate. An id is a key: it is written into
 * every saved leaderboard, the remembered track preference in localStorage, the
 * four determinism gates, the balance harness and the music table. Changing it
 * would orphan all of that to make a string match a string the player never
 * sees, since the UI has always read `def.name`.
 *
 * So the codebase keeps saying rustfall and Hollow Choir in ids, filenames,
 * symbols, test labels and comments, and the game says Elkarim and Centurion
 * Prime. That gap is intentional; this table is where to resolve it.
 */
import type { TrackDef } from '../../sim/track'
import { RUSTFALL } from './rustfall'
import { CRYOSTATIC } from './cryostatic'
import { AETHERION } from './aetherion'
import { HOLLOWCHOIR } from './hollowchoir'

export const TRACKS: TrackDef[] = [RUSTFALL, CRYOSTATIC, AETHERION, HOLLOWCHOIR]
export const TRACKS_BY_ID: Record<string, TrackDef> = Object.fromEntries(
  TRACKS.map((t) => [t.id, t]),
)
export { RUSTFALL, CRYOSTATIC, AETHERION, HOLLOWCHOIR }
