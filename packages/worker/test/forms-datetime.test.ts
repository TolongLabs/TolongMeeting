import { expect, test } from 'bun:test'
import { clockTime, formatDate, isoDate, joinTime, parseDate, parseDateFormat } from '../src/forms/datetime'

const format = (placeholder: string) => parseDateFormat(placeholder)!

test('a date format is read from the placeholder', () => {
  expect(format('Please input date (M/d/yyyy)')).toEqual({
    fields: ['M', 'd', 'y'],
    padded: { M: false, d: false },
    separator: '/'
  })
  expect(format('dd/MM/yyyy').padded).toEqual({ M: true, d: true })
  expect(format('yyyy-MM-dd').fields).toEqual(['y', 'M', 'd'])
  expect(format('d.M.yyyy').separator).toBe('.')
})

test('a placeholder that does not name year, month and day once is no format', () => {
  for (const placeholder of ['Pick a date', '', 'dd/dd/yyyy', 'MM/yyyy', 'dd-MM/yyyy', 'yy/MM/dd'])
    expect(parseDateFormat(placeholder)).toBeNull()
})

test('a date is written the way the widget expects and read back to ISO', () => {
  const us = format('M/d/yyyy')
  const eu = format('dd/MM/yyyy')
  expect(formatDate('2026-03-04', us)).toBe('3/4/2026')
  expect(formatDate('2026-03-04', eu)).toBe('04/03/2026')
  expect(formatDate('2026-03-04', format('yyyy-MM-dd'))).toBe('2026-03-04')
  expect(parseDate('3/4/2026', us)).toBe('2026-03-04')
  expect(parseDate('04/03/2026', eu)).toBe('2026-03-04')
  // The same text means another day in the other order: only the widget's own format reads it right.
  expect(parseDate('04/03/2026', us)).toBe('2026-04-03')
})

test('text that is not a real date in the format reads as null', () => {
  const us = format('M/d/yyyy')
  for (const text of ['', '20/10/2026', '2/30/2026', '1/1/26', '1/1', '1/1/2026/1', 'a/b/cccc', '1-1-2026'])
    expect(parseDate(text, us)).toBeNull()
})

test('formatDate refuses a value that is not a calendar day', () => {
  expect(() => formatDate('2026-02-30', format('M/d/yyyy'))).toThrow('not a calendar date')
  expect(() => formatDate('20/10/2026', format('M/d/yyyy'))).toThrow('not a calendar date')
})

test('iso dates and clock times are checked as real values', () => {
  expect(isoDate('2024-02-29')).toBe('2024-02-29')
  expect(isoDate('2026-02-29')).toBeNull()
  expect(isoDate('2026-2-9')).toBeNull()
  expect(clockTime('23:59')).toBe('23:59')
  expect(clockTime('24:00')).toBeNull()
  expect(clockTime('8:00')).toBeNull()
  expect(joinTime('8', '5')).toBe('08:05')
  expect(joinTime('20', '00')).toBe('20:00')
  expect(joinTime('25', '00')).toBeNull()
  expect(joinTime('', '00')).toBeNull()
  expect(joinTime('ab', '00')).toBeNull()
})
