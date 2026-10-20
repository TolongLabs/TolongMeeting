import { setTimeout as sleep } from 'node:timers/promises'
import type { Page } from 'playwright'
import type { SenderRole } from '@tm/core'
import { shown, withPanel } from '../common'
import { rolesByName } from '../roles'
import { teamsState } from './page-state'
import type { TeamsSelectors } from './selectors'

const PANE_TIMEOUT_MS = 10_000
// How long the roster pane gets to show up and fill with rows before the read gives up.
const ROSTER_WAIT_MS = 5_000
const ROSTER_POLL_MS = 250

// The roster's role label for one participant. Only the roster says who is a host: the chat has no role of its own,
// and message text is never read for one. A label that names no organiser (Presenter, Attendee, none) is a participant.
export function roleFromTeamsLabel(label: string): SenderRole {
  if (/co-?organi[sz]er/i.test(label)) return 'co_host'
  if (/organi[sz]er/i.test(label)) return 'host'
  return 'participant'
}

// Roster rows to a role per trimmed, lower-cased name (see rolesByName): a name listed twice with different roles is
// `unknown`.
export function rolesFromRoster(rows: string[][]): Map<string, SenderRole> {
  return rolesByName(rows, roleFromTeamsLabel)
}

// The rows of the visible roster pane, each a list of text lines, or null when no roster pane is visible.
function rosterRows(page: Page, sel: TeamsSelectors): Promise<string[][] | null> {
  return page.evaluate((css) => {
    const pane = [...document.querySelectorAll<HTMLElement>(css.rosterPane)].find((p) => p.checkVisibility())
    if (!pane) return null
    return [...pane.querySelectorAll<HTMLElement>(css.rosterItem)].map((item) =>
      item.innerText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    )
  }, sel.selectors)
}

// The caller holds `withPanel`. Opens the People pane, reads each participant's name (first text line) and role label
// (the other lines), opens the chat pane again and stores the map in the page state. A pane that is already open is
// not clicked: the button toggles it. The bot is on the roster itself, so a pane that is missing or still empty after
// `waitMs` is a fault and throws; an empty map is never stored as the roster. Names and labels are never logged.
export async function readRolesNow(
  page: Page,
  sel: TeamsSelectors,
  waitMs = ROSTER_WAIT_MS
): Promise<Map<string, SenderRole>> {
  const { selectors } = sel
  if (!(await shown(page, selectors.rosterPane).isVisible())) {
    await shown(page, selectors.rosterButton).click({ timeout: PANE_TIMEOUT_MS })
    await shown(page, selectors.rosterPane).waitFor({ timeout: waitMs })
  }
  const until = Date.now() + waitMs
  let roles = new Map<string, SenderRole>()
  for (;;) {
    const rows = await rosterRows(page, sel)
    roles = rolesFromRoster(rows ?? [])
    if (roles.size > 0) break
    if (Date.now() >= until) throw new Error(`teams: the roster pane is ${rows === null ? 'missing' : 'empty'}`)
    await sleep(ROSTER_POLL_MS)
  }
  if (!(await shown(page, selectors.chatPane).isVisible())) {
    await shown(page, selectors.chatButton).click({ timeout: PANE_TIMEOUT_MS })
    await shown(page, selectors.chatPane).waitFor({ timeout: PANE_TIMEOUT_MS })
  }
  teamsState(page).roles = roles
  return roles
}

// Sender (trimmed, lower-cased) to role, read from the roster, which is the only place Teams states who the organiser
// is. Stored in `teamsState(page).roles`. Takes the page's panel lock, so it never interleaves with a layout pass or a
// chat sweep.
export function readTeamsRoles(
  page: Page,
  sel: TeamsSelectors,
  waitMs = ROSTER_WAIT_MS
): Promise<Map<string, SenderRole>> {
  return withPanel(page, () => readRolesNow(page, sel, waitMs))
}
