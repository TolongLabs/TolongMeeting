import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { link, mkdir, mkdtemp, open, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPLOAD_CHUNK_MAX_BYTES, type DeviceAuth, type OccurrenceState } from '@tm/core'
import { count, eq, sql } from 'drizzle-orm'
import { companionEvents, companionJobs, events, occurrences, type Db } from '../db'
import { claimJob, createCompanionJob, releaseJob } from '../db/companion'
import { localRunPayload, seedCompanionFixture } from '../db/companion.fixtures'
import { FakeNotifier } from '../db/notifier'
import { QUEUES } from '../db/queues'
import { createTestDb, dropAllTestDbs, FakeQueue } from '../db/testing'
import {
  OCCURRENCE_UPLOAD_MAX_BYTES,
  OCCURRENCE_UPLOAD_MAX_FILES,
  completeLocalRun,
  handleFilesRequest,
  handleHeartbeatRequest,
  handlePreflightRequest,
  isUploadPath,
  recordPreflight,
  type LocalRunDeps
} from '../lib/companion/local-runs'
import { handleFailRequest, reportFailure, type FailDeps } from '../lib/companion/native'
import { handleDeviceHeartbeat } from '../lib/control'
import { createDeviceScope } from '../lib/companion/scope'

afterAll(dropAllTestDbs, 60_000)

const JOB_URL = 'https://tm.example/api/companion/jobs/x'
const WHISPER = JSON.stringify({ segments: [{ start: 1, end: 2, text: ' hello' }] })
/** The start of a Matroska file: the EBML header's magic, then filler. */
const MKV = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])

let db: Db
let f: Awaited<ReturnType<typeof seedCompanionFixture>>
let queue: FakeQueue
let notifier: FakeNotifier
let root: string
let deps: LocalRunDeps
let failDeps: FailDeps

beforeEach(async () => {
  db = await createTestDb()
  f = await seedCompanionFixture(db)
  queue = new FakeQueue()
  notifier = new FakeNotifier()
  root = await mkdtemp(join(tmpdir(), 'tm-local-runs-'))
  deps = { db, queue, notifier, publicUrl: 'https://tm.example', dataRoot: root }
  failDeps = { db, notifier, publicUrl: 'https://tm.example' }
}, 60_000)

afterEach(() => rm(root, { recursive: true, force: true }))

const scope = (d: DeviceAuth) => createDeviceScope(db, d)
const occDir = (id: string) => join(root, 'occurrences', id)

/** A `local_run` job that `device` holds, with the occurrence in `state` at attempt `attempt`. */
async function claimedRun(
  device: DeviceAuth = f.a1,
  o: { native?: boolean; state?: OccurrenceState; attempt?: number } = {}
): Promise<string> {
  await db
    .update(occurrences)
    .set({ state: o.state ?? 'starting', attempt: o.attempt ?? 1 })
    .where(eq(occurrences.id, f.occA))
  const payload = localRunPayload(f.occA)
  payload.job.entry.transcription = o.native ? 'native' : 'live'
  const id = await createCompanionJob(db, {
    memberId: f.a1.memberId,
    occurrenceId: f.occA,
    kind: 'local_run',
    payload,
    targetDeviceId: f.a1.deviceId
  })
  await db.execute(sql`update device_tokens set last_used_at = now() where id = ${device.deviceId}`)
  expect(await claimJob(db, device, id)).toMatchObject({ state: 'claimed' })
  return id
}

const stateOf = async () => (await db.select().from(occurrences).where(eq(occurrences.id, f.occA)))[0]!
const jobOf = async (id: string) => (await db.select().from(companionJobs).where(eq(companionJobs.id, id)))[0]!
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill)

/** A body that sends `first` and then does what `then` says. */
const bodyThen = (
  first: Uint8Array,
  then: (c: ReadableStreamDefaultController<Uint8Array>) => void | Promise<void>
) => {
  let sent = false
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      if (!sent) {
        sent = true
        c.enqueue(first)
      } else {
        await Bun.sleep(20)
        await then(c)
      }
    }
  })
}

// --- Heartbeats ---

const hb = (occurrenceId: string, state: OccurrenceState, attempt = 1, extra: Record<string, unknown> = {}) => ({
  occurrenceId,
  attempt,
  state,
  recording: true,
  participants: 12,
  events: [],
  ...extra
})
const beat = (device: DeviceAuth, id: string, body: unknown) =>
  handleHeartbeatRequest(new Request(JOB_URL, { method: 'POST', body: JSON.stringify(body) }), scope(device), deps, id)

