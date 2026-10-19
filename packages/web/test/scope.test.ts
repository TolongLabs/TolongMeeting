import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq, sql, type SQL } from 'drizzle-orm'
import {
  artefacts,
  closeDb,
  events,
  forms,
  identities,
  MEMBER_OWNED,
  members,
  mentionNames,
  occurrences,
  pkOf,
  profiles,
  signinSessions,
  timetableEntries,
  type Db
} from '../db'
import { createTestDb, dropAllTestDbs, seedMember, testDbUrl, type Seeded } from '../db/testing'
import { createScope, scopeForAuthUser, type MemberOwnedTable } from '../lib/scope'

let db: Db

beforeAll(async () => {
  db = await createTestDb()
})

afterAll(async () => {
  await dropAllTestDbs()
})

/** A change to one column of each member-owned table, used to prove updates land on the owner's row only. */
const CHANGED: Record<keyof typeof MEMBER_OWNED, Record<string, unknown>> = {
  identities: { name: 'Changed' },
  profiles: { latestCheckpoint: 'changed' },
  details: { value: 'changed' },
  mentionNames: { name: 'Changed' },
  timetableEntries: { name: 'Changed' },
  occurrences: { stateReason: 'changed' },
  events: { dataHash: 'changed' },
  forms: { result: 'changed' },
  artefacts: { bytes: 7 },
  aiKeys: { testError: 'changed' },
  connections: { tokenEnc: 'changed' },
  deviceTokens: { name: 'Changed' },
  signinSessions: { upstream: 'changed' }
}

async function rowById(table: MemberOwnedTable, id: string) {
  return db
    .select()
    .from(table)
    .where(eq(pkOf(table), id))
}

