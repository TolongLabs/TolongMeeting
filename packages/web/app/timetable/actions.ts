'use server'

import { InputError, InUseError } from '../../lib/identities'
import { WatchingNotAllowedError } from '../../lib/link-notices'
import { requireMember } from '../../lib/session'
import { appEntryDeps, deleteEntry, NoWorkingKeyError, saveEntry, setPaused, type Clash } from '../../lib/timetable'

// Server actions: public endpoints, so each takes only the form input and gets the member from the session. A saved
// entry's link and passcode are never returned: a save answers with the clashes it found, nothing else.

/** `entryId` is set by a save: the entry that was written. */
export type TimetableResult = { ok: true; clashes: Clash[]; entryId?: string } | { ok: false; error: string }

/** Turns a refusal the member can act on into its message. Any other failure still throws. */
async function attempt(run: () => Promise<{ clashes: Clash[]; entryId?: string }>): Promise<TimetableResult> {
  try {
    return { ok: true, ...(await run()) }
  } catch (e) {
    if (
      e instanceof InputError ||
      e instanceof InUseError ||
      e instanceof NoWorkingKeyError ||
      e instanceof WatchingNotAllowedError
    ) {
      return { ok: false, error: e.message }
    }
    throw e
  }
}

/** Saves a timetable entry (a new one, or the one named by `id` in the input). */
export async function saveEntryAction(input: unknown): Promise<TimetableResult> {
  const scope = await requireMember()
  return attempt(async () => await saveEntry(scope, input, await appEntryDeps(scope)))
}

/** Pauses or resumes one of the member's timetable entries. */
export async function setPausedAction(entryId: string, paused: boolean): Promise<TimetableResult> {
  const scope = await requireMember()
  return attempt(async () => {
    await setPaused(scope, entryId, paused, await appEntryDeps(scope))
    return { clashes: [] }
  })
}

/** Deletes one of the member's timetable entries and its future sessions. */
export async function deleteEntryAction(entryId: string): Promise<TimetableResult> {
  const scope = await requireMember()
  return attempt(async () => {
    await deleteEntry(scope, entryId, await appEntryDeps(scope))
    return { clashes: [] }
  })
}
