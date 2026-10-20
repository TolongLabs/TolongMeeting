import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { ACTIVE_STATES } from '@tm/core'
import { Notice } from '../../../components/Notice'
import { PageHeader } from '../../../components/PageHeader'
import { meetingData } from '../../../lib/meeting'
import { CONTROL_COPY } from '../../../lib/meeting-control'
import { requireMember } from '../../../lib/session'

/**
 * The page behind the pings' "Make the bot leave" and "Take over" links. Opening it changes nothing: the button does.
 * A meeting that is not the member's is the plain not-found page. A bot that is not in the meeting gets one sentence.
 */
export async function ControlPage({
  id,
  mode,
  panel
}: {
  id: string
  mode: 'leave' | 'take-over'
  /** The button, a client component the page file imports itself. Shown only while the bot is in the meeting. */
  panel: ReactNode
}) {
  const scope = await requireMember()
  const view = await meetingData(scope, id)
  if (view === null) notFound()
  const { occurrence } = view
  const intro = (mode === 'leave' ? CONTROL_COPY.leaveIntro : CONTROL_COPY.takeOverIntro).replaceAll(
    '<entry>',
    () => occurrence.entryName
  )
  return (
    <>
      <PageHeader title={mode === 'leave' ? CONTROL_COPY.leaveButton : 'Take over the meeting'}>
        <p>{occurrence.entryName}</p>
      </PageHeader>
      {ACTIVE_STATES.has(occurrence.state) ? (
        <>
          <p>{intro}</p>
          {panel}
        </>
      ) : (
        <Notice>{CONTROL_COPY.notRunning}</Notice>
      )}
      <p>
        <Link href={`/meetings/${occurrence.id}`}>Back to the meeting page</Link>
      </p>
    </>
  )
}
