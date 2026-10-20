import { getTableColumns, sql, type SQL } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
  type PgColumn,
  type PgTable
} from 'drizzle-orm/pg-core'
import type {
  EntryType,
  EventType,
  FormProvider,
  FormSource,
  FormState,
  JobConfig,
  LinkSource,
  OccurrenceState,
  RepeatRule,
  RunLocation,
  SenderRole,
  TranscriptionMode,
  TrustReason
} from '@tm/core'
import type { AccountStatus } from '@tm/core/control'
import { auth_user } from './auth-schema'

// The Better Auth tables (generated) are part of the schema, so drizzle-kit and `Db` see them.
export * from './auth-schema'

// Column values for the check constraints. Each list must cover its union: the `Covers` aliases below fail to
// compile when a value is missing from a list, and `satisfies` fails when a list holds a value the union lacks.

type Covers<Union, List extends readonly Union[]> = [Exclude<Union, List[number]>] extends [never] ? true : never

export const MEMBER_ROLES = ['member', 'admin'] as const
export type MemberRole = (typeof MEMBER_ROLES)[number]

export const RUN_LOCATIONS = ['server', 'server_via_home', 'local'] as const satisfies readonly RunLocation[]
export const PROFILE_LOCATIONS = ['server', 'local'] as const
export const ENTRY_TYPES = ['lecture', 'work'] as const satisfies readonly EntryType[]
export const TRANSCRIPTION_MODES = ['live', 'native'] as const satisfies readonly TranscriptionMode[]
export const OCCURRENCE_STATES = [
  'scheduled',
  'starting',
  'verifying_accounts',
  'waiting_for_signin',
  'watching_for_link',
  'no_link',
  'joining',
  'in_lobby',
  'denied',
  'in_meeting',
  'restarting',
  'left_by_member',
  'leaving',
  'uploading',
  'transcribing',
  'waiting_for_pc',
  'post_processing',
  'completed',
  'skipped_capacity',
  'skipped_identity_clash',
  'skipped_pc_offline',
  'failed',
  'deleted'
] as const satisfies readonly OccurrenceState[]
export const EVENT_TYPES = [
  'state',
  'joined',
  'notice_dismissed',
  'form',
  'alert',
  'error',
  'keyframe',
  'recording_gap',
  'mention',
  'deletion'
] as const satisfies readonly EventType[]
export const FORM_SOURCES = ['qr', 'meeting_chat', 'watched_chat'] as const satisfies readonly FormSource[]
export const FORM_STATES = [
  'detected',
  'resolving',
  'checking_trust',
  'untrusted',
  'opening',
  'awaiting_signin',
  'inspecting',
  'not_attendance',
  'quiz',
  'filling',
  'needs_member',
  'submitting',
  'submitted',
  'already_answered',
  'failed'
] as const satisfies readonly FormState[]
export const ARTEFACT_KINDS = [
  'recording',
  'summary',
  'transcript',
  'slides',
  'slides_json',
  'slide_image',
  'chat',
  'form_screenshot'
] as const
export type ArtefactKind = (typeof ARTEFACT_KINDS)[number]
export const CONNECTION_KINDS = ['google', 'github', 'notion'] as const
export type ConnectionKind = (typeof CONNECTION_KINDS)[number]
export const CONNECTION_STATUSES = ['ok', 'reconnect_needed'] as const
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number]
export const EXPORT_TARGETS = ['zip', 'pdf', 'github', 'gdocs', 'notion'] as const
export type ExportTarget = (typeof EXPORT_TARGETS)[number]
export const EXPORT_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const
export type ExportStatus = (typeof EXPORT_STATUSES)[number]
export const EXPORT_ERROR_CODES = [
  'not_connected',
  'reconnect_needed',
  'invalid_settings',
  'not_found',
  'already_running',
  'not_ready',
  'meeting_deleted',
  'rate_limited',
  'interrupted',
  'failed'
] as const
export type ExportErrorCode = (typeof EXPORT_ERROR_CODES)[number]
export const SIGNIN_MODES = ['worker', 'container'] as const
export const SIGNIN_STATES = ['starting', 'ready', 'ended'] as const

