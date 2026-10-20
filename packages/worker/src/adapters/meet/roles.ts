import type { SenderRole } from '@tm/core'
import type { Page } from 'playwright'
import { shown, withPanel } from '../common'
import { rolesByName } from '../roles'
import { meetState } from './page-state'
import type { MeetSelectors } from './selectors'

const CLICK_MS = 5_000

export function roleFromMeetLabel(label: string): SenderRole {
  if (/\bco-?host\b/i.test(label)) return 'co_host'
  if (/\bhost\b/i.test(label)) return 'host'
  return 'participant'
}

// People panel rows to a role per trimmed, lower-cased name (see rolesByName).
export function rolesFromPeople(rows: string[][]): Map<string, SenderRole> {
  return rolesByName(rows, roleFromMeetLabel)
}

// The caller holds `withPanel`. Opens People unless it is open, reads it, and brings Chat back.
export async function readRolesNow(page: Page, sel: MeetSelectors): Promise<Map<string, SenderRole>> {
  const { peopleButton, peopleList, peopleItem, chatButton, chatScroller } = sel.selectors
  if (!(await shown(page, peopleList).isVisible())) {
    await shown(page, peopleButton).click({ timeout: CLICK_MS })
    await shown(page, peopleList).waitFor({ timeout: CLICK_MS })
  }
  const rows = await page.evaluate(
    ({ list, item }) =>
      [...document.querySelectorAll<HTMLElement>(list)]
        .filter((el) => el.checkVisibility())
        .flatMap((el) => [...el.querySelectorAll<HTMLElement>(item)])
        .map((row) =>
          row.innerText
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
        ),
    { list: peopleList, item: peopleItem }
  )
  const roles = rolesFromPeople(rows)
  if (!(await shown(page, chatScroller).isVisible())) await shown(page, chatButton).click({ timeout: CLICK_MS })
  await shown(page, chatScroller).waitFor({ timeout: CLICK_MS })
  meetState(page).roles = roles
  return roles
}

// Sender (trimmed, lower-cased) to role, read from the People panel, which is the only place Meet states who the host
// is. Stored in `meetState(page).roles`.
export function readMeetRoles(page: Page, sel: MeetSelectors): Promise<Map<string, SenderRole>> {
  return withPanel(page, () => readRolesNow(page, sel))
}
