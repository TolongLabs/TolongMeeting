import { afterEach, expect, test } from 'bun:test'
import { unzipSync } from 'fflate'
import sharp from 'sharp'
import { loadBundle } from '../src/bundle'
import { bundleDocument, type DocBlock } from '../src/render/doc'
import { bundleImages, toJpeg } from '../src/render/images'
import { toDocx } from '../src/render/docx'
import { fixture } from './fixture'
import { removeTestContexts } from './context'

afterEach(removeTestContexts)

const text = (files: Record<string, Uint8Array>, name: string) => new TextDecoder().decode(files[name])

test('the Word file holds text, headings, page breaks and images', async () => {
  const b = await loadBundle(fixture)
  const files = unzipSync(await toDocx(bundleDocument(b), await bundleImages(b), b.title))
  const xml = text(files, 'word/document.xml')
  expect(xml).toContain('Submit lab 2 (due 27 October 2026, 23:59)')
  expect(xml).toContain('<w:pStyle w:val="Heading1"/>')
  expect(xml.match(/<w:pageBreakBefore\/>/g)).toHaveLength(3)
  expect(Object.keys(files).filter((k) => /^word\/media\/.+\.jpg$/.test(k))).toHaveLength(2)
  expect(text(files, 'docProps/core.xml')).toContain('2026-10-20 1400 Data Mining')
})

test('every relationship is local, an https hyperlink or an embedded image', async () => {
  const b = await loadBundle(fixture)
  const doc: DocBlock[] = [
    ...bundleDocument(b),
    {
      kind: 'paragraph',
      runs: [
        { text: 'safe', href: 'https://example.com/a?b=1&c=2' },
        { text: 'unsafe', href: 'javascript:alert(1)' },
        { text: 'plain', href: 'http://example.com/' },
        { text: 'data', href: 'data:text/html,hi' }
      ]
    },
    { kind: 'image', path: 'https://evil.example/x.png', alt: 'remote image' }
  ]
  const files = unzipSync(await toDocx(doc, await bundleImages(b), b.title))
  const rels = Object.entries(files)
    .filter(([name]) => name.endsWith('.rels'))
    .map(([, bytes]) => new TextDecoder().decode(bytes))
    .join('\n')
  const targets = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0])
  const external = targets.filter((t) => t.includes('TargetMode="External"'))
  expect(external).toHaveLength(1)
  expect(external[0]).toContain('Target="https://example.com/a?b=1&amp;c=2"')
  for (const t of targets.filter((t) => !t.includes('TargetMode="External"')))
    expect(t).toMatch(/Target="(?!https?:|data:|javascript:|file:|\/\/)[^"]+"/)
  const xml = text(files, 'word/document.xml')
  for (const s of ['safe', 'unsafe', 'plain', 'data', 'remote image']) expect(xml).toContain(s)
  expect(xml).not.toContain('evil.example')
})

test('lists, tables, code, rules and a break before a table or missing image', async () => {
  const doc: DocBlock[] = [
    { kind: 'paragraph', runs: [{ text: 'first' }] },
    { kind: 'break' },
    { kind: 'table', header: [[{ text: 'h1' }], [{ text: 'h2' }]], rows: [[[{ text: 'a' }], []]] },
    { kind: 'list', ordered: true, items: [[{ text: 'one' }], [{ text: 'two', italic: true }]] },
    { kind: 'list', ordered: true, items: [[{ text: 'again' }]] },
    { kind: 'list', ordered: false, items: [[{ text: 'dot', code: true }]] },
    { kind: 'code', text: 'x = 1\ny = 2' },
    { kind: 'rule' },
    { kind: 'break' },
    { kind: 'image', path: 'slides/09.webp', alt: 'missing slide' },
    { kind: 'paragraph', runs: [{ text: 'line1\nline2 😀 日本', bold: true }] }
  ]
  const files = unzipSync(await toDocx(doc, new Map(), 'T'))
  const xml = text(files, 'word/document.xml')
  expect(xml.match(/<w:pageBreakBefore\/>/g)).toHaveLength(2)
  expect(xml).toContain('<w:tbl>')
  expect(xml.match(/<w:tblHeader\/>/g)).toHaveLength(1)
  for (const s of ['h2', 'one', 'again', 'dot', 'x = 1', 'y = 2', 'missing slide', 'line2 😀 日本'])
    expect(xml).toContain(s)
  expect(text(files, 'word/numbering.xml')).toContain('w:numId')
  expect(text(files, 'docProps/core.xml')).toContain('<dc:title>T</dc:title>')
})

test('a large slide is embedded at 600 px wide at most', async () => {
  const big = await toJpeg(
    await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#fff' } })
      .webp()
      .toBuffer()
  )
  const files = unzipSync(
    await toDocx([{ kind: 'image', path: 'slides/01.webp', alt: 'big' }], new Map([['slides/01.webp', big]]), 'T')
  )
  expect(text(files, 'word/document.xml')).toMatch(/<wp:extent cx="5715000" cy="2857500"\/>/)
})

test('a renderer failure becomes a fixed ExportError', async () => {
  const broken = { kind: 'paragraph', runs: undefined } as unknown as DocBlock
  const error = await toDocx([broken], new Map(), 'secret meeting words').catch((e: unknown) => e)
  expect(error).toMatchObject({
    name: 'ExportError',
    code: 'failed',
    message: 'The meeting could not be turned into a file.'
  })
})
