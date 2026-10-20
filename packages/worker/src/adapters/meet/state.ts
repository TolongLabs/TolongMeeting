import { setTimeout as sleep } from 'node:timers/promises'
import type { Page } from 'playwright'
import type { AdmissionResult, MeetingState } from '../types'
import { navigationGuard } from '../zoom/root'
import { shown } from './join'
import type { MeetSelectors } from './selectors'
import { meetTextSignal } from './text'

// Every text check goes through meetTextSignal, which leaves the side panel (chat, people) and the captions out: a
// message that says "you left the meeting" must not change the state. Nothing here logs or returns page text.

async function lobbyShowing(page: Page, sel: MeetSelectors): Promise<boolean> {
  return meetTextSignal(page, sel, sel.texts.lobby)
}

async function readState(page: Page, sel: MeetSelectors): Promise<MeetingState> {
  const { selectors, texts } = sel
  // With Leave showing the call is live: ended and removed count only inside a notice container, so toolbar or other
  // page text cannot end it. Without Leave, an end screen counts wherever it is on the page.
  const live = await shown(page, selectors.leaveButton).isVisible()
  const within = live ? selectors.noticeContainers : undefined
  if (await meetTextSignal(page, sel, texts.removed, within)) return 'removed'
  if (
    (await meetTextSignal(page, sel, texts.ended, within)) ||
    (await meetTextSignal(page, sel, texts.endScreen, within))
  )
    return 'ended'
  if (await meetTextSignal(page, sel, texts.breakoutPrompt)) return 'breakout_prompt'
  if (await lobbyShowing(page, sel)) return 'lobby'
  // No Leave button and no end signal is a page still loading or a dropped session: 01a's drop handling, not an end.
  return live ? 'in_meeting' : 'unknown'
}

// Reads the page without touching it. A page that is navigating under the read shows no state yet.
export async function meetMeetingState(page: Page, sel: MeetSelectors): Promise<MeetingState> {
  return (await navigationGuard('meetingState', 'meet').run(() => readState(page, sel))) ?? 'unknown'
}

// Polls every `pollMs` until the bot is let in, refused, or `deadline` passes (reported as an expired lobby).
export async function waitMeetAdmitted(
  page: Page,
  sel: MeetSelectors,
  deadline: Date,
  pollMs = 2_000
): Promise<AdmissionResult> {
  const guard = navigationGuard('admission', 'meet')
  const poll = async (): Promise<AdmissionResult | null> => {
    if (await meetTextSignal(page, sel, sel.texts.lobbyDenied)) return 'lobby_denied'
    if (await meetTextSignal(page, sel, sel.texts.lobbyExpired)) return 'lobby_expired'
    if ((await shown(page, sel.selectors.leaveButton).isVisible()) && !(await lobbyShowing(page, sel)))
      return 'admitted'
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
