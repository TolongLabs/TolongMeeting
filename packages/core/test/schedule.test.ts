import { describe, expect, test } from 'bun:test'
import { expandEntry, findClashes, formatDay, formatWhen, RepeatRuleSchema } from '../src'

const now = new Date('2026-10-20T00:00:00Z')

describe('expandEntry', () => {
  test('a weekly entry expands 14 days ahead in the member time zone', () => {
    const slots = expandEntry(
      { repeat: { kind: 'weekly', days: [1, 3], from: '2026-10-01' }, startTime: '14:00', endTime: '16:00' },
      'Asia/Kuala_Lumpur',
      now
    )
    expect(slots.map((s) => s.start.toISOString())).toEqual([
      '2026-10-21T06:00:00.000Z',
      '2026-10-26T06:00:00.000Z',
      '2026-10-28T06:00:00.000Z',
      '2026-11-02T06:00:00.000Z'
    ])
    expect(slots[0]!.end.toISOString()).toBe('2026-10-21T08:00:00.000Z')
  })

  test('expansion keeps local time across a daylight-saving change', () => {
    const slots = expandEntry(
      { repeat: { kind: 'weekly', days: [1], from: '2026-10-19' }, startTime: '10:00', endTime: '11:00' },
      'Europe/London',
      new Date('2026-10-18T00:00:00Z')
    )
    expect(slots.map((s) => s.start.toISOString())).toEqual(['2026-10-19T09:00:00.000Z', '2026-10-26T10:00:00.000Z'])
  })

  test('an end before the start is on the next day', () => {
    const [s] = expandEntry(
      { repeat: { kind: 'once', date: '2026-10-23' }, startTime: '23:00', endTime: '01:00' },
      'Asia/Kuala_Lumpur',
      now
    )
    expect([s!.start.toISOString(), s!.end.toISOString()]).toEqual([
      '2026-10-23T15:00:00.000Z',
      '2026-10-23T17:00:00.000Z'
    ])
  })

  test('past and out-of-horizon slots are left out', () => {
    const once = (date: string) =>
      expandEntry({ repeat: { kind: 'once', date }, startTime: '10:00', endTime: '11:00' }, 'Asia/Kuala_Lumpur', now)
    expect(once('2026-10-19')).toEqual([])
    expect(once('2026-11-03')).toEqual([])
  })

  test('a weekly entry does not start before its from date', () => {
    const slots = expandEntry(
      { repeat: { kind: 'weekly', days: [1, 3], from: '2026-10-27' }, startTime: '14:00', endTime: '16:00' },
      'Asia/Kuala_Lumpur',
      now
    )
    expect(slots.map((s) => s.start.toISOString())).toEqual(['2026-10-28T06:00:00.000Z', '2026-11-02T06:00:00.000Z'])
  })

  test('the time zone decides the day: a Monday 00:30 in Kuala Lumpur is still Sunday in UTC', () => {
    const slots = expandEntry(
      { repeat: { kind: 'once', date: '2026-10-26' }, startTime: '00:30', endTime: '01:30' },
      'Asia/Kuala_Lumpur',
      now
    )
    expect(slots.map((s) => s.start.toISOString())).toEqual(['2026-10-25T16:30:00.000Z'])
  })

  test('a time in the spring-forward gap shifts forward by the gap length, and an overlap uses the first occurrence', () => {
    const run = (date: string, zone: string, startTime: string) =>
      expandEntry(
        { repeat: { kind: 'once', date }, startTime, endTime: '23:00' },
        zone,
        new Date('2026-03-25T00:00:00Z')
      )
    // London: 01:30 on 29 Mar 2026 does not exist (01:00 -> 02:00), so it becomes 02:30 BST.
    expect(run('2026-03-29', 'Europe/London', '01:30').map((s) => s.start.toISOString())).toEqual([
      '2026-03-29T01:30:00.000Z'
    ])
    // New York: 01:30 on 1 Nov 2026 happens twice; the first (EDT, UTC-4) is used.
    const fall = expandEntry(
      { repeat: { kind: 'once', date: '2026-11-01' }, startTime: '01:30', endTime: '03:00' },
      'America/New_York',
      new Date('2026-10-25T00:00:00Z')
    )
    expect(fall.map((s) => s.start.toISOString())).toEqual(['2026-11-01T05:30:00.000Z'])
  })

  test('a slot whose start is moved by a gap keeps its length instead of becoming 24 hours', () => {
    const hours = (date: string, zone: string, startTime: string, endTime: string, from: string) => {
      const [s] = expandEntry({ repeat: { kind: 'once', date }, startTime, endTime }, zone, new Date(from))
      return [s!.start.toISOString(), s!.end.toISOString(), (s!.end.getTime() - s!.start.getTime()) / 3_600_000]
    }
    // London 29 Mar 2026: 01:30 -> 02:30 BST (01:30Z), the end 02:30 BST is the same instant, so it moves to 03:30 BST.
    expect(hours('2026-03-29', 'Europe/London', '01:30', '02:30', '2026-03-25T00:00:00Z')).toEqual([
      '2026-03-29T01:30:00.000Z',
      '2026-03-29T02:30:00.000Z',
      1
    ])
    // New York 8 Mar 2026: 02:30 -> 03:30 EDT (07:30Z), the end 03:30 EDT is the same instant, so it moves to 04:30 EDT.
    expect(hours('2026-03-08', 'America/New_York', '02:30', '03:30', '2026-03-04T00:00:00Z')).toEqual([
      '2026-03-08T07:30:00.000Z',
      '2026-03-08T08:30:00.000Z',
      1
    ])
  })

  test('on a fall-back day the slot runs over the repeated hour', () => {
    const one = (date: string, zone: string, from: string) =>
      expandEntry({ repeat: { kind: 'once', date }, startTime: '01:30', endTime: '02:30' }, zone, new Date(from))[0]!
    // London 25 Oct 2026: 01:30 BST (00:30Z) to 02:30 GMT (02:30Z).
    const london = one('2026-10-25', 'Europe/London', '2026-10-21T00:00:00Z')
    expect([london.start.toISOString(), london.end.toISOString()]).toEqual([
      '2026-10-25T00:30:00.000Z',
      '2026-10-25T02:30:00.000Z'
    ])
    // New York 1 Nov 2026: 01:30 EDT (05:30Z) to 02:30 EST (07:30Z).
    const ny = one('2026-11-01', 'America/New_York', '2026-10-28T00:00:00Z')
    expect([ny.start.toISOString(), ny.end.toISOString()]).toEqual([
      '2026-11-01T05:30:00.000Z',
      '2026-11-01T07:30:00.000Z'
    ])
  })

  test('daily slots around a clock change never overlap each other', () => {
    const cases = [
      ['Europe/London', '2026-03-27T00:00:00Z'],
      ['America/New_York', '2026-03-06T00:00:00Z'],
      ['Europe/London', '2026-10-23T00:00:00Z'],
      ['America/New_York', '2026-10-30T00:00:00Z']
    ] as const
    for (const [zone, from] of cases) {
      const slots = expandEntry(
        {
          repeat: { kind: 'weekly', days: [1, 2, 3, 4, 5, 6, 7], from: '2026-01-01' },
          startTime: '01:30',
          endTime: '02:30'
        },
        zone,
        new Date(from)
      ).map((s, i) => ({ id: String(i), ...s, rank: i }))
      expect(slots.length).toBeGreaterThan(10)
      expect(findClashes(slots)).toEqual([])
      for (const s of slots) expect(s.end.getTime() - s.start.getTime()).toBeLessThanOrEqual(2 * 3_600_000)
    }
  })

  test('times with seconds, as Postgres returns them, are accepted', () => {
    const [s] = expandEntry(
      { repeat: { kind: 'once', date: '2026-10-21' }, startTime: '14:00:00', endTime: '16:00:00' },
      'Asia/Kuala_Lumpur',
      now
    )
    expect(s!.start.toISOString()).toBe('2026-10-21T06:00:00.000Z')
  })

  test('an unknown time zone or a malformed time throws', () => {
    const entry = { repeat: { kind: 'once', date: '2026-10-21' }, startTime: '14:00', endTime: '16:00' } as const
    expect(() => expandEntry(entry, 'Mars/Olympus', now)).toThrow()
    expect(() => expandEntry({ ...entry, startTime: '25:00' }, 'Asia/Kuala_Lumpur', now)).toThrow()
  })
})

