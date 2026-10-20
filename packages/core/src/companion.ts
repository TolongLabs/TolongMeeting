import { z } from 'zod'
import { formatDay, formatTime } from './schedule'
import {
  JobAiSchema,
  JobEntrySchema,
  JobIdentitySchema,
  JobMemberSchema,
  JobNtfySchema,
  OccurrenceIdSchema,
  SavedDetailSchema,
  type JobConfig,
  type NtfyConfig
} from './job'
import type { RunLocation, SavedDetail } from './types'

// Everything a PC sends is untrusted: its schemas are strict (unknown keys fail) and bounded in size. Schemas for what
// the server sends are strict too, so a drifting server fails loudly on the PC.

// --- Timings, caps and names ---

export const DEVICE_TOKEN_PREFIX = 'tmd_'
/** A claimed job returns to `pending` this long after the PC last renewed it. */
export const JOB_LEASE_MS = 300_000
/** How long a native job may wait for a PC claim before the occurrence moves to `waiting_for_pc`. */
export const PC_CLAIM_GRACE_MS = 120_000
export const NATIVE_MAX_ATTEMPTS = 2
/** A pairing code is valid this long. */
export const PAIRING_CODE_TTL_MS = 600_000
export const MAX_DEVICES_PER_MEMBER = 10
/** A device counts as online if it was seen within this window. */
export const DEVICE_ONLINE_WINDOW_MS = 90_000
export const LOCAL_HEARTBEAT_TIMEOUT_MS = 120_000
/** 3.75 GiB: a 4 GB Docker Desktop allotment reports about 3.8 GiB. */
export const MIN_DOCKER_MEM_BYTES = 4_026_531_840
export const UPLOAD_CHUNK_MAX_BYTES = 16 * 1024 * 1024
/** Form fields of the native transcript upload, in the order the companion sends them. */
export const NATIVE_UPLOAD_FIELDS = ['txt', 'srt', 'json'] as const
export const NATIVE_UPLOAD_MAX_FILE_BYTES = 50 * 1024 * 1024
export const NATIVE_UPLOAD_MAX_BODY_BYTES = 160 * 1024 * 1024
/** Most jobs, summaries or events one answer may carry. */
export const MAX_LIST_ITEMS = 50

const MAX_FLAC_BYTES = 16 * 1024 ** 3
const MAX_DURATION_SEC = 24 * 3600
const MAX_WHISPER_SEGMENTS = 200_000

// Each table lists every member of its union, so adding a member to the type fails to compile until it is added here.
const keysOf = <T extends string>(table: Record<T, true>) => Object.keys(table) as [T, ...T[]]

const RUN_LOCATION_TABLE: Record<RunLocation, true> = { server: true, server_via_home: true, local: true }
/** The values of `identities.run_location` (the database check constraint must list exactly these). */
export const RUN_LOCATIONS = keysOf(RUN_LOCATION_TABLE)
export const RunLocationSchema = z.enum(RUN_LOCATIONS)

// --- Shared field rules ---

const noControl = (s: string) => !/\p{Cc}/u.test(s)
const isTimeZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone })
    return true
  } catch (e) {
    if (e instanceof RangeError) return false
    throw e
  }
}

/** An id the server minted (job, device, identity): short, URL-safe. */
const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const stamp = z.iso.datetime({ offset: true })
const text = (max: number) => z.string().min(1).max(max).refine(noControl, 'control characters are not allowed')

