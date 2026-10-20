import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ControlCommand, Heartbeat, HeartbeatReply, JobConfig, MeetingEvent } from '@tm/core'
import { dispatchCommands } from '../src/control/commands'
import { backoffDelayMs, startHeartbeat, type HeartbeatOptions } from '../src/control/heartbeat'
import { LinkOverride } from '../src/control/link-override'
import { siteLinks } from '../src/control/links'
import { EventOutbox } from '../src/control/outbox'
import { acknowledgedState, rememberState } from '../src/control/resume'
import { makeCfg } from './helpers/fake-deps'

let cfg: JobConfig
let dir: string
beforeEach(async () => {
  cfg = await makeCfg()
  dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tm-outbox-'))
})
afterEach(async () => {
  await rm(join(cfg.dataDir, '..'), { recursive: true, force: true })
  await rm(dir, { recursive: true, force: true })
})

const event = (
  n: number,
  type: MeetingEvent['type'] = 'error',
  data: Record<string, unknown> = { n }
): MeetingEvent => ({
  occurrenceId: 'occ-1',
  attempt: 1,
  at: `2026-10-21T12:00:0${n}.000Z`,
  type,
  data
})
const [e1, e2, e3] = [event(1), event(2), event(3)] as [MeetingEvent, MeetingEvent, MeetingEvent]

function status(events: MeetingEvent[]): Heartbeat {
  return { occurrenceId: 'occ-1', attempt: 1, state: 'in_meeting', recording: true, participants: 4, events }
}

function withControl(url: string): JobConfig {
  return { ...cfg, control: { url, token: '1.abc' } }
}

type Handler = (req: Request, body: Heartbeat) => Response | Promise<Response>

// A control server on 127.0.0.1 that records each request and answers with `handler`.
function serve(handler: Handler) {
  const seen: { path: string; auth: string | null; body: Heartbeat }[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as Heartbeat
      seen.push({ path: new URL(req.url).pathname, auth: req.headers.get('authorization'), body })
      return handler(req, body)
    }
  })
  return { seen, url: `http://127.0.0.1:${server.port}/api/control`, stop: () => server.stop(true) }
}

const FAST: HeartbeatOptions = { intervalMs: 20, backoff: { firstMs: 10, maxMs: 40 } }
const ok = (r: Partial<HeartbeatReply> = {}) => Response.json({ ackedEvents: 0, commands: [], link: null, ...r })

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await Bun.sleep(5)
  }
}

test('heartbeats carry the bearer token and pass replies on', async () => {
  const s = serve(() => ok({ ackedEvents: 1, commands: ['leave_now'] }))
  const replies: HeartbeatReply[] = []
  const loop = startHeartbeat(
    withControl(s.url),
    () => status([e1]),
    (r) => replies.push(r),
    FAST
  )
  await until(() => s.seen.length >= 2)
  await loop.stop()
  s.stop()
  expect(s.seen[0]!.path).toBe('/api/control/heartbeat')
  expect(s.seen[0]!.auth).toBe('Bearer 1.abc')
  expect(s.seen[0]!.body).toMatchObject({
    occurrenceId: 'occ-1',
    state: 'in_meeting',
    recording: true,
    participants: 4
  })
  expect(replies[0]).toEqual({ ackedEvents: 1, commands: ['leave_now'], link: null })
})

test('410 becomes a stop command and ends the sending; no control channel means no requests', async () => {
  const s = serve(() => new Response(null, { status: 410 }))
  const replies: HeartbeatReply[] = []
  let superseded = 0
  const loop = startHeartbeat(
    withControl(s.url),
    () => status([]),
    (r) => replies.push(r),
    {
      ...FAST,
      onSuperseded: () => superseded++
    }
  )
  await until(() => replies.length > 0)
  await Bun.sleep(80)
  await loop.stop()
  s.stop()
  expect(replies).toEqual([{ ackedEvents: 0, commands: ['stop'], link: null }])
  expect(s.seen).toHaveLength(1)
  expect(superseded).toBe(1)
  const fetchFn = mock(fetch) as unknown as typeof fetch
  const none = startHeartbeat(
    { ...cfg, control: null },
    () => status([]),
    () => {},
    { intervalMs: 10, fetchFn }
  )
  await none.stop()
  expect(await none.flush()).toBe(true)
  expect(fetchFn).not.toHaveBeenCalled()
})