describe('findClashes', () => {
  const t = (h: number) => new Date(Date.UTC(2026, 9, 21, h))

  test('the earlier start wins a clash, ties go to the older entry, touching slots do not clash', () => {
    expect(
      findClashes([
        { id: 'b', start: t(7), end: t(9), rank: 1 },
        { id: 'a', start: t(6), end: t(8), rank: 2 }
      ])
    ).toEqual([{ winner: 'a', loser: 'b' }])
    expect(
      findClashes([
        { id: 'x', start: t(6), end: t(8), rank: 2 },
        { id: 'y', start: t(6), end: t(8), rank: 1 }
      ])
    ).toEqual([{ winner: 'y', loser: 'x' }])
    expect(
      findClashes([
        { id: 'p', start: t(6), end: t(8), rank: 1 },
        { id: 'q', start: t(8), end: t(10), rank: 2 }
      ])
    ).toEqual([])
  })

  test('every overlapping pair is reported', () => {
    expect(
      findClashes([
        { id: 'a', start: t(6), end: t(12), rank: 1 },
        { id: 'b', start: t(7), end: t(8), rank: 2 },
        { id: 'c', start: t(9), end: t(10), rank: 3 }
      ])
    ).toEqual([
      { winner: 'a', loser: 'b' },
      { winner: 'a', loser: 'c' }
    ])
  })
})

