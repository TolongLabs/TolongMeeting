import { test, expect } from 'bun:test'
import type { ResolvedForm } from '@tm/core'
import type { Ping } from '../src/index'
import {
  joinedPing,
  alertPing,
  summaryReadyPing,
  summaryFailedPing,
  linkUncheckedPing,
  formNotFilledPing,
  pings
} from '../src/index'

const resolvedQr: ResolvedForm = {
  url: 'https://forms.gle/abc',
  source: 'qr',
  sender: null,
  senderRole: null,
  seenAt: '2026-10-21T12:41:00.000Z',
  finalUrl: 'https://docs.google.com/forms/d/e/abc/viewform',
  provider: 'google'
}

const resolvedChat: ResolvedForm = {
  url: 'https://forms.gle/def',
  source: 'meeting_chat',
  sender: 'Student A',
  senderRole: 'participant',
  seenAt: '2026-10-21T12:42:00.000Z',
  finalUrl: 'https://docs.google.com/forms/d/e/def/viewform',
  provider: 'google'
}

test('ping copy', () => {
  expect(joinedPing('Data Mining', 41)).toEqual({
    title: 'Joined: Data Mining',
    message: 'In the meeting with 41 participants. Recording.',
    priority: 'default'
  })
  expect(alertPing('Data Mining', 'black_frames').title).toBe('Alert: Data Mining')
  expect(summaryReadyPing('Data Mining', 'x'.repeat(5000)).message.length).toBeLessThanOrEqual(
    3900 + '\n(truncated)'.length
  )
})

test('copy for the remaining builders', () => {
  expect(joinedPing('Data Mining', null).message).toBe('In the meeting. Recording.')
  expect(linkUncheckedPing('Data Mining', resolvedChat, '20:44')).toEqual({
    title: 'Link seen, not checked: Data Mining',
    message: "Student A shared a link at 20:44 that couldn't be checked within 5 seconds. It may be a form.",
    priority: 'high',
    actions: [{ label: 'Open link', url: resolvedChat.url }]
  })
  expect(alertPing('Data Mining', 'join_failed', 'lobby closed').message).toBe("The bot couldn't join: lobby closed.")
  expect(summaryFailedPing('Data Mining', 401)).toEqual({
    title: 'Summary failed: Data Mining',
    message: 'Your AI key was rejected (401). Everything is kept; run tm-pipeline again after fixing the key.',
    priority: 'high'
  })
})

test('a detail-bearing alert without its detail fails loudly', () => {
  expect(() => alertPing('Data Mining', 'recording_gap')).toThrow('recording_gap needs a detail')
})

test('recorder and component alerts', () => {
  expect(alertPing('Data Mining', 'recording_unstable').message).toBe(
    'The recorder keeps restarting. Parts of the recording are missing.'
  )
  expect(alertPing('Data Mining', 'recorder_failed').priority).toBe('high')
  expect(alertPing('Data Mining', 'component_failed', 'chat capture').message).toBe(
    "The bot's chat capture stopped working. The recording continues."
  )
  expect(() => alertPing('Data Mining', 'component_failed')).toThrow('component_failed needs a detail')
  expect(alertPing('Data Mining', 'run_failed').message).toBe(
    'The bot stopped unexpectedly. The meeting is no longer being recorded.'
  )
  expect(alertPing('Data Mining', 'device_check_failed').message).toBe(
    'The bot could not check that its microphone and camera are off, so it is rejoining the meeting.'
  )
  expect(alertPing('Data Mining', 'device_check_stopped').message).toBe(
    'The bot could not check its microphone and camera again, so it stopped.'
  )
})

test('summary cut to 3900 bytes never splits a multi-byte character', () => {
  // 'a' is one byte and 'é' is two, so byte 3900 is the second byte of an 'é': the cut lands mid-character.
  const text = 'a' + 'é'.repeat(3000)
  const message = summaryReadyPing('Data Mining', text).message
  expect(message.endsWith('\n(truncated)')).toBe(true)
  const kept = message.slice(0, -'\n(truncated)'.length)
  expect(new TextEncoder().encode(kept).length).toBeLessThanOrEqual(3900)
  // 'a' plus 1,949 'é' is 3,899 bytes; the split 'é' is dropped whole.
  expect(kept).toBe('a' + 'é'.repeat(1949))
})

