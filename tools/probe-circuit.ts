import { circuit, type Seg } from '../src/content/tracks/circuit'
// A Road-America-ish shape: long straights, a mix of bands, one hairpin.
const segs: Seg[] = [
  { t: 'straight', len: 420, tag: 'start' },
  { t: 'corner', r: 62, deg: 92, tag: 't1' },
  { t: 'straight', len: 180 },
  { t: 'corner', r: 150, deg: 46 },
  { t: 'straight', len: 300 },
  { t: 'corner', r: 48, deg: 110, tag: 'hairpin' },
  { t: 'straight', len: 260 },
  { t: 'corner', r: 88, deg: -70 },
  { t: 'straight', len: 150 },
  { t: 'corner', r: 72, deg: 68 },
  { t: 'straight', len: 340 },
  { t: 'corner', r: 120, deg: 64 },
  { t: 'straight', len: 200 },
  { t: 'corner', r: 66, deg: -48 },
  { t: 'straight', len: 190 },
  { t: 'corner', r: 95, deg: 98 },
]
const b = circuit(segs, { spacing: 24, defaults: { w: 20, surface: 'tarmac' } })
console.log('plan length', b.length.toFixed(0), 'gap', b.gap.toFixed(3), 'heading err', b.turn.toFixed(3))
console.log('straights authored -> closed:')
console.log('  ', b.straights.map(v=>v.toFixed(0)).join(', '))
console.log('nodes', b.nodes.length)
