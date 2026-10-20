'use client'

import Link from 'next/link'
import { useActionState, useEffect, useRef, useState, type ReactNode } from 'react'
import { FormField } from '../../components/FormField'
import { Notice } from '../../components/Notice'
import { SubmitButton } from '../../components/SubmitButton'
import { saveEntryFormAction } from './form-actions'
import type { ChatAppName, EntryFormClash, EntryFormProps, EntryFormState, EntryFormValues } from './form-state'

const DAYS = [
  ['1', 'Monday'],
  ['2', 'Tuesday'],
  ['3', 'Wednesday'],
  ['4', 'Thursday'],
  ['5', 'Friday'],
  ['6', 'Saturday'],
  ['7', 'Sunday']
] as const

const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  type: 'Type',
  'repeat-kind': 'Repeat',
  date: 'Date',
  days: 'Days',
  start: 'Start time',
  end: 'End time',
  identity: 'Identity',
  'link-kind': 'How to find the meeting link',
  'link-url': 'Meeting link',
  'link-app': 'Chat app',
  'link-chat': 'Chat',
  'trusted-senders': 'Trusted senders',
  'course-code': 'Course code',
  section: 'Section',
  lecturer: 'Lecturer',
  keywords: 'Attendance keywords',
  transcription: 'Transcription'
}

/** A group of radio buttons or checkboxes: a fieldset whose hint and error are tied to it. */
function Group(props: { id: string; legend: string; hint?: string; error?: string; children: ReactNode }) {
  const { id, hint, error } = props
  const described = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ')
  return (
    <fieldset id={id} className="field" aria-describedby={described || undefined}>
      <legend>{props.legend}</legend>
      {hint && (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      )}
      {props.children}
      {error && (
        <p id={`${id}-error`} className="field-error">
          Error: {error}
        </p>
      )}
    </fieldset>
  )
}

function Choice(props: {
  name: string
  value: string
  checked: boolean
  onChange: () => void
  type?: 'radio' | 'checkbox'
  disabled?: boolean
  note?: string | null
  children: ReactNode
}) {
  const noteId = props.note ? `${props.name}-${props.value}-note` : undefined
  return (
    <div>
      <label>
        <input
          type={props.type ?? 'radio'}
          name={props.name}
          value={props.value}
          checked={props.checked}
          onChange={props.onChange}
          disabled={props.disabled}
          aria-describedby={noteId}
        />{' '}
        {props.children}
      </label>
      {props.note && (
        <p id={noteId} className="hint">
          {props.note}
        </p>
      )}
    </div>
  )
}

/** One line for each pair of entries that overlap: the first time, and how many more times they overlap. */
function groupClashes(clashes: EntryFormClash[]) {
  const pairs = new Map<string, EntryFormClash & { more: number }>()
  for (const c of clashes) {
    const seen = pairs.get(`${c.loser}|${c.winner}`)
    if (seen) seen.more += 1
    else pairs.set(`${c.loser}|${c.winner}`, { ...c, more: 0 })
  }
  return [...pairs.values()]
}

