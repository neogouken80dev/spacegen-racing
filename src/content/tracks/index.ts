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
