import { afterAll, expect, test } from 'bun:test'
import { count } from 'drizzle-orm'
import { PgBoss } from 'pg-boss'
import { bossQueue, QUEUES, type Queue } from '../db/queues'
import { syncOccurrences } from '../db/occurrences'
import { createTestDb, dropAllTestDbs, testDbUrl, withEntry, type EntryShape } from '../db/testing'
import { occurrences } from '../db'

afterAll(dropAllTestDbs)

test('bossQueue queues a job with its data, and holds a job until its start time', async () => {
  const db = await createTestDb()
  const boss = new PgBoss(testDbUrl(db))
  boss.on('error', (error) => {
    throw error
  })
  await boss.start()
  try {
    await boss.createQueue(QUEUES.launch)
    const queue = bossQueue(boss)
    const data = { occurrenceId: 'o1', scheduledStart: '2026-10-21T06:00:00.000Z' }
    const first = await queue.send(QUEUES.launch, data, { startAfter: new Date(0), singletonKey: 'launch:o1' })
    expect(first).toEqual(expect.any(String))
    const later = await queue.send(
      QUEUES.launch,
      { occurrenceId: 'o2' },
      { startAfter: new Date(Date.now() + 3_600_000) }
    )
    expect(later).toEqual(expect.any(String))
    const jobs = await boss.fetch(QUEUES.launch, { batchSize: 10 })
    expect(jobs.map((j) => j.data)).toEqual([data])
  } finally {
    await boss.stop({ graceful: false })
  }
})

const WEDNESDAY_14: EntryShape = {
  repeat: { kind: 'weekly', days: [3], from: '2026-10-01' },
  startTime: '14:00',
  endTime: '16:00'
}
const now = new Date('2026-10-20T00:00:00Z')

async function withBoss<T>(url: string, run: (boss: PgBoss) => Promise<T>): Promise<T> {
  const boss = new PgBoss(url)
  boss.on('error', (error) => {
    throw error
  })
  await boss.start()
  try {
    await boss.createQueue(QUEUES.launch)
    return await run(boss)
  } finally {
    await boss.stop({ graceful: false })
  }
}

test('a sync that rolls back leaves no launch job, and a committed job is invisible until the commit', async () => {
  const { db } = await withEntry(WEDNESDAY_14)
  await withBoss(testDbUrl(db), async (boss) => {
    const real = bossQueue(boss)
    const queued = async () => (await boss.findJobs(QUEUES.launch)).length

    // The second send fails after the first insert, so the whole transaction (rows and the first job) rolls back.
    let sends = 0
    const failing: Queue = {
      async send(name, data, opts) {
        if (++sends === 2) throw new Error('queue down')
        const id = await real.send(name, data, opts)
        expect(await queued()).toBe(0) // not visible to another connection before the commit
        return id
      }
    }
    await expect(syncOccurrences(db, failing, now)).rejects.toThrow('queue down')
    expect(await queued()).toBe(0)
    expect((await db.select({ n: count() }).from(occurrences))[0]!.n).toBe(0)

    // A clean sync commits both occurrences and both jobs together; neither is visible until then.
    const seen: number[] = []
    const watching: Queue = {
      async send(name, data, opts) {
        const id = await real.send(name, data, opts)
        seen.push(await queued())
        return id
      }
    }
    expect(await syncOccurrences(db, watching, now)).toEqual({ created: 2, removed: 0 })
    expect(seen).toEqual([0, 0])
    const jobs = await boss.findJobs<{ scheduledStart: string }>(QUEUES.launch)
    expect(jobs.map((j) => j.data.scheduledStart).sort()).toEqual([
      '2026-10-21T06:00:00.000Z',
      '2026-10-28T06:00:00.000Z'
    ])
  })
})
