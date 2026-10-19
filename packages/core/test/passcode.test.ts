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
