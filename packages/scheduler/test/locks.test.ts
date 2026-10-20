import { afterAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { profiles } from '@tm/web/db'
import { createTestDb, dropAllTestDbs, seedMember } from '@tm/web/db/testing'
import { acquireProfile, releaseProfile } from '../src/index'

afterAll(dropAllTestDbs, 60_000)

test('a profile has one holder at a time', async () => {
  const db = await createTestDb()
  const { identityId } = await seedMember(db, { full: false })
  expect(await acquireProfile(db, identityId, 'occ:a')).toBe(true)
  expect(await acquireProfile(db, identityId, 'signin:b')).toBe(false)
  await releaseProfile(db, identityId, 'signin:b')
  expect(await acquireProfile(db, identityId, 'signin:b')).toBe(false)
  await releaseProfile(db, identityId, 'occ:a')
  expect(await acquireProfile(db, identityId, 'signin:b')).toBe(true)
  const [row] = await db.select().from(profiles).where(eq(profiles.identityId, identityId))
  expect(row).toMatchObject({ heldBy: 'signin:b' })
  expect(row!.heldSince).toBeInstanceOf(Date)
})
