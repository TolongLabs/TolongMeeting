import { createHash, timingSafeEqual } from 'node:crypto'
import {
  ACTIVE_STATES,
  AccountCheckDataSchema,
  HeartbeatSchema,
  IllegalTransition,
  StateEventDataSchema,
  canonicalFormUrl,
  isFormPageUrl,
  triggerFor,
  type ControlCommand,
  type Heartbeat,
  type HeartbeatReply,
  type MeetingEvent,
  type OccurrenceState
} from '@tm/core'
import { and, count, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { FORM_SOURCES, FORM_STATES, events, forms, getDb, occurrences, profiles, type Db } from '../db'
import { QUEUES, queueDbOf, type Queue } from '../db/queues'
import { applyTrigger, hashEventData } from '../db/transitions'
import { getQueue } from './queue'

/** A heartbeat body larger than this (bytes) is refused before it is parsed. */
export const MAX_BODY_BYTES = 1_000_000

/** An event whose serialised `data` is larger than this (bytes) is dropped. */
export const MAX_EVENT_DATA_BYTES = 16 * 1024
/** An event whose `data` nests deeper than this is dropped (the top-level object is depth 1). */
export const MAX_EVENT_DATA_DEPTH = 8
/** Events stored for one occurrence; beyond this a heartbeat's events are acknowledged but dropped. */
export const MAX_EVENTS_PER_OCCURRENCE = 20_000
/** Forms stored for one occurrence. */
export const MAX_FORMS_PER_OCCURRENCE = 200
/** An event may be stamped this long after the server's clock. */
const FUTURE_SLACK_MS = 5 * 60_000
/** An event may be stamped this long before the occurrence's scheduled start. */
const PAST_SLACK_MS = 24 * 3_600_000

export type HeartbeatDeps = { db: Db; queue: Queue; now: Date }

export type HeartbeatResult =
  { status: 200 | 410; body: HeartbeatReply } | { status: 400 | 401; body: { error: string } }

/** The database and the queue the routes pass on. Routes never open the database themselves. */
export async function controlDeps(): Promise<{ db: Db; queue: Queue }> {
  return { db: getDb(), queue: await getQueue() }
}

// Fixed answers: nothing from the request, the token or the database is echoed back.
const unauthorized = (): HeartbeatResult => ({ status: 401, body: { error: 'unauthorized' } })
const badRequest = (): HeartbeatResult => ({ status: 400, body: { error: 'invalid request' } })
const superseded = (): HeartbeatResult => ({ status: 410, body: { ackedEvents: 0, commands: ['stop'], link: null } })

const TOKEN = /^Bearer (\d{1,7})\.([A-Za-z0-9_-]{1,200})$/
const sha256hex = (text: string): string => createHash('sha256').update(text).digest('hex')

function sameHash(stored: string | null, given: string): boolean {
  if (stored === null || stored.length !== given.length) return false
  return timingSafeEqual(Buffer.from(stored), Buffer.from(given))
}

type OccurrenceRow = typeof occurrences.$inferSelect

/** The states a worker may report a move from: the ones it runs in, plus `uploading`. */
const WORKER_MOVES_FROM: ReadonlySet<OccurrenceState> = new Set<OccurrenceState>([...ACTIVE_STATES, 'uploading'])
/** The states a worker can never move the occurrence to. (`transcribing` is reachable only from `uploading`.) */
const WORKER_CANNOT_ENTER: ReadonlySet<OccurrenceState> = new Set<OccurrenceState>([
  'deleted',
  'completed',
  'post_processing',
  'waiting_for_pc',
  'restarting'
])

/**
 * Whether the token belongs to this occurrence's current attempt. A token that doesn't match but names an older attempt
 * than the stored one is a superseded worker (its hash was replaced, so only the attempt prefix can be compared).
 */
function verdict(row: OccurrenceRow | undefined, token: string, tokenAttempt: number): 'ok' | 'superseded' | 'denied' {
  if (row === undefined) return 'denied'
  if (sameHash(row.controlTokenHash, sha256hex(token))) return row.state === 'deleted' ? 'superseded' : 'ok'
  return tokenAttempt < row.attempt ? 'superseded' : 'denied'
}

/** Whether `value` nests deeper than `limit`. Stops descending at the limit, so it never recurses further than that. */
function deeperThan(value: unknown, limit: number): boolean {
  if (typeof value !== 'object' || value === null) return false
  if (limit <= 0) return true
  return (Array.isArray(value) ? value : Object.values(value)).some((v) => deeperThan(v, limit - 1))
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/** Strips NUL characters and replaces lone surrogates, which Postgres refuses in text and jsonb. */
function clean<T>(value: T): T {
  if (typeof value === 'string') return value.replaceAll('\0', '').replace(LONE_SURROGATE, '\ufffd') as T
  if (Array.isArray(value)) return value.map(clean) as T
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [clean(k), clean(v)])) as T
  return value
}

