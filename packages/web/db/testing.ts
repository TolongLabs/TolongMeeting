// Test helpers: a real Postgres database per call and a seeded member. Import from tests only, never from app code.
import { randomBytes } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { MEMBER_OWNED, schema, type Db } from './index'
import { runMigrations } from './migrate'
import type { Queue, QueueName } from './queues'
import { hashEventData } from './transitions'

interface TestDbHandle {
  name: string
  pool: Pool
}

const created = new Map<Db, TestDbHandle>()

function adminUrl(): URL {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL is not set (see COMMON.md: the shared tm-test-pg Postgres)')
  return new URL(url)
}

async function onAdmin<T>(run: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: adminUrl().toString(), max: 1 })
  try {
    return await run(pool)
  } finally {
    await pool.end()
  }
}

/**
 * A fresh, uniquely named database on `TEST_DATABASE_URL` with every migration applied. Drop it with `dropTestDb`
 * (or `dropAllTestDbs` in `afterAll`): nothing drops it for you, and the Postgres is shared.
 */
export async function createTestDb(): Promise<Db> {
  const base = adminUrl()
  const name = `tm_web_${process.pid}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
  await onAdmin((admin) => admin.query(`create database "${name}"`))
  const url = new URL(base)
  url.pathname = `/${name}`
  const pool = new Pool({ connectionString: url.toString() })
  const db: Db = drizzle(pool, { schema })
  created.set(db, { name, pool })
  await runMigrations(db)
  return db
}

/** The connection string of a database made by `createTestDb`. */
export function testDbUrl(db: Db): string {
  const handle = created.get(db)
  if (!handle) throw new Error('Not a database made by createTestDb')
  const url = new URL(adminUrl())
  url.pathname = `/${handle.name}`
  return url.toString()
}

/** Closes the connections of a database made by `createTestDb` and drops it. */
export async function dropTestDb(db: Db): Promise<void> {
  const handle = created.get(db)
  if (!handle) throw new Error('Not a database made by createTestDb')
  created.delete(db)
  await handle.pool.end()
  await onAdmin((admin) => admin.query(`drop database if exists "${handle.name}" with (force)`))
}

export async function dropAllTestDbs(): Promise<void> {
  for (const db of [...created.keys()]) await dropTestDb(db)
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
