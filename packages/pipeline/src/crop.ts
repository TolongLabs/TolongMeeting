// Slide curation rules from the session's crop.py and its techniques note. Pure: pixels and hashes in, rectangles
// and frames out.
import { hamming, type GreyImage } from '@tm/core'

/** A rectangle in stage pixels. Structural, the same shape as the worker's `Rect`, so the pipeline does not import the worker. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** A keyframe the worker kept. `region` is the shared screen the worker found, or null. */
export interface KeptFrame {
  file: string
  offsetMs: number
  region: Rect | null
}

/** A kept frame's crop, with the mean luma and dHash of the crop. */
export interface SlideCandidate {
  frame: KeptFrame
  hash: bigint
  luma: number
}

const BRIGHT = 40
const SHARE = 0.04
const DARK_LUMA = 10
const DUPLICATE_BITS = 12
const BUILD_UP_MS = 6000
const BUILD_UP_BITS = 30

// First and last index whose count reaches `min`, or null when none does.
function extent(counts: Uint32Array, min: number): [number, number] | null {
  let first = -1
  let last = -1
  counts.forEach((count, i) => {
    if (count < min) return
    if (first < 0) first = i
    last = i
  })
  return first < 0 ? null : [first, last]
}

/**
 * The span of rows and columns inside `search` where at least 4% of the pixels are brighter than 40, or null when no
 * row or column qualifies. Every pixel is counted.
 */
export function brightnessCrop(img: GreyImage, search: Rect): Rect | null {
  const x1 = search.x + search.width
  const y1 = search.y + search.height
  if (search.x < 0 || search.y < 0 || x1 > img.width || y1 > img.height)
    throw new RangeError(`search area is outside the ${img.width}x${img.height} image`)
  const columns = new Uint32Array(search.width)
  const rows = new Uint32Array(search.height)
  for (let y = search.y; y < y1; y++)
    for (let x = search.x; x < x1; x++)
      if (img.data[y * img.width + x]! > BRIGHT) {
        columns[x - search.x]!++
        rows[y - search.y]!++
      }
  const cols = extent(columns, search.height * SHARE)
  const lines = extent(rows, search.width * SHARE)
  if (cols === null || lines === null) return null
  const [left, right] = cols
  const [top, bottom] = lines
  return { x: search.x + left, y: search.y + top, width: right - left + 1, height: bottom - top + 1 }
}

/**
 * Chooses the slides from frames sorted by time. A frame is dropped when it is too dark, when its hash is within 12
 * bits of a kept one (a near-duplicate), or when the next frame that is not too dark follows within 6 seconds and
 * within 30 bits (a build-up: the slide is still being drawn).
 */
export function selectSlides(frames: SlideCandidate[]): KeptFrame[] {
  const lit = frames.filter((c) => c.luma >= DARK_LUMA)
  const kept: SlideCandidate[] = []
  lit.forEach((c, i) => {
    if (kept.some((k) => hamming(c.hash, k.hash) <= DUPLICATE_BITS)) return
    const next = lit[i + 1]
    if (
      next !== undefined &&
      next.frame.offsetMs - c.frame.offsetMs <= BUILD_UP_MS &&
      hamming(c.hash, next.hash) <= BUILD_UP_BITS
    )
      return
    kept.push(c)
  })
  return kept.map((c) => c.frame)
}
