import { afterAll, expect, test } from 'bun:test'
import { summaryFileName } from '../src/summary/name'
import { makeOccurrence, removeOccurrence } from './helpers'

const occ = await makeOccurrence()
afterAll(() => removeOccurrence(occ.root))

const entryAt = (patch: Partial<typeof occ.cfg.entry>) => ({ ...occ.cfg, entry: { ...occ.cfg.entry, ...patch } })

test('file name in the entry time zone with unsafe characters replaced', () => {
  expect(
    summaryFileName(
      entryAt({
        start: '2026-10-21T12:00:00Z',
        timeZone: 'Asia/Kuala_Lumpur',
        name: 'Data Mining / Kuliah 5: Pengenalan'
      })
    )
  ).toBe('2026-10-21 2000 Data Mining - Kuliah 5- Pengenalan.md')
})

test('every unsafe character goes, whitespace collapses and the name is cut to 120 characters', () => {
  expect(summaryFileName(entryAt({ name: 'a\\b*c?d"e<f>g|h   i\tj' }))).toBe('2026-10-21 2000 a-b-c-d-e-f-g-h i j.md')
  const long = summaryFileName(entryAt({ name: 'x'.repeat(200) }))
  expect(long).toBe(`2026-10-21 2000 ${'x'.repeat(120)}.md`)
})

test('the date is the local date when the UTC date differs', () => {
  expect(summaryFileName(entryAt({ start: '2026-10-21T23:30:00Z', timeZone: 'Asia/Kuala_Lumpur' }))).toStartWith(
    '2026-10-22 0730 '
  )
})
