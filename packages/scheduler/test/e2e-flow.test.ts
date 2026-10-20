// End-to-end test of the server side: timetable -> queue -> scheduler launch -> worker heartbeats -> monitor ->
// pipeline consumer -> meeting page -> retention. See ./e2e/harness.ts for what is real and what is faked.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { access, readdir, readFile, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { eq } from 'drizzle-orm'
import { stripPasscode } from '@tm/core'
import { artefacts, events, forms, profiles } from '@tm/web/db'
import { QUEUES } from '@tm/web/db/queues'
import { InUseError } from '@tm/web/lib/identities'
import { meetingData, requestDeleteNow, rerunPipeline } from '@tm/web/lib/meeting'
import { saveAiKeys } from '@tm/web/lib/ai-keys'
import {
  OccurrenceActiveError,
  UNREACHABLE_FAIL_MS,
  UNREACHABLE_PING_MS,
  containerSpec,
  deleteOccurrenceData,
  launchOccurrence,
  monitorTick,
  retentionTick,
  settleRemuxes,
  stopJobFileWatchers,
  validateRequest
} from '../src/index'
import { installSession, signInAs } from './e2e/companion'
import {
  DAY,
  FakeWorker,
  GOOD_KEY,
  HOUR,
  MASTER,
  MINUTE,
  PUBLIC_URL,
  ZOOM_LINK,
  finishMeeting,
  joinMeeting,
  keyTester,
  newMember,
  queuedJobs,
  resetStack,
  rowOf,
  saveLecture,
  sha256hex,
  startStack,
  until,
  writeMeetingOutput,
  type Lecture,
  type Member,
  type Stack
} from './e2e/harness'

setDefaultTimeout(120_000)
const exec = promisify(execFile)

// --- Sign-in for the file route -------------------------------------------------------------------------------------
// `requireMember` reads the request's cookies through `next/headers`, which only works inside a Next request. The real
// Better Auth (`getAuth()`, `getSession`, the session row, the signed cookie) runs; only the request context is supplied
// (./e2e/companion.ts, shared with e2e-companion.test.ts, which runs in the same process when the directory is tested).
const session = installSession()

let stack: Stack
beforeAll(async () => {
  stack = await startStack()
}, 120_000)

afterEach(async () => {
  await stack.stopConsumer()
  await settleRemuxes()
  await stopJobFileWatchers()
  await resetStack(stack)
})

afterAll(async () => {
  session.restore()
  // The website's own send-only pg-boss (`getQueue`) loses its connections when the database is dropped, and says so.
  const log = console.error
  console.error = (...args: unknown[]) => (String(args[0]).startsWith('queue error:') ? undefined : log(...args))
  await stack?.teardown()
  await Bun.sleep(300)
  console.error = log
}, 120_000)

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false
  )

async function fileRoute(as: Member | null, id: string, path: string[], range?: string): Promise<Response> {
  const { GET } = await import('../../web/app/api/meetings/[id]/files/[...path]/route')
  signInAs(as)
  return GET(
    new Request(`${PUBLIC_URL}/api/meetings/${id}/files/${path.join('/')}`, range ? { headers: { range } } : {}),
    { params: Promise.resolve({ id, path }) }
  )
}

/** Every text the member could read about the meeting: the pings and the files the pipeline wrote to out/. */
async function leaks(member: Member, id: string, needles: string[]): Promise<string[]> {
  const found: string[] = []
  const check = (where: string, text: string) => {
    for (const n of needles) if (text.includes(n)) found.push(`${where} contains ${n}`)
  }
  for (const p of pingsOf(member)) check(`ping "${p.title}"`, JSON.stringify(p))
  // The raw worker inputs (chat.jsonl) hold what was said; the member reads only what the pipeline wrote to out/.
  const out = `${stack.env.dataRoot}/occurrences/${id}/out`
  for (const name of await readdir(out)) check(`out/${name}`, await readFile(`${out}/${name}`, 'utf8'))
  return found
}

/** The pings that reached this member's topic. */
const pingsOf = (member: Member) => stack.ntfy.pings.filter((p) => p.topic === member.topic)
const titlesOf = (member: Member) => pingsOf(member).map((p) => p.title)

const SECRETS = ['SECRETPASSCODE123', 'pwd=', 'example.zoom.us']

