import type { SenderRole } from '@tm/core'
import type { Page } from 'playwright'
import { shown, withPanel } from '../common'
import { meetState } from './page-state'
import type { MeetSelectors } from './selectors'

const CLICK_MS = 5_000

export function roleFromMeetLabel(label: string): SenderRole {
  if (/\bco-?host\b/i.test(label)) return 'co_host'
  if (/\bhost\b/i.test(label)) return 'host'
  return 'participant'
}

// People panel rows (each a list of text lines: the name first, the labels after it) to a role per trimmed, lower-cased
// name. Only the lines after the name count as a label, so a participant named "Host" is not one. A name that appears
// more than once with different roles (a student who renamed themselves to the lecturer's name) is `unknown`, so
// neither entry is trusted.
export function rolesFromPeople(rows: string[][]): Map<string, SenderRole> {
  const roles = new Map<string, SenderRole>()
  for (const lines of rows) {
    const name = lines[0]?.trim().toLowerCase()
    if (!name) continue
    const role = roleFromMeetLabel(lines.slice(1).join('\n'))
    const earlier = roles.get(name)
    roles.set(name, earlier === undefined || earlier === role ? role : 'unknown')
  }
  return roles
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
