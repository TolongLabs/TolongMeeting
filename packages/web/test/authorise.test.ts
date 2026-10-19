import { afterAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { APIError } from 'better-auth/api'
import { dropAllTestDbs, createTestDb, seedAuthUser, seedMember, seedLinkedMember, TEST_MASTER } from '../db/testing'
import { auth_account, auth_session, auth_user, members, type Db } from '../db'
import { authoriseSession, NOT_A_MEMBER, NOT_A_MEMBER_CODE } from '../lib/authorise'
import { GitHubTokenError, type GitHubApi } from '../lib/github'
import { authScope } from '../lib/scope'

afterAll(dropAllTestDbs, 60_000)

const gh = (m: 'active' | 'pending' | 'none', user = { id: 42, login: 'Octo-Member' }): GitHubApi => ({
  user: async () => user,
  orgMembership: async () => m
})
const deps = (db: Db, m: 'active' | 'pending' | 'none', user?: { id: number; login: string }) => ({
  github: gh(m, user),
  auth: authScope(TEST_MASTER, db),
  org: 'tolonglabs'
})

test('an active organisation member added by an admin is allowed and linked', async () => {
  const db = await createTestDb()
  const { memberId } = await seedMember(db, { githubLogin: 'octo-member', full: false })
  const authUserId = await seedAuthUser(db, { githubToken: 'gho_test' })
  await authoriseSession(deps(db, 'active'), authUserId)
  const [m] = await db.select().from(members).where(eq(members.id, memberId))
  expect(m).toMatchObject({ githubId: 42, authUserId })
})

test('a pending membership is refused', async () => {
  const db = await createTestDb()
  await seedMember(db, { githubLogin: 'octo-member', full: false })
  const authUserId = await seedAuthUser(db, { githubToken: 'gho_test' })
  await expect(authoriseSession(deps(db, 'pending'), authUserId)).rejects.toThrow('Not an active TolongLabs member')
})

test('an organisation member nobody added is refused and gets no link', async () => {
  const db = await createTestDb()
  const { memberId } = await seedMember(db, { githubLogin: 'someone-else', full: false })
  const authUserId = await seedAuthUser(db, { githubToken: 'gho_test' })
  const refusal = await authoriseSession(deps(db, 'active'), authUserId).catch((e: unknown) => e)
  expect(refusal).toBeInstanceOf(APIError)
  expect((refusal as APIError).status).toBe('FORBIDDEN')
  expect((refusal as APIError).body?.message).toBe(NOT_A_MEMBER)
  // The code is what makes Better Auth redirect to `/sign-in?error=NOT_A_MEMBER` instead of showing a bare 403.
  expect((refusal as APIError).body?.code).toBe(NOT_A_MEMBER_CODE)
  const [m] = await db.select().from(members).where(eq(members.id, memberId))
  expect(m).toMatchObject({ githubId: null, authUserId: null })
})

test('a user whose organisation membership is "none" is refused', async () => {
  const db = await createTestDb()
  await seedMember(db, { githubLogin: 'octo-member', full: false })
  const authUserId = await seedAuthUser(db, { githubToken: 'gho_test' })
  await expect(authoriseSession(deps(db, 'none'), authUserId)).rejects.toThrow(NOT_A_MEMBER)
})

test('a revoked token and a missing token are refused, not crashed on', async () => {
  const db = await createTestDb()
  await seedMember(db, { githubLogin: 'octo-member', full: false })
  const revoked = await seedAuthUser(db, { githubToken: 'gho_revoked' })
  const none = await seedAuthUser(db)
  const github: GitHubApi = {
    user: async () => {
      throw new GitHubTokenError()
    },
    orgMembership: async () => 'active'
  }
  const auth = authScope(TEST_MASTER, db)
  await expect(authoriseSession({ github, auth, org: 'tolonglabs' }, revoked)).rejects.toThrow(NOT_A_MEMBER)
  await expect(authoriseSession(deps(db, 'active'), none)).rejects.toThrow(NOT_A_MEMBER)
})

test('a GitHub outage is not reported as a refusal', async () => {
  const db = await createTestDb()
  await seedMember(db, { githubLogin: 'octo-member', full: false })
  const authUserId = await seedAuthUser(db, { githubToken: 'gho_test' })
  const github: GitHubApi = {
    user: async () => {
      throw new Error('GitHub /user failed with status 500')
    },
    orgMembership: async () => 'active'
  }
  await expect(
    authoriseSession({ github, auth: authScope(TEST_MASTER, db), org: 'tolonglabs' }, authUserId)
  ).rejects.toThrow('status 500')
})

test('a renamed GitHub login still matches by id', async () => {
  const db = await createTestDb()
  const { memberId } = await seedMember(db, { githubLogin: 'old-name', full: false })
  await db.update(members).set({ githubId: 42 }).where(eq(members.id, memberId))
  const authUserId = await seedAuthUser(db, { githubToken: 'gho_test' })
  await expect(authoriseSession(deps(db, 'active', { id: 42, login: 'new-name' }), authUserId)).resolves.toBeUndefined()
})

test('a login that now belongs to another GitHub id does not match a member already tied to an id', async () => {
  const db = await createTestDb()
  const { memberId } = await seedMember(db, { githubLogin: 'octo-member', full: false })
  await db.update(members).set({ githubId: 7 }).where(eq(members.id, memberId))
  const authUserId = await seedAuthUser(db, { githubToken: 'gho_test' })
  await expect(authoriseSession(deps(db, 'active'), authUserId)).rejects.toThrow(NOT_A_MEMBER)
})

test('a refusal deletes the new auth user and its token when no member is linked', async () => {
  const db = await createTestDb()
  const authUserId = await seedAuthUser(db, { githubToken: 'gho_stranger' })
  await expect(authoriseSession(deps(db, 'active'), authUserId)).rejects.toThrow(NOT_A_MEMBER)
  expect(await db.$count(auth_user, eq(auth_user.id, authUserId))).toBe(0)
  expect(await db.$count(auth_account, eq(auth_account.userId, authUserId))).toBe(0)
})

test('a refusal for a linked member who left the organisation ends their sessions and keeps the member', async () => {
  const db = await createTestDb()
  const { memberId, authUserId } = await seedLinkedMember(db, 'gho_left')
  await expect(authoriseSession(deps(db, 'none'), authUserId)).rejects.toThrow(NOT_A_MEMBER)
  expect(await db.$count(auth_session, eq(auth_session.userId, authUserId))).toBe(0)
  expect(await db.$count(auth_user, eq(auth_user.id, authUserId))).toBe(1)
  const [m] = await db.select().from(members).where(eq(members.id, memberId))
  expect(m!.authUserId).toBe(authUserId)
})

test('a GitHub outage deletes an unlinked auth user but leaves a linked member signed in', async () => {
  const db = await createTestDb()
  const stranger = await seedAuthUser(db, { githubToken: 'gho_stranger' })
  const linked = await seedLinkedMember(db, 'gho_linked')
  const github: GitHubApi = {
    user: async () => {
      throw new Error('GitHub /user failed with status 500')
    },
    orgMembership: async () => 'active'
  }
  const outage = { github, auth: authScope(TEST_MASTER, db), org: 'tolonglabs' }
  await expect(authoriseSession(outage, stranger)).rejects.toThrow('status 500')
  await expect(authoriseSession(outage, linked.authUserId)).rejects.toThrow('status 500')
  expect(await db.$count(auth_user, eq(auth_user.id, stranger))).toBe(0)
  expect(await db.$count(auth_session, eq(auth_session.userId, linked.authUserId))).toBe(1)
})

test('the stored GitHub token is sealed, opens under the same master key and fails under another', async () => {
  const db = await createTestDb()
  const authUserId = await seedAuthUser(db, { githubToken: 'gho_sealed' })
  const [row] = await db.select().from(auth_account).where(eq(auth_account.userId, authUserId))
  expect(row!.accessToken).not.toContain('gho_sealed')
  expect(await authScope(TEST_MASTER, db).githubToken(authUserId)).toBe('gho_sealed')
  await expect(authScope(Buffer.alloc(32, 1), db).githubToken(authUserId)).rejects.toThrow()
})
