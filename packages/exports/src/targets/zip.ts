import { zipSync, type Zippable } from 'fflate'
import { ExportError, type BundleFile, type ExportBundle, type ExportTarget } from '../types'
import { writeDownload } from './download'
import { renderGuard } from './guard'

const TEXT_FILES = new Set(['transcript.md', 'slides.md', 'chat.md'])
const SLIDE = /^slides\/(\d{2,3})\.webp$/
const SAFE_DIR = /^[a-z0-9-]+$/

/**
 * The entry name inside the folder. Every name is one this module chooses: the summary is always `summary.md`, and the
 * rest are the pipeline's fixed names or `slides/NN.webp` with the digits checked. A path loadBundle does not produce
 * is refused, so nothing from the occurrence directory is copied into an entry name.
 */
function entryFor(file: BundleFile, summaryFile: string): string {
  if (file.path === summaryFile) return 'summary.md'
  if (TEXT_FILES.has(file.path)) return file.path
  const slide = SLIDE.exec(file.path)
  if (slide !== null) return `slides/${slide[1]}.webp`
  throw new ExportError('failed', `The meeting file "${file.path}" cannot be put in a zip.`)
}

/** One folder named `bundle.dirName`, holding the bundle files in order. Images are stored; text is deflated. */
export function zipBundle(bundle: ExportBundle): Uint8Array {
  if (!SAFE_DIR.test(bundle.dirName)) throw new ExportError('failed', 'This meeting has no usable folder name.')
  const data: Zippable = {}
  for (const file of bundle.files) {
    const name = `${bundle.dirName}/${entryFor(file, bundle.summaryFile)}`
    if (Object.hasOwn(data, name)) throw new ExportError('failed', `The zip would hold "${name}" twice.`)
    data[name] = [file.bytes, { level: file.path.endsWith('.webp') ? 0 : 6 }]
  }
  return zipSync(data)
}

export const zipTarget: ExportTarget = {
  id: 'zip',
  async run(bundle, ctx) {
    const filePath = await writeDownload(ctx, 'zip', await renderGuard(() => zipBundle(bundle)))
    return { url: null, filePath, note: null }
  }
}
