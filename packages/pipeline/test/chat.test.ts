import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { ChatMessage } from '@tm/core'
import { buildChat, orderChat, stripInviteLinks } from '../src/chat'
import { makeOccurrence, removeOccurrence, writeLines } from './helpers'

const occurrences: string[] = []
afterEach(async () => {
  for (const root of occurrences.splice(0)) await removeOccurrence(root)
})

function m(
  key: string,
  time: string,
  sender: string,
  text: string,
  seen: number,
  replyTo: string | null = null,
  senderRole: ChatMessage['senderRole'] = 'participant'
): ChatMessage {
  return {
    key,
    sender,
    senderRole,
    time,
    seenAt: `2026-10-21T12:00:0${seen}Z`,
    text,
    links: [],
    replyTo
  }
}

const postings = [
  m('a', '8:41 PM', 'Lecturer', 'Attendance: https://forms.gle/abc', 1, null, 'host'),
  m('b', '8:42 PM', 'Student A', 'hi', 2),
  m('c', '8:43 PM', 'Student B', 'thanks', 3, 'a'),
  m('a2', '8:41 PM', 'Lecturer', 'Attendance: https://forms.gle/abc', 4, null, 'host')
]

test('de-duplicate, order, replies after parents, invite links removed', () => {
  const out = orderChat([
    m('a', '8:41 PM', 'Lecturer', 'Attendance: https://forms.gle/abc', 1),
    m('b', '8:42 PM', 'Student A', 'hi', 2),
    m('c', '8:43 PM', 'Student B', 'thanks', 3, 'a'),
    m('a2', '8:41 PM', 'Lecturer', 'Attendance: https://forms.gle/abc', 4)
  ])
  expect(out.map((x) => x.key)).toEqual(['a', 'c', 'b'])
  expect(stripInviteLinks('join https://example-uni.zoom.us/j/00000000000?pwd=PWD now')).toBe(
    'join [meeting link removed] now'
  )
  expect(stripInviteLinks('https://meet.google.com/abc-defg-hij and https://teams.microsoft.com/l/meetup-join/x')).toBe(
    '[meeting link removed] and [meeting link removed]'
  )
})

test('replies to a removed duplicate attach to the kept message', () => {
  const out = orderChat([...postings, m('d', '8:44 PM', 'Student C', 'me too', 5, 'a2')])
  expect(out.map((x) => x.key)).toEqual(['a', 'c', 'd', 'b'])
  expect(out[2].replyTo).toBe('a')
})

test('a reply that points at itself is reported as a loop', () => {
  expect(() => orderChat([m('x', '8:45 PM', 'Student D', 'loop', 1, 'x')])).toThrow('chat replies form a loop')
})

test('chat.md format', async () => {
  const occ = await makeOccurrence()
  occurrences.push(occ.root)
  await writeLines(join(occ.dataDir, 'chat.jsonl'), [...postings])

  const path = await buildChat(occ.cfg)
  expect(path).toBe(join(occ.dataDir, 'out', 'chat.md'))
  const md = await Bun.file(path).text()
  expect(md).toContain(
    '# Data Mining: chat\n\n3 messages from the meeting chat, in posting order. Meeting links are removed.\n\n## Messages\n\n'
  )
  expect(md).toContain(
    '**[8:41 PM] Lecturer (host):** Attendance: https://forms.gle/abc\n\n> **[8:43 PM] Student B:** thanks'
  )
  expect(md).toBe(
    '# Data Mining: chat\n\n' +
      '3 messages from the meeting chat, in posting order. Meeting links are removed.\n\n' +
      '## Messages\n\n' +
      '**[8:41 PM] Lecturer (host):** Attendance: https://forms.gle/abc\n\n' +
      '> **[8:43 PM] Student B:** thanks\n\n' +
      '**[8:42 PM] Student A:** hi\n'
  )
})

test('meeting links are removed from chat.md and names are kept', async () => {
  const occ = await makeOccurrence()
  occurrences.push(occ.root)
  await writeLines(join(occ.dataDir, 'chat.jsonl'), [
    m('z1', '9:00 PM', 'Co Host', 'join https://example-uni.zoom.us/j/00000000000?pwd=PWD now', 1, null, 'co_host'),
    m(
      'z2',
      '9:01 PM',
      'Student E',
      'https://meet.google.com/abc-defg-hij and https://teams.microsoft.com/l/meetup-join/x',
      2
    )
  ])

  const md = await Bun.file(await buildChat(occ.cfg)).text()
  expect(
    md.endsWith(
      '## Messages\n\n**[9:00 PM] Co Host (co-host):** join [meeting link removed] now\n\n' +
        '**[9:01 PM] Student E:** [meeting link removed] and [meeting link removed]\n'
    )
  ).toBe(true)
  expect(md).not.toContain('pwd=')
})

test('a meeting without captured chat says so', async () => {
  const occ = await makeOccurrence()
  occurrences.push(occ.root)
  const md = await Bun.file(await buildChat(occ.cfg)).text()
  expect(md).toContain('0 messages from the meeting chat')
  expect(md.endsWith('## Messages\n\n_No chat was captured for this meeting._\n')).toBe(true)
})

test('a participant cannot inject Markdown structure into chat.md', async () => {
  const occ = await makeOccurrence()
  occurrences.push(occ.root)
  await writeLines(join(occ.dataDir, 'chat.jsonl'), [
    m(
      'i1',
      '9:10 PM',
      'Student F',
      '**bold** [click](https://evil.example) # heading\n`code` > quote _em_ | table ~ strike + plus - dash ! bang \\ slash',
      1
    )
  ])
  const md = await Bun.file(await buildChat(occ.cfg)).text()
  expect(md).toContain(
    '**[9:10 PM] Student F:** ' +
      '\\*\\*bold\\*\\* \\[click\\]\\(https://evil.example\\) \\# heading\n' +
      '\\`code\\` \\> quote \\_em\\_ \\| table \\~ strike \\+ plus \\- dash \\! bang \\\\ slash'
  )
})