describe('a heartbeat through the PC', () => {
  test('is applied only for the run this PC holds, and answers like the worker route', async () => {
    const id = await claimedRun()
    const ok = await beat(f.a1, id, hb(f.occA, 'verifying_accounts'))
    expect(ok.status).toBe(200)
    expect(ok.headers.get('cache-control')).toBe('no-store')
    expect(await ok.json()).toMatchObject({ ackedEvents: 0, commands: [] })
    expect((await stateOf()).state).toBe('verifying_accounts')
    expect((await stateOf()).lastHeartbeatAt).not.toBeNull()

    for (const [device, body] of [
      [f.a1, hb(f.occB, 'in_meeting')], // another occurrence than the job's
      [f.a2, hb(f.occA, 'in_meeting')], // another device of the same member
      [f.b1, hb(f.occA, 'in_meeting')] // another member's device
    ] as const) {
      const res = await beat(device, id, body)
      expect([res.status, await res.json()]).toEqual([404, { error: 'not_found' }])
    }
    expect((await stateOf()).state).toBe('verifying_accounts')
    expect((await beat(f.a1, 'not-a-uuid', hb(f.occA, 'in_meeting'))).status).toBe(404)
  })

  test('needs the attempt the server stores, and a body of the right shape', async () => {
    const id = await claimedRun()
    expect((await beat(f.a1, id, hb(f.occA, 'verifying_accounts', 2))).status).toBe(400)
    expect((await beat(f.a1, id, { occurrenceId: f.occA })).status).toBe(400)
    expect((await beat(f.a1, id, null)).status).toBe(400)
    expect((await stateOf()).state).toBe('starting')
  })

  test('is refused after the lease is gone, and for a job that is not a local run', async () => {
    const id = await claimedRun()
    expect(await releaseJob(db, f.a1, id)).toBe(true)
    expect((await beat(f.a1, id, hb(f.occA, 'verifying_accounts'))).status).toBe(404)
  })

  test('cannot move the occurrence to a state a worker may not enter, or drop its events outside the server clock', async () => {
    const id = await claimedRun(f.a1, { state: 'in_meeting' })
    const stamp = (ms: number) => new Date(Date.now() + ms).toISOString()
    const event = (at: string) => ({ occurrenceId: f.occA, attempt: 1, at, type: 'joined', data: {} })
    const res = await beat(f.a1, id, hb(f.occA, 'completed', 1, { events: [event(stamp(48 * 3_600_000))] }))
    expect(res.status).toBe(200)
    expect((await stateOf()).state).toBe('in_meeting')
    const types = await db.select({ type: events.type, data: events.data }).from(events)
    expect(types).toContainEqual({ type: 'error', data: { reason: 'event_out_of_range' } })
    expect(types.filter((e) => e.type === 'joined')).toEqual([])
    // An event inside the window is stored.
    await beat(f.a1, id, hb(f.occA, 'in_meeting', 1, { events: [event(stamp(-1000))] }))
    expect((await db.select({ n: count() }).from(events).where(eq(events.type, 'joined')))[0]!.n).toBe(1)
  })

  test('stores the link the worker joined with without its passcode, and ignores a link that is not a meeting', async () => {
    const id = await claimedRun(f.a1, { state: 'joining' })
    const linkUsed = await db.select({ link: occurrences.linkUsed }).from(occurrences).where(eq(occurrences.id, f.occA))
    expect(linkUsed[0]!.link).toBeNull()
    await beat(
      f.a1,
      id,
      hb(f.occA, 'in_lobby', 1, { linkUsed: 'https://us02web.zoom.us/j/84123456789?pwd=hunter2&uname=Bot' })
    )
    const stored = async () =>
      (await db.select({ link: occurrences.linkUsed }).from(occurrences).where(eq(occurrences.id, f.occA)))[0]!.link
    const first = await stored()
    expect(first).toContain('/j/84123456789')
    expect(first).not.toContain('hunter2')
    await beat(f.a1, id, hb(f.occA, 'in_lobby', 1, { linkUsed: 'https://evil.example/phish?pwd=hunter2' }))
    expect(await stored()).toBe(first)
  })

  test('a failed write reaches the logs without its SQL parameters', async () => {
    const id = await claimedRun(f.a1, { state: 'in_meeting' })
    // A constraint that refuses the event: the insert fails with the event's data among its parameters.
    await db.execute(sql`alter table events add constraint no_secret_events check (type <> 'joined')`)
    const event = {
      occurrenceId: f.occA,
      attempt: 1,
      at: new Date().toISOString(),
      type: 'joined',
      data: { who: 'secret-name' }
    }
    const error = await handleDeviceHeartbeat(
      { db, queue, notifier, publicUrl: 'https://tm.example', now: new Date() },
      f.a1,
      id,
      hb(f.occA, 'in_meeting', 1, { events: [event] })
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(
      `${(error as Error).message} ${(error as Error).stack} ${JSON.stringify((error as Error).cause)}`
    ).not.toMatch(/secret|insert into|params/i)
  })

  test('holds a reported transcribing at uploading and never queues the pipeline', async () => {
    const id = await claimedRun(f.a1, { state: 'uploading' })
    expect((await beat(f.a1, id, hb(f.occA, 'transcribing'))).status).toBe(200)
    expect((await stateOf()).state).toBe('uploading')
    expect(queue.sent).toEqual([])
  })

  test('a restart notice crashes the run once, bumps the attempt and pings once; the next heartbeat resumes', async () => {
    const id = await claimedRun(f.a1, { state: 'in_meeting' })
    for (let i = 0; i < 3; i++) expect((await beat(f.a1, id, hb(f.occA, 'restarting', 2))).status).toBe(200)
    expect(await stateOf()).toMatchObject({ state: 'restarting', attempt: 2, restarts: 1, resumeState: 'in_meeting' })
    expect(notifier.sent).toHaveLength(1)
    expect(notifier.sent[0]!.ping.title).toBe('Restarting: Data Mining')
    expect(notifier.sent[0]!.ping.message).toContain('restart 1 of 3')
    // Attempt 1 is stale now.
    expect((await beat(f.a1, id, hb(f.occA, 'in_meeting', 1))).status).toBe(400)
    expect((await beat(f.a1, id, hb(f.occA, 'in_meeting', 2))).status).toBe(200)
    expect(await stateOf()).toMatchObject({ state: 'in_meeting', attempt: 2, restarts: 1 })
  })

  test('the fourth restart fails the run, tells the PC to stop and pings once', async () => {
    const id = await claimedRun(f.a1, { state: 'in_meeting' })
    for (let attempt = 2; attempt <= 4; attempt++) {
      await beat(f.a1, id, hb(f.occA, 'restarting', attempt))
      await beat(f.a1, id, hb(f.occA, 'in_meeting', attempt))
    }
    expect((await stateOf()).restarts).toBe(3)
    const last = await beat(f.a1, id, hb(f.occA, 'restarting', 5))
    expect(await last.json()).toMatchObject({ commands: ['stop'] })
    expect(await stateOf()).toMatchObject({ state: 'failed', stateReason: 'worker_unresponsive' })
    expect(await jobOf(id)).toMatchObject({ state: 'failed', error: 'worker_unresponsive' })
    expect(notifier.sent.map((s) => s.ping.title)).toEqual([
      'Restarting: Data Mining',
      'Restarting: Data Mining',
      'Restarting: Data Mining',
      'Failed: Data Mining'
    ])
    // The job is no longer held: nothing more is accepted.
    expect((await beat(f.a1, id, hb(f.occA, 'restarting', 6))).status).toBe(404)
  })
})

// --- Pre-flight ---

describe('the pre-flight report', () => {
  test('Docker not running pings once; ok clears it; the problem pings again when it comes back', async () => {
    const id = await claimedRun()
    const report = { reason: 'docker_unavailable', dockerMemBytes: null } as const
    await recordPreflight(deps, f.a1, id, report)
    await recordPreflight(deps, f.a1, id, report)
    expect(notifier.sent).toHaveLength(1)
    expect(notifier.sent[0]!.ping).toMatchObject({ title: 'Start Docker Desktop: Data Mining', priority: 'high' })
    expect(notifier.sent[0]!.ping.message).toContain('DESKTOP-ABC')
    expect(notifier.sent[0]!.ping.message).toContain('before 13:50')
    expect((await jobOf(id)).error).toBe('docker_unavailable')
    await recordPreflight(deps, f.a1, id, { reason: 'ok', dockerMemBytes: null })
    expect((await jobOf(id)).error).toBeNull()
    await recordPreflight(deps, f.a1, id, report)
    await recordPreflight(deps, f.a1, id, { reason: 'image_unavailable', dockerMemBytes: null })
    expect(notifier.sent.map((s) => s.ping.title)).toEqual([
      'Start Docker Desktop: Data Mining',
      'Start Docker Desktop: Data Mining',
      "Can't get the bot software: Data Mining"
    ])
  })

  test('low memory fails the job and the run and pings', async () => {
    const id = await claimedRun()
    await recordPreflight(deps, f.a1, id, { reason: 'docker_memory_low', dockerMemBytes: 2 * 1024 ** 3 })
    expect(await stateOf()).toMatchObject({ state: 'failed', stateReason: 'docker_memory_low' })
    expect(await jobOf(id)).toMatchObject({ state: 'failed', error: 'docker_memory_low' })
    expect(notifier.sent).toHaveLength(1)
    expect(notifier.sent[0]!.ping.message).toContain('Docker Desktop has 2.0 GB')
  })

  test('is for the holding device only, and the route checks the body', async () => {
    const id = await claimedRun()
    const post = (device: DeviceAuth, body: string) =>
      handlePreflightRequest(new Request(JOB_URL, { method: 'POST', body }), scope(device), deps, id)
    expect((await post(f.a2, '{"reason":"docker_unavailable","dockerMemBytes":null}')).status).toBe(404)
    expect((await post(f.a1, '{"reason":"nope","dockerMemBytes":null}')).status).toBe(400)
    expect((await post(f.a1, 'x'.repeat(2000))).status).toBe(400)
    expect(notifier.sent).toEqual([])
    expect((await post(f.a1, '{"reason":"docker_unavailable","dockerMemBytes":null}')).status).toBe(204)
    expect(notifier.sent).toHaveLength(1)
  })
})

// --- Uploads ---

test.each([
  ['recording/meeting.mkv', true],
  ['recording/attempt_2_seg_014.mkv', true],
  ['frames/0007_141502.png', true],
  ['chat.jsonl', true],
  ['events.jsonl', true],
  ['forms/f1/record.json', true],
  ['forms/f1/filled.png', true],
  ['transcript/live.jsonl', true],
  ['transcript/native/audio.srt', true],
  ['audio.flac', false],
  ['../other/events.jsonl', false],
  ['forms/../../x.json', false],
  ['/etc/passwd', false],
  ['recording\\meeting.mkv', false],
  ['profiles/u1/work/Cookies', false],
  ['events.jsonl\n', false],
  ['events.jsonl\0.png', false],
  ['events.jsonl.part', false]
])('isUploadPath(%j) is %p', (p, ok) => expect(isUploadPath(p)).toBe(ok))

const put = (
  device: DeviceAuth,
  id: string,
  path: string,
  range: string,
  body: BodyInit | null,
  d: LocalRunDeps = deps
) =>
  handleFilesRequest(
    new Request(`${JOB_URL}/files/${path}`, {
      method: 'PUT',
      headers: { 'content-range': range },
      body,
      // @ts-expect-error Bun and Node need `duplex` for a streamed body
      duplex: 'half'
    }),
    scope(device),
    d,
    id,
    path.split('/')
  )
const head = (device: DeviceAuth, id: string, path: string) =>
  handleFilesRequest(
    new Request(`${JOB_URL}/files/${path}`, { method: 'HEAD' }),
    scope(device),
    deps,
    id,
    path.split('/')
  )
const offsetOf = async (id: string, path: string) => Number((await head(f.a1, id, path)).headers.get('upload-offset'))
const send = async (id: string, path: string, content: Uint8Array | string) => {
  const data = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content)
  const res = await put(f.a1, id, path, `bytes 0-${data.length - 1}/${data.length}`, data)
  expect(res.status).toBe(204)
}

