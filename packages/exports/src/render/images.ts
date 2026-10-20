import sharp from 'sharp'
import { ExportError, type ExportBundle } from '../types'

export interface Jpeg {
  bytes: Uint8Array
  width: number
  height: number
}

/** Slides are screen captures, far below this. A bigger image is refused before sharp decodes it. */
const MAX_INPUT_PIXELS = 40_000_000
const SLIDE = /^slides\/\d{2,3}\.webp$/

/**
 * Decodes an image (webp from a bundle) and encodes it as a JPEG of at most `maxWidth` pixels wide, never enlarged.
 * Re-encoding means the PDF never embeds the input bytes. Transparency is flattened onto white.
 */
export async function toJpeg(image: Uint8Array, maxWidth = 1600): Promise<Jpeg> {
  const { data, info } = await sharp(image, { limitInputPixels: MAX_INPUT_PIXELS })
    .flatten({ background: '#ffffff' })
    .resize({ width: maxWidth, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer({ resolveWithObject: true })
  return { bytes: new Uint8Array(data), width: info.width, height: info.height }
}

/** Every `slides/NN.webp` of the bundle as a JPEG, keyed by its bundle path. */
export async function bundleImages(bundle: ExportBundle): Promise<Map<string, Jpeg>> {
  const out = new Map<string, Jpeg>()
  for (const file of bundle.files) {
    if (!SLIDE.test(file.path)) continue
    try {
      out.set(file.path, await toJpeg(file.bytes))
    } catch (e) {
      const error = new ExportError('failed', `The slide image "${file.path}" could not be read.`)
      error.cause = e
      throw error
    }
  }
  return out
}
