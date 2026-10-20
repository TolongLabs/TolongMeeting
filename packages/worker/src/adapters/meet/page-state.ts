import type { SenderRole } from '@tm/core'
import type { Page } from 'playwright'

// What the Meet adapter remembers about one page between calls.
export interface MeetPageState {
  // Sender (trimmed, lower-cased) to role, read from the People panel; null until the first read.
  roles: Map<string, SenderRole> | null
  // True once the layout pass has spotlighted the current screen share; reset when the share goes away.
  shareSeen: boolean
}

const states = new WeakMap<Page, MeetPageState>()

export function meetState(page: Page): MeetPageState {
  let state = states.get(page)
  if (state === undefined) {
    state = { roles: null, shareSeen: false }
    states.set(page, state)
  }
  return state
}
