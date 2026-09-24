/**
 * SpaceGen Racing — NAME PLATES.
 * ---------------------------------------------------------------------------
 * Who is that car? One strip of text and a face, floating over every racer in
 * a multiplayer grid except the one the player is driving.
 *
 * ===========================================================================
 * THE PROBLEM IS NOT DRAWING TEXT. IT IS READING IT.
 *
 * A label over a car is trivial to put on screen and very hard to keep
 * legible, because the thing it is attached to is doing all of the following
 * at once: moving at 60 m/s, sitting anywhere from 4 m to 300 m away, rolled
 * upside down inside a drum, behind a barrier, and shoulder to shoulder with
 * seven others at the first corner. Every decision in this file is an answer
 * to one of those, and each of them is written out where it is made.
 *
 * ===========================================================================
 * 1. WHAT THE TEXT ACTUALLY IS: ONE BAKED ATLAS OF WHOLE PLATES
 *
 * Not a glyph atlas, not an SDF field, not a texture per plate. The whole
 * plate -- panel, accent edge, portrait and name -- is drawn once into one row
 * of ONE 512x512 canvas when the race starts, and never touched again. Each
 * plate is then a single quad sampling its own row.
 *
 * Why not the alternatives, in the order they were considered:
 *
 *   SDF text is the right answer when type has to be crisp at an unbounded
 *   range of sizes. Ours is bounded: a plate is between 19 and 26 CSS pixels
 *   tall and never anything else (see THE SIZE, below). Paying for a glyph
 *   atlas, a per-glyph quad stream -- twelve characters times seven plates is
 *   84 quads where this design has 7 -- and a second shader to win crispness
 *   at sizes we do not use is a bad trade.
 *
 *   A texture per plate is one texture bind and one draw call per racer.
 *   Eight of those is eight draw calls for a feature whose entire budget
 *   should be one.
 *
 *   A glyph sprite sheet is SDF's costs without SDF's benefit.
 *
 * The atlas is baked at 512 texels across for a plate drawn at most ~160 CSS
 * pixels wide, so even a 3x phone samples it at better than 1:1 and a desktop
 * at better than 3:1. It is mipmapped, and that is not decoration: a plate
 * 180 m away is a dozen pixels tall, and nearest-sampling a 40px typeface down
 * to that produces a crawling mess of aliased stems every frame the car moves.
 *
 * THE ONE THING MIPS COST US is bleed between neighbouring rows at the small
 * levels. It is bounded by the fade: a plate stops being drawn below
 * `MIN_READABLE_PX`, which puts the smallest mip we ever sample at level 2 --
 * where a 64px row is 16px and the transparent margin baked above and below
 * each plate is still a texel wide. Below that the rows would smear into each
 * other and we never get there.
 *
 * ===========================================================================
 * 2. THE SIZE: CONSTANT ON SCREEN, WHICH MEANS NO SIZE IN THE WORLD AT ALL
 *
 * A plate with a size in metres is unreadable at 150 m, which is exactly the
 * range where you want to know who is ahead. A plate with a size in metres
 * large enough to read at 150 m is a billboard the width of the road when the
 * car is next to you.
 *
 * So the quad has NO world extent. The vertex shader projects the anchor point
 * and then pushes the four corners apart in clip space by a pixel offset
 * scaled by `w`, which the perspective divide then undoes exactly. The plate
 * is the same number of pixels tall at 4 m and at 240 m.
 *
 * Three things fall out of that, and all three are the reason it is done this
 * way rather than by scaling a world-space quad by distance:
 *
 *   - THE QUAD IS UPRIGHT ON SCREEN BY CONSTRUCTION. There is no billboard
 *     basis to build, so there is no world-up to get wrong -- see the note on
 *     `aAxis` in render/particles.ts for what that costs when it is wrong.
 *     Inside Centurion Prime's drum the world rolls through 360 degrees and
 *     the text does not move a pixel.
 *   - THE WHOLE PLATE SITS AT ONE DEPTH: the anchor's. A world-space quad 16 m
 *     across (which is what constant screen size at 150 m would need) would
 *     punch through the tunnel wall next to the car it belongs to and be half
 *     occluded by scenery that is nowhere near it. This one cannot.
 *   - IT IS FREE. Seven anchors written per frame; no matrices, no sorting by
 *     camera basis, no per-plate scale.
 *
 * The ANCHOR is the one place the racer's own frame is load-bearing:
 *
 *       anchor = pos + up * (roof + clearance)
 *
 * `up`, never world +Y. That is the `aAxis` lesson applied where it actually
 * applies: inside the drum the roof points at the axis, and a plate lifted
 * along +Y there would be inside the floor on one side of the barrel and out
 * in space on the other. A few pixels of additional screen-space lift are
 * added on top so the plate never quite touches the car at long range, where
 * a metre and a half of world offset is six pixels.
 *
 * ===========================================================================
 * 3. DEPTH: FADE, NOT OCCLUDE AND NOT DRAW THROUGH
 *
 * There is a real argument for each, so here is the argument against the two
 * we did not take.
 *
 *   DRAW THROUGH (always on top) labels the car behind the barrier, which is
 *   genuinely useful on a blind corner -- and it is the option that LIES. A
 *   plate that reads identically whether its car is beside you or on the other
 *   side of a wall has thrown away the one thing the player most needs from it
 *   during a race, which is where that car is.
 *
 *   OCCLUDE (plain depth test, plate disappears behind geometry) is honest and
 *   free, and in motion it is the worst of the three: at 60 m/s a fence post
 *   sweeping past chops the plate in and out several times a second, which
 *   reads as a rendering fault rather than as occlusion, and a plate that is
 *   simply absent is indistinguishable from a car that is not there.
 *
 * So: TWO PASSES OVER THE SAME GEOMETRY. A ghost pass with the depth test off
 * at `GHOST_ALPHA`, drawn first, and the real pass with the depth test on,
 * drawn over it. Where the anchor is visible the second pass covers the first
 * completely and the plate is at full strength. Where it is hidden, only the
 * ghost survives and the name is still readable but obviously behind
 * something. The boundary is a soft wipe across the plate as the occluder
 * passes, not a pop, because the ghost is always under it.
 *
 * Two draw calls for all seven plates, no depth readback, no raycast, no CPU.
 * On `low` the ghost pass is dropped and occluded plates simply vanish -- the
 * honest cheap answer, and the tier that gets it is the one that cannot afford
 * the second pass.
 *
 * ===========================================================================
 * 4. OVERLAP: NEAREST WINS, THE LOSER FADES, NOBODY IS MOVED
 *
 * Eight cars into the first corner is eight plates in a hand's width of
 * screen. The three ways out are to let them stack, to push them apart, or to
 * drop some.
 *
 * PUSHING THEM APART is what a map label engine does and it is wrong here.
 * A label nudged thirty pixels clear of its neighbour is now hovering over a
 * DIFFERENT CAR, and the association between a name and a car is the entire
 * product. On a static map that is a small lie that resolves when you look
 * closely; at 60 m/s it never resolves.
 *
 * So plates are dropped, in priority order, and priority is DISTANCE: the car
 * you are about to hit matters more than the car in fourth. A plate that loses
 * fades out over `FADE_OUT` rather than vanishing, and the accept threshold
 * has hysteresis (`SHARE_IN` / `SHARE_OUT`) so two plates trading places as
 * their cars trade places do not strobe.
 *
 * AI cars carry a `AI_PRIORITY_PENALTY` metres of pretend extra distance, so
 * in a bunch the humans' names are the ones that survive. See below for why AI
 * cars have plates at all.
 *
 * ===========================================================================
 * 5. AI CARS GET PLATES. DIMMER ONES, AND NO FACE.
 *
 * The tempting answer is that they do not: nobody has a relationship with
 * "MERIDIAN", and seven fewer plates is a calmer screen.
 *
 * It is the wrong answer, because of what the player would then infer from a
 * car with NO plate. There is exactly one of those in every race and it is the
 * player's own. A grid where the bots are also unlabelled makes "no plate"
 * ambiguous between "this is me" and "this is furniture", and the one piece of
 * information a racing game must never be vague about is which car you are
 * driving.
 *
 * The multiplayer contract already assumed this, which is a second vote: see
 * `MultiplayerSlot.avatarId` in src/net/types.ts -- "Null for AI: an AI car
 * draws no avatar on its nameplate". An AI slot HAS a nameplate; it has no
 * face on it.
 *
 * So bots get the name, no portrait, a muted rail and muted ink, a lower base
 * alpha, and last place in the overlap contest. Humans and bots are then
 * distinguishable before you have read a single character.
 *
 * ===========================================================================
 * 6. MOBILE
 *
 * The game runs at 412 CSS pixels wide in portrait. A plate sized for a
 * 1440px desktop is a third of that screen.
 *
 * The plate's screen height is driven from the SMALLER viewport dimension, and
 * clamped at both ends: it cannot shrink below the size at which type stops
 * being type, and it cannot grow past the size at which it stops being a label
 * and becomes UI. In practice that is 19px on a phone and 21px on a 1440x810
 * desktop -- barely different, which is correct, because a phone is held
 * closer and a plate has to subtend roughly the same angle in both.
 *
 * What DOES change on a phone is how many you see at once: `PLATE_BUDGET` caps
 * the number of plates allowed on screen, and on a narrow viewport it is 3.
 * That is not a performance cap -- all the plates in the game are one draw
 * call whatever the count -- it is a CLUTTER cap. On a phone you get the names
 * of the cars you are actually fighting, which at 412px is as many as will fit
 * without covering the corner.
 *
 * ===========================================================================
 * 7. WHAT THIS COSTS, MEASURED
 *
 * One InstancedBufferGeometry (a unit quad, 4 verts, 2 triangles), up to 7
 * live instances, two materials, one 512x512 RGBA texture with mips (~1.4 MB).
 * Per frame the CPU writes at most 7 anchors, 7 sizes and 7 alphas and runs a
 * 7x7 rectangle overlap pass; it allocates nothing.
 *
 * tools/probe-nameplates.mjs takes the renderer's OWN counters for two renders
 * of ONE frame -- the same camera, the same scenery, `plates.group.visible`
 * the only difference -- with the whole field on screen:
 *
 *   tier    racing frame           name plates      share
 *   low      72 calls   84,430     1 call   14 tri   1.4% of calls, 0.017% of tri
 *   medium   77 calls  126,122     2 calls  28 tri   2.6% of calls, 0.022% of tri
 *
 * That is the whole of it. The plate count does not appear in either number,
 * because every plate in the race is one instanced draw per pass -- eight cars
 * and two cars cost the same. `low` halves it by dropping the ghost pass.
 *
 * ===========================================================================
 * 8. WHAT PHOTOGRAPHED BADLY, AND WHY IT IS STILL THIS WAY
 *
 * A plate whose car is at the very edge of the frame is CUT BY THE FRAME. On
 * a 412px phone that is a visible "ORBITA" hanging off the right margin.
 *
 * It is not clamped back on screen, and that is the same decision as the
 * overlap rule rather than a second one: the plate's tick points at its car,
 * and a plate slid along the frame edge to fit points at nothing. The cars at
 * the edges of the frame in a racing game are the ones ALONGSIDE you, which is
 * when their names matter most, so fading them out instead is worse again. A
 * plate cut by the frame is cut exactly as the car it belongs to is cut, which
 * at least tells the truth about where that car is.
 *
 * ===========================================================================
 * 9. WHAT IT DOES NOT DO
 *
 * It does not animate. There is no bob, no pulse, no scale-in. That is partly
 * taste and partly the reduced-motion contract: a label attached to a moving
 * car is already moving as much as anything on screen needs to, and the only
 * time-varying quantity in this file is an alpha crossfade, which is not a
 * vestibular trigger. `reduceMotion` is accepted and honoured -- it shortens
 * the crossfades to nothing so the feature is fully static -- and the probe
 * photographs both so the claim is checked rather than asserted.
 */
