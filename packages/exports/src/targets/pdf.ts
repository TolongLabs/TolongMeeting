/// <reference path="../render/pdfmake.d.ts" />
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import pdfmake from 'pdfmake'
import { bundleDocument, type DocBlock, type Run } from '../render/doc'
import { bundleImages, type Jpeg } from '../render/images'
import type { ExportTarget } from '../types'
import { writeDownload } from './download'
import { renderGuard } from './guard'

type Node = Record<string, unknown>

const FONT_DIR = join(import.meta.dir, '..', '..', 'assets', 'fonts')
const FONT = 'DejaVuSans'
/** A4 is 595 pt wide; with 40 pt margins the text column is 515 pt. */
const CONTENT_WIDTH = 515
const MAX_IMAGE_HEIGHT = 700
const HEADING_SIZE = { 1: 18, 2: 14, 3: 12 } as const

// Fonts are read from the package and images are embedded as data, so rendering never reads another file or the network.
pdfmake.setUrlAccessPolicy(() => false)
pdfmake.setLocalAccessPolicy(() => false)

const FONT_FILES = {
  normal: 'DejaVuSans.ttf',
  bold: 'DejaVuSans-Bold.ttf',
  italics: 'DejaVuSans-Oblique.ttf',
  bolditalics: 'DejaVuSans-BoldOblique.ttf'
} as const

let fontsReady: Promise<void> | undefined

/** pdfmake takes font paths or virtual-file names, not bytes: the files go into its in-memory file system by name. */
function loadFonts(): Promise<void> {
  fontsReady ??= (async () => {
    for (const name of Object.values(FONT_FILES))
      pdfmake.virtualfs.writeFileSync(name, new Uint8Array(await readFile(join(FONT_DIR, name))))
    pdfmake.setFonts({ [FONT]: FONT_FILES })
  })()
  // A failed read must be retried by the next export.
  fontsReady.catch(() => {
    fontsReady = undefined
  })
  return fontsReady
}

function runNode(run: Run, bold = false): Node {
  const node: Node = { text: run.text }
  if (run.bold === true || bold) node.bold = true
  if (run.italic === true) node.italics = true
  if (run.code === true) node.background = '#eeeeee'
  if (run.href !== undefined) {
    node.link = run.href
    node.color = '#1a5fb4'
    node.decoration = 'underline'
  }
  return node
}

function textOf(runs: Run[], bold = false): Node {
  return { text: runs.length === 0 ? '' : runs.map((r) => runNode(r, bold)) }
}

/** The pdfmake nodes of one block. Images missing from `images` (no such slide in the bundle) show their alt text. */
function blockNodes(block: DocBlock, images: Map<string, Jpeg>): Node[] {
  switch (block.kind) {
    case 'heading':
      return [{ ...textOf(block.runs), bold: true, fontSize: HEADING_SIZE[block.level], margin: [0, 10, 0, 6] }]
    case 'paragraph':
      return [{ ...textOf(block.runs), margin: [0, 0, 0, 6] }]
    case 'list': {
      const items = block.items.map((runs) => textOf(runs))
      return [{ ...(block.ordered ? { ol: items } : { ul: items }), margin: [0, 0, 0, 6] }]
    }
    case 'table': {
      const columns = block.header.length
      return [
        {
          table: {
            headerRows: 1,
            widths: Array.from({ length: columns }, () => '*'),
            body: [
              block.header.map((cell) => textOf(cell, true)),
              ...block.rows.map((row) => row.map((c) => textOf(c)))
            ]
          },
          layout: 'lightHorizontalLines',
          margin: [0, 0, 0, 8]
        }
      ]
    }
    case 'image': {
      const image = images.get(block.path)
      if (image === undefined) return block.alt === '' ? [] : [{ text: block.alt, italics: true, margin: [0, 0, 0, 6] }]
      return [{ image: block.path, fit: [CONTENT_WIDTH, MAX_IMAGE_HEIGHT], margin: [0, 4, 0, 8] }]
    }
    case 'code':
      return [{ text: block.text, fontSize: 9, background: '#eeeeee', margin: [0, 0, 0, 8] }]
    case 'rule':
      return [
        {
          canvas: [{ type: 'line', x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 0.5, lineColor: '#999999' }],
          margin: [0, 6, 0, 6]
        }
      ]
    case 'break':
      return []
  }
}

/** A4 PDF of the blocks. The fonts are DejaVu Sans; glyphs it lacks (emoji, CJK) print blank. */
export async function renderPdf(doc: DocBlock[], images: Map<string, Jpeg>, title: string): Promise<Uint8Array> {
  await loadFonts()
  const content: Node[] = []
  let pageBreak = false
  for (const block of doc) {
    if (block.kind === 'break') {
      pageBreak = true
      continue
    }
    const nodes = blockNodes(block, images)
    if (pageBreak && nodes.length > 0) {
      nodes[0]!.pageBreak = 'before'
      pageBreak = false
    }
    content.push(...nodes)
  }
  const used = new Set(doc.flatMap((b) => (b.kind === 'image' && images.has(b.path) ? [b.path] : [])))
  const imageData: Record<string, string> = {}
  for (const path of used) {
    imageData[path] = `data:image/jpeg;base64,${Buffer.from(images.get(path)!.bytes).toString('base64')}`
  }
  const buffer = await pdfmake
    .createPdf({
      info: { title },
      pageSize: 'A4',
      pageMargins: 40,
      defaultStyle: { font: FONT, fontSize: 10, lineHeight: 1.3 },
      images: imageData,
      content
    })
    .getBuffer()
  return new Uint8Array(buffer)
}

export const pdfTarget: ExportTarget = {
  id: 'pdf',
  async run(bundle, ctx) {
    const bytes = await renderGuard(async () =>
      renderPdf(bundleDocument(bundle), await bundleImages(bundle), bundle.title)
    )
    const filePath = await writeDownload(ctx, 'pdf', bytes)
    return { url: null, filePath, note: null }
  }
}
