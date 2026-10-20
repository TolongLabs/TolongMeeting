import { normaliseMeetLink } from '@tm/core'
import type { PlatformAdapter } from '../types'
import { readMeetChat, sweepMeetChat } from './chat'
import { assertMeetDevicesOff, connectMeetOutputAudio, dismissMeetNotices, leaveMeet } from './controls'
import { joinMeet } from './join'
import { ensureMeetLayout, meetParticipantCount, meetSharedScreenRegion } from './layout'
import { meetMeetingState, waitMeetAdmitted } from './state'
import { meetSelectors, type MeetSelectors } from './selectors'

export { MeetSelectorsSchema, meetSelectors } from './selectors'

// How long each adapter method may take, in ms. `normaliseLink` is pure and `waitUntilAdmitted` is bounded by its own
// deadline, so neither is listed.
export const MEET_TIMEOUTS = {
  join: 100_000,
  connectOutputAudio: 15_000,
  ensureLayout: 20_000,
  assertDevicesOff: 5_000,
  readChat: 20_000,
  sweepChat: 120_000,
  sharedScreenRegion: 5_000,
  participantCount: 5_000,
  meetingState: 5_000,
  dismissNotices: 5_000,
  leave: 20_000
} as const

export type MeetTimeouts = { readonly [K in keyof typeof MEET_TIMEOUTS]: number }

// The join step runs to its own deadline a little before the adapter's limit, so a slow join reports a result, not a
// timeout.
const JOIN_HEADROOM = 0.9

// Rejects when `step` has not settled after `ms`. The step itself cannot be cancelled: its late result or error is
// dropped, not left unhandled.
async function within<T>(method: string, ms: number, step: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`meet ${method} timed out after ${ms} ms`)), ms)
  })
  step.catch(() => undefined)
  try {
    return await Promise.race([step, limit])
  } finally {
    clearTimeout(timer)
  }
}

// The Meet adapter with its own limits (tests use short ones; `meetAdapter` uses `MEET_TIMEOUTS`).
export function buildMeetAdapter(timeouts: MeetTimeouts): PlatformAdapter {
  // Read on first use. A failed read is not kept, so the next call reads again.
  let loaded: Promise<MeetSelectors> | null = null
  const selectors = () => {
    loaded ??= meetSelectors().catch((error: unknown) => {
      loaded = null
      throw error
    })
    return loaded
  }
  const run = <T>(method: keyof MeetTimeouts, step: (sel: MeetSelectors) => Promise<T>): Promise<T> =>
    within(
      method,
      timeouts[method],
      selectors().then((sel) => step(sel))
    )

  return {
    platform: 'meet',
    normaliseLink: normaliseMeetLink,
    // The bot joins as the signed-in member: a pre-join that asks for a name is refused, so `guestName` is not used.
    join: (page) => run('join', (sel) => joinMeet(page, sel, Math.round(timeouts.join * JOIN_HEADROOM))),
    connectOutputAudio: (page) => run('connectOutputAudio', (sel) => connectMeetOutputAudio(page, sel)),
    ensureLayout: (page) => run('ensureLayout', (sel) => ensureMeetLayout(page, sel)),
    waitUntilAdmitted: async (page, deadline) => waitMeetAdmitted(page, await selectors(), deadline),
    assertDevicesOff: (page) => run('assertDevicesOff', (sel) => assertMeetDevicesOff(page, sel)),
    readChat: (page, cursor) => run('readChat', (sel) => readMeetChat(page, sel, cursor)),
    sweepChat: (page) => run('sweepChat', (sel) => sweepMeetChat(page, sel)),
    sharedScreenRegion: (page) => run('sharedScreenRegion', (sel) => meetSharedScreenRegion(page, sel)),
    participantCount: (page) => run('participantCount', (sel) => meetParticipantCount(page, sel)),
    meetingState: (page) => run('meetingState', (sel) => meetMeetingState(page, sel)),
    dismissNotices: (page) => run('dismissNotices', (sel) => dismissMeetNotices(page, sel)),
    leave: (page) => run('leave', (sel) => leaveMeet(page, sel))
  }
}

export const meetAdapter: PlatformAdapter = buildMeetAdapter(MEET_TIMEOUTS)
