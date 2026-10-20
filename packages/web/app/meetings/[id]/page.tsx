import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ACTIVE_STATES, type OccurrenceState } from '@tm/core'
import { ExportPanel } from '../../../components/export-panel'
import { ConfirmForm } from '../../../components/ConfirmForm'
import { Markdown } from '../../../components/Markdown'
import { Notice } from '../../../components/Notice'
import { PageHeader } from '../../../components/PageHeader'
import { RelativeTime } from '../../../components/RelativeTime'
import { SubmitButton } from '../../../components/SubmitButton'
import { STATE_LABELS } from '../../../lib/labels'
import { meetingData, PASTE_STATES, type FormView, type MeetingView } from '../../../lib/meeting'
import {
  clock,
  eventDetail,
  EVENT_LABELS,
  FORM_SOURCE_LABELS,
  FORM_STATE_LABELS,
  splitHeard,
  TRUST_LABELS
} from '../../../lib/meeting-labels'
import { requireMember } from '../../../lib/session'
import { deleteNowAction, rerunSummaryAction } from './actions'
import { PasteLinkForm } from './paste-link-form'
import { SeekButton } from './seek-button'
import './meeting.css'

export const metadata: Metadata = { title: 'Meeting' }

/** What the address can say after an action. The code picks one of these sentences; nothing else from the address is shown. */
const NOTICES: Record<string, string> = {
  rerun: 'The summary is being written again. Reload this page in a few minutes.',
  delete_queued: 'Deleting this meeting.',
  delete_later: 'Deleting as soon as processing finishes.',
  link_saved: 'The meeting link was saved.'
}
const ERRORS: Record<string, string> = {
  rerun_nothing: 'This meeting has nothing to run again.',
  delete_blocked: 'Make the bot leave before deleting this meeting.',
  missing: 'This meeting does not exist.',
  link_bad: 'Paste a link that starts with https://.',
  link_too_late: 'A link can only be pasted before the bot joins.'
}

/** One sentence for a state that needs the member's attention, with an optional place to fix it. */
const STATE_NOTES: Partial<
  Record<OccurrenceState, { kind: 'info' | 'warn' | 'error'; text: string; link?: [string, string] }>
> = {
  waiting_for_signin: {
    kind: 'warn',
    text: 'The bot is waiting for you to sign in to an account.',
    link: ['/accounts', 'Sign in again']
  },
  watching_for_link: {
    kind: 'warn',
    text: 'Waiting for a meeting link.',
    link: ['#paste-link', 'Paste one now']
  },
  no_link: {
    kind: 'warn',
    text: 'No meeting link was found by the start time. The bot keeps watching for a link for 30 minutes after the start.'
  },
  denied: { kind: 'warn', text: 'The host did not let the bot into the meeting.' },
  restarting: { kind: 'warn', text: 'The bot dropped out and is rejoining. You can take over.' },
  waiting_for_pc: {
    kind: 'info',
    text: 'The transcript is waiting for your PC. One ping was sent. Open the companion app on your PC.'
  },
  transcribing: {
    kind: 'info',
    text: 'This meeting is still being processed. The summary appears here when it is ready.'
  },
  post_processing: {
    kind: 'info',
    text: 'This meeting is still being processed. The summary appears here when it is ready.'
  },
  failed: { kind: 'error', text: 'This meeting failed. What was recorded before the failure stays on this page.' },
  skipped_capacity: {
    kind: 'warn',
    text: 'Two meetings were already running. Switch the identity to run on your PC, or move an entry.',
    link: ['/timetable', 'Open the timetable']
  },
  skipped_identity_clash: {
    kind: 'warn',
    text: 'Another meeting was using the same identity. Move an entry, or give the meetings different identities.',
    link: ['/timetable', 'Open the timetable']
  },
  skipped_pc_offline: {
    kind: 'warn',
    text: 'Your PC was offline when the meeting started. Open the companion app on your PC before the next one.',
    link: ['/devices', 'Open Devices']
  }
}

function Attendance({ forms, timeZone, lecture }: { forms: FormView[]; timeZone: string; lecture: boolean }) {
  const submitted = forms.find((f) => f.state === 'submitted')
  if (submitted) {
    return (
      <p>
        <strong>Attendance:</strong> submitted. The form was seen at{' '}
        <RelativeTime at={submitted.seenAt} timeZone={timeZone} />.
      </p>
    )
  }
  const needsYou = forms.find((f) => f.state === 'needs_member')
  if (needsYou) {
    return (
      <p>
        <strong>Attendance:</strong> needs you. {FORM_STATE_LABELS.needs_member}.
      </p>
    )
  }
  const last = forms.at(-1)
  if (last) {
    return (
      <p>
        <strong>Attendance:</strong> a form was seen, but nothing was marked. {FORM_STATE_LABELS[last.state]}.
      </p>
    )
  }
  return lecture ? (
    <p>
      <strong>Attendance:</strong> no attendance form was seen.
    </p>
  ) : null
}

