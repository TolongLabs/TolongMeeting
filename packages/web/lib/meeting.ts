import { readFile } from 'node:fs/promises'
import { and, eq, inArray, ne, notInArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  ACTIVE_STATES,
  stripPasscode,
  type EntryType,
  type EventType,
  type FormSource,
  type FormState,
  type OccurrenceState,
  type TranscriptionMode,
  type TrustReason
} from '@tm/core'
import { artefacts, events, forms, occurrences } from '../db/schema'
import type { Queue } from '../db/queues'
import { QUEUES } from '../db/queues'
import { memberFile } from './files'
import { InputError, InUseError } from './identities'
import type { MemberScope } from './scope'

export interface TranscriptLine {
  /** Seconds from the recording start, or null for a line that has no time. */
  seconds: number | null
  text: string
  /** True for a note the pipeline wrote (a silence or a recording gap), not speech. */
  note?: true
}

// The two line shapes of `out/transcript.md` (packages/pipeline/src/transcript.ts, `renderBlock`).
const PARAGRAPH = /^\*\*\[(\d\d):(\d\d):(\d\d)\]\*\* (.*)$/
const NOTE = /^_\[(\d\d):(\d\d):(\d\d)\] (.*)_$/

const secondsOf = (h: string, m: string, s: string) => Number(h) * 3600 + Number(m) * 60 + Number(s)

/**
 * Reads `out/transcript.md`. Speech paragraphs and notes carry a time; the title and intro before `## Transcript` are
 * skipped, and any other line after it (such as "No live transcript for this meeting.") is kept without a time.
 */
export function parseTranscript(md: string): TranscriptLine[] {
  const lines = md.split('\n')
  const heading = lines.findIndex((line) => line === '## Transcript')
  const out: TranscriptLine[] = []
  for (const raw of lines.slice(heading + 1)) {
    const line = raw.trimEnd()
    if (line === '') continue
    const para = PARAGRAPH.exec(line)
    if (para) {
      out.push({ seconds: secondsOf(para[1]!, para[2]!, para[3]!), text: para[4]! })
      continue
    }
    const note = NOTE.exec(line)
    if (note) {
      out.push({ seconds: secondsOf(note[1]!, note[2]!, note[3]!), text: note[4]!, note: true })
      continue
    }
    out.push({ seconds: null, text: line.replace(/^_(.*)_$/, '$1'), note: true })
  }
  return out
}

const SlidesJson = z.array(
  z.object({
    n: z.number().int(),
    file: z.string().min(1),
    atMs: z.number(),
    title: z.string(),
    text: z.string(),
    failed: z.literal(true).optional()
  })
)

export const SLIDE_UNREADABLE = 'The text of this slide could not be read.'

export interface SlideView {
  n: number
  imageUrl: string
  title: string
  /** For a slide the vision model could not read this is `SLIDE_UNREADABLE`, never an empty string. */
  text: string
  failed: boolean
}

export interface FormView {
  seenAt: string
  source: FormSource
  sender: string | null
  trustReason: TrustReason | null
  fieldsFilled: string[]
  state: FormState
  result: string | null
  screenshotUrls: string[]
}

export interface MeetingOccurrence {
  id: string
  entryName: string
  entryType: EntryType
  state: OccurrenceState
  stateReason: string | null
  transcription: TranscriptionMode
  scheduledStart: string
  scheduledEnd: string
  actualStart: string | null
  actualEnd: string | null
  participants: number | null
  recording: boolean
}

