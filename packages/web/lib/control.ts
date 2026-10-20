import { createHash, timingSafeEqual } from 'node:crypto'
import {
  ACTIVE_STATES,
  AccountCheckDataSchema,
  HeartbeatSchema,
  IllegalTransition,
  SigninEventDataSchema,
  SigninHeartbeatSchema,
  StateEventDataSchema,
  canonicalFormUrl,
  isFormPageUrl,
  isPlainHttpsUrl,
  meetingUrl,
  normaliseMeetingLink,
  stripPasscode,
  triggerFor,
  type ControlCommand,
  type Heartbeat,
  type HeartbeatReply,
  type DeviceAuth,
  type MeetingEvent,
  type OccurrenceState,
  type SigninEventData,
  type SigninReply
} from '@tm/core'
import { pings, type Ping } from '@tm/notify'
import { and, count, eq, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  FORM_SOURCES,
  FORM_STATES,
  companionJobs,
  events,
  forms,
  getDb,
  members,
  occurrences,
  profiles,
  signinSessions,
  type Db
} from '../db'
import { getClaimedJob } from '../db/companion'
import type { Notifier } from '../db/notifier'
import { QUEUES, queueDbOf, type Queue } from '../db/queues'
import { applyTrigger, hashEventData } from '../db/transitions'
import { getAuth } from './auth'
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
/** How long the pipeline job waits before its first attempt: the worker container is usually gone by then. */
const PIPELINE_START_DELAY_MS = 20_000
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
  'restarting',
  'skipped_capacity',
  'skipped_identity_clash',
  'skipped_pc_offline'
])

/**
 * The in-meeting path, in order. A restarted worker whose heartbeat was lost reports a state on it that can be behind
 * the server's `resume_state` (it never saw the acknowledgement); on this path alone that is not a refusal.
 */
const MEETING_PATH: readonly OccurrenceState[] = ['joining', 'in_lobby', 'in_meeting']

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
  if (!isPlainHttpsUrl(url)) return null
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
  // The posted link may be a short link (forms.gle), so it only has to be a plain https URL: it is stored canonical when
  // it is a form page and as given otherwise. The page it led to (`finalUrl`) must be a provider form page.
  const finalUrl = f.finalUrl === null ? null : canonicalFormPage(f.finalUrl)
  const refused = !isPlainHttpsUrl(f.url) || (f.finalUrl !== null && finalUrl === null)
  // The times in the data are the worker's word, so they get the same window as an event's `at`.
  const outside = [f.seenAt, f.submittedAt].some(
    (t) => t !== null && !(Date.parse(t) >= range.from && Date.parse(t) <= range.to)
  )
  if (refused || outside) return logError({ reason: 'form_not_upserted', formId: f.formId })
  const url = canonicalFormPage(f.url) ?? f.url
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
    return { status: 200, body: await applyHeartbeat(tx, deps, row!, parsed.data, false) } as const
  })
}

// --- A heartbeat through the member's PC ------------------------------------------------------------------------

/** A PC may restart its local worker this many times; the next crash fails the run (the scheduler's `MAX_RESTARTS`). */
const LOCAL_MAX_RESTARTS = 3

export type DeviceHeartbeatDeps = HeartbeatDeps & {
  /** Sends the member's pings once the heartbeat has committed. */
  notifier: Notifier
  publicUrl: string
}

export type DeviceHeartbeatResult = HeartbeatResult | { status: 404; body: { error: string } }

const notFound = (): DeviceHeartbeatResult => ({ status: 404, body: { error: 'not_found' } })

/**
 * One heartbeat of a local run, sent by the member's PC for its worker (the container's own relay forwards it). The
 * device must hold the live `local_run` job `jobId` and the body must name that job's occurrence; anything else is
 * a 404 that says nothing more. From there it is checked like a server worker's heartbeat (`handleHeartbeat`): the
 * attempt must be the stored one, the same states may be entered, the server's clock judges event times, and the same
 * locked `applyHeartbeat` runs. A local run has no launcher-minted token: the PC's device token and its lease on the job
 * are the credential, and the run is named by the job row, never by the body.
 *
 * The PC speaks for the worker's restarts: a `restarting` report for attempt N+1 crashes the run (once), stores the
 * new attempt and pings the member once; the third restart is the last, the next one fails the run (`worker_unresponsive`)
 * and tells the PC to stop. A reported `transcribing` is held at `uploading`, so the pipeline never starts before
 * `complete`.
 */
