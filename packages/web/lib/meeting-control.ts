import { ACTIVE_STATES, type OccurrenceState } from '@tm/core'

/** The words on the leave and take-over pages. `<entry>` is replaced by the entry name. */
export const CONTROL_COPY: Record<
  | 'takeOverIntro'
  | 'takeOverButton'
  | 'waiting'
  | 'takeOverNoLink'
  | 'takeOverTimeout'
  | 'takeOverAnyway'
  | 'leaveIntro'
  | 'leaveButton'
  | 'leaveDone'
  | 'leaveTimeout'
  | 'notRunning',
  string
> = {
  takeOverIntro:
    'The bot will leave <entry> first, then this page opens the meeting for you. Joining with the same account while the bot is still in can disconnect one of you.',
  takeOverButton: 'Take over now',
  waiting: 'Waiting for the bot to leave…',
  takeOverNoLink: 'The bot has left. Open the meeting from where its link was posted.',
  takeOverTimeout: "The bot hasn't confirmed that it left. If you join now, the meeting may disconnect one of you.",
  takeOverAnyway: 'Open the meeting anyway',
  leaveIntro: 'The bot will leave <entry> and stop recording. What it recorded so far stays on the meeting page.',
  leaveButton: 'Make the bot leave',
  leaveDone: 'The bot has left the meeting.',
  leaveTimeout: "The bot hasn't confirmed that it left yet. Check the meeting page in a minute.",
  notRunning: 'The bot is not in this meeting.'
}

/**
 * Polls `getState` until the bot is out of the active states (`'left'`) or `timeoutMs` has passed (`'timeout'`).
 * It asks once, then sleeps `intervalMs` between asks.
 */
export async function waitUntilLeft(
  getState: () => Promise<OccurrenceState>,
  opts: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<'left' | 'timeout'> {
  const intervalMs = opts.intervalMs ?? 1_000
  const timeoutMs = opts.timeoutMs ?? 60_000
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let waited = 0
  for (;;) {
    if (!ACTIVE_STATES.has(await getState())) return 'left'
    if (waited >= timeoutMs) return 'timeout'
    await sleep(intervalMs)
    waited += intervalMs
  }
}