import * as THREE from 'three'
import type { MultiplayerSlot } from '../net/types'
import type { RacerState } from '../sim/types'
import type { RenderQuality } from './api'
import { AVATAR_BY_ID, portraitFor } from '../content/avatars'
import { CHASSIS_BY_ID } from '../content/chassis'

// ---------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------

/** Grid slots, and therefore rows in the atlas. See LOBBY_MAX_PLAYERS. */
export const MAX_PLATES = 8

/** Atlas edge, texels. Square and power of two so the mip chain is exact. */
export const ATLAS = 512
/** One row per grid slot: 512 / 8. */
export const CELL_H = ATLAS / MAX_PLATES

/**
 * A ROW, TOP TO BOTTOM: margin, panel, tick, margin. Texels.
 *
 * THE TICK IS NOT DECORATION AND IT WAS NOT IN THE FIRST CUT. Photographed in
 * the first-corner bunch (tools/probe-nameplates.mjs, case 1), four plates
 * floated over five cars and it was genuinely ambiguous which name belonged to
 * which vehicle: a plate is centred on its car, so with two cars a plate-width
 * apart the label sits in the GAP between them. A nine-texel wedge at the
 * plate's bottom centre -- which is exactly where the anchor is -- points at
 * the roof it belongs to and settles it. It cost a tenth of the row, which
 * came out of the portrait and the padding rather than out of the type: the
 * PANEL is still the number that is tuned against the viewport, so the
 * characters are exactly the size they were before the tick existed.
 *
 * THE MARGINS ARE THE MIP BUDGET. The chain averages across row boundaries, so
 * without them the bottom of one racer's plate bleeds into the top of the next
 * at level 2 and below. Three texels is one and a half at level 1 and most of
 * one at level 2, which is the smallest level the readability fade lets us
 * reach.
 */
