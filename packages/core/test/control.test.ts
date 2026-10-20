import { expect, test } from 'bun:test'
import type { HeartbeatReply } from '../src/types'
import type { SigninHeartbeat } from '../src/control'
import {
  ControlCommandSchema,
  HeartbeatReplySchema,
  HeartbeatReplyShapeSchema,
  MAX_HEARTBEAT_EVENTS,
  SigninEventDataSchema,
  SigninHeartbeatSchema,
  SigninJobSchema,
  SigninReplySchema,
  controlTokenHash,
  vncSecret
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

test('the remote view password is the same for the worker (token) and the website (stored hash), and differs per session', () => {
  const hash = controlTokenHash('1.abc')
  expect(hash).toMatch(/^[0-9a-f]{64}$/)
  expect(vncSecret(hash)).toMatch(/^[A-Za-z0-9_-]{8}$/)
  expect(vncSecret(hash)).toBe(vncSecret(controlTokenHash('1.abc')))
  expect(vncSecret(hash)).not.toBe(vncSecret(controlTokenHash('1.abd')))
  expect(vncSecret(hash)).not.toContain('1.abc')
})

test('sign-in jobs, reports, replies and events are checked', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const job = {
    sessionId: id,
    identityId: id,
    profileDir: '/p/profile',
    checkpointsDir: '/p/checkpoints',
    control: { url: 'https://x.example/api/control', token: 't' }
  }
  expect(SigninJobSchema.parse(job)).toEqual(job)
  expect(SigninJobSchema.safeParse({ ...job, control: { url: '', token: 't' } }).success).toBe(false)
  expect(SigninJobSchema.safeParse({ ...job, sessionId: 'x' }).success).toBe(false)

  const hb: SigninHeartbeat = {
    sessionId: id,
    idleMs: 0,
    ended: true,
    reason: 'done',
    accounts: [{ account: 'google', signedIn: true }]
  }
  expect(SigninHeartbeatSchema.parse(hb)).toEqual(hb)
  expect(SigninHeartbeatSchema.safeParse({ ...hb, reason: 'bored' }).success).toBe(false)
  expect(SigninHeartbeatSchema.safeParse({ ...hb, idleMs: -1 }).success).toBe(false)
  expect(SigninHeartbeatSchema.safeParse({ ...hb, accounts: [{ account: 'myspace', signedIn: true }] }).success).toBe(
    false
  )

  expect(SigninReplySchema.parse({ commands: ['stop'] })).toEqual({ commands: ['stop'] })
  expect(SigninReplySchema.safeParse({ commands: ['dance'] }).success).toBe(false)
  expect(SigninEventDataSchema.parse({ signin: 'resumed', reason: 'idle' })).toEqual({
    signin: 'resumed',
    reason: 'idle'
  })
  expect(SigninEventDataSchema.safeParse({ signin: 'gone' }).success).toBe(false)
})
