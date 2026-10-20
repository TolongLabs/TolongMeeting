import { Fragment, type ReactNode } from 'react'
import { marked, type Token, type Tokens } from 'marked'

/** Larger files are cut before they reach the lexer, whose cost grows faster than their size. */
const MAX_BYTES = 200 * 1024
const TOO_LONG = 'The rest of this file is too long to show here.'

/** Deeper nesting overflows the stack before it can be a useful page. */
const MAX_DEPTH = 20

/** One `*` or `_` opening emphasis, not part of `**bold**` or a list bullet. Long runs of these are quadratic in marked. */
const SINGLE_EMPHASIS = /(^|[^*_\\])[*_](?=[^*_\s])/gm
const MAX_SINGLE_EMPHASIS = 1000

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** The text cut to `max` UTF-8 bytes, and whether anything was cut. */
function truncate(text: string, max: number): { text: string; truncated: boolean } {
  const bytes = encoder.encode(text)
  if (bytes.length <= max) return { text, truncated: false }
  return { text: decoder.decode(bytes.slice(0, max)), truncated: true }
}

/**
 * True when a line nests quotes or list indentation more than `MAX_DEPTH` deep. The lexer recurses per level, so a
 * hostile document could otherwise overflow the stack before the renderer sees it.
 */
function tooDeep(text: string): boolean {
  for (const line of text.split('\n')) {
    const quote = /^\s*((?:>\s*)+)/.exec(line)
    if (quote !== null && (quote[1]!.match(/>/g) ?? []).length > MAX_DEPTH) return true
    const list = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+/.exec(line)
    if (list !== null && Math.floor(list[1]!.replace(/\t/g, '    ').length / 2) > MAX_DEPTH) return true
  }
  return false
}

/** True when the text has a long run of single emphasis markers, which marked's lexer takes quadratic time to scan. */
function emphasisFlood(text: string): boolean {
  let count = 0
  for (const _match of text.matchAll(SINGLE_EMPHASIS)) {
    count++
    if (count > MAX_SINGLE_EMPHASIS) return true
  }
  return false
}

