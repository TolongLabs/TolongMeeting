import { afterAll, expect, test } from 'bun:test'
import { openColumn } from '../db/secrets'
import { FakeNotifier } from '../db/notifier'
import { createTestDb, dropAllTestDbs, fakeFetch, seedMember } from '../db/testing'
import { ensureNtfy, ntfyAdmin, ntfyUsername, sendTestPing } from '../lib/ntfy-admin'
import { createScope } from '../lib/scope'
import { pings } from '@tm/notify'
import { expectNotLogged } from './no-log'

afterAll(async () => {
  await dropAllTestDbs()
})

const admin = (fetchFn: ReturnType<typeof fakeFetch>) => ntfyAdmin('https://ntfy.tm.example', 'tk_admin', fetchFn)

test('ensureNtfy creates a user, grants one topic and stores a sealed token, once', async () => {
  const db = await createTestDb()
  const { memberId } = await seedMember(db, { full: false })
  const fetchFn = fakeFetch({ '/v1/account/token': { token: 'tk_test' } })
  const scope = createScope(db, memberId)
  const { topic } = await ensureNtfy(scope, admin(fetchFn), Buffer.alloc(32))
  expect(topic).toMatch(/^tm-[a-z2-7]{24}$/)
  expect(fetchFn.calls).toEqual([
    'POST /v1/users Bearer',
    'PUT /v1/users/access Bearer',
    'POST /v1/account/token Basic'
  ])
  expect(fetchFn.bodies[0]).toEqual({ username: ntfyUsername(memberId), password: expect.any(String) })
  expect(fetchFn.bodies[1]).toEqual({ username: `tm-${memberId}`, topic, permission: 'read-write' })
  expect(fetchFn.bodies[2]).toEqual({ label: 'TolongMeeting', expires: 0 })
  const me = await scope.me()
  expect(openColumn(Buffer.alloc(32), memberId, 'members.ntfy_token', me.ntfyTokenEnc!)).toBe('tk_test')
  expect(me.ntfyTopic).toBe(topic)
  const again = await ensureNtfy(scope, admin(fetchFn), Buffer.alloc(32))
  expect(again.topic).toBe(topic)
  expect(fetchFn.calls).toHaveLength(3)
})

test('the ntfy password is never stored', async () => {
  const db = await createTestDb()
  const { memberId } = await seedMember(db, { full: false })
  const fetchFn = fakeFetch({ '/v1/account/token': { token: 'tk_test' } })
  const scope = createScope(db, memberId)
  await ensureNtfy(scope, admin(fetchFn), Buffer.alloc(32))
  const password = (fetchFn.bodies[0] as { password: string }).password
  expect(password).toMatch(/^[0-9a-f]{64}$/)
  expect(JSON.stringify(await scope.me())).not.toContain(password)
})

test('a failed ntfy call throws a fixed error, stores nothing and never carries the token', async () => {
  const db = await createTestDb()
  const { memberId } = await seedMember(db, { full: false })
  const fetchFn = fakeFetch({ '/v1/account/token': new Response('tk_test leaked', { status: 500 }) })
  const scope = createScope(db, memberId)
  let caught: unknown
  await expectNotLogged('tk_test', async () => {
    try {
      await ensureNtfy(scope, admin(fetchFn), Buffer.alloc(32))
    } catch (e) {
      caught = e
    }
  })
  expect(caught).toBeInstanceOf(Error)
  expect((caught as Error).name).toBe('NtfyAdminError')
  expect((caught as Error).message).toBe('ntfy admin request failed (HTTP 500)')
  expect((await scope.me()).ntfyTopic).toBeNull()
})

test('deleteUser sends the admin token and the username', async () => {
  const fetchFn = fakeFetch()
  await admin(fetchFn).deleteUser('tm-abc')
  expect(fetchFn.calls).toEqual(['DELETE /v1/users Bearer'])
  expect(fetchFn.bodies[0]).toEqual({ username: 'tm-abc' })
})

test('the test ping goes to the notifier for this member', async () => {
  const db = await createTestDb()
  const { memberId } = await seedMember(db, { full: false })
  const notifier = new FakeNotifier()
  await sendTestPing(createScope(db, memberId), notifier)
  expect(notifier.sent).toEqual([{ memberId, ping: pings.notificationsTest() }])
})
