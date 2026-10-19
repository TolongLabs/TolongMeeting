import { afterAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { APIError } from 'better-auth/api'
import { dropAllTestDbs, createTestDb, seedAuthUser, seedMember } from '../db/testing'
import { members, type Db } from '../db'
import { authoriseSession, NOT_A_MEMBER } from '../lib/authorise'
import { GitHubTokenError, type GitHubApi } from '../lib/github'
import { authScope } from '../lib/scope'

afterAll(dropAllTestDbs)

const gh = (m: 'active' | 'pending' | 'none', user = { id: 42, login: 'Octo-Member' }): GitHubApi => ({
  user: async () => user,
  orgMembership: async () => m
})
const deps = (db: Db, m: 'active' | 'pending' | 'none', user?: { id: number; login: string }) => ({
  github: gh(m, user),
  auth: authScope(db),
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
  const auth = authScope(db)
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
  await expect(authoriseSession({ github, auth: authScope(db), org: 'tolonglabs' }, authUserId)).rejects.toThrow(
    'status 500'
  )
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
