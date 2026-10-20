'use server'

import { createIdentityFor, deleteIdentityFor, updateIdentityFor, type IdentityResult } from '../../lib/action-results'
import { requireMember } from '../../lib/session'

// Server actions: public endpoints, so each takes only the form input and gets the member from the session.

export async function createIdentityAction(input: unknown): Promise<IdentityResult> {
  return createIdentityFor(await requireMember(), input)
}

export async function updateIdentityAction(id: string, input: unknown): Promise<IdentityResult> {
  return updateIdentityFor(await requireMember(), id, input)
}

export async function deleteIdentityAction(id: string): Promise<IdentityResult> {
  return deleteIdentityFor(await requireMember(), id)
}
