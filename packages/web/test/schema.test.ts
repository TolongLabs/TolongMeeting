import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, getTableName, sql } from 'drizzle-orm'
import { closeDb, getDb, MEMBER_OWNED, pkOf, schema, type Db } from '../db'
import { runMigrations } from '../db/migrate'
import { createTestDb, dropAllTestDbs, dropTestDb, seedMember, testDbUrl } from '../db/testing'

const { aiKeys, artefacts, connections, details, deviceTokens, events, forms, identities, members } = schema
const { mentionNames, occurrences, profiles, signinSessions, timetableEntries } = schema

const TABLES = [
  'ai_keys',
  'artefacts',
  'connections',
  'details',
  'device_tokens',
  'events',
  'forms',
  'identities',
  'members',
  'mention_names',
  'occurrences',
  'profiles',
  'signin_sessions',
  'timetable_entries'
]

/** Runs a statement that must fail and returns the Postgres error code and constraint it failed on. */
async function violation(statement: PromiseLike<unknown>): Promise<{ code: string; constraint: string | undefined }> {
  try {
    await statement
  } catch (error) {
    const pg = ((error as { cause?: unknown }).cause ?? error) as { code?: string; constraint?: string }
    return { code: pg.code ?? 'none', constraint: pg.constraint }
  }
  throw new Error('Expected the statement to fail, but it succeeded')
}

const UNIQUE = '23505'
const FOREIGN_KEY = '23503'
const NOT_NULL = '23502'
const CHECK = '23514'

let db: Db

beforeAll(async () => {
  db = await createTestDb()
})

afterAll(async () => {
  await dropAllTestDbs()
})

describe('migrations', () => {
  test('migrations create every table', async () => {
    const { rows } = await db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public'`
    )
    expect(rows.map((r) => r.table_name).sort()).toEqual(TABLES)
  })

  test('every table but members has a non-null member_id', async () => {
    const { rows } = await db.execute(
      sql`select table_name from information_schema.columns
          where table_schema = 'public' and column_name = 'member_id' and is_nullable = 'NO'`
    )
    expect(rows.map((r) => r.table_name).sort()).toEqual(TABLES.filter((t) => t !== 'members'))
  })

  test('MEMBER_OWNED lists exactly the tables with a member_id', () => {
    const names: string[] = Object.values(MEMBER_OWNED).map((t) => getTableName(t))
    expect(names.sort()).toEqual(TABLES.filter((t) => t !== 'members'))
  })

  test('pkOf finds the primary key of every table', () => {
    expect(pkOf(members).name).toBe('id')
    expect(pkOf(profiles).name).toBe('identity_id')
    expect(pkOf(aiKeys).name).toBe('member_id')
    expect(pkOf(events).name).toBe('id')
  })

  test('applying them to an empty database works, and applying them again changes nothing', async () => {
    const fresh = await createTestDb()
    const applied = async () =>
      (await fresh.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)).rows[0]!.n
    expect(await applied()).toBe(1)
    const a = await seedMember(fresh)
    await runMigrations(fresh)
    await runMigrations(fresh)
    expect(await applied()).toBe(1)
    expect(await fresh.$count(members, eq(members.id, a.memberId))).toBe(1)
    await dropTestDb(fresh)
  })

  test('another schema in the same database (pg-boss keeps its own) does not collide', async () => {
    const other = await createTestDb()
    await other.execute(sql`create schema pgboss`)
    await other.execute(sql`create table pgboss.job (id uuid primary key, name text not null)`)
    await runMigrations(other)
    const { rows } = await other.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public'`
    )
    expect(rows.map((r) => r.table_name).sort()).toEqual(TABLES)
    await dropTestDb(other)
  })

  test('getDb opens one pool on DATABASE_URL and fails loudly without it', async () => {
    const saved = process.env.DATABASE_URL
    try {
      delete process.env.DATABASE_URL
      expect(() => getDb()).toThrow('DATABASE_URL is not set')
      process.env.DATABASE_URL = testDbUrl(db)
      const a = await seedMember(db)
      expect(getDb()).toBe(getDb())
      expect(await getDb().$count(members, eq(members.id, a.memberId))).toBe(1)
    } finally {
      await closeDb()
      if (saved === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = saved
    }
  })
})

