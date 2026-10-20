import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_LIST_ITEMS, type CompanionEvent } from '@tm/core'
import { eq } from 'drizzle-orm'
import { CompanionApi } from '../../companion/src/api'
import { startCommandStream } from '../../companion/src/sse'
import { StateStore } from '../../companion/src/state'
import { deviceTokens, type Db } from '../db'
import { emitCompanionEvent } from '../db/companion'
import { seedCompanionFixture } from '../db/companion.fixtures'
import { createTestDb, dropAllTestDbs } from '../db/testing'
import { withDevice } from '../lib/companion/scope'
import { companionEventStream, formatSse, handleEventsRequest, MAX_QUEUED_BYTES } from '../lib/companion/sse'
import { newDeviceToken } from '../lib/companion/tokens'

let db: Db
let fx: Awaited<ReturnType<typeof seedCompanionFixture>>
let server: ReturnType<typeof Bun.serve>
let base: string
const tokens = {} as Record<'a1' | 'a2' | 'b1', string>
const dirs: string[] = []

// Short timings so a test sees polls, keepalives and the revoke check within milliseconds.
const FAST = { pollMs: 10, keepAliveMs: 150, recheckMs: 40 }

beforeAll(async () => {
  db = await createTestDb()
  fx = await seedCompanionFixture(db)
  for (const key of ['a1', 'a2', 'b1'] as const) {
    const { token, hash } = newDeviceToken()
    await db.update(deviceTokens).set({ tokenHash: hash }).where(eq(deviceTokens.id, fx[key].deviceId))
    tokens[key] = token
  }
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    fetch: withDevice(
      async (request, scope) => handleEventsRequest(request, scope, FAST),
      () => ({ db })
    )
  })
  base = `http://127.0.0.1:${server.port}`
}, 60_000)

afterAll(async () => {
  await server?.stop(true)
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  await dropAllTestDbs()
}, 60_000)

const job = (n: number) => ({ type: 'job_available' as const, jobId: `j${n}` })

function connect(token: string, lastEventId?: number): Promise<Response> {
  const ac = new AbortController()
  cleanups.push(() => ac.abort())
  return fetch(`${base}/api/companion/events`, {
    headers: {
      authorization: `Bearer ${token}`,
      ...(lastEventId === undefined ? {} : { 'last-event-id': String(lastEventId) })
    },
    signal: ac.signal
  })
}
const cleanups: (() => void)[] = []
afterAll(() => cleanups.forEach((c) => c()))

/** Reads the body until `text` appeared in what was read so far (or the stream ends or the wait runs out). */
async function readUntil(
  res: Response,
  done: (text: string) => boolean,
  ms = 3000
): Promise<{ text: string; ended: boolean }> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const end = Date.now() + ms
  try {
    while (!done(text)) {
      const left = end - Date.now()
      if (left <= 0) return { text, ended: false }
      const next = await Promise.race([reader.read(), Bun.sleep(left).then(() => null)])
      if (next === null) return { text, ended: false }
      if (next.done) return { text, ended: true }
      text += decoder.decode(next.value, { stream: true })
    }
    return { text, ended: false }
  } finally {
    reader.releaseLock()
  }
}

describe('formatSse', () => {
  test('writes id, event and data lines', () => {
    expect(formatSse({ id: 7, command: { type: 'job_available', jobId: 'j1' } })).toBe(
      'id: 7\nevent: job_available\ndata: {"type":"job_available","jobId":"j1"}\n\n'
    )
  })
})

