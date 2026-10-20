// Test helpers: a real Postgres database per call and a seeded member. Import from tests only, never from app code.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { symmetricEncrypt } from 'better-auth/crypto'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { closeDb, MEMBER_OWNED, schema, type Db } from './index'
import { authSecret } from '../lib/auth-secret'
import { migrationsFolder, runMigrations } from './migrate'
import { sealColumn } from './secrets'
import type { Queue, QueueName } from './queues'
import { hashEventData } from './transitions'

interface TestDbHandle {
  name: string
  pool: Pool
}

const created = new Map<Db, TestDbHandle>()

/** At most this many `drop database` statements run at once. */
const DROP_CONCURRENCY = 4
/** A leaked database is swept only when it is older than this (ms), so a run that just started is never touched. */
const SWEEP_MIN_AGE = 10 * 60_000

function adminUrl(): URL {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL is not set (see COMMON.md: the shared tm-test-pg Postgres)')
  return new URL(url)
}

function urlFor(name: string): string {
  const url = adminUrl()
  url.pathname = `/${name}`
  return url.toString()
}

async function onAdmin<T>(run: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: adminUrl().toString(), max: 1 })
  try {
    return await run(pool)
  } finally {
    await pool.end()
  }
}

/** Runs `task` over `items`, at most `limit` at a time; every item is tried, then the first failure (if any) is thrown. */
async function inPool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const errors: unknown[] = []
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      try {
        await task(item)
      } catch (error) {
        errors.push(error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (errors.length > 0)
    throw new AggregateError(errors, `${errors.length} of ${items.length} failed: ${String(errors[0])}`)
}

const dropSql = (name: string) => `drop database if exists "${name}" with (force)`

/**
 * Drops the `tm_web_*` and `tm_tpl_*` databases that a dead run left behind: the pid in the name has no `/proc/<pid>`
 * and the creation time (base36, next in the name) is older than ten minutes. Only on Linux with `/proc`; a pid that
 * is alive, even if reused, is left alone.
 */
async function sweepLeaked(): Promise<void> {
  if (process.platform !== 'linux' || !existsSync('/proc/self')) return
  const names = await onAdmin(async (admin) => {
    const { rows } = await admin.query<{ datname: string }>(
      `select datname from pg_database where datname like 'tm\\_web\\_%' or datname like 'tm\\_tpl\\_%'`
    )
    return rows.map((r) => r.datname)
  })
  const stale = names.filter((name) => {
    const [, , pid, made] = name.split('_')
    const at = parseInt(made ?? '', 36)
    return (
      /^\d+$/.test(pid ?? '') && Number.isFinite(at) && !existsSync(`/proc/${pid}`) && Date.now() - at > SWEEP_MIN_AGE
    )
  })
  if (stale.length === 0) return
  let failed = 0
  await onAdmin((admin) =>
    inPool(stale, 2, async (name) => {
      try {
        await admin.query(dropSql(name))
      } catch {
        failed++
      }
    })
  )
  console.log(`[testing] swept ${stale.length - failed} leaked test databases${failed ? `, ${failed} failed` : ''}`)
}

/** A short hash of the migration files, so a template made from other migrations is never reused. */
function migrationsHash(): string {
  const hash = createHash('sha256')
  const files = [
    ...readdirSync(migrationsFolder)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => join(migrationsFolder, f)),
    join(migrationsFolder, 'meta', '_journal.json')
  ]
  for (const file of files) hash.update(file.slice(migrationsFolder.length)).update(readFileSync(file))
  return hash.digest('hex').slice(0, 10)
}

interface Template {
  name: string
}

let swept = false
let template: Promise<Template> | undefined
/** Copies from the template run one at a time: Postgres refuses to copy a template that has other connections. */
let copyQueue: Promise<unknown> = Promise.resolve()

async function makeTemplate(): Promise<Template> {
  const name = `tm_tpl_${process.pid}_${Date.now().toString(36)}_${migrationsHash()}`
  try {
    await onAdmin((admin) => admin.query(`create database "${name}"`))
    // The migration lock holds one connection and the migrator uses another, so the pool needs two.
    const pool = new Pool({ connectionString: urlFor(name), max: 2 })
    try {
      await runMigrations(drizzle(pool, { schema }))
    } finally {
      // The template may have no connection while it is copied.
      await pool.end()
    }
  } catch (error) {
    await onAdmin((admin) => admin.query(dropSql(name)))
    throw error
  }
  // Once per process, and only after the template exists: a sweep running beside the build made the first test time out.
  // Nothing waits for it; a sweep cut short by the end of the run is finished by the next one.
  if (!swept) {
    swept = true
    void sweepLeaked().catch((error) => console.warn(`[testing] sweep of leaked test databases failed: ${error}`))
  }
  return { name }
}

