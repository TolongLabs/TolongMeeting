import { expect, test, type Page } from '@playwright/test'
import { driverFor } from '../src/forms/drivers'
import {
  OpenTimeoutError,
  TabCloseFailedError,
  TabNotOnDeskError,
  openDeskTab,
  openForm,
  waitForTabSignin
} from '../src/forms/open'
import { googleUrl, routeFormFixtures } from './forms/route'

const windowOf = async (p: Page) =>
  (await (await p.context().newCDPSession(p)).send('Browser.getWindowForTarget')).windowId

test('opens the form tab in the desk window, muted', async ({ page: desk }) => {
  const tab = await openDeskTab(desk)
  expect(await windowOf(tab)).toBe(await windowOf(desk))
  expect(await tab.evaluate(() => Symbol.for('tm.deskMuted') in window)).toBe(true)
})

test('refuses and closes a tab that opened in another window', async ({ page: desk }) => {
  const popup = async () => {
    const [p] = await Promise.all([
      desk.waitForEvent('popup'),
      desk.evaluate(() => window.open('about:blank', '_blank', 'popup,left=2000,top=0,width=600,height=400'))
    ])
    return p
  }
  await expect(openDeskTab(desk, popup)).rejects.toThrow(TabNotOnDeskError)
  expect(desk.context().pages()).toHaveLength(1)
})

test('says so when a tab outside the desk window cannot be closed', async ({ page: desk }) => {
  let popupPage: Page | undefined
  const stubborn = async () => {
    const [p] = await Promise.all([
      desk.waitForEvent('popup'),
      desk.evaluate(() => window.open('about:blank', '_blank', 'popup,left=2000,top=0,width=600,height=400'))
    ])
    popupPage = p
    p.close = async () => {
      throw new Error('close refused')
    }
    return p
  }
  const error = await openDeskTab(desk, stubborn).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(TabCloseFailedError)
  expect(error).not.toBeInstanceOf(TabNotOnDeskError)
  expect(popupPage!.isClosed()).toBe(false)
  delete (popupPage as Partial<Page>).close // the prototype close again
  await popupPage!.close()
})

test('closes a tab that fails after it opened, then rethrows', async ({ browser, page: desk }) => {
  // a page of another context: the desk's context cannot attach a CDP session to it
  const other = await browser.newContext()
  try {
    const foreign = await other.newPage()
    await expect(openDeskTab(desk, async () => foreign)).rejects.toThrow()
    expect(foreign.isClosed()).toBe(true)
    expect(desk.context().pages()).toHaveLength(1)
  } finally {
    await other.close()
  }
})

test('reports form, signin and timeouts', async ({ context, page: desk }) => {
  const fx = await routeFormFixtures(context)
  const driver = await driverFor('google')
  const tab = await openDeskTab(desk)
  expect(await openForm(tab, googleUrl('attendance'), driver)).toBe('form')
  fx.signedOut.add('attendance')
  expect(await openForm(tab, googleUrl('attendance'), driver)).toBe('signin')
  fx.delayMs.set('quiz', 5_000)
  await expect(openForm(tab, googleUrl('quiz'), driver, 1_000)).rejects.toThrow(OpenTimeoutError)
})

test('always opens the plain form, never a pre-filled or direct-submit link', async ({ context, page: desk }) => {
  const fx = await routeFormFixtures(context)
  const driver = await driverFor('google')
  const tab = await openDeskTab(desk)
  const plain = googleUrl('attendance')
  for (const posted of [
    `${plain}?usp=pp_url&entry.1=Aisyah`,
    plain.replace('/viewform', '/formResponse?entry.1=Aisyah&submit=Submit')
  ]) {
    expect(await openForm(tab, posted, driver)).toBe('form')
    expect(tab.url()).toBe(plain)
  }
  expect(fx.requests.filter((u) => u.includes('formResponse'))).toEqual([])
  expect(fx.requests.every((u) => u === plain)).toBe(true)
  expect(fx.submissions).toEqual([])
})

test('waits for the tab to come back to the form, without typing', async ({ context, page: desk }) => {
  const fx = await routeFormFixtures(context)
  const driver = await driverFor('google')
  const tab = await openDeskTab(desk)
  fx.signedOut.add('attendance')
  await openForm(tab, googleUrl('attendance'), driver)
  const waiting = waitForTabSignin(tab, driver, new AbortController().signal, 10_000)
  expect(await tab.inputValue('input[type=email]')).toBe('')
  fx.signedOut.delete('attendance')
  await tab.click('text=Continue')
  expect(await waiting).toBe(true)
})

test('stops waiting on abort or timeout', async ({ context, page: desk }) => {
  const fx = await routeFormFixtures(context)
  const driver = await driverFor('google')
  const tab = await openDeskTab(desk)
  fx.signedOut.add('attendance')
  await openForm(tab, googleUrl('attendance'), driver)
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 500)
  expect(await waitForTabSignin(tab, driver, ac.signal, 10_000)).toBe(false)
  expect(await waitForTabSignin(tab, driver, new AbortController().signal, 1_000)).toBe(false)
})
