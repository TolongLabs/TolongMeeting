import { afterAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  aiKeys,
  artefacts,
  auth_account,
  auth_user,
  connections,
  deviceTokens,
  details,
  forms,
  identities,
  members,
  mentionNames,
  occurrences,
  profiles,
  signinSessions,
  timetableEntries,
  type Db
} from '../db'
import { createTestDb, dropAllTestDbs, seedLinkedMember, seedMember } from '../db/testing'
import { NtfyAdminError, ntfyUsername, type NtfyAdmin } from '../lib/ntfy-admin'
import { addMemberFor, removeMemberFor, setRoleFor } from '../lib/admin'
import { adminScope, LastAdminError, MemberBusyError } from '../lib/scope'

// Dropping every test database is slow on the shared Postgres under load; the default hook timeout is 5 seconds.
afterAll(dropAllTestDbs, 120_000)

/** Records every delete. A user that was never created answers 404, as ntfy does. */
function fakeNtfyAdmin(existing: string[] = []) {
  const users = new Set(existing)
  const deleted: string[] = []
  const admin: NtfyAdmin & { deleted: string[] } = {
    deleted,
    async addUser(username) {
      users.add(username)
    },
    async allow() {},
    async createToken() {
      return 'token'
    },
    async deleteUser(username) {
      deleted.push(username)
      if (!users.delete(username)) throw new NtfyAdminError(404)
    }
  }
  return admin
}

/** A member whose sign-in has ended, so nothing holds them. */
async function idleMember(db: Db, opts: Parameters<typeof seedMember>[1] = {}) {
  const seeded = await seedMember(db, opts)
  await db
    .update(signinSessions)
    .set({ state: 'ended', endedAt: new Date() })
    .where(eq(signinSessions.memberId, seeded.memberId))
  return seeded
}

test("admins list members without the members' data", async () => {
  const db = await createTestDb()
  await seedMember(db)
  const [m] = await adminScope(db).listMembers()
  expect(Object.keys(m!).sort()).toEqual(['createdAt', 'displayName', 'githubLogin', 'id', 'role', 'timeZone'])
})

test("admin results hold none of a member's content", async () => {
  const db = await createTestDb()
  const a = await seedMember(db, { githubLogin: 'rich-member' })
  const secrets = [
    'SEEDED-detail-value',
    'SEEDED-mention',
    'SEEDED-entry-name',
    'SEEDED-occurrence-name',
    'SEEDED-form-url',
    'SEEDED-artefact-path',
    'SEEDED-token-enc',
    'SEEDED-zoom-guest',
    'SEEDED-checkpoint',
    'SEEDED-ntfy-topic',
    'SEEDED-ai-key-enc',
    'SEEDED-device-name'
  ]
  await db.update(details).set({ value: secrets[0]! }).where(eq(details.memberId, a.memberId))
  await db.update(mentionNames).set({ name: secrets[1]! }).where(eq(mentionNames.memberId, a.memberId))
  await db.update(timetableEntries).set({ name: secrets[2]! }).where(eq(timetableEntries.memberId, a.memberId))
  await db.update(occurrences).set({ entryName: secrets[3]! }).where(eq(occurrences.memberId, a.memberId))
  await db
    .update(forms)
    .set({ url: `https://forms.example/${secrets[4]}` })
    .where(eq(forms.memberId, a.memberId))
  await db
    .update(artefacts)
    .set({ path: `${secrets[5]}.md` })
    .where(eq(artefacts.memberId, a.memberId))
  await db.update(connections).set({ tokenEnc: secrets[6]! }).where(eq(connections.memberId, a.memberId))
  await db.update(identities).set({ zoomGuestName: secrets[7]! }).where(eq(identities.memberId, a.memberId))
  await db.update(profiles).set({ latestCheckpoint: secrets[8]! }).where(eq(profiles.memberId, a.memberId))
  await db.update(members).set({ ntfyTopic: secrets[9]!, ntfyTokenEnc: secrets[9]! }).where(eq(members.id, a.memberId))
  await db.update(aiKeys).set({ dashscopeKeyEnc: secrets[10]! }).where(eq(aiKeys.memberId, a.memberId))
  await db.update(deviceTokens).set({ name: secrets[11]! }).where(eq(deviceTokens.memberId, a.memberId))

  const admin = adminScope(db)
  const listed = JSON.stringify(await admin.listMembers())
  expect(listed).toContain('rich-member')
  for (const secret of secrets) expect(listed).not.toContain(secret)
})

test("a member with a meeting in progress can't be removed", async () => {
  const db = await createTestDb()
  const a = await seedMember(db)
  await db.update(occurrences).set({ state: 'in_meeting' }).where(eq(occurrences.id, a.ids.occurrences))
  await expect(adminScope(db).removeMember(a.memberId, fakeNtfyAdmin())).rejects.toThrow(MemberBusyError)
})