export async function handleDeviceHeartbeat(
  deps: DeviceHeartbeatDeps,
  device: DeviceAuth,
  jobId: string,
  body: unknown
): Promise<DeviceHeartbeatResult> {
  const { db, now } = deps
  const first = await getClaimedJob(db, device, jobId, now)
  if (first === null || first.kind !== 'local_run') return notFound()
  const parsed = HeartbeatSchema.safeParse(body)
  if (!parsed.success) return badRequest()
  const hb = parsed.data
  if (hb.occurrenceId !== first.occurrenceId) return notFound()

  const outbox: { memberId: string; ping: Ping }[] = []
  const result = await db.transaction(async (tx): Promise<DeviceHeartbeatResult> => {
    let [row] = await tx.select().from(occurrences).where(eq(occurrences.id, first.occurrenceId)).for('update')
    // The lease is checked again under the row lock: a release or a failure may have come in meanwhile.
    const held = await getClaimedJob(tx, device, jobId, now)
    if (row === undefined || held === null) return notFound()
    if (row.state === 'deleted') return superseded()
    const url = meetingUrl(deps.publicUrl, row.id)

    if (hb.state === 'restarting' && hb.attempt === row.attempt + 1 && ACTIVE_STATES.has(row.state)) {
      const { restarts } = await applyTrigger(tx, row.id, 'crash')
      await tx.update(occurrences).set({ attempt: hb.attempt }).where(eq(occurrences.id, row.id))
      if (restarts > LOCAL_MAX_RESTARTS) {
        await applyTrigger(tx, row.id, 'fail', { reason: 'worker_unresponsive' })
        await tx
          .update(companionJobs)
          .set({ state: 'failed', error: 'worker_unresponsive', updatedAt: now })
          .where(and(eq(companionJobs.id, jobId), eq(companionJobs.state, 'claimed')))
        outbox.push({
          memberId: row.memberId,
          ping: pings.workerFailed({ entry: row.entryName, reason: 'it crashed 3 times', meetingUrl: url })
        })
        return { status: 200, body: { ackedEvents: 0, commands: ['stop'], link: null } }
      }
      outbox.push({
        memberId: row.memberId,
        ping: pings.workerRestarted({ entry: row.entryName, n: restarts, meetingUrl: url })
      })
      ;[row] = await tx.select().from(occurrences).where(eq(occurrences.id, row.id))
    }
    if (hb.attempt !== row!.attempt) return badRequest()
    return { status: 200, body: await applyHeartbeat(tx, deps, row!, hb, true) }
  })
  for (const { memberId, ping } of outbox) await deps.notifier.notify(memberId, ping)
  return result
}

/**
 * The link the worker joined with, as it may be stored: the passcode is cut (the container is untrusted and a link may
 * carry one), and only a Zoom, Teams or Meet join link passes. Anything else is ignored, not an error. It goes in no event.
 */
function storableLinkUsed(link: string | undefined): string | null {
  if (link === undefined) return null
  const clean = stripPasscode(link)
  return clean !== '' && normaliseMeetingLink(clean) !== null ? clean : null
}

/** Stores what an account check saw in `profiles.account_status`, stamped with the server's clock. */
async function recordAccount(
  tx: Db,
  row: { identityId: string; memberId: string },
  check: { account: string; signedIn: boolean },
  now: Date
): Promise<void> {
  const value = JSON.stringify({ verifiedAt: now.toISOString(), signedIn: check.signedIn })
  await tx
    .update(profiles)
    .set({
      accountStatus: sql`jsonb_set(${profiles.accountStatus}, array[${check.account}]::text[], ${value}::jsonb)`
    })
    .where(and(eq(profiles.identityId, row.identityId), eq(profiles.memberId, row.memberId)))
}

