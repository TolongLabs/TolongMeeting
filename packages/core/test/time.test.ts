import { test, expect } from 'bun:test'
import { formatOffset, localParts } from '../src/time'

test('offsets and local parts', () => {
  expect(formatOffset(3_723_400)).toBe('01:02:03')
  expect(localParts('2026-10-21T12:00:00Z', 'Asia/Kuala_Lumpur')).toEqual({
    date: '2026-10-21',
    hhmm: '2000',
    hhmmss: '200000',
    weekday: 'Wed',
    dayMonthYear: '21 Oct 2026'
  })
})
