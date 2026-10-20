import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import {
  ACTIVE_STATES,
  chatWatchAllowed,
  formatWhen,
  normaliseDiscordChannelUrl,
  normaliseMeetingLink,
  normaliseTeamsChatUrl,
  normaliseZoomLink,
  RepeatRuleSchema,
  watchGateFromEnv,
  type LinkSource,
  type WatchGate
} from '@tm/core'
import { pings, type Ping } from '@tm/notify'
import { loadMasterKey } from '../db/secrets'
import { safeDbError } from '../db/errors'
import { appNotifier, type Notifier } from '../db/notifier'
import type { Queue } from '../db/queues'
import { identities, occurrences, timetableEntries } from '../db/schema'
import { hasWorkingKey } from './ai-keys'
import { getQueue } from './queue'
import { ensureNtfy, ntfyAdminFromEnv } from './ntfy-admin'
import { InputError, InUseError, NO_CONTROL_MESSAGE, noControlCharacters } from './identities'
import { WatchingNotAllowedError } from './link-notices'
import type { MemberScope } from './scope'

export const RECORDING_NOTICE =
  "TolongMeeting records this meeting, including other participants' names and messages, and keeps it for 30 days. Check that recording and automated attendance are allowed here; that's your responsibility."
export const EMPLOYER_NOTICE =
  'Live transcription sends the meeting audio to Alibaba Cloud on your key. Check that your employer allows cloud AI processing of work meetings before choosing it.'

export class NoWorkingKeyError extends Error {
  constructor() {
    super('Add a working DashScope key on the AI keys page before scheduling meetings.')
    this.name = 'NoWorkingKeyError'
  }
}

export interface Clash {
  loser: string
  winner: string
  when: string
}

/** What the timetable needs from the outside world. Built per request by `appEntryDeps`; tests pass fakes. */
export interface EntryDeps {
  queue: Queue
  notifier: Notifier
  ensureNtfy: () => Promise<void>
  now: Date
  publicUrl: string
  gate: WatchGate
}

const CLASH_WINDOW_MS = 14 * 24 * 3_600_000
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

const text = (max: number) => z.string().trim().min(1).max(max).refine(noControlCharacters, NO_CONTROL_MESSAGE)

// Meeting links only for the platforms this build can join: Zoom and Teams. Meet arrives with plan 05.
// A link is accepted only if the worker would accept it (the one rule in `@tm/core`). The trimmed original is stored.
const FixedLinkSchema = z.object({
  kind: z.literal('fixed'),
  url: z
    .string()
    .trim()
    .max(2048)
    .refine(
      (url) => normaliseMeetingLink(url) !== null,
      'Enter a Zoom or Teams meeting link that starts with https://.'
    )
})

const WHATSAPP_NAME_MESSAGE = "Type the chat's name exactly as WhatsApp shows it."
const TEAMS_CHAT_MESSAGE = "Paste the chat's link from Teams (open the chat, then More options, then Copy link)."
const DISCORD_MESSAGE = "Paste the channel's address, such as https://discord.com/channels/<server>/<channel>."
const LINE_BREAKS = /[\p{Cc}\u2028\u2029]/u

/**
 * A chat source: a WhatsApp chat's exact name (NFC-normalised, 1 to 100 characters, one line), a Discord channel's
 * address (stored as `https://discord.com/channels/<server>/<channel>`), or a Teams chat's link (stored as
 * `https://<host>/l/chat/<thread>/conversations`).
 */
export const ChatLinkSchema = z
  .object({
    kind: z.literal('chat'),
    app: z.enum(['whatsapp', 'discord', 'teams']),
    chat: z.string().max(2048)
  })
  .transform((link, ctx) => {
    const fail = (message: string) => {
      ctx.issues.push({ code: 'custom', path: ['chat'], message, input: link.chat })
      return z.NEVER
    }
    const trimmed = link.chat.trim()
    if (link.app === 'discord') {
      const chat = normaliseDiscordChannelUrl(trimmed)
      return chat === null ? fail(DISCORD_MESSAGE) : { ...link, chat }
    }
    if (link.app === 'whatsapp') {
      const chat = trimmed.normalize('NFC')
      const length = Array.from(chat).length
      return length < 1 || length > 100 || LINE_BREAKS.test(chat) ? fail(WHATSAPP_NAME_MESSAGE) : { ...link, chat }
    }
    const chat = normaliseTeamsChatUrl(trimmed)
    return chat === null ? fail(TEAMS_CHAT_MESSAGE) : { ...link, chat }
  })