test('a 401 stops the sending and is reported once', async () => {
  const s = serve(() => new Response('no', { status: 401 }))
  let refused = 0
  const errors = mock(() => {})
  const saved = console.error
  console.error = errors
  const loop = startHeartbeat(
    withControl(s.url),
    () => status([e1]),
    () => {},
    { ...FAST, onRefused: () => refused++ }
  )
  await until(() => refused > 0)
  await Bun.sleep(80)
  await loop.stop()
  console.error = saved
  s.stop()
  expect(s.seen).toHaveLength(1)
  expect(refused).toBe(1)
  expect(errors).toHaveBeenCalledWith('heartbeat refused')
})

test('the control URL must be https, or http on 127.0.0.1', () => {
  for (const url of [
    'http://example.com/api/control',
    'http://localhost:3000/api/control',
    'not a url',
    'https://u:p@x.com/c'
  ]) {
    expect(() =>
      startHeartbeat(
        withControl(url),
        () => status([]),
        () => {},
        FAST
      )
    ).toThrow()
  }
  startHeartbeat(
    withControl('https://tolong.example.com/api/control'),
    () => status([]),
    () => {},
    FAST
  ).stop()
})

test('a network error or a 5xx keeps the events, then sending resumes', async () => {
  let calls = 0
  const s = serve(() => {
    calls += 1
    if (calls === 1) return new Response('boom', { status: 503 })
    return ok({ ackedEvents: 2 })
  })
  const problems: string[] = []
  const replies: HeartbeatReply[] = []
  const loop = startHeartbeat(
    withControl(s.url),
    () => status([e1, e2]),
    (r) => replies.push(r),
    {
      ...FAST,
      onProblem: (p) => problems.push(p)
    }
  )
  await until(() => replies.length > 0)
  await loop.stop()
  s.stop()
  expect(s.seen[0]!.body.events).toEqual([e1, e2])
  expect(s.seen[1]!.body.events).toEqual([e1, e2])
  expect(problems).toEqual(['heartbeat answered 503'])
  expect(replies[0]!.ackedEvents).toBe(2)

  const down = mock(async () => {
    throw new TypeError('connect ECONNREFUSED http://127.0.0.1:1/api/control?token=SECRET')
  })
  const reported: string[] = []
  const dead = startHeartbeat(
    withControl('http://127.0.0.1:1/api/control'),
    () => status([e1]),
    () => {},
    {
      ...FAST,
      fetchFn: down as unknown as typeof fetch,
      onProblem: (p) => reported.push(p)
    }
  )
  await until(() => down.mock.calls.length >= 3)
  await dead.stop()
  // The error's own text (which can hold the URL) is never kept.
  expect(reported).toEqual(['heartbeat not delivered (TypeError)'])
})

test('a 400 halves the batch until the lone bad event is dropped; the good ones still go', async () => {
  const bad = event(2, 'error', { bad: true })
  const events = [e1, bad, e3]
  const dropped: MeetingEvent[] = []
  const s = serve((_req, body) =>
    body.events.some((e) => e.data.bad === true)
      ? Response.json({ error: 'invalid request' }, { status: 400 })
      : ok({ ackedEvents: body.events.length })
  )
  let queue = [...events]
  const loop = startHeartbeat(
    withControl(s.url),
    () => status(queue),
    (r) => void (queue = queue.slice(r.ackedEvents)),
    { ...FAST, onRejectedEvent: (e) => void ((queue = queue.slice(1)), dropped.push(e)) }
  )
  await until(() => queue.length === 0)
  await loop.stop()
  s.stop()
  expect(dropped).toEqual([bad])
  const sizes = s.seen.map((r) => r.body.events.length)
  expect(sizes.slice(0, 3)).toEqual([3, 2, 1])
})