// --- Form events ---------------------------------------------------------------------------------------------------

const text = (max: number) => z.string().transform((s) => s.slice(0, max))
const optional = <T extends z.ZodType>(schema: T) => schema.nullish().transform((v) => v ?? null)
const stamp = z.iso.datetime({ offset: true })

/** The `form` event data the worker sends (01b `formEventData`). An event without all of these is stored but not upserted. */
const FormEventSchema = z.object({
  formId: z.string().min(1).max(200),
  url: z.string().max(2000),
  finalUrl: optional(z.string().max(2000)),
  provider: optional(z.enum(['google', 'microsoft'])),
  source: z.enum(FORM_SOURCES),
  sender: optional(text(200)),
  senderRole: optional(z.enum(['host', 'co_host', 'participant', 'unknown'])),
  trustReason: optional(z.enum(['qr_on_screen', 'host', 'co_host', 'trusted_sender', 'org_restricted'])),
  state: z.enum(FORM_STATES),
  seenAt: stamp,
  submittedAt: optional(stamp),
  reason: optional(text(64)),
  fieldsFilled: z.array(text(120)).max(200).default([])
})

/** The URL without its query, or null when it isn't an https provider form page (a stored link is later shown to the member). */
function canonicalFormPage(url: string): string | null {
  if (!URL.canParse(url) || new URL(url).protocol !== 'https:') return null
  const canonical = canonicalFormUrl(url)
  return isFormPageUrl(canonical) ? canonical : null
}

async function upsertForm(
  tx: Db,
  row: OccurrenceRow,
  data: Record<string, unknown>,
  now: Date,
  range: { from: number; to: number },
  logError: (data: Record<string, unknown>) => Promise<void>
): Promise<void> {
  const parsed = FormEventSchema.safeParse(data)
  if (!parsed.success) return
  const f = parsed.data
  const url = canonicalFormPage(f.url)
  const finalUrl = f.finalUrl === null ? null : canonicalFormPage(f.finalUrl)
  if (url === null || (f.finalUrl !== null && finalUrl === null)) return
  // The times in the data are the worker's word, so they get the same window as an event's `at`.
  for (const t of [f.seenAt, f.submittedAt])
    if (t !== null && !(Date.parse(t) >= range.from && Date.parse(t) <= range.to)) return
  const [counted] = await tx.select({ n: count() }).from(forms).where(eq(forms.occurrenceId, row.id))
  if (counted!.n >= MAX_FORMS_PER_OCCURRENCE) {
    const [known] = await tx
      .select({ id: forms.id })
      .from(forms)
      .where(and(eq(forms.occurrenceId, row.id), eq(forms.formKey, f.formId)))
    if (!known) return logError({ reason: 'form_cap' })
  }
  const later = {
    finalUrl,
    provider: f.provider,
    sender: f.sender,
    senderRole: f.senderRole,
    trustReason: f.trustReason,
    state: f.state,
    submittedAt: f.submittedAt === null ? null : new Date(f.submittedAt),
    fieldsFilled: f.fieldsFilled,
    result: f.reason,
    updatedAt: now
  }
  // The first sight (url, source, seenAt) stays; everything the handler changes later is replaced.
  await tx
    .insert(forms)
    .values({
      ...later,
      occurrenceId: row.id,
      memberId: row.memberId,
      formKey: f.formId,
      url,
      source: f.source,
      seenAt: new Date(f.seenAt)
    })
    .onConflictDoUpdate({ target: [forms.occurrenceId, forms.formKey], set: later })
}

// --- handleHeartbeat -----------------------------------------------------------------------------------------------

