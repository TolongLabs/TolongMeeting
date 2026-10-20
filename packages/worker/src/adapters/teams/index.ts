import { normaliseTeamsLink } from '@tm/core'
import type { PlatformAdapter } from '../types'
import { readTeamsChat, sweepTeamsChat } from './chat'
import { assertTeamsDevicesOff, connectTeamsOutputAudio, dismissTeamsNotices, leaveTeams } from './controls'
import { joinTeams } from './join'
import { ensureTeamsLayout, teamsParticipantCount, teamsSharedScreenRegion } from './layout'
import { teamsMeetingState, waitTeamsAdmitted } from './state'
import { teamsSelectors, type TeamsSelectors } from './selectors'

export { TeamsSelectorsSchema, teamsSelectors } from './selectors'

// How long each adapter method may take, in ms. `normaliseLink` is pure and `waitUntilAdmitted` is bounded by its own
// deadline, so neither is listed.
export const TEAMS_TIMEOUTS = {
  join: 100_000,
  connectOutputAudio: 15_000,
  ensureLayout: 15_000,
  assertDevicesOff: 5_000,
  readChat: 20_000,
  sweepChat: 120_000,
  sharedScreenRegion: 5_000,
  participantCount: 5_000,
  meetingState: 5_000,
  dismissNotices: 5_000,
  leave: 20_000
} as const

export type TeamsTimeouts = { readonly [K in keyof typeof TEAMS_TIMEOUTS]: number }

// The join step runs to its own deadline a little before the adapter's limit, so a slow join reports a result, not a
// timeout.
const JOIN_HEADROOM = 0.9

// Rejects when `step` has not settled after `ms`. The step itself cannot be cancelled: its late result or error is
// dropped, not left unhandled.
async function within<T>(method: string, ms: number, step: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`teams ${method} timed out after ${ms} ms`)), ms)
  })
  step.catch(() => undefined)
  try {
    return await Promise.race([step, limit])
  } finally {
    clearTimeout(timer)
  }
}

// The Teams adapter with its own limits (tests use short ones; `teamsAdapter` uses `TEAMS_TIMEOUTS`).
export function buildTeamsAdapter(timeouts: TeamsTimeouts): PlatformAdapter {
  // Read on first use. A failed read is not kept, so the next call reads again.
  let loaded: Promise<TeamsSelectors> | null = null
  const selectors = () => {
    loaded ??= teamsSelectors().catch((error: unknown) => {
      loaded = null
      throw error
    })
    return loaded
  }
  const run = <T>(method: keyof TeamsTimeouts, step: (sel: TeamsSelectors) => Promise<T>): Promise<T> =>
    within(
      method,
      timeouts[method],
      selectors().then((sel) => step(sel))
    )

  return {
    platform: 'teams',
    normaliseLink: normaliseTeamsLink,
    // Teams has no guest path: a join that needs a name is refused, so `guestName` is not used.
    join: (page) => run('join', (sel) => joinTeams(page, sel, Math.round(timeouts.join * JOIN_HEADROOM))),
    connectOutputAudio: (page) => run('connectOutputAudio', (sel) => connectTeamsOutputAudio(page, sel)),
    ensureLayout: (page) => run('ensureLayout', (sel) => ensureTeamsLayout(page, sel)),
    waitUntilAdmitted: async (page, deadline) => waitTeamsAdmitted(page, await selectors(), deadline),
    assertDevicesOff: (page) => run('assertDevicesOff', (sel) => assertTeamsDevicesOff(page, sel)),
    readChat: (page, cursor) => run('readChat', (sel) => readTeamsChat(page, sel, cursor)),
    sweepChat: (page) => run('sweepChat', (sel) => sweepTeamsChat(page, sel)),
    sharedScreenRegion: (page) => run('sharedScreenRegion', (sel) => teamsSharedScreenRegion(page, sel)),
    participantCount: (page) => run('participantCount', (sel) => teamsParticipantCount(page, sel)),
    meetingState: (page) => run('meetingState', (sel) => teamsMeetingState(page, sel)),
    dismissNotices: (page) => run('dismissNotices', (sel) => dismissTeamsNotices(page, sel)),
    leave: (page) => run('leave', (sel) => leaveTeams(page, sel))
  }
}

export const teamsAdapter: PlatformAdapter = buildTeamsAdapter(TEAMS_TIMEOUTS)
