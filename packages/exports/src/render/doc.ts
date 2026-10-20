import { marked, type Token, type Tokens } from 'marked'
import { ExportError, type ExportBundle } from '../types'

/** A span of text with the same look. `href` is always an https URL. */
export interface Run {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  href?: string
}

export type DocBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; runs: Run[] }
  | { kind: 'paragraph'; runs: Run[] }
  | { kind: 'list'; ordered: boolean; items: Run[][] }
  | { kind: 'table'; header: Run[][]; rows: Run[][][] }
  | { kind: 'image'; path: string; alt: string } // bundle-relative, e.g. "slides/01.webp"
  | { kind: 'code'; text: string }
  | { kind: 'rule' }
  | { kind: 'break' } // between the files of a bundle

/** The only image paths the document keeps: the bundle's slide images. Anything else (URLs, `../`) is shown as its alt text. */
const SLIDE_PATH = /^slides\/\d{2,3}\.webp$/
/** C0/C1 controls except tab and newline (they break XML and PDF text), and DEL. */
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** marked leaves character references in text tokens; the document wants the characters. Unknown names stay as written. */
function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g,
    (whole, dec?: string, hex?: string, name?: string) => {
      if (name !== undefined) return ENTITIES[name] ?? whole
      const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? '', 16)
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole
    }
  )
}

/** An https link without credentials or control characters, else null. The text stays; only the link goes. */
function safeHref(href: string): string | null {
  if (!/^https:\/\//i.test(href) || /[\u0000- \u007f-\u009f\\]/.test(href)) return null
  let url
  try {
    url = new URL(href)
  } catch {
    return null
  }
  return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hostname !== '' ? href : null
}

type Style = Omit<Run, 'text'>

function sameStyle(a: Run, b: Run): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.code === b.code && a.href === b.href
}

function pushRun(runs: Run[], text: string, style: Style): void {
  const clean = text.replace(CONTROLS, '')
  if (clean === '') return
  const run: Run = { text: clean, ...style }
  const last = runs[runs.length - 1]
  if (last !== undefined && sameStyle(last, run)) last.text += clean
  else runs.push(run)
}

function inline(tokens: Token[] | undefined, style: Style, runs: Run[]): Run[] {
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'text': {
        const t = token as Tokens.Text
        if (t.tokens !== undefined) inline(t.tokens, style, runs)
        else pushRun(runs, decodeEntities(t.text), style)
        break
      }
      case 'escape':
        pushRun(runs, (token as Tokens.Escape).text, style)
        break
      case 'strong':
        inline((token as Tokens.Strong).tokens, { ...style, bold: true }, runs)
        break
      case 'em':
        inline((token as Tokens.Em).tokens, { ...style, italic: true }, runs)
        break
      case 'del':
        inline((token as Tokens.Del).tokens, style, runs)
        break
      case 'codespan':
        pushRun(runs, decodeEntities((token as Tokens.Codespan).text), { ...style, code: true })
        break
      case 'br':
        pushRun(runs, '\n', style)
        break
      case 'link': {
        const link = token as Tokens.Link
        const href = safeHref(link.href)
        inline(link.tokens, href === null ? style : { ...style, href }, runs)
        break
      }
      case 'image':
        pushRun(runs, decodeEntities((token as Tokens.Image).text), style)
        break
      default:
        // Inline `html` (a tag such as <b> or <script>) is dropped; nothing is passed through.
        break
    }
  }
  return runs
}

const inlineRuns = (tokens: Token[] | undefined): Run[] => inline(tokens, {}, [])

function imageBlock(image: Tokens.Image): DocBlock {
  const alt = decodeEntities(image.text)
  return SLIDE_PATH.test(image.href)
    ? { kind: 'image', path: image.href, alt }
    : { kind: 'paragraph', runs: alt === '' ? [] : [{ text: alt.replace(CONTROLS, '') }] }
}

