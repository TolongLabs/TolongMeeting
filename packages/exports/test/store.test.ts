import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { exports as exportsTable, occurrences, type Db } from '@tm/web/db'
import { createTestDb, dropAllTestDbs, seedMember } from '@tm/web/db/testing'
import { memberExports } from '@tm/web/db/exports'
import { createScope } from '@tm/web/lib/scope'
import type { RunnerStore } from '../src'
import { runnerStore } from '../src/store'

let db: Db
let runner: RunnerStore
let m1: string
let o1: string
let o2: string

beforeAll(async () => {
  db = await createTestDb()
  runner = runnerStore(db)
  const seeded = await seedMember(db)
  m1 = seeded.memberId
  o1 = seeded.ids.occurrences
  // A second occurrence, in state 'deleted'.
  const [first] = await db.select().from(occurrences).where(eq(occurrences.id, o1))
  const { id: _id, ...rest } = first!
  const [second] = await db
    .insert(occurrences)
    .values({
      ...rest,
      scheduledStart: new Date('2026-10-22T06:00:00Z'),
      scheduledEnd: new Date('2026-10-22T08:00:00Z')
    })
    .returning()
  o2 = second!.id
  await db.update(occurrences).set({ state: 'deleted' }).where(eq(occurrences.id, o2))
})
afterAll(() => dropAllTestDbs(), 60_000)
beforeEach(async () => {
  await db.delete(exportsTable)
})

const queue = (occurrenceId: string, target: 'zip' | 'pdf' | 'github') => {
  const created = memberExports(createScope(db, m1)).create(occurrenceId, target)
  return created.then((r) => {
    if (!r.ok) throw new Error(r.message)
    return r.row
  })
}

describe('runner store', () => {
  test('claimNext takes the oldest queued export and marks it running', async () => {
    const a = await queue(o1, 'zip')
    await queue(o1, 'pdf')
    expect(await runner.claimNext()).toMatchObject({ id: a.id, status: 'running' })
    expect((await runner.claimNext())?.target).toBe('pdf')
    expect(await runner.claimNext()).toBeNull()
  })

  test('two runners never claim the same export', async () => {
    await queue(o1, 'zip')
    await queue(o1, 'pdf')
    const claimed = await Promise.all([runner.claimNext(), runner.claimNext()])
    expect(new Set(claimed.map((r) => r!.id)).size).toBe(2)
  })

  test('succeed records the result and frees the slot', async () => {
    const a = await queue(o1, 'zip')
    await runner.claimNext()
    await runner.succeed(a.id, '2026-10-20 1400 Data Mining', { url: null, filePath: 'exports/x.zip', note: null })
    const [row] = await db.select().from(exportsTable).where(eq(exportsTable.id, a.id))
    expect(row).toMatchObject({ status: 'succeeded', title: '2026-10-20 1400 Data Mining', filePath: 'exports/x.zip' })
    expect(row!.finishedAt).toBeInstanceOf(Date)
    expect((await queue(o1, 'zip')).status).toBe('queued')
  })

  test('succeed refuses an export that is not running', async () => {
    const a = await queue(o1, 'zip')
    await expect(runner.succeed(a.id, 't', { url: null, filePath: null, note: null })).rejects.toThrow('not running')
  })

  test('fail stores the code and a message with secrets removed', async () => {
    const a = await queue(o1, 'github')
    await runner.claimNext()
    await runner.fail(a.id, 'failed', 'GitHub said no to Bearer abc123def and https://u:pw@github.com/x')
    const [row] = await db.select().from(exportsTable).where(eq(exportsTable.id, a.id))
    expect(row).toMatchObject({
      status: 'failed',
      errorCode: 'failed',
      error: 'GitHub said no to Bearer [redacted] and [redacted]'
    })
    await expect(runner.fail(a.id, 'failed', 'again')).rejects.toThrow('not queued or running')
  })

  test('fail also removes the tokens of the opened connection', async () => {
    const a = await queue(o1, 'github')
    await runner.claimNext()
    await runner.fail(a.id, 'failed', 'GitHub echoed my-odd-token-value in the body', ['my-odd-token-value', 'short'])
    const [row] = await db.select().from(exportsTable).where(eq(exportsTable.id, a.id))
    expect(row!.error).toBe('GitHub echoed [redacted] in the body')
  })

  test('failInterrupted fails running exports and returns them', async () => {
    await queue(o1, 'zip')
    await queue(o1, 'pdf')
    await runner.claimNext()
    const failed = await runner.failInterrupted()
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({
      status: 'failed',
      errorCode: 'interrupted',
      error: 'The export was interrupted. Try again.'
    })
    expect(await db.$count(exportsTable, eq(exportsTable.status, 'queued'))).toBe(1)
  })

  test('purgeDeleted removes only the exports of deleted occurrences', async () => {
    await queue(o1, 'zip')
    await db.insert(exportsTable).values({ occurrenceId: o2, memberId: m1, target: 'zip' })
    expect(await runner.purgeDeleted()).toBe(1)
    expect(await db.$count(exportsTable)).toBe(1)
    expect(await runner.purgeDeleted()).toBe(0)
  })
})
