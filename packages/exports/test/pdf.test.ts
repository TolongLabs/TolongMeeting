import { afterEach, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { extractText, getDocumentProxy } from 'unpdf'
import { loadBundle } from '../src/bundle'
import { bundleDocument, type DocBlock } from '../src/render/doc'
import { bundleImages } from '../src/render/images'
import { pdfTarget, renderPdf } from '../src/targets/pdf'
import { fixture } from './fixture'
import { removeTestContexts, testContext } from './context'

afterEach(removeTestContexts)

async function textOf(pdf: Uint8Array) {
  return extractText(await getDocumentProxy(pdf), { mergePages: true })
}

test('the PDF holds every section, slides and symbols', async () => {
  const b = await loadBundle(fixture)
  const pdf = await renderPdf(bundleDocument(b), await bundleImages(b), b.title)
  expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe('%PDF-')
  const { totalPages, text } = await textOf(pdf)
  expect(totalPages).toBeGreaterThanOrEqual(4)
  for (const s of ['Do next: Submit lab 2', '✓', 'Slide 01: Welcome', 'Good afternoon, everyone.', 'see you next week'])
    expect(text).toContain(s)
})

test('a break starts a new page, and blocks without glyphs do not fail', async () => {
  const doc: DocBlock[] = [
    { kind: 'paragraph', runs: [{ text: 'first' }] },
    { kind: 'break' },
    {
      kind: 'paragraph',
      runs: [
        { text: 'second 😀 日本', bold: true },
        { text: ' link', href: 'https://example.com/x' }
      ]
    },
    { kind: 'code', text: 'x = 1' },
    { kind: 'rule' },
    { kind: 'list', ordered: true, items: [[{ text: 'one' }], [{ text: 'two', italic: true }]] },
    { kind: 'table', header: [[{ text: 'h1' }], [{ text: 'h2' }]], rows: [[[{ text: 'a' }], []]] },
    { kind: 'image', path: 'slides/09.webp', alt: 'missing slide' }
  ]
  const pdf = await renderPdf(doc, new Map(), 'T')
  const proxy = await getDocumentProxy(pdf)
  expect(proxy.numPages).toBe(2)
  const { text } = await extractText(proxy, { mergePages: true })
  for (const s of ['first', 'second', 'x = 1', 'h2', 'missing slide']) expect(text).toContain(s)
  expect((await proxy.getMetadata()).info).toMatchObject({ Title: 'T' })
})

test('pdfTarget writes <exportId>.pdf', async () => {
  const ctx = testContext({ exportId: 'exp-2' })
  const result = await pdfTarget.run(await loadBundle(fixture), ctx)
  expect(result.filePath).toBe(join(ctx.outDir, 'exp-2.pdf'))
  expect(new TextDecoder().decode((await readFile(result.filePath!)).subarray(0, 5))).toBe('%PDF-')
})