describe('seedMember', () => {
  test('a full seed adds a row to every member-owned table', async () => {
    const a = await seedMember(db)
    for (const [name, table] of Object.entries(MEMBER_OWNED)) {
      const key = name as keyof typeof MEMBER_OWNED
      expect(a.ids[key]).toBeString()
      expect(await db.$count(table, eq(pkOf(table), a.ids[key]))).toBe(1)
    }
  })

  test('a bare seed adds only an identity, its profile and a tested AI key', async () => {
    const a = await seedMember(db, { full: false })
    for (const table of Object.values(MEMBER_OWNED)) {
      const owned = await db.$count(table, eq(sql.raw('member_id'), a.memberId))
      expect(owned).toBe(table === identities || table === profiles || table === aiKeys ? 1 : 0)
    }
    const [key] = await db.select().from(aiKeys).where(eq(aiKeys.memberId, a.memberId))
    expect(key!.testOk).toBe(true)
  })

  test('the login is stored lower-case and the role is honoured', async () => {
    const a = await seedMember(db, { githubLogin: 'Octo-Admin', role: 'admin', full: false })
    const [m] = await db.select().from(members).where(eq(members.id, a.memberId))
    expect(m).toMatchObject({ githubLogin: 'octo-admin', role: 'admin', timeZone: 'Asia/Kuala_Lumpur' })
  })
})

describe('members, identities and details', () => {
  test('a GitHub login is unique, and stored lower-case', async () => {
    await seedMember(db, { githubLogin: 'dup-login', full: false })
    expect(await violation(db.insert(members).values({ githubLogin: 'dup-login', displayName: 'x' }))).toEqual({
      code: UNIQUE,
      constraint: 'members_github_login_unique'
    })
    expect(await violation(db.insert(members).values({ githubLogin: 'Upper-Case', displayName: 'x' }))).toEqual({
      code: CHECK,
      constraint: 'members_github_login_lower'
    })
  })

  test('a member needs a display name and a known role', async () => {
    expect((await violation(db.insert(members).values({ githubLogin: 'no-name' } as never))).code).toBe(NOT_NULL)
    expect(
      await violation(db.insert(members).values({ githubLogin: 'odd-role', displayName: 'x', role: 'owner' as never }))
    ).toEqual({ code: CHECK, constraint: 'members_role_check' })
  })

  test('GitHub id, auth user, ntfy topic are each unique', async () => {
    const a = await seedMember(db, { full: false })
    const b = await seedMember(db, { full: false })
    await db
      .update(members)
      .set({ githubId: 42, authUserId: 'auth-1', ntfyTopic: 'topic-1' })
      .where(eq(members.id, a.memberId))
    for (const [patch, constraint] of [
      [{ githubId: 42 }, 'members_github_id_unique'],
      [{ authUserId: 'auth-1' }, 'members_auth_user_id_unique'],
      [{ ntfyTopic: 'topic-1' }, 'members_ntfy_topic_unique']
    ] as const) {
      expect(await violation(db.update(members).set(patch).where(eq(members.id, b.memberId)))).toEqual({
        code: UNIQUE,
        constraint
      })
    }
  })

  test('an identity name is unique per member, and the run location is checked', async () => {
    const a = await seedMember(db, { full: false }) // already has the identity "Main"
    const row = { zoomGuestName: 'Guest' }
    expect(await violation(db.insert(identities).values({ ...row, memberId: a.memberId, name: 'Main' }))).toEqual({
      code: UNIQUE,
      constraint: 'identities_member_id_name_unique'
    })
    expect(
      await violation(
        db.insert(identities).values({ ...row, memberId: a.memberId, name: 'Odd', runLocation: 'moon' as never })
      )
    ).toEqual({ code: CHECK, constraint: 'identities_run_location_check' })
    const [ok] = await db
      .insert(identities)
      .values({ ...row, memberId: a.memberId, name: 'Home', runLocation: 'server_via_home' })
      .returning()
    expect(ok).toMatchObject({ runLocation: 'server_via_home', orgName: null, orgEmailDomain: null })
  })

  test('an identity must belong to a member', async () => {
    const nobody = '00000000-0000-4000-8000-000000000000'
    expect(await violation(db.insert(identities).values({ memberId: nobody, name: 'x', zoomGuestName: 'x' }))).toEqual({
      code: FOREIGN_KEY,
      constraint: 'identities_member_id_members_id_fk'
    })
  })

  test('a profile defaults to the server with an empty account status, and its location is checked', async () => {
    const a = await seedMember(db, { full: false })
    const [p] = await db.select().from(profiles).where(eq(profiles.identityId, a.identityId))
    expect(p).toMatchObject({ location: 'server', accountStatus: {}, heldBy: null })
    expect(
      await violation(
        db
          .update(profiles)
          .set({ location: 'cloud' as never })
          .where(eq(profiles.identityId, a.identityId))
      )
    ).toEqual({
      code: CHECK,
      constraint: 'profiles_location_check'
    })
  })

  test('a detail key is unique per member; labels default to empty', async () => {
    const a = await seedMember(db)
    expect(
      await violation(db.insert(details).values({ memberId: a.memberId, key: 'full_name', value: 'again' }))
    ).toEqual({
      code: UNIQUE,
      constraint: 'details_member_id_key_unique'
    })
    const [d] = await db.insert(details).values({ memberId: a.memberId, key: 'student_id', value: '1' }).returning()
    expect(d).toMatchObject({ labels: [], position: 0 })
  })

  test('a mention name is unique per member ignoring case', async () => {
    const a = await seedMember(db)
    const b = await seedMember(db, { full: false })
    expect(await violation(db.insert(mentionNames).values({ memberId: a.memberId, name: 'SEED' }))).toEqual({
      code: UNIQUE,
      constraint: 'mention_names_member_id_lower_name_unique'
    })
    await db.insert(mentionNames).values({ memberId: b.memberId, name: 'seed' })
  })
})

