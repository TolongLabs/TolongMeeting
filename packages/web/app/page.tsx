import Link from 'next/link'
import type { ReactNode } from 'react'
import { EmptyState } from '../components/EmptyState'
import { Notice } from '../components/Notice'
import { PageHeader } from '../components/PageHeader'
import { homeData, type HomeWarning, type OccurrenceCard } from '../lib/home'
import { ACCOUNT_LABELS, STATE_LABELS } from '../lib/labels'
import { requireMember } from '../lib/session'

/** A warning in plain words, with the one place that fixes it. */
function warningText(w: HomeWarning): { text: string; href: string; action: string } {
  switch (w.kind) {
    case 'no_ai_key':
      return {
        text: "You have no AI key. Meetings that need cloud AI can't be scheduled without a working key.",
        href: '/ai-keys',
        action: 'Add an AI key'
      }
    case 'ai_key_untested':
      return { text: 'Your AI key is not tested yet.', href: '/ai-keys', action: 'Test your AI key' }
    case 'ai_key_failing':
      return {
        text: 'Your AI key failed its last test. Summaries may not be written.',
        href: '/ai-keys',
        action: 'Fix your AI key'
      }
    case 'ntfy_not_set_up':
      return {
        text: "Notifications are not set up. You won't get pings about your meetings.",
        href: '/notifications',
        action: 'Set up notifications'
      }
    case 'account_signed_out':
      return {
        text: `${w.account ? ACCOUNT_LABELS[w.account] : 'An account'} is signed out${w.identity ? ` on ${w.identity}` : ''}. Meetings that need it will not start.`,
        href: '/accounts',
        action: 'Sign in again'
      }
  }
}

function Meetings<T extends OccurrenceCard>({ cards, children }: { cards: T[]; children?: (card: T) => ReactNode }) {
  return (
    <ul className="list">
      {cards.map((card) => (
        <li key={card.id}>
          <Link href={`/meetings/${card.id}`}>{card.name}</Link>, {card.when}. {children?.(card)}
        </li>
      ))}
    </ul>
  )
}

export default async function HomePage() {
  const scope = await requireMember()
  const { upcoming, inProgress, recent, warnings, deletingSoon } = await homeData(scope, new Date())
  const [next, ...later] = upcoming
  const nothingYet = !next && inProgress.length === 0 && recent.length === 0

  return (
    <>
      <PageHeader title="Home" />

      {(warnings.length > 0 || deletingSoon.length > 0) && (
        <section aria-labelledby="attention">
          <h2 id="attention">Needs your attention</h2>
          {warnings.map((w, i) => {
            const { text, href, action } = warningText(w)
            return (
              <Notice key={i} kind="warn">
                {text} <Link href={href}>{action}</Link>
              </Notice>
            )
          })}
          {deletingSoon.map((card) => (
            <Notice key={card.id} kind="warn">
              {card.name}, {card.when}, will be deleted within 3 days. Export it now or leave it.{' '}
              <Link href={`/meetings/${card.id}`}>Open the meeting</Link>
            </Notice>
          ))}
        </section>
      )}

      {nothingYet && (
        <EmptyState title="No meetings yet" action={{ href: '/timetable', label: 'Add your first timetable entry' }}>
          <p>You have no entries, meetings or summaries yet. Add an entry and it will appear here.</p>
        </EmptyState>
      )}

      {inProgress.length > 0 && (
        <section aria-labelledby="in-progress">
          <h2 id="in-progress">In progress</h2>
          <Meetings cards={inProgress}>{(card) => <strong>{STATE_LABELS[card.state]}</strong>}</Meetings>
        </section>
      )}

      {!nothingYet && (
        <section aria-labelledby="next">
          <h2 id="next">Next meeting</h2>
          {next ? (
            <Meetings cards={[next]} />
          ) : (
            <p>
              No meetings in the next 14 days. <Link href="/timetable">Open the timetable</Link>
            </p>
          )}
          {later.length > 0 && (
            <>
              <h3>After that</h3>
              <Meetings cards={later} />
            </>
          )}
        </section>
      )}

      {!nothingYet && (
        <section aria-labelledby="recent">
          <h2 id="recent">Recent meetings</h2>
          {recent.length === 0 ? (
            <p>No summaries yet. A summary appears here after a meeting is done.</p>
          ) : (
            <Meetings cards={recent}>
              {(card) => (
                <>
                  {STATE_LABELS[card.state]}. {card.doNext ?? 'No "Do next" line in this summary.'}
                </>
              )}
            </Meetings>
          )}
        </section>
      )}
    </>
  )
}
