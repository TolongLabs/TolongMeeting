import { expect, test } from 'bun:test'
import { signinUrlsFor } from '../src/control/desk-tabs'
import { SIGNIN_START_URLS } from '../src/control/vnc'

test('a sign-in pause leaves out the hosts that already have a tab', () => {
  expect(signinUrlsFor(SIGNIN_START_URLS)).toEqual(SIGNIN_START_URLS)
  const urls = signinUrlsFor(SIGNIN_START_URLS, ['web.whatsapp.com'])
  expect(urls).toHaveLength(SIGNIN_START_URLS.length - 1)
  expect(urls.some((u) => u.includes('web.whatsapp.com'))).toBe(false)
  expect(signinUrlsFor(SIGNIN_START_URLS, ['discord.com'])).not.toContain('https://discord.com/login')
})
