import { expect, test } from 'bun:test'
import type { FormRecord, FormState } from '@tm/core'
import { sampleRecord } from '@tm/core/testing'
import { formPing, type FormLinks } from '../src/forms/pings'

const opts = {
  entryName: 'Example lecture',
  timeZone: 'Asia/Kuala_Lumpur',
  links: { meetingPage: null, signIn: null } as FormLinks
}

const base = sampleRecord({
  formId: '0123456789abcdef',
  provider: 'google',
  finalUrl: 'https://docs.google.com/forms/d/e/x/viewform',
  sender: 'Classmate',
  senderRole: 'participant',
  source: 'meeting_chat'
})
const open = [{ label: 'Open form', url: base.finalUrl }]

const CASES: Array<[string, Partial<FormRecord>, ReturnType<typeof formPing>]> = [
  [
    'untrusted_source',
    { state: 'untrusted', reason: 'untrusted_source' },
    {
      title: 'Form seen, not submitted',
      priority: 'high',
      actions: open,
      message:
        "Example lecture: I didn't open this Google Forms form because Classmate posted it in the meeting chat, and they aren't the host or a trusted sender."
    }
  ],
  [
    'not_org_restricted',
    { state: 'untrusted', reason: 'not_org_restricted' },
    {
      title: 'Form seen, not submitted',
      priority: 'high',
      actions: open,
      message:
        "Example lecture: I didn't submit this Google Forms form because Classmate posted it in the meeting chat, they aren't the host or a trusted sender, and the form isn't limited to your organisation."
    }
  ],
  [
    'not_attendance',
    { state: 'not_attendance' },
    {
      title: 'Form seen, not submitted',
      priority: 'default',
      actions: open,
      message: "Example lecture: this Google Forms form doesn't look like an attendance form, so I didn't submit it."
    }
  ],
  [
    'quiz',
    { state: 'quiz' },
    {
      title: 'Form seen, not submitted',
      priority: 'default',
      actions: open,
      message: "Example lecture: this Google Forms form is a quiz (it shows points), so I didn't submit it."
    }
  ],
  [
    'already_answered',
    { state: 'already_answered' },
    {
      title: 'Form already answered',
      priority: 'default',
      actions: open,
      message: 'Example lecture: Google Forms says this form was already answered, so nothing was sent.'
    }
  ],
  [
    'failed open_timeout',
    { state: 'failed', reason: 'open_timeout' },
    {
      title: 'Form needs you',
      priority: 'high',
      actions: open,
      message:
        "Example lecture: I couldn't submit this Google Forms form because it didn't load within 15 seconds. Please open it yourself."
    }
  ],
  [
    'failed interrupted_submitting',
    { state: 'failed', reason: 'interrupted_submitting' },
    {
      title: 'Form needs you',
      priority: 'high',
      actions: open,
      message:
        "Example lecture: I couldn't submit this Google Forms form because the worker restarted while submitting it (check whether your response was recorded). Please open it yourself."
    }
  ]
]

test('submitted without a meeting page says where the screenshots are', () =>
  expect(formPing({ ...base, state: 'submitted', submittedAt: '2026-10-20T12:42:10.000Z' }, opts)).toEqual({
    title: 'Attendance submitted',
    priority: 'high',
    actions: [],
    message:
      'Example lecture: attendance form submitted at 20:42 (Google Forms). Screenshots: forms/0123456789abcdef/ in the meeting folder.'
  }))

test('submitted with a meeting page links to it and not to the form', () =>
  expect(
    formPing(
      { ...base, state: 'submitted', submittedAt: '2026-10-20T12:42:10.000Z' },
      { ...opts, links: { meetingPage: 'https://tm.example/meetings/1', signIn: null } }
    )
  ).toEqual({
    title: 'Attendance submitted',
    priority: 'high',
    actions: [{ label: 'Open meeting page', url: 'https://tm.example/meetings/1' }],
    message: 'Example lecture: attendance form submitted at 20:42 (Google Forms). Screenshots are on the meeting page.'
  }))