test("a member whose sign-in session hasn't ended can't be removed", async () => {
  const db = await createTestDb()
  const a = await seedMember(db)
  await expect(adminScope(db).removeMember(a.memberId, fakeNtfyAdmin())).rejects.toThrow(MemberBusyError)
})

test('removing a member deletes their rows and their ntfy user', async () => {
  const db = await createTestDb()
  await seedMember(db, { role: 'admin' })
  const a = await idleMember(db)
  const ntfy = fakeNtfyAdmin()
  await adminScope(db).removeMember(a.memberId, ntfy)
  expect(ntfy.deleted).toEqual([ntfyUsername(a.memberId)])
  expect(await db.$count(occurrences, eq(occurrences.memberId, a.memberId))).toBe(0)
  expect(await db.$count(members, eq(members.id, a.memberId))).toBe(0)
})

test('removing a member also removes their Better Auth user and its GitHub token', async () => {
  const db = await createTestDb()
  await seedMember(db, { role: 'admin' })
  const linked = await seedLinkedMember(db, 'gho_seeded_token')
  await adminScope(db).removeMember(linked.memberId, fakeNtfyAdmin())
  expect(await db.$count(auth_user, eq(auth_user.id, linked.authUserId))).toBe(0)
  expect(await db.$count(auth_account, eq(auth_account.userId, linked.authUserId))).toBe(0)
})

test('a failing ntfy delete keeps the member, so the removal can be retried', async () => {
  const db = await createTestDb()
  await seedMember(db, { role: 'admin' })
  const a = await idleMember(db)
  const ntfy = fakeNtfyAdmin()
  ntfy.deleteUser = async () => {
    throw new NtfyAdminError(500)
  }
  await expect(adminScope(db).removeMember(a.memberId, ntfy)).rejects.toThrow(NtfyAdminError)
  expect(await db.$count(members, eq(members.id, a.memberId))).toBe(1)
})

test("the last admin can't be removed or demoted", async () => {
  const db = await createTestDb()
  const admin = await seedMember(db, { role: 'admin' })
  await expect(adminScope(db).removeMember(admin.memberId, fakeNtfyAdmin())).rejects.toThrow(LastAdminError)
  await expect(adminScope(db).setRole(admin.memberId, 'member')).rejects.toThrow(LastAdminError)
})

test('an admin can be demoted while another admin remains', async () => {
  const db = await createTestDb()
  const first = await seedMember(db, { role: 'admin' })
  const second = await seedMember(db, { role: 'admin' })
  await adminScope(db).setRole(first.memberId, 'member')
  const [row] = await db.select({ role: members.role }).from(members).where(eq(members.id, first.memberId))
  expect(row!.role).toBe('member')
  await expect(adminScope(db).setRole(second.memberId, 'member')).rejects.toThrow(LastAdminError)
})

test('addMember stores a lower-cased login and returns its id', async () => {
  const db = await createTestDb()
  const id = await adminScope(db).addMember({
    githubLogin: 'New-Member',
    displayName: 'New Member',
    timeZone: 'Asia/Kuala_Lumpur',
    role: 'member'
  })
  const [row] = await db.select().from(members).where(eq(members.id, id))
  expect(row!.githubLogin).toBe('new-member')
})

test('addMemberFor refuses a bad GitHub login without writing a row', async () => {
  const db = await createTestDb()
  const admin = adminScope(db)
  const bad = await addMemberFor(admin, {
    githubLogin: 'not a login',
    displayName: 'Nobody',
    timeZone: 'Asia/Kuala_Lumpur',
    role: 'member'
  })
  expect(bad.ok).toBe(false)
  expect(await db.$count(members)).toBe(0)
})

test('addMemberFor refuses a login that is already a member, in fixed words', async () => {
  const db = await createTestDb()
  const admin = adminScope(db)
  const input = { githubLogin: 'dup-member', displayName: 'Dup', timeZone: 'Asia/Kuala_Lumpur', role: 'member' }
  expect(await addMemberFor(admin, input)).toMatchObject({ ok: true })
  expect(await addMemberFor(admin, input)).toEqual({ ok: false, error: 'That GitHub login is already a member.' })
})

test('removeMemberFor reports a busy member as a message and keeps the row', async () => {
  const db = await createTestDb()
  const a = await seedMember(db)
  const result = await removeMemberFor(adminScope(db), a.memberId, fakeNtfyAdmin())
  expect(result).toEqual({ ok: false, error: 'This member has a meeting or a sign-in in progress.' })
  expect(await db.$count(members, eq(members.id, a.memberId))).toBe(1)
})

test('setRoleFor refuses to demote the last admin as a message', async () => {
  const db = await createTestDb()
  const admin = await seedMember(db, { role: 'admin' })
  expect(await setRoleFor(adminScope(db), admin.memberId, 'member')).toEqual({
    ok: false,
    error: 'The last admin cannot be removed or made a member.'
  })
})
