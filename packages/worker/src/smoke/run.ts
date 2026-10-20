import type { Page } from 'playwright'
import { adapterFor } from '../adapters'
import type { SmokeEntry } from './entries'

// How long the standing meeting's lobby may hold the bot, and how long a key gets to appear after its step.
const LOBBY_WAIT_MS = 2 * 60_000
const KEY_WAIT_MS = 5_000
const POLL_MS = 250

// True when the selector matches an element in any frame of the page. A Playwright locator, so `text=` and
// `:text-matches` selectors work as well as CSS.
async function matches(page: Page, selector: string): Promise<boolean> {
  for (const frame of page.frames()) if ((await frame.locator(selector).count()) > 0) return true
  return false
}

async function appears(page: Page, selector: string): Promise<boolean> {
  const end = Date.now() + KEY_WAIT_MS
  for (;;) {
    if (await matches(page, selector)) return true
    if (Date.now() >= end) return false
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

/**
 * Joins the platform's standing test meeting at `url`, reads it the way a run does and leaves. Returns what is missing:
 * a selector key (a selector from `entry.selectors()` that matches no element at its checkpoint) or `step:<name>` (an
 * adapter step that threw or gave an unexpected result). The run goes on after a failure, so one report lists everything, except that a failed device check leaves at once.
 * A selector map that cannot be read throws.
 */
export async function runSmokeEntry(page: Page, entry: SmokeEntry, url: string): Promise<{ missing: string[] }> {
  const adapter = adapterFor(url)
  if (adapter?.platform !== entry.platform) throw new Error(`the smoke link is not a ${entry.platform} link`)
  const link = adapter.normaliseLink(url)
  if (link === null) throw new Error(`the smoke link is not a ${entry.platform} link`)
  const { selectors } = await entry.selectors()
  const missing = new Set<string>()

  const step = async (name: string, run: () => Promise<boolean | void>): Promise<void> => {
    try {
      if ((await run()) === false) missing.add(`step:${name}`)
    } catch (error) {
      console.error(`smoke: ${entry.platform} ${name} failed: ${error instanceof Error ? error.name : 'error'}`)
      missing.add(`step:${name}`)
    }
  }
  const check = async (keys: string[]): Promise<void> => {
    await Promise.all(
      keys.map(async (key) => {
        const selector = selectors[key]
        if (selector === undefined) throw new Error(`smoke key ${key} is not in the ${entry.platform} selector map`)
        if (!(await appears(page, selector))) missing.add(key)
      })
    )
  }

  await step('goto', async () => {
    await page.goto(link, { waitUntil: 'domcontentloaded' })
  })
  await step('join', async () => {
    const joined = await adapter.join(page, { guestName: null })
    if (joined.kind === 'in_meeting') return true
    if (joined.kind !== 'lobby') return false
    return (await adapter.waitUntilAdmitted(page, new Date(Date.now() + LOBBY_WAIT_MS))) === 'admitted'
  })
  await check(entry.checkpoints.inMeeting)
  await step('assertDevicesOff', () => adapter.assertDevicesOff(page))
  // The bot is live in a real meeting with a device on, or could not tell: it leaves at once and touches nothing else.
  if (missing.has('step:assertDevicesOff')) {
    await step('leave', () => adapter.leave(page))
    return { missing: [...missing] }
  }
  await step('connectOutputAudio', () => adapter.connectOutputAudio(page))
  await step('ensureLayout', () => adapter.ensureLayout(page))
  await check(entry.checkpoints.afterLayout)
  await step('readChat', async () => void (await adapter.readChat(page, { seenKeys: [] })))
  await step('sweepChat', async () => void (await adapter.sweepChat(page)))
  await step('participantCount', async () => void (await adapter.participantCount(page)))
  await step('meetingState', async () => (await adapter.meetingState(page)) === 'in_meeting')
  await check(entry.checkpoints.afterSweep)
  await step('leave', () => adapter.leave(page))
  await check(entry.checkpoints.afterLeave)
  return { missing: [...missing] }
}
