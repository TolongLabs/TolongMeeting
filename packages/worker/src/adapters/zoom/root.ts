import type { Frame as PwFrame, Page } from 'playwright'
import { zoomSelectors } from './selectors'

// The frame that holds the Zoom web client: iframe#webclient when it has loaded a document (a meeting entered
// through the /j/ page), else the main frame (a /wc/join/ page). Resolved on every call, so a reloaded iframe is followed.
export async function zoomRoot(page: Page): Promise<PwFrame> {
  const { rootIframe } = await zoomSelectors()
  // elementHandles() resolves to [] when the iframe is absent. page.$() would throw "Execution context was destroyed"
  // when called during the navigation that replaces the page, which the join and admission polls hit.
  const [handle] = await page.locator(rootIframe).elementHandles()
  if (!handle) return page.mainFrame()
  try {
    const frame = await handle.contentFrame()
    // An iframe that is still loading shows about:blank, which is not the client yet.
    if (frame && frame.url() !== 'about:blank' && frame.url() !== '') return frame
    return page.mainFrame()
  } finally {
    await handle.dispose()
  }
}

// What Playwright throws when a page or iframe is replaced in the middle of a call.
const NAVIGATION_RACE =
  /Execution context was destroyed|Frame was detached|Element is not attached|Cannot find context with specified id|Target frame detached/

// Runs one poll step. When the page navigates under it (Join, admission, an iframe reload) the step is abandoned and
// undefined is returned, so the caller polls again. Any other error is thrown.
export async function duringNavigation<T>(step: () => Promise<T>): Promise<T | undefined> {
  try {
    return await step()
  } catch (error) {
    if (error instanceof Error && NAVIGATION_RACE.test(error.message)) return undefined
    throw error
  }
}
