import type { Page } from 'playwright'
import type { ChatMessage, SenderRole } from '@tm/core'
import { extractLinks } from '../../forms/links'
import type { ChatCursor } from '../types'
import { shown, withPanel } from '../common'
import { navigationGuard } from '../zoom/root'
import { teamsChatProbe, type RawTeamsMessage, type TeamsProbeResult } from './chat-dom'
import { teamsState } from './page-state'
import { readRolesNow, readTeamsRoles } from './roles'
import type { TeamsSelectors } from './selectors'

// A recurring meeting keeps one chat thread for all its occurrences: only messages from the hour before the join on
// belong to this one.
export const TEAMS_CHAT_HISTORY_MS = 60 * 60 * 1000

// A sweep stops after this long: a list that keeps growing, or a page that stalls, must not hold the meeting loop.
export const TEAMS_SWEEP_BUDGET_MS = 45_000

interface ToChatContext {
  // Sender (trimmed, lower-cased) to role; null until the roster has been read.
  roles: Map<string, SenderRole> | null
  // Messages dated before this are another occurrence's; null keeps everything.
  cutoffMs: number | null
  seenAt: string
}

// Roles come from the roster only (readTeamsRoles); a sender the roster does not name, or no roster at all, is
// 'unknown'. Message text never sets a role. Teams meeting chat quotes a reply inline, so replyTo is always null.
export function toTeamsChatMessages(raw: RawTeamsMessage[], ctx: ToChatContext): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of raw) {
    if (ctx.cutoffMs !== null && m.datetime !== null && Date.parse(m.datetime) < ctx.cutoffMs) continue
    const links = [...new Set([...m.hrefs.filter((href) => /^https?:/i.test(href)), ...extractLinks(m.text)])]
    out.push({
      key: m.id ?? `${m.sender}|${m.time}|${m.text.slice(0, 200)}`,
      sender: m.sender,
      senderRole: ctx.roles?.get(m.sender.trim().toLowerCase()) ?? 'unknown',
      time: m.time,
      seenAt: ctx.seenAt,
      text: m.text,
      links,
      replyTo: null
    })
  }
  return out
}

async function probe(
  page: Page,
  sel: TeamsSelectors,
  mode: 'read' | 'sweep',
  sweepBudgetMs = TEAMS_SWEEP_BUDGET_MS
): Promise<TeamsProbeResult | undefined> {
  // A page that navigates under the call yields nothing this time.
  return navigationGuard(`${mode}Chat`, 'teams').run(() =>
    page.evaluate(teamsChatProbe, { sel: sel.selectors, mode, sweepBudgetMs })
  )
}

const knows = (roles: Map<string, SenderRole> | null, sender: string) =>
  roles?.has(sender.trim().toLowerCase()) ?? false

// Sweeps in flight, one per page. A read during one leaves the page alone: it must not pin the list to the bottom or
// switch panes under the sweep's scrolling.
const sweeps = new WeakMap<Page, Promise<ChatMessage[]>>()

// The messages whose keys the cursor has not seen, and a cursor that has seen them too. It advances nothing itself: the
// caller adopts the new cursor only after the messages are durably written (CHAT-03). A closed chat pane reads nothing
// (the layout step reopens it). A new message with a link from a sender the roster has not named makes one roster read.
export async function readTeamsChat(
  page: Page,
  sel: TeamsSelectors,
  cursor: ChatCursor
): Promise<{ messages: ChatMessage[]; cursor: ChatCursor }> {
  const unchanged = { messages: [], cursor }
  if (sweeps.has(page) || !(await shown(page, sel.selectors.chatPane).isVisible())) return unchanged
  const state = teamsState(page)
  state.joinedAt ??= Date.now()
  const cutoffMs = state.joinedAt - TEAMS_CHAT_HISTORY_MS
  const seen = new Set(cursor.seenKeys)
  const collect = (parsed: TeamsProbeResult, roles: Map<string, SenderRole> | null) =>
    toTeamsChatMessages(parsed.messages, { roles, cutoffMs, seenAt: new Date().toISOString() }).filter(
      (m) => !seen.has(m.key)
    )

  let parsed = await probe(page, sel, 'read')
  if (!parsed) return unchanged
  let messages = collect(parsed, state.roles)
  if (messages.some((m) => m.links.length > 0 && !knows(state.roles, m.sender))) {
    const roles = await readTeamsRoles(page, sel)
    parsed = await probe(page, sel, 'read')
    if (!parsed) return unchanged
    messages = collect(parsed, roles)
  }
  return { messages, cursor: { seenKeys: [...cursor.seenKeys, ...messages.map((m) => m.key)] } }
}

// Reads the roster, then scrolls the whole list so every row renders once, and returns every message met, in list
// order and after the same cutoff (not only new ones). Stops after `budgetMs`: the log then says how far it
// got, and the next sweep starts again from the top. A caller that arrives during a sweep gets that sweep's result. It
// holds the panel lock, so no layout pass or role read opens another pane under it.
export function sweepTeamsChat(
  page: Page,
  sel: TeamsSelectors,
  budgetMs: number = TEAMS_SWEEP_BUDGET_MS
): Promise<ChatMessage[]> {
  const running = sweeps.get(page)
  if (running) return running
  const run = withPanel(page, async () => {
    if (!(await shown(page, sel.selectors.chatPane).isVisible())) return []
    const state = teamsState(page)
    state.joinedAt ??= Date.now()
    const roles = await readRolesNow(page, sel)
    const result = await probe(page, sel, 'sweep', budgetMs)
    if (!result) return []
    if (!result.complete) {
      console.warn(`teams: chat sweep partial, reached ${result.reached} of ${result.total} px in ${budgetMs} ms`)
    }
    return toTeamsChatMessages(result.messages, {
      roles,
      cutoffMs: state.joinedAt - TEAMS_CHAT_HISTORY_MS,
      seenAt: new Date().toISOString()
    })
  }).finally(() => sweeps.delete(page))
  sweeps.set(page, run)
  return run
}
