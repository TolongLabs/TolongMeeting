import { afterEach, expect, test } from 'bun:test'
import type { ChatMessage, FormCandidate } from '@tm/core'
import type { Page } from 'playwright'
import {
  WatcherChatError,
  WatcherSigninError,
  configureWatchers,
  resetWatcherEnv,
  runChatWatcher,
  type ChatSourceReader,
  type WatcherEnv,
  type WatcherStatus
} from '../../src/watchers/loop'
import type { Stopper } from '../../src/types'

const NOW = new Date('2026-10-21T05:00:00Z')
const Z1 = 'https://example.zoom.us/j/00000000001?pwd=PASSCODE'
const Z2 = 'https://example.zoom.us/j/00000000002?pwd=PASSCODE'
const Z3 = 'https://example.zoom.us/j/00000000003?pwd=PASSCODE'
const Z4 = 'https://example.zoom.us/j/00000000004?pwd=PASSCODE'
const P = 'https://pasted.zoom.us/j/00000000009?pwd=PASSCODE'
const F = 'https://forms.gle/TESTFORM1'
// The loop never looks inside the desk: the reader is the only thing that uses it.
const desk = {} as unknown as Page

const m = (key: string, sender: string, links: string[]): ChatMessage => ({
  key,
  sender,
  senderRole: 'unknown',
  time: '',
  seenAt: '',
  text: '',
  links,
  replyTo: null
})

interface FakeReader extends ChatSourceReader {
  /** What the next `latest()` call returns. */
  feed: ChatMessage[]
  throwNext: unknown[]
  alwaysThrow: unknown
  sinces: Date[]
  calls: { open: number; history: number; latest: number }
}

function fakeReader({ history, feed = [] }: { history: ChatMessage[]; feed?: ChatMessage[] }): FakeReader {
  const reader: FakeReader = {
    feed,
    throwNext: [],
    alwaysThrow: null,
    sinces: [],
    calls: { open: 0, history: 0, latest: 0 },
    async open() {
      reader.calls.open += 1
    },
    async history(_desk, since) {
      reader.calls.history += 1
      reader.sinces.push(since)
      return history
    },
    async latest() {
      reader.calls.latest += 1
      if (reader.alwaysThrow !== null) throw reader.alwaysThrow
      if (reader.throwNext.length > 0) throw reader.throwNext.shift()
      return [...reader.feed]
    }
  }
  return reader
}

type Link = FormCandidate | { meetingUrl: string }

const stoppers: Stopper[] = []

afterEach(async () => {
  for (const s of stoppers.splice(0)) await s.stop()
  resetWatcherEnv()
})

function harness(over: Partial<WatcherEnv> = {}) {
  resetWatcherEnv()
  const meeting: { meetingUrl: string }[] = []
  const forms: FormCandidate[] = []
  const delays: number[] = []
  const statuses: WatcherStatus[] = []
  let sleeping: (() => void) | null = null
  let sleepCount = 0
  let releasedAt = 0
  let ended = false
  let listeners: (() => void)[] = []

  const notify = () => {
    for (const l of listeners.splice(0)) l()
  }
  const until = (done: () => boolean): Promise<void> =>
    new Promise((resolve) => {
      const check = () => (done() ? resolve() : listeners.push(check))
      check()
    })

  const set = (more: Partial<WatcherEnv>) => configureWatchers(more)
  set({
    now: () => NOW,
    sleep: (ms) => {
      delays.push(ms)
      sleepCount += 1
      const p = new Promise<void>((resolve) => (sleeping = resolve))
      notify()
      return p
    },
    onStatus: (s) => {
      statuses.push(s)
      if (s.kind === 'chat_lost') {
        ended = true
        notify()
      }
    },
    ...over
  })

  const release = async () => {
    await until(() => sleeping !== null || ended)
    if (ended) return
    releasedAt = sleepCount
    const resolve = sleeping!
    sleeping = null
    resolve()
  }
  return {
    meeting,
    forms,
    delays,
    statuses,
    set,
    release,
    onLink: (c: Link) => ('meetingUrl' in c ? meeting.push(c) : forms.push(c)),
    async run(reader: ChatSourceReader): Promise<Stopper> {
      const stopper = await runChatWatcher(desk, reader, this.onLink)
      stoppers.push(stopper)
      return stopper
    },
    /** Releases one sleep and waits until the next poll has finished (the loop sleeps again, or has ended). */
    async tick() {
      await release()
      await until(() => sleepCount > releasedAt || ended)
    },
    /** Waits for the poll in flight. */
    settle: () => until(() => sleepCount > releasedAt || ended)
  }
}

test('the history scan reports only the newest meeting link', async () => {
  const r = fakeReader({ history: [m('a', 'Rep', [Z1]), m('b', 'Rep', [Z2]), m('c', 'Rep', [])] })
  const h = harness()
  await h.run(r)
  expect(r.sinces[0]!.toISOString()).toBe('2026-10-20T05:00:00.000Z')
  expect(h.meeting).toEqual([{ meetingUrl: Z2 }])
})

test('a corrected link replaces the first; a pasted link overrides; nothing repeats', async () => {
  const r = fakeReader({ history: [m('a', 'Rep', [Z1])] })
  const h = harness()
  await h.run(r)
  r.feed = [m('a', 'Rep', [Z1]), m('b', 'Rep', [Z2])]
  await h.tick()
  h.set({ pastedLink: () => P })
  r.feed.push(m('c', 'Rep', [Z3]))
  await h.tick()
  await h.tick()
  expect(h.meeting).toEqual([{ meetingUrl: Z1 }, { meetingUrl: Z2 }, { meetingUrl: P }])
})

