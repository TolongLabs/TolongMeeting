import { dHash256, hamming, meanDiff, type GreyImage } from '@tm/core'
import sharp from 'sharp'

/** Mean difference from the last kept frame at which a frame counts as new. */
export const CHANGE = 7.0
/** Largest mean difference from the previous sample at which the picture counts as settled. */
export const STABLE = 2.0
/** A frame whose dHash is this close (in bits) to a kept frame repeats it. */
export const HASH_DUP = 12
/** Only the left part of the stage is compared: the chat panel lives on the right. */
export const DIFF_WIDTH = 0.74

async function grey(png: Buffer, width: number, height: number): Promise<GreyImage> {
  const { width: full, height: fullHeight } = await sharp(png).metadata()
  if (full === undefined || fullHeight === undefined) throw new Error('frame has no width or height')
  const { data, info } = await sharp(png)
    .extract({ left: 0, top: 0, width: Math.floor(full * DIFF_WIDTH), height: fullHeight })
    .resize(width, height, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.channels !== 1) throw new Error(`expected a one-channel thumbnail, got ${info.channels} channels`)
  return { width, height, data: new Uint8Array(data) }
}

/** 128x72 greyscale of the left 74% of a stage frame, for the settled and changed checks. */
export const thumbnail = (png: Buffer): Promise<GreyImage> => grey(png, 128, 72)

/** 17x16 greyscale of the left 74% of a stage frame, the input of `dHash256`. */
export const hashInput = (png: Buffer): Promise<GreyImage> => grey(png, 17, 16)

/**
 * The session's keyframe rule: keep a frame once the picture has settled (at most `STABLE` from the previous sample),
 * is new (at least `CHANGE` from the last kept frame), and its dHash is more than `HASH_DUP` bits from every kept one.
 */
export class KeyframeSelector {
  private prev: GreyImage | null = null
  private kept: GreyImage | null = null
  private readonly hashes: bigint[] = []

  /** `hash` is only called when the frame is settled and new, because hashing costs an image decode. */
  async consider(thumb: GreyImage, hash: () => Promise<bigint>): Promise<boolean> {
    const settled = this.prev !== null && meanDiff(thumb, this.prev) <= STABLE
    const changed = this.kept === null || meanDiff(thumb, this.kept) >= CHANGE
    this.prev = thumb
    if (!(settled && changed)) return false
    const h = await hash()
    const fresh = this.hashes.every((other) => hamming(h, other) > HASH_DUP)
    if (fresh) this.hashes.push(h)
    this.kept = thumb
    return fresh
  }
}

/** The dHash of a stage frame, ready to pass to `KeyframeSelector.consider`. */
export const hashOf = async (png: Buffer): Promise<bigint> => dHash256(await hashInput(png))
