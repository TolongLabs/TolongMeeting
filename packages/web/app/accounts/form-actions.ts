'use server'

import { redirect } from 'next/navigation'
import { getQueue } from '../../lib/queue'
import { IdentityInputSchema, InUseError } from '../../lib/identities'
import { setRunLocation, type RunLocationChoice } from '../../lib/run-locations/settings'
import { requireMember } from '../../lib/session'
import { createIdentityAction, deleteIdentityAction, updateIdentityAction } from './actions'
import type { IdentityFormState, IdentityFormValues } from './form-state'

// The Accounts page's form handlers. They read the form's fields, then use the identity actions and `setRunLocation`.
// They take only the form and get the member from the session. Every refusal is a fixed sentence: the page picks the text
// from a short code in the redirect, and nothing the member typed or the database said is put in a URL.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const text = (formData: FormData, name: string) => {
  const value = formData.get(name)
  return typeof value === 'string' ? value : ''
}

const FIELD_MESSAGES: Record<keyof IdentityFormValues, string> = {
  name: 'Enter a name of 1 to 40 characters.',
  zoomGuestName: 'Enter the Zoom display name, 1 to 64 characters.',
  orgName: 'Enter an organisation name of up to 100 characters.',
  orgEmailDomain: 'Enter a bare domain such as uni.edu.my, with no @ or web address.'
}
const NAME_TAKEN = 'You already have an identity with this name.'
const SAVE_FAILED = 'The identity could not be saved. Try again.'

/** Adds an identity, or saves the one named by the hidden `id` field. Success goes back to the list. */
export async function saveIdentityFormAction(
  _previous: IdentityFormState,
  formData: FormData
): Promise<IdentityFormState> {
  await requireMember()
  const id = text(formData, 'id')
  const values: IdentityFormValues = {
    name: text(formData, 'name'),
    zoomGuestName: text(formData, 'zoomGuestName'),
    orgName: text(formData, 'orgName'),
    orgEmailDomain: text(formData, 'orgEmailDomain')
  }
  const parsed = IdentityInputSchema.safeParse(values)
  if (!parsed.success) {
    const fields: Partial<Record<keyof IdentityFormValues, string>> = {}
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as keyof IdentityFormValues
      // The schema's own sentences are fixed; zod's default ones are not, so a default one is replaced.
      fields[field] ??= issue.code === 'custom' ? issue.message : FIELD_MESSAGES[field]
    }
    return { status: 'error', fields, values }
  }
  if (id !== '' && !UUID.test(id)) redirect('/accounts?problem=gone')
  const result = id === '' ? await createIdentityAction(values) : await updateIdentityAction(id, values)
  if (!result.ok) {
    if (result.error === 'No such identity.') redirect('/accounts?problem=gone')
    if (result.error.startsWith('You already have an identity called'))
      return { status: 'error', fields: { name: NAME_TAKEN }, values }
    return { status: 'error', message: SAVE_FAILED, fields: {}, values }
  }
  redirect(`/accounts?notice=${id === '' ? 'created' : 'saved'}`)
}

/** Deletes the identity named by the form (`id`). */
export async function deleteIdentityFormAction(formData: FormData): Promise<void> {
  await requireMember()
  const id = text(formData, 'id')
  if (!UUID.test(id)) redirect('/accounts?problem=gone')
  const result = await deleteIdentityAction(id)
  if (result.ok) redirect('/accounts?notice=deleted')
  if (result.error === 'No such identity.') redirect('/accounts?problem=gone')
  const code =
    result.error === 'This identity has timetable entries.'
      ? 'delete_has_entries'
      : result.error === 'This identity has a meeting or sign-in that has not finished.' ||
          result.error === 'This identity is in use by a meeting or a sign-in.'
        ? 'delete_busy'
        : 'delete_failed'
  redirect(`/accounts?problem=${code}&for=${id}`)
}

/** `server`, `server_via_home` or `local:<device id>`, as the move buttons send it. */
function choiceOf(where: string): RunLocationChoice | null {
  if (where === 'server' || where === 'server_via_home') return { location: where }
  const device = /^local:(.+)$/.exec(where)?.[1]
  return device && UUID.test(device) ? { location: 'local', deviceId: device } : null
}

/** Moves the identity named by the form (`id`) to `where`. A refusal goes back to the list with its short code. */
export async function moveIdentityFormAction(formData: FormData): Promise<void> {
  const scope = await requireMember()
  const id = text(formData, 'id')
  const choice = choiceOf(text(formData, 'where'))
  if (!UUID.test(id) || !choice) redirect('/accounts?problem=move_gone')
  let result
  try {
    result = await setRunLocation(scope, await getQueue(), id, choice)
  } catch (e) {
    if (e instanceof InUseError) redirect(`/accounts?problem=move_busy&for=${id}`)
    throw e
  }
  if (result.ok) redirect(`/accounts?notice=moved&for=${id}`)
  const code = {
    identity_not_found: 'move_gone',
    device_not_found: 'move_no_pc',
    home_route_not_set_up: 'move_no_home'
  }[result.error]
  redirect(`/accounts?problem=${code}&for=${id}`)
}