const CELL_PAD = 3
const PANEL_H = 49
const TICK_H = 9
const TICK_W = 17

/** Type size inside the panel, texels. Cap height lands near 26. */
const FONT_PX = 38
/** Portrait square inside the panel, texels. */
const FACE_PX = 40
/** The accent rail down the left edge of the panel, texels. */
const RAIL_PX = 5

/**
 * PANEL height on screen, CSS pixels, as a fraction of the SMALLER viewport
 * dimension, and the clamp that actually decides it on real devices.
 *
 * The PANEL rather than the quad, deliberately: the quad also carries the tick
 * and two margins, and tuning the number that includes them would mean every
 * change to the tick silently re-tuned the type. The quad is this times
 * CELL_H / PANEL_H, which is where `QUAD_SCALE` below comes from.
 *
 * The fraction only bites between roughly 730px and 1000px of short edge; a
 * phone lands on `MIN` and a desktop on or near `MAX`. It is written as a
 * fraction anyway so a 4K screen does not get a postage stamp.
 */
const SIZE_FRAC = 0.026
const SIZE_MIN = 19
const SIZE_MAX = 26

/** Quad height / panel height. The tick and the margins, priced. */
const QUAD_SCALE = CELL_H / PANEL_H

/**
 * Screen-space lift above the anchor, CSS pixels.
 *
 * The world-space offset (roof + clearance) is what puts the plate over the
 * car in three dimensions and through a loop. At 200 m it is worth two pixels,
 * which is not a gap. This is the guaranteed gap, in the one space where "a
 * gap" means anything -- and it is small because the tick's own tip and the
 * row's bottom margin already stand the panel off the roof.
 */
const LIFT_PX = 2

/** Metres of clearance above the chassis roof for the anchor. */
const ROOF_CLEARANCE = 1.15

/**
 * Below this the plate is a smudge rather than a name, so it is faded out
 * instead. Also the floor that bounds mip bleed -- see the header.
 */
const MIN_READABLE_PX = 11

/** Full strength out to here, gone by `FAR_CULL`. Metres. */
const FAR_FADE = 175
const FAR_CULL = 255

/** Base alpha, human and AI. The bots are quieter on purpose. */
const ALPHA_HUMAN = 1
const ALPHA_AI = 0.72

/** The depth-failed pass. Readable, obviously behind something. */
const GHOST_ALPHA = 0.3

/** Crossfade half-lives, seconds. Appearing is slower than disappearing:
 *  a plate that arrives abruptly draws the eye off the road. */
const FADE_IN = 0.09
const FADE_OUT = 0.06

/**
 * Metres of pretend extra distance carried by an AI plate in the overlap
 * contest. Roughly two car lengths plus a corner: enough that a human two
 * places back beats a bot alongside you, not so much that a bot you are
 * actually fighting is never named.
 */
const AI_PRIORITY_PENALTY = 45

/** Share of a candidate plate's own area that may be covered by an
 *  already-accepted plate. Two values, for hysteresis. */
const SHARE_IN = 0.18
const SHARE_OUT = 0.45

/** Clutter cap, by viewport short edge. Not a performance cap. See the header. */
const NARROW_PX = 560
const BUDGET_NARROW = 3
const BUDGET_WIDE = MAX_PLATES - 1

/** Palette. Pulled from ui/styles.css so a plate belongs to the same game as
 *  the HUD -- --sg-void, --sg-ink, --sg-dim, --sg-mute. */
const C_PANEL = 'rgba(5, 8, 16, 0.76)'
const C_INK = '#eaf2ff'
const C_INK_AI = '#92a8ca'
const C_MUTE = '#5b6d8c'

// ---------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------

/** One plate's worth of resolved identity. Produced by `plateRoster`. */
export interface PlateSpec {
  /** Grid slot, 0-7. Also the racer id in the sim, and the atlas row. */
  slot: number
  name: string
  /** Portrait URL or data URI, or null for a plate that draws no face. */
  portrait: string | null
  /** Rail and edge colour, '#rrggbb'. */
  accent: string
  /** False for an AI slot. Drives ink, base alpha and overlap priority. */
  human: boolean
}

/** What `NameplateSystem.setRoster` takes: the start packet's grid, and who
 *  the reader is. Exactly the two fields `RaceStartPacket` publishes. */
export interface NameplateRoster {
  grid: readonly MultiplayerSlot[]
  /** Matched against `MultiplayerSlot.playerId`. The matching slot gets no
   *  plate, ever. */
  localPlayerId: string
}

/**
 * The grid, minus the local player, resolved into plates.
 *
 * PURE, AND DELIBERATELY SEPARATE FROM EVERY PIXEL IN THIS FILE, because the
 * single most important property of this feature -- that the player never gets
 * a plate over their own roof -- is a property of this function and can
 * therefore be tested without a graphics driver. See tests/nameplates.test.ts.
 *
 * A slot whose `avatarId` names an avatar this build does not have degrades to
 * a nameplate with no portrait rather than to a broken image: the id is
 * resolved through `AVATAR_BY_ID` and a miss is just a null. The portrait
 * itself always comes from `portraitFor`, never from `def.src`: `src` is the
 * 512px file and a plate draws a 40-texel face, and an avatar whose art has
 * not been delivered has to come back as its placeholder rather than as a
 * path that 404s (see src/content/avatars.ts, hasArt).
 */
