export interface PilotDef {
  id: string
  name: string
  read: string
  shell: number
  accent: number
  face: number
  /** Face-panel personality drives the idle animation set. */
  temperament: 'eager' | 'jittery' | 'cold' | 'gruff' | 'serene' | 'glitched'
}

export const PILOTS: PilotDef[] = [
  { id: 'pip', name: 'PIP', read: 'Rookie unit. Wide-eyed and over-eager.', shell: 0xf2f3f5, accent: 0xff7a2f, face: 0x36e0ff, temperament: 'eager' },
  { id: 'volt', name: 'VOLT', read: 'Overclocked speed addict, visibly vibrating.', shell: 0x3a4150, accent: 0xffe14d, face: 0xfff27a, temperament: 'jittery' },
  { id: 'meridian', name: 'MERIDIAN', read: 'Cold navigation intelligence. Never changes expression.', shell: 0xc8d2dd, accent: 0x24d3ff, face: 0x24d3ff, temperament: 'cold' },
  { id: 'slag', name: 'SLAG', read: 'Junkyard scavenger. Dented and mismatched.', shell: 0x7d6a55, accent: 0xd94f1e, face: 0xffa94d, temperament: 'gruff' },
  { id: 'halo9', name: 'HALO-9', read: 'Caretaker unit from Aetherion. Serene, slow blinks.', shell: 0xf5efe2, accent: 0xe8c66a, face: 0x9fe8d4, temperament: 'serene' },
  { id: 'null', name: 'NULL', read: 'Corrupted derelict unit. Glitches between expressions.', shell: 0x14121a, accent: 0xb44dff, face: 0xff3b6b, temperament: 'glitched' },
]

export const PILOTS_BY_ID: Record<string, PilotDef> = Object.fromEntries(
  PILOTS.map((p) => [p.id, p]),
)
