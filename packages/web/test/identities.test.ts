import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { identities, occurrences, profiles, timetableEntries, type Db } from '../db'
import { createTestDb, dropAllTestDbs, seedMember, withEntry } from '../db/testing'
import {
  accountStatus,
  createIdentity,
  deleteIdentity,
  IdentityInputSchema,
  InUseError,
  listIdentities,
  updateIdentity
} from '../lib/identities'
import { createScope, type MemberScope } from '../lib/scope'
import { createIdentityFor, deleteIdentityFor } from '../lib/action-results'

let db: Db

beforeAll(async () => {
  db = await createTestDb()
})

afterAll(async () => {
  await dropAllTestDbs()
})

/** A member with an identity and profile, and no other rows. */
async function bare(): Promise<{ scope: MemberScope; identityId: string }> {
  const { memberId, identityId } = await seedMember(db, { full: false })
  return { scope: createScope(db, memberId), identityId }
}

const WORK = { name: 'Work', runLocation: 'server', zoomGuestName: 'A Member' }

describe('IdentityInputSchema', () => {
  test('only the server run location is accepted for now', () => {
    expect(
      IdentityInputSchema.safeParse({
        name: 'Home',
        runLocation: 'local',
        zoomGuestName: 'A'
      }).error?.issues[0]?.message
    ).toBe('Only "Server" is available until run locations are added.')
  })

  test('name and zoom guest name are trimmed and length-checked', () => {
    expect(IdentityInputSchema.parse({ ...WORK, name: '  Work  ', zoomGuestName: ' A ' })).toMatchObject({
      name: 'Work',
      zoomGuestName: 'A'
    })
    expect(IdentityInputSchema.safeParse({ ...WORK, name: '   ' }).success).toBe(false)
    expect(IdentityInputSchema.safeParse({ ...WORK, name: 'x'.repeat(41) }).success).toBe(false)
    expect(IdentityInputSchema.safeParse({ ...WORK, zoomGuestName: 'x'.repeat(65) }).success).toBe(false)
  })

  test('organisation name and email domain are both given or both absent', () => {
    const base = { ...WORK }
    expect(IdentityInputSchema.safeParse({ ...base, orgName: 'Uni', orgEmailDomain: 'uni.edu.my' }).success).toBe(true)
    expect(IdentityInputSchema.safeParse({ ...base, orgName: '', orgEmailDomain: '' }).success).toBe(true)
    expect(IdentityInputSchema.safeParse({ ...base, orgName: 'Uni' }).success).toBe(false)
    expect(IdentityInputSchema.safeParse({ ...base, orgEmailDomain: 'uni.edu.my' }).success).toBe(false)
  })

  test('free-text identity fields refuse control characters', () => {
    for (const patch of [
      { name: 'Wo\u0000rk' },
      { name: 'Wo\trk' },
      { zoomGuestName: 'A\u0085' },
      { orgName: 'Uni\u0007', orgEmailDomain: 'uni.edu' }
    ]) {
      expect(IdentityInputSchema.safeParse({ ...WORK, ...patch }).success).toBe(false)
    }
  })

  test('the organisation email domain is a bare lower-cased domain', () => {
    const base = { ...WORK, orgName: 'Uni' }
    const parsed = IdentityInputSchema.parse({ ...base, orgEmailDomain: ' Uni.EDU.my ' })
    expect(parsed.orgEmailDomain).toBe('uni.edu.my')
    for (const bad of ['@uni.edu.my', 'https://uni.edu.my', 'uni.edu.my/x', 'localhost', 'uni..edu', 'uni edu.my']) {
      expect(IdentityInputSchema.safeParse({ ...base, orgEmailDomain: bad }).success).toBe(false)
    }
  })
})

test('creating an identity creates its profile', async () => {
  const { scope } = await bare()
  const id = await createIdentity(scope, WORK)
  expect(id.name).toBe('Work')
  expect(await scope.select(profiles, eq(profiles.identityId, id.id))).toHaveLength(1)
})

test('an identity name is unique for the member', async () => {
  const { scope } = await bare()
  await createIdentity(scope, WORK)
  await expect(createIdentity(scope, WORK)).rejects.toThrow('You already have an identity called "Work".')
})

test('updating an identity changes its settings and keeps names unique', async () => {
  const { scope } = await bare()
  const work = await createIdentity(scope, WORK)
  await updateIdentity(scope, work.id, { ...WORK, zoomGuestName: 'Renamed', orgName: 'Uni', orgEmailDomain: 'uni.edu' })
  const [row] = await scope.select(identities, eq(identities.id, work.id))
  expect(row).toMatchObject({ zoomGuestName: 'Renamed', orgName: 'Uni', orgEmailDomain: 'uni.edu' })
  await expect(updateIdentity(scope, work.id, { ...WORK, name: 'Main' })).rejects.toThrow(
    'You already have an identity called "Main".'
  )
})

test('listing returns only the member’s identities', async () => {
  const a = await bare()
  const b = await bare()
  await createIdentity(a.scope, { ...WORK, name: 'Mine' })
  await createIdentity(b.scope, { ...WORK, name: 'Theirs' })
  expect((await listIdentities(a.scope)).map((i) => i.name).sort()).toEqual(['Main', 'Mine'])
})