async function withEnv<T>(name: string, value: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env[name]
  process.env[name] = value
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

describe('isolation between members', () => {
  for (const name of Object.keys(MEMBER_OWNED) as (keyof typeof MEMBER_OWNED)[]) {
    const table = MEMBER_OWNED[name]
    test(`${name}: reads return only the scope's own rows`, async () => {
      const a = await seedMember(db)
      const b = await seedMember(db)
      const scope = createScope(db, b.memberId)
      expect((await scope.select(table)).map((r) => r.memberId)).toEqual([b.memberId])
      expect(await scope.select(table, eq(pkOf(table), a.ids[name]))).toEqual([])
    })

    test(`${name}: updates and deletes never touch another member's row`, async () => {
      const a = await seedMember(db)
      const b = await seedMember(db)
      const before = await rowById(table, a.ids[name])
      const scope = createScope(db, b.memberId)
      expect(await scope.update(table, CHANGED[name], eq(pkOf(table), a.ids[name]))).toBe(0)
      expect(await scope.remove(table, eq(pkOf(table), a.ids[name]))).toBe(0)
      expect(await rowById(table, a.ids[name])).toEqual(before)
    })

    test(`${name}: a where with a bare or can't reach another member's rows`, async () => {
      const a = await seedMember(db)
      const b = await seedMember(db)
      const before = await rowById(table, a.ids[name])
      const scope = createScope(db, b.memberId)
      const everything = sql`true or ${pkOf(table)} is null`
      expect((await scope.select(table, everything)).map((r) => r.memberId)).toEqual([b.memberId])
      expect(await scope.update(table, CHANGED[name], everything)).toBe(1)
      expect(await rowById(table, a.ids[name])).toEqual(before)
    })

    test(`${name}: the owner's scope can update its own row`, async () => {
      const a = await seedMember(db)
      const own = createScope(db, a.memberId)
      expect(await own.update(table, CHANGED[name], eq(pkOf(table), a.ids[name]))).toBe(1)
      const [row] = await rowById(table, a.ids[name])
      expect(
        Object.entries(CHANGED[name]).every(([key, value]) => (row as Record<string, unknown>)[key] === value)
      ).toBe(true)
    })
  }
})

describe('a caller where clause', () => {
  // Leaf tables only: deleting an identity is blocked by its timetable entries, which is not what this test is about.
  for (const name of ['mentionNames', 'details', 'connections', 'deviceTokens'] as const) {
    test(`${name}: a bare or in remove's where can't delete another member's rows`, async () => {
      const a = await seedMember(db)
      const b = await seedMember(db)
      const table = MEMBER_OWNED[name]
      const before = await rowById(table, a.ids[name])
      expect(await createScope(db, b.memberId).remove(table, sql`true or ${pkOf(table)} is null`)).toBe(1)
      expect(await rowById(table, a.ids[name])).toEqual(before)
      expect(await rowById(table, b.ids[name])).toEqual([])
    })
  }
})

describe('scope operations', () => {
  test('the owner can delete its own row', async () => {
    const a = await seedMember(db)
    expect(await createScope(db, a.memberId).remove(mentionNames, eq(pkOf(mentionNames), a.ids.mentionNames))).toBe(1)
    expect(await rowById(mentionNames, a.ids.mentionNames)).toEqual([])
  })

  test("an update can't touch or move another member's row", async () => {
    const a = await seedMember(db)
    const b = await seedMember(db)
    const sb = createScope(db, b.memberId)
    expect(await sb.update(identities, { name: 'Taken' }, eq(identities.id, a.identityId))).toBe(0)
    await sb.update(identities, { memberId: a.memberId, name: 'Mine' } as never, eq(identities.id, b.identityId))
    const [row] = await db.select().from(identities).where(eq(identities.id, b.identityId))
    expect(row).toMatchObject({ memberId: b.memberId, name: 'Mine' })
  })

  test('an insert is always stored under the scope member', async () => {
    const a = await seedMember(db)
    const b = await seedMember(db)
    const row = await createScope(db, b.memberId).insert(mentionNames, {
      name: 'Short Name',
      memberId: a.memberId
    } as never)
    expect(row.memberId).toBe(b.memberId)
  })

  test('me and updateMe act on the scope member only', async () => {
    const a = await seedMember(db)
    const b = await seedMember(db)
    await createScope(db, b.memberId).updateMe({ displayName: 'Bee' })
    expect((await createScope(db, b.memberId).me()).displayName).toBe('Bee')
    const [rowA] = await db.select().from(members).where(eq(members.id, a.memberId))
    expect(rowA!.displayName).not.toBe('Bee')
  })

  test('updateMe ignores keys outside its four settings', async () => {
    const b = await seedMember(db)
    const scope = createScope(db, b.memberId)
    const before = await scope.me()
    await scope.updateMe({ role: 'admin', githubLogin: 'taken', authUserId: 'x', displayName: 'Bee' } as never)
    await scope.updateMe({ role: 'admin' } as never)
    expect(await scope.me()).toEqual({ ...before, displayName: 'Bee' })
  })

  test('a transaction scope keeps the same member', async () => {
    const b = await seedMember(db)
    const memberIds = await createScope(db, b.memberId).transaction(async (s) => {
      const rows = await s.select(mentionNames)
      return [s.memberId, ...rows.map((r) => r.memberId)]
    })
    expect(memberIds.every((id) => id === b.memberId)).toBe(true)
  })

  test('artefact files resolve only for the owner registered paths', async () => {
    const a = await seedMember(db)
    const b = await seedMember(db)
    const [art] = await db.select().from(artefacts).where(eq(artefacts.id, a.ids.artefacts))
    await withEnv('TM_DATA_ROOT', '/data/tm', async () => {
      expect(await createScope(db, a.memberId).artefactFile(art!.occurrenceId, art!.path)).toBe(
        `/data/tm/occurrences/${art!.occurrenceId}/${art!.path}`
      )
      expect(await createScope(db, b.memberId).artefactFile(art!.occurrenceId, art!.path)).toBeNull()
      expect(await createScope(db, a.memberId).artefactFile(art!.occurrenceId, '../../etc/passwd')).toBeNull()
    })
  })

  test('artefact files never leave the occurrence directory, even for a registered path', async () => {
    const a = await seedMember(db)
    const scope = createScope(db, a.memberId)
    const [art] = await db.select().from(artefacts).where(eq(artefacts.id, a.ids.artefacts))
    const occurrenceId = art!.occurrenceId
    for (const path of ['../../x', '../x', 'out/../../x', '/etc/passwd', '.', '']) {
      await scope.insert(artefacts, { occurrenceId, kind: 'summary', path, bytes: 1 })
    }
    await withEnv('TM_DATA_ROOT', '/data/tm', async () => {
      for (const path of ['../../x', '../x', 'out/../../x', '/etc/passwd', '.', '']) {
        expect(await scope.artefactFile(occurrenceId, path)).toBeNull()
      }
      expect(await scope.artefactFile('not-a-uuid', art!.path)).toBeNull()
      expect(await scope.artefactFile(`${occurrenceId}/..`, art!.path)).toBeNull()
    })
  })

  test('artefact files normalise a messy TM_DATA_ROOT', async () => {
    const a = await seedMember(db)
    const [art] = await db.select().from(artefacts).where(eq(artefacts.id, a.ids.artefacts))
    await withEnv('TM_DATA_ROOT', '/data/./tm//sub/..', async () => {
      expect(await createScope(db, a.memberId).artefactFile(art!.occurrenceId, art!.path)).toBe(
        resolve('/data/tm', 'occurrences', art!.occurrenceId, art!.path)
      )
    })
  })

  test('scopeForAuthUser returns the scope of the linked member, or null', async () => {
    const a = await seedMember(db)
    const authUserId = `auth-${a.memberId}`
    await db.update(members).set({ authUserId }).where(eq(members.id, a.memberId))
    await withEnv('DATABASE_URL', testDbUrl(db), async () => {
      try {
        expect((await scopeForAuthUser(authUserId))?.memberId).toBe(a.memberId)
        expect(await scopeForAuthUser('no-such-auth-user')).toBeNull()
      } finally {
        await closeDb()
      }
    })
  })
})

describe('child rows follow their parent member in the database', () => {
  type Writer = {
    insert(table: MemberOwnedTable, values: Record<string, unknown>): Promise<unknown>
    update(table: MemberOwnedTable, set: Record<string, unknown>, where: SQL): Promise<unknown>
  }
  const writers: Record<string, (b: string) => Writer> = {
    'through the scope': (b) => {
      const scope = createScope(db, b)
      return {
        insert: (table, values) => scope.insert(table, values as never),
        update: (table, set, where) => scope.update(table, set as never, where)
      }
    },
    'through raw db': (b) => ({
      insert: (table, values) =>
        db
          .insert(table)
          .values({ ...values, memberId: b } as never)
          .returning(),
      update: (table, set, where) => db.update(table).set(set).where(where)
    })
  }

  // Differs from the seeded start so the unique keys on the child tables don't fire before the foreign key does.
  const elsewhere = new Date('2026-11-02T06:00:00Z')

  /** Each case tries to attach one of b's rows to one of a's parents. */
  const attach: Record<string, (w: Writer, a: Seeded, b: Seeded) => Promise<unknown>> = {
    'timetable entry -> identity': async (w, a, b) => {
      const { id: _, memberId: __, ...entry } = await only(timetableEntries, b.ids.timetableEntries)
      return w.insert(timetableEntries, { ...entry, identityId: a.identityId })
    },
    'timetable entry moved to identity': (w, a, b) =>
      w.update(timetableEntries, { identityId: a.identityId }, eq(timetableEntries.id, b.ids.timetableEntries)),
    'occurrence -> identity': async (w, a, b) => {
      const { id: _, memberId: __, ...occurrence } = await only(occurrences, b.ids.occurrences)
      return w.insert(occurrences, { ...occurrence, entryId: null, identityId: a.identityId })
    },
    'occurrence -> timetable entry': async (w, a, b) => {
      const { id: _, memberId: __, ...occurrence } = await only(occurrences, b.ids.occurrences)
      return w.insert(occurrences, { ...occurrence, entryId: a.ids.timetableEntries, scheduledStart: elsewhere })
    },
    'occurrence moved to timetable entry': (w, a, b) =>
      w.update(
        occurrences,
        { entryId: a.ids.timetableEntries, scheduledStart: elsewhere },
        eq(occurrences.id, b.ids.occurrences)
      ),
    'occurrence moved to identity': (w, a, b) =>
      w.update(occurrences, { identityId: a.identityId }, eq(occurrences.id, b.ids.occurrences)),
    'event -> occurrence': async (w, a, b) => {
      const { id: _, memberId: __, ...event } = await only(events, b.ids.events)
      return w.insert(events, { ...event, attempt: 2, occurrenceId: a.ids.occurrences })
    },
    'form -> occurrence': async (w, a, b) => {
      const { id: _, memberId: __, ...form } = await only(forms, b.ids.forms)
      return w.insert(forms, { ...form, formKey: 'other', occurrenceId: a.ids.occurrences })
    },
    'artefact -> occurrence': async (w, a, b) => {
      const { id: _, memberId: __, ...artefact } = await only(artefacts, b.ids.artefacts)
      return w.insert(artefacts, { ...artefact, path: 'other', occurrenceId: a.ids.occurrences })
    },
    'artefact moved to occurrence': (w, a, b) =>
      w.update(artefacts, { occurrenceId: a.ids.occurrences, path: 'other' }, eq(artefacts.id, b.ids.artefacts)),
    'profile -> identity': async (w, a) => {
      const [bare] = await db
        .insert(identities)
        .values({ memberId: a.memberId, name: 'Bare', zoomGuestName: 'Bare' })
        .returning()
      return w.insert(profiles, { identityId: bare!.id })
    },
    'sign-in session -> identity': (w, a) => w.insert(signinSessions, { identityId: a.identityId, mode: 'worker' }),
    'sign-in session -> occurrence': (w, a, b) =>
      w.insert(signinSessions, { identityId: b.identityId, mode: 'container', occurrenceId: a.ids.occurrences })
  }

  async function only(table: MemberOwnedTable, id: string) {
    const [row] = await rowById(table, id)
    return row as Record<string, unknown> & { id: string; memberId: string }
  }

  for (const [via, writer] of Object.entries(writers)) {
    for (const [name, run] of Object.entries(attach)) {
      test(`${via}: ${name} is refused when the parent belongs to another member`, async () => {
        const a = await seedMember(db)
        const b = await seedMember(db)
        await expectForeignKeyViolation(run(writer(b.memberId), a, b))
      })
    }
  }

  test("a child can't be moved to another member while its parent stays", async () => {
    const a = await seedMember(db)
    const b = await seedMember(db)
    await expectForeignKeyViolation(
      db.update(artefacts).set({ memberId: a.memberId }).where(eq(artefacts.id, b.ids.artefacts)) as never
    )
    await expectForeignKeyViolation(
      db
        .update(timetableEntries)
        .set({ memberId: a.memberId })
        .where(eq(timetableEntries.id, b.ids.timetableEntries)) as never
    )
  })

  test('a child may still point at its own member parents', async () => {
    const b = await seedMember(db)
    const scope = createScope(db, b.memberId)
    const { id: _, memberId: __, ...entry } = await only(timetableEntries, b.ids.timetableEntries)
    const own = await scope.insert(timetableEntries, entry as never)
    expect(own.identityId).toBe(b.identityId)
  })

  test('deleting a parent still sets only the reference to null', async () => {
    const b = await seedMember(db)
    const session = await createScope(db, b.memberId).insert(signinSessions, {
      identityId: b.identityId,
      mode: 'container',
      occurrenceId: b.ids.occurrences
    })
    await db.delete(timetableEntries).where(eq(timetableEntries.id, b.ids.timetableEntries))
    const [occurrence] = await rowById(occurrences, b.ids.occurrences)
    expect(occurrence).toMatchObject({ entryId: null, memberId: b.memberId })
    await db.delete(occurrences).where(eq(occurrences.id, b.ids.occurrences))
    const [after] = await rowById(signinSessions, session.id)
    expect(after).toMatchObject({ occurrenceId: null, memberId: b.memberId })
    expect(await rowById(artefacts, b.ids.artefacts)).toEqual([])
  })
})

/** Postgres error 23503; drizzle wraps the driver error as `cause`. */
async function expectForeignKeyViolation(run: Promise<unknown>) {
  const error = await run.then(
    () => null,
    (e: unknown) => e
  )
  expect((error as { cause?: { code?: string } } | null)?.cause?.code).toBe('23503')
}
