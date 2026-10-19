import type { PgBoss } from 'pg-boss'

export const QUEUES = {
  expand: 'expand',
  launch: 'launch',
  pipeline: 'pipeline',
  signinStart: 'signin-start',
  deleteOccurrence: 'delete-occurrence',
  retention: 'retention',
  backup: 'backup',
  orgCheck: 'org-check'
} as const

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]

/** The part of pg-boss that web and scheduler code uses to queue jobs, so tests can swap in `FakeQueue`. */
export interface Queue {
  send(
    name: QueueName,
    data: Record<string, unknown>,
    opts?: { startAfter?: Date; singletonKey?: string }
  ): Promise<string | null>
}

/** A `Queue` over a started pg-boss instance. The queue named in `send` must already exist (`boss.createQueue`). */
export function bossQueue(boss: PgBoss): Queue {
  return {
    send: (name, data, opts) => boss.send(name, data, opts ?? {})
  }
}