describe('timetable and occurrences', () => {
  test('an occurrence is unique per entry and start', async () => {
    const a = await seedMember(db)
    const [o] = await db.select().from(occurrences).where(eq(occurrences.id, a.ids.occurrences))
    expect(await violation(db.insert(occurrences).values({ ...o!, id: undefined }))).toEqual({
      code: UNIQUE,
      constraint: 'occurrences_entry_id_scheduled_start_unique'
    })
  })

  test('an unknown occurrence state is rejected', async () => {
    const a = await seedMember(db)
    expect(
      await violation(
        db
          .update(occurrences)
          .set({ state: 'bogus' as never })
          .where(eq(occurrences.id, a.ids.occurrences))
      )
    ).toEqual({ code: CHECK, constraint: 'occurrences_state_check' })
  })

  test('a new occurrence starts scheduled with no attempts', async () => {
    const a = await seedMember(db)
    const [o] = await db.select().from(occurrences).where(eq(occurrences.id, a.ids.occurrences))
    expect(o).toMatchObject({
      state: 'scheduled',
      attempt: 0,
      restarts: 0,
      recording: false,
      pendingCommands: [],
      entrySnapshot: null
    })
  })

  test('an entry has a known type and transcription mode, and times of day', async () => {
    const a = await seedMember(db)
    const [entry] = await db.select().from(timetableEntries).where(eq(timetableEntries.id, a.ids.timetableEntries))
    expect(entry).toMatchObject({
      startTime: '14:00:00',
      endTime: '16:00:00',
      trustedSenders: [],
      formDetails: {},
      attendanceKeywords: [],
      paused: false
    })
    const { id: _id, ...rest } = entry!
    expect(await violation(db.insert(timetableEntries).values({ ...rest, type: 'party' as never }))).toEqual({
      code: CHECK,
      constraint: 'timetable_entries_type_check'
    })
    expect(await violation(db.insert(timetableEntries).values({ ...rest, transcription: 'guess' as never }))).toEqual({
      code: CHECK,
      constraint: 'timetable_entries_transcription_check'
    })
  })

  test('an identity with timetable entries cannot be deleted', async () => {
    const a = await seedMember(db)
    await db.delete(occurrences).where(eq(occurrences.id, a.ids.occurrences))
    expect(await violation(db.delete(identities).where(eq(identities.id, a.identityId)))).toEqual({
      code: FOREIGN_KEY,
      constraint: 'timetable_entries_identity_id_identities_id_fk'
    })
  })

  test('deleting an entry keeps its occurrences, with no entry', async () => {
    const a = await seedMember(db)
    await db.delete(timetableEntries).where(eq(timetableEntries.id, a.ids.timetableEntries))
    const [o] = await db.select().from(occurrences).where(eq(occurrences.id, a.ids.occurrences))
    expect(o!.entryId).toBeNull()
  })

  test('an occurrence needs its delete_after time', async () => {
    const a = await seedMember(db)
    const [o] = await db.select().from(occurrences).where(eq(occurrences.id, a.ids.occurrences))
    const { id: _id, deleteAfter: _d, ...rest } = o!
    expect((await violation(db.insert(occurrences).values({ ...rest, entryId: null } as never))).code).toBe(NOT_NULL)
  })
})