describe('uploads', () => {
  test('resume at the server offset, refuse gaps and overlaps, and rename only when whole', async () => {
    const id = await claimedRun()
    expect(await offsetOf(id, 'chat.jsonl')).toBe(0)
    expect((await put(f.a1, id, 'chat.jsonl', 'bytes 0-9/20', bytes(10))).status).toBe(204)
    expect(await offsetOf(id, 'chat.jsonl')).toBe(10)
    expect((await readdir(occDir(f.occA))).sort()).toEqual(['chat.jsonl.part'])

    const gap = await put(f.a1, id, 'chat.jsonl', 'bytes 15-19/20', bytes(5))
    expect([gap.status, gap.headers.get('upload-offset')]).toEqual([409, '10'])
    const overlap = await put(f.a1, id, 'chat.jsonl', 'bytes 5-14/20', bytes(10))
    expect([overlap.status, overlap.headers.get('upload-offset')]).toEqual([409, '10'])
    expect((await stat(join(occDir(f.occA), 'chat.jsonl.part'))).size).toBe(10)

    expect((await put(f.a1, id, 'chat.jsonl', 'bytes 10-19/20', bytes(10))).status).toBe(204)
    expect((await readdir(occDir(f.occA))).sort()).toEqual(['chat.jsonl'])
    expect((await stat(join(occDir(f.occA), 'chat.jsonl'))).size).toBe(20)
    expect(await offsetOf(id, 'chat.jsonl')).toBe(20)
    // A finished file is never extended or replaced.
    const again = await put(f.a1, id, 'chat.jsonl', 'bytes 0-9/20', bytes(10))
    expect([again.status, again.headers.get('upload-offset')]).toEqual([409, '20'])
  })

  test('go to fixed paths only', async () => {
    const id = await claimedRun()
    for (const path of ['audio.flac', 'profiles/u1/Cookies', 'forms/f1/other.json', 'events.jsonl.part']) {
      expect([path, (await put(f.a1, id, path, 'bytes 0-9/10', bytes(10))).status]).toEqual([path, 400])
      expect([path, (await head(f.a1, id, path)).status]).toEqual([path, 404])
    }
    // A client-built traversal never reaches the file system.
    const res = await handleFilesRequest(
      new Request(JOB_URL, { method: 'PUT', headers: { 'content-range': 'bytes 0-9/10' }, body: bytes(10) }),
      scope(f.a1),
      deps,
      id,
      ['..', f.occB, 'events.jsonl']
    )
    expect(res.status).toBe(400)
    expect(await readdir(root).catch(() => [])).toEqual([])
    await send(id, 'forms/f1/record.json', '{}')
    expect(await readFile(join(occDir(f.occA), 'forms', 'f1', 'record.json'), 'utf8')).toBe('{}')
  })

  test('refuse a strange Content-Range, a short or long body and a chunk over 16 MiB', async () => {
    const id = await claimedRun()
    for (const range of [
      '',
      'bytes 0-9',
      'bytes 0-9/*',
      'bytes 9-0/20',
      'bytes 0-20/20',
      'bytes -1-9/20',
      'items 0-9/20',
      'bytes 0-99999999999999999/99999999999999999'
    ]) {
      expect([range, (await put(f.a1, id, 'chat.jsonl', range, bytes(10))).status]).toEqual([range, 400])
    }
    expect((await put(f.a1, id, 'chat.jsonl', 'bytes 0-9/20', bytes(9))).status).toBe(400)
    expect((await put(f.a1, id, 'chat.jsonl', 'bytes 0-9/20', bytes(11))).status).toBe(400)
    expect((await put(f.a1, id, 'chat.jsonl', 'bytes 0-9/20', null)).status).toBe(400)
    const over = UPLOAD_CHUNK_MAX_BYTES + 1
    expect((await put(f.a1, id, 'recording/meeting.mkv', `bytes 0-${over - 1}/${over}`, bytes(over))).status).toBe(400)
    // A failed chunk leaves nothing: the next one still starts at 0.
    expect(await offsetOf(id, 'chat.jsonl')).toBe(0)
  })

  test('enforce the file cap and the occurrence cap while reading', async () => {
    const id = await claimedRun()
    const mb = 1024 ** 2
    expect((await put(f.a1, id, 'events.jsonl', `bytes 0-9/${257 * mb}`, bytes(10))).status).toBe(413)
    expect((await put(f.a1, id, 'frames/0001_000001.png', `bytes 0-9/${21 * mb}`, bytes(10))).status).toBe(413)
    expect((await put(f.a1, id, 'recording/meeting.mkv', `bytes 0-9/${9 * 1024 * mb}`, bytes(10))).status).toBe(413)
    // Two sparse files fill the occurrence; the next chunk goes over the total.
    const dir = join(occDir(f.occA), 'recording')
    await mkdir(dir, { recursive: true })
    for (const [name, size] of [
      ['meeting.mkv', 8 * 1024 * mb],
      ['attempt_1_seg_001.mkv', OCCURRENCE_UPLOAD_MAX_BYTES - 8 * 1024 * mb - 5]
    ] as const) {
      const handle = await open(join(dir, name), 'w')
      await handle.truncate(size)
      await handle.close()
    }
    const res = await put(f.a1, id, 'chat.jsonl', 'bytes 0-9/10', bytes(10))
    expect(res.status).toBe(413)
    expect(await readdir(occDir(f.occA))).not.toContain('chat.jsonl')
  })

  test('refuse a link in the occurrence folder and write nothing through it', async () => {
    const id = await claimedRun()
    const outside = join(root, 'outside')
    await mkdir(outside)
    await mkdir(occDir(f.occA), { recursive: true })
    await symlink(outside, join(occDir(f.occA), 'forms'))
    expect((await put(f.a1, id, 'forms/f1/record.json', 'bytes 0-1/2', bytes(2))).status).toBe(409)
    await writeFile(join(outside, 'target'), 'keep')
    await symlink(join(outside, 'target'), join(occDir(f.occA), 'chat.jsonl.part'))
    expect((await put(f.a1, id, 'chat.jsonl', 'bytes 0-1/2', bytes(2))).status).toBe(409)
    await symlink(join(outside, 'target'), join(occDir(f.occA), 'events.jsonl'))
    expect((await put(f.a1, id, 'events.jsonl', 'bytes 0-1/2', bytes(2))).status).toBe(409)
    expect(await readdir(outside)).toEqual(['target'])
    expect(await readFile(join(outside, 'target'), 'utf8')).toBe('keep')
  })

  test('are accepted only while this device holds the job', async () => {
    const id = await claimedRun()
    expect((await put(f.a2, id, 'chat.jsonl', 'bytes 0-1/2', bytes(2))).status).toBe(404)
    expect((await put(f.b1, id, 'chat.jsonl', 'bytes 0-1/2', bytes(2))).status).toBe(404)
    expect((await head(f.a2, id, 'chat.jsonl')).status).toBe(404)
    expect(await releaseJob(db, f.a1, id)).toBe(true)
    expect((await put(f.a1, id, 'chat.jsonl', 'bytes 0-1/2', bytes(2))).status).toBe(404)
    expect((await head(f.a1, id, 'chat.jsonl')).status).toBe(404)
    expect(await readdir(root)).toEqual([])
  })

  test('a lease that ends while the body arrives takes nothing', async () => {
    const id = await claimedRun()
    // The lease ends in the middle of the body, after the first bytes have been taken.
    const body = bodyThen(bytes(5), async (c) => {
      await releaseJob(db, f.a1, id)
      c.enqueue(bytes(5))
      c.close()
    })
    expect((await put(f.a1, id, 'chat.jsonl', 'bytes 0-9/10', body)).status).toBe(404)
    expect(await readdir(occDir(f.occA))).toEqual(['chat.jsonl.part'])
    expect((await stat(join(occDir(f.occA), 'chat.jsonl.part'))).size).toBe(0)
  })

  test('two requests for one file do not write at once', async () => {
    const id = await claimedRun()
    let release!: () => void
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(5))
        release = () => {
          controller.enqueue(bytes(5))
          controller.close()
        }
      }
    })
    const first = put(f.a1, id, 'chat.jsonl', 'bytes 0-9/10', stalled)
    await Bun.sleep(100)
    const second = await put(f.a1, id, 'chat.jsonl', 'bytes 0-9/10', bytes(10))
    expect(second.status).toBe(409)
    release()
    expect((await first).status).toBe(204)
    expect((await stat(join(occDir(f.occA), 'chat.jsonl'))).size).toBe(10)
  })

  test('a body that stalls or trickles is cut off with a 408 and leaves nothing', async () => {
    const id = await claimedRun()
    const stalled = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(bytes(3)) })
    const slow = { ...deps, deadlines: { idleMs: 80 } }
    expect((await put(f.a1, id, 'chat.jsonl', 'bytes 0-9/10', stalled, slow)).status).toBe(408)
    const trickle = new ReadableStream<Uint8Array>({
      async pull(c) {
        await Bun.sleep(30)
        c.enqueue(bytes(1))
      }
    })
    const total = { ...deps, deadlines: { idleMs: 1000, totalMs: 150 } }
    expect((await put(f.a1, id, 'chat.jsonl', 'bytes 0-9/10', trickle, total)).status).toBe(408)
    expect(await offsetOf(id, 'chat.jsonl')).toBe(0)
  })

  test('a 12 MB chunk arrives whole through the route', async () => {
    const id = await claimedRun()
    const size = 12 * 1000 * 1000
    const data = new Uint8Array(size)
    for (let i = 0; i < size; i += 4096) data[i] = (i / 4096) % 251
    const res = await put(f.a1, id, 'recording/meeting.mkv', `bytes 0-${size - 1}/${size}`, data)
    expect(res.status).toBe(204)
    const stored = await readFile(join(occDir(f.occA), 'recording', 'meeting.mkv'))
    expect(stored.length).toBe(size)
    expect(Buffer.compare(stored, Buffer.from(data))).toBe(0)
  })
})

