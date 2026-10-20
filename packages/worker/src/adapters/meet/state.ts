import type { Page } from 'playwright'
import { pollAdmission, shown } from '../common'
import type { AdmissionResult, MeetingState } from '../types'
import { navigationGuard } from '../zoom/root'
import type { MeetSelectors } from './selectors'
import { meetTextSignal } from './text'

// Every text check goes through meetTextSignal, which leaves the side panel (chat, people) and the captions out: a
// message that says "you left the meeting" must not change the state. Nothing here logs or returns page text.

async function lobbyShowing(page: Page, sel: MeetSelectors): Promise<boolean> {
  return meetTextSignal(page, sel, sel.texts.lobby)
}

async function readState(page: Page, sel: MeetSelectors): Promise<MeetingState> {
  const { selectors, texts } = sel
  // With Leave showing the call is live: ended, removed and breakout text count only inside a notice container, so
  // toolbar, tile or other page text ("Breakout room helper" in a participant's name) cannot end it or pose as a prompt.
  // Without Leave, they count wherever they are on the page.
  const live = await shown(page, selectors.leaveButton).isVisible()
  const within = live ? selectors.noticeContainers : undefined
  if (await meetTextSignal(page, sel, texts.removed, within)) return 'removed'
  if (
    (await meetTextSignal(page, sel, texts.ended, within)) ||
    (await meetTextSignal(page, sel, texts.endScreen, within))
  )
    return 'ended'
  if (await meetTextSignal(page, sel, texts.breakoutPrompt, within)) return 'breakout_prompt'
  if (await lobbyShowing(page, sel)) return 'lobby'
  // No Leave button and no end signal is a page still loading or a dropped session: 01a's drop handling, not an end.
  return live ? 'in_meeting' : 'unknown'
}

// Reads the page without touching it. A page that is navigating under the read shows no state yet.
export async function meetMeetingState(page: Page, sel: MeetSelectors): Promise<MeetingState> {
  return (await navigationGuard('meetingState', 'meet').run(() => readState(page, sel))) ?? 'unknown'
}

// Polls every `pollMs` until the bot is let in, refused, or `deadline` passes (reported as an expired lobby). A poll that
// hangs is cut at the deadline.
export function waitMeetAdmitted(
  page: Page,
  sel: MeetSelectors,
  deadline: Date,
  pollMs = 2_000
): Promise<AdmissionResult> {
  const poll = async (): Promise<AdmissionResult | null> => {
    if (await meetTextSignal(page, sel, sel.texts.lobbyDenied)) return 'lobby_denied'
    if (await meetTextSignal(page, sel, sel.texts.lobbyExpired)) return 'lobby_expired'
    if ((await shown(page, sel.selectors.leaveButton).isVisible()) && !(await lobbyShowing(page, sel)))
      return 'admitted'
    return null
  }
  return pollAdmission(navigationGuard('admission', 'meet'), poll, deadline, pollMs)
}
