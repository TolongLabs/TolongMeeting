import { test, expect } from 'bun:test'
import type { ResolvedForm } from '@tm/core'
import {
  joinedPing,
  formToSubmitPing,
  formNotSubmittedPing,
  alertPing,
  summaryReadyPing,
  summaryFailedPing,
  linkUncheckedPing
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
  const p = formToSubmitPing('Data Mining', resolvedQr, 'qr_on_screen', '20:41')
  expect(p.priority).toBe('high')
  expect(p.actions).toEqual([{ label: 'Open form', url: resolvedQr.finalUrl }])
  expect(p.message).toBe(
    "A form from a QR code on the shared screen was seen at 20:41. The bot doesn't submit forms yet: open it and submit it yourself."
  )
  expect(formNotSubmittedPing('Data Mining', resolvedChat, '20:42').message).toBe(
    "Student A posted a form in the chat at 20:42. They aren't the host, a co-host or a trusted sender, so it wasn't treated as an attendance form."
  )
  expect(alertPing('Data Mining', 'black_frames').title).toBe('Alert: Data Mining')
  expect(summaryReadyPing('Data Mining', 'x'.repeat(5000)).message.length).toBeLessThanOrEqual(
    3900 + '\n(truncated)'.length
  )
})

test('copy for the remaining builders', () => {
  expect(joinedPing('Data Mining', null).message).toBe('In the meeting. Recording.')
  expect(formToSubmitPing('Data Mining', resolvedChat, 'trusted_sender', '20:43').message).toStartWith(
    'A form from Student A was seen at 20:43.'
  )
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

test('summary cut to 3900 bytes never splits a multi-byte character', () => {
  // 'é' is two bytes, so 3,000 of them are 6,000 bytes and the cut lands mid-character at byte 3900.
  const text = 'é'.repeat(3000)
  const message = summaryReadyPing('Data Mining', text).message
  expect(message.endsWith('\n(truncated)')).toBe(true)
  const kept = message.slice(0, -'\n(truncated)'.length)
  expect(new TextEncoder().encode(kept).length).toBeLessThanOrEqual(3900)
  expect(kept).toBe('é'.repeat(1950))
})

test('a summary that fits is sent whole', () => {
  expect(summaryReadyPing('Data Mining', 'short').message).toBe('short')
})