describe('events, forms, artefacts', () => {
  test('a repeated event is stored once', async () => {
    const a = await seedMember(db)
    const e = {
      occurrenceId: a.ids.occurrences,
      memberId: a.memberId,
      attempt: 1,
      at: new Date('2026-10-21T06:00:00Z'),
      type: 'joined' as const,
      data: {},
      dataHash: 'h'
    }
    await db.insert(events).values(e).onConflictDoNothing()
    await db.insert(events).values(e).onConflictDoNothing()
    expect(await db.$count(events, eq(events.occurrenceId, a.ids.occurrences))).toBe(2) // the seeded state event and one joined
    expect(await db.$count(events, eq(events.dataHash, 'h'))).toBe(1)
    expect(await violation(db.insert(events).values(e))).toEqual({
      code: UNIQUE,
      constraint: 'events_occurrence_id_attempt_at_type_data_hash_unique'
    })
  })

  test('an unknown event type is rejected', async () => {
    const a = await seedMember(db)
    const e = {
      occurrenceId: a.ids.occurrences,
      memberId: a.memberId,
      attempt: 1,
      at: new Date(),
      data: {},
      dataHash: 'x'
    }
    expect(await violation(db.insert(events).values({ ...e, type: 'sneeze' as never }))).toEqual({
      code: CHECK,
      constraint: 'events_type_check'
    })
  })

  test('a form is unique per occurrence and key, with a known source and state', async () => {
    const a = await seedMember(db)
    const f = {
      occurrenceId: a.ids.occurrences,
      memberId: a.memberId,
      url: 'https://forms.office.com/x',
      source: 'qr' as const,
      state: 'detected' as const,
      seenAt: new Date()
    }
    expect(await violation(db.insert(forms).values({ ...f, formKey: 'seed-form' }))).toEqual({
      code: UNIQUE,
      constraint: 'forms_occurrence_id_form_key_unique'
    })
    expect(await violation(db.insert(forms).values({ ...f, formKey: 'k2', source: 'email' as never }))).toEqual({
      code: CHECK,
      constraint: 'forms_source_check'
    })
    expect(await violation(db.insert(forms).values({ ...f, formKey: 'k3', state: 'dancing' as never }))).toEqual({
      code: CHECK,
      constraint: 'forms_state_check'
    })
    const [ok] = await db
      .insert(forms)
      .values({ ...f, formKey: 'k4' })
      .returning()
    expect(ok).toMatchObject({ fieldsFilled: [], provider: null, submittedAt: null })
  })

  test('an artefact path is unique per occurrence, and its kind is checked', async () => {
    const a = await seedMember(db)
    const base = { occurrenceId: a.ids.occurrences, memberId: a.memberId, bytes: 1 }
    expect(await violation(db.insert(artefacts).values({ ...base, kind: 'summary', path: 'out/summary.md' }))).toEqual({
      code: UNIQUE,
      constraint: 'artefacts_occurrence_id_path_unique'
    })
    expect(await violation(db.insert(artefacts).values({ ...base, kind: 'video' as never, path: 'x' }))).toEqual({
      code: CHECK,
      constraint: 'artefacts_kind_check'
    })
    await db
      .insert(artefacts)
      .values({ ...base, kind: 'recording', path: 'recording/meeting.mp4', bytes: 5_000_000_000 })
  })

  test('deleting an occurrence deletes its events, forms and artefacts, and unlinks sign-in sessions', async () => {
    const a = await seedMember(db)
    await db.delete(occurrences).where(eq(occurrences.id, a.ids.occurrences))
    expect(await db.$count(events, eq(events.occurrenceId, a.ids.occurrences))).toBe(0)
    expect(await db.$count(forms, eq(forms.occurrenceId, a.ids.occurrences))).toBe(0)
    expect(await db.$count(artefacts, eq(artefacts.occurrenceId, a.ids.occurrences))).toBe(0)
    const [s] = await db.select().from(signinSessions).where(eq(signinSessions.id, a.ids.signinSessions))
    expect(s!.occurrenceId).toBeNull()
  })
})