/**
 * The worker handed its desk to the member (`paused`: the session is ready) or took it back (`resumed`: it has ended,
 * `idle` or `done`). Only the worker-mode sessions of this heartbeat's own occurrence and member change.
 */
async function applySigninEvent(tx: Db, row: OccurrenceRow, data: SigninEventData, now: Date): Promise<void> {
  const mine = and(
    eq(signinSessions.occurrenceId, row.id),
    eq(signinSessions.memberId, row.memberId),
    eq(signinSessions.mode, 'worker')
  )
  if (data.signin === 'paused')
    await tx
      .update(signinSessions)
      .set({ state: 'ready', lastHeartbeatAt: now })
      .where(and(mine, eq(signinSessions.state, 'starting')))
  else
    await tx
      .update(signinSessions)
      .set({ state: 'ended', endedAt: now, endReason: data.reason === 'idle' ? 'idle' : 'done' })
      .where(and(mine, ne(signinSessions.state, 'ended')))
}

/**
 * Applies one heartbeat to a locked occurrence row. `viaDevice` is a heartbeat the PC forwards for a local run: a
 * reported `transcribing` is held at `uploading` (the PC has not uploaded anything yet; `complete` moves on and queues
 * the pipeline), so nothing here ever queues the pipeline for it.
 */
