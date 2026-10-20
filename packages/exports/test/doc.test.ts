import { expect, test } from 'bun:test'
import { loadBundle } from '../src/bundle'
import { bundleDocument, parseMarkdown } from '../src/render/doc'
import { fixture } from './fixture'

test('drops the contents list and anchor links', () => {
  expect(parseMarkdown('# T\n\nContents:\n\n1.  [A](#a)\n1.  [B](#b)\n\n## A\n\nSee [B](#b).')).toEqual([
    { kind: 'heading', level: 1, runs: [{ text: 'T' }] },
    { kind: 'heading', level: 2, runs: [{ text: 'A' }] },
    { kind: 'paragraph', runs: [{ text: 'See B.' }] }
  ])
})

test('keeps bold speaker labels, web links and images', () => {
  expect(parseMarkdown('**[00:00:05] Lecturer:** Hello')[0]).toEqual({
    kind: 'paragraph',
    runs: [{ text: '[00:00:05] Lecturer:', bold: true }, { text: ' Hello' }]
  })
  expect(parseMarkdown('[form](https://example.com/x)')[0]).toEqual({
    kind: 'paragraph',
    runs: [{ text: 'form', href: 'https://example.com/x' }]
  })
  expect(parseMarkdown('![Slide 01: Welcome](slides/01.webp)')[0]).toEqual({
    kind: 'image',
    path: 'slides/01.webp',
    alt: 'Slide 01: Welcome'
  })
})

test('clamps deep headings and parses tables', () => {
  expect(parseMarkdown('#### Deep')[0]).toMatchObject({ kind: 'heading', level: 3 })
  expect(parseMarkdown('| a | b |\n| - | - |\n| 1 | 2 |')[0]).toEqual({
    kind: 'table',
    header: [[{ text: 'a' }], [{ text: 'b' }]],
    rows: [[[{ text: '1' }], [{ text: '2' }]]]
  })
})

test('bundle order is summary, transcript, slides, chat', async () => {
  const doc = bundleDocument(await loadBundle(fixture))
  expect(doc[0]).toEqual({
    kind: 'paragraph',
    runs: [{ text: 'Data Mining, Week 3 (Tuesday 20 October 2026, 14:00 to 16:00)' }]
  })
  expect(doc.filter((b) => b.kind === 'break')).toHaveLength(3)
  expect(doc.filter((b) => b.kind === 'image').map((b) => (b as { path: string }).path)).toEqual([
    'slides/01.webp',
    'slides/02.webp'
  ])
})

test('keeps only https links; other schemes become plain text', () => {
  const runs = (md: string) => (parseMarkdown(md)[0] as { runs: unknown[] }).runs
  expect(
    runs('[a](javascript:alert(1)) [b](data:text/html,x) [c](http://example.com) [d](//evil.com) [e](mailto:x@y.z)')
  ).toEqual([{ text: 'a b c d e' }])
  expect(runs('[u](https://user:pw@example.com/x) [v](HTTPS://example.com/y)')).toEqual([
    { text: 'u ' },
    { text: 'v', href: 'HTTPS://example.com/y' }
  ])
  expect(runs('**[bold](https://example.com)**')).toEqual([{ text: 'bold', bold: true, href: 'https://example.com' }])
})

test('treats raw HTML as nothing and entities as text', () => {
  expect(parseMarkdown('<script>alert(1)</script>\n\n<div onclick="x">hi</div>')).toEqual([])
  expect(parseMarkdown('a <b onclick="x">bold</b> &lt;i&gt; &amp; c')).toEqual([
    { kind: 'paragraph', runs: [{ text: 'a bold <i> & c' }] }
  ])
  expect(parseMarkdown('`<img src=x>`')).toEqual([{ kind: 'paragraph', runs: [{ text: '<img src=x>', code: true }] }])
})

test('images outside the slide folder become alt text', () => {
  expect(parseMarkdown('![tracker](https://evil.example/p.png)')).toEqual([
    { kind: 'paragraph', runs: [{ text: 'tracker' }] }
  ])
  expect(parseMarkdown('![x](../../etc/passwd)\n\n![y](slides/../x.webp)')).toEqual([
    { kind: 'paragraph', runs: [{ text: 'x' }] },
    { kind: 'paragraph', runs: [{ text: 'y' }] }
  ])
  expect(parseMarkdown('see ![Slide](slides/01.webp) here')).toEqual([
    { kind: 'paragraph', runs: [{ text: 'see Slide here' }] }
  ])
})

test('flattens nested lists, emits quotes as paragraphs and keeps code and rules', () => {
  expect(parseMarkdown('- a\n  - b\n- c\n\n1. x\n\n> quoted\n\n---\n\n```\ncode <x>\n```')).toEqual([
    { kind: 'list', ordered: false, items: [[{ text: 'a' }], [{ text: 'b' }], [{ text: 'c' }]] },
    { kind: 'list', ordered: true, items: [[{ text: 'x' }]] },
    { kind: 'paragraph', runs: [{ text: 'quoted' }] },
    { kind: 'rule' },
    { kind: 'code', text: 'code <x>' }
  ])
})

test('strips control characters from text', () => {
  expect(parseMarkdown('a\u0000b\u0007c')).toEqual([{ kind: 'paragraph', runs: [{ text: 'abc' }] }])
})