/**
 * `create database ... template`, retried while the template's last backend is still shutting down (55006). The
 * `file_copy` strategy checkpoints on create but makes the drop cheap; the default `wal_log` leaves dirty buffers that
 * make every later `drop database` wait for a slow checkpoint.
 */
async function copyTemplate(name: string, from: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await onAdmin((admin) => admin.query(`create database "${name}" template "${from}" strategy file_copy`))
      return
    } catch (error) {
      if ((error as { code?: string }).code !== '55006' || attempt >= 100) throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

/**
 * A fresh, uniquely named database on `TEST_DATABASE_URL` with every migration applied. Each process migrates one
 * template database once (`tm_tpl_<pid>_...`) and copies it for every call, which is much faster than migrating each
 * time. Drop it with `dropTestDb` (or `dropAllTestDbs` in `afterAll`, which also drops the template): nothing drops it
 * for you, and the Postgres is shared.
 */
export async function createTestDb(): Promise<Db> {
  const name = `tm_web_${process.pid}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
  const pending = (template ??= makeTemplate())
  const tpl = await pending.catch((error) => {
    if (template === pending) template = undefined
    throw error
  })
  const copy = copyQueue.then(() => copyTemplate(name, tpl.name))
  copyQueue = copy.catch(() => undefined)
  await copy
  const pool = new Pool({ connectionString: urlFor(name) })
  const db: Db = drizzle(pool, { schema })
  created.set(db, { name, pool })
  return db
}

/** The connection string of a database made by `createTestDb`. */
export function testDbUrl(db: Db): string {
  const handle = created.get(db)
  if (!handle) throw new Error('Not a database made by createTestDb')
  return urlFor(handle.name)
}

/** Closes the connections of a database made by `createTestDb` and drops it. */
export async function dropTestDb(db: Db): Promise<void> {
  const handle = created.get(db)
  if (!handle) throw new Error('Not a database made by createTestDb')
  created.delete(db)
  await closeDb()
  await handle.pool.end()
  await onAdmin((admin) => admin.query(dropSql(handle.name)))
}

/** Drops every database `createTestDb` made in this process, four at a time, then the template. */
export async function dropAllTestDbs(): Promise<void> {
  const tpl = template
  template = undefined
  const handles = [...created.values()]
  created.clear()
  await closeDb()
  await Promise.all(handles.map((h) => h.pool.end()))
  await onAdmin(async (admin) => {
    const drop = (name: string) => admin.query(dropSql(name)).then(() => undefined)
    // The template goes even when a database failed to drop.
    const dropped = await inPool(handles, DROP_CONCURRENCY, (h) => drop(h.name)).then(
      () => undefined,
      (error: unknown) => error
    )
    const made = await tpl?.catch(() => undefined) // a template that failed to build already dropped itself
    if (made) {
      await drop(made.name)
    }
    if (dropped) throw dropped
  })
}

export interface Seeded {
  memberId: string
  identityId: string
  /** The primary key (as a string) of the seeded row in each member-owned table; only the tables seeded are set. */
  ids: Record<keyof typeof MEMBER_OWNED, string>
}

export interface SeedOptions {
  githubLogin?: string
  role?: 'member' | 'admin'
  /** `true` (the default) adds one row to every member-owned table; `false` only an identity, its profile and a tested AI key. */
  full?: boolean
}

const hour = 3_600_000

/** Inserts a member with an identity and profile, a tested AI key and (unless `full: false`) one row everywhere else. */
export async function seedMember(db: Db, opts: SeedOptions = {}): Promise<Seeded> {
  const { role = 'member', full = true } = opts
  const githubLogin = (opts.githubLogin ?? `seed-${randomBytes(4).toString('hex')}`).toLowerCase()
  const s = schema
  const ids: Partial<Record<keyof typeof MEMBER_OWNED, string>> = {}

  const [member] = await db.insert(s.members).values({ githubLogin, displayName: githubLogin, role }).returning()
  const memberId = member!.id

  const [identity] = await db
    .insert(s.identities)
    .values({ memberId, name: 'Main', zoomGuestName: 'Seed Member' })
    .returning()
  const identityId = identity!.id
  ids.identities = identityId
  await db.insert(s.profiles).values({ identityId, memberId })
  ids.profiles = identityId
  await db.insert(s.aiKeys).values({ memberId, dashscopeKeyEnc: 'sealed', testOk: true, testedAt: new Date() })
  ids.aiKeys = memberId

  if (full) {
    const [detail] = await db.insert(s.details).values({ memberId, key: 'full_name', value: 'Seed Member' }).returning()
    ids.details = detail!.id
    const [mention] = await db.insert(s.mentionNames).values({ memberId, name: 'Seed' }).returning()
    ids.mentionNames = mention!.id
    const [entry] = await db
      .insert(s.timetableEntries)
      .values({
        memberId,
        identityId,
        name: 'Seed lecture',
        type: 'lecture',
        repeat: { kind: 'once', date: '2026-10-21' },
        startTime: '14:00',
        endTime: '16:00',
        link: { kind: 'paste' },
        transcription: 'live'
      })
      .returning()
    ids.timetableEntries = entry!.id
    const start = new Date('2026-10-21T06:00:00Z')
    const [occurrence] = await db
      .insert(s.occurrences)
      .values({
        memberId,
        entryId: entry!.id,
        identityId,
        entryName: 'Seed lecture',
        entryType: 'lecture',
        transcription: 'live',
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + 2 * hour),
        deleteAfter: new Date(start.getTime() + 30 * 24 * hour)
      })
      .returning()
    const occurrenceId = occurrence!.id
    ids.occurrences = occurrenceId
    const data = {}
    const [event] = await db
      .insert(s.events)
      .values({ occurrenceId, memberId, attempt: 1, at: start, type: 'state', data, dataHash: hashEventData(data) })
      .returning()
    ids.events = String(event!.id)
    const [form] = await db
      .insert(s.forms)
      .values({
        occurrenceId,
        memberId,
        formKey: 'seed-form',
        url: 'https://docs.google.com/forms/d/e/seed/viewform',
        source: 'qr',
        state: 'detected',
        seenAt: start
      })
      .returning()
    ids.forms = form!.id
    const [artefact] = await db
      .insert(s.artefacts)
      .values({ occurrenceId, memberId, kind: 'summary', path: 'out/summary.md', bytes: 1024 })
      .returning()
    ids.artefacts = artefact!.id
    const [exported] = await db
      .insert(s.exports)
      .values({ occurrenceId, memberId, target: 'zip', status: 'succeeded', title: 'Seed lecture', finishedAt: start })
      .returning()
    ids.exports = exported!.id
    const [connection] = await db
      .insert(s.connections)
      .values({ memberId, kind: 'google', tokenEnc: 'sealed' })
      .returning()
    ids.connections = connection!.id
    const [device] = await db
      .insert(s.deviceTokens)
      .values({ memberId, name: 'Seed laptop', tokenHash: randomBytes(16).toString('hex') })
      .returning()
    ids.deviceTokens = device!.id
    const [signin] = await db
      .insert(s.signinSessions)
      .values({ memberId, identityId, mode: 'container', occurrenceId })
      .returning()
    ids.signinSessions = signin!.id
    const [pairing] = await db
      .insert(s.devicePairings)
      .values({ memberId, codeHash: randomBytes(16).toString('hex'), expiresAt: new Date(start.getTime() + hour) })
      .returning()
    ids.devicePairings = pairing!.id
    const [job] = await db
      .insert(s.companionJobs)
      .values({ memberId, occurrenceId, kind: 'native_transcription', payload: { occurrenceId }, deviceId: device!.id })
      .returning()
    ids.companionJobs = job!.id
    const [companionEvent] = await db
      .insert(s.companionEvents)
      .values({ memberId, deviceId: device!.id, command: { type: 'job_available', jobId: job!.id } })
      .returning()
    ids.companionEvents = String(companionEvent!.id)
    await db.insert(s.homeExitNodes).values({
      memberId,
      nodeId: `seed-node-${memberId}`,
      hostname: 'tm-home-seed',
      ipv4: '100.64.0.1',
      checkedAt: start
    })
    ids.homeExitNodes = memberId
  }

  return { memberId, identityId, ids: ids as Seeded['ids'] }
}

export interface SentJob {
  name: QueueName
  data: Record<string, unknown>
  opts: Parameters<Queue['send']>[2]
}

/** A `Queue` that records what was sent instead of queueing it. */
export class FakeQueue implements Queue {
  readonly sent: SentJob[] = []

  async send(name: QueueName, data: Record<string, unknown>, opts?: SentJob['opts']): Promise<string | null> {
    this.sent.push({ name, data, opts })
    return `fake-${this.sent.length}`
  }
}

export interface EntryShape {
  repeat: typeof schema.timetableEntries.$inferInsert.repeat
  startTime: string
  endTime: string
  name?: string
}

/** A fresh database with a seeded member (`full: false`, working AI key), one timetable entry and a `FakeQueue`. */
export async function withEntry(entry: EntryShape) {
  const db = await createTestDb()
  const { memberId, identityId } = await seedMember(db, { full: false })
  const [row] = await db
    .insert(schema.timetableEntries)
    .values({
      memberId,
      identityId,
      name: entry.name ?? 'Seed lecture',
      type: 'lecture',
      repeat: entry.repeat,
      startTime: entry.startTime,
      endTime: entry.endTime,
      link: { kind: 'paste' },
      transcription: 'live'
    })
    .returning()
  return { db, memberId, identityId, entryId: row!.id, q: new FakeQueue() }
}

/** The master key the auth test helpers seal GitHub tokens under; pass it to `authScope` and `createAuth`. */
export const TEST_MASTER = Buffer.alloc(32, 7)

export interface AuthUserOptions {
  /** Stored, sealed as Better Auth seals it, as the user's GitHub access token; leave out for a user with no GitHub account row. */
  githubToken?: string
  /** The master key to seal `githubToken` under (default `TEST_MASTER`). */
  master?: Buffer
  /** Adds one `auth_session` row. */
  session?: boolean
}

/** Inserts a Better Auth user, optionally with a GitHub account holding `githubToken` and a session. Returns its id. */
export async function seedAuthUser(db: Db, opts: AuthUserOptions = {}): Promise<string> {
  const s = schema
  const authUserId = randomBytes(8).toString('hex')
  await db.insert(s.auth_user).values({ id: authUserId, name: 'Seed', email: `${authUserId}@users.noreply.test` })
  if (opts.githubToken) {
    await db.insert(s.auth_account).values({
      id: randomBytes(8).toString('hex'),
      accountId: String(Math.floor(Math.random() * 1e9)),
      providerId: 'github',
      userId: authUserId,
      accessToken: await symmetricEncrypt({ key: authSecret(opts.master ?? TEST_MASTER), data: opts.githubToken })
    })
  }
  if (opts.session) {
    await db.insert(s.auth_session).values({
      id: randomBytes(8).toString('hex'),
      token: randomBytes(16).toString('hex'),
      userId: authUserId,
      expiresAt: new Date(Date.now() + 7 * 24 * hour)
    })
  }
  return authUserId
}

/** A member linked to a new auth user that holds `githubToken` and one session (what sign-in leaves behind). */
export async function seedLinkedMember(db: Db, githubToken: string): Promise<{ memberId: string; authUserId: string }> {
  const { memberId } = await seedMember(db, { full: false })
  const authUserId = await seedAuthUser(db, { githubToken, session: true })
  await db.update(schema.members).set({ authUserId }).where(eq(schema.members.id, memberId))
  return { memberId, authUserId }
}

const TOPIC_CHARS = 'abcdefghijklmnopqrstuvwxyz234567'

/** A seeded member (`full: false`) with a topic and a token sealed under `master`, as `ensureNtfy` leaves them. */
export async function withNtfy(
  token: string,
  master: Buffer = Buffer.alloc(32)
): Promise<{ db: Db; memberId: string; topic: string }> {
  const db = await createTestDb()
  const { memberId } = await seedMember(db, { full: false })
  const topic = `tm-${Array.from(randomBytes(24), (b) => TOPIC_CHARS[b % 32]).join('')}`
  await db
    .update(schema.members)
    .set({ ntfyTopic: topic, ntfyTokenEnc: sealColumn(master, memberId, 'members.ntfy_token', token) })
    .where(eq(schema.members.id, memberId))
  return { db, memberId, topic }
}

export interface FakeFetch {
  (input: string, init?: RequestInit): Promise<Response>
  /** One `METHOD path Scheme` entry per call, e.g. `POST /v1/users Bearer`; `none` when there is no Authorization header. */
  readonly calls: string[]
  /** The parsed JSON body of each call, in order; `undefined` for a call with no body. */
  readonly bodies: unknown[]
}

/**
 * A fetch that records each call and answers by URL path. A value is sent as JSON with status 200, unless it is a
 * `Response`, which is sent as it is; a path with no entry answers `{}`.
 */
export function fakeFetch(responses: Record<string, unknown | Response> = {}): FakeFetch {
  const calls: string[] = []
  const bodies: unknown[] = []
  const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const auth = new Headers(init?.headers).get('authorization')
    calls.push(`${method} ${url.pathname} ${auth ? auth.split(' ')[0] : 'none'}`)
    bodies.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)))
    const answer = responses[url.pathname] ?? {}
    return answer instanceof Response ? answer : Response.json(answer)
  }
  return Object.assign(fetchFn, { calls, bodies })
}
