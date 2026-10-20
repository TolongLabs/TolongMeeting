'use server'

import { saveDetailsFor, type DetailsResult } from '../../lib/action-results'
import { requireMember } from '../../lib/session'

// A server action: a public endpoint, so it takes only the form input and gets the member from the session.

export async function saveDetailsAction(input: unknown): Promise<DetailsResult> {
  return saveDetailsFor(await requireMember(), input)
}