test('a 400 that an empty heartbeat also gets drops no event', async () => {
  const s = serve(() => Response.json({ error: 'invalid request' }, { status: 400 }))
  const dropped: MeetingEvent[] = []
  const problems: string[] = []
  const loop = startHeartbeat(
    withControl(s.url),
    () => status([e1]),
    () => {},
    {
      ...FAST,
      onRejectedEvent: (e) => dropped.push(e),
      onProblem: (p) => problems.push(p)
    }
  )
  await until(() => s.seen.length >= 3)
  await loop.stop()
  s.stop()
  expect(dropped).toEqual([])
  expect(problems).toEqual(['heartbeat refused as invalid (400) even without events'])
})

test('a reply with an unknown command keeps the known ones; a bad reply is a failure', async () => {
  let n = 0
  const s = serve(() => {
    n += 1
    if (n === 1) return Response.json({ ackedEvents: 0, commands: ['dance', 'stop'], link: 'https://zoom.us/j/1' })
    if (n === 2) return Response.json({ ackedEvents: 9, commands: [], link: null })
    return ok()
  })
  const replies: HeartbeatReply[] = []
  const problems: string[] = []
  const loop = startHeartbeat(
    withControl(s.url),
    () => status([e1]),
    (r) => replies.push(r),
    {
      ...FAST,
      onProblem: (p) => problems.push(p)
    }
  )
  await until(() => replies.length >= 2)
  await loop.stop()
  s.stop()
  expect(replies[0]).toEqual({ ackedEvents: 0, commands: ['stop'], link: 'https://zoom.us/j/1' })
  expect(problems).toEqual([
    'heartbeat reply held a command this worker does not know; it was ignored',
    'heartbeat reply is not valid'
  ])
})

test('flush sends until nothing is left and says whether the server took it', async () => {
  const s = serve((_req, body) => ok({ ackedEvents: body.events.length }))
  let queue = [e1, e2, e3]
  const loop = startHeartbeat(
    withControl(s.url),
    () => status(queue),
    (r) => void (queue = queue.slice(r.ackedEvents)),
    { intervalMs: 60_000 }
  )
  await until(() => s.seen.length === 1)
  queue = [e1, e2, e3]
  expect(await loop.flush()).toBe(true)
  expect(queue).toEqual([])
  s.stop()
  expect(await loop.flush()).toBe(false)
  await loop.stop()
})

test('the outbox acknowledges from the front', async () => {
  const o = await EventOutbox.open(dir, 1)
  ;[e1, e2, e3].forEach((e) => o.push(e))
  expect(o.pending(2)).toEqual([e1, e2])
  o.ack(2)
  expect(o.pending()).toEqual([e3])
  expect(() => o.ack(2)).toThrow(RangeError)
  await o.settled()
})

test('the outbox survives a restart, in order', async () => {
  const first = await EventOutbox.open(dir, 1)
  ;[e1, e2, e3].forEach((e) => first.push(e))
  first.ack(1)
  await first.settled()
  const again = await EventOutbox.open(dir, 1)
  expect(again.pending()).toEqual([e2, e3])
})

test('a later attempt adopts the unsent events but not the plain state changes', async () => {
  const first = await EventOutbox.open(dir, 1)
  const state = event(2, 'state', { state: 'in_meeting' })
  const account = event(3, 'state', { account: 'google', signedIn: false })
  ;[e1, state, account].forEach((e) => first.push(e))
  await first.settled()
  const second = await EventOutbox.open(dir, 2)
  second.push(event(4))
  await second.settled()
  expect(second.pending()).toEqual([e1, account, event(4)])
  expect(await readdir(dir)).toEqual(['attempt_2.jsonl'])
  expect((await EventOutbox.open(dir, 2)).pending()).toHaveLength(3)
})

test('a damaged outbox file is set aside, its readable start kept, and the outbox opens', async () => {
  const o = await EventOutbox.open(dir, 1)
  ;[e1, e2].forEach((e) => o.push(e))
  await o.settled()
  // A line cut short by a crash, then a good line that cannot be trusted to be in order.
  await appendFile(join(dir, 'attempt_1.jsonl'), `{"occurrenceId":"occ-1","att\n${JSON.stringify(e3)}\n`)
  const again = await EventOutbox.open(dir, 1)
  expect(again.pending()).toEqual([e1, e2])
  expect(again.damaged).toEqual(['attempt_1.jsonl.damaged'])
  expect(await readFile(join(dir, 'attempt_1.jsonl.damaged'), 'utf8')).toContain('"att')
  expect((await EventOutbox.open(dir, 1)).damaged).toEqual([])

  // A damaged file of an earlier attempt is adopted as far as it reads.
  await writeFile(join(dir, 'attempt_2.jsonl'), `${JSON.stringify(e3)}\nnot json\n`)
  const third = await EventOutbox.open(dir, 3)
  expect(third.pending()).toEqual([e1, e2, e3])
  expect(third.damaged).toEqual(['attempt_2.jsonl.damaged'])
  expect((await readdir(dir)).sort()).toEqual(['attempt_1.jsonl.damaged', 'attempt_2.jsonl.damaged', 'attempt_3.jsonl'])
})

