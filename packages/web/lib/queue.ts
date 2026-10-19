import { PgBoss } from 'pg-boss'
import { bossQueue, type Queue } from '../db/queues'

const globalForQueue = globalThis as typeof globalThis & { __tmQueue?: { url: string; queue: Promise<Queue> } }

/**
 * The process-wide queue on `DATABASE_URL`: a send-only pg-boss, with no supervision and no scheduling, so the web
 * process never runs jobs. The queues it sends to are created by the scheduler. A failed start is not cached.
 */
export function getQueue(): Promise<Queue> {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  if (globalForQueue.__tmQueue?.url !== url) {
    const queue = startQueue(url)
    queue.catch(() => {
      if (globalForQueue.__tmQueue?.queue === queue) globalForQueue.__tmQueue = undefined
    })
    globalForQueue.__tmQueue = { url, queue }
  }
  return globalForQueue.__tmQueue.queue
}

async function startQueue(url: string): Promise<Queue> {
  const boss = new PgBoss({ connectionString: url, supervise: false, schedule: false })
  // Only the error's name is logged: a message can quote a connection string.
  boss.on('error', (e) => console.error(`queue error: ${e.name}`))
  await boss.start()
  return bossQueue(boss)
}
