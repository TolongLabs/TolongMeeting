import type { Page } from 'playwright'
import type { SenderRole } from '@tm/core'
import { shown } from './join'
import { teamsState } from './page-state'
import type { TeamsSelectors } from './selectors'

const PANE_TIMEOUT_MS = 10_000

// The roster's role label for one participant. Only the roster says who is a host: the chat has no role of its own,
// and message text is never read for one. A label that names no organiser (Presenter, Attendee, none) is a participant.
export function roleFromTeamsLabel(label: string): SenderRole {
  if (/co-?organi[sz]er/i.test(label)) return 'co_host'
  if (/organi[sz]er/i.test(label)) return 'host'
  return 'participant'
}

// Opens the People pane, reads each participant's name (first text line) and role label (the other lines), opens the
// chat pane again and stores the map (keyed by trimmed, lower-cased name) in the page state. A pane that is already
// open is not clicked: the button toggles it. Names and labels are never logged.
export async function readTeamsRoles(page: Page, sel: TeamsSelectors): Promise<Map<string, SenderRole>> {
  const { selectors } = sel
  if (!(await shown(page, selectors.rosterPane).isVisible())) {
    await shown(page, selectors.rosterButton).click({ timeout: PANE_TIMEOUT_MS })
    await shown(page, selectors.rosterPane).waitFor({ timeout: PANE_TIMEOUT_MS })
  }
  const rows = await page.evaluate((css) => {
    const pane = [...document.querySelectorAll<HTMLElement>(css.rosterPane)].find((p) => p.checkVisibility())
    return [...(pane?.querySelectorAll<HTMLElement>(css.rosterItem) ?? [])].map((item) =>
      item.innerText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    )
  }, selectors)
  const roles = new Map<string, SenderRole>()
  for (const [name, ...label] of rows) {
    if (name) roles.set(name.toLowerCase(), roleFromTeamsLabel(label.join(' ')))
  }
  if (!(await shown(page, selectors.chatPane).isVisible())) {
    await shown(page, selectors.chatButton).click({ timeout: PANE_TIMEOUT_MS })
    await shown(page, selectors.chatPane).waitFor({ timeout: PANE_TIMEOUT_MS })
  }
  teamsState(page).roles = roles
  return roles
}