test('a link from the shared screen is worded as a QR code, not a sender', () => {
  expect(linkUncheckedPing('Data Mining', resolvedQr, '20:46')).toEqual({
    title: 'Link seen, not checked: Data Mining',
    message:
      "A QR code on the shared screen pointed to a link at 20:46 that couldn't be checked within 5 seconds. It may be a form.",
    priority: 'high',
    actions: [{ label: 'Open link', url: resolvedQr.url }]
  })
})

test('a form the bot did not fill names who shared it and opens the form', () => {
  expect(formNotFilledPing('Data Mining', resolvedChat, '20:44', resolvedChat.finalUrl)).toEqual({
    title: 'Form seen, not filled: Data Mining',
    message: 'Student A shared a form at 20:44. The bot did not fill it. Open it yourself.',
    priority: 'high',
    actions: [{ label: 'Open form', url: resolvedChat.finalUrl }]
  })
  expect(
    formNotFilledPing('Data Mining', { ...resolvedChat, sender: null }, '20:45', resolvedChat.finalUrl).message
  ).toBe('Someone shared a form at 20:45. The bot did not fill it. Open it yourself.')
  expect(formNotFilledPing('Data Mining', resolvedQr, '20:46', resolvedQr.url).message).toBe(
    'A QR code on the shared screen pointed to a form at 20:46. The bot did not fill it. Open it yourself.'
  )
})

test('a summary that fits is sent whole', () => {
  expect(summaryReadyPing('Data Mining', 'short').message).toBe('short')
})

test('form_ping_failed alert copy', () => {
  expect(alertPing('Data Mining', 'form_ping_failed')).toEqual({
    title: 'Alert: Data Mining',
    message: "A form couldn't be checked or pinged. Open the meeting page to see what the bot recorded.",
    priority: 'high'
  })
})

const timetable = 'https://tm.example/timetable'
const accounts = 'https://tm.example/accounts'
const meeting = 'https://tm.example/meetings/abc'

