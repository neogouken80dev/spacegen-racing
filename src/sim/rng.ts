/**
 * Deterministic seeded RNG (mulberry32). Every random decision in the sim
 * draws from an instance of this so a fixed seed plus a fixed input tape
 * always produces an identical race. This is what makes the determinism
 * gate and the headless balance simulation possible.
 */
export class Rng {
  private s: number

  constructor(seed: number) {
    this.s = seed >>> 0
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Float in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo)
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n)
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)]
  }

  /**
   * Weighted pick. `weights` need not sum to 1; they are normalised here.
   * Returns the chosen index.
   */
  weighted(weights: readonly number[]): number {
    let total = 0
    for (let i = 0; i < weights.length; i++) total += weights[i]
    if (total <= 0) return 0
    let r = this.next() * total
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i]
      if (r <= 0) return i
    }
    return weights.length - 1
  }

  fork(salt: number): Rng {
    return new Rng((this.s ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0)
  }

  getState(): number { return this.s }
  setState(s: number): void { this.s = s >>> 0 }
}

/** FNV-1a over a float array, used for the determinism state hash. */
export function hashFloats(values: readonly number[]): string {
  let h = 0x811c9dc5
  const buf = new ArrayBuffer(8)
  const f64 = new Float64Array(buf)
  const u8 = new Uint8Array(buf)
  for (let i = 0; i < values.length; i++) {
    // Quantise to 1e-4 so benign last-bit float noise does not break the hash
    f64[0] = Math.round(values[i] * 1e4) / 1e4
    for (let b = 0; b < 8; b++) {
      h ^= u8[b]
      h = Math.imul(h, 0x01000193) >>> 0
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
