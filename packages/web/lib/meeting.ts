import { and, eq, inArray, ne, notInArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  ACTIVE_STATES,
  normaliseMeetingLink,
  normaliseZoomLink,
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
import { openMemberFile } from './files'
import { PAST_LEAVING } from './meeting-control'
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
 * skipped (a file with no `## Transcript` heading has no transcript), and any other line after it (such as "No live transcript for this meeting.") is kept without a time.
 */
export function parseTranscript(md: string): TranscriptLine[] {
  const lines = md.split('\n')
  const heading = lines.findIndex((line) => line === '## Transcript')
  if (heading === -1) return []
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
  /** Where the bot joined, masked like the timetable's `maskedLink`: the host and the meeting id, never the passcode. */
  joinedLink: { host: string; meetingId: string | null } | null
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

const MEETING_HOST_SOURCE =
  '(?:[a-z0-9-]+\\.)*(?:zoom\\.us|zoomgov\\.com|zoom\\.com|teams\\.microsoft\\.com|teams\\.live\\.com|meet\\.google\\.com|webex\\.com|whereby\\.com|gotomeeting\\.com|bluejeans\\.com)'
/** A meeting-service host followed by a path, with or without a scheme. */
const MEETING_LINK = new RegExp(`(?:\\b[a-z][a-z0-9+.-]*://)?\\b${MEETING_HOST_SOURCE}\\b[^\\s"'<>)]*`, 'gi')
/** Any other URL with a scheme. */
const ANY_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi
/** Dropped by name, wherever they are nested: anything that names a passcode, a link, or a way in. */
const SECRET_KEY = /(pass(code|word)?|pwd|pw|link|url|join|invite)/i
const REMOVED = '[meeting link removed]'
/** A passcode phrase and its whole value, up to the end of the clause (newline, `;`, a closing bracket or quote, or a full stop). */
const PASSCODE_PHRASE = /\b(?:pass[\s-]?code|passwords?|passwd|pwd)\b[^\n;)\]"'<>]*?(?=[.!?](?:\s|$)|[\n;)\]"'<>]|$)/gi
/** Deeper than the heartbeat route lets event data nest (8), with room to spare. */
const REDACT_MAX_DEPTH = 16
const PASSCODE_REMOVED = '[passcode removed]'

/**
 * The only URLs event data may keep are those of the member's own form providers (Google Forms and Microsoft Forms),
 * and only with the passcode parameters cut. Every other URL is dropped whole, not only known meeting hosts.
 */
function keepUrl(url: string): string {
  if (!URL.canParse(url)) return REMOVED
  const { protocol, hostname, pathname } = new URL(url)
  const formsHost = (hostname === 'docs.google.com' && pathname.startsWith('/forms')) || hostname === 'forms.office.com'
  if (protocol !== 'https:' || !formsHost) return REMOVED
  // A join link can ride along percent-encoded in a query value.
  let decoded = url
  try {
    decoded = decodeURIComponent(decodeURIComponent(url))
  } catch {
    return REMOVED
  }
  if (new RegExp(MEETING_HOST_SOURCE, 'i').test(decoded)) return REMOVED
  return stripPasscode(url) || REMOVED
}

function redactString(text: string): string {
  return text.replace(MEETING_LINK, REMOVED).replace(ANY_URL, keepUrl).replace(PASSCODE_PHRASE, PASSCODE_REMOVED)
}

/**
 * Defence in depth: the worker already keeps links and passcodes out of event data, and the page must never show one.
 * Drops every key that names a passcode, link, URL, join or invite (any case, snake_case included) and cuts join links,
 * other URLs and passcode phrases out of every string.
 */
function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value)
  if (typeof value !== 'object' || value === null) return value
  // Data nested deeper than any worker event is cut, so a hostile row can't overflow the stack.
  if (depth >= REDACT_MAX_DEPTH) return '[too deep to show]'
  if (Array.isArray(value)) return value.map((inner) => redact(inner, depth + 1))
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SECRET_KEY.test(key))
      .map(([key, inner]) => [key, redact(inner, depth + 1)])
  )
}

/**
 * The link the bot joined with, cut down to its host and meeting id (`https://<host><path>`), or null when it is not a
 * Zoom, Teams or Meet join link. `link_used` is written by the worker's heartbeat (passcode already cut) and by the
 * launch (from a fixed link, which may carry one), so every read cuts the passcode again, runs the one meeting-link rule
 * and drops the query and fragment, so nothing the stored text held beyond the meeting id is ever shown.
 */
