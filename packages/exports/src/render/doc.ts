import { marked, type Token, type Tokens } from 'marked'
import type { ExportBundle } from '../types'

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

/**
 * Turns pipeline Markdown into blocks. The Markdown comes from untrusted meeting content, so it is only ever text here:
 * raw HTML is dropped, links keep `href` only when they are https (others, and `#anchor` links, become plain text) and
 * images are kept only for the bundle's `slides/NN.webp` files.
 */
export function parseMarkdown(md: string): DocBlock[] {
  return blocks(marked.lexer(md))
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
