import { afterAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { schema } from '@tm/web/db'
import { createTestDb, dropAllTestDbs, seedLinkedMember } from '@tm/web/db/testing'
import { GitHubTokenError, type GitHubApi } from '@tm/web/lib/github'
import { authScope } from '@tm/web/lib/scope'
import { checkMemberships } from '../src/org-check'

afterAll(dropAllTestDbs)

const { auth_session: authSession, members } = schema

test('the daily check ends the sessions of members who left or revoked the app', async () => {
  const db = await createTestDb()
  const left = await seedLinkedMember(db, 'gho_left')
  const revoked = await seedLinkedMember(db, 'gho_revoked')
  const stays = await seedLinkedMember(db, 'gho_stays')
  const github: GitHubApi = {
    user: async (t) => {
      if (t === 'gho_revoked') throw new GitHubTokenError()
      return { id: 1, login: 'x' }
    },
    orgMembership: async (t) => (t === 'gho_left' ? 'none' : 'active')
  }
  const { ended } = await checkMemberships({ github, auth: authScope(db), org: 'tolonglabs' })
  expect(ended.sort()).toEqual([left.memberId, revoked.memberId].sort())
  expect(await db.$count(authSession, eq(authSession.userId, stays.authUserId))).toBe(1)
  expect(await db.$count(authSession, eq(authSession.userId, left.authUserId))).toBe(0)
  expect(await db.$count(authSession, eq(authSession.userId, revoked.authUserId))).toBe(0)
  // The member rows stay: only access ends, nothing is deleted.
  expect(await db.$count(members)).toBe(3)
})

test('a second run has nothing left to end', async () => {
  const db = await createTestDb()
  await seedLinkedMember(db, 'gho_left')
  const github: GitHubApi = { user: async () => ({ id: 1, login: 'x' }), orgMembership: async () => 'none' }
  const deps = { github, auth: authScope(db), org: 'tolonglabs' }
  expect((await checkMemberships(deps)).ended).toHaveLength(1)
  expect(await checkMemberships(deps)).toEqual({ ended: [] })
})

test('a GitHub outage for one member is raised after the others were still checked', async () => {
  const db = await createTestDb()
  const broken = await seedLinkedMember(db, 'gho_broken')
  const left = await seedLinkedMember(db, 'gho_left')
  const github: GitHubApi = {
    user: async (t) => {
      if (t === 'gho_broken') throw new Error('GitHub /user failed with status 500')
      return { id: 1, login: 'x' }
    },
    orgMembership: async () => 'none'
  }
  await expect(checkMemberships({ github, auth: authScope(db), org: 'tolonglabs' })).rejects.toThrow('1 member')
  expect(await db.$count(authSession, eq(authSession.userId, left.authUserId))).toBe(0)
  expect(await db.$count(authSession, eq(authSession.userId, broken.authUserId))).toBe(1)
})
