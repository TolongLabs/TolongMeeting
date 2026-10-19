// Control-channel and sign-in contracts shared by the website, the scheduler and the worker (plan 01c).
import { z } from 'zod'
import type { ControlCommand, EventType, Heartbeat, HeartbeatReply, OccurrenceState } from './types'

export const ACCOUNT_KINDS = ['zoom', 'microsoft', 'google', 'whatsapp', 'discord', 'teams'] as const

export type AccountKind = (typeof ACCOUNT_KINDS)[number]

export type AccountStatus = Partial<Record<AccountKind, { verifiedAt: string; signedIn: boolean }>>

/** The host paths and public URLs a container spec is built from (shared by the scheduler, the website and the pipeline). */
export type SpecEnv = { dataRoot: string; profileRoot: string; publicUrl: string; ntfyUrl: string }

/** What a worker `state` event carries when the state changed. */
export type StateEventData = { state: OccurrenceState }

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
export const StateEventDataSchema = z.object({ state: OccurrenceStateSchema })
export const AccountCheckDataSchema = z.object({ account: AccountKindSchema, signedIn: z.boolean() })

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
  events: z.array(MeetingEventSchema).max(MAX_HEARTBEAT_EVENTS)
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
