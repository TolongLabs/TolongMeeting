import { describe, expect, test } from 'bun:test'
import type { CompanionJob } from '@tm/core'
import { CompanionApi, CompanionApiError, DeviceRevokedError } from '../src/api'
import { startJobPoller, type JobPollerDeps } from '../src/jobs/poller'

const job = (id: string): CompanionJob => ({
  id,
  kind: 'native_transcription',
  state: 'pending',
  occurrenceId: 'occ_1',
  attempts: 0,
  payload: {
    occurrenceId: 'occ_1',
    entryName: 'Maths',
    start: '2026-10-21T08:00:00Z',
    timeZone: 'Asia/Kuala_Lumpur',
    durationSec: 3600,
    flacBytes: 1000
  }
})

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await Bun.sleep(2)
  }
}

function gate() {
  let open!: () => void
  const promise = new Promise<void>((r) => (open = r))
  return { promise, open }
}

describe('startJobPoller', () => {
  test('trigger polls at once; otherwise the poller waits for the interval', async () => {
    let polls = 0
    const p = startJobPoller({
      api: { jobs: async () => (polls++, []) },
      onJobs: () => {},
      intervalMs: 100
    })
    await Bun.sleep(20)
    expect(polls).toBe(1)
    p.trigger()
    await Bun.sleep(20)
    expect(polls).toBe(2)
    await Bun.sleep(100)
    p.stop()
    expect(polls).toBe(3)
  })

  test('hands each listing to onJobs', async () => {
    const got: string[][] = []
    const p = startJobPoller({
      api: { jobs: async () => [job('j1'), job('j2')] },
      onJobs: (jobs) => void got.push(jobs.map((j) => j.id)),
      intervalMs: 10_000
    })
    await until(() => got.length === 1)
    p.stop()
    expect(got).toEqual([['j1', 'j2']])
  })

  test('triggers during a slow poll or hand-off queue exactly one more poll, never two at once', async () => {
    let inFlight = 0
    let maxInFlight = 0
    let polls = 0
    const hold = gate()
    const p = startJobPoller({
      api: {
        jobs: async () => {
          polls++
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          await Bun.sleep(15)
          inFlight--
          return [job('j1')]
        }
      },
      // The first hand-off is slow, like a runner that is still claiming.
      onJobs: () => (polls === 1 ? hold.promise : undefined),
      intervalMs: 10_000
    })
    await until(() => polls === 1)
    for (let i = 0; i < 5; i++) p.trigger() // five replayed job_available events
    await Bun.sleep(40)
    expect(polls).toBe(1) // still inside the hand-off: nothing overlaps
    hold.open()
    await until(() => polls === 2)
    await Bun.sleep(40)
    p.stop()
    expect(polls).toBe(2)
    expect(maxInFlight).toBe(1)
  })

  test('does not list jobs while the runner is busy', async () => {
    let polls = 0
    let busy = true
    const p = startJobPoller({
      api: { jobs: async () => (polls++, []) },
      onJobs: () => {},
      busy: () => busy,
      intervalMs: 10_000
    })
    await Bun.sleep(20)
    p.trigger()
    await Bun.sleep(20)
    expect(polls).toBe(0)
    busy = false
    p.trigger()
    await until(() => polls === 1)
    p.stop()
  })

  test('a failing poll backs off by the ladder, ignores triggers meanwhile, and recovers', async () => {
    const outcomes: (Error | CompanionJob[])[] = [
      new CompanionApiError(503),
      new CompanionApiError(500),
      new CompanionApiError(401),
      new TypeError('fetch failed'),
      []
    ]
    const calls: number[] = []
    const delays: number[] = []
    const errors: Error[] = []
    const p = startJobPoller({
      api: {
        jobs: async () => {
          calls.push(Date.now())
          const next = outcomes.shift() ?? []
          if (next instanceof Error) throw next
          return next
        }
      },
      onJobs: () => {},
      intervalMs: 10_000,
      delayMs: (attempt) => (delays.push(attempt), 20),
      onError: (e) => void errors.push(e)
    })
    await until(() => calls.length === 1)
    p.trigger() // during the backoff wait: ignored
    await Bun.sleep(8)
    expect(calls.length).toBe(1)
    await until(() => calls.length === 5)
    await Bun.sleep(30)
    p.stop()
    expect(delays).toEqual([0, 1, 2, 3])
    expect(calls.length).toBe(5) // after the good poll it waits the 10 s interval
    expect(errors.map((e) => e.message)).toEqual([
      'The website answered with HTTP 503',
      'The website answered with HTTP 500',
      'The website answered with HTTP 401',
      'fetch failed'
    ])
    for (let i = 1; i < 4; i++) expect(calls[i] - calls[i - 1]).toBeGreaterThanOrEqual(18)
  })

  test('an error from onJobs is reported and does not stop the poller', async () => {
    let polls = 0
    const errors: Error[] = []
    const p = startJobPoller({
      api: { jobs: async () => (polls++, []) },
      onJobs: () => {
        throw new Error('runner broke')
      },
      intervalMs: 15,
      onError: (e) => void errors.push(e)
    })
    await until(() => polls >= 2)
    p.stop()
    expect(errors[0].message).toBe('the job handler failed: runner broke')
  })

  test('401 device_revoked_or_unknown stops the poller and reports "PC was unpaired"', async () => {
    let calls = 0
    let cleared = 0
    const revoked: Error[] = []
    const errors: Error[] = []
    const fetchStub = Object.assign(
      async () => (calls++, Response.json({ error: 'device_revoked_or_unknown' }, { status: 401 })),
      { preconnect: () => {} }
    )
    const api = new CompanionApi({
      serverUrl: 'https://tm.example',
      token: async () => 'tmd_secret',
      onRevoked: () => cleared++,
      fetch: fetchStub
    })
    const p = startJobPoller({
      api,
      onJobs: () => {},
      intervalMs: 10,
      delayMs: () => 10,
      onRevoked: (e) => void revoked.push(e),
      onError: (e) => void errors.push(e)
    })
    await until(() => revoked.length === 1)
    p.trigger()
    await Bun.sleep(50)
    expect(calls).toBe(1)
    expect(cleared).toBe(1)
    expect(revoked[0]).toBeInstanceOf(DeviceRevokedError)
    expect(revoked[0].message).toBe('PC was unpaired')
    expect(errors).toEqual([])
  })

  test('stop() ends the wait and a poll that is still running', async () => {
    let polls = 0
    const slow = gate()
    const handed: number[] = []
    const deps: JobPollerDeps = {
      api: {
        jobs: async () => {
          polls++
          if (polls === 2) await slow.promise
          return [job('j1')]
        }
      },
      onJobs: () => void handed.push(polls),
      intervalMs: 20
    }
    const p = startJobPoller(deps)
    await until(() => polls === 2) // second poll is hanging
    p.stop()
    slow.open()
    await Bun.sleep(60)
    expect(polls).toBe(2)
    expect(handed).toEqual([1]) // the listing that arrived after stop() is not handed on
  })

  test('stop() during the interval wait cancels the next poll', async () => {
    let polls = 0
    const p = startJobPoller({ api: { jobs: async () => (polls++, []) }, onJobs: () => {}, intervalMs: 30 })
    await until(() => polls === 1)
    p.stop()
    p.trigger()
    await Bun.sleep(80)
    expect(polls).toBe(1)
  })
})
