import Link from 'next/link'
import { EmptyState } from '../../../components/EmptyState'
import { Notice } from '../../../components/Notice'
import { PageHeader } from '../../../components/PageHeader'
import { requireMember } from '../../../lib/session'
import { timetableView } from '../../../lib/timetable-view'
import { EntryFormFor } from '../entry-page'

export const metadata = { title: 'Add a timetable entry' }

export default async function NewEntryPage() {
  const scope = await requireMember()
  const { identities, hasKey } = await timetableView(scope, new Date())

  return (
    <>
      <PageHeader title="Add a timetable entry">
        <p>
          <Link href="/timetable">Back to the timetable</Link>
        </p>
      </PageHeader>
      {identities.length === 0 ? (
        <EmptyState title="Add an identity first" action={{ href: '/accounts', label: 'Open Accounts' }}>
          <p>Every entry runs under an identity, such as University or Work. You have none yet.</p>
        </EmptyState>
      ) : (
        <>
          {!hasKey && (
            <Notice kind="warn">
              You have no working AI key. An entry cannot be saved without one.{' '}
              <Link href="/ai-keys">Add an AI key</Link>
            </Notice>
          )}
          <EntryFormFor scope={scope} entry={null} identities={identities} />
        </>
      )}
    </>
  )
}