async function applyHeartbeat(
  tx: Db,
  deps: HeartbeatDeps,
  row: OccurrenceRow,
  hb: Heartbeat,
  viaDevice: boolean
): Promise<HeartbeatReply> {
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

  const moveTo = async (reported: OccurrenceState): Promise<void> => {
    const next = viaDevice && reported === 'transcribing' ? 'uploading' : reported
    if (next === current) return
    // A restarted worker is back in the meeting flow: when both its state and `resume_state` are on the in-meeting path,
    // it resumes at `resume_state` first, and what it reported is then judged from there. A worker still can't reach a
    // state after the meeting this way: the post-meeting states are not on the path.
    const resumeAt = row.resumeState
    if (
      current === 'restarting' &&
      resumeAt !== null &&
      next !== resumeAt &&
      MEETING_PATH.includes(resumeAt) &&
      MEETING_PATH.includes(next)
    ) {
      await moveTo(resumeAt)
      if (next === current) return
    }
    // After a restart, a state behind the server's on the path is a worker that is catching up (or an echo of its first
    // heartbeat), not an illegal move.
    if (row.restarts > 0 && MEETING_PATH.includes(next) && MEETING_PATH.indexOf(next) < MEETING_PATH.indexOf(current))
      return
    const trigger = triggerFor(current, next)
    // A worker may report progress. The server owns restarts, deletion and everything after the upload.
    // The one exception: the restarted attempt reports the state it resumes (`applyTrigger` accepts only `resume_state`).
    const resumes = current === 'restarting' && trigger === `resume:${row.resumeState}`
    const allowed =
      resumes || (WORKER_MOVES_FROM.has(current) && !WORKER_CANNOT_ENTER.has(next) && !trigger?.startsWith('resume:'))
    if (trigger === null || !allowed) return logIllegal(current, next)
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
    // Starts 20 s later, so the first attempt normally finds the worker container gone (the pipeline refuses to run before).
    if (current === 'transcribing')
      await queue.send(
        QUEUES.pipeline,
        { occurrenceId: row.id },
        { db: queueDbOf(tx), startAfter: new Date(now.getTime() + PIPELINE_START_DELAY_MS) }
      )
  }

  for (const [key, event] of unique) {
    if (!fresh.has(key)) continue
    if (event.type === 'state') {
      const check = AccountCheckDataSchema.safeParse(event.data)
      const change = StateEventDataSchema.safeParse(event.data)
      const signin = SigninEventDataSchema.safeParse(event.data)
      if (check.success) await recordAccount(tx, row, check.data, now)
      else if (change.success) await moveTo(change.data.state)
      else if (signin.success) await applySigninEvent(tx, row, signin.data, now)
    } else if (event.type === 'form') await upsertForm(tx, row, event.data, now, range, logError)
  }
  await moveTo(hb.state)

  const linkUsed = ACTIVE_STATES.has(current) ? storableLinkUsed(hb.linkUsed) : null
  await tx
    .update(occurrences)
    .set({
      lastHeartbeatAt: now,
      recording: hb.recording,
      participants: hb.participants,
      pendingCommands: [],
      ...(linkUsed === null ? {} : { linkUsed })
    })
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

// --- The sign-in container's heartbeat -----------------------------------------------------------------------------

/** A sign-in heartbeat body larger than this (bytes) is refused before it is parsed (a real one is under 1 KB). */
export const MAX_SIGNIN_BODY_BYTES = 16 * 1024

export type SigninHeartbeatResult = { status: 200; body: SigninReply } | { status: 400 | 401; body: { error: string } }

/** The database the sign-in route passes on. Routes never open the database themselves. */
export function signinDeps(): { db: Db } {
  return { db: getDb() }
}

const SIGNIN_TOKEN = /^Bearer (s\.[A-Za-z0-9_-]{1,200})$/
const signinUnauthorized = (): SigninHeartbeatResult => ({ status: 401, body: { error: 'unauthorized' } })
const signinBadRequest = (): SigninHeartbeatResult => ({ status: 400, body: { error: 'invalid request' } })

/**
 * One report from a sign-in container. The token (`Authorization: Bearer s.<random>`) is compared by its SHA-256 hash in
 * constant time against the row of `body.sessionId`; the member and the identity come from that row only. The first
 * report makes the session `ready`; one with `ended: true` ends it (reason `done`, `idle` or `error`) and stores the
 * account check it carries. The reply is `stop` once the member pressed Done, or when the session has ended already.
 */
export async function handleSigninHeartbeat(
  deps: { db: Db; now: Date },
  authorization: string | null,
  body: unknown
): Promise<SigninHeartbeatResult> {
  const header = SIGNIN_TOKEN.exec(authorization ?? '')
  if (!header) return signinUnauthorized()
  const hash = sha256hex(header[1]!)
  const target = z.object({ sessionId: z.uuid() }).safeParse(body)
  if (!target.success) return signinBadRequest()
  const { db, now } = deps

  const sameToken = (row: typeof signinSessions.$inferSelect | undefined) =>
    row !== undefined && row.mode === 'container' && sameHash(row.controlTokenHash, hash)
  // A cheap check first, so a caller without a valid token never holds the row lock.
  const [first] = await db.select().from(signinSessions).where(eq(signinSessions.id, target.data.sessionId))
  if (!sameToken(first)) return signinUnauthorized()
  const parsed = SigninHeartbeatSchema.safeParse(body)
  if (!parsed.success) return signinBadRequest()
  const hb = parsed.data

  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(signinSessions).where(eq(signinSessions.id, first!.id)).for('update')
    if (!sameToken(row)) return signinUnauthorized()
    const wasEnded = row!.state === 'ended'
    if (!wasEnded)
      await tx
        .update(signinSessions)
        .set(
          hb.ended
            ? { lastHeartbeatAt: now, state: 'ended', endedAt: now, endReason: hb.reason ?? 'done' }
            : { lastHeartbeatAt: now, state: 'ready' }
        )
        .where(eq(signinSessions.id, row!.id))
    // Only kind and result are stored; the container sends nothing else about an account.
    if (hb.ended) for (const check of hb.accounts ?? []) await recordAccount(tx, row!, check, now)
    return { status: 200, body: { commands: wasEnded || row!.doneRequested ? ['stop'] : [] } } as const
  })
}

