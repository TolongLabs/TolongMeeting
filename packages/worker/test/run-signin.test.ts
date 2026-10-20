import { expect, spyOn, test } from 'bun:test'
import type { AccountCheckData, SigninHeartbeat, SigninJob, SigninReply } from '@tm/core'
import { SIGNIN_START_URLS } from '../src/control/vnc'
import { runSignin, type SigninDeps } from '../src/signin/run-signin'

const job: SigninJob = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  identityId: '22222222-2222-4222-8222-222222222222',
  profileDir: '/profiles/22222222/profile',
  checkpointsDir: '/profiles/22222222/checkpoints',
  control: { url: 'https://tolong.example.com/api/control', token: 'T0KEN' }
}

interface Options {
  replies?: SigninReply[]
  idle?: number
  accounts?: AccountCheckData[]
  closeFails?: Error
  postFails?: boolean
  idleFails?: boolean
  openFails?: Error
  signal?: AbortSignal
}

// Scripted collaborators. `order` is the order of the steps; a reply list ends with its last reply repeated. The
// clock ticks every millisecond so the loop runs fast.
function signinFixture(opts: Options = {}) {
  const order: string[] = []
  const posts: SigninHeartbeat[] = []
  const replies = [...(opts.replies ?? [{ commands: [] }])]
  const f = { order, posts, vncStopped: 0, job, deps: null as unknown as SigninDeps }
  const deps: SigninDeps = {
    openDesk: async () => {
      order.push('openDesk')
      if (opts.openFails) throw opts.openFails
      return {
        openTabs: async (urls) => {
          order.push('openTabs')
          expect(urls).toEqual(SIGNIN_START_URLS)
        },
        close: async () => {
          order.push('close')
          if (opts.closeFails) throw opts.closeFails
        },
        ...(opts.accounts
          ? {
              checkAccounts: async () => {
                order.push('accounts')
                return opts.accounts!
              }
            }
          : {})
      }
    },
    startVnc: async () => {
      order.push('startVnc')
      return {
        stop: async () => {
          order.push('stopVnc')
          f.vncStopped += 1
        }
      }
    },
    idleMs: async () => {
      if (opts.idleFails) throw new Error('xprintidle is missing')
      return opts.idle ?? 0
    },
    checkpoint: async () => void order.push('checkpoint'),
    post: async (hb) => {
      posts.push(hb)
      if (opts.postFails && !hb.ended) throw new Error('offline')
      order.push(hb.ended ? `post:ended:${hb.reason}` : 'post')
      return (replies.length > 1 ? replies.shift() : replies[0]) ?? { commands: [] }
    },
    clock: {
      every: (_ms, fn) => {
        const id = setInterval(fn, 1)
        return { stop: async () => clearInterval(id) }
      }
    },
    ...(opts.signal ? { signal: opts.signal } : {})
  }
  f.deps = deps
  return f
}

test('Done stops the sign-in container after a checkpoint', async () => {
  const f = signinFixture({ replies: [{ commands: [] }, { commands: ['stop'] }] })
  await runSignin(f.job, f.deps)
  expect(f.order).toEqual([
    'openDesk',
    'openTabs',
    'startVnc',
    'post',
    'post',
    'stopVnc',
    'close',
    'checkpoint',
    'post:ended:done'
  ])
  expect(f.posts[0]).toEqual({ sessionId: job.sessionId, idleMs: 0, ended: false })
})

test('15 idle minutes end the session', async () => {
  const f = signinFixture({ replies: [{ commands: [] }], idle: 900_000 })
  await runSignin(f.job, f.deps)
  expect(f.posts.at(-1)).toEqual({ sessionId: f.job.sessionId, idleMs: 900_000, ended: true, reason: 'idle' })
  expect(f.order).toContain('checkpoint')
})

test('a resume_after_signin reply is the same as Done', async () => {
  const f = signinFixture({ replies: [{ commands: ['resume_after_signin'] }] })
  await runSignin(f.job, f.deps)
  expect(f.posts.at(-1)).toMatchObject({ ended: true, reason: 'done' })
})

test('the accounts seen at the end go with the last report, before the browser closes', async () => {
  const accounts: AccountCheckData[] = [
    { account: 'google', signedIn: true },
    { account: 'microsoft', signedIn: false }
  ]
  const f = signinFixture({ replies: [{ commands: ['stop'] }], accounts })
  await runSignin(f.job, f.deps)
  expect(f.order.slice(-4)).toEqual(['accounts', 'close', 'checkpoint', 'post:ended:done'])
  expect(f.posts.at(-1)).toEqual({ sessionId: job.sessionId, idleMs: 0, ended: true, reason: 'done', accounts })
  expect(f.posts.filter((p) => !p.ended).every((p) => p.accounts === undefined)).toBe(true)
})

test('SIGTERM ends the session as done without the account check, inside the stop timeout', async () => {
  const abort = new AbortController()
  const f = signinFixture({ accounts: [{ account: 'google', signedIn: true }], signal: abort.signal })
  const running = runSignin(f.job, f.deps)
  await Bun.sleep(20)
  abort.abort()
  await running
  expect(f.order).not.toContain('accounts')
  expect(f.order.slice(-3)).toEqual(['close', 'checkpoint', 'post:ended:done'])
  expect(f.vncStopped).toBe(1)
})

test('a browser that will not close is not checkpointed, and the end is still reported and thrown', async () => {
  const f = signinFixture({ replies: [{ commands: ['stop'] }], closeFails: new Error('chrome hung') })
  await expect(runSignin(f.job, f.deps)).rejects.toThrow('chrome hung')
  expect(f.order).not.toContain('checkpoint')
  expect(f.order.at(-1)).toBe('post:ended:done')
})

test('a desk that cannot open ends the session as an error', async () => {
  const f = signinFixture({ openFails: new Error('no display') })
  await expect(runSignin(f.job, f.deps)).rejects.toThrow('no display')
  expect(f.order).toEqual(['openDesk', 'post:ended:error'])
})

test('an idle time that cannot be read ends the session as an error, with the view stopped', async () => {
  const f = signinFixture({ idleFails: true })
  await expect(runSignin(f.job, f.deps)).rejects.toThrow('xprintidle is missing')
  expect(f.vncStopped).toBe(1)
  expect(f.posts.at(-1)).toMatchObject({ ended: true, reason: 'error' })
})

test('a server that takes no report for a minute ends the session, and the log names no URL or token', async () => {
  const errors = spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    const f = signinFixture({ postFails: true })
    await expect(runSignin(f.job, f.deps)).rejects.toThrow('took none of 12 heartbeats')
    expect(f.vncStopped).toBe(1)
    expect(f.posts.at(-1)).toMatchObject({ ended: true, reason: 'error' })
    const logged = errors.mock.calls.flat().join('\n')
    expect(logged).toContain('heartbeat not delivered')
    expect(logged).not.toContain('T0KEN')
    expect(logged).not.toContain('tolong.example.com')
  } finally {
    errors.mockRestore()
  }
})
