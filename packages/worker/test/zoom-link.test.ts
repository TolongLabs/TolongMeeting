import { expect, test } from 'bun:test'
import { adapterFor } from '../src/adapters'
import { zoomAdapter } from '../src/adapters/zoom'

// Review focus: every Zoom link variant becomes the /wc/join/ web-client URL or null, never the /j/ launcher page.
test('every Zoom link becomes the web-client join URL or null', () => {
  const n = zoomAdapter.normaliseLink
  expect(n('https://us06web.zoom.us/j/00000000000?pwd=PWD')).toBe('https://us06web.zoom.us/wc/join/00000000000?pwd=PWD')
  expect(n('https://zoom.us/j/00000000000')).toBe('https://zoom.us/wc/join/00000000000')
  expect(n('https://example-uni.zoom.us/j/00000000000?pwd=PWD#success')).toBe(
    'https://example-uni.zoom.us/wc/join/00000000000?pwd=PWD'
  )
  expect(n('https://app.zoom.us/wc/00000000000/join?pwd=PWD')).toBe('https://app.zoom.us/wc/join/00000000000?pwd=PWD')
  expect(n('https://example-uni.zoom.us/wc/join/00000000000?pwd=PWD')).toBe(
    'https://example-uni.zoom.us/wc/join/00000000000?pwd=PWD'
  )
  expect(
    n('https://apc01.safelinks.protection.outlook.com/?url=' + encodeURIComponent('https://zoom.us/j/00000000000'))
  ).toBe('https://zoom.us/wc/join/00000000000')
  expect(n('https://example-uni.zoom.us/my/lecturer')).toBeNull()
  expect(n('https://zoom.us.example.com/j/00000000000')).toBeNull()
  expect(n('https://teams.microsoft.com/l/meetup-join/x')).toBeNull()
  expect(adapterFor('https://zoom.us/j/00000000000')).toBe(zoomAdapter)
})

test('fragments on /wc/ links are dropped and the query is kept', () => {
  const n = zoomAdapter.normaliseLink
  expect(n('https://example-uni.zoom.us/wc/join/00000000000?pwd=PWD#success')).toBe(
    'https://example-uni.zoom.us/wc/join/00000000000?pwd=PWD'
  )
  expect(n('https://zoom.us/j/00000000000?pwd=PWD&uname=Member%20Guest#success')).toBe(
    'https://zoom.us/wc/join/00000000000?pwd=PWD&uname=Member%20Guest'
  )
  expect(n('  https://zoom.us/j/00000000000/  ')).toBe('https://zoom.us/wc/join/00000000000')
})

test('look-alike hosts, other schemes and other Zoom paths are refused', () => {
  const n = zoomAdapter.normaliseLink
  expect(n('https://evilzoom.us/j/00000000000')).toBeNull()
  expect(n('https://zoom.us.example.com/wc/join/00000000000')).toBeNull()
  expect(n('https://example.com/zoom.us/j/00000000000')).toBeNull()
  expect(n('https://zoom.us@example.com/j/00000000000')).toBeNull()
  expect(n('https://zoom.us:8443/j/00000000000')).toBeNull()
  expect(n('http://zoom.us/j/00000000000')).toBeNull()
  expect(n('https://zoom.us/')).toBeNull()
  expect(n('https://zoom.us/j/')).toBeNull()
  expect(n('https://zoom.us/j/not-a-number')).toBeNull()
  expect(n('https://zoom.us/s/00000000000')).toBeNull()
  expect(n('https://zoom.us/wc/00000000000/start')).toBeNull()
  expect(n('https://us06web.zoom.us/postattendee?mn=00000000000')).toBeNull()
  expect(n('zoom.us/j/00000000000')).toBeNull()
  expect(n('not a url')).toBeNull()
  expect(n('')).toBeNull()
})

test('adapterFor finds no adapter for other platforms', () => {
  expect(adapterFor('https://teams.microsoft.com/l/meetup-join/x')).toBeNull()
  expect(adapterFor('https://example-uni.zoom.us/my/lecturer')).toBeNull()
})
