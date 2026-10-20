import type { EventType, FormSource, FormState, TrustReason } from '@tm/core'
import { STATE_LABELS } from './labels'

// The words on the meeting page for forms and events. Type-only imports from core: safe to import anywhere.

export const FORM_SOURCE_LABELS: Record<FormSource, string> = {
  qr: 'A QR code on the screen',
  meeting_chat: 'The meeting chat',
  watched_chat: 'The chat the bot watches'
}

export const TRUST_LABELS: Record<TrustReason, string> = {
  qr_on_screen: 'The QR code was shown in the meeting',
  host: 'Sent by the host',
  co_host: 'Sent by a co-host',
  trusted_sender: 'Sent by a trusted sender',
  org_restricted: 'The form is limited to one organisation'
}

/** The outcome of a form in plain words. A form that was seen but not submitted says why. */
export const FORM_STATE_LABELS: Record<FormState, string> = {
  detected: 'Seen',
  resolving: 'Checking the link',
  checking_trust: 'Checking who sent it',
  untrusted: 'Not submitted: the sender is not trusted',
  opening: 'Opening the form',
  awaiting_signin: 'Waiting for you to sign in',
  inspecting: 'Reading the form',
  not_attendance: 'Not submitted: this is not an attendance form',
  quiz: 'Not submitted: this is a quiz',
  filling: 'Filling in the form',
  needs_member: 'Needs you: the form could not be filled in alone',
  submitting: 'Submitting',
  submitted: 'Submitted',
  already_answered: 'Already answered',
  failed: 'Failed'
}

export const EVENT_LABELS: Record<EventType, string> = {
  state: 'Status changed',
  joined: 'The bot joined the meeting',
  notice_dismissed: 'A notice was dismissed',
  form: 'A form was handled',
  alert: 'An alert was sent',
  error: 'A step failed',
  keyframe: 'A slide change was seen',
  recording_gap: 'The recording has a gap',
  mention: 'Your name was mentioned',
  deletion: 'The meeting was deleted'
}

const WORD = /^[a-z][a-z_ ]{0,39}$/

const words = (value: unknown): string | null =>
  typeof value === 'string' && WORD.test(value) ? value.replaceAll('_', ' ') : null

/**
 * The one short detail the page shows for an event. Event data is written by the bot and can hold free text, so only
 * a status the page knows or a short lower-case code (such as `handler failed`) is shown; nothing else is.
 */
export function eventDetail(type: EventType, data: Record<string, unknown>): string | null {
  if (type === 'state') {
    const state = data.state ?? data.to
    return typeof state === 'string' && Object.hasOwn(STATE_LABELS, state)
      ? STATE_LABELS[state as keyof typeof STATE_LABELS]
      : null
  }
  if (type === 'form') return words(data.outcome) ?? words(data.reason)
  if (type === 'error') return words(data.where) ?? words(data.reason)
  if (type === 'alert') return words(data.kind)
  return null
}

/** `00:05:12` for an offset in seconds. */
export function clock(seconds: number): string {
  const s = Math.floor(seconds)
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':')
}

/** A transcript paragraph split at the pipeline's `_(as heard: "...")_` notes, so the page can set them apart. */
export function splitHeard(text: string): ({ text: string } | { heard: string })[] {
  const parts: ({ text: string } | { heard: string })[] = []
  let cursor = 0
  for (const match of text.matchAll(/ ?_\(as heard: "([^"]*)"\)_/g)) {
    if (match.index > cursor) parts.push({ text: text.slice(cursor, match.index) })
    parts.push({ heard: match[1]! })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) })
  return parts
}
