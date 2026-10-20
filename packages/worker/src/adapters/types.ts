import type { Page } from 'playwright'
import type { ChatMessage, Platform } from '@tm/core'

export type MeetingState = 'in_meeting' | 'lobby' | 'ended' | 'removed' | 'breakout_prompt' | 'unknown'
export type AdmissionResult = 'admitted' | 'lobby_expired' | 'lobby_denied'
export type JoinResult =
  | { kind: 'in_meeting' }
  | { kind: 'lobby' }
  | { kind: 'signin_required'; host: string }
  | { kind: 'account_busy' }
  | { kind: 'failed'; reason: string }
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}
export interface ChatCursor {
  seenKeys: string[]
}

export interface PlatformAdapter {
  readonly platform: Platform
  normaliseLink(url: string): string | null // null if not this platform's link
  join(page: Page, opts: { guestName: string | null }): Promise<JoinResult>
  connectOutputAudio(page: Page): Promise<void>
  ensureLayout(page: Page): Promise<void>
  waitUntilAdmitted(page: Page, deadline: Date): Promise<AdmissionResult>
  assertDevicesOff(page: Page): Promise<void> // throws DevicesOnError
  // `rosterError`: the roster read made for a link message failed. The batch is still returned, with those messages
  // `unknown`; the caller reports the failure.
  readChat(
    page: Page,
    cursor: ChatCursor
  ): Promise<{ messages: ChatMessage[]; cursor: ChatCursor; rosterError?: unknown }>
  sweepChat(page: Page): Promise<ChatMessage[]>
  sharedScreenRegion(page: Page): Promise<Rect | null> // in stage coordinates
  participantCount(page: Page): Promise<number | null>
  meetingState(page: Page): Promise<MeetingState>
  dismissNotices(page: Page): Promise<string[]> // texts of buttons clicked
  leave(page: Page): Promise<void>
}

// Thrown by assertDevicesOff: the labels are the toolbar buttons that show the microphone or camera is live.
export class DevicesOnError extends Error {
  readonly labels: string[]

  constructor(labels: string[]) {
    super(`microphone or camera is on: ${labels.join(', ')}`)
    this.name = 'DevicesOnError'
    this.labels = labels
  }
}