const completeLists: [
  Covers<RunLocation, typeof RUN_LOCATIONS>,
  Covers<EntryType, typeof ENTRY_TYPES>,
  Covers<TranscriptionMode, typeof TRANSCRIPTION_MODES>,
  Covers<OccurrenceState, typeof OCCURRENCE_STATES>,
  Covers<EventType, typeof EVENT_TYPES>,
  Covers<FormSource, typeof FORM_SOURCES>,
  Covers<FormState, typeof FORM_STATES>
] = [true, true, true, true, true, true, true]
void completeLists

// `column in ('a', 'b')`; the values are our own constants, so they are inlined (a check cannot take parameters).
function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} in (${sql.join(
    values.map((v) => sql.raw(`'${v}'`)),
    sql.raw(', ')
  )})`
}

const lower = (column: AnyPgColumn): SQL => sql`lower(${column})`

const id = () => uuid('id').primaryKey().defaultRandom()
const memberId = () =>
  uuid('member_id')
    .notNull()
    .references(() => members.id, { onDelete: 'cascade' })
const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })
const createdAt = () => timestamptz('created_at').notNull().defaultNow()
const updatedAt = () =>
  timestamptz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())

/**
 * A composite foreign key `(child, member_id) -> parent(id, member_id)`: a child row can only point at a parent owned by
 * the same member, so member isolation holds in the database and not only in the scope. The parent table needs a unique
 * constraint on `(id, member_id)`. Cascade is the default action, like the single-column keys it replaces.
 * `'set null'` needs a hand edit in the generated migration to `ON DELETE SET NULL (<child column>)`: drizzle-kit writes a
 * plain `SET NULL`, which would also null `member_id` and fail its NOT NULL on every parent delete.
 */
function ownedFk(
  name: string,
  columns: [AnyPgColumn, AnyPgColumn],
  foreignColumns: [AnyPgColumn, AnyPgColumn],
  onDelete: 'cascade' | 'restrict' | 'set null' = 'cascade'
) {
  return foreignKey({ name, columns, foreignColumns }).onDelete(onDelete)
}

export const members = pgTable(
  'members',
  {
    id: id(),
    githubLogin: text('github_login').notNull().unique(),
    githubId: bigint('github_id', { mode: 'number' }).unique(),
    authUserId: text('auth_user_id')
      .unique()
      .references(() => auth_user.id, { onDelete: 'set null' }),
    displayName: text('display_name').notNull(),
    timeZone: text('time_zone').notNull().default('Asia/Kuala_Lumpur'),
    role: text('role').$type<MemberRole>().notNull().default('member'),
    ntfyTopic: text('ntfy_topic').unique(),
    ntfyTokenEnc: text('ntfy_token_enc'),
    createdAt: createdAt()
  },
  (t) => [
    check('members_github_login_lower', sql`${t.githubLogin} = lower(${t.githubLogin})`),
    check('members_role_check', oneOf(t.role, MEMBER_ROLES))
  ]
)

export const identities = pgTable(
  'identities',
  {
    id: id(),
    memberId: memberId(),
    name: text('name').notNull(),
    runLocation: text('run_location').$type<RunLocation>().notNull().default('server'),
    zoomGuestName: text('zoom_guest_name').notNull(),
    orgName: text('org_name'),
    orgEmailDomain: text('org_email_domain'),
    createdAt: createdAt()
  },
  (t) => [
    unique('identities_member_id_name_unique').on(t.memberId, t.name),
    unique('identities_id_member_id_unique').on(t.id, t.memberId),
    check('identities_run_location_check', oneOf(t.runLocation, RUN_LOCATIONS))
  ]
)

export const profiles = pgTable(
  'profiles',
  {
    identityId: uuid('identity_id').primaryKey(),
    memberId: memberId(),
    location: text('location').$type<'server' | 'local'>().notNull().default('server'),
    latestCheckpoint: text('latest_checkpoint'),
    checkpointAt: timestamptz('checkpoint_at'),
    accountStatus: jsonb('account_status').$type<AccountStatus>().notNull().default({}),
    heldBy: text('held_by'),
    heldSince: timestamptz('held_since')
  },
  (t) => [
    ownedFk('profiles_identity_id_identities_id_fk', [t.identityId, t.memberId], [identities.id, identities.memberId]),
    check('profiles_location_check', oneOf(t.location, PROFILE_LOCATIONS))
  ]
)

export const details = pgTable(
  'details',
  {
    id: id(),
    memberId: memberId(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    labels: text('labels')
      .array()
      .notNull()
      .default(sql`'{}'`),
    position: integer('position').notNull().default(0)
  },
  (t) => [unique('details_member_id_key_unique').on(t.memberId, t.key)]
)

export const mentionNames = pgTable(
  'mention_names',
  {
    id: id(),
    memberId: memberId(),
    name: text('name').notNull()
  },
  (t) => [uniqueIndex('mention_names_member_id_lower_name_unique').on(t.memberId, lower(t.name))]
)

export const timetableEntries = pgTable(
  'timetable_entries',
  {
    id: id(),
    memberId: memberId(),
    identityId: uuid('identity_id').notNull(),
    name: text('name').notNull(),
    type: text('type').$type<EntryType>().notNull(),
    repeat: jsonb('repeat').$type<RepeatRule>().notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    link: jsonb('link').$type<LinkSource>().notNull(),
    trustedSenders: text('trusted_senders')
      .array()
      .notNull()
      .default(sql`'{}'`),
    transcription: text('transcription').$type<TranscriptionMode>().notNull(),
    formDetails: jsonb('form_details').$type<Record<string, string>>().notNull().default({}),
    attendanceKeywords: text('attendance_keywords')
      .array()
      .notNull()
      .default(sql`'{}'`),
    paused: boolean('paused').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [
    ownedFk(
      'timetable_entries_identity_id_identities_id_fk',
      [t.identityId, t.memberId],
      [identities.id, identities.memberId],
      'restrict'
    ),
    unique('timetable_entries_id_member_id_unique').on(t.id, t.memberId),
    index('timetable_entries_member_id_idx').on(t.memberId),
    index('timetable_entries_identity_id_idx').on(t.identityId),
    check('timetable_entries_type_check', oneOf(t.type, ENTRY_TYPES)),
    check('timetable_entries_transcription_check', oneOf(t.transcription, TRANSCRIPTION_MODES))
  ]
)

export const occurrences = pgTable(
  'occurrences',
  {
    id: id(),
    memberId: memberId(),
    entryId: uuid('entry_id'),
    identityId: uuid('identity_id').notNull(),
    entryName: text('entry_name').notNull(),
    entryType: text('entry_type').$type<EntryType>().notNull(),
    transcription: text('transcription').$type<TranscriptionMode>().notNull(),
    scheduledStart: timestamptz('scheduled_start').notNull(),
    scheduledEnd: timestamptz('scheduled_end').notNull(),
    actualStart: timestamptz('actual_start'),
    actualEnd: timestamptz('actual_end'),
    state: text('state').$type<OccurrenceState>().notNull().default('scheduled'),
    stateReason: text('state_reason'),
    attempt: integer('attempt').notNull().default(0),
    restarts: integer('restarts').notNull().default(0),
    knocks: integer('knocks').notNull().default(0),
    resumeState: text('resume_state').$type<OccurrenceState>(),
    entrySnapshot: jsonb('entry_snapshot').$type<JobConfig['entry']>(),
    linkUsed: text('link_used'),
    pastedLink: text('pasted_link'),
    containerName: text('container_name'),
    controlTokenHash: text('control_token_hash'),
    lastHeartbeatAt: timestamptz('last_heartbeat_at'),
    recording: boolean('recording').notNull().default(false),
    participants: integer('participants'),
    pendingCommands: text('pending_commands')
      .array()
      .notNull()
      .default(sql`'{}'`),
    deleteAfter: timestamptz('delete_after').notNull(),
    deletionWarnedAt: timestamptz('deletion_warned_at'),
    createdAt: createdAt()
  },
  (t) => [
    // Postgres needs `on delete set null (entry_id)` here, so the migration hand-edits the generated statement: a plain
    // `set null` would also null `member_id`.
    ownedFk(
      'occurrences_entry_id_timetable_entries_id_fk',
      [t.entryId, t.memberId],
      [timetableEntries.id, timetableEntries.memberId],
      'set null'
    ),
    ownedFk(
      'occurrences_identity_id_identities_id_fk',
      [t.identityId, t.memberId],
      [identities.id, identities.memberId]
    ),
    unique('occurrences_id_member_id_unique').on(t.id, t.memberId),
    unique('occurrences_entry_id_scheduled_start_unique').on(t.entryId, t.scheduledStart),
    index('occurrences_state_idx').on(t.state),
    index('occurrences_state_scheduled_start_idx').on(t.state, t.scheduledStart),
    index('occurrences_member_id_scheduled_start_idx').on(t.memberId, t.scheduledStart),
    index('occurrences_identity_id_scheduled_start_idx').on(t.identityId, t.scheduledStart),
    index('occurrences_delete_after_idx').on(t.deleteAfter),
    check('occurrences_state_check', oneOf(t.state, OCCURRENCE_STATES)),
    check('occurrences_resume_state_check', oneOf(t.resumeState, OCCURRENCE_STATES))
  ]
)

export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    occurrenceId: uuid('occurrence_id').notNull(),
    memberId: memberId(),
    attempt: integer('attempt').notNull(),
    at: timestamptz('at').notNull(),
    type: text('type').$type<EventType>().notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    dataHash: text('data_hash').notNull()
  },
  (t) => [
    ownedFk(
      'events_occurrence_id_occurrences_id_fk',
      [t.occurrenceId, t.memberId],
      [occurrences.id, occurrences.memberId]
    ),
    index('events_member_id_idx').on(t.memberId),
    unique('events_occurrence_id_attempt_at_type_data_hash_unique').on(
      t.occurrenceId,
      t.attempt,
      t.at,
      t.type,
      t.dataHash
    ),
    check('events_type_check', oneOf(t.type, EVENT_TYPES))
  ]
)

export const forms = pgTable(
  'forms',
  {
    id: id(),
    occurrenceId: uuid('occurrence_id').notNull(),
    memberId: memberId(),
    formKey: text('form_key').notNull(),
    url: text('url').notNull(),
    finalUrl: text('final_url'),
    provider: text('provider').$type<FormProvider>(),
    source: text('source').$type<FormSource>().notNull(),
    sender: text('sender'),
    senderRole: text('sender_role').$type<SenderRole>(),
    trustReason: text('trust_reason').$type<TrustReason>(),
    state: text('state').$type<FormState>().notNull(),
    seenAt: timestamptz('seen_at').notNull(),
    submittedAt: timestamptz('submitted_at'),
    fieldsFilled: text('fields_filled')
      .array()
      .notNull()
      .default(sql`'{}'`),
    result: text('result'),
    updatedAt: updatedAt()
  },
  (t) => [
    ownedFk(
      'forms_occurrence_id_occurrences_id_fk',
      [t.occurrenceId, t.memberId],
      [occurrences.id, occurrences.memberId]
    ),
    index('forms_member_id_idx').on(t.memberId),
    unique('forms_occurrence_id_form_key_unique').on(t.occurrenceId, t.formKey),
    check('forms_source_check', oneOf(t.source, FORM_SOURCES)),
    check('forms_state_check', oneOf(t.state, FORM_STATES))
  ]
)

export const artefacts = pgTable(
  'artefacts',
  {
    id: id(),
    occurrenceId: uuid('occurrence_id').notNull(),
    memberId: memberId(),
    kind: text('kind').$type<ArtefactKind>().notNull(),
    path: text('path').notNull(), // relative to the occurrence directory
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    createdAt: createdAt()
  },
  (t) => [
    ownedFk(
      'artefacts_occurrence_id_occurrences_id_fk',
      [t.occurrenceId, t.memberId],
      [occurrences.id, occurrences.memberId]
    ),
    index('artefacts_member_id_idx').on(t.memberId),
    unique('artefacts_occurrence_id_path_unique').on(t.occurrenceId, t.path),
    check('artefacts_kind_check', oneOf(t.kind, ARTEFACT_KINDS))
  ]
)

// Secret columns (`*_enc`) hold only `sealColumn` output (plan 01c Task 2).
export const aiKeys = pgTable('ai_keys', {
  memberId: uuid('member_id')
    .primaryKey()
    .references(() => members.id, { onDelete: 'cascade' }),
  dashscopeKeyEnc: text('dashscope_key_enc').notNull(),
  workspaceId: text('workspace_id'),
  modelscopeKeyEnc: text('modelscope_key_enc'),
  testOk: boolean('test_ok').notNull().default(false),
  testError: text('test_error'),
  testedAt: timestamptz('tested_at'),
  modelscopeTestOk: boolean('modelscope_test_ok'),
  updatedAt: updatedAt()
})

export const connections = pgTable(
  'connections',
  {
    id: id(),
    memberId: memberId(),
    kind: text('kind').$type<ConnectionKind>().notNull(),
    tokenEnc: text('token_enc').notNull(),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').$type<ConnectionStatus>().notNull().default('ok'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (t) => [
    unique('connections_member_id_kind_unique').on(t.memberId, t.kind),
    check('connections_kind_check', oneOf(t.kind, CONNECTION_KINDS)),
    check('connections_status_check', oneOf(t.status, CONNECTION_STATUSES))
  ]
)

export const exports = pgTable(
  'exports',
  {
    id: id(),
    occurrenceId: uuid('occurrence_id').notNull(),
    memberId: memberId(),
    target: text('target').$type<ExportTarget>().notNull(),
    status: text('status').$type<ExportStatus>().notNull().default('queued'),
    title: text('title'),
    url: text('url'),
    filePath: text('file_path'), // relative to the occurrence directory
    note: text('note'),
    errorCode: text('error_code').$type<ExportErrorCode>(),
    error: text('error'),
    createdAt: createdAt(),
    startedAt: timestamptz('started_at'),
    finishedAt: timestamptz('finished_at')
  },
  (t) => [
    ownedFk(
      'exports_occurrence_id_occurrences_id_fk',
      [t.occurrenceId, t.memberId],
      [occurrences.id, occurrences.memberId]
    ),
    index('exports_member_id_idx').on(t.memberId),
    // The occurrence's export list, newest first (also serves the cascade from the occurrence).
    index('exports_occurrence_id_created_at_idx').on(t.occurrenceId, t.createdAt),
    // The runner claims the oldest queued row.
    index('exports_status_created_at_idx').on(t.status, t.createdAt),
    // At most one queued or running export per occurrence and target.
    uniqueIndex('exports_one_active_idx')
      .on(t.occurrenceId, t.target)
      .where(sql`${t.status} in ('queued', 'running')`),
    check('exports_target_check', oneOf(t.target, EXPORT_TARGETS)),
    check('exports_status_check', oneOf(t.status, EXPORT_STATUSES)),
    check('exports_error_code_check', oneOf(t.errorCode, EXPORT_ERROR_CODES))
  ]
)

export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: id(),
    memberId: memberId(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: createdAt(),
    lastUsedAt: timestamptz('last_used_at'),
    revokedAt: timestamptz('revoked_at')
  },
  (t) => [index('device_tokens_member_id_idx').on(t.memberId)]
)

export const signinSessions = pgTable(
  'signin_sessions',
  {
    id: id(),
    memberId: memberId(),
    identityId: uuid('identity_id').notNull(),
    mode: text('mode').$type<'worker' | 'container'>().notNull(),
    occurrenceId: uuid('occurrence_id'),
    upstream: text('upstream'),
    controlTokenHash: text('control_token_hash'),
    state: text('state').$type<'starting' | 'ready' | 'ended'>().notNull().default('starting'),
    doneRequested: boolean('done_requested').notNull().default(false),
    lastHeartbeatAt: timestamptz('last_heartbeat_at'),
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    endedAt: timestamptz('ended_at'),
    endReason: text('end_reason')
  },
  (t) => [
    ownedFk(
      'signin_sessions_identity_id_identities_id_fk',
      [t.identityId, t.memberId],
      [identities.id, identities.memberId]
    ),
    // Hand-edited to `on delete set null (occurrence_id)` in the migration, like occurrences.entry_id.
    ownedFk(
      'signin_sessions_occurrence_id_occurrences_id_fk',
      [t.occurrenceId, t.memberId],
      [occurrences.id, occurrences.memberId],
      'set null'
    ),
    index('signin_sessions_member_id_idx').on(t.memberId),
    index('signin_sessions_identity_id_idx').on(t.identityId),
    index('signin_sessions_occurrence_id_idx').on(t.occurrenceId),
    check('signin_sessions_mode_check', oneOf(t.mode, SIGNIN_MODES)),
    check('signin_sessions_state_check', oneOf(t.state, SIGNIN_STATES))
  ]
)

/** Every table with a `memberId` column, keyed by its export name. Member scoping (Task 4) works over this record. */
export const MEMBER_OWNED = {
  identities,
  profiles,
  details,
  mentionNames,
  timetableEntries,
  occurrences,
  events,
  forms,
  artefacts,
  exports,
  aiKeys,
  connections,
  deviceTokens,
  signinSessions
} as const

/** The single primary-key column of a table (every table in this schema has exactly one). */
export function pkOf(table: PgTable): PgColumn {
  const keys = Object.values(getTableColumns(table)).filter((c) => c.primary)
  if (keys.length !== 1) throw new Error(`Expected one primary key column, found ${keys.length}`)
  return keys[0]!
}
