// Control-channel and sign-in contracts shared by the website, the scheduler and the worker (plan 01c).
import { createHash, createHmac } from 'node:crypto'
import { z } from 'zod'
import type { ControlCommand, EventType, Heartbeat, HeartbeatReply, OccurrenceState } from './types'

export const ACCOUNT_KINDS = ['zoom', 'microsoft', 'google', 'whatsapp', 'discord', 'teams'] as const

export type AccountKind = (typeof ACCOUNT_KINDS)[number]

export type AccountStatus = Partial<Record<AccountKind, { verifiedAt: string; signedIn: boolean }>>

/** The host paths and public URLs a container spec is built from (shared by the scheduler, the website and the pipeline). */
export type SpecEnv = { dataRoot: string; profileRoot: string; publicUrl: string; ntfyUrl: string }

/** Where the meeting link the bot joined came from. */
export const JOINED_LINK_SOURCES = ['fixed', 'watched', 'pasted'] as const

/** What a worker `state` event carries when the state changed. `link` (host only, never the URL) rides on `joining`. */
export type StateEventData = {
  state: OccurrenceState
  /** Only on `left_by_member`: the command that ended the meeting. */
  command?: 'leave_now' | 'take_over'
  link?: { source: (typeof JOINED_LINK_SOURCES)[number]; host: string }
}

/** What a worker `state` event carries after an account check. */
export type AccountCheckData = { account: AccountKind; signedIn: boolean }

/** Most events one heartbeat may carry. */
export const MAX_HEARTBEAT_EVENTS = 500

// Each table lists every member of its union, so adding a member to the type fails to compile until it is added here.
const OCCURRENCE_STATE_TABLE: Record<OccurrenceState, true> = {
  scheduled: true,
  starting: true,
  verifying_accounts: true,
  waiting_for_signin: true,
  watching_for_link: true,
  no_link: true,
  joining: true,
  in_lobby: true,
  denied: true,
  in_meeting: true,
  restarting: true,
  left_by_member: true,
  leaving: true,
  uploading: true,
  transcribing: true,
  waiting_for_pc: true,
  post_processing: true,
  completed: true,
  skipped_capacity: true,
  skipped_identity_clash: true,
  skipped_pc_offline: true,
  failed: true,
  deleted: true
}
const EVENT_TYPE_TABLE: Record<EventType, true> = {
  state: true,
  joined: true,
  notice_dismissed: true,
  form: true,
  alert: true,
  error: true,
  keyframe: true,
  recording_gap: true,
  mention: true,
  deletion: true
}

const CONTROL_COMMAND_TABLE: Record<ControlCommand, true> = {
  leave_now: true,
  take_over: true,
  pause_for_signin: true,
  resume_after_signin: true,
  stop: true
}

const keysOf = <T extends string>(table: Record<T, true>) => Object.keys(table) as [T, ...T[]]

export const OccurrenceStateSchema = z.enum(keysOf(OCCURRENCE_STATE_TABLE))
export const AccountKindSchema = z.enum(ACCOUNT_KINDS)
export const StateEventDataSchema = z.object({
  state: OccurrenceStateSchema,
  command: z.enum(['leave_now', 'take_over']).optional(),
  link: z.object({ source: z.enum(JOINED_LINK_SOURCES), host: z.string().min(1).max(255) }).optional()
}) satisfies z.ZodType<StateEventData>
export const AccountCheckDataSchema = z.object({ account: AccountKindSchema, signedIn: z.boolean() })

/** An `https:` URL of at most 2,048 characters. */
const httpsUrl = z
  .string()
  .max(2048)
  .refine((v) => URL.canParse(v) && new URL(v).protocol === 'https:', 'must be an https URL')

const stamp = z.iso.datetime({ offset: true })

export const MeetingEventSchema = z.object({
  occurrenceId: z.string().max(64),
  attempt: z.int().min(1).max(1_000_000),
  at: stamp,
  type: z.enum(keysOf(EVENT_TYPE_TABLE)),
  data: z.record(z.string(), z.unknown())
})

/**
 * The body of a heartbeat. An event type outside `EventType` fails, so does a state outside `OccurrenceState`, and
 * more than `MAX_HEARTBEAT_EVENTS` events. Unknown extra fields are dropped.
 */
