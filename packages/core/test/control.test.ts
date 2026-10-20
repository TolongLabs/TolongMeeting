import { expect, test } from 'bun:test'
import type { Heartbeat, HeartbeatReply } from '../src/types'
import type { SigninHeartbeat } from '../src/control'
import {
  ControlCommandSchema,
  HeartbeatReplySchema,
  HeartbeatSchema,
  HeartbeatReplyShapeSchema,
  MAX_HEARTBEAT_EVENTS,
  SigninEventDataSchema,
  SigninHeartbeatSchema,
  SigninJobSchema,
  SigninReplySchema,
  StateEventDataSchema,
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

test('a joining state event carries the link source and host, and the URL itself is dropped', () => {
  expect(StateEventDataSchema.parse({ state: 'in_meeting' })).toEqual({ state: 'in_meeting' })
  expect(StateEventDataSchema.parse({ state: 'joining', link: { source: 'pasted', host: 'example.zoom.us' } })).toEqual(
    {
      state: 'joining',
      link: { source: 'pasted', host: 'example.zoom.us' }
    }
  )
  expect(
    StateEventDataSchema.parse({ state: 'joining', link: { source: 'watched', host: 'h.example', url: 'https://h' } })
  ).toEqual({ state: 'joining', link: { source: 'watched', host: 'h.example' } })
  expect(StateEventDataSchema.safeParse({ state: 'joining', link: { source: 'discord', host: 'h' } }).success).toBe(
    false
  )
  expect(StateEventDataSchema.safeParse({ state: 'joining', link: { source: 'fixed', host: '' } }).success).toBe(false)
})

const hb = (): Heartbeat => ({
  occurrenceId: '6f1c0a52-3c1e-4c1f-8f0e-2d6f6a1d9b11',
  attempt: 1,
  state: 'in_meeting',
  recording: true,
  participants: 3,
  events: []
})

test('a heartbeat may carry the joined link; a value that is not an https URL is ignored, not refused', () => {
  const linkUsed = 'https://example.zoom.us/j/00000000000?pwd=PASSCODE'
  expect(HeartbeatSchema.parse({ ...hb(), linkUsed }).linkUsed).toBe(linkUsed)
  expect(HeartbeatSchema.safeParse(hb()).success).toBe(true)
  for (const bad of [
    'javascript:alert(1)',
    'http://example.zoom.us/j/1',
    `https://example.zoom.us/${'a'.repeat(2048)}`,
    42
  ]) {
    const parsed = HeartbeatSchema.parse({ ...hb(), linkUsed: bad })
    expect(parsed.linkUsed, String(bad)).toBeUndefined()
    expect(parsed.state).toBe('in_meeting')
  }
})

test('a left_by_member state event may name the command that ended the meeting', () => {
  expect(StateEventDataSchema.parse({ state: 'left_by_member', command: 'take_over' }).command).toBe('take_over')
  expect(StateEventDataSchema.safeParse({ state: 'left_by_member', command: 'stop' }).success).toBe(false)
})