test('times are shown in the member time zone', () => {
  expect(formatWhen(new Date('2026-10-21T06:00:00Z'), 'Asia/Kuala_Lumpur')).toBe('Wed 21 Oct, 14:00')
  expect(formatDay(new Date('2026-11-20T08:00:00Z'), 'Asia/Kuala_Lumpur')).toBe('Fri 20 Nov')
})

test('months are always three letters, September included', () => {
  expect(formatWhen(new Date('2026-09-09T06:00:00Z'), 'Asia/Kuala_Lumpur')).toBe('Wed 9 Sep, 14:00')
  expect(formatDay(new Date('2026-09-09T06:00:00Z'), 'Asia/Kuala_Lumpur')).toBe('Wed 9 Sep')
})

describe('RepeatRuleSchema', () => {
  test('accepts the two rule kinds', () => {
    expect(RepeatRuleSchema.parse({ kind: 'once', date: '2026-10-21' })).toEqual({ kind: 'once', date: '2026-10-21' })
    expect(RepeatRuleSchema.parse({ kind: 'weekly', days: [1, 3], from: '2026-10-01' }).kind).toBe('weekly')
  })

  test('rejects bad dates, weekdays and empty day lists', () => {
    expect(RepeatRuleSchema.safeParse({ kind: 'once', date: '21/10/2026' }).success).toBe(false)
    expect(RepeatRuleSchema.safeParse({ kind: 'once', date: '2026-02-30' }).success).toBe(false)
    expect(RepeatRuleSchema.safeParse({ kind: 'weekly', days: [8], from: '2026-10-01' }).success).toBe(false)
    expect(RepeatRuleSchema.safeParse({ kind: 'weekly', days: [], from: '2026-10-01' }).success).toBe(false)
  })
})
