import Link from 'next/link'
import { EmptyState } from '../../components/EmptyState'
import { Notice } from '../../components/Notice'
import { PageHeader } from '../../components/PageHeader'
import { RelativeTime } from '../../components/RelativeTime'
import { SubmitButton } from '../../components/SubmitButton'
import { requireMember } from '../../lib/session'
import { maskedLink } from '../../lib/timetable'
import { timetableView } from '../../lib/timetable-view'
import { describeLink, describeRepeat } from './entry-form-data'
import { pauseEntryFormAction } from './form-actions'

export const metadata = { title: 'Timetable' }

const NOTICES: Record<string, string> = {
  saved: 'Entry saved.',
  paused: 'Entry paused. Its future sessions are removed.',
  resumed: 'Entry resumed. Its sessions are scheduled again.',
  deleted: 'Entry deleted.'
}
const PROBLEMS: Record<string, string> = {
  busy: 'That entry has a meeting in progress. Wait until it ends, then try again.',
  gone: 'That entry no longer exists.',
  failed: 'That did not work. Try again.'
}

export default async function TimetablePage(props: { searchParams: Promise<{ notice?: string; problem?: string }> }) {
  const scope = await requireMember()
  const [{ notice, problem }, view] = await Promise.all([props.searchParams, timetableView(scope, new Date())])
  const { entries, identities, hasKey, timeZone } = view

  return (
    <>
      <PageHeader title="Timetable">
        {identities.length > 0 && (
          <p>
            <Link href="/timetable/new">Add an entry</Link>
          </p>
        )}
      </PageHeader>

      {notice && NOTICES[notice] && <Notice>{NOTICES[notice]}</Notice>}
      {problem && PROBLEMS[problem] && <Notice kind="error">{PROBLEMS[problem]}</Notice>}
      {!hasKey && (
        <Notice kind="warn">
          You have no working AI key, so entries cannot be saved or scheduled.{' '}
          <Link href="/ai-keys">Add an AI key</Link>
        </Notice>
      )}

      {identities.length === 0 ? (
        <EmptyState title="Add an identity first" action={{ href: '/accounts', label: 'Open Accounts' }}>
          <p>Every entry runs under an identity, such as University or Work. You have none yet.</p>
        </EmptyState>
      ) : entries.length === 0 ? (
        <EmptyState title="No timetable entries yet" action={{ href: '/timetable/new', label: 'Add your first entry' }}>
          <p>An entry is a lecture or work meeting the bot should attend. Times use your time zone, {timeZone}.</p>
        </EmptyState>
      ) : (
        <ul className="list">
          {entries.map(({ entry, identityName, next }) => (
            <li key={entry.id}>
              <h2>
                <Link href={`/timetable/${entry.id}`}>{entry.name}</Link>
                {entry.paused && <> (paused)</>}
              </h2>
              <p>
                {entry.type === 'lecture' ? 'Lecture' : 'Work meeting'}. {describeRepeat(entry.repeat)},{' '}
                {entry.startTime.slice(0, 5)} to {entry.endTime.slice(0, 5)}. Identity: {identityName}.
              </p>
              <p>
                {entry.paused ? (
                  'Paused: no sessions are scheduled.'
                ) : next ? (
                  <>
                    Next session: <RelativeTime at={next} timeZone={timeZone} />.
                  </>
                ) : (
                  'No session is scheduled yet.'
                )}{' '}
                {describeLink(maskedLink(entry))}.
              </p>
              <form action={pauseEntryFormAction}>
                <input type="hidden" name="id" value={entry.id} />
                <input type="hidden" name="paused" value={entry.paused ? 'false' : 'true'} />
                <SubmitButton pendingLabel={entry.paused ? 'Resuming...' : 'Pausing...'}>
                  {entry.paused ? `Resume ${entry.name}` : `Pause ${entry.name}`}
                </SubmitButton>
              </form>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
