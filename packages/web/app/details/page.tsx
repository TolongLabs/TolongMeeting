import type { Metadata } from 'next'
import { isWatchableName } from '@tm/core'
import { Notice } from '../../components/Notice'
import { PageHeader } from '../../components/PageHeader'
import { BUILTIN_DETAILS, loadDetails, MENTION_NAMES_COPY } from '../../lib/details'
import { requireMember } from '../../lib/session'
import { DetailsForm, type DetailRow } from './details-form'
import { CUSTOM_ROWS } from './form-state'

export const metadata: Metadata = { title: 'My details' }

const BUILTIN_HINTS: Record<string, string> = {
  student_id: 'Your matric number or student ID. Staff can put a staff number in your own details below.',
  university_email: 'The bot types this into attendance forms that ask for an email address.'
}

export default async function DetailsPage({ searchParams }: { searchParams: Promise<{ notice?: string | string[] }> }) {
  const scope = await requireMember()
  const [saved, me, { notice }] = await Promise.all([loadDetails(scope), scope.me(), searchParams])
  const byKey = new Map(saved.details.map((d) => [d.key, d]))
  const builtinKeys = new Set<string>(BUILTIN_DETAILS.map((d) => d.key))

  const builtin: DetailRow[] = BUILTIN_DETAILS.map(({ key, label }) => ({
    key,
    label,
    value: byKey.get(key)?.value ?? '',
    labels: byKey.get(key)?.labels ?? [],
    hint: BUILTIN_HINTS[key]
  }))
  const custom = [
    ...saved.details
      .filter((d) => !builtinKeys.has(d.key))
      .map((d) => ({ name: d.key.replaceAll('_', ' '), value: d.value, labels: d.labels })),
    ...Array.from({ length: CUSTOM_ROWS }, () => ({ name: '', value: '', labels: [] as string[] }))
  ]
  const unwatched = saved.mentionNames.filter((name) => !isWatchableName(name))

  return (
    <>
      <PageHeader title="My details">
        <p>
          The bot uses these to fill attendance forms for you, and the names below to tell you when someone calls you in
          a meeting. They are yours alone.
        </p>
        <p>
          Signed in as {me.displayName}. Your time zone is {me.timeZone}. An admin sets both.
        </p>
      </PageHeader>

      {notice === 'saved' && <Notice>Saved.</Notice>}
      {unwatched.length > 0 && (
        <Notice kind="warn">
          {unwatched.length === 1 ? 'This name is' : 'These names are'} saved but not watched: {unwatched.join(', ')}.
          Short names match too many words.
        </Notice>
      )}

      <DetailsForm
        builtin={builtin}
        custom={custom}
        mentionNames={saved.mentionNames}
        mentionHint={MENTION_NAMES_COPY.hint}
      />
    </>
  )
}