export const NtfyConfigSchema = z.strictObject({
  url: z.url().max(2048),
  topic: z.string().regex(/^[^\s/?#\p{Cc}]{1,128}$/u),
  token: z.string().min(1).max(512)
}) satisfies z.ZodType<NtfyConfig>

// --- Devices and pairing ---

/** Who a device-token request acts as. Set by the server from the token, never read from a request body. */
export interface DeviceAuth {
  deviceId: string
  memberId: string
}

export interface PairRequest {
  code: string
  deviceName: string
}
export const PairRequestSchema = z.strictObject({
  code: z.string().regex(/^[A-Za-z0-9 -]{4,32}$/),
  deviceName: z.string().trim().min(1).max(64).refine(noControl, 'control characters are not allowed')
}) satisfies z.ZodType<PairRequest>

export interface PairResponse {
  deviceId: string
  token: string
  ntfy: NtfyConfig
  pairedAt: string
}
export const PairResponseSchema = z.strictObject({
  deviceId: IdSchema,
  token: z.string().startsWith(DEVICE_TOKEN_PREFIX).max(128),
  ntfy: NtfyConfigSchema,
  pairedAt: stamp
}) satisfies z.ZodType<PairResponse>

// --- Jobs ---

export type CompanionJobKind = 'native_transcription' | 'local_run'
const JOB_KIND_TABLE: Record<CompanionJobKind, true> = { native_transcription: true, local_run: true }
/** The values of `companion_jobs.kind`. */
export const COMPANION_JOB_KINDS = keysOf(JOB_KIND_TABLE)
export const CompanionJobKindSchema = z.enum(COMPANION_JOB_KINDS)

export type CompanionJobState = 'pending' | 'claimed' | 'done' | 'failed' | 'cancelled'
const JOB_STATE_TABLE: Record<CompanionJobState, true> = {
  pending: true,
  claimed: true,
  done: true,
  failed: true,
  cancelled: true
}
/** The values of `companion_jobs.state`. */
export const COMPANION_JOB_STATES = keysOf(JOB_STATE_TABLE)
export const CompanionJobStateSchema = z.enum(COMPANION_JOB_STATES)

export interface NativeJobPayload {
  occurrenceId: string
  entryName: string
  start: string
  timeZone: string
  durationSec: number
  flacBytes: number
}
export const NativeJobPayloadSchema = z.strictObject({
  occurrenceId: OccurrenceIdSchema,
  entryName: text(300),
  start: stamp,
  timeZone: z.string().max(64).refine(isTimeZone, 'unknown IANA time zone'),
  durationSec: z.int().min(1).max(MAX_DURATION_SEC),
  flacBytes: z.int().min(1).max(MAX_FLAC_BYTES)
}) satisfies z.ZodType<NativeJobPayload>

/** A `JobConfig` without what the server keeps from a PC: the AI key, the ntfy token, saved details and `control`. */
export type LocalJobTemplate = Omit<JobConfig, 'ai' | 'ntfy' | 'member' | 'control'> & {
  ai: Omit<JobConfig['ai'], 'apiKey'>
  ntfy: Omit<JobConfig['ntfy'], 'token'>
  member: Omit<JobConfig['member'], 'details'>
}
export const LocalJobTemplateSchema = z.strictObject({
  occurrenceId: OccurrenceIdSchema,
  attempt: z.int().min(1),
  entry: JobEntrySchema,
  identity: JobIdentitySchema,
  member: JobMemberSchema.omit({ details: true }).strict(),
  ai: JobAiSchema.omit({ apiKey: true }).strict(),
  ntfy: JobNtfySchema.omit({ token: true }).strict(),
  dataDir: z.string().startsWith('/'),
  profileDir: z.string().startsWith('/')
}) satisfies z.ZodType<LocalJobTemplate>

export interface LocalRunPayload {
  occurrenceId: string
  identityId: string
  identityName: string
  image: string
  job: LocalJobTemplate
}
export const LocalRunPayloadSchema = z.strictObject({
  occurrenceId: OccurrenceIdSchema,
  identityId: IdSchema,
  identityName: text(200),
  image: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,299}$/),
  job: LocalJobTemplateSchema
}) satisfies z.ZodType<LocalRunPayload>

export type CompanionJob = {
  id: string
  state: CompanionJobState
  occurrenceId: string
  attempts: number
} & ({ kind: 'native_transcription'; payload: NativeJobPayload } | { kind: 'local_run'; payload: LocalRunPayload })
const jobBase = {
  id: IdSchema,
  state: CompanionJobStateSchema,
  occurrenceId: OccurrenceIdSchema,
  attempts: z.int().min(0).max(1000)
}
export const CompanionJobSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...jobBase, kind: z.literal('native_transcription'), payload: NativeJobPayloadSchema }),
  z.strictObject({ ...jobBase, kind: z.literal('local_run'), payload: LocalRunPayloadSchema })
]) satisfies z.ZodType<CompanionJob>

/** What `GET /api/companion/jobs/<id>/secrets` answers for an active local run. */
export interface LocalSecrets {
  apiKey: string
  details: SavedDetail[]
}
export const LocalSecretsSchema = z.strictObject({
  apiKey: z.string().min(1).max(512),
  details: z.array(SavedDetailSchema).max(500)
}) satisfies z.ZodType<LocalSecrets>

