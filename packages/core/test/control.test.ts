import { expect, test } from 'bun:test'
import type { HeartbeatReply } from '../src/types'
import {
  ControlCommandSchema,
  HeartbeatReplySchema,
  HeartbeatReplyShapeSchema,
  MAX_HEARTBEAT_EVENTS
} from '../src/control'

test('a reply holds only commands the worker knows', () => {
  const good: HeartbeatReply = {
    ackedEvents: 2,
    commands: ['leave_now', 'take_over', 'pause_for_signin', 'resume_after_signin', 'stop'],
    link: null
  }
  expect(HeartbeatReplySchema.parse(good)).toEqual(good)
  expect(HeartbeatReplySchema.safeParse({ ...good, commands: ['dance'] }).success).toBe(false)
  expect(ControlCommandSchema.safeParse('leave').success).toBe(false)
})

test('a reply is bounded and its link is a string or null', () => {
  const base = { ackedEvents: 0, commands: [], link: 'https://zoom.us/j/1' }
  expect(HeartbeatReplySchema.safeParse(base).success).toBe(true)
  expect(HeartbeatReplySchema.safeParse({ ...base, ackedEvents: MAX_HEARTBEAT_EVENTS + 1 }).success).toBe(false)
  expect(HeartbeatReplySchema.safeParse({ ...base, ackedEvents: -1 }).success).toBe(false)
  expect(HeartbeatReplySchema.safeParse({ ...base, link: 5 }).success).toBe(false)
  expect(HeartbeatReplySchema.safeParse({ ackedEvents: 0, commands: [] }).success).toBe(false)
})

test('the shape schema keeps an unknown command as text, so a worker can ignore just that one', () => {
  const parsed = HeartbeatReplyShapeSchema.parse({ ackedEvents: 1, commands: ['dance', 'stop'], link: null })
  expect(parsed.commands).toEqual(['dance', 'stop'])
})