function paragraphBlocks(tokens: Token[] | undefined): DocBlock[] {
  const parts = (tokens ?? []).filter(
    (t) => !(t.type === 'text' && (t as Tokens.Text).text.trim() === '') && t.type !== 'br'
  )
  if (parts.length > 0 && parts.every((t) => t.type === 'image')) {
    return parts.map((t) => imageBlock(t as Tokens.Image)).filter((b) => b.kind !== 'paragraph' || b.runs.length > 0)
  }
  const runs = inlineRuns(tokens)
  return runs.length === 0 ? [] : [{ kind: 'paragraph', runs }]
}

/** The runs of one list item; nested lists are flattened into `out` after it, in order. */
function listItems(list: Tokens.List, out: Run[][]): void {
  for (const item of list.items) {
    const runs: Run[] = []
    const nested: Tokens.List[] = []
    for (const child of item.tokens) {
      if (child.type === 'list') {
        nested.push(child as Tokens.List)
        continue
      }
      const part =
        child.type === 'code'
          ? ([{ text: (child as Tokens.Code).text.replace(CONTROLS, ''), code: true }] satisfies Run[])
          : child.type === 'text' || child.type === 'paragraph'
            ? inlineRuns((child as Tokens.Text).tokens ?? [child])
            : []
      if (part.length === 0) continue
      if (runs.length > 0) pushRun(runs, '\n', {})
      for (const run of part) {
        const { text, ...style } = run
        pushRun(runs, text, style)
      }
    }
    out.push(runs)
    for (const inner of nested) listItems(inner, out)
  }
}

function blocks(tokens: Token[]): DocBlock[] {
  const out: DocBlock[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    switch (token.type) {
      case 'heading': {
        const h = token as Tokens.Heading
        const runs = inlineRuns(h.tokens)
        if (runs.length > 0) out.push({ kind: 'heading', level: Math.min(h.depth, 3) as 1 | 2 | 3, runs })
        break
      }
      case 'paragraph': {
        const p = token as Tokens.Paragraph
        if (p.text.trim() === 'Contents:') {
          // The pipeline's contents list is anchor links to headings; the document has no anchors.
          let next = i + 1
          while (tokens[next]?.type === 'space') next++
          if (tokens[next]?.type === 'list') i = next
          break
        }
        out.push(...paragraphBlocks(p.tokens))
        break
      }
      case 'text': // a bare text token between blocks (only inside list items or blockquotes in practice)
        out.push(...paragraphBlocks([token]))
        break
      case 'list': {
        const l = token as Tokens.List
        const items: Run[][] = []
        listItems(l, items)
        out.push({ kind: 'list', ordered: l.ordered, items })
        break
      }
      case 'table': {
        const t = token as Tokens.Table
        out.push({
          kind: 'table',
          header: t.header.map((cell) => inlineRuns(cell.tokens)),
          rows: t.rows.map((row) => row.map((cell) => inlineRuns(cell.tokens)))
        })
        break
      }
      case 'code':
        out.push({ kind: 'code', text: (token as Tokens.Code).text.replace(CONTROLS, '') })
        break
      case 'blockquote':
        out.push(...blocks((token as Tokens.Blockquote).tokens))
        break
      case 'hr':
        out.push({ kind: 'rule' })
        break
      default:
        // `html` (raw HTML blocks), `space` and `def` produce nothing.
        break
    }
  }
  return out
}

/** Longest Markdown text one file may hand the parser (characters). The 8 MB file cap alone would let marked run for minutes. */
export const MAX_MARKDOWN_CHARS = 1_000_000
/**
 * Longest run of leading spaces, tabs, `>` marks and list markers (`-`, `+`, `*`, `1.`, `1)`) on a line. marked is quadratic in
 * nesting depth, so deeper input is refused.
 */
export const MAX_NESTING_MARKS = 64
/**
 * `*`, `_` and `~` marks in one paragraph, and in one file. marked is quadratic in the marks of a paragraph (8,000 unmatched `*`
 * take 3 s), so a hostile chat message could stall the runner. Real text has a few dozen.
 */
