import { canonicalFormUrl } from '@tm/core'
import { errors, type Page } from 'playwright'
import { TabCloseFailedError, TabNotOnDeskError, openDeskTab } from '../chrome/launch'
import type { FormDriver } from './drivers'
import type { PageKind } from './types'

// Both come from chrome/launch.ts: there is one openDeskTab, and a form tab is a desk tab.
export { TabCloseFailedError, TabNotOnDeskError, openDeskTab }

export class OpenTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpenTimeoutError'
  }
}

export const OPEN_TIMEOUT_MS = 15_000
export const SIGNIN_WAIT_MS = 15 * 60_000 // matches the sign-in pause's 15-minute idle limit
export const SIGNIN_POLL_MS = 2_000
const OPEN_POLL_MS = 250

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// The page is mid-navigation (a sign-in redirect, a form submit): the read is repeated. These are Playwright's messages
// for that race; anything else is a real error and is thrown.
const NAVIGATION_RACE =
  /execution context was destroyed|frame was detached|navigation .*interrupted|interrupted by another navigation/i
const isNavigationRace = (error: unknown): boolean => error instanceof Error && NAVIGATION_RACE.test(error.message)

// pageKind, repeated while the page is changing under it.
async function kindOf(tab: Page, driver: FormDriver): Promise<PageKind | 'navigating'> {
  try {
    return await driver.pageKind(tab)
  } catch (error) {
    if (isNavigationRace(error)) return 'navigating'
    throw error
  }
}

// Opens the plain form page, never the link as posted: a pre-filled or direct-submit link must not answer anything
// before the handler has looked. Returns the first kind that is not 'unknown'.
export async function openForm(
  tab: Page,
  url: string,
  driver: FormDriver,
  timeoutMs = OPEN_TIMEOUT_MS
): Promise<PageKind> {
  const target = canonicalFormUrl(url)
  const deadline = Date.now() + timeoutMs
  try {
    await tab.goto(target, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  } catch (error) {
    if (error instanceof errors.TimeoutError) throw new OpenTimeoutError(`the form did not load within ${timeoutMs} ms`)
    throw error
  }
  for (;;) {
    const kind = await kindOf(tab, driver)
    if (kind !== 'unknown' && kind !== 'navigating') return kind
    const left = deadline - Date.now()
    if (left <= 0) throw new OpenTimeoutError(`the form page was not recognised within ${timeoutMs} ms`)
    await sleep(Math.min(OPEN_POLL_MS, left))
  }
}

// Sleeps `ms`, or less if the signal aborts.
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done)
  })
}

// Waits for the member to finish signing in, in this tab, through the desk view: true once the tab shows the form,
// false on abort or timeout. It only reads the page: it never clicks, types or navigates.
export async function waitForTabSignin(
  tab: Page,
  driver: FormDriver,
  signal: AbortSignal,
  timeoutMs = SIGNIN_WAIT_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!signal.aborted) {
    if ((await kindOf(tab, driver)) === 'form') return true
    const left = deadline - Date.now()
    if (left <= 0) return false
    await abortableSleep(Math.min(SIGNIN_POLL_MS, left), signal)
  }
  return false
}
