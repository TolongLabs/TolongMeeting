import { expect, test } from 'bun:test'
import type { FormSource, ResolvedForm, SenderRole } from '@tm/core'
import { checkTrust } from '../src/forms/trust'

test('pre-open trust rules', () => {
  const t = (source: FormSource, sender: string | null, senderRole: SenderRole | null) =>
    checkTrust({ source, sender, senderRole }, ['Dr Lecturer'])
  expect(t('qr', null, null)).toEqual({
    trusted: true,
    reason: 'qr_on_screen'
  })
  expect(t('meeting_chat', 'Anyone', 'host')).toEqual({
    trusted: true,
    reason: 'host'
  })
  expect(t('meeting_chat', 'Anyone', 'co_host')).toEqual({
    trusted: true,
    reason: 'co_host'
  })
  expect(t('meeting_chat', ' dr  lecturer (Guest) ', 'participant')).toEqual({
    trusted: true,
    reason: 'trusted_sender'
  })
  expect(t('meeting_chat', 'Dr Lecturer2', 'participant')).toEqual({
    trusted: false,
    reason: null
  })
  expect(t('meeting_chat', null, 'unknown')).toEqual({
    trusted: false,
    reason: null
  })
  expect(t('watched_chat', 'Someone', 'host')).toEqual({
    trusted: false,
    reason: null
  })
})

test('a resolved form from a trusted sender is trusted; a bare candidate works too', () => {
  const resolved: ResolvedForm = {
    url: 'https://forms.gle/abc',
    finalUrl: 'https://docs.google.com/forms/d/e/1FAIpQ/viewform',
    provider: 'google',
    source: 'watched_chat',
    sender: 'DR LECTURER',
    senderRole: 'participant',
    seenAt: '2026-10-20T10:00:00Z'
  }
  expect(checkTrust(resolved, ['Dr Lecturer'])).toEqual({ trusted: true, reason: 'trusted_sender' })
  expect(checkTrust(resolved, [])).toEqual({ trusted: false, reason: null })
  expect(checkTrust({ source: 'qr', sender: null, senderRole: null }, [])).toEqual({
    trusted: true,
    reason: 'qr_on_screen'
  })
})
