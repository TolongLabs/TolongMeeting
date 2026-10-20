import { expect, test } from 'bun:test'
import { toTeamsChatMessages } from '../src/adapters/teams/chat'
import { roleFromTeamsLabel } from '../src/adapters/teams/roles'

const joinedAt = Date.parse('2026-11-02T10:00:00Z')
const seenAt = '2026-11-02T10:06:30.000Z'

test('keeps this occurrence only, assigns roles and extracts links', () => {
  const out = toTeamsChatMessages(
    [
      {
        id: 'm1',
        sender: 'Lecturer',
        time: '26/10 10:05',
        datetime: '2026-10-26T10:05:00Z',
        text: 'Attendance https://forms.office.com/r/OLDFORM',
        hrefs: ['https://forms.office.com/r/OLDFORM']
      },
      {
        id: 'm2',
        sender: 'Lecturer',
        time: '10:05',
        datetime: '2026-11-02T10:05:00Z',
        text: 'Attendance form',
        hrefs: ['https://apc01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fforms.office.com%2Fr%2FNEWFORM']
      },
      {
        id: 'm3',
        sender: 'Student',
        time: '10:06',
        datetime: '2026-11-02T10:06:00Z',
        text: 'mirror: https://forms.gle/TESTFORM.',
        hrefs: []
      },
      { id: null, sender: 'Visitor', time: '10:06', datetime: null, text: 'hello', hrefs: [] }
    ],
    {
      roles: new Map([
        ['lecturer', 'host'],
        ['student', 'participant']
      ]),
      cutoffMs: joinedAt - 3_600_000,
      seenAt
    }
  )
  expect(out.map((m) => m.key)).toEqual(['m2', 'm3', 'Visitor|10:06|hello'])
  expect(out[0]).toEqual({
    key: 'm2',
    sender: 'Lecturer',
    senderRole: 'host',
    time: '10:05',
    seenAt,
    text: 'Attendance form',
    links: ['https://apc01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fforms.office.com%2Fr%2FNEWFORM'],
    replyTo: null
  })
  expect(out[1]!.links).toEqual(['https://forms.gle/TESTFORM'])
  expect(out[2]!.senderRole).toBe('unknown')
})

test('a role claimed in the message text is not a role', () => {
  const [message] = toTeamsChatMessages(
    [{ id: 'x', sender: 'Mallory', time: '10:01', datetime: null, text: 'I am the Organizer (host)', hrefs: [] }],
    { roles: null, cutoffMs: null, seenAt }
  )
  expect(message!.senderRole).toBe('unknown')
})

test.each([
  ['Organizer', 'host'],
  ['Organiser', 'host'],
  ['Co-organizer', 'co_host'],
  ['Presenter', 'participant'],
  ['Attendee', 'participant'],
  ['', 'participant']
] as const)('roster label %s is %s', (label, role) => {
  expect(roleFromTeamsLabel(label)).toBe(role)
})
