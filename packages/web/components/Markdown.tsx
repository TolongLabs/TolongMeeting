import { Fragment, type ReactNode } from 'react'
import { marked, type Token, type Tokens } from 'marked'

/** An https link without credentials or control characters, else null. The text stays; only the link goes. */
function safeHref(href: string): string | null {
  if (!/^https:\/\//i.test(href) || /[\u0000- \u007f-\u009f\\]/.test(href)) return null
  if (!URL.canParse(href)) return null
  const url = new URL(href)
  return url.username === '' && url.password === '' && url.hostname !== '' ? href : null
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

/** marked leaves character references in text tokens. React escapes the output, so the characters are safe to show. */
function decode(text: string): string {
  return text.replace(/&(#39|amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => ENTITIES[name]!)
}

function inline(tokens: Token[] | undefined): ReactNode {
  return (tokens ?? []).map((token, i) => {
    switch (token.type) {
      case 'text': {
        const t = token as Tokens.Text
        return <Fragment key={i}>{t.tokens ? inline(t.tokens) : decode(t.text)}</Fragment>
      }
      case 'escape':
        return <Fragment key={i}>{(token as Tokens.Escape).text}</Fragment>
      case 'strong':
        return <strong key={i}>{inline((token as Tokens.Strong).tokens)}</strong>
      case 'em':
        return <em key={i}>{inline((token as Tokens.Em).tokens)}</em>
      case 'del':
        return <del key={i}>{inline((token as Tokens.Del).tokens)}</del>
      case 'codespan':
        return <code key={i}>{decode((token as Tokens.Codespan).text)}</code>
      case 'br':
        return <br key={i} />
      case 'link': {
        const link = token as Tokens.Link
        const href = safeHref(link.href)
        // The link text stays; a link that is not a plain https link loses only the link.
        return href === null ? (
          <Fragment key={i}>{inline(link.tokens)}</Fragment>
        ) : (
          <a key={i} href={href} rel="noopener noreferrer nofollow">
            {inline(link.tokens)}
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

function blocks(tokens: Token[], top: number): ReactNode {
  return tokens.map((token, i) => {
    switch (token.type) {
      case 'heading': {
        const h = token as Tokens.Heading
        const Tag = HEADINGS[Math.max(0, Math.min(h.depth - top, HEADINGS.length - 1))]!
        return <Tag key={i}>{inline(h.tokens)}</Tag>
      }
      case 'paragraph':
        return <p key={i}>{inline((token as Tokens.Paragraph).tokens)}</p>
      case 'text':
        // A bare text block inside a list item or quote.
        return <Fragment key={i}>{inline([token])}</Fragment>
      case 'list': {
        const list = token as Tokens.List
        const Tag = list.ordered ? 'ol' : 'ul'
        return (
          <Tag key={i} {...(list.ordered && list.start !== '' ? { start: list.start } : {})}>
            {list.items.map((item, j) => (
              <li key={j}>{blocks(item.tokens, top)}</li>
            ))}
          </Tag>
        )
      }
      case 'blockquote':
        return <blockquote key={i}>{blocks((token as Tokens.Blockquote).tokens, top)}</blockquote>
      case 'code':
        return (
          <pre key={i}>
            <code>{(token as Tokens.Code).text}</code>
          </pre>
        )
      case 'hr':
        return <hr key={i} />
      case 'space':
      case 'html':
      case 'def':
        // Raw HTML blocks are dropped. Nothing is passed through.
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
 */
export function Markdown({ md, dropTitle = false }: { md: string; dropTitle?: boolean }) {
  const tokens = marked.lexer(md)
  const shown =
    dropTitle && tokens[0]?.type === 'heading' && (tokens[0] as Tokens.Heading).depth === 1 ? tokens.slice(1) : tokens
  const top = Math.min(6, ...shown.filter((t): t is Tokens.Heading => t.type === 'heading').map((h) => h.depth))
  return <div className="markdown">{blocks(shown, top)}</div>
}
