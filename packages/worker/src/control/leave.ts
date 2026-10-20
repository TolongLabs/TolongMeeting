import type { Page } from 'playwright'
import type { PlatformAdapter } from '../adapters/types'

const CONFIRM_MS = 10_000
const POLL_MS = 500
// A leave confirmation dialog or a reload hides the toolbar, so `unknown` alone proves nothing; this many in a row do.
const UNKNOWN_READS = 3

/**
 * Leaves the meeting on the stage page. Outside a meeting or its lobby there is nothing to click, so it says `left`
 * at once. Otherwise it calls `adapter.leave` and polls `meetingState` for up to `confirmMs` after the click. Only
 * `ended` or `removed`, or `unknown` on 3 reads in a row, confirms `left`. If that does not happen in time, or `leave`
 * or `meetingState` throws, it closes the stage page and says `closed`. Only the stage page is touched. Nothing the
 * command carried is read or logged here.
 */
export async function leaveMeeting(
  stage: Page,
  adapter: PlatformAdapter,
  opts: { confirmMs?: number; pollMs?: number } = {}
): Promise<'left' | 'closed'> {
  const confirmMs = opts.confirmMs ?? CONFIRM_MS
  const pollMs = opts.pollMs ?? POLL_MS
  try {
    const before = await adapter.meetingState(stage)
    if (before !== 'in_meeting' && before !== 'lobby') return 'left'
    await adapter.leave(stage)
    const deadline = Date.now() + confirmMs
    let unknownReads = 0
    while (Date.now() < deadline) {
      const state = await adapter.meetingState(stage)
      if (state === 'ended' || state === 'removed') return 'left'
      unknownReads = state === 'unknown' ? unknownReads + 1 : 0
      if (unknownReads >= UNKNOWN_READS) return 'left'
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))))
    }
  } catch {
    // The page cannot be read or clicked: close it, so the bot is out whatever state the meeting is in.
  }
  return closeStage(stage)
}

async function closeStage(stage: Page): Promise<'closed'> {
  await stage.close({ runBeforeUnload: false })
  return 'closed'
}
