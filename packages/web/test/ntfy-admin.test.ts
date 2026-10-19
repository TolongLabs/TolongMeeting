import { afterAll, expect, test } from 'bun:test'
import { openColumn } from '../db/secrets'
import { FakeNotifier, type Notifier } from '../db/notifier'
import { createTestDb, dropAllTestDbs, fakeFetch, seedMember, withNtfy } from '../db/testing'
import { ensureNtfy, ntfyAdmin, ntfyUsername, sendTestPing, type FetchFn } from '../lib/ntfy-admin'
import { createScope } from '../lib/scope'
import { pings } from '@tm/notify'
import { expectNotLogged } from './no-log'

afterAll(async () => {
  await dropAllTestDbs()
})

const master = Buffer.alloc(32)
const admin = (fetchFn: FetchFn) => ntfyAdmin('https://ntfy.tm.example', 'tk_admin', fetchFn)

/**
 * Records each call like `fakeFetch` and answers with `answer(key, n)`, where `key` is `METHOD path` and `n` counts the
 * earlier calls with that key. Answers default to a 200 with `{}`.
 */
function recordingFetch(answer: (key: string, n: number) => Response | undefined) {
  const calls: string[] = []
  const inits: RequestInit[] = []
  const bodies: unknown[] = []
  const fetchFn: FetchFn = async (input, init) => {
    const url = new URL(input)
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}`
    const auth = new Headers(init?.headers).get('authorization')
    const n = calls.filter((c) => c.startsWith(`${key} `)).length
    calls.push(`${key} ${auth ? auth.split(' ')[0] : 'none'}`)
    inits.push(init ?? {})
    bodies.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)))
    return (
      answer(key, n) ?? (key === 'POST /v1/account/token' ? Response.json({ token: 'tk_test' }) : Response.json({}))
    )
  }
  return Object.assign(fetchFn, { calls, inits, bodies })
}

test('ensureNtfy creates a user, grants one topic and stores a sealed token, once', async () => {
  const db = await createTestDb()
  const { memberId } = await seedMember(db, { full: false })
  const fetchFn = fakeFetch({ '/v1/account/token': { token: 'tk_test' } })
  const scope = createScope(db, memberId)
  const { topic } = await ensureNtfy(db, scope, admin(fetchFn), master)
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
  expect(openColumn(master, memberId, 'members.ntfy_token', me.ntfyTokenEnc!)).toBe('tk_test')
  expect(me.ntfyTopic).toBe(topic)
  const again = await ensureNtfy(db, scope, admin(fetchFn), master)
  expect(again.topic).toBe(topic)
  expect(fetchFn.calls).toHaveLength(3)
})

test('a member who already has a topic and token gets it back with no ntfy call', async () => {
  const { db, memberId, topic } = await withNtfy('tk_test', master)
  const fetchFn = fakeFetch()
  const got = await ensureNtfy(db, createScope(db, memberId), admin(fetchFn), master)
  expect(got).toEqual({ topic })
  expect(fetchFn.calls).toEqual([])
})

test('concurrent calls for one member provision once, under the advisory lock', async () => {
  const db = await createTestDb()
  const { memberId } = await seedMember(db, { full: false })
  const fetchFn = fakeFetch({ '/v1/account/token': { token: 'tk_test' } })
  const scope = createScope(db, memberId)
  const [first, second] = await Promise.all([
    ensureNtfy(db, scope, admin(fetchFn), master),
    ensureNtfy(db, scope, admin(fetchFn), master)
  ])
  expect(second.topic).toBe(first.topic)
  expect(fetchFn.calls.filter((c) => c === 'POST /v1/users Bearer')).toHaveLength(1)
  expect(fetchFn.calls).toHaveLength(3)
})

test('the ntfy password is never stored', async () => {
  const db = await createTestDb()
  const { memberId } = await seedMember(db, { full: false })
  const fetchFn = fakeFetch({ '/v1/account/token': { token: 'tk_test' } })
  const scope = createScope(db, memberId)
  await ensureNtfy(db, scope, admin(fetchFn), master)
  const password = (fetchFn.bodies[0] as { password: string }).password
  expect(password).toMatch(/^[0-9a-f]{64}$/)
  expect(JSON.stringify(await scope.me())).not.toContain(password)
})

test('a failed token call deletes the new user, throws the original error, stores nothing and never carries the token', async () => {
  const db = await createTestDb()
  const { memberId } = await seedMember(db, { full: false })
  const fetchFn = recordingFetch((key, n) =>
    key === 'POST /v1/account/token' && n === 0 ? new Response('tk_test leaked', { status: 500 }) : undefined
  )
  const scope = createScope(db, memberId)
  let caught: unknown
  await expectNotLogged('tk_test', async () => {
    try {
      await ensureNtfy(db, scope, admin(fetchFn), master)
    } catch (e) {
      caught = e
    }
  })
  expect(caught).toBeInstanceOf(Error)
  expect((caught as Error).name).toBe('NtfyAdminError')
  expect((caught as Error).message).toBe('ntfy admin request failed (HTTP 500)')
  expect(fetchFn.calls).toEqual([
    'POST /v1/users Bearer',
    'PUT /v1/users/access Bearer',
    'POST /v1/account/token Basic',
    'DELETE /v1/users Bearer'
  ])
  expect((await scope.me()).ntfyTopic).toBeNull()
})

test('after a failed token call the next ensureNtfy succeeds', async () => {
  const db = await createTestDb()
  const { memberId } = await seedMember(db, { full: false })
  const fetchFn = recordingFetch((key, n) =>
    key === 'POST /v1/account/token' && n === 0 ? new Response('no', { status: 500 }) : undefined
  )
  const scope = createScope(db, memberId)
  await expect(ensureNtfy(db, scope, admin(fetchFn), master)).rejects.toThrow('ntfy admin request failed (HTTP 500)')
  const { topic } = await ensureNtfy(db, scope, admin(fetchFn), master)
  expect(topic).toMatch(/^tm-[a-z2-7]{24}$/)
  expect((await scope.me()).ntfyTopic).toBe(topic)
  expect(fetchFn.calls.slice(4)).toEqual([
    'POST /v1/users Bearer',
    'PUT /v1/users/access Bearer',
    'POST /v1/account/token Basic'
  ])
})

test('a user left behind without a stored token is replaced, then provisioned', async () => {
  const db = await createTestDb()
  const { memberId } = await seedMember(db, { full: false })
  const fetchFn = recordingFetch((key, n) =>
    key === 'POST /v1/users' && n === 0 ? new Response('', { status: 409 }) : undefined
  )
  const scope = createScope(db, memberId)
  const { topic } = await ensureNtfy(db, scope, admin(fetchFn), master)
  expect(fetchFn.calls).toEqual([
    'POST /v1/users Bearer',
    'DELETE /v1/users Bearer',
    'POST /v1/users Bearer',
    'PUT /v1/users/access Bearer',
    'POST /v1/account/token Basic'
  ])
  expect((await scope.me()).ntfyTopic).toBe(topic)
})

test('a non-JSON token reply throws a fixed error without echoing the reply', async () => {
  const db = await createTestDb()
  const { memberId } = await seedMember(db, { full: false })
  const fetchFn = recordingFetch((key) =>
    key === 'POST /v1/account/token' ? new Response('tk_test {', { status: 200 }) : undefined
  )
  const scope = createScope(db, memberId)
  let caught: unknown
  await expectNotLogged('tk_test', async () => {
    try {
      await ensureNtfy(db, scope, admin(fetchFn), master)
    } catch (e) {
      caught = e
    }
  })
  expect((caught as Error).name).toBe('NtfyAdminError')
  expect((caught as Error).message).toBe('ntfy admin reply was not JSON (HTTP 200)')
})

test('admin calls never follow a redirect, so the admin token is not replayed', async () => {
  const fetchFn = recordingFetch(() => undefined)
  await admin(fetchFn).deleteUser('tm-abc')
  expect(fetchFn.inits[0]!.redirect).toBe('error')
})

test('deleteUser sends the admin token and the username', async () => {
  const fetchFn = fakeFetch()
  await admin(fetchFn).deleteUser('tm-abc')
  expect(fetchFn.calls).toEqual(['DELETE /v1/users Bearer'])
  expect(fetchFn.bodies[0]).toEqual({ username: 'tm-abc' })
})

test('the test ping goes to the notifier for this member and resolves its result', async () => {
  const db = await createTestDb()
  const { memberId } = await seedMember(db, { full: false })
  const notifier = new FakeNotifier()
  expect(await sendTestPing(createScope(db, memberId), notifier)).toBe(true)
  expect(notifier.sent).toEqual([{ memberId, ping: pings.notificationsTest() }])
})

test('the test ping resolves false when the notifier could not send', async () => {
  const db = await createTestDb()
  const { memberId } = await seedMember(db, { full: false })
  const failing: Notifier = { notify: async () => false }
  expect(await sendTestPing(createScope(db, memberId), failing)).toBe(false)
})
