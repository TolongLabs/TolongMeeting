import { expect, test } from 'bun:test'
import { stripPasscode } from '@tm/core'

test('passcodes are stripped from meeting links', () => {
  expect(stripPasscode('https://example.zoom.us/j/00000000000?pwd=PASSCODE')).toBe(
    'https://example.zoom.us/j/00000000000'
  )
  expect(stripPasscode('https://teams.microsoft.com/meet/00000000?p=PASSCODE')).toBe(
    'https://teams.microsoft.com/meet/00000000'
  )
  expect(stripPasscode('https://example.com/x?p=1')).toBe('https://example.com/x?p=1')
  expect(stripPasscode('not a url')).toBe('')
})

test('pwd and passcode are stripped on any host, p only on the Teams hosts', () => {
  expect(stripPasscode('https://example.com/x?passcode=1&keep=2')).toBe('https://example.com/x?keep=2')
  expect(stripPasscode('https://example.com/x?pwd=1')).toBe('https://example.com/x')
  expect(stripPasscode('https://team.teams.microsoft.com/l/meetup?p=1')).toBe(
    'https://team.teams.microsoft.com/l/meetup'
  )
  expect(stripPasscode('https://teams.live.com/meet/1?p=1&x=2')).toBe('https://teams.live.com/meet/1?x=2')
  expect(stripPasscode('https://notteams.microsoft.com/x?p=1')).toBe('https://notteams.microsoft.com/x?p=1')
})

test('parameter names match in any case', () => {
  expect(stripPasscode('https://example.zoom.us/j/1?PWD=abc')).toBe('https://example.zoom.us/j/1')
  expect(stripPasscode('https://example.com/x?PassCode=1&keep=2')).toBe('https://example.com/x?keep=2')
  expect(stripPasscode('https://teams.microsoft.com/meet/1?P=abc&x=2')).toBe('https://teams.microsoft.com/meet/1?x=2')
  expect(stripPasscode('https://example.com/x?P=1')).toBe('https://example.com/x?P=1')
})

test('repeated, empty and control-character keys are all stripped', () => {
  expect(stripPasscode('https://example.zoom.us/j/1?pwd=1&pwd=2&keep=3')).toBe('https://example.zoom.us/j/1?keep=3')
  expect(stripPasscode('https://example.zoom.us/j/1?pwd=')).toBe('https://example.zoom.us/j/1')
  expect(stripPasscode('https://example.zoom.us/j/1?pwd')).toBe('https://example.zoom.us/j/1')
  expect(stripPasscode('https://example.zoom.us/j/1?pw\td=abc')).toBe('https://example.zoom.us/j/1')
  expect(stripPasscode('https://example.zoom.us/j/1?pw\nd=abc')).toBe('https://example.zoom.us/j/1')
  expect(stripPasscode('https://example.zoom.us/j/1?pwd\r=1&x=2')).toBe('https://example.zoom.us/j/1?x=2')
  expect(stripPasscode('  https://example.zoom.us/j/1?pwd=1  ')).toBe('https://example.zoom.us/j/1')
})

test('the rest of the query keeps its original encoding', () => {
  expect(stripPasscode('https://example.zoom.us/j/1?topic=a%20b+c&pwd=abc&tz=Asia%2FKuala_Lumpur#frag')).toBe(
    'https://example.zoom.us/j/1?topic=a%20b+c&tz=Asia%2FKuala_Lumpur#frag'
  )
  expect(stripPasscode('https://example.zoom.us/j/1?a=%20&b=%zz')).toBe('https://example.zoom.us/j/1?a=%20&b=%zz')
})

test('a passcode joined with a semicolon, written pwd%3D or put in the fragment is stripped too', () => {
  const zoom = 'https://us02web.zoom.us/j/123456789'
  expect(stripPasscode(`${zoom}?a=1;pwd=ABC`)).toBe(`${zoom}?a=1`)
  expect(stripPasscode(`${zoom}?pwd=ABC;a=1&b=2`)).toBe(`${zoom}?a=1&b=2`)
  expect(stripPasscode(`${zoom}?pwd%3DABC`)).toBe(zoom)
  expect(stripPasscode(`${zoom}?x=1&PWD%3dABC`)).toBe(`${zoom}?x=1`)
  expect(stripPasscode(`${zoom}#success?pwd=ABC`)).toBe(`${zoom}#success`)
  expect(stripPasscode(`${zoom}#pwd=ABC`)).toBe(zoom)
  expect(stripPasscode(`${zoom}?pwd=ABC#success`)).toBe(`${zoom}#success`)
  expect(stripPasscode(`${zoom}#a=1&passcode=ABC`)).toBe(`${zoom}#a=1`)
  expect(stripPasscode('https://teams.microsoft.com/meet/1#p=ABC')).toBe('https://teams.microsoft.com/meet/1')
  expect(stripPasscode(`${zoom}?b=%zz;pwd%3D%zz`)).toBe(`${zoom}?b=%zz`)
})