const MAX_JOINED_LINK_LENGTH = 2048

function cleanJoinedLink(stored: string | null): string | null {
  if (stored === null || stored.length > MAX_JOINED_LINK_LENGTH) return null
  const meeting = normaliseMeetingLink(stripPasscode(stored))
  if (meeting === null) return null
  const { origin, pathname } = new URL(meeting)
  return `${origin}${pathname}`
}

function maskedJoinedLink(stored: string | null): MeetingOccurrence['joinedLink'] {
  const clean = cleanJoinedLink(stored)
  if (clean === null) return null
  const zoom = normaliseZoomLink(clean)
  if (zoom !== null) {
    const { host, pathname } = new URL(zoom)
    return { host, meetingId: pathname.slice('/wc/join/'.length) }
  }
  const meeting = normaliseMeetingLink(clean)
  return meeting === null ? null : { host: new URL(meeting).host, meetingId: null }
}

/** The largest artefact the page reads into memory. Bigger files (a chat or transcript that size is not real) are refused. */
export const MAX_ARTEFACT_BYTES = 20 * 1024 * 1024

/** A registered text file is too big for the page to read. The message is fit to show to the member. */
export class ArtefactTooLargeError extends Error {
  constructor(relPath: string, bytes: number) {
    super(
      `${relPath} is too large to show here (${(bytes / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_ARTEFACT_BYTES / 1024 / 1024} MB).`
    )
    this.name = 'ArtefactTooLargeError'
  }
}

/**
 * The text of a registered artefact, or null when it has no row or its file is gone or not a safe regular file. It is
 * read from the verified open descriptor (`openMemberFile`), never from a path, and refused above `MAX_ARTEFACT_BYTES`.
 */
