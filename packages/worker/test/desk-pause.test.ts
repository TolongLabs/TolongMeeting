import { expect, test } from 'bun:test'
import type { SigninEventData } from '@tm/core'
import { DeskPause } from '../src/control/desk-pause'
import { SIGNIN_START_URLS } from '../src/control/vnc'

// A desk pause with scripted collaborators and a clock the test moves. `idle` is what xprintidle reports; `now` is
// the clock; `tick()` runs the 10-second idle check and lets it finish.
function deskFixture(
  over: { openTabs?: () => Promise<void>; checkpoint?: () => Promise<void>; anchor?: () => Promise<void> } = {}
) {
  let tick: (() => void) | null = null
  const f = {
    idle: 0,
    now: 0,
    idleFails: false,
    events: [] as SigninEventData[],
    openedTabs: [] as string[],
    vncStarted: 0,
    vncStopped: 0,
    tabsClosed: 0,
    anchors: 0,
    order: [] as string[],
    checkpoints: 0,
    reported: [] as unknown[],
    async tick() {
      tick?.()
      await Bun.sleep(1)
    },
    pause: null as unknown as DeskPause
  }
  f.pause = new DeskPause(
    {
      startVnc: async () => {
        f.vncStarted += 1
        return { stop: async () => void (f.vncStopped += 1) }
      },
      idleMs: async () => {
        if (f.idleFails) throw new Error('xprintidle is missing')
        return f.idle
      },
      openTabs: async (urls) => {
        await over.openTabs?.()
        f.openedTabs.push(...urls)
        return async () => {
          f.tabsClosed += 1
          f.order.push('closeTabs')
        }
      },
      anchor: async () => {
        f.anchors += 1
        f.order.push('anchor')
        await over.anchor?.()
      },
      checkpoint: async () => {
        f.checkpoints += 1
        await over.checkpoint?.()
      },
      emit: (data) => void f.events.push(data),
      report: (error) => void f.reported.push(error)
    },
    {
      now: () => f.now,
      every: (_ms, fn) => {
        tick = fn
        return { stop: async () => void (tick = null) }
      }
    }
  )
  return f
}

test('the desk pauses for sign-in and resumes after 15 minutes idle', async () => {
  const f = deskFixture()
  await f.pause.pause()
  expect(f.events).toEqual([{ signin: 'paused' }])
  expect(f.openedTabs).toEqual(SIGNIN_START_URLS)
  f.now = 899_999
  f.idle = 899_999
  await f.tick()
  expect(f.pause.paused).toBe(true)
  f.now = 900_000
  f.idle = 900_000
  await f.tick()
  expect(f.pause.paused).toBe(false)
  expect(f.events.at(-1)).toEqual({ signin: 'resumed', reason: 'idle' })
  expect([f.vncStopped, f.tabsClosed, f.checkpoints]).toEqual([1, 1, 1])
})

test('time the desk sat unused before the pause does not count as the member being idle', async () => {
  const f = deskFixture()
  f.now = 3_600_000
  await f.pause.pause()
  f.now += 10_000
  f.idle = 3_610_000
  await f.tick()
  expect(f.pause.paused).toBe(true)
})

test('a resume command releases the waiting desk actions', async () => {
  const f = deskFixture()
  await f.pause.pause()
  let opened = false
  const waiting = f.pause.whenOpen().then(() => (opened = true))
  const next = f.pause.nextResume()
  await Bun.sleep(1)
  expect(opened).toBe(false)
  await f.pause.resume('command')
  await waiting
  expect(await next).toBe('command')
  expect(f.events.at(-1)).toEqual({ signin: 'resumed', reason: 'command' })
})

test('the desk is free when no pause runs', async () => {
  const f = deskFixture()
  await f.pause.whenOpen()
  await f.pause.resume('command') // nothing to resume
  expect(f.events).toEqual([])
  expect(f.pause.paused).toBe(false)
})

test('pausing twice starts one view', async () => {
  const f = deskFixture()
  await Promise.all([f.pause.pause(), f.pause.pause()])
  await f.pause.pause()
  expect([f.vncStarted, f.events.length]).toEqual([1, 1])
})

test('a pause that cannot open its pages stops the view and frees the desk', async () => {
  const f = deskFixture({
    openTabs: async () => {
      throw new Error('the desk window is gone')
    }
  })
  const waiting = f.pause.whenOpen()
  const queued = f.pause.pause()
  const late = f.pause.whenOpen()
  await expect(queued).rejects.toThrow('the desk window is gone')
  await Promise.all([waiting, late])
  expect(f.pause.paused).toBe(false)
  expect([f.vncStarted, f.vncStopped, f.events.length]).toEqual([1, 1, 0])
})

