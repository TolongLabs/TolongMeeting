import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from 'docx'
import { renderGuard } from '../targets/guard'
import type { DocBlock, Run } from './doc'
import type { Jpeg } from './images'

type Child = Paragraph | Table

/** Word shows pixels at 96 per inch; a portrait page with 1 inch margins is about 624 px wide. */
const MAX_IMAGE_WIDTH = 600
const MAX_IMAGE_HEIGHT = 800
const HEADINGS = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 } as const
const MONO = 'Courier New'
const LINK_COLOR = '1A5FB4'
const BULLETS = 'bullets'
const NUMBERS = 'numbers'

/** Only https links become hyperlinks. The document model already drops the rest; this is the second check. */
function isHttps(href: string): boolean {
  try {
    return new URL(href).protocol === 'https:'
  } catch {
    return false
  }
}

function textRuns(run: Run, bold: boolean, link = false): TextRun[] {
  const style = {
    bold: run.bold === true || bold,
    italics: run.italic === true,
    font: run.code === true ? MONO : undefined,
    shading: run.code === true ? { fill: 'EEEEEE' } : undefined,
    color: link ? LINK_COLOR : undefined,
    underline: link ? {} : undefined
  }
  return run.text.split('\n').map((line, i) => new TextRun({ ...style, text: line, break: i === 0 ? undefined : 1 }))
}

function runChildren(runs: Run[], bold = false): (TextRun | ExternalHyperlink)[] {
  return runs.flatMap((run): (TextRun | ExternalHyperlink)[] => {
    if (run.href === undefined || !isHttps(run.href)) return textRuns(run, bold)
    return [new ExternalHyperlink({ link: run.href, children: textRuns(run, bold, true) })]
  })
}

function blockChildren(block: DocBlock, images: Map<string, Jpeg>, pageBreak: boolean, instance: number): Child[] {
  const pageBreakBefore = pageBreak ? true : undefined
  switch (block.kind) {
    case 'heading':
      return [new Paragraph({ heading: HEADINGS[block.level], pageBreakBefore, children: runChildren(block.runs) })]
    case 'paragraph':
      return [new Paragraph({ pageBreakBefore, spacing: { after: 120 }, children: runChildren(block.runs) })]
    case 'list':
      if (block.items.length === 0) return []
      return block.items.map(
        (runs, i) =>
          new Paragraph({
            pageBreakBefore: i === 0 ? pageBreakBefore : undefined,
            numbering: block.ordered ? { reference: NUMBERS, level: 0, instance } : { reference: BULLETS, level: 0 },
            children: runChildren(runs)
          })
      )
    case 'table': {
      const columns = block.header.length
      if (columns === 0) return []
      const cell = (runs: Run[], bold: boolean) =>
        new TableCell({ children: [new Paragraph({ children: runChildren(runs, bold) })] })
      const rows = [
        new TableRow({ tableHeader: true, children: block.header.map((c) => cell(c, true)) }),
        ...block.rows.map(
          (row) => new TableRow({ children: Array.from({ length: columns }, (_, i) => cell(row[i] ?? [], false)) })
        )
      ]
      // A table cannot carry the page break itself, and Word wants a paragraph after it.
      return [
        ...(pageBreak ? [new Paragraph({ pageBreakBefore: true, children: [] })] : []),
        new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }),
        new Paragraph({ children: [] })
      ]
    }
    case 'image': {
      const image = images.get(block.path)
      if (image === undefined) {
        if (block.alt === '') return []
        return [new Paragraph({ pageBreakBefore, children: [new TextRun({ text: block.alt, italics: true })] })]
      }
      const scale = Math.min(1, MAX_IMAGE_WIDTH / image.width, MAX_IMAGE_HEIGHT / image.height)
      return [
        new Paragraph({
          pageBreakBefore,
          alignment: AlignmentType.CENTER,
          spacing: { before: 80, after: 160 },
          children: [
            new ImageRun({
              type: 'jpg',
              data: image.bytes,
              transformation: {
                width: Math.max(1, Math.round(image.width * scale)),
                height: Math.max(1, Math.round(image.height * scale))
              },
              altText: { name: block.path, title: block.alt, description: block.alt }
            })
          ]
        })
      ]
    }
    case 'code': {
      const lines = block.text.split('\n')
      return lines.map(
        (line, i) =>
          new Paragraph({
            pageBreakBefore: i === 0 ? pageBreakBefore : undefined,
            shading: { fill: 'EEEEEE' },
            children: [new TextRun({ text: line, font: MONO, size: 18 })]
          })
      )
    }
    case 'rule':
      return [
        new Paragraph({
          pageBreakBefore,
          border: { bottom: { style: 'single', size: 6, space: 1, color: '999999' } },
          children: []
        })
      ]
    case 'break':
      return []
  }
}

/** Word file of the blocks. Images are embedded JPEGs from `images`; nothing is fetched. A block after a `break` starts a new page. */
export async function toDocx(doc: DocBlock[], images: Map<string, Jpeg>, title: string): Promise<Uint8Array> {
  return renderGuard(async () => {
    const children: Child[] = []
    let pageBreak = false
    let instance = 0
    for (const block of doc) {
      if (block.kind === 'break') {
        pageBreak = true
        continue
      }
      if (block.kind === 'list' && block.ordered) instance += 1
      const blocks = blockChildren(block, images, pageBreak, instance)
      if (blocks.length > 0) pageBreak = false
      children.push(...blocks)
    }
    const document = new Document({
      title,
      numbering: {
        config: [
          {
            reference: BULLETS,
            levels: [
              {
                level: 0,
                format: LevelFormat.BULLET,
                text: '•',
                alignment: AlignmentType.LEFT,
                style: { paragraph: { indent: { left: 720, hanging: 360 } } }
              }
            ]
          },
          {
            reference: NUMBERS,
            levels: [
              {
                level: 0,
                format: LevelFormat.DECIMAL,
                text: '%1.',
                alignment: AlignmentType.LEFT,
                style: { paragraph: { indent: { left: 720, hanging: 360 } } }
              }
            ]
          }
        ]
      },
      sections: [{ children }]
    })
    return new Uint8Array(await Packer.toBuffer(document))
  })
}
