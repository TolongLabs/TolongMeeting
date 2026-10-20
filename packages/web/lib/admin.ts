import { z } from 'zod'
import { DbError, safeDbError } from '../db/errors'
import { MEMBER_ROLES, type MemberRole } from '../db/schema'
import { noControlCharacters, NO_CONTROL_MESSAGE } from './identities'
import type { NtfyAdmin } from './ntfy-admin'
import { LastAdminError, MemberBusyError, type AdminScope } from './scope'

// Scope-taking helpers behind the admin's server actions (`app/admin/actions.ts`). Like `action-results.ts`, refusals the
// admin can act on come back as a fixed message; any other failure throws. Input is checked here before it reaches the scope.

export type AdminResult = { ok: true } | { ok: false; error: string }
export type AddMemberResult = { ok: true; id: string } | { ok: false; error: string }

const GITHUB_LOGIN = /^[a-z0-9](?:-?[a-z0-9]){0,38}$/i

function isTimeZone(value: string): boolean {
  try {
    Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch (e) {
    // Intl throws a RangeError for a zone it does not know; anything else is a bug and propagates.
    if (e instanceof RangeError) return false
    throw e
  }
}

export const AddMemberInputSchema = z.object({
  githubLogin: z
    .string()
    .trim()
    .regex(GITHUB_LOGIN, { message: 'Enter a GitHub username: letters, digits and single hyphens.' }),
  displayName: z.string().trim().min(1).max(100).refine(noControlCharacters, NO_CONTROL_MESSAGE),
  timeZone: z.string().trim().refine(isTimeZone, { message: 'Choose a time zone such as Asia/Kuala_Lumpur.' }),
  role: z.enum(MEMBER_ROLES)
})

const MEMBER_ID = z.uuid()
const DUPLICATE_LOGIN = '23505'

export async function addMemberFor(scope: AdminScope, input: unknown): Promise<AddMemberResult> {
  const parsed = AddMemberInputSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]!.message }
  try {
    return { ok: true, id: await scope.addMember(parsed.data) }
  } catch (e) {
    const err = safeDbError(e)
    if (err instanceof DbError && err.code === DUPLICATE_LOGIN) {
      return { ok: false, error: 'That GitHub login is already a member.' }
    }
    throw err
  }
}

export async function setRoleFor(scope: AdminScope, id: string, role: MemberRole): Promise<AdminResult> {
  const memberId = MEMBER_ID.parse(id)
  const parsedRole = z.enum(MEMBER_ROLES).parse(role)
  try {
    await scope.setRole(memberId, parsedRole)
    return { ok: true }
  } catch (e) {
    if (e instanceof LastAdminError) return { ok: false, error: e.message }
    throw e
  }
}

export async function removeMemberFor(scope: AdminScope, id: string, ntfy: NtfyAdmin): Promise<AdminResult> {
  const memberId = MEMBER_ID.parse(id)
  try {
    await scope.removeMember(memberId, ntfy)
    return { ok: true }
  } catch (e) {
    if (e instanceof MemberBusyError || e instanceof LastAdminError) return { ok: false, error: e.message }
    throw e
  }
}
