import type { Page } from 'playwright'
import type { PlatformAdapter } from '../adapters/types'

const CONFIRM_MS = 10_000
const POLL_MS = 500

/**
 * Leaves the meeting on the stage page. Outside a meeting or its lobby there is nothing to click, so it says `left`
 * at once. Otherwise it calls `adapter.leave` and polls `meetingState` until the page is neither in the meeting nor in
 * the lobby. If that does not happen within `confirmMs`, or `leave` throws, it closes the stage page and says `closed`.
 * Only the stage page is touched. Nothing the command carried is read or logged here.
 */
export async function leaveMeeting(
  stage: Page,
  adapter: PlatformAdapter,
  opts: { confirmMs?: number; pollMs?: number } = {}
): Promise<'left' | 'closed'> {
  const confirmMs = opts.confirmMs ?? CONFIRM_MS
  const pollMs = opts.pollMs ?? POLL_MS
  if (!(await inMeetingOrLobby(stage, adapter))) return 'left'
  const deadline = Date.now() + confirmMs
  try {
    await adapter.leave(stage)
  } catch {
    return closeStage(stage)
  }
  while (Date.now() < deadline) {
    if (!(await inMeetingOrLobby(stage, adapter))) return 'left'
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))))
  }
  if (!(await inMeetingOrLobby(stage, adapter))) return 'left'
  return closeStage(stage)
}

async function inMeetingOrLobby(stage: Page, adapter: PlatformAdapter): Promise<boolean> {
  const state = await adapter.meetingState(stage)
  return state === 'in_meeting' || state === 'lobby'
}

async function closeStage(stage: Page): Promise<'closed'> {
  await stage.close({ runBeforeUnload: false })
  return 'closed'
}
