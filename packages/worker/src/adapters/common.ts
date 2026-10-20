import { setTimeout as sleep } from 'node:timers/promises'
import type { Locator, Page } from 'playwright'
import type { AdmissionResult } from './types'
import type { NavigationGuard } from './zoom/root'

// Helpers the Teams and Meet adapters share. The Zoom adapter keeps its own.

export const STEP_TIMEOUT_MS = 10_000
export const RACE_POLL_MS = 250

// Playwright's TimeoutError, by name: an action that was cut to a deadline fails with it.
export function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError'
}

// The first match that is on screen: both clients keep hidden copies of some controls in the DOM.
export function shown(page: Page, selector: string): Locator {
  return page.locator(selector).filter({ visible: true }).first()
}

// A step's action timeout: the usual step timeout, cut to what is left before the deadline (at least 1 ms, because
// Playwright reads 0 as "no timeout").
export function stepTimeout(deadline: number): number {
  return Math.max(1, Math.min(STEP_TIMEOUT_MS, deadline - Date.now()))
}

// Runs `step` until the page holds still long enough for it to finish. A navigation under it is swallowed by the guard,
// which throws after a handful in a row; a step that never completed is never read as a pass.
export async function settled<T>(guard: NavigationGuard, step: () => Promise<T>): Promise<T> {
  for (;;) {
    const result = await guard.run(step)
    if (result !== undefined) return result
    await sleep(RACE_POLL_MS)
  }
}

// A device toggle that vanished: its state can no longer be confirmed, so the join stops.
export class DeviceControlMissing extends Error {
  constructor(platform: string, name: string) {
    super(`${platform}: ${name} is not on screen, cannot confirm the device is off`)
    this.name = 'DeviceControlMissing'
  }
}

// Thrown when Leave was clicked and the end screen never showed.
export class LeaveIncomplete extends Error {
  constructor(platform: string) {
    super(`${platform}: no end screen after leaving`)
    this.name = 'LeaveIncomplete'
  }
}

// Errors Playwright raises about the page: a timeout, or a failed call (its message starts with the API name, as in
// "locator.click: ..." and "page.evaluate: ..."). A TypeError or ReferenceError is a bug in this code, not the page.
function isPageFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return isTimeout(error) || error instanceof LeaveIncomplete || /^[a-z]\w*\.[a-z]\w*: /i.test(error.message)
}

// Runs `leave` (click Leave, confirm, wait for the end screen). When the page fails it (no Leave button, no end screen
// in time) the page is closed instead, which drops the call. Any other error closes the page too, then goes on
// to the caller: a bug must not look like a clean leave. Only the error's name is logged, never its message, which can
// quote the page.
export async function leaveWithFallback(page: Page, platform: string, leave: () => Promise<void>): Promise<void> {
  try {
    await leave()
  } catch (error) {
    console.info(`${platform}: leave failed (${error instanceof Error ? error.name : 'unknown'}), closing the page`)
    await page.close()
    if (!isPageFailure(error)) throw error
  }
}

// One side-panel job at a time per page. Reading roles clicks People and then Chat, a layout pass opens panes, and a
// sweep scrolls the chat list: a second job in the middle would meet the wrong pane or move the list under the sweep and
// lose rows. A job that already holds the lock must not call another that takes it.
const queues = new WeakMap<Page, Promise<void>>()

export function withPanel<T>(page: Page, job: () => Promise<T>): Promise<T> {
  const run = (queues.get(page) ?? Promise.resolve()).then(job)
  queues.set(
    page,
    run.then(
      () => undefined,
      () => undefined
    )
  )
  return run
}

const EXPIRED = Symbol('deadline')

// Polls every `pollMs` until `poll` gives a result or `deadline` passes (reported as an expired lobby). A poll that
// hangs is cut at the deadline, so the wait never outlives it.
export async function pollAdmission(
  guard: NavigationGuard,
  poll: () => Promise<AdmissionResult | null>,
  deadline: Date,
  pollMs: number
): Promise<AdmissionResult> {
  for (;;) {
    const left = deadline.getTime() - Date.now()
    if (left <= 0) return 'lobby_expired'
    const step = guard.run(poll)
    // The abandoned poll may still fail later; nobody is waiting for it.
    step.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const cutoff = new Promise<typeof EXPIRED>((resolve) => {
      timer = setTimeout(() => resolve(EXPIRED), left)
    })
    const result = await Promise.race([step, cutoff]).finally(() => clearTimeout(timer))
    if (result === EXPIRED) return 'lobby_expired'
    if (result) return result
    await sleep(Math.min(pollMs, Math.max(0, deadline.getTime() - Date.now())))
  }
}
