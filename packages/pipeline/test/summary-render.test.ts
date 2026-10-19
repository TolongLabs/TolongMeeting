import { afterAll, expect, test } from 'bun:test'
import type { Inventory, InventoryItem } from '../src/summary/inventory'
import { chooseDue, renderLectureSummary } from '../src/summary/render'
import { makeOccurrence, removeOccurrence } from './helpers'

const occ = await makeOccurrence()
afterAll(() => removeOccurrence(occ.root))
const { cfg } = occ

const item = (patch: Partial<InventoryItem>): InventoryItem => ({
  kind: 'task',
  text: 'Do it',
  due: null,
  source: 'slide',
  ref: null,
  conflicts: [],
  ...patch
})

const smallInventory: Inventory = {
  sessionLabel: 'Week 7: Clustering',
  nextAction: null,
  items: [
    item({ text: 'Read chapter 8' }),
    item({
      kind: 'deadline',
      text: 'Submit assignment 2',
      due: '2026-11-01T23:59',
      conflicts: [{ source: 'speech', due: '2026-10-31', text: 'assignment two on Saturday' }]
    })
  ],
  covered: ['k-means', 'Choosing k']
}

// The lines of a section: everything after its heading up to the next blank line.
function section(md: string, heading: string): string[] {
  const lines = md.split('\n')
  const at = lines.indexOf(heading)
  if (at < 0) return []
  const out: string[] = []
  for (const line of lines.slice(at + 1)) {
    if (line === '') break
    out.push(line)
  }
  return out
}

test('the lecture template, exactly', () => {
  expect(
    renderLectureSummary(smallInventory, {
      cfg,
      attendance: 'needs you: https://forms.gle/abc',
      outDir: '/data/out'
    })
  ).toBe(
    [
      'Data Mining, Week 7: Clustering (Wed 21 Oct 2026, 20:00 to 22:00)',
      '',
      'Do next: Submit assignment 2 (due Sun 1 Nov 2026, 23:59; heard as Sat 31 Oct 2026)',
      '',
      'Attendance: needs you: https://forms.gle/abc',
      '',
      'To do',
      '1. Submit assignment 2 (due Sun 1 Nov 2026, 23:59; heard as Sat 31 Oct 2026)',
      '2. Read chapter 8',
      '',
      'What was covered',
      '1. k-means',
      '2. Choosing k',
      '',
      'Details: transcript.md, slides.md and chat.md in /data/out',
      ''
    ].join('\n')
  )
})

const sevenDeadlines: Inventory = {
  sessionLabel: null,
  nextAction: null,
  items: [
    ...[27, 26, 25, 24, 23, 22, 28].map((day) =>
      item({ kind: 'deadline', text: `Quiz ${day}`, due: `2026-10-${day}` })
    ),
    item({ kind: 'link', text: 'Slides at https://example.com/s' })
  ],
  covered: []
}

test('7 deadlines: 5 most urgent under To do, the rest under More deadlines; empty sections left out', () => {
  const out = renderLectureSummary(sevenDeadlines, { cfg, attendance: 'not seen', outDir: '/o' })
  expect(section(out, 'To do')).toHaveLength(5)
  expect(section(out, 'More deadlines')).toEqual([
    '1. Quiz 27 (due Tue 27 Oct 2026)',
    '2. Quiz 28 (due Wed 28 Oct 2026)'
  ])
  expect(section(out, 'To do')[0]).toContain('(due Thu 22 Oct 2026)')
  expect(section(out, 'Announcements')).toEqual(['1. Slides at https://example.com/s'])
  expect(out).not.toContain('What was covered')
  expect(out.split('\n')[2]).toStartWith('Do next: ')
  expect(out).toContain('\nAttendance: not seen\n')
})

test('overflowing dated announcements go to More deadlines; a null attendance leaves the line out', () => {
  const inv: Inventory = {
    sessionLabel: null,
    nextAction: 'Email the lecturer',
    items: [
      ...Array.from({ length: 5 }, (_, i) => item({ kind: 'announcement', text: `News ${i}` })),
      item({ kind: 'announcement', text: 'Lab moved', due: '2026-10-29T14:00' }),
      item({ kind: 'announcement', text: 'Undated overflow' })
    ],
    covered: []
  }
  const out = renderLectureSummary(inv, { cfg, attendance: null, outDir: '/o' })
  expect(section(out, 'Announcements')).toHaveLength(5)
  expect(section(out, 'More deadlines')).toEqual(['1. Lab moved (due Thu 29 Oct 2026, 14:00)'])
  expect(out).not.toContain('Attendance')
  expect(out).not.toContain('Undated overflow')
  expect(out.split('\n')[2]).toBe('Do next: Email the lecturer')
})

test('with nothing to do the summary says so', () => {
  const out = renderLectureSummary(
    { sessionLabel: null, nextAction: null, items: [], covered: ['Intro'] },
    {
      cfg,
      attendance: null,
      outDir: '/o'
    }
  )
  expect(out.split('\n')[2]).toBe('Do next: nothing to do from this session')
})

test('meeting links never reach the summary', () => {
  const inv: Inventory = {
    sessionLabel: null,
    nextAction: null,
    items: [item({ kind: 'link', text: 'Join https://zoom.us/j/123456789?pwd=SECRETPASS now' })],
    covered: ['See https://us02web.zoom.us/j/99?pwd=ZZZ']
  }
  const out = renderLectureSummary(inv, { cfg, attendance: null, outDir: '/o' })
  expect(out).not.toContain('pwd=')
  expect(out).not.toContain('zoom.us')
})

test('source priority: slide over lecturer chat over speech', () => {
  expect(
    chooseDue(
      item({
        source: 'speech',
        due: '2026-10-31',
        conflicts: [{ source: 'slide', due: '2026-11-01T23:59', text: '' }]
      })
    )
  ).toEqual({ due: '2026-11-01T23:59', note: 'heard as Sat 31 Oct 2026' })
  expect(
    chooseDue(
      item({
        source: 'lecturer_chat',
        due: '2026-10-30',
        conflicts: [
          { source: 'slide', due: null, text: '' },
          { source: 'speech', due: '2026-10-29', text: '' }
        ]
      })
    )
  ).toEqual({ due: '2026-10-30', note: 'heard as Thu 29 Oct 2026' })
  expect(
    chooseDue(
      item({
        source: 'slide',
        due: '2026-11-01',
        conflicts: [{ source: 'lecturer_chat', due: '2026-11-02T09:30', text: '' }]
      })
    )
  ).toEqual({ due: '2026-11-01', note: 'chat says Mon 2 Nov 2026, 09:30' })
  expect(chooseDue(item({ due: null }))).toEqual({ due: null, note: null })
})