describe('keys, connections, devices, sign-in sessions', () => {
  test('a member has one AI key row, and the DashScope key is required', async () => {
    const a = await seedMember(db)
    expect(await violation(db.insert(aiKeys).values({ memberId: a.memberId, dashscopeKeyEnc: 'x' }))).toEqual({
      code: UNIQUE,
      constraint: 'ai_keys_pkey'
    })
    const b = await seedMember(db, { full: false })
    await db.delete(aiKeys).where(eq(aiKeys.memberId, b.memberId))
    expect((await violation(db.insert(aiKeys).values({ memberId: b.memberId } as never))).code).toBe(NOT_NULL)
    await db.insert(aiKeys).values({ memberId: b.memberId, dashscopeKeyEnc: 'sealed' })
    const [k] = await db.select().from(aiKeys).where(eq(aiKeys.memberId, b.memberId))
    expect(k).toMatchObject({ testOk: false, modelscopeTestOk: null, modelscopeKeyEnc: null })
  })

  test('a connection is unique per member and kind, and the token is required', async () => {
    const a = await seedMember(db)
    expect(
      await violation(db.insert(connections).values({ memberId: a.memberId, kind: 'google', tokenEnc: 'x' }))
    ).toEqual({
      code: UNIQUE,
      constraint: 'connections_member_id_kind_unique'
    })
    expect(
      await violation(db.insert(connections).values({ memberId: a.memberId, kind: 'dropbox' as never, tokenEnc: 'x' }))
    ).toEqual({
      code: CHECK,
      constraint: 'connections_kind_check'
    })
    expect(
      (await violation(db.insert(connections).values({ memberId: a.memberId, kind: 'notion' } as never))).code
    ).toBe(NOT_NULL)
    await db.insert(connections).values({ memberId: a.memberId, kind: 'notion', tokenEnc: 'x' })
  })

  test('a device token hash is unique', async () => {
    const a = await seedMember(db)
    const [d] = await db.select().from(deviceTokens).where(eq(deviceTokens.id, a.ids.deviceTokens))
    expect(
      await violation(db.insert(deviceTokens).values({ memberId: a.memberId, name: 'again', tokenHash: d!.tokenHash }))
    ).toEqual({
      code: UNIQUE,
      constraint: 'device_tokens_token_hash_unique'
    })
  })

  test('a sign-in session starts in "starting", and its mode and state are checked', async () => {
    const a = await seedMember(db)
    const [s] = await db.select().from(signinSessions).where(eq(signinSessions.id, a.ids.signinSessions))
    expect(s).toMatchObject({ state: 'starting', doneRequested: false, endedAt: null })
    expect(s!.startedAt).toBeInstanceOf(Date)
    const base = { memberId: a.memberId, identityId: a.identityId }
    expect(await violation(db.insert(signinSessions).values({ ...base, mode: 'vnc' as never }))).toEqual({
      code: CHECK,
      constraint: 'signin_sessions_mode_check'
    })
    expect(
      await violation(db.insert(signinSessions).values({ ...base, mode: 'worker', state: 'paused' as never }))
    ).toEqual({
      code: CHECK,
      constraint: 'signin_sessions_state_check'
    })
  })
})

describe('deleting a member', () => {
  test('removes everything the member owns and nothing of anyone else', async () => {
    const a = await seedMember(db)
    const b = await seedMember(db)
    await db.delete(members).where(eq(members.id, a.memberId))
    for (const [name, table] of Object.entries(MEMBER_OWNED)) {
      const key = name as keyof typeof MEMBER_OWNED
      expect(await db.$count(table, eq(pkOf(table), a.ids[key]))).toBe(0)
      expect(await db.$count(table, eq(pkOf(table), b.ids[key]))).toBe(1)
    }
  })
})