test("an identity in use can't be deleted", async () => {
  const { scope, identityId } = await bare()
  await scope.update(profiles, { heldBy: 'occ:x' }, eq(profiles.identityId, identityId))
  await expect(deleteIdentity(scope, identityId)).rejects.toThrow('This identity is in use by a meeting or a sign-in.')
  await expect(deleteIdentity(scope, identityId)).rejects.toBeInstanceOf(InUseError)
  expect(await scope.select(identities, eq(identities.id, identityId))).toHaveLength(1)
})

/** An occurrence with no timetable entry (its entry was deleted), so only its state can hold the identity. */
async function addOccurrence(
  scope: MemberScope,
  identityId: string,
  state: 'scheduled' | 'post_processing' | 'completed'
) {
  await scope.insert(occurrences, {
    identityId,
    entryName: 'Past lecture',
    entryType: 'lecture',
    transcription: 'live',
    scheduledStart: new Date('2026-10-21T06:00:00Z'),
    scheduledEnd: new Date('2026-10-21T08:00:00Z'),
    deleteAfter: new Date('2026-11-21T06:00:00Z'),
    state
  })
}

test('an identity with an occurrence that has not finished is kept; a finished one does not block', async () => {
  for (const state of ['scheduled', 'post_processing'] as const) {
    const { scope, identityId } = await bare()
    await addOccurrence(scope, identityId, state)
    await expect(deleteIdentity(scope, identityId)).rejects.toThrow(
      'This identity has a meeting or sign-in that has not finished.'
    )
    expect(await scope.select(identities, eq(identities.id, identityId))).toHaveLength(1)
  }
  const done = await bare()
  await addOccurrence(done.scope, done.identityId, 'completed')
  await deleteIdentity(done.scope, done.identityId)
  expect(await done.scope.select(identities, eq(identities.id, done.identityId))).toHaveLength(0)
})

test('an identity with timetable entries is refused with a typed error and never cascades', async () => {
  const fixture = await withEntry({
    repeat: { kind: 'once', date: '2026-10-21' },
    startTime: '14:00',
    endTime: '16:00'
  })
  const scope = createScope(fixture.db, fixture.memberId)
  const error = await deleteIdentity(scope, fixture.identityId).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(InUseError)
  expect((error as Error).message).toBe('This identity has timetable entries.')
  expect(await fixture.db.select().from(timetableEntries).where(eq(timetableEntries.id, fixture.entryId))).toHaveLength(
    1
  )
  expect(await scope.select(identities, eq(identities.id, fixture.identityId))).toHaveLength(1)
})

test('an identity without timetable entries or holds is deleted with its profile', async () => {
  const { scope } = await bare()
  const work = await createIdentity(scope, WORK)
  await deleteIdentity(scope, work.id)
  expect(await scope.select(profiles, eq(profiles.identityId, work.id))).toHaveLength(0)
  expect(await scope.select(identities, eq(identities.id, work.id))).toHaveLength(0)
})

test('account status lists every account in order', async () => {
  const { scope, identityId } = await bare()
  await scope.update(
    profiles,
    {
      accountStatus: {
        zoom: { verifiedAt: '2026-10-21T05:01:00Z', signedIn: true }
      }
    },
    eq(profiles.identityId, identityId)
  )
  const s = await accountStatus(scope, identityId)
  expect(s.map((x) => x.label)).toEqual(['Zoom', 'Microsoft', 'Google', 'WhatsApp Web', 'Discord', 'Teams'])
  expect(s[0]).toEqual({
    kind: 'zoom',
    label: 'Zoom',
    verifiedAt: '2026-10-21T05:01:00Z',
    signedIn: true
  })
  expect(s[1]).toEqual({ kind: 'microsoft', label: 'Microsoft', verifiedAt: null, signedIn: null })
})

describe('another member’s identity is refused', () => {
  test('every identity call on it fails and leaves it unchanged', async () => {
    const owner = await bare()
    const other = await bare()
    const theirs = await createIdentity(owner.scope, WORK)

    await expect(updateIdentity(other.scope, theirs.id, { ...WORK, zoomGuestName: 'Hijack' })).rejects.toThrow(
      'No such identity.'
    )
    await expect(deleteIdentity(other.scope, theirs.id)).rejects.toThrow('No such identity.')
    await expect(accountStatus(other.scope, theirs.id)).rejects.toThrow('No such identity.')

    const [row] = await owner.scope.select(identities, eq(identities.id, theirs.id))
    expect(row?.zoomGuestName).toBe('A Member')
    expect(await owner.scope.select(profiles, eq(profiles.identityId, theirs.id))).toHaveLength(1)
  })
})

test('the actions return refusals as messages and keep other members’ identities out', async () => {
  const owner = await bare()
  const other = await bare()
  const created = await createIdentityFor(owner.scope, WORK)
  expect(created).toEqual({ ok: true })
  const mine = (await listIdentities(owner.scope)).find((row) => row.name === 'Work')
  expect(mine).toBeDefined()

  expect(await createIdentityFor(owner.scope, { ...WORK, name: 'Bad', runLocation: 'local' })).toEqual({
    ok: false,
    error: 'Only "Server" is available until run locations are added.'
  })
  await owner.scope.update(profiles, { heldBy: 'occ:x' }, eq(profiles.identityId, mine!.id))
  expect(await deleteIdentityFor(owner.scope, mine!.id)).toEqual({
    ok: false,
    error: 'This identity is in use by a meeting or a sign-in.'
  })
  await expect(deleteIdentityFor(other.scope, mine!.id)).rejects.toThrow('No such identity.')
})
