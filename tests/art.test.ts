/**
 * The art manifest against the files it describes.
 *
 * `src/content/artManifest.ts` is what the game believes exists, and
 * `public/` is what a deploy actually serves. The two can only drift by
 * someone adding or deleting a file without re-running tools/import-art.mjs,
 * and the cost of that drift is silent: a manifest naming a missing file is a
 * 404 that renders as a blank circle, and a file the manifest does not name is
 * a finished portrait the game keeps drawing as a placeholder. Both are held
 * here, along with the sizes, so a hand-dropped 1254px PNG cannot sneak in
 * where a 128px WebP was promised.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, existsSync, statSync } from 'node:fs'
import sharp from 'sharp'
import { ART_SIZES, AVATAR_ART, BADGE_ART } from '../src/content/artManifest'
import { AVATAR_BY_ID } from '../src/content/avatars'

const KINDS: Array<[string, readonly string[]]> = [
  ['avatars', AVATAR_ART],
  ['badges', BADGE_ART],
]

describe('the art manifest matches public/', () => {
  for (const [kind, ids] of KINDS) {
    it(`lists every ${kind} file that is there, and nothing that is not`, () => {
      const dir = `public/${kind}`
      const files = existsSync(dir) ? readdirSync(dir) : []
      const want = new Set<string>()
      for (const id of ids) for (const n of ART_SIZES) want.add(`${id}-${n}.webp`)
      // Every promised file is on disk...
      for (const f of want) expect(files, f).toContain(f)
      // ...and every file on disk was promised. A stray PNG dropped in by hand
      // is caught here too: the game would never draw it.
      for (const f of files) expect(want.has(f), `${kind}/${f} is not in the manifest`).toBe(true)
    })

    it(`exports every ${kind} file square, at its stated size, as WebP`, async () => {
      for (const id of ids) {
        for (const n of ART_SIZES) {
          const meta = await sharp(`public/${kind}/${id}-${n}.webp`).metadata()
          expect(meta.format, `${id}-${n}`).toBe('webp')
          expect(meta.width, `${id}-${n}`).toBe(n)
          expect(meta.height, `${id}-${n}`).toBe(n)
        }
      }
    })
  }

  it('names only avatars the catalogue has', () => {
    for (const id of AVATAR_ART) expect(AVATAR_BY_ID.has(id), id).toBe(true)
  })

  it('keeps the whole set small enough for a phone', () => {
    // The generator's originals were 80 MB. What ships has to be a small
    // fraction of that, fetched as screens open; this is the tripwire for a
    // quality setting or a size that quietly undoes it.
    let bytes = 0
    for (const [kind] of KINDS) {
      const dir = `public/${kind}`
      if (!existsSync(dir)) continue
      for (const f of readdirSync(dir)) bytes += statSync(`${dir}/${f}`).size
    }
    expect(bytes).toBeLessThan(4 * 1024 * 1024)
  })
})
