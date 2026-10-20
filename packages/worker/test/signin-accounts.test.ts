import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { AccountCheckData, AccountKind } from '@tm/core'
import type { Page } from 'playwright'
import { checkSigninAccounts } from '../src/signin/accounts'

process.env.TM_SELECTORS_DIR ??= resolve(import.meta.dir, '../../../config/selectors')

interface FakeState {
  url: string
  /** The page's visible text, read through `body`. */
  body?: string
  /** WhatsApp's link-device code is on screen. */
  qr?: boolean
  /** WhatsApp's chat list is on screen. */
  chatList?: boolean
  /** Discord's login form is on screen. */
  loginForm?: boolean
  /** A form provider's email/password field is on screen. */
  formSignIn?: boolean
  /** Every read of the page throws, as a page that navigated away or closed under the check does. */
  broken?: boolean
  closed?: boolean
}

// A page whose URL and content are scripted, and whose locators answer the CSS selectors the checks ask for.
function fakePage(state: FakeState): Page {
  const gone = () => {
    if (state.broken) throw new Error('the page is gone')
    return state
  }
  const page = {
    url: () => state.url,
    isClosed: () => state.closed === true,
    goto: async (url: string) => {
      gone()
      state.url = url
    },
    locator: (selector: string) => {
      gone()
      const locator = {
        filter: () => locator,
        count: async (): Promise<number> => {
          gone()
          if (selector === 'body') return 1
          if (selector.includes('QR')) return state.qr === true ? 1 : 0
          if (selector === '#pane-side') return state.chatList === true ? 1 : 0
          if (selector === 'input[name="email"]') return state.loginForm === true ? 1 : 0
          if (selector.startsWith('input[type=email]')) return state.formSignIn === true ? 1 : 0
          return 0
        },
        innerText: async (): Promise<string> => gone().body ?? ''
      }
      return locator
    }
  }
  return page as unknown as Page
}

const accounts = (results: AccountCheckData[]): [AccountKind, boolean][] => results.map((r) => [r.account, r.signedIn])

test('every kind is reported signed in from the pages the session left open', async () => {
  const desk = fakePage({ url: 'https://docs.google.com/forms/u/0/' })
  const pages = [
    desk,
    fakePage({ url: 'https://zoom.us/profile' }),
    fakePage({ url: 'https://teams.microsoft.com/v2/' }),
    fakePage({ url: 'https://web.whatsapp.com/', chatList: true }),
    fakePage({ url: 'https://discord.com/channels/@me' })
  ]
  expect(accounts(await checkSigninAccounts(desk, pages))).toEqual([
    ['zoom', true],
    ['teams', true],
    ['whatsapp', true],
    ['discord', true],
    ['google', true],
    ['microsoft', true]
  ])
})

test('a sign-in page marks each new kind signed out, with the form providers', async () => {
  const desk = fakePage({ url: 'https://docs.google.com/forms/u/0/', formSignIn: true })
  const pages = [
    desk,
    fakePage({ url: 'https://zoom.us/signin' }),
    fakePage({ url: 'https://login.microsoftonline.com/' }),
    fakePage({ url: 'https://web.whatsapp.com/', qr: true }),
    fakePage({ url: 'https://discord.com/login' })
  ]
  expect(accounts(await checkSigninAccounts(desk, pages))).toEqual([
    ['zoom', false],
    ['teams', false],
    ['whatsapp', false],
    ['discord', false],
    ['google', false],
    ['microsoft', false]
  ])
})

test('Zoom counts as signed in only without its sign-in-required text', async () => {
  const desk = fakePage({ url: 'https://docs.google.com/forms/u/0/' })
  const required = fakePage({ url: 'https://zoom.us/profile', body: 'Sign in to join this meeting' })
  const checks = await checkSigninAccounts(desk, [desk, required])
  expect(checks.find((c) => c.account === 'zoom')).toEqual({ account: 'zoom', signedIn: false })
})

test('an unreadable page or a page that is gone is unknown, never signed in', async () => {
  const desk = fakePage({ url: 'https://docs.google.com/forms/u/0/' })
  const pages = [
    desk,
    fakePage({ url: 'https://zoom.us/profile', broken: true }),
    fakePage({ url: 'https://web.whatsapp.com/' }),
    fakePage({ url: 'https://discord.com/channels/@me' })
  ]
  // No Teams tab at all: unknown, like a page that could not be read.
  expect(accounts(await checkSigninAccounts(desk, pages))).toEqual([
    ['discord', true],
    ['google', true],
    ['microsoft', true]
  ])
})

test('a closed page is not read for its kind', async () => {
  const desk = fakePage({ url: 'https://docs.google.com/forms/u/0/' })
  const closed = fakePage({ url: 'https://zoom.us/profile', closed: true })
  expect(accounts(await checkSigninAccounts(desk, [desk, closed]))).toEqual([
    ['google', true],
    ['microsoft', true]
  ])
})

test('a page that is not on the kind’s host is not used for it', async () => {
  const desk = fakePage({ url: 'https://docs.google.com/forms/u/0/' })
  const elsewhere = fakePage({ url: 'https://example.com/', chatList: true })
  expect(accounts(await checkSigninAccounts(desk, [desk, elsewhere]))).toEqual([
    ['google', true],
    ['microsoft', true]
  ])
})