/**
 * One heartbeat from a worker. The token (`Authorization: Bearer <attempt>.<random>`) is compared by its SHA-256 hash in
 * constant time; the occurrence and the member come from that row, never from the body's other fields. Replaying a
 * heartbeat stores each event once and applies each state change once.
 */
export async function handleHeartbeat(
  deps: HeartbeatDeps,
  authorization: string | null,
  body: unknown
): Promise<HeartbeatResult> {
  const header = TOKEN.exec(authorization ?? '')
  if (!header) return unauthorized()
  const token = `${header[1]}.${header[2]}`
  const tokenAttempt = Number(header[1])
  const target = z.object({ occurrenceId: z.uuid() }).safeParse(body)
  if (!target.success) return badRequest()
  const { db } = deps

  // A cheap check first, so a caller without a valid token never holds the row lock.
  const [first] = await db.select().from(occurrences).where(eq(occurrences.id, target.data.occurrenceId))
  const early = verdict(first, token, tokenAttempt)
  if (early === 'denied') return unauthorized()
  if (early === 'superseded') return superseded()
  const parsed = HeartbeatSchema.safeParse(body)
  if (!parsed.success) return badRequest()

  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(occurrences).where(eq(occurrences.id, first!.id)).for('update')
    const again = verdict(row, token, tokenAttempt)
    if (again === 'denied') return unauthorized()
    if (again === 'superseded') return superseded()
    if (parsed.data.attempt !== row!.attempt) return badRequest()
    return { status: 200, body: await applyHeartbeat(tx, deps, row!, parsed.data) } as const
  })
}