function Forms({ forms, timeZone }: { forms: FormView[]; timeZone: string }) {
  return (
    <section aria-labelledby="forms">
      <h2 id="forms">Forms seen</h2>
      <ul className="list">
        {forms.map((form, i) => (
          <li key={i}>
            <p>
              <strong>{FORM_STATE_LABELS[form.state]}.</strong> Seen at{' '}
              <RelativeTime at={form.seenAt} timeZone={timeZone} />.
            </p>
            <ul>
              <li>Found in: {FORM_SOURCE_LABELS[form.source]}.</li>
              {form.sender !== null && <li>Sent by: {form.sender}.</li>}
              {form.trustReason !== null && <li>Why it was trusted: {TRUST_LABELS[form.trustReason]}.</li>}
              <li>Fields filled: {form.fieldsFilled.length > 0 ? form.fieldsFilled.join(', ') : 'none'}.</li>
              {form.result !== null && <li>Result: {form.result.slice(0, 300)}</li>}
            </ul>
            {form.screenshotUrls.length > 0 && (
              <ul className="shots">
                {form.screenshotUrls.map((url, j) => (
                  <li key={url}>
                    <a href={url}>
                      <img
                        src={url}
                        alt={`Screenshot ${j + 1} of ${form.screenshotUrls.length} of this form`}
                        loading="lazy"
                      />
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function Transcript({ view }: { view: MeetingView }) {
  const { transcript, videoUrl, occurrence } = view
  return (
    <section aria-labelledby="transcript">
      <h2 id="transcript">Transcript</h2>
      {videoUrl !== null && (
        <>
          <video id="meeting-video" controls preload="metadata" src={videoUrl}>
            Your browser cannot play this recording.
          </video>
          <p>Press a time in the transcript to play the recording from there.</p>
        </>
      )}
      {transcript.length === 0 ? (
        <p>
          {ACTIVE_STATES.has(occurrence.state) || occurrence.state === 'transcribing'
            ? 'The transcript is not ready yet.'
            : 'There is no transcript for this meeting.'}
        </p>
      ) : (
        <>
          <p>
            <a href="#slides">Skip transcript</a>
          </p>
          <ol className="transcript list">
            {transcript.map((line, i) => (
              <li key={i} className={line.note ? 'note' : undefined}>
                <p>
                  {line.seconds !== null &&
                    (videoUrl !== null && !line.note ? (
                      <SeekButton seconds={line.seconds} label={clock(line.seconds)} />
                    ) : (
                      <>{clock(line.seconds)} </>
                    ))}
                  {line.note && <strong>Note: </strong>}
                  {splitHeard(line.text).map((part, j) =>
                    'heard' in part ? (
                      <span key={j} className="heard">
                        {' '}
                        (as heard: “{part.heard}”)
                      </span>
                    ) : (
                      <span key={j}>{part.text}</span>
                    )
                  )}
                </p>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  )
}

const MAX_EVENTS = 200

export default async function MeetingPage({
  params,
  searchParams
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ notice?: string | string[]; error?: string | string[] }>
}) {
  const scope = await requireMember()
  const { id } = await params
  const view = await meetingData(scope, id)
  if (view === null) notFound()
  const { timeZone } = await scope.me()
  const { occurrence, summaryMd, forms, slides, slidesNote, chatMd, events } = view
  const { notice, error } = await searchParams
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
  const noticeText = Object.hasOwn(NOTICES, first(notice) ?? '') ? NOTICES[first(notice)!] : undefined
  const errorText = Object.hasOwn(ERRORS, first(error) ?? '') ? ERRORS[first(error)!] : undefined
  const fieldError =
    first(error) === 'link_bad' ? ERRORS.link_bad : first(error) === 'link_too_late' ? ERRORS.link_too_late : undefined

  const { state, stateReason } = occurrence
  if (state === 'deleted') {
    return (
      <>
        <PageHeader title={occurrence.entryName} />
        <Notice>This meeting has been deleted. Your exports of it are not touched.</Notice>
        <p>
          <Link href="/">Go to Home</Link>
        </p>
      </>
    )
  }

  const active = ACTIVE_STATES.has(state)
  const note = STATE_NOTES[state]
  const deleting = stateReason === 'deleting'

  return (
    <>
      <PageHeader title={occurrence.entryName}>
        <p>
          <strong>{STATE_LABELS[state]}.</strong> Scheduled{' '}
          <RelativeTime at={occurrence.scheduledStart} timeZone={timeZone} /> to{' '}
          <RelativeTime at={occurrence.scheduledEnd} timeZone={timeZone} />.
          {occurrence.actualStart !== null && (
            <>
              {' '}
              The bot joined at <RelativeTime at={occurrence.actualStart} timeZone={timeZone} />
              {occurrence.actualEnd !== null && (
                <>
                  {' '}
                  and left at <RelativeTime at={occurrence.actualEnd} timeZone={timeZone} />
                </>
              )}
              .
            </>
          )}
          {occurrence.participants !== null && ` ${occurrence.participants} people were in the meeting.`}
        </p>
      </PageHeader>

      {noticeText && <Notice>{noticeText}</Notice>}
      {errorText && <Notice kind="error">{errorText}</Notice>}
      {note && (
        <Notice kind={note.kind}>
          {note.text} {note.link && <Link href={note.link[0]}>{note.link[1]}</Link>}
        </Notice>
      )}
      {deleting && <Notice>Deleting this meeting.</Notice>}
      {stateReason === 'rerun_queued' && <Notice>The summary is queued to be written again.</Notice>}

      {active && (
        <section aria-labelledby="live">
          <h2 id="live">The bot is in this meeting</h2>
          <ul>
            <li>
              <Link href={`/meetings/${occurrence.id}/leave`}>Make the bot leave</Link>
            </li>
            <li>
              <Link href={`/meetings/${occurrence.id}/take-over`}>Take over</Link>
            </li>
          </ul>
        </section>
      )}

      {PASTE_STATES.includes(state) && (
        <PasteLinkForm id={occurrence.id} currentLink={occurrence.joinedLink} error={fieldError} />
      )}

      <Attendance forms={forms} timeZone={timeZone} lecture={occurrence.entryType === 'lecture'} />

      <section aria-labelledby="summary">
        <h2 id="summary">Summary</h2>
        {summaryMd !== null ? (
          <Markdown md={summaryMd} />
        ) : (
          <p>{state === 'completed' ? 'No summary was written for this meeting.' : 'The summary is not ready yet.'}</p>
        )}
      </section>

      {stateReason === 'ai_key_error' && state === 'post_processing' && (
        <section aria-labelledby="rerun">
          <h2 id="rerun">The summary stopped</h2>
          <Notice kind="error">
            Your AI key was rejected, so the summary was not written. <Link href="/ai-keys">Fix your AI key</Link>, then
            run the summary again.
          </Notice>
          <form action={rerunSummaryAction}>
            <input type="hidden" name="id" value={occurrence.id} />
            <SubmitButton pendingLabel="Starting…">Run the summary again</SubmitButton>
          </form>
        </section>
      )}

      {forms.length > 0 && <Forms forms={forms} timeZone={timeZone} />}

      <Transcript view={view} />

      <section aria-labelledby="slides">
        <h2 id="slides">Slides</h2>
        {slidesNote !== null && <Notice>{slidesNote}</Notice>}
        {slides.length === 0 && slidesNote === null ? (
          <p>No slides were read for this meeting.</p>
        ) : slides.length > 0 ? (
          <ol className="list">
            {slides.map((slide) => (
              <li key={slide.n} className="slide">
                <h3>{slide.title !== '' ? `Slide ${slide.n}: ${slide.title}` : `Slide ${slide.n}`}</h3>
                <img src={slide.imageUrl} alt={`Slide ${slide.n}`} loading="lazy" />
                <p className="slide-text">{slide.text}</p>
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      <section aria-labelledby="chat">
        <h2 id="chat">Chat</h2>
        {chatMd !== null ? <Markdown md={chatMd} dropTitle /> : <p>No chat was saved for this meeting.</p>}
      </section>

      <section aria-labelledby="timeline">
        <h2 id="timeline">Timeline</h2>
        {events.length === 0 ? (
          <p>No events were recorded for this meeting.</p>
        ) : (
          <>
            {events.length > MAX_EVENTS && (
              <p>
                Showing the last {MAX_EVENTS} of {events.length} events.
              </p>
            )}
            <ol className="events">
              {events.slice(-MAX_EVENTS).map((event, i) => {
                const detail = eventDetail(event.type, event.data)
                return (
                  <li key={i}>
                    <RelativeTime at={event.at} timeZone={timeZone} />: {EVENT_LABELS[event.type]}
                    {detail !== null && `: ${detail}`}.
                  </li>
                )
              })}
            </ol>
          </>
        )}
      </section>

      {state === 'completed' ? (
        <ExportPanel occurrenceId={occurrence.id} timeZone={timeZone} />
      ) : (
        <section aria-labelledby="export-heading">
          <h2 id="export-heading">Export</h2>
          <p>You can export this meeting when it is completed.</p>
        </section>
      )}

      <section aria-labelledby="actions">
        <h2 id="actions">Delete</h2>
        {active ? (
          <p>Make the bot leave before deleting this meeting.</p>
        ) : deleting ? null : (
          <ConfirmForm
            action={deleteNowAction}
            label="Delete now"
            question="Delete this meeting and everything saved for it? This cannot be undone. Your exports are not touched."
            confirmLabel="Yes, delete this meeting"
          >
            <input type="hidden" name="id" value={occurrence.id} />
          </ConfirmForm>
        )}
      </section>
    </>
  )
}
