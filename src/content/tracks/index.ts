import type { TrackDef } from '../../sim/track'
import { RUSTFALL } from './rustfall'
import { CRYOSTATIC } from './cryostatic'
import { AETHERION } from './aetherion'

export const TRACKS: TrackDef[] = [RUSTFALL, CRYOSTATIC, AETHERION]
export const TRACKS_BY_ID: Record<string, TrackDef> = Object.fromEntries(
  TRACKS.map((t) => [t.id, t]),
)
export { RUSTFALL, CRYOSTATIC, AETHERION }
