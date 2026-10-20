/** The bot joins from this long before the start (PRD LINK-4). */
export const JOIN_FROM_MS = 10 * 60_000
/** A meeting with no link is given up this long after its start (PRD LINK-4). */
export const GIVE_UP_AFTER_MS = 30 * 60_000

export type LinkWaitDecision =
  { kind: 'join'; url: string } | { kind: 'ping_no_link' } | { kind: 'wait' } | { kind: 'give_up' }

/**
 * What the wait for a meeting link does now, in this order: a link and `now >= start - JOIN_FROM_MS` joins;
 * `now >= start + GIVE_UP_AFTER_MS` gives up; `now >= start` and not yet pinged pings; otherwise it waits.
 */
export function decideLinkWait(s: {
  now: Date
  start: Date
  link: string | null
  noLinkPinged: boolean
}): LinkWaitDecision {
  const now = s.now.getTime()
  const start = s.start.getTime()
  if (s.link !== null && now >= start - JOIN_FROM_MS) return { kind: 'join', url: s.link }
  if (now >= start + GIVE_UP_AFTER_MS) return { kind: 'give_up' }
  if (now >= start && !s.noLinkPinged) return { kind: 'ping_no_link' }
  return { kind: 'wait' }
}