// One case per row of the 01c ping copy table (plan 01c, Task 7).
const COPY_CASES: [string, Ping, Ping][] = [
  [
    'notificationsTest',
    pings.notificationsTest(),
    {
      title: 'TolongMeeting test',
      priority: 'default',
      message: 'Notifications work. Meeting pings will arrive here.'
    }
  ],
  [
    'identityClashSaved',
    pings.identityClashSaved({
      loser: 'Data Mining',
      winner: 'Algorithms',
      when: 'Wed 21 Oct, 14:00',
      identity: 'University',
      timetableUrl: timetable
    }),
    {
      title: 'Timetable clash on University',
      priority: 'high',
      message:
        "Data Mining at Wed 21 Oct, 14:00 overlaps Algorithms on the same identity, so Data Mining won't be attended. Change a time or pick another identity.",
      actions: [{ label: 'Open timetable', url: timetable }]
    }
  ],
  [
    'identityClashSkipped',
    pings.identityClashSkipped({
      entry: 'Data Mining',
      when: 'Wed 21 Oct, 14:00',
      winner: 'Algorithms',
      identity: 'University',
      timetableUrl: timetable
    }),
    {
      title: 'Skipped: Data Mining',
      priority: 'high',
      message:
        "Data Mining at Wed 21 Oct, 14:00 overlaps Algorithms, which uses the same identity (University), so the bot won't attend it.",
      actions: [{ label: 'Open timetable', url: timetable }]
    }
  ],
  [
    'capacityClash',
    pings.capacityClash({
      entry: 'Data Mining',
      when: 'Wed 21 Oct, 14:00',
      identity: 'University',
      accountsUrl: accounts
    }),
    {
      title: 'Skipped: Data Mining (server full)',
      priority: 'high',
      message:
        "Two meetings are already running on the server, so the bot won't attend Data Mining at Wed 21 Oct, 14:00. To run it, switch the University identity to your PC.",
      actions: [{ label: 'Open accounts', url: accounts }]
    }
  ],
  [
    'workerRestarted',
    pings.workerRestarted({ entry: 'Data Mining', n: 2, meetingUrl: meeting }),
    {
      title: 'Restarting: Data Mining',
      priority: 'high',
      message: 'The bot stopped responding and is rejoining from its last checkpoint (restart 2 of 3).',
      actions: [{ label: 'Open meeting page', url: meeting }]
    }
  ],
  [
    'workerFailed',
    pings.workerFailed({ entry: 'Data Mining', reason: "it couldn't start", meetingUrl: meeting }),
    {
      title: 'Failed: Data Mining',
      priority: 'high',
      message: "The bot stopped and won't retry (it couldn't start). Anything it recorded is on the meeting page.",
      actions: [{ label: 'Open meeting page', url: meeting }]
    }
  ],
  [
    'workerUnchecked',
    pings.workerUnchecked({ entry: 'Data Mining', meetingUrl: meeting }),
    {
      title: "Can't check: Data Mining",
      priority: 'high',
      message:
        "TolongMeeting can't check your meeting worker: it has stopped reporting and the server can't ask Docker about it. It may still be running.",
      actions: [{ label: 'Open meeting page', url: meeting }]
    }
  ],
  [
    'workerFailedUnreachable',
    pings.workerFailed({ entry: 'Data Mining', reason: "it couldn't be reached", meetingUrl: meeting }),
    {
      title: 'Failed: Data Mining',
      priority: 'high',
      message: "The bot stopped and won't retry (it couldn't be reached). Anything it recorded is on the meeting page.",
      actions: [{ label: 'Open meeting page', url: meeting }]
    }
  ],
  [
    'deletionSoon',
    pings.deletionSoon({
      entry: 'Data Mining',
      when: 'Wed 21 Oct, 14:00',
      deleteOn: 'Sat 24 Oct',
      meetingUrl: meeting
    }),
    {
      title: 'Deleting in 3 days: Data Mining',
      priority: 'default',
      message:
        'Data Mining (Wed 21 Oct, 14:00) will be deleted from the server on Sat 24 Oct. Export anything you want to keep before then.',
      actions: [{ label: 'Open meeting page', url: meeting }]
    }
  ],
  [
    'waitingForPc',
    pings.waitingForPc({ entry: 'Data Mining', meetingUrl: meeting }),
    {
      title: 'Waiting for your PC: Data Mining',
      priority: 'default',
      message: 'Turn on your PC with the companion app to transcribe Data Mining.',
      actions: [{ label: 'Open meeting page', url: meeting }]
    }
  ],
  [
    'aiKeyProblem',
    pings.aiKeyProblem({
      entry: 'Data Mining',
      status: 401,
      meetingUrl: meeting,
      aiKeysUrl: 'https://tm.example/ai-keys'
    }),
    {
      title: 'Summary needs your key: Data Mining',
      priority: 'high',
      message:
        'DashScope refused your key (401). Everything is kept; fix the key on the AI keys page, then press Re-run on the meeting page.',
      actions: [
        { label: 'Open AI keys', url: 'https://tm.example/ai-keys' },
        { label: 'Open meeting page', url: meeting }
      ]
    }
  ],
  [
    'pipelineFailed',
    pings.pipelineFailed({ entry: 'Data Mining', meetingUrl: meeting }),
    {
      title: 'Summary failed: Data Mining',
      priority: 'high',
      message: 'Post-processing failed. The recording, chat and transcript are kept on the meeting page.',
      actions: [{ label: 'Open meeting page', url: meeting }]
    }
  ]
]

test.each(COPY_CASES)('%s matches the copy table', (_name, ping, expected) => {
  expect(ping).toEqual(expected)
})

test('capacity clash copy', () => {
  expect(
    pings.capacityClash({
      entry: 'Data Mining',
      when: 'Wed 21 Oct, 14:00',
      identity: 'University',
      accountsUrl: 'https://tm.example/accounts'
    })
  ).toEqual(COPY_CASES[3][2])
})
