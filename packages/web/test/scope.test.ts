import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { artefacts, closeDb, identities, MEMBER_OWNED, members, mentionNames, pkOf, type Db } from '../db'
import { createTestDb, dropAllTestDbs, seedMember, testDbUrl } from '../db/testing'
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