export const HeartbeatSchema = z.object({
  occurrenceId: z.uuid(),
  attempt: z.int().min(1).max(1_000_000),
  state: OccurrenceStateSchema,
  recording: z.boolean(),
  participants: z.int().min(0).max(1_000_000).nullable(),
  events: z.array(MeetingEventSchema).max(MAX_HEARTBEAT_EVENTS),
  linkUsed: httpsUrl.optional()
}) satisfies z.ZodType<Heartbeat>

export const ControlCommandSchema = z.enum(keysOf(CONTROL_COMMAND_TABLE))

/**
 * What the server answers to a heartbeat. A command outside `ControlCommand` fails the whole reply: the worker checks
 * each command itself (see `HeartbeatReplyShapeSchema`) when it wants to ignore only the unknown ones.
 */
export const HeartbeatReplySchema = z.object({
  ackedEvents: z.int().min(0).max(MAX_HEARTBEAT_EVENTS),
  commands: z.array(ControlCommandSchema).max(32),
  link: z.string().max(4096).nullable()
}) satisfies z.ZodType<HeartbeatReply>

/** The reply with `commands` left as strings, so a worker can drop an unknown command and still use the rest. */
export const HeartbeatReplyShapeSchema = z.object({
  ackedEvents: HeartbeatReplySchema.shape.ackedEvents,
  commands: z.array(z.string().max(64)).max(32),
  link: HeartbeatReplySchema.shape.link
})

// --- Sign-in sessions (desk pause and sign-in container, plan 01c Task 17) ---

/** What the sign-in container reads from its job file (`--signin <file>`). */
export type SigninJob = {
  sessionId: string
  identityId: string
  profileDir: string
  checkpointsDir: string
  control: { url: string; token: string }
}

/**
 * The container's report to `<control.url>/signin`, every 5 s. `accounts` is sent once, with `ended: true`: what the
 * container saw of the accounts when the member finished.
 */
export type SigninHeartbeat = {
  sessionId: string
  idleMs: number
  ended: boolean
  reason?: 'done' | 'idle' | 'error'
  accounts?: AccountCheckData[]
}

/** The server's answer: `stop` (or `resume_after_signin`) is the member pressing "Done". */
export type SigninReply = { commands: ControlCommand[] }

/** What a worker `state` event carries when the desk was handed to the member for a sign-in, or taken back. */
export type SigninEventData = { signin: 'paused' | 'resumed'; reason?: 'command' | 'idle' }

export const SigninJobSchema = z.object({
  sessionId: z.uuid(),
  identityId: z.uuid(),
  profileDir: z.string().min(1),
  checkpointsDir: z.string().min(1),
  control: z.object({ url: z.string().min(1), token: z.string().min(1) })
}) satisfies z.ZodType<SigninJob>

export const SigninHeartbeatSchema = z.object({
  sessionId: z.uuid(),
  idleMs: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  ended: z.boolean(),
  reason: z.enum(['done', 'idle', 'error']).optional(),
  accounts: z.array(AccountCheckDataSchema).max(ACCOUNT_KINDS.length).optional()
}) satisfies z.ZodType<SigninHeartbeat>

export const SigninReplySchema = z.object({
  commands: z.array(ControlCommandSchema).max(32)
}) satisfies z.ZodType<SigninReply>

export const SigninEventDataSchema = z.object({
  signin: z.enum(['paused', 'resumed']),
  reason: z.enum(['command', 'idle']).optional()
}) satisfies z.ZodType<SigninEventData>

/** The control token as the server stores it: its SHA-256, hex. */
export const controlTokenHash = (token: string): string => createHash('sha256').update(token).digest('hex')

/**
 * The password of a session's remote view (x11vnc), from the stored hash of its control token: the worker has the
 * token, the website has the hash, and both get the same eight characters (the VNC protocol uses no more). The
 * password is never logged and never leaves the worker except through the member's own authenticated view.
 */
export const vncSecret = (tokenHash: string): string =>
  createHmac('sha256', tokenHash).update('tolongmeeting/vnc/v1').digest('base64url').slice(0, 8)