describe('a lecture from the timetable to retention', () => {
  test('happy path: save, launch, meeting, monitor, pipeline, meeting page, file route, retention', async () => {
    const alice = await newMember(stack, 'Alice')
    const bob = await newMember(stack, 'Bob')
    const { db, deps } = stack

    // 1. The member saves a lecture that starts in 61 minutes: the occurrence is synced and its launch job is queued.
    const lecture = await saveLecture(stack, alice, 61)
    const { occurrenceId: id } = lecture
    expect(lecture.start.getTime() - Date.now()).toBeGreaterThan(60 * MINUTE)
    const scheduled = await rowOf(stack, id)
    expect(scheduled).toMatchObject({ state: 'scheduled', memberId: alice.memberId, identityId: alice.identityId })
    const launchJobs = await queuedJobs(stack, 'launch', id)
    expect(launchJobs).toHaveLength(1)
    expect(launchJobs[0]!.data).toEqual({ occurrenceId: id, scheduledStart: lecture.start.toISOString() })
    expect(Math.abs(launchJobs[0]!.start_after.getTime() - (lecture.start.getTime() - HOUR))).toBeLessThan(1000)
    expect(await queuedJobs(stack, 'pipeline', id)).toHaveLength(0)

    // 2. At T-60 the scheduler launches it.
    const tMinus60 = new Date(lecture.start.getTime() - HOUR)
    expect(
      await launchOccurrence(deps, { occurrenceId: id, scheduledStart: lecture.start.toISOString() }, tMinus60)
    ).toBe('launched')
    const launched = await rowOf(stack, id)
    expect(launched).toMatchObject({ state: 'starting', attempt: 1, containerName: `tm-worker-${id}-a1` })
    expect(launched.lastHeartbeatAt).toEqual(tMinus60)
    expect(launched.linkUsed).toBe(stripPasscode(ZOOM_LINK)) // the used link is stored without its passcode
    expect(launched.linkUsed).not.toContain('pwd=')
    expect(stack.docker.created).toHaveLength(1)
    const spec = containerSpec({
      kind: 'worker',
      occurrenceId: id,
      attempt: 1,
      identityId: alice.identityId,
      env: stack.env
    })
    expect(stack.docker.created[0]).toMatchObject({ name: `tm-worker-${id}-a1`, body: spec })
    expect(
      validateRequest(
        { method: 'POST', path: `/containers/create?name=tm-worker-${id}-a1`, body: stack.docker.created[0]!.body },
        stack.env
      ).ok
    ).toBe(true)
    expect(stack.docker.started).toEqual(['fake-1'])
    const jobBase = `${stack.env.profileRoot}/${alice.identityId}/job/tm-worker-${id}-a1`
    for (const file of [`${jobBase}.json`, `${jobBase}.key`]) expect((await stat(file)).mode & 0o777).toBe(0o600)
    const worker = await FakeWorker.fromJobFile(stack, alice.identityId, id, 1)
    expect(worker.token).toStartWith('1.')
    expect(launched.controlTokenHash).toBe(sha256hex(worker.token))
    expect((await db.select().from(profiles).where(eq(profiles.identityId, alice.identityId)))[0]!.heldBy).toBe(
      `occ:${id}`
    )

    // 3. The worker reports over the real heartbeat route.
    expect((await worker.beat('in_meeting', { stateEvent: false })).status).toBe(200) // a skipped step is refused, not applied
    expect((await rowOf(stack, id)).state).toBe('starting')
    expect(
      (await db.select().from(events).where(eq(events.occurrenceId, id))).some(
        (e) => (e.data as any).reason === 'illegal_transition'
      )
    ).toBe(true)
    await joinMeeting(worker)
    const inMeeting = await rowOf(stack, id)
    expect(inMeeting).toMatchObject({ state: 'in_meeting', recording: true, participants: 31 })
    expect(inMeeting.actualStart).not.toBeNull()
    expect(await queuedJobs(stack, 'pipeline', id)).toHaveLength(0)
    const formRows = await db.select().from(forms).where(eq(forms.occurrenceId, id))
    expect(formRows.map((f) => [f.formKey, f.source, f.state]).sort()).toEqual([
      ['0f1e2d3c4b5a6978', 'meeting_chat', 'needs_member'],
      ['a1b2c3d4e5f60718', 'qr', 'submitted']
    ])
    // The monitor leaves a healthy worker alone and deletes its job files once it has sent a heartbeat.
    expect(await monitorTick(deps, new Date())).toEqual({ restarted: [], failed: [], released: [] })
    expect(await exists(`${jobBase}.json`)).toBe(false)
    expect(await exists(`${jobBase}.key`)).toBe(false)

    await worker.writeSegments(2)
    await writeMeetingOutput(worker, lecture)
    await finishMeeting(worker)
    expect(await queuedJobs(stack, 'pipeline', id)).toHaveLength(0) // not before `transcribing`
    expect((await worker.beat('transcribing')).status).toBe(200)
    const transcribing = await rowOf(stack, id)
    expect(transcribing).toMatchObject({ state: 'transcribing', containerName: `tm-worker-${id}-a1` })
    expect(transcribing.actualEnd).not.toBeNull()
    const pipelineJobs = await queuedJobs(stack, 'pipeline', id)
    expect(pipelineJobs).toHaveLength(1)
    expect(pipelineJobs[0]!.data).toEqual({ occurrenceId: id })
    expect(titlesOf(alice).filter((t) => t.startsWith('Summary'))).toEqual([])

    // 4. The consumer must not touch the directory while the container exists: its job fails and is retried.
    await stack.startConsumer()
    await until(
      'the first pipeline attempt to be refused',
      async () => (await queuedJobs(stack, 'pipeline', id))[0]!.retry_count >= 1
    )
    expect((await rowOf(stack, id)).state).toBe('transcribing')
    expect(await exists(`${worker.dataDir}/recording/meeting.mp4`)).toBe(false)
    // Docker reports the container gone; the monitor clears `container_name` and gives the profile back.
    stack.docker.gone(`tm-worker-${id}-a1`)
    expect((await monitorTick(deps, new Date())).released).toEqual([id])
    const released = await rowOf(stack, id)
    expect(released.containerName).toBeNull()
    expect((await db.select().from(profiles).where(eq(profiles.identityId, alice.identityId)))[0]!.heldBy).toBeNull()
    await until('the pipeline to complete the occurrence', async () => (await rowOf(stack, id)).state === 'completed')
    const done = await rowOf(stack, id)
    expect(done).toMatchObject({ state: 'completed', stateReason: null })
    expect(JSON.stringify([done.linkUsed, done.entrySnapshot, done.pastedLink])).not.toContain('pwd=')

    // The recording was joined from its segments and remuxed to a browser MP4; exactly one summary ping went out.
    const mp4 = `${worker.dataDir}/recording/meeting.mp4`
    const probe = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4])
    expect(Number(probe.stdout)).toBeGreaterThan(3.5)
    expect(Number(probe.stdout)).toBeLessThan(4.6)
    expect(await exists(`${worker.dataDir}/recording/meeting.mkv`)).toBe(false)
    const summaryPings = pingsOf(alice).filter((p) => p.title.startsWith('Summary'))
    expect(summaryPings.map((p) => p.title)).toEqual(['Summary ready: Data Mining'])
    expect(summaryPings[0]!.auth).toBe('Bearer tk_fake_member_token')
    expect(titlesOf(alice).filter((t) => t !== 'Summary ready: Data Mining')).toEqual([])
    expect(stack.pipelineConfigs).toHaveLength(1)
    expect(stack.pipelineConfigs[0]!.ai.apiKey).toBe('sk-good-key-0001')
    expect(new Set(stack.ai.keysSeen)).toEqual(new Set(['sk-good-key-0001']))
    expect(await leaks(alice, id, SECRETS)).toEqual([])

    // A duplicate pipeline job (a retry, a double click) is dropped: still one summary ping, still completed.
    await stack.queue.send(QUEUES.pipeline, { occurrenceId: id })
    await until('the duplicate job to be taken', async () =>
      (await queuedJobs(stack, 'pipeline', id)).every((j) => j.state === 'completed')
    )
    expect(titlesOf(alice).filter((t) => t.startsWith('Summary'))).toEqual(['Summary ready: Data Mining'])
    expect((await rowOf(stack, id)).state).toBe('completed')
    expect(stack.pipelineConfigs).toHaveLength(1)

    // 5. The meeting page data and the file route.
    const view = (await meetingData(alice.scope, id))!
    expect(view.occurrence).toMatchObject({ state: 'completed', recording: false, participants: 31 })
    expect(view.transcript.map((l) => l.text).join(' ')).toContain('Today we cover k-means')
    expect(view.slides).toHaveLength(1)
    expect(view.slides[0]).toMatchObject({ n: 1, title: 'Week 7: Clustering', failed: false })
    expect(view.forms.map((f) => [f.source, f.state, f.trustReason])).toEqual(
      expect.arrayContaining([
        ['qr', 'submitted', 'qr_on_screen'],
        ['meeting_chat', 'needs_member', 'host']
      ])
    )
    expect(view.forms.find((f) => f.source === 'qr')!.screenshotUrls).toEqual([
      `/api/meetings/${id}/files/forms/a1b2c3d4e5f60718/filled.png`
    ])
    expect(view.videoUrl).toBe(`/api/meetings/${id}/files/recording/meeting.mp4`)
    expect(view.summaryMd).toContain('Data Mining')
    expect(view.summaryMd).toContain('Submit assignment 2')
    expect(view.chatMd).toContain('Assignment 2 is due Sunday')
    // the joined link is shown masked (host and meeting id); nothing else names the meeting
    expect(view.occurrence.joinedLink).toEqual({ host: 'example.zoom.us', meetingId: '81234567890' })
    expect(JSON.stringify(view)).not.toMatch(/SECRETPASSCODE|pwd=/)
    expect(JSON.stringify({ ...view, occurrence: { ...view.occurrence, joinedLink: null } })).not.toMatch(/zoom\.us/)
    const kinds = (await db.select().from(artefacts).where(eq(artefacts.occurrenceId, id))).map((a) => a.kind)
    expect(new Set(kinds)).toEqual(
      new Set(['recording', 'summary', 'transcript', 'slides', 'slides_json', 'slide_image', 'chat', 'form_screenshot'])
    )

    const size = (await stat(mp4)).size
    const ranged = await fileRoute(alice, id, ['recording', 'meeting.mp4'], 'bytes=0-99')
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe(`bytes 0-99/${size}`)
    expect(ranged.headers.get('content-type')).toBe('video/mp4')
    const head = new Uint8Array(await ranged.arrayBuffer())
    expect(head.byteLength).toBe(100)
    expect(new TextDecoder().decode(head.slice(4, 8))).toBe('ftyp')
    const whole = await fileRoute(alice, id, ['recording', 'meeting.mp4'])
    expect(whole.status).toBe(200)
    expect((await whole.arrayBuffer()).byteLength).toBe(size)
    expect((await fileRoute(bob, id, ['recording', 'meeting.mp4'])).status).toBe(404)
    expect(await meetingData(bob.scope, id)).toBeNull()
    expect((await fileRoute(alice, id, ['..', '..', 'master.key'])).status).toBe(404)

    // 6. Retention: a warning three days before, then the tombstone.
    const deleteAfter = done.deleteAfter
    expect((await retentionTick(deps, new Date(deleteAfter.getTime() - 10 * DAY))).warned).toBe(0)
    expect((await retentionTick(deps, new Date(deleteAfter.getTime() - 2 * DAY))).warned).toBe(1)
    expect((await retentionTick(deps, new Date(deleteAfter.getTime() - 1 * DAY))).warned).toBe(0)
    expect(titlesOf(alice).filter((t) => t.startsWith('Deleting in 3 days'))).toEqual([
      'Deleting in 3 days: Data Mining'
    ])
    expect(await exists(worker.dataDir)).toBe(true)
    const gone = await retentionTick(deps, new Date(deleteAfter.getTime() + MINUTE))
    expect(gone.deleted).toBe(1)
    const tomb = await rowOf(stack, id)
    expect(tomb).toMatchObject({
      state: 'deleted',
      stateReason: 'expired',
      linkUsed: null,
      pastedLink: null,
      entrySnapshot: null
    })
    expect(await exists(worker.dataDir)).toBe(false)
    expect(await db.select().from(artefacts).where(eq(artefacts.occurrenceId, id))).toEqual([])
    expect(await db.select().from(forms).where(eq(forms.occurrenceId, id))).toEqual([])
    expect((await fileRoute(alice, id, ['recording', 'meeting.mp4'])).status).toBe(404)
  })
})

