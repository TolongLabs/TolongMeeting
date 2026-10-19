import { safeDbError } from '../db/errors'
import { saveDetails } from './details'
import { createIdentity, deleteIdentity, InputError, InUseError, updateIdentity } from './identities'
import type { MemberScope } from './scope'

// Scope-taking helpers behind the server actions in `app/*/actions.ts`. They live here, not in the `'use server'` files:
// every export of a `'use server'` file is a public endpoint, and these take a scope the caller must not supply.
// Refusals the member can act on come back as a message; any other failure still throws. Saved values are never echoed.

export type IdentityResult = { ok: true } | { ok: false; error: string }
export type DetailsResult = { ok: true } | { ok: false; error: string }

async function outcome(run: () => Promise<unknown>): Promise<IdentityResult> {
  try {
    await run()
    return { ok: true }
  } catch (e) {
    if (e instanceof InputError || e instanceof InUseError) return { ok: false, error: e.message }
    throw safeDbError(e)
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

export async function saveDetailsFor(scope: MemberScope, input: unknown): Promise<DetailsResult> {
  try {
    await saveDetails(scope, input)
    return { ok: true }
  } catch (e) {
    if (e instanceof InputError) return { ok: false, error: e.message }
    throw safeDbError(e)
  }
}