describe('the event stream under Bun.serve', () => {
  test('is an event stream with the headers a proxy needs, and replays after Last-Event-ID, then sends new events', async () => {
    const e1 = await emitCompanionEvent(db, fx.a1.memberId, job(1))
    const e2 = await emitCompanionEvent(db, fx.a1.memberId, job(2))
    const res = await connect(tokens.a1, e1)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-accel-buffering')).toBe('no')
    const e3Promise = Bun.sleep(60).then(() => emitCompanionEvent(db, fx.a1.memberId, job(3)))
    const e3 = await e3Promise
    const { text } = await readUntil(res, (t) => t.includes(`id: ${e3}\n`))
    expect(text).not.toContain(`id: ${e1}\n`)
    expect(text).toContain(`id: ${e2}\nevent: job_available\ndata: {"type":"job_available","jobId":"j2"}\n\n`)
    expect(text).toContain(`id: ${e3}\n`)
  })

  test("sends only this device's events: its own and its member's broadcasts, never another member's or device's", async () => {
    const own = await emitCompanionEvent(db, fx.a1.memberId, job(10), fx.a1.deviceId)
    const broadcast = await emitCompanionEvent(db, fx.a1.memberId, job(11))
    const sibling = await emitCompanionEvent(db, fx.a2.memberId, job(12), fx.a2.deviceId)
    const other = await emitCompanionEvent(db, fx.b1.memberId, job(13))
    const last = await emitCompanionEvent(db, fx.a1.memberId, job(14))
    const res = await connect(tokens.a1, own - 1)
    const { text } = await readUntil(res, (t) => t.includes(`id: ${last}\n`))
    expect(text).toContain(`id: ${own}\n`)
    expect(text).toContain(`id: ${broadcast}\n`)
    expect(text).not.toContain(`id: ${sibling}\n`)
    expect(text).not.toContain(`id: ${other}\n`)
    expect(text).not.toContain('j12')
    expect(text).not.toContain('j13')
  })

  test('a reconnect with the last id seen gets exactly the events it missed', async () => {
    const before = await emitCompanionEvent(db, fx.a2.memberId, job(20))
    const first = await connect(tokens.a2, before - 1)
    const seen = await readUntil(first, (t) => t.includes(`id: ${before}\n`))
    expect(seen.text).toContain(`id: ${before}\n`)
    await first.body!.cancel()
    const missed = await emitCompanionEvent(db, fx.a2.memberId, job(21))
    const second = await connect(tokens.a2, before)
    const { text } = await readUntil(second, (t) => t.includes(`id: ${missed}\n`))
    expect(text).not.toContain(`id: ${before}\n`)
    expect(text).toContain(`id: ${missed}\n`)
  })

  test('sends keepalive comments and keeps last_used_at fresh', async () => {
    const stale = new Date(Date.now() - 3_600_000)
    await db.update(deviceTokens).set({ lastUsedAt: stale }).where(eq(deviceTokens.id, fx.b1.deviceId))
    const res = await connect(tokens.b1)
    const { text } = await readUntil(res, (t) => t.includes(': keepalive\n\n'))
    expect(text).toContain(': keepalive\n\n')
    const [row] = await db.select().from(deviceTokens).where(eq(deviceTokens.id, fx.b1.deviceId))
    expect(row!.lastUsedAt!.getTime()).toBeGreaterThan(stale.getTime() + 60_000)
  })

  test('closes the stream when the token is revoked mid-stream, and refuses the next connect', async () => {
    const { token, hash } = newDeviceToken()
    await db.update(deviceTokens).set({ tokenHash: hash }).where(eq(deviceTokens.id, fx.a2.deviceId))
    const res = await connect(token)
    const reading = readUntil(res, () => false, 3000)
    await Bun.sleep(100)
    await db.update(deviceTokens).set({ revokedAt: new Date() }).where(eq(deviceTokens.id, fx.a2.deviceId))
    const { ended } = await reading
    expect(ended).toBe(true)
    const again = await connect(token)
    expect(again.status).toBe(401)
    expect(await again.json()).toEqual({ error: 'device_revoked_or_unknown' })
  })

  test('a second stream from the same device ends the first', async () => {
    const first = await connect(tokens.a1)
    const reading = readUntil(first, () => false, 3000)
    await Bun.sleep(50)
    const second = await connect(tokens.a1)
    expect((await reading).ended).toBe(true)
    await second.body!.cancel()
  })

  test('a bad Last-Event-ID is a fixed 400 and a missing token a 401', async () => {
    for (const bad of ['abc', '-1', '1.5', '9'.repeat(40)]) {
      const res = await fetch(`${base}/api/companion/events`, {
        headers: { authorization: `Bearer ${tokens.a1}`, 'last-event-id': bad }
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_last_event_id' })
    }
    expect((await fetch(`${base}/api/companion/events`)).status).toBe(401)
  })
})

describe('the real companion client against the route', () => {
  test('follows the stream, resumes by id, and reports a revoked token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tm-sse-client-'))
    dirs.push(dir)
    const { token, hash } = newDeviceToken()
    await db.update(deviceTokens).set({ tokenHash: hash }).where(eq(deviceTokens.id, fx.b1.deviceId))
    const state = new StateStore(join(dir, 'state.json'))
    // Start after what earlier tests emitted for this member.
    await state.update({ lastEventId: await emitCompanionEvent(db, fx.b1.memberId, job(29)) })
    let revoked = 0
    const api = new CompanionApi({ serverUrl: base, token: async () => token, onRevoked: () => revoked++ })
    const got: CompanionEvent[] = []
    const errors: string[] = []
    let revokedSeen = false
    const stream = startCommandStream({
      api,
      state,
      onEvent: (e) => void got.push(e),
      onStatus: () => {},
      onError: (e) => void errors.push(e.message),
      onRevoked: () => void (revokedSeen = true),
      stallMs: 5000,
      delayMs: () => 20
    })
    const waitFor = async (check: () => boolean) => {
      const end = Date.now() + 5000
      while (!check()) {
        if (Date.now() > end) throw new Error(`timed out; errors: ${errors.join('; ')}`)
        await Bun.sleep(10)
      }
    }
    try {
      const a = await emitCompanionEvent(db, fx.b1.memberId, job(30))
      const b = await emitCompanionEvent(db, fx.b1.memberId, { type: 'local_identities_changed' })
      await waitFor(() => got.length === 2)
      expect(got).toEqual([
        { id: a, command: job(30) },
        { id: b, command: { type: 'local_identities_changed' } }
      ])
      const c = await emitCompanionEvent(db, fx.b1.memberId, job(31))
      await waitFor(() => got.length === 3)
      expect(got[2]).toEqual({ id: c, command: job(31) })
      expect(state.get().lastEventId).toBe(c)
      expect(errors).toEqual([])

      await db.update(deviceTokens).set({ revokedAt: new Date() }).where(eq(deviceTokens.id, fx.b1.deviceId))
      await waitFor(() => revokedSeen)
      expect(revoked).toBe(1)
      expect(got).toHaveLength(3)
    } finally {
      stream.stop()
    }
  })
})

describe('companionEventStream', () => {
  test('stops feeding a client that does not read, so the queue stays bounded', async () => {
    let calls = 0
    let next = 1
    const scope = {
      listEvents: async (): Promise<CompanionEvent[]> => {
        calls++
        return Array.from({ length: MAX_LIST_ITEMS }, () => ({ id: next++, command: job(next) }))
      },
      touch: async () => true
    }
    const ac = new AbortController()
    companionEventStream(scope, 0, ac.signal, { pollMs: 1, keepAliveMs: 1000, recheckMs: 1000 })
    await Bun.sleep(150)
    ac.abort()
    const perPage = MAX_LIST_ITEMS * formatSse({ id: 1000, command: job(1000) }).length
    expect(calls).toBeLessThanOrEqual(Math.ceil(MAX_QUEUED_BYTES / perPage) + 2)
    expect(calls).toBeGreaterThan(0)
  })

  test('ends with an error when the database fails, instead of going quiet', async () => {
    const scope = {
      listEvents: async (): Promise<CompanionEvent[]> => {
        throw new Error('boom')
      },
      touch: async () => true
    }
    const res = new Response(companionEventStream(scope, 0, new AbortController().signal, FAST))
    await expect(res.text()).rejects.toThrow('boom')
  })
})