// --- Edge scenarios -----------------------------------------------------------------------------------------------

/** A saved lecture, launched at T-60, and the worker that reads the job file the launcher wrote. */
async function launchedLecture(member: Member, name = 'Data Mining') {
  const lecture = await saveLecture(stack, member, 61, name)
  const tMinus60 = new Date(lecture.start.getTime() - HOUR)
  const job = { occurrenceId: lecture.occurrenceId, scheduledStart: lecture.start.toISOString() }
  expect(await launchOccurrence(stack.deps, job, tMinus60)).toBe('launched')
  const worker = await FakeWorker.fromJobFile(stack, member.identityId, lecture.occurrenceId, 1)
  return { lecture, worker, tMinus60, id: lecture.occurrenceId }
}

/** The worker's end of a meeting: its files, then `leaving`, `uploading` and `transcribing`. */
async function endMeeting(
  worker: FakeWorker,
  lecture: Lecture,
  attempts?: { startMs: number; stopMs: number | null }[]
) {
  await worker.writeSegments(1)
  await writeMeetingOutput(worker, lecture, { attempts })
  await finishMeeting(worker)
  expect((await worker.beat('transcribing')).status).toBe(200)
}

/** Docker reports the worker's container gone and the monitor lets go of it. */
async function releaseWorker(id: string) {
  const row = await rowOf(stack, id)
  stack.docker.gone(row.containerName!)
  const result = await monitorTick(stack.deps, new Date())
  expect(result.released).toEqual([id])
}