export const MAX_BLOCK_EMPHASIS = 4000
export const MAX_FILE_EMPHASIS = 20_000
/** Lines in one run without a blank line (one paragraph, list or table). marked stalls on tens of thousands (64,000 lines never finish). */
export const MAX_BLOCK_LINES = 20_000

function markdownError(why: string): ExportError {
  return new ExportError('failed', `A meeting file cannot be exported: ${why}.`)
}

/** Counts the container prefix of the line that starts at `start` (whitespace, `>` and list markers); throws past `MAX_NESTING_MARKS`. */
function checkPrefix(md: string, start: number): void {
  let run = 0
  let i = start
  while (i < md.length) {
    const c = md.charCodeAt(i)
    let width = 1
    if (c === 32 || c === 9 || c === 62) {
      // whitespace or a block quote mark
    } else if (c === 45 || c === 43 || c === 42) {
      if (!isBlank(md.charCodeAt(i + 1))) return
    } else if (c >= 48 && c <= 57) {
      let j = i + 1
      while (j < md.length && j - i < 9 && md.charCodeAt(j) >= 48 && md.charCodeAt(j) <= 57) j++
      const end = md.charCodeAt(j)
      if ((end !== 46 && end !== 41) || !isBlank(md.charCodeAt(j + 1))) return
      width = j + 1 - i
    } else return
    run += width
    if (run > MAX_NESTING_MARKS) throw markdownError('it is nested too deeply')
    i += width
  }
}

function isBlank(c: number): boolean {
  return c === 32 || c === 9
}

/** Refuses text that is too long, nests too deeply or holds too many emphasis marks for marked to lex in reasonable time. Linear. */
function checkMarkdown(md: string): void {
  if (md.length > MAX_MARKDOWN_CHARS) throw markdownError('it is too long')
  let blank = true
  let block = 0
  let file = 0
  let lines = 0
  checkPrefix(md, 0)
  for (let i = 0; i < md.length; i++) {
    const c = md.charCodeAt(i)
    if (c === 10) {
      if (blank) {
        block = 0
        lines = 0
      } else if (++lines > MAX_BLOCK_LINES) throw markdownError('it has a paragraph that is too long')
      blank = true
      checkPrefix(md, i + 1)
      continue
    }
    if (c !== 32 && c !== 9 && c !== 13) blank = false
    if ((c === 42 || c === 95 || c === 126) && (++block > MAX_BLOCK_EMPHASIS || ++file > MAX_FILE_EMPHASIS))
      throw markdownError('it has too much emphasis markup')
  }
}

/**
 * Turns pipeline Markdown into blocks. The Markdown comes from untrusted meeting content, so it is only ever text here:
 * raw HTML is dropped, links keep `href` only when they are https (others, and `#anchor` links, become plain text) and
 * images are kept only for the bundle's `slides/NN.webp` files. Text over `MAX_MARKDOWN_CHARS`, with a line that opens
 * with more than `MAX_NESTING_MARKS` spaces, tabs, `>` marks and list markers, with too many `*`, `_` and `~` marks, or with a paragraph of more than `MAX_BLOCK_LINES` lines, is refused; any other throw (marked's `RangeError` on
 * deep input, for one) becomes `ExportError('failed')`.
 */
export function parseMarkdown(md: string): DocBlock[] {
  checkMarkdown(md)
  try {
    return blocks(marked.lexer(md))
  } catch (e) {
    if (e instanceof ExportError) throw e
    const error = markdownError('it could not be read')
    error.cause = e
    throw error
  }
}

/** The summary, `transcript.md`, `slides.md` and `chat.md` (those present), with a `break` between files. */
export function bundleDocument(bundle: ExportBundle): DocBlock[] {
  const order = [bundle.summaryFile, 'transcript.md', 'slides.md', 'chat.md']
  const decoder = new TextDecoder()
  const out: DocBlock[] = []
  for (const name of order) {
    const file = bundle.files.find((f) => f.path === name)
    if (file === undefined) continue
    if (out.length > 0) out.push({ kind: 'break' })
    out.push(...parseMarkdown(decoder.decode(file.bytes)))
  }
  return out
}
