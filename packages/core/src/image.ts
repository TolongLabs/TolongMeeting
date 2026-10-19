// Greyscale image maths for the slide keyframe rule and the health checks. Pure: pixels in, numbers out.

/** An 8-bit greyscale image, row by row: `data[y * width + x]`. */
export interface GreyImage {
  width: number
  height: number
  data: Uint8Array
}

const checked = (img: GreyImage): void => {
  if (img.data.length !== img.width * img.height)
    throw new RangeError(`grey image ${img.width}x${img.height} has ${img.data.length} pixels`)
}

/** Mean brightness, 0 (black) to 255 (white). */
export function meanLuma(img: GreyImage): number {
  checked(img)
  if (img.data.length === 0) throw new RangeError('grey image is empty')
  let sum = 0
  for (const v of img.data) sum += v
  return sum / img.data.length
}

/** Mean absolute difference of two images of the same size, 0 to 255. */
export function meanDiff(a: GreyImage, b: GreyImage): number {
  checked(a)
  checked(b)
  if (a.width !== b.width || a.height !== b.height)
    throw new RangeError(`cannot compare ${a.width}x${a.height} with ${b.width}x${b.height}`)
  if (a.data.length === 0) throw new RangeError('grey images are empty')
  let sum = 0
  for (let i = 0; i < a.data.length; i++) sum += Math.abs(a.data[i]! - b.data[i]!)
  return sum / a.data.length
}

const HASH_WIDTH = 17
const HASH_HEIGHT = 16

/**
 * The 256-bit difference hash of a 17x16 image: bit `row * 16 + col` is set when the pixel is brighter than its
 * right-hand neighbour. Same bit order as the session's watcher (`docs/session-record/techniques.md`).
 */
export function dHash256(img: GreyImage): bigint {
  checked(img)
  if (img.width !== HASH_WIDTH || img.height !== HASH_HEIGHT)
    throw new RangeError(`dHash256 needs a ${HASH_WIDTH}x${HASH_HEIGHT} image, got ${img.width}x${img.height}`)
  let hash = 0n
  for (let row = 0; row < HASH_HEIGHT; row++)
    for (let col = 0; col < HASH_HEIGHT; col++) {
      const i = row * HASH_WIDTH + col
      if (img.data[i]! > img.data[i + 1]!) hash |= 1n << BigInt(row * HASH_HEIGHT + col)
    }
  return hash
}

/** Number of differing bits. */
export function hamming(a: bigint, b: bigint): number {
  if (a < 0n || b < 0n) throw new RangeError('hamming needs non-negative values')
  let x = a ^ b
  let bits = 0
  while (x > 0n) {
    bits += Number(x & 1n)
    x >>= 1n
  }
  return bits
}
