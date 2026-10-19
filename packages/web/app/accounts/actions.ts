import { createIdentity, deleteIdentity, InputError, InUseError, updateIdentity } from '../../lib/identities'
import type { MemberScope } from '../../lib/scope'

// Plain functions, not `'use server'` actions yet, like app/ai-keys/actions.ts: the member's scope comes from
// `requireMember()` (plan 01c Task 5, `lib/session.ts`), which doesn't exist yet. Refusals the member can act on come back
// as a message; any other failure still throws.

export type IdentityResult = { ok: true } | { ok: false; error: string }

async function outcome(run: () => Promise<unknown>): Promise<IdentityResult> {
  try {
    await run()
    return { ok: true }
  } catch (e) {
    if (e instanceof InputError || e instanceof InUseError) return { ok: false, error: e.message }
    throw e
  }
}

export function createIdentityFor(scope: MemberScope, input: unknown): Promise<IdentityResult> {
  return outcome(() => createIdentity(scope, input))
}

export function updateIdentityFor(scope: MemberScope, id: string, input: unknown): Promise<IdentityResult> {
  return outcome(() => updateIdentity(scope, id, input))
}

export function deleteIdentityFor(scope: MemberScope, id: string): Promise<IdentityResult> {
  return outcome(() => deleteIdentity(scope, id))
}
