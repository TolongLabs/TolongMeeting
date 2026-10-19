import { afterAll, expect, test } from 'bun:test'
import { format } from 'node:util'
import type { NtfyConfig } from '@tm/core'
import { pings, PingError } from '@tm/notify'
import { memberNotifier } from '../db/notifier'
import { createTestDb, dropAllTestDbs, seedMember, withNtfy } from '../db/testing'
import { expectNotLogged } from './no-log'

afterAll(async () => {
  await dropAllTestDbs()
})

const master = Buffer.alloc(32)
const url = 'https://ntfy.tm.example'

/** The lines `console.error` printed while `fn` ran. */
async function errorLines(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    lines.push(format(...args))
  }
  try {
    await fn()
  } finally {
    console.error = original
  }
  return lines
}

test('notify sends with the member topic and token and resolves true', async () => {
  const { db, memberId, topic } = await withNtfy('tk_test', master)
  const sent: NtfyConfig[] = []
  const sentOk = await memberNotifier(db, master, url, async (cfg) => {
    sent.push(cfg)
  }).notify(memberId, pings.notificationsTest())
  expect(sent).toEqual([{ url, topic, token: 'tk_test' }])
  expect(sentOk).toBe(true)
})

test("a failing ntfy doesn't throw, resolves false, logs only the error name and never the token", async () => {
  const { db, memberId } = await withNtfy('tk_test', master)
  const failing = memberNotifier(db, master, url, async () => {
    throw new PingError('ntfy responded 500 tk_test', 500)
  })
  let sentOk: boolean | undefined
  const lines = await errorLines(async () => {
    sentOk = await failing.notify(memberId, pings.notificationsTest())
  })
  expect(sentOk).toBe(false)
  expect(lines).toEqual(['ping failed: TolongMeeting test (PingError)'])
  await expectNotLogged('tk_test', () => failing.notify(memberId, pings.notificationsTest()))
})

test('a member with no ntfy topic resolves false and logs the named error, not a throw', async () => {
  const db = await createTestDb()
  const { memberId } = await seedMember(db, { full: false })
  let sentOk: boolean | undefined
  const lines = await errorLines(async () => {
    sentOk = await memberNotifier(db, master, url, async () => {
      throw new Error('should not send')
    }).notify(memberId, pings.notificationsTest())
  })
  expect(sentOk).toBe(false)
  expect(lines).toEqual(['ping failed: TolongMeeting test (NoNtfyTopicError)'])
})

test('an unknown member resolves false and logs NoSuchMemberError', async () => {
  const db = await createTestDb()
  let sentOk: boolean | undefined
  const lines = await errorLines(async () => {
    sentOk = await memberNotifier(db, master, url, async () => {
      throw new Error('should not send')
    }).notify(crypto.randomUUID(), pings.notificationsTest())
  })
  expect(sentOk).toBe(false)
  expect(lines).toEqual(['ping failed: TolongMeeting test (NoSuchMemberError)'])
})