const LinkSchema = z.discriminatedUnion('kind', [
  FixedLinkSchema,
  ChatLinkSchema,
  z.object({ kind: z.literal('paste') }),
  // An edit sends this (or no link) to leave the stored link as it is, so the passcode never has to be shown again.
  z.object({ kind: z.literal('keep') })
])

const FormDetailsSchema = z.object({
  course_code: text(100).optional(),
  section: text(100).optional(),
  lecturer: text(100).optional()
})

export const EntryInputSchema = z
  .object({
    id: z.uuid().optional(),
    name: text(100),
    type: z.enum(['lecture', 'work']),
    repeat: RepeatRuleSchema,
    start: z.string().regex(TIME, 'Enter a start time as HH:MM.'),
    end: z.string().regex(TIME, 'Enter an end time as HH:MM.'),
    identityId: z.uuid(),
    link: LinkSchema.optional(),
    trustedSenders: z.array(text(100)).max(10).default([]),
    transcription: z.enum(['live', 'native']).optional(),
    formDetails: FormDetailsSchema.default({}),
    attendanceKeywords: z.array(text(60)).max(20).default([]),
    paused: z.boolean().optional()
  })
  .transform((value) => {
    const lecture = value.type === 'lecture'
    return {
      ...value,
      transcription: value.transcription ?? (lecture ? 'live' : 'native'),
      trustedSenders: lecture ? value.trustedSenders : [],
      formDetails: lecture ? value.formDetails : {},
      attendanceKeywords: lecture ? value.attendanceKeywords : []
    }
  })

export type EntryInput = z.output<typeof EntryInputSchema>

function parseEntry(input: unknown): EntryInput {
  const parsed = EntryInputSchema.safeParse(input)
  if (!parsed.success) throw new InputError(parsed.error.issues[0]!.message)
  return parsed.data
}

function parseId(id: unknown): string {
  const parsed = z.uuid().safeParse(id)
  if (!parsed.success) throw new InputError('No such entry.')
  return parsed.data
}

/**
 * What an edit page may show of a stored link: the host and meeting id of a Zoom link, or the host alone of a Teams
 * link (`meetingId: null`), never the passcode, thread or any other query. A chat source shows only its app, and a
 * pasted link has nothing to show.
 */
export type MaskedLink =
  | { kind: 'fixed'; host: string; meetingId: string | null }
  | { kind: 'chat'; app: 'whatsapp' | 'discord' | 'teams' }
  | { kind: 'paste' }

export function maskedLink(entry: { link: LinkSource }): MaskedLink {
  const { link } = entry
  if (link.kind === 'paste') return { kind: 'paste' }
  if (link.kind === 'chat') return { kind: 'chat', app: link.app }
  const zoom = normaliseZoomLink(link.url)
  if (zoom !== null) {
    const { host, pathname } = new URL(zoom)
    return { kind: 'fixed', host, meetingId: pathname.slice('/wc/join/'.length) }
  }
  const meeting = normaliseMeetingLink(link.url)
  if (meeting === null) throw new Error('stored link is not a Zoom or Teams meeting link')
  return { kind: 'fixed', host: new URL(meeting).host, meetingId: null }
}

/** The `Record<string, string>` the form details are stored as: the fields the member filled in. */
function filledDetails(details: EntryInput['formDetails']): Record<string, string> {
  return Object.fromEntries(Object.entries(details).filter((pair): pair is [string, string] => pair[1] !== undefined))
}

/**
 * Saves an entry (new, or the one named by `id`) and brings the member's occurrences in line with it, in one
 * transaction. Then it looks for clashes on the entry's identity over the next 14 days. If one involves this entry, it
 * pings the member once, about the first, and returns every such clash. Passcodes are never returned.
 */
