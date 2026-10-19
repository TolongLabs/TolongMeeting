import { afterAll, expect, test } from 'bun:test'
import { PgBoss } from 'pg-boss'
import { bossQueue, QUEUES } from '../db/queues'
import { createTestDb, dropAllTestDbs, testDbUrl } from '../db/testing'

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