describe('edge scenarios', () => {
  test('a worker that crashes mid-meeting is restarted, resumes its state and the meeting completes', async () => {
    const alice = await newMember(stack, 'Carol')
    const { lecture, worker, id } = await launchedLecture(alice)
    await joinMeeting(worker)
    await worker.writeSegments(1)
    const quiet = (await rowOf(stack, id)).lastHeartbeatAt!

    // Quiet for 31 seconds: the monitor stops the old container, counts a crash and starts attempt 2.
    expect(await monitorTick(stack.deps, new Date(quiet.getTime() + 31_000))).toEqual({
      restarted: [id],
      failed: [],
      released: []
    })
    const restarting = await rowOf(stack, id)
    expect(restarting).toMatchObject({
      state: 'restarting',
      attempt: 2,
      restarts: 1,
      resumeState: 'in_meeting',
      containerName: `tm-worker-${id}-a2`
    })
    expect(stack.docker.stopped.map((s) => s.id)).toContain(`tm-worker-${id}-a1`)
    expect(stack.docker.created.map((c) => c.name)).toContain(`tm-worker-${id}-a2`)
    expect(titlesOf(alice)).toEqual(['Restarting: Data Mining'])
    expect((await profileOf(alice)).heldBy).toBe(`occ:${id}`)
    expect(await exists(`${stack.env.profileRoot}/${alice.identityId}/job/tm-worker-${id}-a1.json`)).toBe(false)

    // The old worker is superseded; the new one resumes from the state the server stored.
    const old = await worker.beat('in_meeting')
    expect(old).toEqual({ status: 410, body: { ackedEvents: 0, commands: ['stop'], link: null } })
    const second = await FakeWorker.fromJobFile(stack, alice.identityId, id, 2)
    expect(second.token).toStartWith('2.')
    // The restarted worker must be able to rejoin: its job still carries the full link, passcode included.
    const job2 = JSON.parse(
      await readFile(`${stack.env.profileRoot}/${alice.identityId}/job/tm-worker-${id}-a2.json`, 'utf8')
    )
    expect(job2.entry.link).toEqual({ kind: 'fixed', url: ZOOM_LINK })
    expect(job2.attempt).toBe(2)
    expect((await second.beat('in_meeting', { recording: true, participants: 29 })).status).toBe(200)
    expect(await rowOf(stack, id)).toMatchObject({ state: 'in_meeting', resumeState: null, restarts: 1, attempt: 2 })

    await second.writeSegments(1)
    await endMeeting(second, lecture, [
      { startMs: 0, stopMs: null },
      { startMs: 45_000, stopMs: 50_000 }
    ])
    expect(await queuedJobs(stack, 'pipeline', id)).toHaveLength(1)
    await stack.startConsumer()
    await releaseWorker(id)
    await until('completion', async () => (await rowOf(stack, id)).state === 'completed')

    const view = (await meetingData(alice.scope, id))!
    expect(view.transcript.some((l) => l.note && l.text.includes('Recording gap'))).toBe(true)
    expect(view.videoUrl).not.toBeNull()
    expect(titlesOf(alice)).toEqual(['Restarting: Data Mining', 'Summary ready: Data Mining'])
    const attempts = new Set(
      (await stack.db.select().from(events).where(eq(events.occurrenceId, id))).map((e) => e.attempt)
    )
    // Attempt 0 is the server's own `launch` state event, written before the first attempt exists.
    expect(attempts).toEqual(new Set([0, 1, 2]))
    expect(await leaks(alice, id, SECRETS)).toEqual([])
  })

  test('a worker that never sends a heartbeat is restarted three times, then the meeting fails with one ping', async () => {
    const alice = await newMember(stack, 'Dave')
    const { id, tMinus60 } = await launchedLecture(alice)
    const outcomes = []
    for (let n = 1; n <= 4; n++) outcomes.push(await monitorTick(stack.deps, new Date(tMinus60.getTime() + n * 31_000)))
    expect(outcomes.map((o) => [o.restarted.length, o.failed.length])).toEqual([
      [1, 0],
      [1, 0],
      [1, 0],
      [0, 1]
    ])
    const failed = await rowOf(stack, id)
    expect(failed).toMatchObject({ state: 'failed', stateReason: 'worker_unresponsive', restarts: 3, attempt: 4 })
    expect(titlesOf(alice)).toEqual([
      'Restarting: Data Mining',
      'Restarting: Data Mining',
      'Restarting: Data Mining',
      'Failed: Data Mining'
    ])
    expect(pingsOf(alice).at(-1)!.message).toContain('crashed 3 times')
    expect(stack.docker.created.filter((c) => c.name.includes(id)).map((c) => c.name)).toEqual(
      [1, 2, 3, 4].map((n) => `tm-worker-${id}-a${n}`)
    )
    // The monitor stopped the last container before it failed the meeting, so the profile is already free.
    expect((await profileOf(alice)).heldBy).toBeNull()
    expect((await rowOf(stack, id)).containerName).toBe(`tm-worker-${id}-a4`)
    stack.docker.gone(`tm-worker-${id}-a4`)
    await monitorTick(stack.deps, new Date())
    await settleRemuxes()
    expect(await rowOf(stack, id)).toMatchObject({ state: 'failed', containerName: null })
    expect((await profileOf(alice)).heldBy).toBeNull()
    await until(
      'the exit watcher to delete the last job files',
      async () => !(await exists(`${stack.env.profileRoot}/${alice.identityId}/job/tm-worker-${id}-a4.json`))
    )
  })

  test('Docker unreachable for 16 minutes: one "can\'t check" ping at 5 minutes, then worker_unreachable and a ping', async () => {
    const alice = await newMember(stack, 'Erin')
    const { worker, id } = await launchedLecture(alice)
    await joinMeeting(worker)
    const last = (await rowOf(stack, id)).lastHeartbeatAt!.getTime()
    stack.docker.down = true

    expect((await monitorTick(stack.deps, new Date(last + 31_000))).failed).toEqual([])
    expect(titlesOf(alice)).toEqual([])
    await monitorTick(stack.deps, new Date(last + 30_000 + UNREACHABLE_PING_MS + 1000))
    await monitorTick(stack.deps, new Date(last + 30_000 + UNREACHABLE_PING_MS + 61_000))
    expect(titlesOf(alice)).toEqual(["Can't check your meeting bot: Data Mining"])
    expect((await rowOf(stack, id)).state).toBe('in_meeting')

    const result = await monitorTick(stack.deps, new Date(last + 30_000 + UNREACHABLE_FAIL_MS + 1000))
    expect(result.failed).toEqual([id])
    expect(await rowOf(stack, id)).toMatchObject({
      state: 'failed',
      stateReason: 'worker_unreachable',
      containerName: `tm-worker-${id}-a1`
    })
    expect(titlesOf(alice)).toEqual(["Can't check your meeting bot: Data Mining", 'Failed: Data Mining'])
    expect(pingsOf(alice).at(-1)!.message).toContain("couldn't be reached")
    expect(stack.docker.created.filter((c) => c.name.includes(id))).toHaveLength(1) // not restarted
    // The profile stays held: the worker may still be running.
    expect((await profileOf(alice)).heldBy).toBe(`occ:${id}`)
    // A worker that is in fact alive is told to stop in its next reply.
    expect((await worker.beat('in_meeting')).body.commands).toContain('stop')
    // Docker is back and the container is gone: the profile is released.
    stack.docker.down = false
    stack.docker.gone(`tm-worker-${id}-a1`)
    await monitorTick(stack.deps, new Date())
    await settleRemuxes()
    expect(await rowOf(stack, id)).toMatchObject({ state: 'failed', containerName: null })
    expect((await profileOf(alice)).heldBy).toBeNull()
  })

  test('an AI key rejected in the pipeline waits for the member; one ping; the re-run after a key fix completes', async () => {
    const alice = await newMember(stack, 'Frank')
    const { lecture, worker, id } = await launchedLecture(alice)
    await joinMeeting(worker)
    await endMeeting(worker, lecture)
    stack.ai.validKey = 'sk-key-the-provider-knows-0002' // the member's saved key is now rejected (401)
    await stack.startConsumer()
    await releaseWorker(id)
    await until('the key error', async () => (await rowOf(stack, id)).stateReason === 'ai_key_error')
    expect(await rowOf(stack, id)).toMatchObject({ state: 'post_processing', stateReason: 'ai_key_error' })
    expect(titlesOf(alice)).toEqual(['Summary needs your key: Data Mining'])
    expect(pingsOf(alice)[0]!.message).toContain('(401)')
    expect(pingsOf(alice)[0]!.actions.map((a) => a.url)).toEqual([
      `${PUBLIC_URL}/ai-keys`,
      `${PUBLIC_URL}/meetings/${id}`
    ])
    // What exists is kept and registered; the job itself finished (no retry storm, no second ping).
    expect((await alice.scope.select(artefacts, eq(artefacts.occurrenceId, id))).map((a) => a.kind)).toContain(
      'recording'
    )
    await until('the pipeline job to finish', async () =>
      (await queuedJobs(stack, 'pipeline', id)).every((j) => j.state === 'completed')
    )
    await Bun.sleep(2500) // longer than the 1 s retry delay and the consumer's polling interval
    expect(titlesOf(alice)).toEqual(['Summary needs your key: Data Mining'])
    expect(await queuedJobs(stack, 'pipeline', id)).toHaveLength(1)

    // The member fixes the key and presses Re-run (twice: one job).
    expect(
      await saveAiKeys(
        alice.scope,
        { dashscopeKey: stack.ai.validKey },
        { master: MASTER, tester: keyTester, now: new Date() }
      )
    ).toEqual({ ok: true })
    await rerunPipeline(alice.scope, id, stack.queue)
    await expect(rerunPipeline(alice.scope, id, stack.queue)).rejects.toThrow(InUseError)
    await until('completion', async () => (await rowOf(stack, id)).state === 'completed')
    expect(stack.pipelineConfigs.at(-1)!.ai.apiKey).toBe(stack.ai.validKey)
    expect(stack.pipelineConfigs.at(-1)!.ai.apiKey).not.toBe(GOOD_KEY)
    expect(titlesOf(alice)).toEqual(['Summary needs your key: Data Mining', 'Summary ready: Data Mining'])
    expect(await queuedJobs(stack, 'pipeline', id)).toHaveLength(2)
    expect((await meetingData(alice.scope, id))!.summaryMd).toContain('Submit assignment 2')
  })
})