export async function saveEntry(
  scope: MemberScope,
  input: unknown,
  deps: EntryDeps
): Promise<{ entryId: string; clashes: Clash[] }> {
  const value = parseEntry(input)
  if (!(await hasWorkingKey(scope))) throw new NoWorkingKeyError()
  const [identity] = await scope.select(identities, eq(identities.id, value.identityId))
  if (!identity) throw new InputError('No such identity.')
  // The link that will be stored: the one sent, or (on an edit that keeps or omits it) the one already stored.
  // The gate decides on that link and the identity's location, so a kept chat link cannot move to a refused identity.
  const kept = value.link === undefined || value.link.kind === 'keep'
  const stored =
    kept && value.id ? (await scope.select(timetableEntries, eq(timetableEntries.id, value.id)))[0]?.link : undefined
  const effective = kept ? stored : value.link
  if (effective?.kind === 'chat') {
    const gate = deps.gate
    if (!chatWatchAllowed(effective.app, identity.runLocation, gate))
      throw new WatchingNotAllowedError(effective.app, gate)
  }
  await deps.ensureNtfy()

  const values = {
    name: value.name,
    type: value.type,
    repeat: value.repeat,
    startTime: value.start,
    endTime: value.end,
    identityId: value.identityId,
    trustedSenders: value.trustedSenders,
    transcription: value.transcription,
    formDetails: filledDetails(value.formDetails),
    attendanceKeywords: value.attendanceKeywords,
    updatedAt: deps.now
  }
  // `keep` (or no link) leaves the stored link alone; only a create must name one.
  const link = value.link === undefined || value.link.kind === 'keep' ? null : value.link
  if (!value.id && !link) throw new InputError('Choose how to find the meeting link.')

  let entryId: string
  try {
    entryId = await scope.transaction(async (s) => {
      if (value.id) {
        // `paused` changes only when supplied: pausing and resuming go through `setPaused`.
        const changed = await s.update(
          timetableEntries,
          { ...values, ...(link && { link }), ...(value.paused !== undefined && { paused: value.paused }) },
          eq(timetableEntries.id, value.id)
        )
        if (changed === 0) throw new InputError('No such entry.')
        await s.syncOccurrences(deps.queue, deps.now)
        return value.id
      }
      const row = await s.insert(timetableEntries, { ...values, link: link!, paused: value.paused ?? false })
      await s.syncOccurrences(deps.queue, deps.now)
      return row.id
    })
  } catch (e) {
    throw safeDbError(e)
  }

  const timeZone = (await scope.me()).timeZone
  const clashes: Clash[] = (
    await scope.identityClashes(value.identityId, deps.now, new Date(deps.now.getTime() + CLASH_WINDOW_MS))
  )
    .filter((c) => c.winner.entryId === entryId || c.loser.entryId === entryId)
    .map((c) => ({
      loser: c.loser.entryName,
      winner: c.winner.entryName,
      when: formatWhen(c.loser.scheduledStart, timeZone)
    }))

  const [first] = clashes
  if (first) {
    const ping: Ping = pings.identityClashSaved({
      ...first,
      identity: identity.name,
      timetableUrl: `${deps.publicUrl}/timetable`
    })
    await deps.notifier.notify(scope.memberId, ping)
  }
  return { entryId, clashes }
}

/** Pauses or resumes an entry. Pausing removes its future sessions; resuming writes them back. */
export async function setPaused(scope: MemberScope, entryId: string, paused: boolean, deps: EntryDeps): Promise<void> {
  const id = parseId(entryId)
  if (typeof paused !== 'boolean') throw new InputError('Choose paused or running.')
  try {
    await scope.transaction(async (s) => {
      const changed = await s.update(timetableEntries, { paused, updatedAt: deps.now }, eq(timetableEntries.id, id))
      if (changed === 0) throw new InputError('No such entry.')
      await s.syncOccurrences(deps.queue, deps.now)
    })
  } catch (e) {
    throw safeDbError(e)
  }
}

/**
 * Deletes an entry and its future sessions. Refused while one of its occurrences is in progress. Occurrences that
 * already ran are kept: the sync only ever removes `scheduled` sessions that have not started.
 */
export async function deleteEntry(scope: MemberScope, entryId: string, deps: EntryDeps): Promise<void> {
  const id = parseId(entryId)
  try {
    await scope.transaction(async (s) => {
      const [busy] = await s.select(
        occurrences,
        and(eq(occurrences.entryId, id), inArray(occurrences.state, [...ACTIVE_STATES]))
      )
      if (busy) throw new InUseError('This entry has a meeting in progress.')
      const removed = await s.remove(timetableEntries, eq(timetableEntries.id, id))
      if (removed === 0) throw new InputError('No such entry.')
      await s.syncOccurrences(deps.queue, deps.now)
    })
  } catch (e) {
    throw safeDbError(e)
  }
}

/** The deps the running app uses for `scope`: the send-only queue, the app notifier and ntfy set up for the member. */
export async function appEntryDeps(scope: MemberScope): Promise<EntryDeps> {
  const publicUrl = process.env.TM_PUBLIC_URL
  if (!publicUrl) throw new Error('TM_PUBLIC_URL is not set')
  return {
    queue: await getQueue(),
    // Built on first use, so pausing and deleting work without NTFY_URL.
    notifier: { notify: (memberId, ping) => appNotifier().notify(memberId, ping) },
    ensureNtfy: async () => {
      await ensureNtfy(scope, ntfyAdminFromEnv(), loadMasterKey())
    },
    now: new Date(),
    publicUrl,
    // Read on first use, so only a save needs a valid gate: pausing and deleting work without it.
    get gate() {
      return watchGateFromEnv(process.env)
    }
  }
}