describe('uploads that the PC or a worker makes hard', () => {
  const partOf = (path: string) => join(occDir(f.occA), `${path}.part`)

  test('a body that breaks off is a 400, truncated back to where the chunk started', async () => {
    const id = await claimedRun()
    expect((await put(f.a1, id, 'chat.jsonl', 'bytes 0-4/10', bytes(5))).status).toBe(204)
    const broken = bodyThen(bytes(3), (c) => c.error(new Error('the connection broke')))
    const res = await put(f.a1, id, 'chat.jsonl', 'bytes 5-9/10', broken)
    expect(res.status).toBe(400)
    expect((await stat(partOf('chat.jsonl'))).size).toBe(5)
    // The chunk's claimed bytes were given back: the same chunk goes through.
    expect((await put(f.a1, id, 'chat.jsonl', 'bytes 5-9/10', bytes(5))).status).toBe(204)
    expect((await stat(join(occDir(f.occA), 'chat.jsonl'))).size).toBe(10)
  })

  test('a body that sends too much is a 400 and leaves the file as it was', async () => {
    const id = await claimedRun()
    expect(
      (
        await put(
          f.a1,
          id,
          'chat.jsonl',
          'bytes 0-4/10',
          bodyThen(bytes(4), (c) => c.enqueue(bytes(4)))
        )
      ).status
    ).toBe(400)
    expect((await stat(partOf('chat.jsonl'))).size).toBe(0)
  })

  test('a name that is not a lone regular file is the fixed 409, and a pipe does not hang the request', async () => {
    const id = await claimedRun()
    await mkdir(occDir(f.occA), { recursive: true })
    // A folder, a pipe and a second name for another file, each planted where the `.part` goes.
    await mkdir(partOf('chat.jsonl'))
    expect(Bun.spawnSync(['mkfifo', partOf('events.jsonl')]).exitCode).toBe(0)
    await writeFile(join(root, 'other'), 'keep')
    await link(join(root, 'other'), partOf('transcript.jsonl'))
    for (const path of ['chat.jsonl', 'events.jsonl']) {
      const res = await put(f.a1, id, path, 'bytes 0-1/2', bytes(2))
      expect([path, res.status, await res.json()]).toEqual([path, 409, { error: 'out_of_step' }])
    }
    await mkdir(join(occDir(f.occA), 'transcript'))
    await link(join(root, 'other'), join(occDir(f.occA), 'transcript', 'live.jsonl.part'))
    expect((await put(f.a1, id, 'transcript/live.jsonl', 'bytes 0-1/2', bytes(2))).status).toBe(409)
    expect(await readFile(join(root, 'other'), 'utf8')).toBe('keep')
  })

  test('parallel chunks cannot go over the occurrence total together', async () => {
    const id = await claimedRun()
    await mkdir(occDir(f.occA), { recursive: true })
    const fill = await open(join(occDir(f.occA), 'filler'), 'w')
    await fill.truncate(OCCURRENCE_UPLOAD_MAX_BYTES - 15)
    await fill.close()
    // The first chunk has claimed its 10 bytes while its body is still arriving.
    let release!: () => void
    const stalled = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes(5))
        release = () => {
          c.enqueue(bytes(5))
          c.close()
        }
      }
    })
    const first = put(f.a1, id, 'chat.jsonl', 'bytes 0-9/10', stalled)
    await Bun.sleep(100)
    expect((await put(f.a1, id, 'events.jsonl', 'bytes 0-9/10', bytes(10))).status).toBe(413)
    release()
    expect((await first).status).toBe(204)
    // A failed chunk gives its bytes back.
    expect((await put(f.a1, id, 'events.jsonl', 'bytes 0-4/5', bytes(5))).status).toBe(204)
  })

  test('an occurrence holds at most as many files as the PC will ever send', async () => {
    const id = await claimedRun()
    const dir = join(occDir(f.occA), 'frames')
    await mkdir(dir, { recursive: true })
    const handle = await open(join(dir, 'x'), 'w')
    await handle.close()
    for (let from = 0; from < OCCURRENCE_UPLOAD_MAX_FILES; from += 500) {
      await Promise.all(
        Array.from({ length: Math.min(500, OCCURRENCE_UPLOAD_MAX_FILES - from) }, (_, i) =>
          writeFile(join(dir, `${String(from + i).padStart(4, '0')}_000001.png`), '')
        )
      )
    }
    // 20 000 pictures and the stray file are there; one more file is too many, and so is a new .part.
    const res = await put(f.a1, id, 'chat.jsonl', 'bytes 0-1/2', bytes(2))
    expect([res.status, await res.json()]).toEqual([413, { error: 'too_large' }])
    expect(await readdir(occDir(f.occA))).toEqual(['frames'])
  }, 60_000)

  test('an empty file is sent as bytes */0 with no body, and is a finished file', async () => {
    const id = await claimedRun()
    const empty = () => put(f.a1, id, 'chat.jsonl', 'bytes */0', null)
    expect((await empty()).status).toBe(204)
    expect((await stat(join(occDir(f.occA), 'chat.jsonl'))).size).toBe(0)
    expect(await offsetOf(id, 'chat.jsonl')).toBe(0)
    expect((await empty()).status).toBe(204) // a repeat after a lost answer
    // An empty range with bytes in the body is not empty.
    expect((await put(f.a1, id, 'events.jsonl', 'bytes */0', bytes(3))).status).toBe(400)
    expect((await readdir(occDir(f.occA))).sort()).toEqual(['chat.jsonl', 'events.jsonl.part'])
    // A finished non-empty file is not replaced by an empty one.
    await send(id, 'transcript/live.jsonl', 'x')
    expect((await put(f.a1, id, 'transcript/live.jsonl', 'bytes */0', null)).status).toBe(409)
  })

  test('are refused once the occurrence is no longer running, and a deleted one is gone', async () => {
    const id = await claimedRun()
    expect((await put(f.a1, id, 'chat.jsonl', 'bytes 0-1/4', bytes(2))).status).toBe(204)
    for (const [state, status] of [
      ['failed', 404],
      ['completed', 404],
      ['deleted', 410]
    ] as const) {
      await db.update(occurrences).set({ state }).where(eq(occurrences.id, f.occA))
      expect([state, (await put(f.a1, id, 'chat.jsonl', 'bytes 2-3/4', bytes(2))).status]).toEqual([state, status])
      expect([state, (await head(f.a1, id, 'chat.jsonl')).status]).toEqual([state, status])
      expect([state, await completeLocalRun(deps, f.a1, id)]).toEqual([state, status === 410 ? 'gone' : null])
    }
    expect((await stat(partOf('chat.jsonl'))).size).toBe(2)
    expect((await jobOf(id)).state).toBe('claimed')
  })

  test('a lease that ends because the occurrence was deleted during the body takes nothing', async () => {
    const id = await claimedRun()
    const body = bodyThen(bytes(5), async (c) => {
      await db.update(occurrences).set({ state: 'deleted' }).where(eq(occurrences.id, f.occA))
      c.enqueue(bytes(5))
      c.close()
    })
    expect((await put(f.a1, id, 'chat.jsonl', 'bytes 0-9/10', body)).status).toBe(410)
    expect((await stat(partOf('chat.jsonl'))).size).toBe(0)
  })
})

