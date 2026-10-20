'use server'

import { InputError, InUseError } from '../../../lib/identities'
import { makeBotLeave, takeOver } from '../../../lib/meeting'
import { requireMember } from '../../../lib/session'

// Server actions: public endpoints, so each takes only the meeting id and gets the member from the session. Nothing
// acts on a GET. The take-over link has no passcode and is returned only to the member whose meeting it is.

export type LeaveResult = { ok: true } | { ok: false; error: string }
export type TakeOverResult = { ok: true; link: string | null } | { ok: false; error: string }

/** Asks the bot to leave this meeting. Asking again queues nothing more. */
export async function leaveAction(id: string): Promise<LeaveResult> {
  const scope = await requireMember()
  try {
    await makeBotLeave(scope, id)
    return { ok: true }
  } catch (e) {
    if (e instanceof InputError || e instanceof InUseError) return { ok: false, error: e.message }
    throw e
  }
}

/** Asks the bot to leave and returns the link it joined with (no passcode), or null when there is none. */
export async function takeOverAction(id: string): Promise<TakeOverResult> {
  const scope = await requireMember()
  try {
    const result = await takeOver(scope, id)
    return result === null ? { ok: false, error: 'This meeting does not exist.' } : { ok: true, link: result.link }
  } catch (e) {
    if (e instanceof InputError || e instanceof InUseError) return { ok: false, error: e.message }
    throw e
  }
}
