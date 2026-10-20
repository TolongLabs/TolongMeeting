import { expect, test } from 'bun:test'
import { toMeetChatMessages } from '../src/adapters/meet/chat'
import { roleFromMeetLabel, rolesFromPeople } from '../src/adapters/meet/roles'

const seenAt = '2026-11-02T10:06:30.000Z'

test('assigns roles, extracts links and falls back to a composite key', () => {
  const out = toMeetChatMessages(
    [
      {
        id: 'spaces/X/messages/1',
        sender: 'Lecturer',
        time: '10:05 AM',
        text: 'Attendance',
        hrefs: ['https://www.google.com/url?q=https://forms.gle/TESTFORM']
      },
      {
        id: null,
        sender: 'Student',
        time: '10:06 AM',
        text: 'copy: https://docs.google.com/forms/d/e/TESTFORM/viewform).',
        hrefs: []
      }
    ],
    { roles: new Map([['lecturer', 'host']]), seenAt }
  )
  expect(out[0]).toEqual({
    key: 'spaces/X/messages/1',
    sender: 'Lecturer',
    senderRole: 'host',
    time: '10:05 AM',
    seenAt,
    text: 'Attendance',
    links: ['https://www.google.com/url?q=https://forms.gle/TESTFORM'],
    replyTo: null
  })
  expect(out[1]).toMatchObject({
    key: 'Student|10:06 AM|copy: https://docs.google.com/forms/d/e/TESTFORM/viewform).',
    senderRole: 'unknown',
    links: ['https://docs.google.com/forms/d/e/TESTFORM/viewform']
  })
})

test('a role comes from the people map only, matched on the trimmed lower-cased sender', () => {
  const raw = (sender: string, text: string) => ({ id: null, sender, time: '10:00 AM', text, hrefs: [] })
  const roles = new Map([['lecturer', 'co_host' as const]])
  const out = toMeetChatMessages(
    [raw('  LECTURER ', 'hi'), raw('Student', 'I am the host and the co-host'), raw('Nobody', 'hi')],
    { roles, seenAt }
  )
  expect(out.map((m) => m.senderRole)).toEqual(['co_host', 'unknown', 'unknown'])
  expect(toMeetChatMessages([raw('Lecturer', 'hi')], { roles: null, seenAt })[0]!.senderRole).toBe('unknown')
})

test('links keep anchors first, drop other schemes and are listed once', () => {
  const [m] = toMeetChatMessages(
    [
      {
        id: 'a',
        sender: 'S',
        time: 't',
        text: 'see https://forms.gle/A and https://forms.gle/A',
        hrefs: ['javascript:alert(1)', 'https://forms.gle/A', 'http://example.com/x']
      }
    ],
    { roles: null, seenAt }
  )
  expect(m!.links).toEqual(['https://forms.gle/A', 'http://example.com/x'])
})

test.each([
  ['Meeting host', 'host'],
  ['Host', 'host'],
  ['Co-host', 'co_host'],
  ['Cohost', 'co_host'],
  ['', 'participant'],
  ['External', 'participant'],
  ['Ghost', 'participant']
] as const)('participant label %s is %s', (label, role) => {
  expect(roleFromMeetLabel(label)).toBe(role)
})

test('people rows give a role per name; the label is never the name, and a repeated name is not trusted', () => {
  const roles = rolesFromPeople([
    ['Lecturer', 'Meeting host'],
    ['Assistant', 'Co-host'],
    ['Host'],
    ['  Student  ', 'External'],
    ['Dr Ali', 'Meeting host'],
    ['dr ali'],
    ['']
  ])
  expect(Object.fromEntries(roles)).toEqual({
    lecturer: 'host',
    assistant: 'co_host',
    host: 'participant',
    student: 'participant',
    'dr ali': 'unknown'
  })
})