// Small shared reads kept below the tests that use them.
async function profileOf(member: Member) {
  return (await stack.db.select().from(profiles).where(eq(profiles.identityId, member.identityId)))[0]!
}

describe('a member deletes a meeting that is still in the pipeline', () => {
  /** A meeting that has reached `post_processing`: the worker is gone and the consumer is inside the summary call. */
  async function inPostProcessing(member: Member, key: 'held' | 'rejected') {
    const { lecture, worker, id } = await launchedLecture(member)
    await joinMeeting(worker)
    await endMeeting(worker, lecture)
    let release = () => {}
    if (key === 'held') stack.ai.hold = new Promise<void>((resolve) => (release = resolve))
    else stack.ai.validKey = 'sk-key-the-provider-knows-0003'
    await stack.startConsumer()
    await releaseWorker(id)
    if (key === 'held') await stack.ai.arrived
    else await until('the key error', async () => (await rowOf(stack, id)).stateReason === 'ai_key_error')
    expect((await rowOf(stack, id)).state).toBe('post_processing')
    return { id, worker, release }
  }

  test('while the summary runs: the data stays until the run is done, then the delete goes through', async () => {
    const alice = await newMember(stack, 'Gina')
    const { id, worker, release } = await inPostProcessing(alice, 'held')

    // The scheduler's delete handler must refuse to touch a directory the pipeline is reading.
    expect(await requestDeleteNow(alice.scope, id, stack.queue)).toBe('after_processing')
    expect(await queuedJobs(stack, QUEUES.deleteOccurrence, id)).toHaveLength(0)
    await expect(deleteOccurrenceData(stack.deps, id, new Date())).rejects.toThrow(OccurrenceActiveError)
    expect(await exists(worker.dataDir)).toBe(true)

    release()
    await until('completion', async () => (await rowOf(stack, id)).state === 'completed')
    expect(titlesOf(alice)).toEqual(['Summary ready: Data Mining'])
    expect((await alice.scope.select(artefacts, eq(artefacts.occurrenceId, id))).map((a) => a.kind)).toContain(
      'summary'
    )

    // The consumer queued the delete the member asked for during the run; the scheduler's delete handler now allows it.
    await until('the delete job', async () => (await queuedJobs(stack, QUEUES.deleteOccurrence, id)).length === 1)
    await deleteOccurrenceData(stack.deps, id, new Date())
    expect(await rowOf(stack, id)).toMatchObject({ state: 'deleted' })
    expect(await exists(worker.dataDir)).toBe(false)
    expect((await fileRoute(alice, id, ['out', 'transcript.md'])).status).toBe(404)
  })

  // Finding 1 (.superpowers/sdd/e2e-server-findings.md): "delete now" while the pipeline owns the meeting must not
  // overwrite state_reason 'ai_key_error'. It waits (delete_after = now) and the consumer queues the delete after the run.
  test('at an AI key error: delete now waits for the pipeline, the re-run works, then the delete goes through', async () => {
    const alice = await newMember(stack, 'Hank')
    const { id, worker } = await inPostProcessing(alice, 'rejected')
    expect(await requestDeleteNow(alice.scope, id, stack.queue)).toBe('after_processing')
    expect((await rowOf(stack, id)).stateReason).toBe('ai_key_error')
    expect(await queuedJobs(stack, QUEUES.deleteOccurrence, id)).toHaveLength(0)
    stack.ai.validKey = GOOD_KEY
    await rerunPipeline(alice.scope, id, stack.queue)
    await until('the delete job', async () => (await queuedJobs(stack, QUEUES.deleteOccurrence, id)).length === 1)
    expect(await rowOf(stack, id)).toMatchObject({ state: 'completed', stateReason: 'deleting' })
    await deleteOccurrenceData(stack.deps, id, new Date())
    expect((await rowOf(stack, id)).state).toBe('deleted')
    expect(await exists(worker.dataDir)).toBe(false)
  })

  // Finding 2: a meeting stuck in transcribing, waiting_for_pc or post_processing (a rejected key, an absent PC) must
  // not outlive its 30 days. Retention deletes it once delete_after is more than 3 h past and no pipeline holds it.
  test('retention deletes a meeting that is still waiting on a rejected key long after 30 days', async () => {
    const alice = await newMember(stack, 'Ivan')
    const { id, worker } = await inPostProcessing(alice, 'rejected')
    const { deleteAfter } = await rowOf(stack, id)
    // Just past the day: a pipeline may still be finishing, so the meeting stays.
    expect(await retentionTick(stack.deps, new Date(deleteAfter.getTime() + MINUTE))).toMatchObject({ skipped: 1 })
    expect((await rowOf(stack, id)).state).toBe('post_processing')
    await retentionTick(stack.deps, new Date(deleteAfter.getTime() + 40 * DAY))
    expect((await rowOf(stack, id)).state).toBe('deleted')
    expect(await exists(worker.dataDir)).toBe(false)
  })
})