/** An https link without credentials, control characters or bidirectional overrides, else null. The text stays; only the link goes. */
function safeHref(href: string): string | null {
  if (!/^https:\/\//i.test(href) || /[\u0000- \u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\\]/.test(href))
    return null
  if (!URL.canParse(href)) return null
  const url = new URL(href)
  return url.username === '' && url.password === '' && url.hostname !== '' ? href : null
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

/** marked leaves character references in text tokens. React escapes the output, so the characters are safe to show. */
function decode(text: string): string {
  return text.replace(/&(#39|amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => ENTITIES[name]!)
}

/** The plain text of a block of HTML, for the inner text of elements such as `<details>`. React escapes it. */
function htmlText(raw: string): string {
  return decode(raw.replace(/<[^>]*>/g, ''))
}

/** Plain text as paragraphs on blank lines. Used where Markdown is refused; React escapes every character. */
function plain(text: string): ReactNode {
  return text
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph.trim() !== '')
    .map((paragraph, i) => <p key={i}>{paragraph}</p>)
}

function inline(tokens: Token[] | undefined, depth: number): ReactNode {
  return (tokens ?? []).map((token, i) => {
    if (depth > MAX_DEPTH) return <Fragment key={i}>{token.raw}</Fragment>
    switch (token.type) {
      case 'text': {
        const t = token as Tokens.Text
        return <Fragment key={i}>{t.tokens ? inline(t.tokens, depth + 1) : decode(t.text)}</Fragment>
      }
      case 'escape':
        return <Fragment key={i}>{(token as Tokens.Escape).text}</Fragment>
      case 'strong':
        return <strong key={i}>{inline((token as Tokens.Strong).tokens, depth + 1)}</strong>
      case 'em':
        return <em key={i}>{inline((token as Tokens.Em).tokens, depth + 1)}</em>
      case 'del':
        return <del key={i}>{inline((token as Tokens.Del).tokens, depth + 1)}</del>
      case 'codespan':
        return <code key={i}>{decode((token as Tokens.Codespan).text)}</code>
      case 'br':
        return <br key={i} />
      case 'link': {
        const link = token as Tokens.Link
        const href = safeHref(link.href)
        // The link text stays; a link that is not a plain https link loses only the link.
        return href === null ? (
          <Fragment key={i}>{inline(link.tokens, depth + 1)}</Fragment>
        ) : (
          <a key={i} href={href} rel="noopener noreferrer nofollow">
            {inline(link.tokens, depth + 1)}
          </a>
        )
      }
      case 'image':
        return <Fragment key={i}>{decode((token as Tokens.Image).text)}</Fragment>
      default:
        // Inline HTML (a tag such as <b> or <script>) is dropped. Nothing is passed through.
        return null
    }
  })
}

/** The page has one h1 and h2 sections, so the document's top heading level becomes h3 and the rest follow, down to h6. */
const HEADINGS = ['h3', 'h4', 'h5', 'h6'] as const

function blocks(tokens: Token[], top: number, depth: number): ReactNode {
  return tokens.map((token, i) => {
    if (depth > MAX_DEPTH) return <p key={i}>{token.raw}</p>
    switch (token.type) {
      case 'heading': {
        const h = token as Tokens.Heading
        const Tag = HEADINGS[Math.max(0, Math.min(h.depth - top, HEADINGS.length - 1))]!
        return <Tag key={i}>{inline(h.tokens, depth + 1)}</Tag>
      }
      case 'paragraph':
        return <p key={i}>{inline((token as Tokens.Paragraph).tokens, depth + 1)}</p>
      case 'checkbox':
        // A task-list item's box is text, not a form control.
        return <Fragment key={i}>{(token as Tokens.Checkbox).checked ? '[x] ' : '[ ] '}</Fragment>
      case 'text':
        // A bare text block inside a list item or quote.
        return <Fragment key={i}>{inline([token], depth + 1)}</Fragment>
      case 'list': {
        const list = token as Tokens.List
        const Tag = list.ordered ? 'ol' : 'ul'
        return (
          <Tag key={i} {...(list.ordered && list.start !== '' ? { start: list.start } : {})}>
            {list.items.map((item, j) => (
              <li key={j}>{blocks(item.tokens, top, depth + 1)}</li>
            ))}
          </Tag>
        )
      }
      case 'blockquote':
        return <blockquote key={i}>{blocks((token as Tokens.Blockquote).tokens, top, depth + 1)}</blockquote>
      case 'code':
        return (
          <pre key={i}>
            <code>{(token as Tokens.Code).text}</code>
          </pre>
        )
      case 'hr':
        return <hr key={i} />
      case 'html': {
        // A block such as <details> keeps its inner text, as plain text; its tags are dropped.
        const text = htmlText((token as Tokens.HTML).raw)
        return text.trim() === '' ? null : <Fragment key={i}>{plain(text)}</Fragment>
      }
      case 'space':
      case 'def':
        // Raw HTML definitions are dropped. Nothing is passed through.
        return null
      default:
        // Anything else (a table, for one) is shown as the text it was written as.
        return <p key={i}>{token.raw}</p>
    }
  })
}

/**
 * Markdown from the pipeline or from other people in the meeting, as React elements. There is no raw HTML: HTML tags
 * are dropped and everything else is built as elements, which React escapes. A link keeps only when it is `https:`
 * with no credentials; images become their alt text. `dropTitle` leaves out a first `# title` line the page already shows.
 *
 * The input is bounded before the lexer sees it: at most 200 KB, nesting no deeper than 20, and no flood of emphasis
 * markers. A document beyond those limits, or one that fails to lex, is shown as plain text instead of failing the
 * page. That fallback is deliberate; React escapes the text.
 */
export function Markdown({ md, dropTitle = false }: { md: string; dropTitle?: boolean }) {
  const { text, truncated } = truncate(md, MAX_BYTES)
  if (truncated || tooDeep(text) || emphasisFlood(text)) {
    return (
      <div className="markdown">
        {plain(text)}
        {truncated && <p>{TOO_LONG}</p>}
      </div>
    )
  }
  try {
    const tokens = marked.lexer(text)
    const shown =
      dropTitle && tokens[0]?.type === 'heading' && (tokens[0] as Tokens.Heading).depth === 1 ? tokens.slice(1) : tokens
    const top = Math.min(6, ...shown.filter((t): t is Tokens.Heading => t.type === 'heading').map((h) => h.depth))
    return <div className="markdown">{blocks(shown, top, 0)}</div>
  } catch {
    return <div className="markdown">{plain(text)}</div>
  }
}