describe('the small bodies have read deadlines too', () => {
  const stalled = () => new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new TextEncoder().encode('{')) })
  const slow = () => ({ ...deps, deadlines: { idleMs: 80 } })
  const post = (body: ReadableStream<Uint8Array>) =>
    new Request(JOB_URL, {
      method: 'POST',
      body,
      // @ts-expect-error Bun and Node need `duplex` for a streamed body
      duplex: 'half'
    })

  test('a stalled heartbeat, pre-flight or failure report is a 408 and changes nothing', async () => {
    const id = await claimedRun(f.a1, { state: 'uploading' })
    const beatRes = await handleHeartbeatRequest(post(stalled()), scope(f.a1), slow(), id)
    const preRes = await handlePreflightRequest(post(stalled()), scope(f.a1), slow(), id)
    const failRes = await handleFailRequest(
      post(stalled()),
      scope(f.a1),
      { ...failDeps, deadlines: { idleMs: 80 } },
      id
    )
    expect([beatRes.status, preRes.status, failRes.status]).toEqual([408, 408, 408])
    expect(await failRes.json()).toEqual({ error: 'body_too_slow' })
    expect(await jobOf(id)).toMatchObject({ state: 'claimed', error: null })
    expect((await stateOf()).state).toBe('uploading')
  })
})

