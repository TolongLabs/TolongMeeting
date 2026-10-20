import type { Page } from 'playwright'
import type { SenderRole } from '@tm/core'

// What the Teams adapter remembers about one page between calls.
export interface TeamsPageState {
  // When the join succeeded (Date.now()); chat older than the join is not this meeting's. Null before the join.
  joinedAt: number | null
  // Sender name to role, read from the roster; null until the first roster read.
  roles: Map<string, SenderRole> | null
  // True once the shared screen has been focused on, so the layout step runs once per share.
  shareSeen: boolean
}

const states = new WeakMap<Page, TeamsPageState>()

// One entry per page, created on first use and dropped with the page.
export function teamsState(page: Page): TeamsPageState {
  let state = states.get(page)
  if (!state) {
    state = { joinedAt: null, roles: null, shareSeen: false }
    states.set(page, state)
  }
  return state
}