test('the submitted time is 24-hour and in the entry zone, so midnight reads 00:05', () =>
  expect(formPing({ ...base, state: 'submitted', submittedAt: '2026-10-20T16:05:00.000Z' }, opts)?.message).toContain(
    'submitted at 00:05 '
  ))

test('a missing sender reads as someone', () =>
  expect(formPing({ ...base, state: 'untrusted', reason: 'untrusted_source', sender: null }, opts)?.message).toBe(
    "Example lecture: I didn't open this Google Forms form because someone posted it in the meeting chat, and they aren't the host or a trusted sender."
  ))

test('a QR code on the shared screen reads as shared screen', () =>
  expect(
    formPing({ ...base, state: 'untrusted', reason: 'untrusted_source', source: 'qr', sender: null }, opts)?.message
  ).toBe(
    "Example lecture: I didn't open this Google Forms form because someone posted it in the shared screen, and they aren't the host or a trusted sender."
  ))

test('needs_member quotes at most three questions', () =>
  expect(
    formPing(
      {
        ...base,
        state: 'needs_member',
        unmatched: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']
      },
      opts
    )?.message
  ).toBe(
    'Example lecture: I didn\'t submit this Google Forms form because no saved detail answers "Q1", "Q2", "Q3" and 2 more.'
  ))

test('needs_member with three or fewer questions has no "more" clause', () =>
  expect(formPing({ ...base, state: 'needs_member', unmatched: ['Q1', 'Q2'] }, opts)).toEqual({
    title: 'Form needs you',
    priority: 'high',
    actions: open,
    message: 'Example lecture: I didn\'t submit this Google Forms form because no saved detail answers "Q1", "Q2".'
  }))

test('awaiting_signin links the form until 1C supplies a sign-in view', () => {
  expect(formPing({ ...base, state: 'awaiting_signin' }, opts)).toEqual({
    title: 'Sign in again',
    priority: 'high',
    actions: [{ label: 'Sign in again', url: base.finalUrl }],
    message:
      "Example lecture: an attendance form needs your Google Forms sign-in, which has expired. Sign in on the desk view and I'll try once more while the form is open, or open the form yourself."
  })
  expect(
    formPing(
      { ...base, state: 'awaiting_signin' },
      {
        ...opts,
        links: { meetingPage: null, signIn: 'https://tm.example/signin' }
      }
    )?.actions
  ).toEqual([{ label: 'Sign in again', url: 'https://tm.example/signin' }, ...open])
})

test.each(CASES)('%s', (_name, patch, expected) => expect(formPing({ ...base, ...patch }, opts)).toEqual(expected))

test('Microsoft Forms copy names its provider', () =>
  expect(
    formPing(
      { ...base, provider: 'microsoft', state: 'already_answered', finalUrl: 'https://forms.office.com/r/abc' },
      opts
    )
  ).toEqual({
    title: 'Form already answered',
    priority: 'default',
    actions: [{ label: 'Open form', url: 'https://forms.office.com/r/abc' }],
    message: 'Example lecture: Microsoft Forms says this form was already answered, so nothing was sent.'
  }))

test('states that do not ping return null', () => {
  const quiet: FormState[] = [
    'detected',
    'resolving',
    'checking_trust',
    'opening',
    'inspecting',
    'filling',
    'submitting'
  ]
  for (const state of quiet) expect(formPing({ ...base, state }, opts)).toBeNull()
})

test('an outcome without the fields its copy needs throws instead of pinging a blank', () => {
  expect(() => formPing({ ...base, state: 'submitted', submittedAt: null }, opts)).toThrow()
  expect(() => formPing({ ...base, state: 'needs_member', unmatched: [] }, opts)).toThrow()
  expect(() => formPing({ ...base, state: 'failed', reason: null }, opts)).toThrow()
  expect(() => formPing({ ...base, state: 'untrusted', reason: null }, opts)).toThrow()
})