async function applyHeartbeat(tx: Db, deps: HeartbeatDeps, row: OccurrenceRow, hb: Heartbeat): Promise<HeartbeatReply> {
  const { now, queue } = deps
  // The worker's clock decides nothing that matters: an event outside this window is dropped, not moved into it.
  const range = { from: row.scheduledStart.getTime() - PAST_SLACK_MS, to: now.getTime() + FUTURE_SLACK_MS }
  let outOfRange = false
  let oversized = false
  const cleaned: MeetingEvent[] = []
  for (const e of hb.events) {
    const at = Date.parse(e.at)
    if (!(at >= range.from && at <= range.to)) outOfRange = true
    // The depth is checked before anything walks the data (`clean` and the hash recurse).
    else if (
      deeperThan(e.data, MAX_EVENT_DATA_DEPTH) ||
      Buffer.byteLength(JSON.stringify(e.data)) > MAX_EVENT_DATA_BYTES
    )
      oversized = true
    else cleaned.push({ ...e, data: clean(e.data) })
  }

  // Identical events (same time, type and data) are one event, in this heartbeat and across replays.
  const keyOf = (e: MeetingEvent) => `${Date.parse(e.at)}|${e.type}|${hashEventData(e.data)}`
  const all = [...new Map(cleaned.map((e) => [keyOf(e), e])).entries()]
  const [counted] = await tx.select({ n: count() }).from(events).where(eq(events.occurrenceId, row.id))
  const room = Math.max(0, MAX_EVENTS_PER_OCCURRENCE - counted!.n)
  const unique = all.slice(0, room)
  const stored =
    unique.length === 0
      ? []
      : await tx
          .insert(events)
          .values(
            unique.map(([, e]) => ({
              occurrenceId: row.id,
              memberId: row.memberId,
              attempt: row.attempt,
              at: new Date(e.at),
              type: e.type,
              data: e.data,
              dataHash: hashEventData(e.data)
            }))
          )
          .onConflictDoNothing()
          .returning({ at: events.at, type: events.type, dataHash: events.dataHash })
  const fresh = new Set(stored.map((s) => `${s.at.getTime()}|${s.type}|${s.dataHash}`))

  let current: OccurrenceState = row.state

  const logError = async (data: Record<string, unknown>): Promise<void> => {
    const dataHash = hashEventData(data)
    // The same refusal is logged once per attempt, not on every heartbeat that repeats it.
    const [seen] = await tx
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.occurrenceId, row.id),
          eq(events.attempt, row.attempt),
          eq(events.type, 'error'),
          eq(events.dataHash, dataHash)
        )
      )
      .limit(1)
    if (seen) return
    await tx.insert(events).values({
      occurrenceId: row.id,
      memberId: row.memberId,
      attempt: row.attempt,
      at: now,
      type: 'error',
      data,
      dataHash
    })
  }
  const logIllegal = (from: OccurrenceState, to: OccurrenceState) =>
    logError({ reason: 'illegal_transition', from, to })
  if (outOfRange) await logError({ reason: 'event_out_of_range' })
  if (oversized) await logError({ reason: 'event_too_large' })
  if (all.length > unique.length) await logError({ reason: 'event_cap' })

  const moveTo = async (next: OccurrenceState): Promise<void> => {
    if (next === current) return
    const trigger = triggerFor(current, next)
    // A worker may report progress. The server owns restarts, deletion and everything after the upload.
    if (
      trigger === null ||
      !WORKER_MOVES_FROM.has(current) ||
      WORKER_CANNOT_ENTER.has(next) ||
      trigger.startsWith('resume:')
    )
      return logIllegal(current, next)
    let result: Awaited<ReturnType<typeof applyTrigger>>
    try {
      result = await applyTrigger(tx, row.id, trigger, { recordEvent: false })
    } catch (e) {
      if (e instanceof IllegalTransition) return logIllegal(current, next)
      throw e
    }
    current = result.to
    // The server's clock, like the `hb.state` path: the worker's `at` only orders its events.
    const stamp = sql`${now.toISOString()}::timestamptz`
    if (current === 'in_meeting')
      await tx
        .update(occurrences)
        .set({ actualStart: sql`coalesce(${occurrences.actualStart}, ${stamp})` })
        .where(eq(occurrences.id, row.id))
    if (current === 'leaving')
      await tx
        .update(occurrences)
        .set({ actualEnd: sql`coalesce(${occurrences.actualEnd}, ${stamp})` })
        .where(eq(occurrences.id, row.id))
    // Sent on the same connection, so the job exists only if this heartbeat commits.
    if (current === 'transcribing') await queue.send(QUEUES.pipeline, { occurrenceId: row.id }, { db: queueDbOf(tx) })
  }

  for (const [key, event] of unique) {
    if (!fresh.has(key)) continue
    if (event.type === 'state') {
      const check = AccountCheckDataSchema.safeParse(event.data)
      const change = StateEventDataSchema.safeParse(event.data)
      if (check.success) {
        const value = JSON.stringify({ verifiedAt: now.toISOString(), signedIn: check.data.signedIn })
        await tx
          .update(profiles)
          .set({
            accountStatus: sql`jsonb_set(${profiles.accountStatus}, array[${check.data.account}]::text[], ${value}::jsonb)`
          })
          .where(and(eq(profiles.identityId, row.identityId), eq(profiles.memberId, row.memberId)))
      } else if (change.success) await moveTo(change.data.state)
    } else if (event.type === 'form') await upsertForm(tx, row, event.data, now, range, logError)
  }
  await moveTo(hb.state)

  await tx
    .update(occurrences)
    .set({ lastHeartbeatAt: now, recording: hb.recording, participants: hb.participants, pendingCommands: [] })
    .where(eq(occurrences.id, row.id))
  return { ackedEvents: hb.events.length, commands: row.pendingCommands as ControlCommand[], link: row.pastedLink }
}

// --- The request ---------------------------------------------------------------------------------------------------

/** Reads at most `limit` bytes of the body as text, or null when it is longer. */
async function readCapped(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) return null
  if (request.body === null) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** `POST /api/control/heartbeat`: reads the capped body and answers with `handleHeartbeat`'s status and body. */
export async function handleHeartbeatRequest(
  request: Request,
  deps: { db: Db; queue: Queue },
  now: Date = new Date()
): Promise<Response> {
  // A caller without a well-formed token is refused before its body is read.
  if (!TOKEN.test(request.headers.get('authorization') ?? ''))
    return Response.json(unauthorized().body, { status: 401, headers: { 'cache-control': 'no-store' } })
  const raw = await readCapped(request, MAX_BODY_BYTES)
  let body: unknown = null
  if (raw !== null && raw !== '') {
    try {
      body = JSON.parse(raw)
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e
    }
  }
  const result =
    raw === null ? badRequest() : await handleHeartbeat({ ...deps, now }, request.headers.get('authorization'), body)
  return Response.json(result.body, { status: result.status, headers: { 'cache-control': 'no-store' } })
}