/** The body of a failure report from the PC: a short reason, shown to the member. */
export interface JobFailureReport {
  error: string
}
export const JobFailureReportSchema = z.strictObject({ error: text(1000) }) satisfies z.ZodType<JobFailureReport>

// --- Native transcript ---

export type WhisperJson = { segments: { start: number; end: number; text: string }[] }
const second = z
  .number()
  .min(0)
  .max(10 * 86400)
/** The `json` output of whisper-transcriber: segments with start, end and text; every other key is kept as is. */
export const WhisperJsonSchema: z.ZodType<WhisperJson> = z.looseObject({
  segments: z
    .array(z.looseObject({ start: second, end: second, text: z.string().max(20_000) }))
    .max(MAX_WHISPER_SEGMENTS)
})

// --- Commands and events ---

export type CompanionCommand =
  | { type: 'job_available'; jobId: string }
  | { type: 'open_signin'; identityId: string }
  | { type: 'local_identities_changed' }
export const CompanionCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('job_available'), jobId: IdSchema }),
  z.strictObject({ type: z.literal('open_signin'), identityId: IdSchema }),
  z.strictObject({ type: z.literal('local_identities_changed') })
]) satisfies z.ZodType<CompanionCommand>

export interface CompanionEvent {
  id: number
  command: CompanionCommand
}
const eventId = z.int().min(1).max(Number.MAX_SAFE_INTEGER)
export const CompanionEventSchema = z.strictObject({
  id: eventId,
  command: CompanionCommandSchema
}) satisfies z.ZodType<CompanionEvent>
/** An event whose command is not checked yet, so a client can skip a command from a newer server and keep its id. */
export const CompanionEventEnvelopeSchema = z.strictObject({
  id: eventId,
  command: z.looseObject({ type: z.string().max(64) })
})

// --- Summaries ---

export interface SummaryListItem {
  occurrenceId: string
  fileName: string
  readyAt: string
}
export const SummaryListItemSchema = z.strictObject({
  occurrenceId: OccurrenceIdSchema,
  // A summary is always saved as Markdown, so a name that ends any other way is not one this app saves or opens.
  fileName: text(200).refine((n) => /\.md$/i.test(n), 'a summary file name must end in .md'),
  readyAt: stamp
}) satisfies z.ZodType<SummaryListItem>

// --- Run locations and local runs ---

export type RunLocationChoice =
  { location: 'server' } | { location: 'server_via_home' } | { location: 'local'; deviceId: string }
export const RunLocationChoiceSchema = z.discriminatedUnion('location', [
  z.strictObject({ location: z.literal('server') }),
  z.strictObject({ location: z.literal('server_via_home') }),
  z.strictObject({ location: z.literal('local'), deviceId: IdSchema })
]) satisfies z.ZodType<RunLocationChoice>

/** What `GET /api/companion/identities` answers: this PC's local identities and the worker image to pull. */
export interface LocalIdentitiesResponse {
  identities: { id: string; name: string }[]
  image: string
}
export const LocalIdentitiesResponseSchema = z.strictObject({
  identities: z.array(z.strictObject({ id: IdSchema, name: text(200) })).max(200),
  image: LocalRunPayloadSchema.shape.image
}) satisfies z.ZodType<LocalIdentitiesResponse>

export type PreflightReason = 'ok' | 'docker_unavailable' | 'docker_memory_low' | 'image_unavailable'
const PREFLIGHT_REASON_TABLE: Record<PreflightReason, true> = {
  ok: true,
  docker_unavailable: true,
  docker_memory_low: true,
  image_unavailable: true
}
export const PreflightReasonSchema = z.enum(keysOf(PREFLIGHT_REASON_TABLE))
export interface PreflightReport {
  reason: PreflightReason
  dockerMemBytes: number | null
}
export const PreflightReportSchema = z.strictObject({
  reason: PreflightReasonSchema,
  dockerMemBytes: z
    .int()
    .min(0)
    .max(2 ** 50)
    .nullable()
}) satisfies z.ZodType<PreflightReport>

// --- Formatting ---

/** `Wed 21 Oct` in the member's time zone. */
export function shortDate(iso: string, timeZone: string): string {
  return formatDay(new Date(iso), timeZone)
}

/** `14:00` in the member's time zone. */
export function shortTime(iso: string, timeZone: string): string {
  return formatTime(new Date(iso), timeZone)
}