/** `POST /api/control/signin`: the capped body, answered with `handleSigninHeartbeat`'s status and body. */
export async function handleSigninRequest(
  request: Request,
  deps: { db: Db },
  now: Date = new Date()
): Promise<Response> {
  // A caller without a well-formed token is refused before its body is read.
  if (!SIGNIN_TOKEN.test(request.headers.get('authorization') ?? ''))
    return Response.json(signinUnauthorized().body, { status: 401, headers: { 'cache-control': 'no-store' } })
  const raw = await readCapped(request, MAX_SIGNIN_BODY_BYTES)
  let body: unknown = null
  if (raw !== null && raw !== '') {
    try {
      body = JSON.parse(raw)
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e
    }
  }
  const result =
    raw === null
      ? signinBadRequest()
      : await handleSigninHeartbeat({ ...deps, now }, request.headers.get('authorization'), body)
  return Response.json(result.body, { status: result.status, headers: { 'cache-control': 'no-store' } })
}

// --- Forward auth for the remote view ------------------------------------------------------------------------------

export type VncDeps = { db: Db; getSession(headers: Headers): Promise<{ userId: string } | null> }

/** The database and the Better Auth session lookup the forward-auth route passes on. */
export function vncDeps(): VncDeps {
  return {
    db: getDb(),
    getSession: async (headers) => {
      const session = await getAuth().api.getSession({ headers })
      return session ? { userId: session.user.id } : null
    }
  }
}

/** `/vnc/<sessionId>/websockify`, with an optional query that holds no comma (a proxy joins repeated headers with one) or space. */
const VNC_PATH = /^\/vnc\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/websockify(\?[^,\s]*)?$/
const VNC_UPSTREAM = /^tm-(worker|signin)-[0-9a-f-]+(-a\d+)?:6080$/

/** Constant-time text comparison. */
function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Caddy's `forward_auth` check for `/vnc/<sessionId>/...`. It allows the request only for a signed-in member whose OWN
 * sign-in session, named in the forwarded path, is `ready`; the answer is the upstream to proxy to. No session is a 401;
 * everything else (another member's session, one that isn't ready, a path that isn't `/vnc/<uuid>/websockify`, an
 * `Origin` other than `TM_PUBLIC_URL`'s) is a 403 that says nothing more. Nothing here reads or returns a secret.
 */
export async function authoriseVnc(
  deps: VncDeps,
  headers: Headers
): Promise<{ status: 200; upstream: string } | { status: 401 | 403 }> {
  const session = await deps.getSession(headers)
  if (!session) return { status: 401 }
  const path = VNC_PATH.exec(headers.get('x-forwarded-uri') ?? '')
  if (!path) return { status: 403 }
  // A browser sends `Origin` on the WebSocket upgrade: a page of another site can't open the view with the member's cookie.
  const origin = headers.get('origin')
  if (origin !== null) {
    const publicUrl = process.env.TM_PUBLIC_URL
    if (!publicUrl) throw new Error('TM_PUBLIC_URL is not set')
    if (origin !== new URL(publicUrl).origin) return { status: 403 }
  }
  const [member] = await deps.db.select({ id: members.id }).from(members).where(eq(members.authUserId, session.userId))
  if (!member) return { status: 403 }
  const [row] = await deps.db.select().from(signinSessions).where(eq(signinSessions.id, path[1]!))
  if (
    !row ||
    !sameText(row.memberId, member.id) ||
    row.state !== 'ready' ||
    row.upstream === null ||
    !VNC_UPSTREAM.test(row.upstream)
  )
    return { status: 403 }
  return { status: 200, upstream: row.upstream }
}

/** `GET /api/vnc/authorize`: an empty 200 with `X-Vnc-Upstream`, or a fixed 401 or 403. Never cached. */
export async function authoriseVncRequest(request: Request, deps: VncDeps): Promise<Response> {
  const verdict = await authoriseVnc(deps, request.headers)
  if (verdict.status === 200)
    return new Response(null, {
      status: 200,
      headers: { 'x-vnc-upstream': verdict.upstream, 'cache-control': 'no-store' }
    })
  return Response.json(
    { error: verdict.status === 401 ? 'unauthorized' : 'forbidden' },
    { status: verdict.status, headers: { 'cache-control': 'no-store' } }
  )
}
