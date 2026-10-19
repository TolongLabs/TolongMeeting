import type { ElementHandle, Frame as PwFrame, Page } from 'playwright'
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
    const frame = await contentFrameOf(handle)
    // An iframe that is still loading shows about:blank, which is not the client yet.
    if (frame && frame.url() !== 'about:blank' && frame.url() !== '') return frame
    return page.mainFrame()
  } finally {
    await handle.dispose()
  }
}

// Thrown by zoomRoot when the iframe element was replaced between finding it and reading its document: the one place
// "Element is not attached" is a navigation race rather than a real fault.
export class NavigationRace extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'NavigationRace'
  }
}

async function contentFrameOf(handle: ElementHandle): Promise<PwFrame | null> {
  try {
    return await handle.contentFrame()
  } catch (error) {
    if (error instanceof Error && /Element is not attached/.test(error.message)) throw new NavigationRace(error)
    throw error
  }
}

// What Playwright throws when a page or iframe is replaced in the middle of a call. Each has a name for the log.
const NAVIGATION_RACES: { name: string; pattern: RegExp }[] = [
  { name: 'context-destroyed', pattern: /Execution context was destroyed/ },
  { name: 'frame-detached', pattern: /Frame was detached|Target frame detached/ },
  { name: 'context-missing', pattern: /Cannot find context with specified id/ }
]

// The most races in a row one call site swallows; the next one is thrown, because a page that never settles is a
// fault, not a navigation.
export const MAX_CONSECUTIVE_RACES = 5

function raceName(error: unknown): string | null {
  if (error instanceof NavigationRace) return 'element-detached'
  if (!(error instanceof Error)) return null
  return NAVIGATION_RACES.find((race) => race.pattern.test(error.message))?.name ?? null
}

export interface NavigationGuard {
  // Runs one poll step. When the page navigates under it (Join, admission, an iframe reload) the step is abandoned and
  // undefined is returned, so the caller polls again. Any other error, and the race after MAX_CONSECUTIVE_RACES in a
  // row, is thrown as it came. A step that finishes resets the count.
  run<T>(step: () => Promise<T>): Promise<T | undefined>
  // The message of the last race swallowed, or null.
  readonly lastRace: string | null
}

// One guard per call site (one poll loop). The log holds the step name and the matched pattern only, never page text.
export function navigationGuard(stepName: string): NavigationGuard {
  let streak = 0
  let lastRace: string | null = null
  return {
    get lastRace() {
      return lastRace
    },
    async run<T>(step: () => Promise<T>): Promise<T | undefined> {
      try {
        const result = await step()
        streak = 0
        return result
      } catch (error) {
        const race = raceName(error)
        if (race === null || !(error instanceof Error)) throw error
        streak += 1
        if (streak > MAX_CONSECUTIVE_RACES) throw error
        lastRace = error.message.split('\n')[0]!.slice(0, 200)
        console.info(`zoom: navigation race in ${stepName} (${race}), ${streak} in a row`)
        return undefined
      }
    }
  }
}

// A single step with no loop around it: the race is swallowed once and logged.
export function duringNavigation<T>(stepName: string, step: () => Promise<T>): Promise<T | undefined> {
  return navigationGuard(stepName).run(step)
}
