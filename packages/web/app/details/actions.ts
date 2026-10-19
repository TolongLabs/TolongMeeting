import { InputError } from '../../lib/identities'
import { saveDetails } from '../../lib/details'
import type { MemberScope } from '../../lib/scope'

// Plain functions, not `'use server'` actions yet (see app/accounts/actions.ts). A validation failure comes back as its
// message; the saved values are never echoed back or logged.

export type DetailsResult = { ok: true } | { ok: false; error: string }

export async function saveDetailsFor(scope: MemberScope, input: unknown): Promise<DetailsResult> {
  try {
    await saveDetails(scope, input)
    return { ok: true }
  } catch (e) {
    if (e instanceof InputError) return { ok: false, error: e.message }
    throw e
  }
}