test('a failed checkpoint still ends the pause, then is thrown', async () => {
  const f = deskFixture({
    checkpoint: async () => {
      throw new Error('disk full')
    }
  })
  await f.pause.pause()
  const waiting = f.pause.whenOpen()
  await expect(f.pause.resume('command')).rejects.toThrow('disk full')
  await waiting
  expect(f.pause.paused).toBe(false)
  expect(f.events.at(-1)).toEqual({ signin: 'resumed', reason: 'command' })
  expect([f.vncStopped, f.tabsClosed]).toEqual([1, 1])
  // The next pause works.
  await f.pause.pause()
  expect(f.pause.paused).toBe(true)
})

test('one idle time that cannot be read is reported, two in a row take the desk back', async () => {
  const f = deskFixture()
  await f.pause.pause()
  f.idleFails = true
  await f.tick()
  expect(f.pause.paused).toBe(true)
  expect(f.reported).toHaveLength(1)
  // A good reading in between starts the count again.
  f.idleFails = false
  await f.tick()
  f.idleFails = true
  await f.tick()
  expect(f.pause.paused).toBe(true)
  await f.tick()
  expect(f.pause.paused).toBe(false)
  expect(f.events.at(-1)).toEqual({ signin: 'resumed', reason: 'idle' })
  expect(f.reported).toHaveLength(3)
})

test('the anchor tab is restored before the sign-in tabs close', async () => {
  const f = deskFixture()
  await f.pause.pause()
  await f.pause.resume('command')
  expect(f.order).toEqual(['anchor', 'closeTabs'])
})

test('a failed anchor restore still closes the tabs and ends the pause', async () => {
  const f = deskFixture({
    anchor: async () => {
      throw new Error('the desk window is gone')
    }
  })
  await f.pause.pause()
  await expect(f.pause.resume('command')).rejects.toThrow('the desk window is gone')
  expect(f.pause.paused).toBe(false)
  expect(f.tabsClosed).toBe(1)
})

test('a pause asked for while the last one ends starts a new pause afterwards', async () => {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => (release = resolve))
  const f = deskFixture({ checkpoint: () => gate })
  await f.pause.pause()
  const resuming = f.pause.resume('command')
  const again = f.pause.pause()
  await Bun.sleep(1)
  expect(f.vncStarted).toBe(1) // the second view waits for the first pause to end
  release()
  await resuming
  await again
  expect(f.pause.paused).toBe(true)
  expect(f.vncStarted).toBe(2)
  expect(f.events.map((e) => ('reason' in e ? 'resumed' : e.signin))).toEqual(['paused', 'resumed', 'paused'])
})

test('closing at teardown stops the view and frees waiters without a checkpoint', async () => {
  const f = deskFixture()
  await f.pause.pause()
  const waiting = f.pause.whenOpen()
  await f.pause.close()
  await waiting
  expect(f.pause.paused).toBe(false)
  expect([f.vncStopped, f.checkpoints, f.events.length]).toEqual([1, 0, 1])
  await expect(f.pause.pause()).rejects.toThrow('closed')
})

test('a pause waits for the desk step in flight before it exposes the desk', async () => {
  const f = deskFixture()
  let finish: () => void = () => undefined
  const step = f.pause.deskStep(() => new Promise<void>((resolve) => (finish = resolve)))
  const paused = f.pause.pause()
  await Bun.sleep(1)
  expect(f.vncStarted).toBe(0)
  finish()
  await step
  await paused
  expect([f.vncStarted, f.pause.paused]).toEqual([1, true])
})

test('a desk step that comes while a pause starts waits for the member to finish', async () => {
  const f = deskFixture()
  const paused = f.pause.pause()
  let ran = false
  const step = f.pause.deskStep(async () => void (ran = true))
  await paused
  await Bun.sleep(1)
  expect(ran).toBe(false)
  await f.pause.resume('command')
  await step
  expect(ran).toBe(true)
})

test('a desk step that fails still lets the next pause start', async () => {
  const f = deskFixture()
  await expect(
    f.pause.deskStep(async () => {
      throw new Error('driver failed')
    })
  ).rejects.toThrow('driver failed')
  await f.pause.pause()
  expect(f.pause.paused).toBe(true)
})
