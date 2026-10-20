import type { Page } from 'playwright'
import { openDeskTab } from '../chrome/launch'

const LOAD_TIMEOUT_MS = 15_000

/**
 * Opens each URL in a new tab of the desk window and returns what closes them again. A page that does not load is
 * reported and left open (the member can type the address); a tab that cannot be opened stops the rest, closes the ones
 * already open and throws. Closing throws when a tab is still open afterwards. The first tab is brought to the front, so
 * the desk window is raised and focused when the member arrives.
 */
export async function openSigninTabs(
  desk: Page,
  urls: string[],
  report: (error: unknown) => void
): Promise<() => Promise<void>> {
  const tabs: Page[] = []
  const closeAll = async (): Promise<void> => {
    const errors: unknown[] = []
    for (const tab of tabs.splice(0)) {
      if (tab.isClosed()) continue
      try {
        await tab.close()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'sign-in tabs did not close')
  }
  try {
    for (const url of urls) {
      const tab = await openDeskTab(desk)
      tabs.push(tab)
      try {
        // The response is enough: the member does not wait for a slow page's scripts.
        await tab.goto(url, { waitUntil: 'commit', timeout: LOAD_TIMEOUT_MS })
      } catch (error) {
        report(error)
      }
    }
    await tabs[0]?.bringToFront()
  } catch (error) {
    await closeAll()
    throw error
  }
  return closeAll
}

/**
 * The desk page the worker keeps as an anchor tab: while it stays open, the member closing the sign-in tabs cannot end the
 * desk window. When the member closed it, a new tab takes its place in the desk window; call this before closing the
 * sign-in tabs, so the window is never empty. Returns the page to use from then on. A desk window the member closed
 * entirely cannot be brought back here: openDeskTab throws.
 */
export async function restoreDeskAnchor(desk: Page): Promise<Page> {
  if (!desk.isClosed()) return desk
  return openDeskTab(desk.context())
}