// events.jsonl as the worker writes it: every event of every attempt, in order.
async function writeLog(events: MeetingEvent[]): Promise<string> {
  const file = join(dir, 'events.jsonl')
  await writeFile(file, events.map((e) => `${JSON.stringify(e)}\n`).join(''))
  return file
}
const at = (n: number, state: string, attempt = 1): MeetingEvent => ({
  ...event(n, 'state', { state }),
  attempt,
  at: `2026-10-21T12:00:${String(n).padStart(2, '0')}.000Z`
})

test('a restarted worker reports the state before the first change the server never got', async () => {
  const outbox = join(dir, 'outbox')
  await mkdir(outbox)
  const [a, b, c, d] = [at(1, 'verifying_accounts'), at(2, 'watching_for_link'), at(3, 'joining'), at(4, 'in_meeting')]
  const log = await writeLog([a, b, c, d])
  // The server heard of a and b; c and d are still in the outbox (with an error event between them).
  await writeFile(join(outbox, 'attempt_1.jsonl'), [c, event(5), d].map((e) => `${JSON.stringify(e)}\n`).join(''))
  expect(await acknowledgedState(outbox, 2, log)).toBe('watching_for_link')

  // Everything was sent: the last state change stands.
  await writeFile(join(outbox, 'attempt_1.jsonl'), '')
  expect(await acknowledgedState(outbox, 2, log)).toBe('in_meeting')

  // Nothing was sent: the worker started in `starting`.
  await writeFile(join(outbox, 'attempt_1.jsonl'), [a, b].map((e) => `${JSON.stringify(e)}\n`).join(''))
  expect(await acknowledgedState(outbox, 2, log)).toBe('starting')
})

test('a damaged earlier outbox file falls back to the state the attempt began in', async () => {
  const outbox = join(dir, 'outbox')
  await mkdir(outbox)
  const [a, b, c] = [at(1, 'verifying_accounts'), at(2, 'watching_for_link'), at(3, 'joining')]
  const log = await writeLog([a, b, c])
  // The server heard of a and b; c is unsent.
  await writeFile(join(outbox, 'attempt_1.jsonl'), `${JSON.stringify(c)}\n`)
  expect(await acknowledgedState(outbox, 2, log)).toBe('watching_for_link')

  // The same file, with a line cut short after c: the log cannot show what the damaged part held.
  await writeFile(join(outbox, 'attempt_1.jsonl'), `${JSON.stringify(c)}\n{"occurrenceId":"occ-1","at\n`)
  expect(await acknowledgedState(outbox, 2, log)).toBe('starting')
})

test("only worker states count, and a second restart does not trust the first restart's log", async () => {
  const outbox = join(dir, 'outbox')
  await mkdir(outbox)
  const log = await writeLog([at(1, 'in_meeting'), at(2, 'leaving'), at(3, 'uploading'), at(4, 'transcribing')])
  expect(await acknowledgedState(outbox, 2, log)).toBe('uploading')

  // Attempt 2 began from `leaving` (what the server had), logged two changes and sent neither; it then died.
  await rememberState(outbox, 2, 'leaving')
  const [x, y] = [at(5, 'uploading', 2), at(6, 'transcribing', 2)]
  const both = await writeLog([at(1, 'in_meeting'), at(2, 'leaving'), at(3, 'uploading'), x, y])
  await writeFile(join(outbox, 'attempt_2.jsonl'), [x, y].map((e) => `${JSON.stringify(e)}\n`).join(''))
  expect(await acknowledgedState(outbox, 3, both)).toBe('leaving')
  // Once x is sent, y is the first change the server lacks.
  await writeFile(join(outbox, 'attempt_2.jsonl'), `${JSON.stringify(y)}\n`)
  expect(await acknowledgedState(outbox, 3, both)).toBe('uploading')
})

