import { setTimeout as sleep } from 'node:timers/promises'
import type { Page } from 'playwright'
import type { SenderRole } from '@tm/core'
import { withPanel } from '../common'
import { ZOOM_TIMEOUTS } from './join'
import { zoomRoot } from './root'
import { zoomSelectors } from './selectors'

export interface ZoomRosterEntry {
  name: string
  role: string
  fullText: string
}

export interface ZoomPageState {
  roster: ZoomRosterEntry[] | null
}

const states = new WeakMap<Page, ZoomPageState>()

export function zoomState(page: Page): ZoomPageState {
  let state = states.get(page)
  if (!state) {
    state = { roster: null }
    states.set(page, state)
  }
  return state
}

const HOST_IN_NAME = /\((host|co-?host)\)/i

export function roleFromZoomLabel(label: string): 'host' | 'co_host' | null {
  if (/co-?host/i.test(label)) return 'co_host'
  if (/host/i.test(label)) return 'host'
  return null
}

// A chat sender is the host or co-host only if the roster has exactly one entry whose full visible text (name plus role
// label) matches the chat sender text, that entry's role label element says Host or Co-host, and no other roster
// entry's visible name (the name element alone) equals that same full text. A participant whose own name element
// contains "(Host)" or "(Co-host)" is never host. Any ambiguity gives role unknown.
export function resolveZoomRole(
  rawSender: string,
  roster: ZoomRosterEntry[] | null,
  roleLabelPattern = /\s*\((host|co-?host)\)\s*$/i
): SenderRole {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()
  const normRaw = norm(rawSender)
  const isHostClaim = roleLabelPattern.test(rawSender)

  if (!roster) {
    return isHostClaim ? 'unknown' : 'participant'
  }

  const matchingFullText = roster.filter((e) => norm(e.fullText) === normRaw)

  if (matchingFullText.length === 1) {
    const candidate = matchingFullText[0]!
    const roleMatch = roleFromZoomLabel(candidate.role)
    const nameHasHostLabel = HOST_IN_NAME.test(candidate.name)
    const otherWithSameName = roster.some((e) => e !== candidate && norm(e.name) === normRaw)

    if (roleMatch && !nameHasHostLabel && !otherWithSameName) {
      return roleMatch
    }
  }

  if (isHostClaim) {
    return 'unknown'
  }

  return 'participant'
}

export async function readZoomRolesNow(page: Page, waitMs = 5000): Promise<ZoomRosterEntry[]> {
  const { selectors: sel } = await zoomSelectors()
  const root = await zoomRoot(page)

  const participantsList = root.locator(sel.participantsList).filter({ visible: true })
  if (!(await participantsList.isVisible())) {
    const btn = root.locator(sel.participantsButton).filter({ visible: true })
    if (await btn.isVisible()) {
      await btn.click({ timeout: ZOOM_TIMEOUTS.step })
      await participantsList.waitFor({ state: 'visible', timeout: waitMs })
    }
  }

  const until = Date.now() + waitMs
  let entries: ZoomRosterEntry[] = []
  for (;;) {
    entries = await root.evaluate(
      ({ listSel, itemSel, nameSel, roleSel }) => {
        const list = [...document.querySelectorAll<HTMLElement>(listSel)].find((el) => el.checkVisibility())
        if (!list) return []
        const items = [...list.querySelectorAll<HTMLElement>(itemSel)]
        return items.map((item) => {
          const nameEl = item.querySelector<HTMLElement>(nameSel)
          const roleEl = item.querySelector<HTMLElement>(roleSel)
          const name = nameEl?.innerText.trim() ?? ''
          const role = roleEl?.innerText.trim() ?? ''
          const fullText = item.innerText.replace(/\s+/g, ' ').trim()
          return { name, role, fullText }
        })
      },
      {
        listSel: sel.participantsList,
        itemSel: sel.participantItem,
        nameSel: sel.participantName,
        roleSel: sel.participantRole
      }
    )
    if (entries.length > 0) break
    if (Date.now() >= until) throw new Error('zoom: the participants list is missing or empty')
    await sleep(250)
  }

  // Restore chat list if it is not visible
  const chatList = root.locator(sel.chatList).filter({ visible: true })
  if (!(await chatList.isVisible())) {
    const openChatBtn = root.locator(sel.openChat).filter({ visible: true })
    if (await openChatBtn.isVisible()) {
      await openChatBtn.click({ timeout: ZOOM_TIMEOUTS.step })
      await chatList.waitFor({ state: 'visible', timeout: ZOOM_TIMEOUTS.step })
    }
  }

  return entries
}

export function readZoomRoles(page: Page, waitMs = 5000): Promise<ZoomRosterEntry[]> {
  return withPanel(page, () => readZoomRolesNow(page, waitMs))
}
