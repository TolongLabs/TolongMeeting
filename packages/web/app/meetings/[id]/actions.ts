'use server'

import { redirect } from 'next/navigation'
import { InputError, InUseError } from '../../../lib/identities'
import { requestDeleteNow, rerunPipeline } from '../../../lib/meeting'
import { getQueue } from '../../../lib/queue'
import { requireMember } from '../../../lib/session'

// Server actions: public endpoints, so each takes only the form (the meeting id) and gets the member from the session;
// Next refuses a server action whose Origin is not the site's own. Each ends in a redirect to the meeting page with a
// short code in the address. The page turns the code into a fixed sentence and shows nothing else from the address.

type Outcome = { notice: string } | { error: string }

function back(id: FormDataEntryValue | null, outcome: Outcome): never {
  const [kind, code] = Object.entries(outcome)[0]!
  redirect(`/meetings/${encodeURIComponent(typeof id === 'string' ? id : '')}?${kind}=${code}`)
}

/** Runs the summary again after the AI key failed. */
export async function rerunSummaryAction(form: FormData): Promise<void> {
  const scope = await requireMember()
  const id = form.get('id')
  let outcome: Outcome = { notice: 'rerun' }
  try {
    await rerunPipeline(scope, String(id), await getQueue())
  } catch (e) {
    if (e instanceof InUseError) outcome = { error: 'rerun_nothing' }
    else if (e instanceof InputError) outcome = { error: 'missing' }
    else throw e
  }
  back(id, outcome)
}

/** Deletes the meeting and everything saved for it. */
export async function deleteNowAction(form: FormData): Promise<void> {
  const scope = await requireMember()
  const id = form.get('id')
  let outcome: Outcome
  try {
    const result = await requestDeleteNow(scope, String(id), await getQueue())
    outcome = { notice: result === 'queued' ? 'delete_queued' : 'delete_later' }
  } catch (e) {
    if (e instanceof InUseError) outcome = { error: 'delete_blocked' }
    else if (e instanceof InputError) outcome = { error: 'missing' }
    else throw e
  }
  back(id, outcome)
}
