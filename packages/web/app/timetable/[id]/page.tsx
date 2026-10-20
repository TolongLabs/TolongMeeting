import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ConfirmForm } from '../../../components/ConfirmForm'
import { Notice } from '../../../components/Notice'
import { PageHeader } from '../../../components/PageHeader'
import { SubmitButton } from '../../../components/SubmitButton'
import { listIdentities } from '../../../lib/identities'
import { requireMember } from '../../../lib/session'
import { entryById } from '../../../lib/timetable-view'
import { EntryFormFor } from '../entry-page'
import { deleteEntryFormAction, pauseEntryFormAction } from '../form-actions'

export const metadata = { title: 'Edit a timetable entry' }

const PROBLEMS: Record<string, string> = {
  busy: 'This entry has a meeting in progress. Wait until it ends, then try again.',
  gone: 'This entry no longer exists.',
  failed: 'That did not work. Try again.'
}

export default async function EditEntryPage(props: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ problem?: string }>
}) {
  const scope = await requireMember()
  const [{ id }, { problem }] = await Promise.all([props.params, props.searchParams])
  const entry = await entryById(scope, id)
  if (!entry) notFound()
  const identities = await listIdentities(scope)
  // Only a code from the list is shown; anything else in the URL is ignored and never echoed.
  const problemText = problem !== undefined && Object.hasOwn(PROBLEMS, problem) ? PROBLEMS[problem] : undefined

  return (
    <>
      <PageHeader title={`Edit ${entry.name}`}>
        <p>
          <Link href="/timetable">Back to the timetable</Link>
        </p>
      </PageHeader>
      {problemText && <Notice kind="error">{problemText}</Notice>}

      <section aria-labelledby="status">
        <h2 id="status">{entry.paused ? 'Paused' : 'Running'}</h2>
        <p>
          {entry.paused
            ? 'This entry is paused. No sessions are scheduled until you resume it.'
            : 'This entry is running. Its sessions are scheduled.'}
        </p>
        <form action={pauseEntryFormAction}>
          <input type="hidden" name="id" value={entry.id} />
          <input type="hidden" name="paused" value={entry.paused ? 'false' : 'true'} />
          <SubmitButton pendingLabel={entry.paused ? 'Resuming...' : 'Pausing...'}>
            {entry.paused ? 'Resume this entry' : 'Pause this entry'}
          </SubmitButton>
        </form>
      </section>

      <section aria-labelledby="details">
        <h2 id="details">Details</h2>
        <EntryFormFor scope={scope} entry={entry} identities={identities} />
      </section>

      <section aria-labelledby="delete">
        <h2 id="delete">Delete</h2>
        <ConfirmForm
          action={deleteEntryFormAction}
          label="Delete this entry"
          question={`Delete "${entry.name}" and all its future sessions? Meetings that already ran and their summaries stay.`}
          confirmLabel="Yes, delete this entry"
        >
          <input type="hidden" name="id" value={entry.id} />
        </ConfirmForm>
      </section>
    </>
  )
}
