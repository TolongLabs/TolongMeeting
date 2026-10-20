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
      title: "Can't check your meeting bot: Data Mining",
      priority: 'high',
      message:
        "TolongMeeting can't check on the bot for Data Mining right now. It will keep trying; open the meeting page to see what it recorded.",
      actions: [{ label: 'Open meeting page', url: meeting }]
    }
  ],
  [
    'workerFailedUnreachable',
    pings.workerFailed({ entry: 'Data Mining', reason: 'worker_unreachable', meetingUrl: meeting }),
    {
      title: 'Failed: Data Mining',
      priority: 'high',
      message: "The bot for Data Mining couldn't be reached, so the meeting was marked failed.",
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

test('the joined ping carries its three website actions, and none without links', () => {
  const links = {
    meetingPage: 'https://t.example/meetings/1',
    signIn: 'https://t.example/accounts/2/signin',
    leave: 'https://t.example/meetings/1/leave',
    takeOver: 'https://t.example/meetings/1/take-over'
  }
  expect(joinedPing('Data Mining', 3, links).actions).toEqual([
    { label: 'Open meeting page', url: links.meetingPage },
    { label: 'Make the bot leave', url: links.leave },
    { label: 'Take over', url: links.takeOver }
  ])
  expect(joinedPing('Data Mining', 3, null).actions).toBeUndefined()
  expect(joinedPing('Data Mining', 3).actions).toBeUndefined()
})

test('a Meet sign-in pings with the copy and the Sign in again action', () => {
  const links = {
    meetingPage: 'https://t.example/meetings/1',
    signIn: 'https://t.example/accounts/2/signin',
    leave: 'https://t.example/meetings/1/leave',
    takeOver: 'https://t.example/meetings/1/take-over'
  }
  expect(alertPing('Data Mining', 'meet_signin').message).toBe(
    "Google asked to sign in, so the bot couldn't join the Meet call. Sign in to Google again for this identity."
  )
  expect(alertPing('Data Mining', 'meet_signin', undefined, links)).toEqual({
    title: 'Alert: Data Mining',
    message:
      "Google asked to sign in, so the bot couldn't join the Meet call. Sign in to Google again for this identity.",
    priority: 'high',
    actions: [{ label: 'Sign in again', url: links.signIn }]
  })
})

test('Teams sign-in and breakout copy', () => {
  expect(alertPing('Data Mining', 'teams_signin').message).toBe(
    "Teams asked to sign in, so the bot couldn't join. Sign in to Teams again for this account."
  )
  expect(alertPing('Data Mining', 'breakout').message).toBe(
    "The meeting opened breakout rooms. The bot never joins one itself, but the organiser's settings may have moved it into one."
  )
  for (const kind of ['teams_signin', 'breakout'] as const) {
    expect(alertPing('Data Mining', kind).message).not.toMatch(/identit|zoom\.us|teams\.microsoft|passcode|pwd/i)
  }
})

test('a mention pings with its transcript, and never shows a meeting link, meeting ID or passcode', () => {
  const meetingUrl = 'https://tm.example/meetings/o1'
  const takeOverUrl = 'https://tm.example/meetings/o1/take-over'
  const spoken =
    'the link is https://zoom.us/j/123456789?pwd=abc and meet.google.com/abc-defg-hij, passcode 482913, g.co/meet/xyz, teams.microsoft.com/l/meetup-join/1'
  const p = pings.nameMentioned({
    entry: 'Data Mining',
    at: 'Wed 21 Oct, 14:32',
    transcript: spoken,
    meetingUrl,
    takeOverUrl
  })
  expect(p).toEqual({
    title: 'Your name was mentioned: Data Mining',
    message:
      'Heard at Wed 21 Oct, 14:32. The last 30 seconds:\nthe link is [removed] and [removed], passcode: [removed] [removed], [removed]',
    priority: 'high',
    actions: [
      { label: 'Open meeting page', url: meetingUrl },
      { label: 'Take over', url: takeOverUrl }
    ]
  })
  expect(
    pings.nameMentioned({ entry: 'Data Mining', at: 'x', transcript: 'hi', meetingUrl: null, takeOverUrl: null })
  ).toEqual({
    title: 'Your name was mentioned: Data Mining',
    message: 'Heard at x. The last 30 seconds:\nhi',
    priority: 'high'
  })
})

test('pings that send the member to the website carry one action each', () => {
  const links = {
    meetingPage: 'https://t.example/meetings/1',
    signIn: 'https://t.example/accounts/2/signin',
    leave: 'https://t.example/meetings/1/leave',
    takeOver: 'https://t.example/meetings/1/take-over'
  }
  for (const kind of ['zoom_signin', 'teams_signin', 'meet_signin', 'signin_forms'] as const) {
    expect(alertPing('Data Mining', kind, 'Google', links).actions).toEqual([
      { label: 'Sign in again', url: links.signIn }
    ])
    expect(alertPing('Data Mining', kind, 'Google').actions).toBeUndefined()
  }
  expect(alertPing('Data Mining', 'no_link', undefined, links)).toMatchObject({
    priority: 'high',
    actions: [{ label: 'Open meeting page', url: links.meetingPage }]
  })
  expect(alertPing('Data Mining', 'dropped', undefined, links).actions).toBeUndefined()
})

test('not-attended copy, with the action only when the meeting page URL is known', () => {
  const meetingUrl = 'https://tm.example/meetings/o1'
  expect(pings.noLinkStopped({ entry: 'Data Mining', until: 'Wed 21 Oct, 14:30', meetingUrl })).toEqual({
    title: 'Not attended: Data Mining',
    message: 'No meeting link arrived by Wed 21 Oct, 14:30, so the bot stopped without joining Data Mining.',
    priority: 'default',
    actions: [{ label: 'Open meeting page', url: meetingUrl }]
  })
  expect(pings.noLinkStopped({ entry: 'Data Mining', until: 'Wed 21 Oct, 14:30', meetingUrl: null })).toEqual({
    title: 'Not attended: Data Mining',
    message: 'No meeting link arrived by Wed 21 Oct, 14:30, so the bot stopped without joining Data Mining.',
    priority: 'default'
  })
})

test('watcher problems: one message each, and sign-in offered only for a sign-out', () => {
  const meetingUrl = 'https://tm.example/meetings/o1'
  const signInUrl = 'https://tm.example/accounts/i1/signin'
  const ping = (problem: Parameters<typeof pings.watcherProblem>[0]['problem']) =>
    pings.watcherProblem({ entry: 'Data Mining', app: 'whatsapp', problem, meetingUrl, signInUrl: null })
  expect(ping('not_found')).toMatchObject({
    title: 'Not watching WhatsApp: Data Mining',
    priority: 'high',
    message:
      "The bot couldn't find the chat named on the timetable entry. Check it, and paste the meeting link on the meeting page this time."
  })
  expect(ping('ambiguous').message).toBe(
    'More than one WhatsApp chat has the name on the timetable entry. Rename one or change the entry, and paste the meeting link on the meeting page this time.'
  )
  expect(ping('not_loaded').message).toBe(
    "WhatsApp didn't finish loading, so the bot isn't watching the chat. Paste the meeting link on the meeting page if one is posted."
  )
  expect(ping('lost').message).toBe(
    "The bot lost the chat and stopped watching it. Paste the meeting link on the meeting page if one is posted; forms posted there won't be seen."
  )
  expect(ping('lost').actions).toEqual([{ label: 'Open meeting page', url: meetingUrl }])
  const p = pings.watcherProblem({ entry: 'Data Mining', app: 'discord', problem: 'signed_out', meetingUrl, signInUrl })
  expect([p.title, p.priority, p.actions]).toEqual([
    'Not watching Discord: Data Mining',
    'high',
    [
      { label: 'Open meeting page', url: meetingUrl },
      { label: 'Sign in again', url: signInUrl }
    ]
  ])
  expect(p.message).toBe(
    "Discord signed the bot out while it was watching. Sign in again; until then, new links in the chat aren't seen."
  )
  expect(
    pings.watcherProblem({
      entry: 'Data Mining',
      app: 'whatsapp',
      problem: 'signed_out',
      meetingUrl: null,
      signInUrl: null
    }).actions
  ).toBeUndefined()
})

test('watching-off copy for the home-only and switched-off gates', () => {
  const meetingUrl = 'https://tm.example/meetings/o1'
  const accountsUrl = 'https://tm.example/accounts'
  expect(pings.watchingOff({ entry: 'Data Mining', app: 'whatsapp', gate: 'none', meetingUrl, accountsUrl })).toEqual({
    title: 'Not watching WhatsApp: Data Mining',
    message:
      "WhatsApp watching is switched off, so the bot won't watch it for Data Mining. Paste the meeting link on the meeting page.",
    priority: 'high',
    actions: [
      { label: 'Open meeting page', url: meetingUrl },
      { label: 'Open accounts', url: accountsUrl }
    ]
  })
  expect(
    pings.watchingOff({ entry: 'Data Mining', app: 'discord', gate: 'home_only', meetingUrl: null, accountsUrl: null })
  ).toEqual({
    title: 'Not watching Discord: Data Mining',
    message:
      "Discord is watched only for accounts that run at home or on your PC, so the bot won't watch it for Data Mining. Paste the meeting link on the meeting page, or change where this account runs.",
    priority: 'high'
  })
})

const LOCAL_MEETING = 'https://tm.example/meetings/o1'
const OPEN_MEETING = [{ label: 'Open meeting page', url: LOCAL_MEETING }]

test('PC ping: busy with an earlier meeting', () => {
  expect(pings.pcBusy({ entry: 'Algorithms', busyWith: 'Data Mining', meetingUrl: LOCAL_MEETING })).toEqual({
    title: 'PC busy: Algorithms',
    message: "Your PC is still busy with Data Mining, so the bot won't join Algorithms.",
    priority: 'high',
    actions: OPEN_MEETING
  })
})

test('PC pings: offline and not paired', () => {
  expect(
    pings.pcOffline({ entry: 'Data Mining', when: '14:00', pcName: 'DESKTOP-ABC', meetingUrl: LOCAL_MEETING })
  ).toEqual({
    title: 'PC offline: Data Mining',
    message: "Data Mining (14:00) runs on DESKTOP-ABC, which is asleep or off, so the bot won't join.",
    priority: 'high',
    actions: OPEN_MEETING
  })
  expect(
    pings.pcNotPaired({
      entry: 'Data Mining',
      when: '14:00',
      runsOn: 'My PC',
      account: 'University',
      meetingUrl: LOCAL_MEETING
    })
  ).toEqual({
    title: 'No PC paired: Data Mining',
    message: "Data Mining (14:00) runs on My PC, but no PC is paired for University, so the bot won't join.",
    priority: 'high',
    actions: OPEN_MEETING
  })
})

test('Docker pings: not running, too little memory, software not downloaded', () => {
  const base = { entry: 'Data Mining', when: '14:00', pcName: 'DESKTOP-ABC', meetingUrl: LOCAL_MEETING }
  expect(pings.dockerNotRunning({ ...base, deadline: '13:50' })).toEqual({
    title: 'Start Docker Desktop: Data Mining',
    message: "Data Mining (14:00) runs on DESKTOP-ABC, but Docker Desktop isn't running. Start it before 13:50.",
    priority: 'high',
    actions: OPEN_MEETING
  })
  expect(pings.dockerMemoryLow({ ...base, dockerBytes: 2 * 1024 ** 3 })).toEqual({
    title: 'Docker needs more memory: Data Mining',
    message:
      "Data Mining (14:00) can't run on DESKTOP-ABC: Docker Desktop has 2.0 GB and a meeting needs about 4 GB. Set memory=4GB or more under [wsl2] in %UserProfile%\\.wslconfig, then restart Docker Desktop.",
    priority: 'high',
    actions: OPEN_MEETING
  })
  expect(pings.botSoftwareUnavailable(base)).toEqual({
    title: "Can't get the bot software: Data Mining",
    message:
      "Data Mining (14:00) can't start on DESKTOP-ABC: Docker couldn't download the TolongMeeting bot software. Run docker login ghcr.io with your GitHub account; the PC tries again every 30 seconds.",
    priority: 'high',
    actions: OPEN_MEETING
  })
})

test('home connection ping: one phrase and one fix per problem', () => {
  const base = {
    entry: 'Data Mining',
    when: '14:00',
    device: 'tm-home-1a2b3c4d',
    deadline: '13:50',
    meetingUrl: LOCAL_MEETING
  }
  expect(pings.homeConnectionOffline({ ...base, problem: 'offline' })).toEqual({
    title: 'Home connection offline: Data Mining',
    message:
      "Data Mining (14:00) runs through your home device tm-home-1a2b3c4d, which isn't online. Turn it on before 13:50, or the bot won't join.",
    priority: 'high',
    actions: OPEN_MEETING
  })
  expect(pings.homeConnectionOffline({ ...base, problem: 'not_exit_node' }).message).toBe(
    "Data Mining (14:00) runs through your home device tm-home-1a2b3c4d, which isn't sharing its connection. Share its connection before 13:50, or the bot won't join."
  )
  expect(pings.homeConnectionOffline({ ...base, problem: 'not_enrolled' }).message).toBe(
    "Data Mining (14:00) runs through your home device tm-home-1a2b3c4d, which isn't set up. Set it up before 13:50, or the bot won't join."
  )
})

test('native transcription failure shows only a short, scrubbed first line of the error', () => {
  const ping = pings.nativeTranscriptionFailed({
    entry: 'Data Mining',
    date: 'Wed 21 Oct',
    error: 'RuntimeError: CUDA out of memory.\nTraceback (most recent call last):',
    meetingUrl: LOCAL_MEETING
  })
  expect(ping).toEqual({
    title: 'Transcription failed: Data Mining',
    message:
      'Data Mining (Wed 21 Oct) could not be transcribed on your PC: RuntimeError: CUDA out of memory. The recording is on the meeting page.',
    priority: 'default',
    actions: OPEN_MEETING
  })
  const noisy = pings.nativeTranscriptionFailed({
    entry: 'Data Mining',
    date: 'Wed 21 Oct',
    error: `failed at https://zoom.us/j/123456789?pwd=secret ${'x'.repeat(400)}`,
    meetingUrl: LOCAL_MEETING
  })
  expect(noisy.message).toContain('[removed]')
  expect(noisy.message).not.toContain('zoom.us')
  expect(noisy.message).not.toContain('123456789')
  expect(noisy.message.length).toBeLessThan(330)
  expect(
    pings.nativeTranscriptionFailed({ entry: 'A', date: 'Wed 21 Oct', error: '', meetingUrl: LOCAL_MEETING }).message
  ).toBe('A (Wed 21 Oct) could not be transcribed on your PC. The recording is on the meeting page.')
})

test('every widened failure reason reads inside the failed ping', () => {
  for (const reason of [
    'your PC stopped responding',
    "Docker Desktop wasn't running",
    'Docker Desktop had too little memory',
    "Docker couldn't download the bot software",
    'your home connection was offline'
  ] as const) {
    expect(pings.workerFailed({ entry: 'Data Mining', reason, meetingUrl: LOCAL_MEETING })).toEqual({
      title: 'Failed: Data Mining',
      message: `The bot stopped and won't retry (${reason}). Anything it recorded is on the meeting page.`,
      priority: 'high',
      actions: OPEN_MEETING
    })
  }
})

test('the summary-ready ping carries the tm_summary tag, and no other ping carries a tag', () => {
  expect(summaryReadyPing('Data Mining', 'short').tags).toEqual(['tm_summary'])
  expect(summaryFailedPing('Data Mining', 401).tags).toBeUndefined()
  expect(joinedPing('Data Mining', 3).tags).toBeUndefined()
  expect(alertPing('Data Mining', 'dropped').tags).toBeUndefined()
})

test('no new ping holds a meeting link, passcode or the PC secrets', () => {
  const all = [
    pings.pcOffline({ entry: 'E', when: '14:00', pcName: 'PC', meetingUrl: LOCAL_MEETING }),
    pings.dockerNotRunning({ entry: 'E', when: '14:00', pcName: 'PC', deadline: '13:50', meetingUrl: LOCAL_MEETING }),
    pings.botSoftwareUnavailable({ entry: 'E', when: '14:00', pcName: 'PC', meetingUrl: LOCAL_MEETING }),
    pings.homeConnectionOffline({
      entry: 'E',
      when: '14:00',
      device: 'tm-home-1',
      problem: 'offline',
      deadline: '13:50',
      meetingUrl: LOCAL_MEETING
    })
  ]
  for (const ping of all) {
    expect(ping.message).not.toMatch(/zoom\.us|teams\.microsoft|meet\.google|passcode|token|identit/i)
    expect(ping.actions?.every((a) => a.url === LOCAL_MEETING)).toBe(true)
  }
})