// --- Completion ---

describe('completion', () => {
  const uploaded = async (id: string, files: Record<string, string | Uint8Array>) => {
    for (const [path, content] of Object.entries(files)) await send(id, path, content)
  }
  const NATIVE = {
    'transcript/native/audio.txt': 'hello',
    'transcript/native/audio.srt': '1\n',
    'transcript/native/audio.json': WHISPER
  }

  test('needs events.jsonl, and the native transcript when there is a recording in native mode', async () => {
    const id = await claimedRun(f.a1, { native: true, state: 'uploading' })
    expect(await completeLocalRun(deps, f.a1, id)).toEqual({ ok: false, missing: ['events.jsonl'] })
    await uploaded(id, { 'events.jsonl': '{}\n', 'recording/meeting.mkv': MKV })
    expect(await completeLocalRun(deps, f.a1, id)).toEqual({
      ok: false,
      missing: Object.keys(NATIVE)
    })
    await uploaded(id, { ...NATIVE, 'transcript/native/audio.json': '{"segments":[{"start":"a"}]}' })
    expect(await completeLocalRun(deps, f.a1, id)).toEqual({ ok: false, missing: ['transcript/native/audio.json'] })
  })

  test('moves the occurrence on exactly once and queues the pipeline in the transaction', async () => {
    const id = await claimedRun(f.a1, { native: true, state: 'uploading' })
    await uploaded(id, { 'events.jsonl': '{}\n', 'recording/meeting.mkv': MKV, ...NATIVE })
    expect(await completeLocalRun(deps, f.a2, id)).toBeNull()
    expect(await completeLocalRun(deps, f.a1, id)).toEqual({ ok: true })
    expect((await stateOf()).state).toBe('transcribing')
    expect((await jobOf(id)).state).toBe('done')
    expect(queue.sent.map((s) => [s.name, s.data])).toEqual([[QUEUES.pipeline, { occurrenceId: f.occA }]])
    // A repeat is refused and queues nothing more.
    expect(await completeLocalRun(deps, f.a1, id)).toBeNull()
    expect(queue.sent).toHaveLength(1)
  })

  test('a live meeting needs only events.jsonl, and catches up a run whose last states were lost', async () => {
    const id = await claimedRun(f.a1, { state: 'in_meeting' })
    await uploaded(id, { 'events.jsonl': '{}\n' })
    expect(await completeLocalRun(deps, f.a1, id)).toEqual({ ok: true })
    expect((await stateOf()).state).toBe('transcribing')
  })

  test('refuses an occurrence that cannot move on, and keeps the job', async () => {
    const id = await claimedRun(f.a1, { state: 'restarting' })
    await uploaded(id, { 'events.jsonl': '{}\n' })
    expect(await completeLocalRun(deps, f.a1, id)).toBe('conflict')
    expect((await jobOf(id)).state).toBe('claimed')
    expect(queue.sent).toEqual([])
  })

  test('a recording that is not Matroska is reported missing and removed, so the PC sends it again', async () => {
    for (const native of [false, true]) {
      await rm(occDir(f.occA), { recursive: true, force: true })
      const id = await claimedRun(f.a1, { native, state: 'uploading' })
      await uploaded(id, { 'events.jsonl': '{}\n', 'recording/meeting.mkv': 'not a recording, just a name' })
      expect([native, await completeLocalRun(deps, f.a1, id)]).toEqual([
        native,
        { ok: false, missing: ['recording/meeting.mkv'] }
      ])
      // Gone, so the next upload starts at 0; the native transcript is asked for only once the recording is whole.
      expect(await offsetOf(id, 'recording/meeting.mkv')).toBe(0)
      await uploaded(id, { 'recording/meeting.mkv': MKV })
      expect(await completeLocalRun(deps, f.a1, id)).toEqual(
        native ? { ok: false, missing: Object.keys(NATIVE) } : { ok: true }
      )
      await db.update(companionJobs).set({ state: 'failed' }).where(eq(companionJobs.id, id))
    }
  })

  test('a recording that is a link, a short file or has no name at all is not a recording either', async () => {
    const id = await claimedRun(f.a1, { state: 'uploading' })
    await uploaded(id, { 'events.jsonl': '{}\n' })
    const dir = join(occDir(f.occA), 'recording')
    await mkdir(dir)
    await writeFile(join(root, 'target'), MKV)
    await symlink(join(root, 'target'), join(dir, 'meeting.mkv'))
    expect(await completeLocalRun(deps, f.a1, id)).toEqual({ ok: false, missing: ['recording/meeting.mkv'] })
    await rm(join(dir, 'meeting.mkv'), { force: true })
    await writeFile(join(dir, 'meeting.mkv'), MKV.subarray(0, 3))
    expect(await completeLocalRun(deps, f.a1, id)).toEqual({ ok: false, missing: ['recording/meeting.mkv'] })
    await rm(join(dir, 'meeting.mkv'), { force: true })
    // No recording at all (the run never joined) needs none.
    expect(await completeLocalRun(deps, f.a1, id)).toEqual({ ok: true })
    expect(await readFile(join(root, 'target'))).toEqual(Buffer.from(MKV))
  })

  test('an empty events.jsonl, sent as an empty file, completes the run', async () => {
    const id = await claimedRun(f.a1, { state: 'uploading' })
    expect((await put(f.a1, id, 'events.jsonl', 'bytes */0', null)).status).toBe(204)
    expect(await completeLocalRun(deps, f.a1, id)).toEqual({ ok: true })
  })

  test('catching up a run whose last states were lost stamps the end of the meeting once', async () => {
    const id = await claimedRun(f.a1, { state: 'in_meeting' })
    const before = Date.now()
    await uploaded(id, { 'events.jsonl': '{}\n' })
    expect((await stateOf()).actualEnd).toBeNull()
    expect(await completeLocalRun(deps, f.a1, id)).toEqual({ ok: true })
    const end = (await stateOf()).actualEnd
    expect(end!.getTime()).toBeGreaterThanOrEqual(before - 1000)
    // A run that reported its own end keeps that time.
    await rm(occDir(f.occA), { recursive: true, force: true })
    const stamp = new Date('2026-10-21T15:00:00Z')
    const again = await claimedRun(f.a1, { state: 'leaving' })
    await db.update(occurrences).set({ actualEnd: stamp }).where(eq(occurrences.id, f.occA))
    await uploaded(again, { 'events.jsonl': '{}\n' })
    expect(await completeLocalRun(deps, f.a1, again)).toEqual({ ok: true })
    expect((await stateOf()).actualEnd).toEqual(stamp)
  })

  test('complete, complete and fail at once: exactly one wins and the pipeline is queued at most once', async () => {
    const id = await claimedRun(f.a1, { state: 'uploading' })
    await uploaded(id, { 'events.jsonl': '{}\n' })
    const [one, two, fail] = await Promise.all([
      completeLocalRun(deps, f.a1, id),
      completeLocalRun(deps, f.a1, id),
      reportFailure(failDeps, scope(f.a1), id, 'worker_crashed')
    ])
    const completed = [one, two].filter((r) => r !== null && r !== 'conflict' && r !== 'gone' && r.ok)
    const job = await jobOf(id)
    if (job.state === 'done') {
      expect(completed).toHaveLength(1)
      expect(fail.status).toBe(404)
      expect(queue.sent).toHaveLength(1)
      expect((await stateOf()).state).toBe('transcribing')
    } else {
      expect(completed).toHaveLength(0)
      expect(fail.status).toBe(204)
      expect(job).toMatchObject({ state: 'failed', error: 'worker_crashed' })
      expect(queue.sent).toEqual([])
      expect((await stateOf()).state).toBe('failed')
    }
  })

  test('a partial file is not a finished one', async () => {
    const id = await claimedRun(f.a1, { state: 'uploading' })
    expect((await put(f.a1, id, 'events.jsonl', 'bytes 0-4/10', bytes(5))).status).toBe(204)
    expect(await completeLocalRun(deps, f.a1, id)).toEqual({ ok: false, missing: ['events.jsonl'] })
  })
})

