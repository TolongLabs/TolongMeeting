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

test('notify sends with the member topic and token', async () => {
  const { db, memberId, topic } = await withNtfy('tk_test', master)
  const sent: NtfyConfig[] = []
  await memberNotifier(db, master, url, async (cfg) => {
    sent.push(cfg)
  }).notify(memberId, pings.notificationsTest())
  expect(sent).toEqual([{ url, topic, token: 'tk_test' }])
})

test("a failing ntfy doesn't throw, logs only the error name and never the token", async () => {
  const { db, memberId } = await withNtfy('tk_test', master)
  const failing = memberNotifier(db, master, url, async () => {
    throw new PingError('ntfy responded 500 tk_test', 500)
  })
  const lines = await errorLines(() => failing.notify(memberId, pings.notificationsTest()))
  expect(lines).toEqual(['ping failed: TolongMeeting test (PingError)'])
  await expectNotLogged('tk_test', () => failing.notify(memberId, pings.notificationsTest()))
})

test('a member with no ntfy topic is a logged failure, not a throw', async () => {
  const db = await createTestDb()
  const { memberId } = await seedMember(db, { full: false })
  const lines = await errorLines(() =>
    memberNotifier(db, master, url, async () => {
      throw new Error('should not send')
    }).notify(memberId, pings.notificationsTest())
  )
  expect(lines).toEqual(['ping failed: TolongMeeting test (Error)'])
})