test("the wait after a failure doubles from 1 s to a cap of 10 s, under the monitor's 30 s window", () => {
  expect([1, 2, 3, 4, 5, 6, 20].map((n) => backoffDelayMs(n))).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000, 10_000])
})

test('narrowing down a 400 does not wait, even when the backoff is long', async () => {
  const bad = event(2, 'error', { bad: true })
  const s = serve((_req, body) =>
    body.events.some((e) => e.data.bad === true)
      ? Response.json({ error: 'invalid request' }, { status: 400 })
      : ok({ ackedEvents: body.events.length })
  )
  let queue = [e1, bad, e3]
  const loop = startHeartbeat(
    withControl(s.url),
    () => status(queue),
    (r) => void (queue = queue.slice(r.ackedEvents)),
    {
      intervalMs: 20,
      backoff: { firstMs: 60_000, maxMs: 60_000 },
      onRejectedEvent: () => void (queue = queue.slice(1))
    }
  )
  // 3 events refused, then 2, then 1 goes: all within a moment, though a failure would wait a minute.
  await until(() => s.seen.length >= 3, 1000)
  await loop.stop()
  s.stop()
  expect(s.seen.slice(0, 3).map((r) => r.body.events.length)).toEqual([3, 2, 1])
})

test('a reply body over 64 KB is refused unread', async () => {
  const s = serve(
    () => new Response(JSON.stringify({ ackedEvents: 0, commands: ['stop'], link: null, pad: 'x'.repeat(70_000) }))
  )
  const replies: HeartbeatReply[] = []
  const problems: string[] = []
  const loop = startHeartbeat(
    withControl(s.url),
    () => status([]),
    (r) => replies.push(r),
    { ...FAST, onProblem: (p) => problems.push(p) }
  )
  await until(() => s.seen.length >= 2)
  await loop.stop()
  s.stop()
  expect(replies).toEqual([])
  expect(problems).toEqual(['heartbeat reply is not valid'])
})

test('commands run in order and leave runs once per batch', async () => {
  const calls: string[] = []
  const h = {
    leave: async () => void calls.push('leave'),
    stop: async () => void calls.push('stop'),
    pause: async () => void calls.push('pause'),
    resume: async () => void calls.push('resume')
  }
  const batch: ControlCommand[] = ['pause_for_signin', 'leave_now', 'take_over', 'resume_after_signin', 'stop']
  await dispatchCommands(batch, h)
  expect(calls).toEqual(['pause', 'leave', 'resume', 'stop'])
})

test('the pasted link wins once; the same or a refused link changes nothing', async () => {
  let refused = 0
  const o = new LinkOverride({
    normalise: (u) => (u.startsWith('https://zoom.us/') ? u : null),
    onRefused: () => refused++
  })
  const first = o.next()
  o.offer(null)
  expect(o.current()).toBeNull()
  o.offer('https://evil.example/j/1')
  o.offer('https://evil.example/j/1')
  expect(refused).toBe(1)
  o.offer('https://zoom.us/wc/join/1')
  expect(await first).toBe('https://zoom.us/wc/join/1')
  const second = o.next()
  o.offer('https://zoom.us/wc/join/1')
  o.offer('https://zoom.us/wc/join/2')
  expect(await second).toBe('https://zoom.us/wc/join/2')
  expect(o.current()).toBe('https://zoom.us/wc/join/2')
})

test('site links come from TM_PUBLIC_URL', () => {
  expect(siteLinks(cfg, undefined)).toBeNull()
  expect(siteLinks(cfg, 'https://tolong.example.com/')).toEqual({
    meetingPage: 'https://tolong.example.com/meetings/occ-1',
    signIn: 'https://tolong.example.com/accounts/ident-1/signin',
    leave: 'https://tolong.example.com/meetings/occ-1/leave',
    takeOver: 'https://tolong.example.com/meetings/occ-1/take-over'
  })
  expect(() => siteLinks(cfg, 'http://tolong.example.com')).toThrow('TM_PUBLIC_URL must be an https URL')
})
