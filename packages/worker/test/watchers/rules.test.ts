import { expect, test } from 'bun:test'
import type { ChatMessage } from '@tm/core'
import { chooseMeetingLink, messageSignature, nextPollDelayMs, splitLinks } from '../../src/watchers/rules'

const ZOOM = 'https://example.zoom.us/j/00000000001?pwd=PASSCODE'
const FORM = 'https://forms.gle/TESTFORM1'
const msg = (links: string[], key = 'k1'): ChatMessage => ({
  key,
  sender: 'Lecturer',
  senderRole: 'unknown',
  time: '',
  seenAt: '',
  text: '',
  links,
  replyTo: null
})

test('poll delays stay inside 25 to 45 s before and 12 to 25 s during', () => {
  expect(nextPollDelayMs('before', () => 0)).toBe(25_000)
  expect(nextPollDelayMs('before', () => 0.9999999)).toBe(45_000)
  expect(nextPollDelayMs('during', () => 0)).toBe(12_000)
  expect(nextPollDelayMs('during', () => 0.9999999)).toBe(25_000)
})

test('a pasted link beats a watched one', () => {
  expect(chooseMeetingLink(ZOOM, null)).toBe(ZOOM)
  expect(chooseMeetingLink(ZOOM, 'https://example.zoom.us/j/00000000009')).toBe('https://example.zoom.us/j/00000000009')
  expect(chooseMeetingLink(null, null)).toBeNull()
})

test('links split into meeting and other, https only, without duplicates', () => {
  expect(splitLinks(msg([FORM, ZOOM, FORM, 'http://forms.gle/TESTFORM2']))).toEqual({ meeting: [ZOOM], other: [FORM] })
})

test('a wrapped link is judged by its real host, and unsafe links are dropped', () => {
  const wrapped = `https://www.google.com/url?q=${encodeURIComponent(ZOOM)}`
  const safelink = `https://eur01.safelinks.protection.outlook.com/?url=${encodeURIComponent(FORM)}`
  expect(splitLinks(msg([wrapped, safelink, ZOOM]))).toEqual({ meeting: [ZOOM], other: [FORM] })
  const unsafe = [
    'https://user:pw@example.zoom.us/j/00000000001',
    'https://example.zoom.us:8443/j/00000000001',
    'https://example.zoom.us/j/0000000\t0001',
    'https://example.zoom.us.evil.test/j/00000000001',
    'not a url'
  ]
  const result = splitLinks(msg(unsafe))
  expect(result.meeting).toEqual([])
  expect(result.other).toEqual(['https://example.zoom.us.evil.test/j/00000000001'])
})

test('an edited message with a new link has a new signature', () => {
  expect(messageSignature(msg([ZOOM]))).not.toBe(messageSignature(msg([ZOOM, FORM])))
  expect(messageSignature(msg([FORM, ZOOM]))).toBe(messageSignature(msg([ZOOM, FORM])))
  expect(messageSignature(msg([ZOOM], 'k1'))).not.toBe(messageSignature(msg([ZOOM], 'k2')))
})
