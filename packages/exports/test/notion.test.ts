import { expect, test } from 'bun:test'
import { loadBundle } from '../src/bundle'
import { bundleDocument, parseMarkdown, type DocBlock, type Run } from '../src/render/doc'
import { chunkBlocks, toNotionBlocks } from '../src/render/notion'
import { fixture } from './fixture'

/* eslint-disable @typescript-eslint/no-explicit-any */
const render = (doc: DocBlock[], uploads = new Map<string, string>()) => toNotionBlocks(doc, uploads) as any[]
const para = (runs: Run[]): DocBlock => ({ kind: 'paragraph', runs })

test('long text is split at 2,000 characters', () => {
  const [p] = render([para([{ text: 'a'.repeat(4500) }])])
  expect(p.paragraph.rich_text.map((t: any) => t.text.content.length)).toEqual([2000, 2000, 500])
})

test('a split never cuts a surrogate pair', () => {
  const [p] = render([para([{ text: 'a'.repeat(1999) + '😀' + 'b' }])])
  const parts = p.paragraph.rich_text.map((t: any) => t.text.content)
  expect(parts).toEqual(['a'.repeat(1999), '😀b'])
})

test('more than 100 rich text items make more blocks', () => {
  const runs = Array.from({ length: 250 }, (_, i) => ({ text: `w${i} `, bold: i % 2 === 0 }))
  const blocks = render([{ kind: 'heading', level: 3, runs }])
  expect(blocks.map((b) => b.type)).toEqual(['heading_3', 'heading_3', 'heading_3'])
  expect(blocks.map((b) => b.heading_3.rich_text.length)).toEqual([100, 100, 50])
})

test('maps headings, lists, images, tables and breaks', () => {
  const blocks = render(
    [
      { kind: 'heading', level: 2, runs: [{ text: 'Slide 01: Welcome' }] },
      { kind: 'image', path: 'slides/01.webp', alt: 'Slide 01: Welcome' },
      { kind: 'list', ordered: true, items: [[{ text: 'one' }], [{ text: 'two' }]] },
      { kind: 'table', header: [[{ text: 'a' }]], rows: [[[{ text: '1' }]]] },
      { kind: 'break' }
    ],
    new Map([['slides/01.webp', 'UP1']])
  )
  expect(blocks.map((b) => b.type)).toEqual([
    'heading_2',
    'image',
    'numbered_list_item',
    'numbered_list_item',
    'table',
    'divider'
  ])
  expect(blocks[1].image).toEqual({
    type: 'file_upload',
    file_upload: { id: 'UP1' },
    caption: [
      {
        type: 'text',
        text: { content: 'Slide 01: Welcome', link: null },
        annotations: { bold: false, italic: false, code: false }
      }
    ]
  })
  expect(blocks[4].table).toMatchObject({ table_width: 1, has_column_header: true })
  expect(blocks[4].table.children.map((r: any) => r.type)).toEqual(['table_row', 'table_row'])
})

test('maps bullets, code and rules', () => {
  const blocks = render([
    { kind: 'list', ordered: false, items: [[{ text: 'x', code: true, italic: true }]] },
    { kind: 'code', text: 'a <b>' },
    { kind: 'rule' }
  ])
  expect(blocks.map((b) => b.type)).toEqual(['bulleted_list_item', 'code', 'divider'])
  expect(blocks[0].bulleted_list_item.rich_text[0].annotations).toEqual({ bold: false, italic: true, code: true })
  expect(blocks[1].code).toMatchObject({ language: 'plain text', rich_text: [{ text: { content: 'a <b>' } }] })
})

test('long code is split into text objects and then blocks', () => {
  const blocks = render([{ kind: 'code', text: 'x'.repeat(2000 * 101) }])
  expect(blocks.map((b) => b.code.rich_text.length)).toEqual([100, 1])
})

test('tables over 99 body rows split into tables that repeat the header', () => {
  const rows = Array.from({ length: 200 }, (_, i) => [[{ text: `r${i}` }]])
  const tables = render([{ kind: 'table', header: [[{ text: 'h' }]], rows }])
  expect(tables.map((t) => t.table.children.length)).toEqual([100, 100, 3])
  for (const t of tables) expect(t.table.children[0].table_row.cells[0][0].text.content).toBe('h')
})

test('short table rows are padded to the header width', () => {
  const [t] = render([{ kind: 'table', header: [[{ text: 'a' }], [{ text: 'b' }]], rows: [[[{ text: '1' }]]] }])
  expect(t.table.children[1].table_row.cells).toHaveLength(2)
  expect(t.table.children[1].table_row.cells[1]).toEqual([])
})