// --- Failure reports ---

describe('a failure report', () => {
  const report = (device: DeviceAuth, id: string, error: string) => reportFailure(failDeps, scope(device), id, error)

  test('is device-bound and records a fixed reason for a local run', async () => {
    const id = await claimedRun(f.a1, { state: 'uploading' })
    expect((await report(f.a2, id, 'worker_crashed')).status).toBe(404)
    expect((await report(f.b1, id, 'worker_crashed')).status).toBe(404)
    expect((await stateOf()).state).toBe('uploading')
    expect((await report(f.a1, id, 'worker_crashed')).status).toBe(204)
    expect(await jobOf(id)).toMatchObject({ state: 'failed', error: 'worker_crashed' })
    expect(await stateOf()).toMatchObject({ state: 'failed', stateReason: 'worker_crashed' })
    expect(notifier.sent.map((s) => s.ping.title)).toEqual(['Failed: Data Mining'])
    // No retry and no second ping.
    expect((await report(f.a1, id, 'worker_crashed')).status).toBe(404)
    expect(notifier.sent).toHaveLength(1)
  })

  test('never stores or sends the PC text', async () => {
    const id = await claimedRun(f.a1, { state: 'uploading' })
    const secret = 'Traceback in C:\\Users\\alice\\secret https://zoom.us/j/123456789?pwd=hunter2'
    expect((await report(f.a1, id, secret)).status).toBe(204)
    expect(await jobOf(id)).toMatchObject({ state: 'failed', error: 'pc_failed' })
    expect(await stateOf()).toMatchObject({ stateReason: 'pc_failed' })
    expect(JSON.stringify(notifier.sent)).not.toMatch(/alice|zoom|hunter2/)
  })

  test('native transcription failing on the PC pings with the fixed copy', async () => {
    const id = await claimedRun(f.a1, { state: 'uploading', native: true })
    expect((await report(f.a1, id, 'native_transcription_failed')).status).toBe(204)
    expect(notifier.sent.map((s) => s.ping.title)).toEqual(['Transcription failed: Data Mining'])
  })

  test('a native job: the first failure re-announces it, the second fails the occurrence', async () => {
    await db.update(occurrences).set({ state: 'transcribing' }).where(eq(occurrences.id, f.occA))
    const id = await createCompanionJob(db, {
      memberId: f.a1.memberId,
      occurrenceId: f.occA,
      kind: 'native_transcription',
      payload: {
        occurrenceId: f.occA,
        entryName: 'Data Mining',
        start: '2026-10-21T14:00:00+08:00',
        timeZone: 'Asia/Kuala_Lumpur',
        durationSec: 5400,
        flacBytes: 1000
      }
    })
    const error = 'RuntimeError: CUDA out of memory\nTraceback (most recent call last):\n  File "/home/alice/x.py"'
    await claimJob(db, f.a1, id)
    expect((await report(f.a2, id, error)).status).toBe(404)
    expect((await report(f.a1, id, error)).status).toBe(204)
    expect(await jobOf(id)).toMatchObject({ state: 'pending', attempts: 1, error: 'RuntimeError: CUDA out of memory' })
    const events = await db.select({ command: companionEvents.command }).from(companionEvents)
    expect(events).toContainEqual({ command: { type: 'job_available', jobId: id } })
    expect(notifier.sent).toEqual([])
    await claimJob(db, f.a1, id)
    expect((await report(f.a1, id, error)).status).toBe(204)
    expect(await jobOf(id)).toMatchObject({ state: 'failed' })
    expect(await stateOf()).toMatchObject({ state: 'failed', stateReason: 'native_transcription_failed' })
    expect(notifier.sent).toHaveLength(1)
    expect(notifier.sent[0]!.ping.title).toBe('Transcription failed: Data Mining')
    expect(notifier.sent[0]!.ping.message).toContain('CUDA out of memory')
    expect(notifier.sent[0]!.ping.message).not.toContain('alice')
  })

  test('the route reads a capped JSON body', async () => {
    const id = await claimedRun(f.a1, { state: 'uploading' })
    const post = (body: string) =>
      handleFailRequest(new Request(JOB_URL, { method: 'POST', body }), scope(f.a1), failDeps, id)
    expect((await post('not json')).status).toBe(400)
    expect((await post('{"error":5}')).status).toBe(400)
    expect((await post(JSON.stringify({ error: 'x'.repeat(20_000) }))).status).toBe(400)
    expect((await stateOf()).state).toBe('uploading')
    expect((await post('{"error":"worker_crashed"}')).status).toBe(204)
  })
})
