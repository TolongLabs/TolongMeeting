import { expect, test } from 'bun:test'
import { contentDisposition, slugify } from '../src/names'

test('slugify', () => {
  expect(slugify('2026-10-20 1400 Data Mining: Week 3 / Lab?')).toBe('2026-10-20-1400-data-mining-week-3-lab')
  expect(slugify('2026-10-20 0900 Pengurusan Café')).toBe('2026-10-20-0900-pengurusan-cafe')
  expect(slugify('???')).toBe('meeting')
  const long = slugify('2026-10-20 0900 ' + 'Kursus Lanjutan '.repeat(10))
  expect(long.length).toBeLessThanOrEqual(80)
  expect(long.endsWith('-')).toBe(false)
})

test('contentDisposition', () => {
  expect(contentDisposition('2026-10-20 1400 Pengurusan Café.zip')).toBe(
    `attachment; filename="2026-10-20 1400 Pengurusan Caf_.zip"; filename*=UTF-8''2026-10-20%201400%20Pengurusan%20Caf%C3%A9.zip`
  )
  expect(contentDisposition('a "b".pdf')).toBe(`attachment; filename="a _b_.pdf"; filename*=UTF-8''a%20%22b%22.pdf`)
})

test('contentDisposition encodes the characters encodeURIComponent leaves alone', () => {
  expect(contentDisposition("it's (a) *test*.zip")).toBe(
    `attachment; filename="it's (a) *test*.zip"; filename*=UTF-8''it%27s%20%28a%29%20%2Atest%2A.zip`
  )
})