export interface MeetingView {
  occurrence: MeetingOccurrence
  summaryMd: string | null
  forms: FormView[]
  transcript: TranscriptLine[]
  slides: SlideView[]
  chatMd: string | null
  events: { at: string; type: EventType; data: Record<string, unknown> }[]
  videoUrl: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VIDEO_PATH = 'recording/meeting.mp4'

/** `/api/meetings/<id>/files/<relPath>`, each segment percent-encoded. */
export function fileUrl(occurrenceId: string, relPath: string): string {
  return `/api/meetings/${occurrenceId}/files/${relPath.split('/').map(encodeURIComponent).join('/')}`
}

const MEETING_HOSTS =
  /(?:^|\.)(?:zoom\.us|zoomgov\.com|zoom\.com|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|webex\.com|whereby\.com|gotomeeting\.com|bluejeans\.com)$/i
const SECRET_KEY = /^(?:link|linkUsed|pastedLink|joinUrl|meetingLink|meetingUrl|passcode|pwd|password)$/i
const REMOVED = '[meeting link removed]'

function redactString(text: string): string {
  return text
    .replace(/https?:\/\/[^\s"'<>)]+/gi, (url) => {
      const host = URL.canParse(url) ? new URL(url).hostname : ''
      if (MEETING_HOSTS.test(host)) return REMOVED
      return stripPasscode(url) || REMOVED
    })
    .replace(/\b(passcode|password|pwd)\b(\s*[:=]\s*)\S+/gi, '$1$2[removed]')
}

/**
 * Defence in depth: the worker already keeps links and passcodes out of event data, and the page must never show one.
 * Drops keys that name a link or passcode and cuts join links and passcodes out of every string.
 */
function redact(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map(redact)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SECRET_KEY.test(key))
        .map(([key, inner]) => [key, redact(inner)])
    )
  }
  return value
}

/** The text of a registered artefact, or null when it has no row or its file is gone. */
async function readArtefact(scope: MemberScope, occurrenceId: string, relPath: string): Promise<string | null> {
  const file = await memberFile(scope, occurrenceId, relPath)
  if (file === null) return null
  return readFile(file, 'utf8')
}

type ArtefactRow = typeof artefacts.$inferSelect

const byAge = (a: ArtefactRow, b: ArtefactRow) =>
  a.createdAt.getTime() - b.createdAt.getTime() || a.path.localeCompare(b.path)

/**
 * Everything the meeting page shows, or null when the occurrence is not this member's. It holds neither the meeting
 * link nor the passcode: the occurrence fields are listed one by one and event data is redacted.
 */
export async function meetingData(scope: MemberScope, occurrenceId: string): Promise<MeetingView | null> {
  if (!UUID.test(occurrenceId)) return null
  const [row] = await scope.select(occurrences, eq(occurrences.id, occurrenceId))
  if (!row) return null

  const files = (await scope.select(artefacts, eq(artefacts.occurrenceId, occurrenceId))).sort(byAge)
  const firstOf = (kind: ArtefactRow['kind']) => files.find((f) => f.kind === kind)?.path
  const textOf = async (kind: ArtefactRow['kind']) => {
    const path = firstOf(kind)
    return path === undefined ? null : readArtefact(scope, occurrenceId, path)
  }

  const transcriptMd = await textOf('transcript')
  const slidesJson = await textOf('slides_json')
  const formRows = (await scope.select(forms, eq(forms.occurrenceId, occurrenceId))).sort(
    (a, b) => a.seenAt.getTime() - b.seenAt.getTime() || a.formKey.localeCompare(b.formKey)
  )
  const eventRows = (await scope.select(events, eq(events.occurrenceId, occurrenceId))).sort(
    (a, b) => a.at.getTime() - b.at.getTime() || a.id - b.id
  )

  return {
    occurrence: {
      id: row.id,
      entryName: row.entryName,
      entryType: row.entryType,
      state: row.state,
      stateReason: row.stateReason,
      transcription: row.transcription,
      scheduledStart: row.scheduledStart.toISOString(),
      scheduledEnd: row.scheduledEnd.toISOString(),
      actualStart: row.actualStart?.toISOString() ?? null,
      actualEnd: row.actualEnd?.toISOString() ?? null,
      participants: row.participants,
      recording: row.recording
    },
    summaryMd: await textOf('summary'),
    forms: formRows.map((f) => ({
      seenAt: f.seenAt.toISOString(),
      source: f.source,
      sender: f.sender,
      trustReason: f.trustReason,
      fieldsFilled: f.fieldsFilled,
      state: f.state,
      result: f.result,
      screenshotUrls: files
        .filter((a) => a.kind === 'form_screenshot' && a.path.startsWith(`forms/${f.formKey}/`))
        .map((a) => fileUrl(occurrenceId, a.path))
    })),
    transcript: transcriptMd === null ? [] : parseTranscript(transcriptMd),
    slides:
      slidesJson === null
        ? []
        : SlidesJson.parse(JSON.parse(slidesJson)).map((s) => ({
            n: s.n,
            imageUrl: fileUrl(occurrenceId, s.file),
            title: s.title,
            text: s.failed === true ? SLIDE_UNREADABLE : s.text,
            failed: s.failed === true
          })),
    chatMd: await textOf('chat'),
    events: eventRows.map((e) => ({
      at: e.at.toISOString(),
      type: e.type,
      data: redact(e.data) as Record<string, unknown>
    })),
    videoUrl: files.some((f) => f.path === VIDEO_PATH) ? fileUrl(occurrenceId, VIDEO_PATH) : null
  }
}

