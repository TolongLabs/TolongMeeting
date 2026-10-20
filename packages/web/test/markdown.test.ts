import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from '../components/Markdown'

const html = (md: string, dropTitle = false) => renderToStaticMarkup(createElement(Markdown, { md, dropTitle }))

test('ordinary Markdown still renders as elements', () => {
  const out = html('# Title\n\nSome **bold** and [a link](https://ok.example/a).')
  expect(out).toContain('<h3>Title</h3>')
  expect(out).toContain('<strong>bold</strong>')
  expect(out).toContain('<a href="https://ok.example/a" rel="noopener noreferrer nofollow">a link</a>')
})

test('a task-list item shows its box as text, not as a form control', () => {
  const out = html('- [x] done\n- [ ] todo')
  expect(out).toContain('[x] done')
  expect(out).toContain('[ ] todo')
  expect(out).not.toContain('<input')
})

test('a block of HTML keeps its inner text and drops its tags', () => {
  const out = html('<details>\n<summary>More</summary>\nhidden text\n</details>')
  expect(out).toContain('More')
  expect(out).toContain('hidden text')
  expect(out).not.toContain('<details')
  expect(out).not.toContain('<summary')
})

test('raw HTML never reaches the page', () => {
  const out = html('<script>alert(1)</script> <img src=x onerror=alert(1)>')
  expect(out).not.toContain('<script')
  expect(out).not.toContain('<img')
})

test('a link with a bidirectional override loses only its link', () => {
  const out = html('[text](https://ok.example/\u202Eevil)')
  expect(out).toContain('text')
  expect(out).not.toContain('<a')
})

test('a file over 200 KB shows its start as plain text and says the rest is hidden', () => {
  const out = html(`${'a'.repeat(200 * 1024)}z`)
  expect(out).toContain('The rest of this file is too long to show here.')
  expect(out).not.toContain('z')
  expect(out).toContain('a'.repeat(100))
  expect(out).not.toContain('<h3>')
})

test('12,000 nested quotes are refused as plain text instead of overflowing the stack', () => {
  const out = html(`${'>'.repeat(12000)} x`)
  expect(out).not.toContain('<blockquote')
  expect(out).toContain('x')
})

test('deep list indentation is refused as plain text', () => {
  const md = Array.from({ length: 30 }, (_, i) => `${'  '.repeat(i)}- item`).join('\n')
  const out = html(md)
  expect(out).not.toContain('<ul')
  expect(out).toContain('- item')
})

test('nesting of 20 levels is still rendered as Markdown', () => {
  const out = html(`${'> '.repeat(20)}deep`)
  expect(out).toContain('<blockquote>')
  expect(out).toContain('deep')
})

test('60 KB of single emphasis markers renders in under a second', () => {
  const md = '*a '.repeat(20000)
  const start = performance.now()
  const out = html(md)
  const elapsed = performance.now() - start
  expect(out).toContain('*a *a')
  expect(elapsed).toBeLessThan(1000)
})

test('dropTitle still leaves out the page title', () => {
  const out = html('# Already shown\n\nbody', true)
  expect(out).not.toContain('Already shown')
  expect(out).toContain('body')
})
