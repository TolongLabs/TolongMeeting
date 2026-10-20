import { expect, spyOn, test } from 'bun:test'
import type { Ping } from '@tm/notify'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lastMentionPing, startMentionWatch, MENTION_DEBOUNCE_MS, type MentionWatchDeps } from '../src/mentions/watch'

const r = (startMs: number, endMs: number, text: string) => ({ startMs, endMs, text })

function deps(over: Partial<MentionWatchDeps>): MentionWatchDeps & { emitted: number[]; pings: Ping[] } {
  const emitted: number[] = []
  const sent: Ping[] = []
  return {
    names: ['Aisyah'],
    entry: 'Data Mining',
    timeZone: 'Asia/Kuala_Lumpur',
    recordingStartedAt: new Date('2026-10-21T06:00:00Z'),
    links: { meetingPage: 'https://tm.example/meetings/o1', takeOver: 'https://tm.example/meetings/o1/take-over' },
    emit: (atMs) => void emitted.push(atMs),
    ping: async (p) => void sent.push(p),
    ...over,
    emitted,
    pings: sent
  }
}

test('a mention pings with the last 30 seconds and both buttons', async () => {
  const d = deps({})
  const w = startMentionWatch(d)!
  for (const x of [
    r(0, 10_000, 'one'),
    r(10_000, 25_000, 'two'),
    r(25_000, 40_000, 'three'),
    r(40_000, 52_000, 'Aisyah?')
  ])
    w.onResult(x)
  await Bun.sleep(0)
  expect(d.emitted).toEqual([52_000])
  expect(d.pings).toEqual([
    {
      title: 'Your name was mentioned: Data Mining',
      message: 'Heard at Wed 21 Oct, 14:00. The last 30 seconds:\ntwo three Aisyah?',
      priority: 'high',
      actions: [
        { label: 'Open meeting page', url: 'https://tm.example/meetings/o1' },
        { label: 'Take over', url: 'https://tm.example/meetings/o1/take-over' }
      ]
    }
  ])
})

test('a roll call pings once in 2 minutes; a later mention pings again', async () => {
  const d = deps({})
  const w = startMentionWatch(d)!
  for (const at of [52_000, 58_000, 70_000, 52_000 + MENTION_DEBOUNCE_MS])
    w.onResult(r(at - 2_000, at, 'Aisyah, are you there?'))
  await Bun.sleep(0)
  expect(d.emitted).toEqual([52_000, 58_000, 70_000, 172_000])
  expect(d.pings).toHaveLength(2)
})

test('a mention just inside the debounce window does not ping', async () => {
  const d = deps({})
  const w = startMentionWatch(d)!
  w.onResult(r(0, 10_000, 'Aisyah'))
  w.onResult(r(0, 10_000 + MENTION_DEBOUNCE_MS - 1, 'Aisyah'))
  await Bun.sleep(0)
  expect(d.pings).toHaveLength(1)
})

test('no names means no watch', () => {
  expect(startMentionWatch(deps({ names: ['A', ''] }))).toBeNull()
})

test('no links means no buttons', async () => {
  const d = deps({ links: null })
  startMentionWatch(d)!.onResult(r(0, 1_000, 'aisyah'))
  await Bun.sleep(0)
  expect(d.pings[0]!.actions).toBeUndefined()
})

test('a failed ping is logged by name only, never thrown, and the next mention tries again', async () => {
  const log = spyOn(console, 'error').mockImplementation(() => {})
  try {
    let calls = 0
    const d = deps({
      ping: async () => {
        calls += 1
        if (calls === 1) throw new Error('ntfy down, token tk_secret')
      }
    })
    const w = startMentionWatch(d)!
    expect(() => w.onResult(r(0, 1_000, 'Aisyah, the transcript text'))).not.toThrow()
    await Bun.sleep(0)
    w.onResult(r(1_000, 2_000, 'Aisyah again'))
    await Bun.sleep(0)
    expect(calls).toBe(2)
    const logged = log.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toBe('mention ping failed (Error)')
  } finally {
    log.mockRestore()
  }
})