test('an edited message with a new link counts', async () => {
  const r = fakeReader({ history: [m('a', 'Rep', [])] })
  const h = harness()
  await h.run(r)
  r.feed = [m('a', 'Rep', [Z4])]
  await h.tick()
  expect(h.meeting).toEqual([{ meetingUrl: Z4 }])
})

test('a form first seen after T-10 but before joining is offered when joining starts', async () => {
  const r = fakeReader({ history: [] })
  const h = harness({ formsSince: () => new Date('2026-10-21T04:55:00Z') })
  await h.run(r)
  r.feed = [m('f', 'Lecturer', [F])]
  await h.tick()
  expect(h.forms).toEqual([])
  h.set({ phase: () => 'during' })
  await h.tick()
  expect(h.forms).toEqual([
    { url: F, source: 'watched_chat', sender: 'Lecturer', senderRole: 'unknown', seenAt: '2026-10-21T05:00:00.000Z' }
  ])
})

test('a form first seen before T-10 is never offered', async () => {
  const r = fakeReader({ history: [m('f', 'Lecturer', [F])] })
  const h = harness({ formsSince: () => new Date('2026-10-21T05:10:00Z') })
  await h.run(r)
  h.set({ phase: () => 'during' })
  await h.tick()
  expect(h.forms).toEqual([])
})

test('a restart during the meeting reads from T-10 and reports no meeting link', async () => {
  const r = fakeReader({ history: [m('a', 'Rep', [Z1]), m('f', 'Lecturer', [F])] })
  const h = harness({ phase: () => 'during', formsSince: () => new Date('2026-10-21T04:50:00Z') })
  await h.run(r)
  expect(r.sinces[0]!.toISOString()).toBe('2026-10-21T04:50:00.000Z')
  expect(h.meeting).toEqual([])
  expect(h.forms.map((c) => c.url)).toEqual([F])
})

test('polls use the delay for the current phase', async () => {
  const h = harness({ random: () => 0.5 })
  await h.run(fakeReader({ history: [] }))
  await h.tick()
  h.set({ phase: () => 'during' })
  await h.tick()
  expect(h.delays.slice(0, 3)).toEqual([35_000, 35_000, 18_500])
})

test('nothing touches the desk while it is paused', async () => {
  const r = fakeReader({ history: [] })
  const h = harness()
  await h.run(r)
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  h.set({
    deskStep: async (step) => {
      entered.resolve()
      await gate.promise
      return step()
    }
  })
  await h.release()
  await entered.promise
  expect(r.calls.latest).toBe(0)
  gate.resolve()
  await h.settle()
  expect(r.calls.latest).toBe(1)
})

test('every reader call runs through the desk step', async () => {
  const r = fakeReader({ history: [] })
  let steps = 0
  const h = harness({
    deskStep: (step) => {
      steps += 1
      return step()
    }
  })
  await h.run(r)
  expect(steps).toBe(2) // open, history
  await h.tick()
  expect(steps).toBe(3) // latest
})

test('a sign-out is reported once, and so is the recovery', async () => {
  const r = fakeReader({ history: [] })
  const h = harness()
  await h.run(r)
  r.throwNext = [new WatcherSigninError('web.whatsapp.com'), new WatcherSigninError('web.whatsapp.com')]
  await h.tick()
  await h.tick()
  await h.tick()
  expect(h.statuses).toEqual([{ kind: 'signed_out', host: 'web.whatsapp.com' }, { kind: 'signed_in' }])
})

test('a lost chat is reopened at most 3 times, then the loop ends', async () => {
  const r = fakeReader({ history: [] })
  const h = harness()
  await h.run(r)
  r.alwaysThrow = new WatcherChatError('lost')
  for (let i = 0; i < 6; i++) await h.tick()
  expect(r.calls.open).toBe(4)
  expect(h.statuses).toEqual([{ kind: 'chat_lost' }])
  expect(r.calls.latest).toBe(4)
})

test('the third failure in a row reopens the chat; a good read clears the count', async () => {
  const r = fakeReader({ history: [] })
  const h = harness()
  await h.run(r)
  r.throwNext = [new WatcherChatError('not_loaded'), new WatcherChatError('not_loaded')]
  await h.tick()
  await h.tick()
  await h.tick() // a good read
  expect(r.calls.open).toBe(1)
  r.throwNext = [new Error('x'), new Error('x'), new Error('x')]
  await h.tick()
  await h.tick()
  await h.tick()
  expect(r.calls.open).toBe(2)
  expect(h.statuses).toEqual([])
})

test('stop ends a sleeping loop at once; an open error rejects the start', async () => {
  const h = harness({ sleep: () => new Promise(() => {}) })
  const stop = await h.run(fakeReader({ history: [] }))
  const t = performance.now()
  await stop.stop()
  expect(performance.now() - t).toBeLessThan(500)
  const bad = fakeReader({ history: [] })
  bad.open = async () => {
    throw new WatcherSigninError('discord.com')
  }
  await expect(runChatWatcher(desk, bad, h.onLink)).rejects.toBeInstanceOf(WatcherSigninError)
})
