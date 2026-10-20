import type { DocBlock, Run } from './doc'

/** A Notion block object, ready for the "append block children" endpoint. */
export type NotionBlock = Record<string, unknown>

/**
 * Notion's documented request limits (https://developers.notion.com/reference/request-limits and
 * https://developers.notion.com/reference/patch-block-children): 2,000 characters per rich text `content` and per link URL,
 * 100 elements per array (rich text and block children), 1,000 block elements and 500KB per request.
 */
const MAX_TEXT = 2000
const MAX_URL = 2000
const MAX_ARRAY = 100
const MAX_REQUEST_BLOCKS = 1000
/** A table block holds its rows as children; with the header repeated, a table of 100 rows is the most one request takes. */
const MAX_BODY_ROWS = 99

/** The bundle's slide images, the only images the document keeps. */
const SLIDE_PATH = /^slides\/\d{2,3}\.webp$/
/** C0/C1 controls except tab and newline, and DEL (the document model strips them; stripped again here). */
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

/** An https link without credentials, whitespace or control characters that fits Notion's URL limit, else null. */
function safeHref(href: string | undefined): string | null {
  if (href === undefined || href.length > MAX_URL) return null
  if (!/^https:\/\//i.test(href) || /[\u0000- \u007f-\u009f\\]/.test(href)) return null
  let url
  try {
    url = new URL(href)
  } catch {
    return null
  }
  return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hostname !== '' ? href : null
}

/** Pieces of at most `MAX_TEXT` UTF-16 units that never cut a surrogate pair. */
function pieces(text: string): string[] {
  const out: string[] = []
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + MAX_TEXT, text.length)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--
    out.push(text.slice(start, end))
    start = end
  }
  return out
}

function textObject(content: string, run: Pick<Run, 'bold' | 'italic' | 'code' | 'href'> = {}): NotionBlock {
  const url = safeHref(run.href)
  return {
    type: 'text',
    text: { content, link: url === null ? null : { url } },
    annotations: { bold: run.bold === true, italic: run.italic === true, code: run.code === true }
  }
}

/** Rich text objects for runs: control characters removed, text split at 2,000 characters, only https links kept. */
function richText(runs: Run[]): NotionBlock[] {
  const out: NotionBlock[] = []
  for (const run of runs) {
    for (const content of pieces(run.text.replace(CONTROLS, ''))) out.push(textObject(content, run))
  }
  return out
}

function groups<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** One block per 100 rich text objects (one empty block when there is no text). */
function textBlocks(type: string, runs: Run[], extra: Record<string, unknown> = {}): NotionBlock[] {
  const objects = richText(runs)
  return (objects.length === 0 ? [[]] : groups(objects, MAX_ARRAY)).map((rich_text) => ({
    type,
    [type]: { rich_text, ...extra }
  }))
}

/** A table cell is one array of at most 100 objects and cannot be split; text beyond that loses its styling to fit. */
function cell(runs: Run[]): NotionBlock[] {
  const objects = richText(runs)
  if (objects.length <= MAX_ARRAY) return objects
  const plain = pieces(runs.map((r) => r.text.replace(CONTROLS, '')).join('')).map((content) => textObject(content))
  if (plain.length > MAX_ARRAY) throw new Error('A table cell holds more text than Notion accepts.')
  return plain
}

function tableBlocks(header: Run[][], rows: Run[][][]): NotionBlock[] {
  const width = header.length
  if (width === 0) return []
  const row = (cells: Run[][]): NotionBlock => ({
    type: 'table_row',
    table_row: { cells: Array.from({ length: width }, (_, i) => cell(cells[i] ?? [])) }
  })
  const head = row(header)
  const bodies = rows.length === 0 ? [[]] : groups(rows, MAX_BODY_ROWS)
  return bodies.map((body) => ({
    type: 'table',
    table: {
      table_width: width,
      has_column_header: true,
      has_row_header: false,
      children: [head, ...body.map(row)]
    }
  }))
}

function imageBlocks(path: string, alt: string, uploads: Map<string, string>): NotionBlock[] {
  const id = SLIDE_PATH.test(path) ? uploads.get(path) : undefined
  // No uploaded file: show the alt text. A remote URL is never used, because Notion would fetch it without auth.
  if (id === undefined) return alt === '' ? [] : textBlocks('paragraph', [{ text: alt }])
  return [
    {
      type: 'image',
      image: {
        type: 'file_upload',
        file_upload: { id },
        caption: richText([{ text: alt }]).slice(0, MAX_ARRAY)
      }
    }
  ]
}

function listBlocks(ordered: boolean, items: Run[][]): NotionBlock[] {
  return items.flatMap((runs) => textBlocks(ordered ? 'numbered_list_item' : 'bulleted_list_item', runs))
}

/**
 * Renders the export document as Notion blocks. `uploads` maps a bundle image path (`slides/NN.webp`) to the id of a
 * Notion file upload; an image without one becomes its alt text. Links keep only https URLs, text is split to Notion's
 * limits and nothing in the document reaches Notion except as rich text.
 */
export function toNotionBlocks(doc: DocBlock[], uploads: Map<string, string>): NotionBlock[] {
  return doc.flatMap((block): NotionBlock[] => {
    switch (block.kind) {
      case 'heading':
        return textBlocks(`heading_${block.level}`, block.runs)
      case 'paragraph':
        return textBlocks('paragraph', block.runs)
      case 'list':
        return listBlocks(block.ordered, block.items)
      case 'table':
        return tableBlocks(block.header, block.rows)
      case 'image':
        return imageBlocks(block.path, block.alt.replace(CONTROLS, ''), uploads)
      case 'code':
        return textBlocks('code', [{ text: block.text }], { language: 'plain text' })
      case 'rule':
      case 'break':
        return [{ type: 'divider', divider: {} }]
    }
  })
}

const encoder = new TextEncoder()

/** The block and its nested blocks (table rows). */
function elements(block: NotionBlock): number {
  const table = block.table as { children?: unknown[] } | undefined
  return 1 + (table?.children?.length ?? 0)
}

/**
 * Groups blocks, in order, into requests of at most `maxCount` blocks, `maxBytes` bytes of JSON and 1,000 block elements
 * (table rows count). A single block over a limit gets a chunk of its own; Notion then refuses it with an error.
 */
export function chunkBlocks(blocks: NotionBlock[], maxCount = 100, maxBytes = 400_000): NotionBlock[][] {
  const chunks: NotionBlock[][] = []
  let current: NotionBlock[] = []
  let bytes = 0
  let count = 0
  for (const block of blocks) {
    const size = encoder.encode(JSON.stringify(block)).length
    const nested = elements(block)
    if (
      current.length > 0 &&
      (current.length >= maxCount || bytes + size > maxBytes || count + nested > MAX_REQUEST_BLOCKS)
    ) {
      chunks.push(current)
      current = []
      bytes = 0
      count = 0
    }
    current.push(block)
    bytes += size
    count += nested
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}