async function readArtefact(scope: MemberScope, occurrenceId: string, relPath: string): Promise<string | null> {
  const file = await openMemberFile(scope, occurrenceId, relPath)
  if (file === null) return null
  try {
    const { size } = await file.handle.stat()
    if (size > MAX_ARTEFACT_BYTES) throw new ArtefactTooLargeError(relPath, size)
    return await file.handle.readFile('utf8')
  } finally {
    await file.handle.close()
  }
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
      recording: row.recording,
      joinedLink: maskedJoinedLink(row.linkUsed)
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

/** What `takeOver` hands back: the link to open, and whether the passcode must come from the chat instead. */
export interface TakeOverLink {
  link: string | null
  /** True when the bot joined a link the server doesn't hold (one a chat watcher found): `link` has no passcode. */
  passcodeFromChat: boolean
  /** True when the bot is already out of the meeting (`leaving`, `uploading`): nothing is queued and nothing is waited for. */
  alreadyLeft: boolean
}

// Which meeting a link names, with the passcode and every other parameter gone.
const meetingOf = (link: string): string | null => normaliseMeetingLink(stripPasscode(link))

/**
 * The link the bot joined with, passcode included, for the owner's take-over response only. The bot reports its link
 * without the passcode, so the full link is the one the server already holds that names the same meeting: the link
 * pasted for this occurrence, else the entry's fixed link from `entry_snapshot`. A link a chat watcher found is not
 * held here, so the member gets the masked link and enters the passcode from the chat. Nothing is stored or logged.
 */
function takeOverLink(row: typeof occurrences.$inferSelect): TakeOverLink {
  const masked = cleanJoinedLink(row.linkUsed)
  if (masked === null) return { link: null, passcodeFromChat: false, alreadyLeft: false }
  const joined = meetingOf(masked)
  const fixed = row.entrySnapshot?.link.kind === 'fixed' ? row.entrySnapshot.link.url : null
  for (const held of [row.pastedLink, fixed]) {
    if (held !== null && joined !== null && meetingOf(held) === joined)
      return { link: held, passcodeFromChat: false, alreadyLeft: false }
  }
  return { link: masked, passcodeFromChat: true, alreadyLeft: false }
}

/**
 * Asks the bot to leave and hands the member the link it joined with, so the page can open the meeting once the bot is
 * out. Null when this is not the member's meeting. Only while the bot is in the meeting (or on its way in or out). The
 * command is queued once however often this is called. The link carries its passcode when the server holds it (see
 * `takeOverLink`); it is returned only here, to the owner, and stored nowhere new.
 */
export async function takeOver(scope: MemberScope, id: string): Promise<TakeOverLink | null> {
  if (!UUID.test(id)) return null
  return scope.transaction(async (s) => {
    const [row] = await s.select(occurrences, eq(occurrences.id, id))
    if (!row) return null
    if (!ACTIVE_STATES.has(row.state)) throw new InUseError('The bot is not in this meeting.')
    // A bot that is leaving or uploading is out of the meeting: say so at once instead of waiting through the upload.
    if (PAST_LEAVING.has(row.state)) return { ...takeOverLink(row), alreadyLeft: true }
    // `sendCommand` adds the word once and only while the state is active; 0 rows means it is already queued.
    await s.sendCommand(id, 'take_over')
    return takeOverLink(row)
  })
}

/** The state of one of the member's meetings, for the page that waits for the bot to leave. Null: not theirs. */
export async function controlState(scope: MemberScope, id: string): Promise<{ state: OccurrenceState } | null> {
  if (!UUID.test(id)) return null
  const [row] = await scope.select(occurrences, eq(occurrences.id, id))
  return row ? { state: row.state } : null
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

/** The states in which the pipeline consumer owns the occurrence: its `state_reason` must not be overwritten. */
const PIPELINE_STATES: OccurrenceState[] = ['transcribing', 'waiting_for_pc', 'post_processing']

/**
 * `queued`: the delete job is queued. `after_processing`: the pipeline is still working on the meeting, so the delete
 * waits ("Deleting as soon as processing finishes"); the pipeline consumer queues it when its run ends, and retention
 * removes the meeting if that never happens.
 */
export type DeleteNowResult = 'queued' | 'after_processing'

/**
 * Marks a finished meeting for deletion and queues the scheduler's delete. Refused while the bot is active. While the
 * pipeline owns the meeting (transcribing, waiting for the PC, post-processing) nothing is queued and `state_reason` is
 * left alone (the pipeline reads it): `delete_after` moves to now, and the consumer sees that when its run ends.
 */
export async function requestDeleteNow(scope: MemberScope, id: string, queue: Queue): Promise<DeleteNowResult> {
  if (!UUID.test(id)) throw new InputError(NOT_FOUND)
  const [row] = await scope.select(occurrences, eq(occurrences.id, id))
  if (!row) throw new InputError(NOT_FOUND)
  const tooLate = new InUseError('Make the bot leave before deleting this meeting.')
  if (ACTIVE_STATES.has(row.state)) throw tooLate
  if (PIPELINE_STATES.includes(row.state)) {
    // Guarded by the state: when the run ended since the read, the ordinary path below handles the meeting.
    const waiting = await scope.update(
      occurrences,
      { deleteAfter: sql`least(${occurrences.deleteAfter}, now())` as never },
      and(eq(occurrences.id, id), inArray(occurrences.state, PIPELINE_STATES))!
    )
    if (waiting > 0) return 'after_processing'
  }
  // The state is checked again in the update, so a bot that joined after the read still blocks the delete.
  const changed = await scope.update(
    occurrences,
    { stateReason: 'deleting' },
    and(
      eq(occurrences.id, id),
      ne(occurrences.state, 'deleted'),
      notInArray(occurrences.state, ACTIVE),
      notInArray(occurrences.state, PIPELINE_STATES)
    )!
  )
  if (changed === 0) throw tooLate
  await queue.send(QUEUES.deleteOccurrence, { occurrenceId: id })
  return 'queued'
}

/**
 * Runs the pipeline again after it stopped on an AI key error. The guard is the UPDATE itself (`ai_key_error` to
 * `rerun_queued`), so a double submit queues one job; a failed send puts the reason back.
 */
export async function rerunPipeline(scope: MemberScope, id: string, queue: Queue): Promise<void> {
  if (!UUID.test(id)) throw new InputError(NOT_FOUND)
  const [row] = await scope.select(occurrences, eq(occurrences.id, id))
  if (!row) throw new InputError(NOT_FOUND)
  const nothing = new InUseError('This meeting has nothing to run again.')
  if (row.state !== 'post_processing' || row.stateReason !== 'ai_key_error') throw nothing
  const claimed = await scope.update(
    occurrences,
    { stateReason: 'rerun_queued' },
    and(eq(occurrences.id, id), eq(occurrences.state, 'post_processing'), eq(occurrences.stateReason, 'ai_key_error'))!
  )
  if (claimed === 0) throw nothing
  try {
    await queue.send(QUEUES.pipeline, { occurrenceId: id })
  } catch (e) {
    await scope.update(
      occurrences,
      { stateReason: 'ai_key_error' },
      and(eq(occurrences.id, id), eq(occurrences.stateReason, 'rerun_queued'))!
    )
    throw e
  }
}