/** The entry form for the new and edit pages. Every field is controlled, so a refused save never loses what was typed. */
export function EntryForm(props: EntryFormProps) {
  const { copy, editing } = props
  const [state, formAction] = useActionState<EntryFormState, FormData>(saveEntryFormAction, { status: 'idle' })
  const [v, setValues] = useState<EntryFormValues>(props.initial)
  const [transcriptionChosen, setTranscriptionChosen] = useState(editing)
  const summary = useRef<HTMLDivElement>(null)
  const set = <K extends keyof EntryFormValues>(key: K, value: EntryFormValues[K]) =>
    setValues((previous) => ({ ...previous, [key]: value }))

  // After a refused save, move to the list of problems so a screen reader announces them.
  useEffect(() => {
    if (state.status === 'error') summary.current?.focus()
  }, [state])

  if (state.status === 'saved') {
    return (
      <section aria-labelledby="saved">
        <h2 id="saved">Saved, with a clash</h2>
        <Notice kind="warn">
          This entry overlaps another entry on the same identity. Only one of two overlapping meetings can run.
        </Notice>
        <ul className="list">
          {groupClashes(state.clashes).map(({ loser, winner, when, more }) => (
            <li key={`${loser}|${winner}`}>
              {loser} overlaps {winner} on {when}
              {more > 0 && ` and ${more} more ${more === 1 ? 'time' : 'times'} in the next 14 days`}. {winner} keeps its
              place and {loser} is skipped.
            </li>
          ))}
        </ul>
        <p>Move one entry to another time, or give it another identity.</p>
        <p>
          <Link href={`/timetable/${state.entryId}`}>Edit this entry</Link> |{' '}
          <Link href="/timetable">Back to the timetable</Link>
        </p>
      </section>
    )
  }

  const errors = state.status === 'error' ? state.fields : {}
  const problems = Object.entries(errors)
  const defaultTranscription = (type: EntryFormValues['type']) => (type === 'lecture' ? 'live' : 'native')
  const chatOptions = props.chatOptions[v.identityId] ?? []
  const lecture = v.type === 'lecture'
  const chatCopy = copy.chat[v.chatApp]
  const watchesChat = v.linkKind === 'chat'
  const showsBanRisk = watchesChat && (v.chatApp === 'whatsapp' || v.chatApp === 'discord')
  const showsTeams = (watchesChat && v.chatApp === 'teams') || v.linkKind === 'fixed'

  return (
    <form action={formAction} noValidate>
      {editing && <input type="hidden" name="id" value={v.id} />}

      {state.status === 'error' && (problems.length > 0 || state.message) && (
        <div ref={summary} tabIndex={-1} className="error-summary">
          <Notice kind="error">
            {state.message && (
              <>
                {state.message} {state.help && <Link href={state.help.href}>{state.help.label}</Link>}
              </>
            )}
            {problems.length > 0 && (
              <>
                The entry was not saved. Fix {problems.length === 1 ? 'this problem' : 'these problems'}:
                <ul>
                  {problems.map(([field, message]) => (
                    <li key={field}>
                      <a href={`#${field}`}>{FIELD_LABELS[field] ?? field}</a>: {message}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Notice>
        </div>
      )}

      {!editing && <Notice>{copy.recording}</Notice>}

      <FormField id="name" label="Name" error={errors.name}>
        {(f) => <input {...f} name="name" type="text" value={v.name} onChange={(e) => set('name', e.target.value)} />}
      </FormField>

      <Group id="type" legend="Type" error={errors.type}>
        <Choice
          name="type"
          value="lecture"
          checked={lecture}
          onChange={() => {
            set('type', 'lecture')
            if (!transcriptionChosen) set('transcription', defaultTranscription('lecture'))
          }}
        >
          Lecture
        </Choice>
        <Choice
          name="type"
          value="work"
          checked={!lecture}
          onChange={() => {
            set('type', 'work')
            if (!transcriptionChosen) set('transcription', defaultTranscription('work'))
          }}
        >
          Work meeting
        </Choice>
      </Group>

      <Group id="repeat-kind" legend="Repeat" error={errors['repeat-kind']}>
        <Choice
          name="repeatKind"
          value="weekly"
          checked={v.repeatKind === 'weekly'}
          onChange={() => set('repeatKind', 'weekly')}
        >
          Every week on the days I choose
        </Choice>
        <Choice
          name="repeatKind"
          value="once"
          checked={v.repeatKind === 'once'}
          onChange={() => set('repeatKind', 'once')}
        >
          Once
        </Choice>
      </Group>
      {v.repeatKind === 'weekly' && (
        <Group id="days" legend="Days" error={errors.days}>
          {DAYS.map(([value, label]) => (
            <Choice
              key={value}
              type="checkbox"
              name="days"
              value={value}
              checked={v.days.includes(value)}
              onChange={() =>
                set('days', v.days.includes(value) ? v.days.filter((d) => d !== value) : [...v.days, value])
              }
            >
              {label}
            </Choice>
          ))}
        </Group>
      )}
      <FormField
        id="date"
        label={v.repeatKind === 'weekly' ? 'First day' : 'Date'}
        hint={v.repeatKind === 'weekly' ? 'The entry repeats from this day.' : undefined}
        error={errors.date}
      >
        {(f) => <input {...f} name="date" type="date" value={v.date} onChange={(e) => set('date', e.target.value)} />}
      </FormField>

      <FormField id="start" label="Start time" hint={`In your time zone, ${props.timeZone}.`} error={errors.start}>
        {(f) => (
          <input {...f} name="start" type="time" value={v.start} onChange={(e) => set('start', e.target.value)} />
        )}
      </FormField>
      <FormField id="end" label="Expected end time" error={errors.end}>
        {(f) => <input {...f} name="end" type="time" value={v.end} onChange={(e) => set('end', e.target.value)} />}
      </FormField>

      <FormField
        id="identity"
        label="Identity"
        hint="The identity sets where this meeting runs."
        error={errors.identity}
      >
        {(f) => (
          <select {...f} name="identityId" value={v.identityId} onChange={(e) => set('identityId', e.target.value)}>
            {props.identities.map((identity) => (
              <option key={identity.id} value={identity.id}>
                {identity.name} ({identity.where})
              </option>
            ))}
          </select>
        )}
      </FormField>

      <Group id="link-kind" legend="How to find the meeting link" error={errors['link-kind']}>
        {editing && (
          <Choice name="linkKind" value="keep" checked={v.linkKind === 'keep'} onChange={() => set('linkKind', 'keep')}>
            Keep the current link{props.currentLink ? ` (${props.currentLink})` : ''}
          </Choice>
        )}
        <Choice
          name="linkKind"
          value="fixed"
          checked={v.linkKind === 'fixed'}
          onChange={() => set('linkKind', 'fixed')}
        >
          {editing ? 'Use a new fixed link' : 'A fixed link'}
        </Choice>
        <Choice name="linkKind" value="chat" checked={v.linkKind === 'chat'} onChange={() => set('linkKind', 'chat')}>
          Watch a chat for the link
        </Choice>
        <Choice
          name="linkKind"
          value="paste"
          checked={v.linkKind === 'paste'}
          onChange={() => set('linkKind', 'paste')}
        >
          I will paste it
        </Choice>
      </Group>

      {v.linkKind === 'fixed' && (
        <FormField
          id="link-url"
          label="Meeting link"
          hint={
            (editing ? 'Typing a link replaces the current one. ' : '') +
            'A Zoom, Teams or Meet link that starts with https://. Paste the whole link.'
          }
          error={errors['link-url']}
        >
          {(f) => (
            <input
              {...f}
              name="url"
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={v.url}
              onChange={(e) => set('url', e.target.value)}
            />
          )}
        </FormField>
      )}

      {watchesChat && (
        <>
          <Group id="link-app" legend="Chat app" error={errors['link-app']}>
            {chatOptions.map((option) => (
              <Choice
                key={option.app}
                name="chatApp"
                value={option.app}
                checked={v.chatApp === option.app}
                onChange={() => set('chatApp', option.app)}
                disabled={!option.enabled && v.chatApp !== option.app}
                note={option.note}
              >
                {{ whatsapp: 'WhatsApp', discord: 'Discord', teams: 'Teams' }[option.app satisfies ChatAppName]}
              </Choice>
            ))}
          </Group>
          <FormField id="link-chat" label={chatCopy.label} hint={chatCopy.hint} error={errors['link-chat']}>
            {(f) => (
              <input
                {...f}
                name="chat"
                type="text"
                placeholder={chatCopy.placeholder}
                autoComplete="off"
                value={v.chat}
                onChange={(e) => set('chat', e.target.value)}
              />
            )}
          </FormField>
        </>
      )}
      {showsBanRisk && <Notice kind="warn">{copy.banRisk}</Notice>}
      {v.linkKind === 'paste' && (
        <p className="hint">Open the meeting page when the meeting is about to start and paste the link there.</p>
      )}
      {showsTeams && (
        <p className="hint">
          {v.linkKind === 'fixed' ? 'For a Teams meeting: ' : ''}
          {copy.teamsPresence}
        </p>
      )}

      {lecture && (
        <fieldset className="field">
          <legend>Lecture details</legend>
          <FormField
            id="trusted-senders"
            label="Trusted senders"
            hint={`Display names of the lecturer, one per line. Up to 10.${watchesChat ? ' ' + copy.trustedChatHint : ''}`}
            error={errors['trusted-senders']}
          >
            {(f) => (
              <textarea
                {...f}
                name="trustedSenders"
                rows={3}
                value={v.trustedSenders}
                onChange={(e) => set('trustedSenders', e.target.value)}
              />
            )}
          </FormField>
          <FormField id="course-code" label="Course code (optional)" error={errors['course-code']}>
            {(f) => (
              <input
                {...f}
                name="courseCode"
                type="text"
                value={v.courseCode}
                onChange={(e) => set('courseCode', e.target.value)}
              />
            )}
          </FormField>
          <FormField id="section" label="Section (optional)" error={errors.section}>
            {(f) => (
              <input
                {...f}
                name="section"
                type="text"
                value={v.section}
                onChange={(e) => set('section', e.target.value)}
              />
            )}
          </FormField>
          <FormField id="lecturer" label="Lecturer (optional)" error={errors.lecturer}>
            {(f) => (
              <input
                {...f}
                name="lecturer"
                type="text"
                value={v.lecturer}
                onChange={(e) => set('lecturer', e.target.value)}
              />
            )}
          </FormField>
          <FormField
            id="keywords"
            label="Extra attendance keywords (optional)"
            hint="Words that mark an attendance form, one per line. Up to 20."
            error={errors.keywords}
          >
            {(f) => (
              <textarea
                {...f}
                name="keywords"
                rows={3}
                value={v.keywords}
                onChange={(e) => set('keywords', e.target.value)}
              />
            )}
          </FormField>
        </fieldset>
      )}

      <Group id="transcription" legend="Transcription" error={errors.transcription}>
        <Choice
          name="transcription"
          value="live"
          checked={v.transcription === 'live'}
          onChange={() => {
            setTranscriptionChosen(true)
            set('transcription', 'live')
          }}
          note="Live: the words are written while the meeting runs, using your AI key."
        >
          Live
        </Choice>
        <Choice
          name="transcription"
          value="native"
          checked={v.transcription === 'native'}
          onChange={() => {
            setTranscriptionChosen(true)
            set('transcription', 'native')
          }}
          note="Native: your PC writes the words after the meeting."
        >
          Native
        </Choice>
      </Group>
      {!lecture && <Notice>{copy.employer}</Notice>}
      {!lecture && v.transcription === 'live' && (
        <p className="hint">
          {props.mentionNames.length > 0 ? (
            <>
              In live mode the bot pings you when it hears one of your names: {props.mentionNames.join(', ')}.{' '}
              <Link href="/details">Change your names on My details</Link>
            </>
          ) : (
            <>
              You have no names on My details, so you will get no mention alerts.{' '}
              <Link href="/details">Add names on My details</Link>
            </>
          )}
        </p>
      )}

      <p>
        <SubmitButton pendingLabel="Saving...">{editing ? 'Save changes' : 'Add entry'}</SubmitButton>{' '}
        <Link href="/timetable">Cancel</Link>
      </p>
    </form>
  )
}