test('the mention event carries the offset only, never text', async () => {
  const seen: unknown[][] = []
  const d = deps({ emit: (...args: unknown[]) => void seen.push(args) })
  startMentionWatch(d)!.onResult(r(0, 9_000, 'Aisyah, the passcode is one two three four five six'))
  await Bun.sleep(0)
  expect(seen).toEqual([[9_000]])
})

test('a throwing emit does not reach the caller or stop the ping', async () => {
  const log = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const d = deps({
      emit: () => {
        throw new Error('disk full')
      }
    })
    expect(() => startMentionWatch(d)!.onResult(r(0, 1_000, 'Aisyah'))).not.toThrow()
    await Bun.sleep(0)
    expect(d.pings).toHaveLength(1)
  } finally {
    log.mockRestore()
  }
})

test('a result whose offset goes backwards is ignored: it neither pings nor holds back later pings', async () => {
  const d = deps({})
  const w = startMentionWatch(d)!
  w.onResult(r(498_000, 500_000, 'Aisyah'))
  w.onResult(r(98_000, 100_000, 'Aisyah'))
  w.onResult(r(298_000, 300_000, 'Aisyah'))
  w.onResult(r(500_000 + MENTION_DEBOUNCE_MS - 2_000, 500_000 + MENTION_DEBOUNCE_MS, 'Aisyah'))
  await Bun.sleep(0)
  expect(d.pings).toHaveLength(2)
  expect(d.emitted).toEqual([500_000, 500_000 + MENTION_DEBOUNCE_MS])
})

test('a ping an earlier run of the watch sent still holds the debounce', async () => {
  const started = new Date('2026-10-21T06:00:00Z')
  // The earlier run pinged 60 s before this one started: a mention 30 s in is 90 s after it, inside the window.
  const d = deps({ lastPingAt: new Date(started.getTime() - 60_000) })
  const w = startMentionWatch(d)!
  w.onResult(r(28_000, 30_000, 'Aisyah'))
  w.onResult(r(58_000, 60_001, 'Aisyah'))
  await Bun.sleep(0)
  expect(d.emitted).toEqual([30_000, 60_001])
  expect(d.pings).toHaveLength(1)
  expect(d.pings[0]!.message).toContain('Aisyah')
})

test('the last ping is replayed from the mention events a restarted worker finds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tm-mentions-'))
  try {
    const file = join(dir, 'events.jsonl')
    expect(await lastMentionPing(file)).toBeNull()
    const at = (s: number) => new Date(Date.parse('2026-10-21T06:10:00Z') + s * 1000).toISOString()
    const ev = (type: string, s: number) =>
      JSON.stringify({ occurrenceId: 'o1', attempt: 1, at: at(s), type, data: {} })
    // A roll call: mentions at 0 s, 10 s and 20 s are one ping at 0 s; the one at 130 s is a second ping.
    await writeFile(
      file,
      [
        ev('mention', 0),
        ev('joined', 5),
        ev('mention', 10),
        'not json',
        ev('mention', 20),
        ev('mention', 130),
        '{"truncated'
      ].join('\n')
    )
    expect(await lastMentionPing(file)).toEqual(new Date(at(130)))
    await writeFile(file, [ev('mention', 0), ev('mention', 100)].join('\n'))
    expect(await lastMentionPing(file)).toEqual(new Date(at(0)))
    await writeFile(file, ev('joined', 0))
    expect(await lastMentionPing(file)).toBeNull()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("the passcode of the bot's own link is cut from the quote, however the speaker spaced it", async () => {
  const d = deps({ joinedLinks: ['', 'https://us02web.zoom.us/wc/join/123456789?pwd=Xk9pQ2'] })
  startMentionWatch(d)!.onResult(r(0, 9_000, 'Aisyah, it is X k 9 p Q 2 for the room, or xk9pq2'))
  await Bun.sleep(0)
  expect(d.pings[0]!.message).not.toMatch(/Xk9pQ2|X k 9|xk9pq2/i)
  expect(d.pings[0]!.message).toContain('[removed]')
})