export function plateRoster(
  grid: readonly MultiplayerSlot[],
  localPlayerId: string,
): PlateSpec[] {
  const out: PlateSpec[] = []
  for (const s of grid) {
    if (s.slot < 0 || s.slot >= MAX_PLATES) continue
    // The local player. `playerId` is null on an AI slot, and `localPlayerId`
    // is a real id, so a null can never accidentally match.
    if (s.playerId !== null && s.playerId === localPlayerId) continue
    const human = s.playerId !== null
    const def = s.avatarId !== null ? AVATAR_BY_ID.get(s.avatarId) : undefined
    out.push({
      slot: s.slot,
      name: s.name,
      // FACE_PX texels in the atlas; the smallest file covers it three times.
      portrait: def ? portraitFor(def, FACE_PX) : null,
      accent: def ? def.accent : C_MUTE,
      human,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// The public face
// ---------------------------------------------------------------------------

/** One plate as it stood at the end of the last `update`. Read by the probe
 *  and by tests; the render path does not read it back. */
export interface PlateFrame {
  slot: number
  name: string
  human: boolean
  /** 0..1 as drawn this frame, after the crossfade. */
  alpha: number
  /** What the alpha is heading for. */
  target: number
  /** Metres from the camera to the anchor. */
  dist: number
  /** Screen rect in CSS pixels, or null when the plate is off screen or
   *  behind the camera. */
  rect: { x: number; y: number; w: number; h: number } | null
  /** True when the overlap pass dropped this plate this frame. */
  suppressed: boolean
  /** The anchor in world space -- `pos + up * lift`. The loop test reads it. */
  anchor: { x: number; y: number; z: number }
}

export interface NameplateStats {
  /** Plates in the roster. Never counts the local player. */
  roster: number
  /** Plates with a non-zero alpha this frame. */
  visible: number
  /** Plates the overlap pass dropped this frame. */
  suppressed: number
  /** Plates off screen, behind the camera, too far, or over the budget. */
  culled: number
  /**
   * Passes this system draws when it draws at all: 2 where the ghost pass
   * exists, 1 on `low`. A property of the tier, not of the frame.
   */
  passes: number
  /**
   * Draw calls and triangles this system actually contributed to the frame --
   * zero when nothing is on screen, and zero until the atlas exists (a
   * runtime with no document never bakes one, so a headless test measures the
   * pass count and tools/probe-nameplates.mjs measures the calls).
   */
  calls: number
  tris: number
  /** PANEL height on screen, CSS pixels, as last computed. The quad is this
   *  times CELL_H / PANEL_H -- it also carries the tick and two margins. */
  heightPx: number
  /** The clutter cap in force. */
  budget: number
}

export interface NameplateSystem {
  group: THREE.Group
  /**
   * Install a race's roster, or clear it with null.
   *
   * Baking the atlas is the expensive part of this feature and it happens
   * here, once, at the start of a race -- never per frame and never per plate.
   */
  setRoster(roster: NameplateRoster | null): void
  /**
   * One call per rendered frame, after the camera has been placed.
   *
   * `racers` is the RENDER view of the field (the interpolated copies), so the
   * plates sit on the cars as drawn rather than a frame behind them. `viewW`
   * and `viewH` are the viewport in CSS pixels; the plate's size is expressed
   * as a fraction of that, so device pixel ratio and the adaptive render scale
   * both cancel out and neither has to be plumbed in here.
   */
  update(
    dt: number,
    racers: readonly RacerState[],
    camera: THREE.PerspectiveCamera,
    viewW: number,
    viewH: number,
    enabled: boolean,
  ): void
  /** The player asked for less movement. Removes the crossfades. */
  reduceMotion: boolean
  readonly stats: NameplateStats
  /** Last frame's plates, in roster order. Diagnostics only. */
  readonly plates: readonly PlateFrame[]
  dispose(): void
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

/**
 * The whole trick is three lines long.
 *
 * `clip.xy += corner * pixels / viewport * clip.w` puts the corner a fixed
 * number of PIXELS from the projected anchor: the multiply by `w` is undone by
 * the perspective divide, and the divide by the viewport converts pixels to
 * the two units NDC spans. Nothing in here knows which way is up in the world,
 * which is the entire point -- see the header.
 *
 * The quad is a unit square in `position`, x and y both -0.5..0.5, with the
 * anchor at the BOTTOM CENTRE of the plate rather than its middle, so the
 * pivot is the point over the car's roof and the plate grows upward from it.
 */
const PLATE_VERT = `
uniform vec2 uViewport;
uniform float uLift;

attribute vec3 iAnchor;
attribute vec2 iSize;   // plate size, CSS pixels
attribute vec2 iCell;   // atlas row: v origin, u extent
attribute float iAlpha;

varying vec2 vUv;
varying float vA;

void main() {
  vA = iAlpha;
  // A dead plate is collapsed off screen rather than discarded per fragment:
  // one branch here beats a discard over every texel it would have covered.
  if (iAlpha < 0.004) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vUv = vec2(0.0);
    return;
  }

  vec4 clip = projectionMatrix * modelViewMatrix * vec4(iAnchor, 1.0);
  vec2 px = vec2(position.x * iSize.x, (position.y + 0.5) * iSize.y + uLift);
  clip.xy += px * (2.0 / uViewport) * clip.w;
  gl_Position = clip;

  // The atlas is uploaded unflipped, so v runs the same way canvas y does:
  // the TOP of the plate is the top of its row.
  vUv = vec2((position.x + 0.5) * iCell.y, iCell.x + (0.5 - position.y) * ${(CELL_H / ATLAS).toFixed(6)});
}
`

const PLATE_FRAG = `
uniform sampler2D uAtlas;
uniform float uGhost;

varying vec2 vUv;
varying float vA;

void main() {
  vec4 t = texture2D(uAtlas, vUv);
  float a = t.a * vA * uGhost;
  if (a < 0.004) discard;
  gl_FragColor = vec4(t.rgb, a);
}
`

// ---------------------------------------------------------------------------
// Scratch. Nothing in update() allocates.
// ---------------------------------------------------------------------------

const _anchor = new THREE.Vector3()
const _proj = new THREE.Vector3()
const _camFwd = new THREE.Vector3()

/** Per-plate working state, indexed by roster order. */
interface Live {
  spec: PlateSpec
  /** u extent of this plate's content inside its atlas row, 0..1. */
  uMax: number
  /** Content aspect: width / height. Decides the plate's pixel width. */
  aspect: number
  alpha: number
  target: number
  dist: number
  key: number
  rectX: number; rectY: number; rectW: number; rectH: number
  onScreen: boolean
  suppressed: boolean
  ax: number; ay: number; az: number
}

// ---------------------------------------------------------------------------

class Nameplates implements NameplateSystem {
  readonly group = new THREE.Group()
  reduceMotion = false

  readonly stats: NameplateStats = {
    roster: 0, visible: 0, suppressed: 0, culled: 0,
    passes: 1, calls: 0, tris: 0, heightPx: 0, budget: BUDGET_WIDE,
  }

  readonly plates: PlateFrame[] = []

  private readonly geo: THREE.InstancedBufferGeometry
  private readonly solidMat: THREE.ShaderMaterial
  private readonly ghostMat: THREE.ShaderMaterial | null
  private readonly solidMesh: THREE.Mesh
  private readonly ghostMesh: THREE.Mesh | null

  private readonly aAnchor: THREE.InstancedBufferAttribute
  private readonly aSize: THREE.InstancedBufferAttribute
  private readonly aCell: THREE.InstancedBufferAttribute
  private readonly aAlpha: THREE.InstancedBufferAttribute

  private readonly live: Live[] = []
  /** Priority order, rebuilt in place each frame. Indices into `live`. */
  private readonly order: number[] = []

  private canvas: HTMLCanvasElement | null = null
  private tex: THREE.Texture | null = null
  /** Bumped on every setRoster so a portrait that decodes after the roster
   *  changed cannot draw itself into the new roster's atlas. */
  private bakeId = 0

  constructor(quality: RenderQuality) {
    this.group.name = 'nameplates'

    // Borrowed, not disposed. `src`'s index and position attribute objects are
    // handed straight to the instanced geometry, and disposing the donor fires
    // the renderer's geometry-dispose hook against those same attributes --
    // which is the vfx.ts pattern, and the reason it does not dispose its
    // donors either.
    const src = new THREE.PlaneGeometry(1, 1)
    const g = new THREE.InstancedBufferGeometry()
    g.index = src.index
    g.setAttribute('position', src.attributes.position)
    g.instanceCount = 0
    // The quad has no world extent, so its bounds are meaningless and any
    // frustum test on them is wrong. Culling is ours (see the projection in
    // update); three's is switched off on the meshes below.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)

    this.aAnchor = inst(new Float32Array(MAX_PLATES * 3), 3)
    this.aSize = inst(new Float32Array(MAX_PLATES * 2), 2)
    this.aCell = inst(new Float32Array(MAX_PLATES * 2), 2)
    this.aAlpha = inst(new Float32Array(MAX_PLATES), 1)
    g.setAttribute('iAnchor', this.aAnchor)
    g.setAttribute('iSize', this.aSize)
    g.setAttribute('iCell', this.aCell)
    g.setAttribute('iAlpha', this.aAlpha)
    this.geo = g

    this.solidMat = this.makeMaterial(1, true)
    this.solidMesh = this.makeMesh(this.solidMat, 31)

    /**
     * THE GHOST PASS IS A MEDIUM-AND-ABOVE FEATURE.
     *
     * It is the cheaper half of the depth answer to pay for: dropping it costs
     * a plate behind a wall entirely rather than dimming it, which is a real
     * loss but a survivable one, and it halves this feature's draw calls on
     * the tier that is already choosing between a shadow map and a frame.
     */
    if (quality.tier === 'low') {
      this.ghostMat = null
      this.ghostMesh = null
    } else {
      this.ghostMat = this.makeMaterial(GHOST_ALPHA, false)
      this.ghostMesh = this.makeMesh(this.ghostMat, 30)
      this.stats.passes = 2
    }
    this.setMeshesVisible(false)
  }

  private makeMaterial(ghost: number, depthTest: boolean): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: null },
        uViewport: { value: new THREE.Vector2(1280, 720) },
        uLift: { value: LIFT_PX },
        uGhost: { value: ghost },
      },
      vertexShader: PLATE_VERT,
      fragmentShader: PLATE_FRAG,
      transparent: true,
      depthTest,
      /**
       * NORMAL BLENDING, NOT ADDITIVE, and it is the one blending decision in
       * the render layer that goes against the house style.
       *
       * Everything else the game draws on top of the world glows, and additive
       * is right for a glow. A nameplate is not a glow: it has to be readable
       * against a white ice field, a black sky and a magenta explosion, which
       * only a DARK PANEL under light text can manage. Additive over a bright
       * background is invisible, which is exactly the background the first
       * corner of Frosthelm is made of.
       */
      blending: THREE.NormalBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    })
  }

  private makeMesh(mat: THREE.ShaderMaterial, order: number): THREE.Mesh {
    const m = new THREE.Mesh(this.geo, mat)
    m.frustumCulled = false
    m.matrixAutoUpdate = false
    m.renderOrder = order
    this.group.add(m)
    return m
  }

  private setMeshesVisible(on: boolean): void {
    // `visible = false` rather than instanceCount 0: a mesh with no instances
    // still issues a draw call and still shows up in renderer.info, which
    // would put this feature's cost on every single-player frame in the game.
    this.solidMesh.visible = on
    if (this.ghostMesh) this.ghostMesh.visible = on
  }

  // -------------------------------------------------------------------------
  // The atlas
  // -------------------------------------------------------------------------

  setRoster(roster: NameplateRoster | null): void {
    this.bakeId++
    this.live.length = 0
    this.plates.length = 0
    this.stats.roster = 0
    this.stats.visible = 0
    this.stats.suppressed = 0
    this.stats.culled = 0
    this.setMeshesVisible(false)
    this.geo.instanceCount = 0
    if (!roster) { this.releaseAtlas(); return }

    const specs = plateRoster(roster.grid, roster.localPlayerId)
    if (specs.length === 0) { this.releaseAtlas(); return }

    for (const spec of specs) {
      this.live.push({
        spec, uMax: 1, aspect: 6, alpha: 0, target: 0, dist: 0, key: 0,
        rectX: 0, rectY: 0, rectW: 0, rectH: 0,
        onScreen: false, suppressed: false, ax: 0, ay: 0, az: 0,
      })
      this.plates.push({
        slot: spec.slot, name: spec.name, human: spec.human,
        alpha: 0, target: 0, dist: 0, rect: null, suppressed: false,
        anchor: { x: 0, y: 0, z: 0 },
      })
    }
    this.stats.roster = this.live.length
    this.bake()
  }

  /**
   * Draw every plate into one canvas and hand it to the GPU.
   *
   * SYNCHRONOUS FOR THE TEXT, ASYNCHRONOUS FOR THE FACES, and that split is
   * the degrade path: the name is on screen from the first frame of the race,
   * and a portrait paints itself into the gap it was left when (and only if)
   * it decodes. An avatar that 404s, an SVG a browser refuses, a roster slot
   * whose avatar id this build has never heard of -- all three land in the
   * same place, which is a plate with a name on it and no face. There is no
   * broken-image state to design because there is no image element.
   *
   * On a runtime with no document -- the unit tests, a server -- this does
   * nothing at all and the rest of the system runs unchanged on a null
   * texture. The placement, the overlap pass and the alpha ramps are all
   * testable that way, which is most of what can go wrong here.
   */
  private bake(): void {
    if (typeof document === 'undefined') return
    const id = this.bakeId
    const canvas = this.canvas ?? document.createElement('canvas')
    canvas.width = ATLAS
    canvas.height = ATLAS
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    this.canvas = canvas
    ctx.clearRect(0, 0, ATLAS, ATLAS)

    for (let i = 0; i < this.live.length; i++) {
      const L = this.live[i]
      const y = i * CELL_H
      const w = this.drawPlate(ctx, L.spec, y)
      L.uMax = w / ATLAS
      // Quad aspect, so the width follows the whole cell the way the height
      // does. The panel's own proportions come out of it unchanged.
      L.aspect = w / CELL_H
    }

    if (!this.tex) {
      const t = new THREE.Texture(canvas)
      // Unflipped, so canvas y and texture v run the same way and the shader's
      // row arithmetic is the one written in the comment rather than its
      // mirror image.
      t.flipY = false
      t.generateMipmaps = true
      t.minFilter = THREE.LinearMipmapLinearFilter
      t.magFilter = THREE.LinearFilter
      t.wrapS = THREE.ClampToEdgeWrapping
      t.wrapT = THREE.ClampToEdgeWrapping
      /**
       * NO COLOUR SPACE ON THE TEXTURE, WHICH IS THE THREE.JS DEFAULT AND IS
       * DELIBERATE HERE RATHER THAN OVERLOOKED.
       *
       * This is a raw ShaderMaterial, so the renderer injects neither the tone
       * mapping nor the output-colour-space chunk into the fragment shader:
       * whatever the shader writes goes to the framebuffer untouched. Tagging
       * the atlas sRGB would have the GPU linearise it on sample and there
       * would then be nothing to encode it back, so the plate would come out
       * dark and over-saturated against a HUD drawn from the same hex values.
       * Sampled raw, the plate is exactly the colours the 2D canvas drew --
       * which is the point of picking them out of ui/styles.css.
       */
      // A plate is a long thin strip of type viewed at a glancing angle for
      // most of a lap. Anisotropy is what stops the far end of it turning to
      // mush; 4 is the cheapest step that visibly helps and is supported
      // essentially everywhere.
      t.anisotropy = 4
      this.tex = t
      this.solidMat.uniforms.uAtlas.value = t
      if (this.ghostMat) this.ghostMat.uniforms.uAtlas.value = t
    }
    this.tex.needsUpdate = true

    for (let i = 0; i < this.live.length; i++) {
      const L = this.live[i]
      if (!L.spec.portrait) continue
      const row = i
      const img = new Image()
      img.onload = () => {
        // The roster changed while this was decoding. Painting now would put
        // one race's face on another race's plate.
        if (id !== this.bakeId || !this.canvas || !this.tex) return
        const c = this.canvas.getContext('2d')
        if (!c) return
        this.drawFace(c, img, row, L.spec.accent)
        this.tex.needsUpdate = true
      }
      // No handler. A face that does not arrive is a plate that keeps the
      // name it was already drawn with -- see the note above.
      img.onerror = () => { /* the plate is already correct without it */ }
      img.src = L.spec.portrait
    }
  }

  /**
   * One plate into one row. Returns the content width in texels.
   *
   * VARIABLE WIDTH, and it earns its keep in the bunch: "AL" is a 130px plate
   * and "STORMWRIGHT" is a 380px one, so the shorter names cost the corner
   * less screen and lose the overlap contest less often. It costs one
   * measureText per plate per race.
   */
  private drawPlate(
    ctx: CanvasRenderingContext2D, spec: PlateSpec, y: number,
  ): number {
    const top = y + CELL_PAD
    const face = spec.portrait !== null
    const ink = spec.human ? C_INK : C_INK_AI
    const accent = spec.human ? spec.accent : C_MUTE

    ctx.font = `700 ${FONT_PX}px "Arial Black", "Arial Bold", "Franklin Gothic Heavy", Impact, system-ui, sans-serif`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    const name = spec.name
    const textW = Math.ceil(ctx.measureText(name).width)

    const padL = RAIL_PX + 6
    const facePad = face ? FACE_PX + 8 : 0
    const padR = 12
    const w = Math.min(ATLAS, padL + facePad + textW + padR)

    ctx.save()
    // Clip to the row. A name long enough to overrun its own plate is then
    // cut off at the edge rather than drawn over the neighbouring row, which
    // would corrupt a DIFFERENT racer's plate -- the worst kind of overflow.
    ctx.beginPath()
    ctx.rect(0, y, w, CELL_H)
    ctx.clip()

    roundRect(ctx, 0.5, top + 0.5, w - 1, PANEL_H - 1, 7)
    ctx.fillStyle = C_PANEL
    ctx.fill()
    ctx.strokeStyle = withAlpha(accent, spec.human ? 0.55 : 0.35)
    ctx.lineWidth = 1.5
    ctx.stroke()

    /**
     * THE TICK, pointing at the roof.
     *
     * Drawn in the accent and drawn WIDE AT THE TOP so it reads as part of the
     * panel rather than as a separate mark: at 21 CSS pixels of panel this is
     * two pixels of wedge, and a thin spike at that size is one anti-aliased
     * smudge. It sits on the plate's horizontal centre because that is where
     * the anchor projects -- see the vertex shader.
     */
    const cxTick = w * 0.5
    ctx.beginPath()
    ctx.moveTo(cxTick - TICK_W * 0.5, top + PANEL_H - 1)
    ctx.lineTo(cxTick + TICK_W * 0.5, top + PANEL_H - 1)
    ctx.lineTo(cxTick, top + PANEL_H + TICK_H)
    ctx.closePath()
    ctx.fillStyle = withAlpha(accent, spec.human ? 1 : 0.7)
    ctx.fill()

    // The rail. The player's colour, in the same place it is on the picker's
    // ring, so "my colour" means one thing across the whole game.
    ctx.fillStyle = accent
    roundRect(ctx, 0.5, top + 0.5, RAIL_PX, PANEL_H - 1, 2.5)
    ctx.fill()

    const cx = padL + (face ? FACE_PX + 8 : 0)
    ctx.fillStyle = ink
    ctx.fillText(name, cx, top + PANEL_H * 0.5 + 1)

    ctx.restore()
    return w
  }

  /** A decoded portrait into its row, clipped to a circle. */
  private drawFace(
    ctx: CanvasRenderingContext2D, img: HTMLImageElement,
    row: number, accent: string,
  ): void {
    const y = row * CELL_H + CELL_PAD
    const x = RAIL_PX + 6
    const d = FACE_PX
    const cy = y + PANEL_H * 0.5
    ctx.save()
    ctx.beginPath()
    ctx.arc(x + d * 0.5, cy, d * 0.5, 0, Math.PI * 2)
    ctx.closePath()
    ctx.clip()
    // A portrait is square by contract (AvatarDef.src), so this is a straight
    // fit and not a crop. If one ever is not, it is letterboxed by the circle
    // rather than stretched.
    ctx.drawImage(img, x, cy - d * 0.5, d, d)
    ctx.restore()
    ctx.beginPath()
    ctx.arc(x + d * 0.5, cy, d * 0.5, 0, Math.PI * 2)
    ctx.strokeStyle = withAlpha(accent, 0.8)
    ctx.lineWidth = 2
    ctx.stroke()
  }

  private releaseAtlas(): void {
    if (this.tex) { this.tex.dispose(); this.tex = null }
    this.solidMat.uniforms.uAtlas.value = null
    if (this.ghostMat) this.ghostMat.uniforms.uAtlas.value = null
  }

  // -------------------------------------------------------------------------
  // The frame
  // -------------------------------------------------------------------------

  update(
    dt: number,
    racers: readonly RacerState[],
    camera: THREE.PerspectiveCamera,
    viewW: number,
    viewH: number,
    enabled: boolean,
  ): void {
    const n = this.live.length
    if (n === 0) { this.setMeshesVisible(false); this.zeroStats(); return }

    const heightPx = Math.max(
      MIN_READABLE_PX,
      Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.min(viewW, viewH) * SIZE_FRAC)),
    )
    const budget = Math.min(viewW, viewH) < NARROW_PX ? BUDGET_NARROW : BUDGET_WIDE
    this.stats.heightPx = heightPx
    this.stats.budget = budget

    camera.updateMatrixWorld()
    const cam = camera.position
    camera.getWorldDirection(_camFwd)

    // --- per plate: where is it, and would we like it on screen? ------------
    let culled = 0
    for (let i = 0; i < n; i++) {
      const L = this.live[i]
      const r = racers[L.spec.slot]
      L.suppressed = false
      L.onScreen = false
      L.target = 0

      /**
       * TWO INDEPENDENT GUARDS ON THE LOCAL PLAYER, and they are independent
       * on purpose. `plateRoster` drops the slot whose `playerId` matches the
       * packet's `localPlayerId`; this drops the racer the SIM calls local.
       * They fail for different reasons -- a wrong id in a start packet, a
       * grid whose slot order does not match the sim's -- and the cost of
       * either failing alone is a plate nailed over the player's own roof for
       * a whole race. Two cheap guards, no shared assumption.
       */
      if (!enabled || !r || r.isLocal) { culled++; continue }

      // Mid-respawn the car is being teleported back onto the road; a label
      // riding that arc is a distraction attached to nothing the player did.
      if (r.respawnTime > 0) { culled++; continue }

      const roof = CHASSIS_BY_ID[r.chassisId]?.halfExtents.y ?? 0.6
      const lift = roof + ROOF_CLEARANCE
      // `up`, not +Y. The whole loop story is this line. See the header.
      L.ax = r.pos.x + r.up.x * lift
      L.ay = r.pos.y + r.up.y * lift
      L.az = r.pos.z + r.up.z * lift
      _anchor.set(L.ax, L.ay, L.az)
      L.dist = _anchor.distanceTo(cam)

      if (L.dist > FAR_CULL) { culled++; continue }

      /**
       * BEHIND THE CAMERA IS TESTED ALONG THE VIEW AXIS, NOT OFF THE PROJECTED
       * POINT.
       *
       * `Vector3.project` divides by w, and w is NEGATIVE for anything behind
       * the lens, so a car directly behind you projects to a mirrored point
       * that lands happily in the middle of the frame. Reading ndc.z back to
       * spot it works for most of that region and not all of it. The dot
       * product against the camera's own forward is the question actually
       * being asked and has no such region.
       */
      const depth = (L.ax - cam.x) * _camFwd.x
        + (L.ay - cam.y) * _camFwd.y
        + (L.az - cam.z) * _camFwd.z
      if (depth <= camera.near) { culled++; continue }

      _proj.copy(_anchor).project(camera)
      const sx = (_proj.x * 0.5 + 0.5) * viewW
      const sy = (1 - (_proj.y * 0.5 + 0.5)) * viewH
      // The QUAD, which is the panel plus the tick plus the two margins.
      const quadH = heightPx * QUAD_SCALE
      const w = quadH * L.aspect
      L.rectW = w
      L.rectH = quadH
      L.rectX = sx - w * 0.5
      // The anchor is the quad's bottom edge, plus the screen-space lift.
      L.rectY = sy - quadH - LIFT_PX

      if (L.rectX + w < 0 || L.rectX > viewW || L.rectY + quadH < 0 || L.rectY > viewH) {
        culled++
        continue
      }

      L.onScreen = true
      L.target = L.spec.human ? ALPHA_HUMAN : ALPHA_AI
      // The far fade. Not a cliff: a plate that winks out at a round number of
      // metres reads as the car having vanished.
      if (L.dist > FAR_FADE) {
        L.target *= 1 - (L.dist - FAR_FADE) / (FAR_CULL - FAR_FADE)
      }
      L.key = L.dist + (L.spec.human ? 0 : AI_PRIORITY_PENALTY)
    }

    // --- the overlap contest ------------------------------------------------
    //
    // Nearest first, bots handicapped. Walk the order and drop anything that
    // is sitting on a plate we have already accepted. n <= 7, so the pairwise
    // test is at most 21 rectangle intersections and is not worth a spatial
    // structure, a sweep, or any cleverness at all.
    this.order.length = 0
    for (let i = 0; i < n; i++) if (this.live[i].onScreen) this.order.push(i)
    this.order.sort((a, b) => this.live[a].key - this.live[b].key)

    let accepted = 0
    let suppressed = 0
    for (let oi = 0; oi < this.order.length; oi++) {
      const L = this.live[this.order[oi]]
      if (accepted >= budget) {
        // Over the clutter cap. Same treatment as losing the overlap contest,
        // and counted the same way: the plate is being dropped for room.
        L.suppressed = true
        L.target = 0
        suppressed++
        continue
      }
      // Hysteresis. A plate currently up is given a lot more rope than one
      // trying to come back, so two cars swapping places do not make their
      // plates strobe at the crossing point.
      const limit = L.alpha > 0.02 ? SHARE_OUT : SHARE_IN
      const area = L.rectW * L.rectH
      let covered = 0
      for (let oj = 0; oj < oi; oj++) {
        const O = this.live[this.order[oj]]
        if (O.suppressed) continue
        covered += overlap(L, O)
        if (covered > area * limit) break
      }
      if (area > 0 && covered > area * limit) {
        L.suppressed = true
        L.target = 0
        suppressed++
      } else {
        accepted++
      }
    }

    // --- ramp, publish, upload ---------------------------------------------
    const anchors = this.aAnchor.array as Float32Array
    const sizes = this.aSize.array as Float32Array
    const cells = this.aCell.array as Float32Array
    const alphas = this.aAlpha.array as Float32Array
    let visible = 0
    for (let i = 0; i < n; i++) {
      const L = this.live[i]
      const half = this.reduceMotion ? 0 : (L.target > L.alpha ? FADE_IN : FADE_OUT)
      L.alpha = half <= 0
        ? L.target
        : L.target + (L.alpha - L.target) * Math.pow(2, -dt / half)
      if (L.alpha < 0.004) L.alpha = 0
      if (L.alpha > 0) visible++

      const i3 = i * 3
      anchors[i3] = L.ax; anchors[i3 + 1] = L.ay; anchors[i3 + 2] = L.az
      const i2 = i * 2
      sizes[i2] = L.rectW
      sizes[i2 + 1] = L.rectH
      cells[i2] = (i * CELL_H) / ATLAS
      cells[i2 + 1] = L.uMax
      alphas[i] = L.alpha

      const p = this.plates[i]
      p.alpha = L.alpha
      p.target = L.target
      p.dist = L.dist
      p.suppressed = L.suppressed
      p.rect = L.onScreen
        ? { x: L.rectX, y: L.rectY, w: L.rectW, h: L.rectH }
        : null
      p.anchor.x = L.ax; p.anchor.y = L.ay; p.anchor.z = L.az
    }
    this.aAnchor.needsUpdate = true
    this.aSize.needsUpdate = true
    this.aCell.needsUpdate = true
    this.aAlpha.needsUpdate = true
    this.geo.instanceCount = n

    // No atlas, no draw: the shader has nothing to sample and a plate-shaped
    // hole is worse than no plate. A browser always has one by now; a headless
    // runtime never will.
    const up = visible > 0 && this.tex !== null
    this.setMeshesVisible(up)
    const passes = this.stats.passes
    this.stats.visible = visible
    this.stats.suppressed = suppressed
    this.stats.culled = culled
    this.stats.calls = up ? passes : 0
    this.stats.tris = up ? passes * n * 2 : 0

    const vp = this.solidMat.uniforms.uViewport.value as THREE.Vector2
    vp.set(viewW, viewH)
    if (this.ghostMat) {
      (this.ghostMat.uniforms.uViewport.value as THREE.Vector2).set(viewW, viewH)
    }
  }

  private zeroStats(): void {
    this.stats.visible = 0
    this.stats.suppressed = 0
    this.stats.culled = 0
    this.stats.calls = 0
    this.stats.tris = 0
  }

  dispose(): void {
    this.bakeId++
    this.group.clear()
    this.geo.dispose()
    this.solidMat.dispose()
    this.ghostMat?.dispose()
    this.releaseAtlas()
    this.canvas = null
    this.live.length = 0
    this.plates.length = 0
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inst(a: Float32Array, size: number): THREE.InstancedBufferAttribute {
  const at = new THREE.InstancedBufferAttribute(a, size)
  at.setUsage(THREE.DynamicDrawUsage)
  return at
}

/** Intersection area of two plate rects, square CSS pixels. */
function overlap(a: Live, b: Live): number {
  const x = Math.min(a.rectX + a.rectW, b.rectX + b.rectW) - Math.max(a.rectX, b.rectX)
  if (x <= 0) return 0
  const y = Math.min(a.rectY + a.rectH, b.rectY + b.rectH) - Math.max(a.rectY, b.rectY)
  return y > 0 ? x * y : 0
}

/**
 * A rounded rectangle path, by hand.
 *
 * `roundRect` is on CanvasRenderingContext2D in every browser that matters and
 * on none of the 2D canvas shims a test might supply, and this file already
 * has to survive having no document at all. Four arcs is cheaper than a
 * feature test plus a fallback.
 */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const k = Math.min(r, w * 0.5, h * 0.5)
  ctx.beginPath()
  ctx.moveTo(x + k, y)
  ctx.lineTo(x + w - k, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + k)
  ctx.lineTo(x + w, y + h - k)
  ctx.quadraticCurveTo(x + w, y + h, x + w - k, y + h)
  ctx.lineTo(x + k, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - k)
  ctx.lineTo(x, y + k)
  ctx.quadraticCurveTo(x, y, x + k, y)
  ctx.closePath()
}