test('only https links reach Notion', () => {
  const link = (href: string) =>
    (render([para([{ text: 'x', href }])])[0].paragraph.rich_text[0].text.link as unknown) ?? null
  expect(link('https://example.com/a?b=1')).toEqual({ url: 'https://example.com/a?b=1' })
  for (const bad of [
    'javascript:alert(1)',
    'data:text/html,x',
    'http://example.com',
    '//evil.com',
    'mailto:a@b.c',
    'https://user:pw@example.com/',
    'https://exa mple.com/',
    'https://example.com/\u0007',
    'https://example.com/' + 'a'.repeat(2000)
  ]) {
    expect(link(bad)).toBeNull()
  }
})

test('links split with the text keep their URL on every piece', () => {
  const [p] = render([para([{ text: 'a'.repeat(2500), href: 'https://example.com/' }])])
  expect(p.paragraph.rich_text.map((t: any) => t.text.link)).toEqual([
    { url: 'https://example.com/' },
    { url: 'https://example.com/' }
  ])
})

test('strips control characters from text, code and captions', () => {
  const blocks = render(
    [
      para([{ text: 'a\u0000b\u0085c' }]),
      { kind: 'code', text: 'x\u0007y' },
      { kind: 'image', path: 'slides/01.webp', alt: 'p\u0001q' }
    ],
    new Map([['slides/01.webp', 'U']])
  )
  expect(blocks[0].paragraph.rich_text[0].text.content).toBe('abc')
  expect(blocks[1].code.rich_text[0].text.content).toBe('xy')
  expect(blocks[2].image.caption[0].text.content).toBe('pq')
})

test('an image without an upload, or off the slide path, is its alt text and never a URL', () => {
  const blocks = render(
    [
      { kind: 'image', path: 'slides/02.webp', alt: 'Two' },
      { kind: 'image', path: 'https://evil.example/p.png', alt: 'Tracker' },
      { kind: 'image', path: '../secret.webp', alt: '' }
    ],
    new Map([
      ['https://evil.example/p.png', 'UP'],
      ['../secret.webp', 'UP2']
    ])
  )
  expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph'])
  expect(blocks.map((b) => b.paragraph.rich_text[0].text.content)).toEqual(['Two', 'Tracker'])
  expect(JSON.stringify(blocks)).not.toContain('"external"')
})

test('the fixture bundle renders to blocks with no unsafe URL, raw HTML or external image', async () => {
  const doc = bundleDocument(await loadBundle(fixture))
  const uploads = new Map([
    ['slides/01.webp', 'U1'],
    ['slides/02.webp', 'U2']
  ])
  const blocks = toNotionBlocks(doc, uploads)
  const json = JSON.stringify(blocks)
  expect(blocks.length).toBeGreaterThan(5)
  expect(json).not.toMatch(/javascript:|data:|"external"|<script|<img/i)
  const urls = [...json.matchAll(/"link":\{"url":"([^"]*)"/g)].map((m) => m[1]!)
  for (const url of urls) expect(url).toMatch(/^https:\/\//)
  for (const chunk of chunkBlocks(blocks)) expect(chunk.length).toBeLessThanOrEqual(100)
})

test('Markdown from an untrusted meeting stays inert through both renderers', () => {
  const blocks = toNotionBlocks(
    parseMarkdown(
      '<script>x</script>\n\n[a](javascript:alert(1)) ![t](https://evil.example/p.png) [ok](https://example.com)'
    ),
    new Map()
  )
  expect(JSON.stringify(blocks)).not.toMatch(/javascript:|evil\.example|script/)
  expect(JSON.stringify(blocks)).toContain('https://example.com')
})

test('chunks by count and size', () => {
  expect(
    chunkBlocks(Array.from({ length: 250 }, () => ({ type: 'divider', divider: {} }))).map((c) => c.length)
  ).toEqual([100, 100, 50])
  const big = { type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'x'.repeat(60_000) } }] } }
  expect(chunkBlocks(Array(10).fill(big)).map((c) => c.length)).toEqual([6, 4])
  expect(chunkBlocks([])).toEqual([])
})

test('chunks count table rows toward the 1,000 element limit', () => {
  const [table] = render([
    { kind: 'table', header: [[{ text: 'h' }]], rows: Array.from({ length: 99 }, () => [[{ text: 'c' }]]) }
  ])
  expect(chunkBlocks(Array(25).fill(table)).map((c) => c.length)).toEqual([9, 9, 7])
})
