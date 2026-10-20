'use server'

import { redirect } from 'next/navigation'
import { requireMember } from '../../lib/session'
import { EntryInputSchema } from '../../lib/timetable'
import { deleteEntryAction, saveEntryAction, setPausedAction, type TimetableResult } from './actions'
import { fieldErrors, inputFromForm } from './entry-form-data'
import type { EntryFormState } from './form-state'

// The entry form's handlers: they read the form's fields, then use the timetable actions. They take only the form and
// get the member from the session. A saved link is never put in a result or a redirect.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The reason a pause or delete failed, as a short code for the page to explain. */
function problemCode(result: Extract<TimetableResult, { ok: false }>): string {
  switch (result.code) {
    case 'in_use':
      return 'busy'
    case 'not_found':
      return 'gone'
    default:
      return 'failed'
  }
}

/** Saves the entry form. A save with no clash goes back to the timetable; a clash or a refusal stays on the form. */
export async function saveEntryFormAction(_previous: EntryFormState, formData: FormData): Promise<EntryFormState> {
  await requireMember()
  const input = inputFromForm(formData)
  const parsed = EntryInputSchema.safeParse(input)
  if (!parsed.success) {
    const { fields, unplaced } = fieldErrors(parsed.error.issues)
    return { status: 'error', ...(unplaced[0] && { message: unplaced[0] }), fields }
  }
  const result = await saveEntryAction(input)
  if (!result.ok) {
    if (result.code === 'no_working_key') {
      return { status: 'error', message: result.error, help: { href: '/ai-keys', label: 'Open AI keys' }, fields: {} }
    }
    // A refused chat source is about the chat field; the identity decides it, so the message also names the fix.
    if (result.code === 'watching_not_allowed') return { status: 'error', fields: { 'link-chat': result.error } }
    return { status: 'error', message: result.error, fields: {} }
  }
  if (result.clashes.length === 0) redirect('/timetable?notice=saved')
  if (!result.entryId) throw new Error('a saved entry has no id')
  return { status: 'saved', entryId: result.entryId, clashes: result.clashes }
}

/** Pauses or resumes the entry named by the form (`id`, and `paused` as `true` or `false`). */
export async function pauseEntryFormAction(formData: FormData): Promise<void> {
  await requireMember()
  const id = String(formData.get('id'))
  const paused = formData.get('paused') === 'true'
  if (!UUID.test(id)) redirect('/timetable?problem=gone')
  const result = await setPausedAction(id, paused)
  redirect(
    result.ok ? `/timetable?notice=${paused ? 'paused' : 'resumed'}` : `/timetable?problem=${problemCode(result)}`
  )
}

/** Deletes the entry named by the form (`id`). */
export async function deleteEntryFormAction(formData: FormData): Promise<void> {
  await requireMember()
  const id = String(formData.get('id'))
  if (!UUID.test(id)) redirect('/timetable?problem=gone')
  const result = await deleteEntryAction(id)
  if (result.ok) redirect('/timetable?notice=deleted')
  redirect(`/timetable/${id}?problem=${problemCode(result)}`)
}
