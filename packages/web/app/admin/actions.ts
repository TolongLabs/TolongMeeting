'use server'

import { redirect } from 'next/navigation'
import { MEMBER_ROLES } from '../../db/schema'
import { addMemberFor, AddMemberInputSchema, removeMemberFor, setRoleFor } from '../../lib/admin'
import { ntfyAdminFromEnv } from '../../lib/ntfy-admin'
import { adminScope, MemberBusyError } from '../../lib/scope'
import { requireAdmin } from '../../lib/session'
import type { AddMemberState } from './form-state'

// Server actions: public endpoints, so each one starts with `requireAdmin()`, which takes the member from the session
// and sends a member who is not an admin away. Nothing here reads a member's own data. A refusal is a fixed sentence.

const FIELD_NAMES = ['githubLogin', 'displayName', 'timeZone', 'role'] as const
const text = (formData: FormData, name: string) => {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/** Adds a member to the allow-list: the person can then sign in with GitHub, if they belong to the organisation. */
export async function addMemberAction(_previous: AddMemberState, formData: FormData): Promise<AddMemberState> {
  await requireAdmin()
  const input = Object.fromEntries(FIELD_NAMES.map((name) => [name, text(formData, name)]))
  const parsed = AddMemberInputSchema.safeParse(input)
  if (!parsed.success) {
    const fields: Record<string, string> = {}
    for (const issue of parsed.error.issues) fields[String(issue.path[0])] ??= issue.message
    return { status: 'error', fields, values: input }
  }
  const result = await addMemberFor(adminScope(), parsed.data)
  if (!result.ok) return { status: 'error', fields: { githubLogin: result.error }, values: input }
  redirect('/admin?notice=added')
}

/** Makes the member named by the form (`id`) an admin or a plain member (`role`) and goes back to the page. */
export async function setRoleAction(formData: FormData): Promise<void> {
  await requireAdmin()
  const role = MEMBER_ROLES.find((r) => r === formData.get('role'))
  const id = formData.get('id')
  if (!role || typeof id !== 'string') redirect('/admin')
  const result = await setRoleFor(adminScope(), id, role)
  // `setRoleFor` refuses only when the change would leave no admin.
  redirect(`/admin?notice=${result.ok ? 'role-changed' : 'last-admin'}`)
}

/** Removes the member named by the form (`id`), with their data and their ntfy user, and goes back to the page. */
export async function removeMemberAction(formData: FormData): Promise<void> {
  await requireAdmin()
  const id = formData.get('id')
  if (typeof id !== 'string') redirect('/admin')
  const result = await removeMemberFor(adminScope(), id, ntfyAdminFromEnv())
  if (result.ok) redirect('/admin?notice=removed')
  // The two refusals of `removeMemberFor` are a meeting or sign-in in progress and the last admin.
  redirect(`/admin?notice=${result.error === new MemberBusyError().message ? 'busy' : 'last-admin'}`)
}
