import { setTimeout as sleep } from 'node:timers/promises'
import type { Page } from 'playwright'
import { navigationGuard } from '../zoom/root'
import type { AdmissionResult, MeetingState } from '../types'
import { shown } from './join'
import { teamsState } from './page-state'
import type { TeamsSelectors } from './selectors'
import { teamsTextSignal } from './text'

// Every text check goes through teamsTextSignal, which leaves the chat and roster panes out: a message that says "the
// meeting has ended" must not change the state. Nothing here logs or returns page text.

async function lobbyShowing(page: Page, sel: TeamsSelectors): Promise<boolean> {
  return (
    (await shown(page, sel.selectors.lobbyScreen).isVisible()) || (await teamsTextSignal(page, sel, sel.texts.lobby))
  )
}

async function readState(page: Page, sel: TeamsSelectors): Promise<MeetingState> {
  const { selectors, texts } = sel
  // With Leave showing the meeting is live: ended and removed count only inside a notice container, so toolbar or
  // other page text cannot end it. Without Leave, an end screen counts wherever it is on the page.
  const live = await shown(page, selectors.hangupButton).isVisible()
  const within = live ? selectors.noticeContainers : undefined
  if (await teamsTextSignal(page, sel, texts.removed, within)) return 'removed'
  if ((await shown(page, selectors.endScreen).isVisible()) || (await teamsTextSignal(page, sel, texts.ended, within)))
    return 'ended'
  if (
    (await teamsTextSignal(page, sel, texts.breakoutPrompt)) ||
    (await shown(page, selectors.breakoutRoomBanner).isVisible())
  )
    return 'breakout_prompt'
  if (await lobbyShowing(page, sel)) return 'lobby'
  // No Leave button and no end signal is a page still loading or a dropped session: 01a's drop handling, not an end.
  return live ? 'in_meeting' : 'unknown'
}

// Reads the page without touching it. A page that is navigating under the read shows no state yet.
export async function teamsMeetingState(page: Page, sel: TeamsSelectors): Promise<MeetingState> {
  return (await navigationGuard('meetingState', 'teams').run(() => readState(page, sel))) ?? 'unknown'
}

// Polls every `pollMs` until the bot is let in, refused, or `deadline` passes (reported as an expired lobby).
export async function waitTeamsAdmitted(
  page: Page,
  sel: TeamsSelectors,
  deadline: Date,
  pollMs = 2_000
): Promise<AdmissionResult> {
  const guard = navigationGuard('admission', 'teams')
  const poll = async (): Promise<AdmissionResult | null> => {
    if (await teamsTextSignal(page, sel, sel.texts.lobbyDenied)) return 'lobby_denied'
    if (await teamsTextSignal(page, sel, sel.texts.lobbyExpired)) return 'lobby_expired'
    if ((await shown(page, sel.selectors.hangupButton).isVisible()) && !(await lobbyShowing(page, sel))) {
      teamsState(page).joinedAt = Date.now()
      return 'admitted'
    }
    return null
  }
  for (;;) {
    const result = await guard.run(poll)
    if (result) return result
    const left = deadline.getTime() - Date.now()
    if (left <= 0) return 'lobby_expired'
    await sleep(Math.min(pollMs, left))
  }
}
