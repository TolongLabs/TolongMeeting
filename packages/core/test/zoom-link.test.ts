import { expect, test } from 'bun:test'
import { normaliseZoomLink, unwrapLink } from '../src'

test('valid /j/ and /wc/join/ links become the web-client URL, keeping the query and dropping the fragment', () => {
  expect(normaliseZoomLink('https://us06web.zoom.us/j/00000000000?pwd=PWD#success')).toBe(
    'https://us06web.zoom.us/wc/join/00000000000?pwd=PWD'
  )
  expect(normaliseZoomLink('  https://zoom.us/wc/join/00000000000/  ')).toBe('https://zoom.us/wc/join/00000000000')
})

test('userinfo, a port, http, look-alike hosts, personal rooms and other Zoom pages are refused', () => {
  for (const url of [
    'https://zoom.us@example.com/j/00000000000',
    'https://user:pass@example.zoom.us/j/00000000000',
    'https://example.zoom.us:8443/j/00000000000',
    'http://example.zoom.us/j/00000000000',
    'https://evilzoom.us/j/00000000000',
    'https://zoom.us.example.com/j/00000000000',
    'https://example.zoom.us.evil.test/j/00000000000',
    'https://example.zoom.us/my/lecturer',
    'https://example.zoom.us/signin',
    'https://example.zoom.us/s/00000000000',
    'https://example.zoom.us/wc/00000000000/start',
    'https://example.zoom.us/postattendee?mn=00000000000'
  ]) {
    expect(normaliseZoomLink(url)).toBeNull()
  }
})

test('control characters are refused, since the URL parser would strip them', () => {
  expect(normaliseZoomLink('https://example.zoom.us/j/0000\t0000000')).toBeNull()
  expect(normaliseZoomLink('https://example.zoom.us/j/00000000000\n?pwd=a')).toBeNull()
  expect(normaliseZoomLink('https://exam\rple.zoom.us/j/00000000000')).toBeNull()
  expect(normaliseZoomLink('https://example.zoom.us/j/00000000000?pwd=a\u0000b')).toBeNull()
})

test('a Safe Links wrapper is unwrapped', () => {
  const wrapped = 'https://apc01.safelinks.protection.outlook.com/?url=' + encodeURIComponent('https://zoom.us/j/1')
  expect(unwrapLink(wrapped)).toBe('https://zoom.us/j/1')
  expect(normaliseZoomLink(wrapped)).toBe('https://zoom.us/wc/join/1')
})