// Scope-taking helpers behind the server actions in `app/meetings/[id]/actions.ts`. They live here for the reason
// `lib/action-results.ts` gives: every export of a 'use server' file is a public endpoint, and these take a scope.

const ACTIVE = [...ACTIVE_STATES]
const PASTE_STATES: OccurrenceState[] = [
  'scheduled',
  'starting',
  'verifying_accounts',
  'waiting_for_signin',
  'watching_for_link'
]
const MAX_LINK_LENGTH = 2000

const NOT_FOUND = 'This meeting does not exist.'

/** Asks the bot to leave. Only while it is in the meeting (or on its way in or out). Asking twice does nothing more. */
export async function makeBotLeave(scope: MemberScope, id: string): Promise<void> {
  if (!UUID.test(id)) throw new InputError(NOT_FOUND)
  const changed = await scope.update(
    occurrences,
    {
      pendingCommands:
        sql`case when 'leave_now' = any(${occurrences.pendingCommands}) then ${occurrences.pendingCommands} else array_append(${occurrences.pendingCommands}, 'leave_now') end` as never
    },
    and(eq(occurrences.id, id), inArray(occurrences.state, ACTIVE))!
  )
  if (changed === 0) throw new InUseError('The bot is not in this meeting.')
}

/** Stores a link the member pasted for a meeting that has not started. The link is never echoed in an error. */
export async function pasteLink(scope: MemberScope, id: string, url: string): Promise<void> {
  if (!UUID.test(id)) throw new InputError(NOT_FOUND)
  const clean = url.trim()
  if (
    clean.length > MAX_LINK_LENGTH ||
    /\p{Cc}/u.test(clean) ||
    !URL.canParse(clean) ||
    new URL(clean).protocol !== 'https:'
  ) {
    throw new InputError('Paste a link that starts with https://.')
  }
  const changed = await scope.update(
    occurrences,
    { pastedLink: clean },
    and(eq(occurrences.id, id), inArray(occurrences.state, PASTE_STATES))!
  )
  if (changed === 0) throw new InUseError('A link can only be pasted before the bot joins.')
}

/** Marks a finished meeting for deletion and queues the scheduler's delete. Refused while the bot is active. */
export async function requestDeleteNow(scope: MemberScope, id: string, queue: Queue): Promise<void> {
  if (!UUID.test(id)) throw new InputError(NOT_FOUND)
  const [row] = await scope.select(occurrences, eq(occurrences.id, id))
  if (!row) throw new InputError(NOT_FOUND)
  const tooLate = new InUseError('Make the bot leave before deleting this meeting.')
  if (ACTIVE_STATES.has(row.state)) throw tooLate
  // The state is checked again in the update, so a bot that joined after the read still blocks the delete.
  const changed = await scope.update(
    occurrences,
    { stateReason: 'deleting' },
    and(eq(occurrences.id, id), ne(occurrences.state, 'deleted'), notInArray(occurrences.state, ACTIVE))!
  )
  if (changed === 0) throw tooLate
  await queue.send(QUEUES.deleteOccurrence, { occurrenceId: id })
}

/** Runs the pipeline again after it stopped on an AI key error. */
export async function rerunPipeline(scope: MemberScope, id: string, queue: Queue): Promise<void> {
  if (!UUID.test(id)) throw new InputError(NOT_FOUND)
  const [row] = await scope.select(occurrences, eq(occurrences.id, id))
  if (!row) throw new InputError(NOT_FOUND)
  if (row.state !== 'post_processing' || row.stateReason !== 'ai_key_error') {
    throw new InUseError('This meeting has nothing to run again.')
  }
  await queue.send(QUEUES.pipeline, { occurrenceId: id })
}