/** '#rrggbb' plus an alpha, as an rgba() string. Anything unparseable falls
 *  back to the muted ink rather than throwing inside a bake. */
function withAlpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return `rgba(91, 109, 140, ${a})`
  const v = parseInt(m[1], 16)
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${a})`
}

// ---------------------------------------------------------------------------

/**
 * Build the system. Cheap: one geometry, two materials, no texture and no
 * canvas until a roster arrives. A single-player race never calls setRoster,
 * so it never pays for any of this beyond the constructor.
 */
export function createNameplates(quality: RenderQuality): NameplateSystem {
  return new Nameplates(quality)
}

/** The plate PANEL's screen height for a viewport, CSS pixels. Exported so the
 *  tests and the probe can check a size claim rather than eyeball it. */
export function plateHeightPx(viewW: number, viewH: number): number {
  return Math.max(
    MIN_READABLE_PX,
    Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.min(viewW, viewH) * SIZE_FRAC)),
  )
}

/** The clutter cap for a viewport. Exported for the same reason. */
export function plateBudget(viewW: number, viewH: number): number {
  return Math.min(viewW, viewH) < NARROW_PX ? BUDGET_NARROW : BUDGET_WIDE
}

export const NAMEPLATE_TUNING = {
  FAR_FADE, FAR_CULL, ALPHA_HUMAN, ALPHA_AI, GHOST_ALPHA,
  AI_PRIORITY_PENALTY, SHARE_IN, SHARE_OUT, LIFT_PX, ROOF_CLEARANCE,
  BUDGET_NARROW, BUDGET_WIDE, NARROW_PX, FADE_IN, FADE_OUT,
} as const
