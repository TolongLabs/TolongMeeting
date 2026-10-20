// End-to-end test of the server side for plans 03 (native transcription on a paired PC), 07 (exports) and 08 (run
// locations), on top of the harness of ./e2e-flow.test.ts (see ./e2e/harness.ts and ./e2e/companion.ts for what is real
// and what is faked). Real: Postgres, pg-boss, the Next route functions, Better Auth sessions, device tokens from the
// real pairing route, ffmpeg, sharp, the scheduler, the pipeline consumer and the export runner's stores. Fake: Docker,
// ntfy, the AI provider, Tailscale, GitHub, and the PCs (FakePc speaks to the real routes).
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { and, count, eq, sql } from 'drizzle-orm'
import { PC_CLAIM_GRACE_MS, NATIVE_UPLOAD_MAX_FILE_BYTES } from '@tm/core'
import {
  companionEvents,
  companionJobs,
  events,
  exports as exportsTable,
  identities,
  occurrences,
  profiles
} from '@tm/web/db'
import { dbHomeNodeStore } from '@tm/web/db/home-route'
import { memberConnections, memberOccurrences } from '@tm/web/db/exports'
import { QUEUES } from '@tm/web/db/queues'
import { homeHostname, type TailscaleDevice, HOME_TAG } from '@tm/web/lib/home-route'
import { meetingData, requestDeleteNow } from '@tm/web/lib/meeting'
import { createScope } from '@tm/web/lib/scope'
import { emitCompanionEvent } from '@tm/web/db/companion'
import { unzipSync } from '../../exports/node_modules/fflate'
import { buildTargets } from '../../exports/src/registry'
import { runExport, type RunnerDeps } from '../../exports/src/runner'
import { runnerStore } from '../../exports/src/store'
import { json, routeFetch, type Route } from '../../exports/test/route-fetch'
import { checkNativeJob } from '../src/native-check'
import { handleHomeRouteRecheck } from '../src/home-route/check'
import { handleLocalStartCheck } from '../src/local/dispatch'
import {
  deleteOccurrenceData,
  launchOccurrence,
  monitorTick,
  retentionTick,
  settleRemuxes,
  sidecarName,
  stopJobFileWatchers,
  validateRequest
} from '../src/index'
import {
  FakePc,
  callMember,
  installSession,
  launchedLecture,
  nativeJobOf,
  readStream,
  recordedLecture,
  releaseWorker,
  transcriptForm
} from './e2e/companion'
import {
  FakeWorker,
  GOOD_KEY,
  HOUR,
  MASTER,
  MINUTE,
  PUBLIC_URL,
  newMember,
  queuedJobs,
  resetStack,
  rowOf,
  saveLecture,
  startStack,
  until,
  type Member,
  type Stack
} from './e2e/harness'

setDefaultTimeout(120_000)

const session = installSession()
let stack: Stack
const realFetch = globalThis.fetch

const savedImage = process.env.TM_WORKER_IMAGE_REF
beforeAll(async () => {
  stack = await startStack()
  process.env.TM_WORKER_IMAGE_REF = 'ghcr.io/tolonglabs/tm-worker:e2e' // what a local run offers the PC to pull
}, 120_000)

afterEach(async () => {
  await stack.stopConsumer()
  await settleRemuxes()
  await stopJobFileWatchers()
  await resetStack(stack)
})

afterAll(async () => {
  if (savedImage === undefined) delete process.env.TM_WORKER_IMAGE_REF
  else process.env.TM_WORKER_IMAGE_REF = savedImage
  globalThis.fetch = realFetch
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
const pingsOf = (member: Member) => stack.ntfy.pings.filter((p) => p.topic === member.topic)
const titlesOf = (member: Member) => pingsOf(member).map((p) => p.title)
const jobRow = async (id: string) => (await stack.db.select().from(companionJobs).where(eq(companionJobs.id, id)))[0]!

// --- Plan 03: native transcription ----------------------------------------------------------------------------------

/** A `native` lecture whose worker has finished, with the consumer running and the audio cut for the PC. */
async function nativeMeeting(member: Member, name = 'Data Mining') {
  const made = await recordedLecture(stack, member, name, 'native')
  // A native meeting has no live transcript: whatever the PC uploads is all the transcript there is.
  await Bun.write(`${made.worker.dataDir}/transcript/live.jsonl`, '')
  await stack.startConsumer()
  await releaseWorker(stack, made.id)
  const job = await nativeJobOf(stack, made.id)
  return { ...made, job }
}

/** What the PC's upload must have made once the pipeline has run: the summary, and a transcript that is the PC's. */
async function expectTranscribedBy(member: Member, id: string, said: string, notSaid?: string) {
  await until('completion', async () => (await rowOf(stack, id)).state === 'completed')
  const view = (await meetingData(member.scope, id))!
  const text = view.transcript.map((l) => l.text).join(' ')
  expect(text).toContain(said)
  if (notSaid) expect(text).not.toContain(notSaid)
  expect(view.summaryMd).toContain('Submit assignment 2')
  expect(titlesOf(member).filter((t) => t.startsWith('Summary'))).toEqual(['Summary ready: Data Mining'])
}

/** Puts the lease of a job in the past, as if its PC had gone quiet for five minutes. */
async function lapseLease(jobId: string) {
  await stack.db.execute(sql`update companion_jobs set lease_until = now() - interval '1 second' where id = ${jobId}`)
}

const noNativeFiles = async (dataDir: string) => {
  const dir = `${dataDir}/transcript/native`
  return !(await exists(dir)) || (await readdir(dir)).length === 0
}

describe('native transcription on a paired PC (plan 03)', () => {
  test('a PC claims the job, downloads the audio, uploads Whisper output; bad uploads change nothing; the pipeline finishes', async () => {
    const alice = await newMember(stack, 'Nina')
    const bob = await newMember(stack, 'Omar')
    const { id, worker, job } = await nativeMeeting(alice)

    // The server cut the audio and made one pending job for the member's PCs.
    expect(job).toMatchObject({
      kind: 'native_transcription',
      state: 'pending',
      memberId: alice.memberId,
      occurrenceId: id
    })
    expect(job.payload).toMatchObject({ occurrenceId: id, entryName: 'Data Mining' })
    expect((job.payload as { durationSec: number }).durationSec).toBeGreaterThanOrEqual(1)
    expect(await rowOf(stack, id)).toMatchObject({ state: 'transcribing', transcription: 'native' })
    const audioPath = `${worker.dataDir}/audio.flac`
    const flacBytes = (await stat(audioPath)).size
    expect((job.payload as { flacBytes: number }).flacBytes).toBe(flacBytes)
    expect(await queuedJobs(stack, QUEUES.pipeline, id)).toHaveLength(1)

    // Two members' PCs: only the owner's sees the job and nobody else can reach it.
    const first = await FakePc.pair(alice, 'Lab PC')
    const second = await FakePc.pair(alice, 'Second PC')
    const strangerPc = await FakePc.pair(bob, 'Omar PC')
    expect((await first.jobs()).map((j) => j.id)).toEqual([job.id])
    expect((await second.jobs()).map((j) => j.id)).toEqual([job.id])
    expect(await strangerPc.jobs()).toEqual([])
    expect((await strangerPc.claim(job.id)).status).toBe(404)
    expect((await first.withToken(`tmd_${'A'.repeat(43)}`).claim(job.id)).status).toBe(401)
    expect((await first.audio(job.id)).status).toBe(404) // not claimed yet
    // A request with a member's session cookie and no device token is not a device.
    const { GET: listJobs } = await import('../../web/app/api/companion/jobs/route')
    const asMember = new Request(`${PUBLIC_URL}/api/companion/jobs`, { headers: { cookie: alice.cookie } })
    expect((await listJobs(asMember, { params: Promise.resolve({}) } as never)).status).toBe(401)

    // Two PCs claim at the same moment: exactly one wins.
    const raced = await Promise.all([first.claim(job.id), second.claim(job.id)])
    expect(raced.map((r) => r.status).sort()).toEqual([200, 409])
    const won = raced.find((r) => r.status === 200)!
    const pc = raced[0] === won ? first : second
    expect(await won.json()).toMatchObject({ id: job.id, kind: 'native_transcription', state: 'claimed' })
    expect((await pc.claim(job.id)).status).toBe(409)
    expect((await strangerPc.audio(job.id)).status).toBe(404)
    expect((await strangerPc.upload(job.id, transcriptForm('not yours'))).status).toBe(404)
    expect((await rowOf(stack, id)).state).toBe('transcribing') // claimed in time: it never waited for a PC
    const leased = (await jobRow(job.id)).leaseUntil!
    expect(leased.getTime()).toBeGreaterThan(Date.now() + 4 * MINUTE)

    // The audio, whole and by range.
    const whole = await pc.audio(job.id)
    expect(whole.status).toBe(200)
    const bytes = new Uint8Array(await whole.arrayBuffer())
    expect(bytes.byteLength).toBe(flacBytes)
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('fLaC')
    const ranged = await pc.audio(job.id, 'bytes=0-3')
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe(`bytes 0-3/${flacBytes}`)
    expect((await pc.audio(job.id, `bytes=${flacBytes + 10}-`)).status).toBe(416)

    // Progress renews the lease; a body it does not know is refused.
    expect((await pc.progress(job.id, JSON.stringify({ percent: 40 }))).status).toBe(204)
    expect((await pc.progress(job.id, JSON.stringify({ token: 'x' }))).status).toBe(400)
    expect((await jobRow(job.id)).leaseUntil!.getTime()).toBeGreaterThanOrEqual(leased.getTime())

    // Uploads that must be refused leave the job claimed, the occurrence in `transcribing` and no file behind.
    const refused = async (what: string, res: Response, status: number) => {
      expect([what, res.status]).toEqual([what, status])
      expect(await jobRow(job.id)).toMatchObject({ state: 'claimed', deviceId: pc.deviceId })
      expect((await rowOf(stack, id)).state).toBe('transcribing')
      expect(await noNativeFiles(worker.dataDir)).toBe(true)
      expect(await exists(audioPath)).toBe(true)
    }
    const only = new FormData()
    only.set('txt', 'a')
    only.set('json', JSON.stringify({ segments: [] }))
    await refused('a missing field', await pc.upload(job.id, only), 400)
    await refused(
      'a json that is not Whisper output',
      await pc.upload(job.id, transcriptForm('x', { json: '{"nope":true}' })),
      400
    )
    await refused(
      'a file over the cap',
      await pc.upload(job.id, transcriptForm('x', { txt: 'x'.repeat(NATIVE_UPLOAD_MAX_FILE_BYTES + 1024) })),
      413
    )
    await refused(
      'a body that declares more than the body cap',
      await pc.upload(job.id, {
        body: '--b\r\n--b--\r\n',
        headers: { 'content-type': 'multipart/form-data; boundary=b', 'content-length': String(200 * 1024 * 1024) }
      }),
      413
    )
    await refused(
      'a body that is not multipart',
      await pc.upload(job.id, { body: 'hello', headers: { 'content-type': 'text/plain' } }),
      400
    )

    // The real upload.
    const said = 'Clustering from the PC GPU is covered today.'
    const twice = await Promise.all([pc.upload(job.id, transcriptForm(said)), pc.upload(job.id, transcriptForm(said))])
    expect(twice.map((r) => r.status).sort()).toEqual([204, 404]) // two at once cannot both win
    expect(await jobRow(job.id)).toMatchObject({ state: 'done', leaseUntil: null })
    expect(JSON.parse(await readFile(`${worker.dataDir}/transcript/native/audio.json`, 'utf8')).segments[1].text).toBe(
      said
    )
    expect(await exists(audioPath)).toBe(false) // not needed any more
    expect(['transcribing', 'post_processing', 'completed']).toContain((await rowOf(stack, id)).state)
    // A second upload (a retry that lost the first answer) finds the job done.
    expect((await pc.upload(job.id, transcriptForm('again'))).status).toBe(404)
    expect((await pc.audio(job.id)).status).toBe(404)

    await expectTranscribedBy(alice, id, said)
    expect(titlesOf(alice)).toEqual(['Summary ready: Data Mining'])
    expect(await meetingData(bob.scope, id)).toBeNull()
    expect(await queuedJobs(stack, QUEUES.pipeline, id)).toHaveLength(2) // the heartbeat's, and the upload's
    // The occurrence directory holds the PC's transcript and nothing the member's PC should not have left behind.
    const check = await checkNativeJob(stack.deps, job.id, new Date())
    expect(check).toBe('done')
  })

  test('no PC claims in time: waiting_for_pc, one ping; a PC that comes later claims it and the pipeline finishes', async () => {
    const alice = await newMember(stack, 'Pia')
    const { id, job } = await nativeMeeting(alice)
    expect(
      await stack.db.select().from(companionEvents).where(eq(companionEvents.memberId, alice.memberId))
    ).toHaveLength(1) // job_available

    // Before the grace is over, the check leaves a job alone? It does not: it is only queued for the end of the grace.
    const [check] = (
      await stack.db.execute(
        sql`select start_after from pgboss.job where name = ${QUEUES.nativeJobCheck} and data->>'jobId' = ${job.id}`
      )
    ).rows as { start_after: string }[]
    const wait = new Date(check!.start_after).getTime() - Date.now()
    expect(wait).toBeGreaterThan(PC_CLAIM_GRACE_MS - 15_000)
    expect(wait).toBeLessThanOrEqual(PC_CLAIM_GRACE_MS)

    const graceEnd = new Date(Date.now() + PC_CLAIM_GRACE_MS + 1000)
    expect(await checkNativeJob(stack.deps, job.id, graceEnd)).toBe('waiting_for_pc')
    expect(await rowOf(stack, id)).toMatchObject({ state: 'waiting_for_pc' })
    expect(titlesOf(alice)).toEqual(['Waiting for your PC: Data Mining'])
    expect(pingsOf(alice)[0]!.actions.map((a) => a.url)).toEqual([`${PUBLIC_URL}/meetings/${id}`])
    expect((await meetingData(alice.scope, id))!.occurrence.state).toBe('waiting_for_pc')
    expect((await createAs(alice, id, { target: 'zip' })).status).toBe(409) // nothing to export before the summary
    // Later checks do not ping again.
    expect(await checkNativeJob(stack.deps, job.id, new Date(graceEnd.getTime() + 5 * MINUTE))).toBe('waiting_for_pc')
    expect(titlesOf(alice)).toEqual(['Waiting for your PC: Data Mining'])
    expect((await jobRow(job.id)).pcPingSentAt).not.toBeNull()

    // The PC is turned on and paired: it finds the job in its list, claims it, and the meeting is `transcribing` again.
    const pc = await FakePc.pair(alice)
    expect((await pc.jobs()).map((j) => j.id)).toEqual([job.id])
    expect((await pc.claim(job.id)).status).toBe(200)
    expect((await rowOf(stack, id)).state).toBe('transcribing')
    expect(await checkNativeJob(stack.deps, job.id, new Date())).toBe('claimed')
    const said = 'Late but transcribed.'
    expect((await pc.upload(job.id, transcriptForm(said))).status).toBe(204)
    await expectTranscribedBy(alice, id, said)
    expect(titlesOf(alice)).toEqual(['Waiting for your PC: Data Mining', 'Summary ready: Data Mining'])
  })

  test('a lapsed lease: the late PC is refused, the job goes back, a second PC finishes it', async () => {
    const alice = await newMember(stack, 'Quin')
    const { id, worker, job } = await nativeMeeting(alice)
    const pc1 = await FakePc.pair(alice, 'Laptop')
    const pc2 = await FakePc.pair(alice, 'Desktop')
    expect((await pc1.claim(job.id)).status).toBe(200)
    expect((await pc2.claim(job.id)).status).toBe(409)

    // The laptop goes to sleep and its lease runs out. Everything it sends now is refused, and nothing changes yet.
    await lapseLease(job.id)
    expect((await pc1.progress(job.id)).status).toBe(404)
    expect((await pc1.audio(job.id)).status).toBe(404)
    expect((await pc1.upload(job.id, transcriptForm('late from the laptop'))).status).toBe(404)
    expect(await jobRow(job.id)).toMatchObject({ state: 'claimed', deviceId: pc1.deviceId })
    expect(await noNativeFiles(worker.dataDir)).toBe(true)

    // The scheduler's check takes the job back and tells the member; the desktop claims it.
    expect(await checkNativeJob(stack.deps, job.id, new Date())).toBe('waiting_for_pc')
    expect(await jobRow(job.id)).toMatchObject({ state: 'pending', deviceId: null })
    expect((await rowOf(stack, id)).state).toBe('waiting_for_pc')
    expect(titlesOf(alice)).toEqual(['Waiting for your PC: Data Mining'])
    expect((await pc2.claim(job.id)).status).toBe(200)
    expect((await rowOf(stack, id)).state).toBe('transcribing')
    expect((await pc1.claim(job.id)).status).toBe(409)

    // The laptop wakes up and uploads anyway: it no longer holds the job.
    expect((await pc1.upload(job.id, transcriptForm('late from the laptop'))).status).toBe(404)
    expect((await pc1.audio(job.id)).status).toBe(404)
    expect(await noNativeFiles(worker.dataDir)).toBe(true)

    const said = 'The desktop did it.'
    expect((await pc2.upload(job.id, transcriptForm(said))).status).toBe(204)
    await expectTranscribedBy(alice, id, said, 'late from the laptop')
  })

  test('a device revoked mid-job: its requests stop at once, the job goes back to pending and a check sends it to a new PC', async () => {
    const alice = await newMember(stack, 'Rhea')
    const bob = await newMember(stack, 'Sam')
    const { id, worker, job } = await nativeMeeting(alice)
    const pc = await FakePc.pair(alice, 'Old PC')
    const newPc = await FakePc.pair(alice, 'New PC')
    expect((await pc.claim(job.id)).status).toBe(200)
    expect((await newPc.claim(job.id)).status).toBe(409)
    const started = await pc.audio(job.id)
    expect(started.status).toBe(200)
    await started.body!.cancel() // the PC stops reading when it is revoked

    const revoke = await import('../../web/app/api/devices/[id]/revoke/route')
    const revokeAs = (as: Member, deviceId: string) =>
      callMember(as, revoke.POST, `/api/devices/${deviceId}/revoke`, { id: deviceId }, { method: 'POST' })
    expect((await revokeAs(bob, pc.deviceId)).status).toBe(404) // not Sam's device
    expect((await pc.progress(job.id)).status).toBe(204)
    expect((await revokeAs(alice, pc.deviceId)).status).toBe(200)
    expect((await revokeAs(alice, pc.deviceId)).status).toBe(404)

    // The very next request of the revoked device is refused, whatever it asks for.
    for (const res of [
      await pc.progress(job.id),
      await pc.audio(job.id),
      await pc.upload(job.id, transcriptForm('from a revoked device')),
      await pc.claim(job.id)
    ])
      expect(res.status).toBe(401)
    expect(await noNativeFiles(worker.dataDir)).toBe(true)

    // The revoke released the job in the same transaction and sent a check, so the other PC claims it with no wait.
    expect(await jobRow(job.id)).toMatchObject({ state: 'pending', deviceId: null, leaseUntil: null })
    const checks = (
      await stack.db.execute(
        sql`select start_after from pgboss.job where name = ${QUEUES.nativeJobCheck} and data->>'jobId' = ${job.id} order by created_on`
      )
    ).rows as { start_after: string }[]
    expect(checks).toHaveLength(2) // the one from the upload and the revoke's, which is due now
    expect(Math.max(...checks.map((c) => new Date(c.start_after).getTime())) - Date.now()).toBeGreaterThan(0)
    expect(Math.min(...checks.map((c) => new Date(c.start_after).getTime()))).toBeLessThanOrEqual(Date.now())
    expect(await checkNativeJob(stack.deps, job.id, new Date())).toBe('waiting_for_pc')
    expect((await newPc.claim(job.id)).status).toBe(200)
    expect((await rowOf(stack, id)).state).toBe('transcribing')
    const said = 'The new PC finished the job.'
    expect((await newPc.upload(job.id, transcriptForm(said))).status).toBe(204)
    await expectTranscribedBy(alice, id, said, 'revoked device')
  })

  test('the command stream of a newly paired PC shows nothing from before it was paired', async () => {
    const alice = await newMember(stack, 'Tia')
    const { job } = await nativeMeeting(alice) // emits `job_available` before any PC exists
    const early = await FakePc.pair(alice, 'Early PC')
    await emitCompanionEvent(stack.db, alice.memberId, { type: 'open_signin', identityId: alice.identityId })
    await emitCompanionEvent(stack.db, alice.memberId, { type: 'local_identities_changed' })
    await Bun.sleep(50)
    const late = await FakePc.pair(alice, 'Late PC')
    await Bun.sleep(50)

    const open = async (pc: FakePc, ms: number, until?: (text: string) => boolean) => {
      const ac = new AbortController()
      const res = await pc.events(ac.signal)
      expect(res.headers.get('content-type')).toBe('text/event-stream')
      const text = await readStream(res, ms, until)
      ac.abort()
      return text
    }
    // A PC that was already paired gets the events that came after its pairing, though not the job from before it.
    const earlyText = await open(early, 6000, (t) => t.includes('local_identities_changed'))
    expect(earlyText).toContain('open_signin')
    expect(earlyText).toContain('local_identities_changed')
    expect(earlyText).not.toContain(job.id)

    // The new PC reads from the start of the stream and sees none of it.
    const lateText = await open(late, 3500)
    expect(lateText).toStartWith(': open')
    expect(lateText).not.toContain('event:')
    expect(lateText).not.toContain(job.id)
    expect(lateText).not.toContain('open_signin')

    // It does see what is said after it was paired (the positive control: the stream works).
    await emitCompanionEvent(stack.db, alice.memberId, { type: 'open_signin', identityId: alice.identityId })
    const after = await open(late, 8000, (t) => t.includes('open_signin'))
    expect(after).toContain('event: open_signin')
    expect(after).toContain(alice.identityId)
    // It cannot claim a way around this either: the cursor is not trusted (a header of 0 is the same as none).
    const ac = new AbortController()
    const res = await late.events(ac.signal, 0)
    const again = await readStream(res, 3500, (t) => t.includes('local_identities_changed'))
    ac.abort()
    expect(again).not.toContain('local_identities_changed')
  })

  test('pairing: a code works once, wrong codes lock an address out, codes are limited, a revoked device loses its stream', async () => {
    const alice = await newMember(stack, 'Uri')
    const codeRoute = await import('../../web/app/api/devices/pairing-code/route')
    const pairRoute = await import('../../web/app/api/companion/pair/route')
    const newCode = async () => {
      const res = await callMember(alice, codeRoute.POST, '/api/devices/pairing-code', {}, { method: 'POST' })
      return { status: res.status, code: res.status === 200 ? ((await res.json()) as { code: string }).code : '' }
    }
    const pair = (code: string, ip: string) =>
      pairRoute.POST(
        new Request(`${PUBLIC_URL}/api/companion/pair`, {
          method: 'POST',
          headers: { 'x-forwarded-for': ip },
          body: JSON.stringify({ code, deviceName: 'Test PC' })
        })
      )

    const a = await newCode()
    expect(a.code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/)
    const paired = await pair(a.code, '198.51.100.20')
    expect(paired.status).toBe(200)
    const body = (await paired.json()) as { deviceId: string; token: string; ntfy: { topic: string; token: string } }
    expect(body.token).toStartWith('tmd_')
    expect(body.ntfy.topic).toBe(alice.topic) // the PC pings through the member's own topic
    expect((await pair(a.code, '198.51.100.20')).status).toBe(400) // a code is used once
    expect(await (await pair('ABCDE-FGHJK', '198.51.100.20')).json()).toEqual({ error: 'invalid_code' })

    // Five wrong guesses from one address, then even a right code from it is refused; another address still works.
    const b = await newCode()
    for (let n = 0; n < 5; n++) expect((await pair(`ZZZZ${n}-ZZZZZ`, '198.51.100.21')).status).toBe(400)
    expect((await pair(b.code, '198.51.100.21')).status).toBe(400)
    expect((await pair(b.code, '198.51.100.22')).status).toBe(200)
    // A member may ask for five codes in ten minutes (two are used above), and not a sixth.
    const more = [await newCode(), await newCode(), await newCode(), await newCode()]
    expect(more.map((m) => m.status)).toEqual([200, 200, 200, 429])
    // A cross-site page cannot ask for a code in the member's name.
    const cross = await callMember(
      alice,
      codeRoute.POST,
      '/api/devices/pairing-code',
      {},
      {
        method: 'POST',
        headers: { 'sec-fetch-site': 'cross-site' }
      }
    )
    expect(cross.status).toBe(403)
  })

  test('a revoked device: its open command stream ends and a new one is refused', async () => {
    const alice = await newMember(stack, 'Val')
    const pc = await FakePc.pair(alice, 'Short-lived PC')
    const ac = new AbortController()
    const res = await pc.events(ac.signal)
    const reader = res.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    const ended = (async () => {
      for (;;) if ((await reader.read()).done) return true
    })()
    const revoke = await import('../../web/app/api/devices/[id]/revoke/route')
    const revoked = await callMember(
      alice,
      revoke.POST,
      `/api/devices/${pc.deviceId}/revoke`,
      { id: pc.deviceId },
      { method: 'POST' }
    )
    expect(revoked.status).toBe(200)
    const secondOpen = new AbortController()
    expect((await pc.events(secondOpen.signal)).status).toBe(401)
    // The stream looks at the token every 10 seconds.
    expect(await Promise.race([ended, Bun.sleep(20_000).then(() => false)])).toBe(true)
    ac.abort()
  })

  test('a deleted meeting cancels its native job, so no PC is offered or can claim it', async () => {
    const alice = await newMember(stack, 'Wyn')
    const { id, job } = await nativeMeeting(alice)
    await checkNativeJob(stack.deps, job.id, new Date(Date.now() + PC_CLAIM_GRACE_MS + 1000))
    expect((await rowOf(stack, id)).state).toBe('waiting_for_pc')
    // No pipeline job runs for the meeting, so the request fails it, cancels the job and queues the delete at once.
    expect(await requestDeleteNow(alice.scope, id, stack.queue)).toBe('queued')
    expect(await rowOf(stack, id)).toMatchObject({ state: 'failed', stateReason: 'deleting' })
    expect((await jobRow(job.id)).state).toBe('cancelled')
    expect(await queuedJobs(stack, QUEUES.deleteOccurrence, id)).toHaveLength(1) // due now, not at retention's next pass
    await deleteOccurrenceData(stack.deps, id, new Date())
    expect(await rowOf(stack, id)).toMatchObject({ state: 'deleted' })
    const [gone] = await stack.db
      .select({ data: events.data })
      .from(events)
      .where(and(eq(events.occurrenceId, id), eq(events.type, 'state')))
    expect(gone!.data).toMatchObject({ to: 'deleted', reason: 'member' })

    expect(['cancelled', 'failed']).toContain((await jobRow(job.id)).state)
    const pc = await FakePc.pair(alice)
    expect(await pc.jobs()).toEqual([])
    expect((await pc.claim(job.id)).status).toBe(404)
  })
})

// --- Plan 07: exports -----------------------------------------------------------------------------------------------

// The export routes, called as the member (module level: a native scenario also checks the `not_ready` answer).
const exportsRoute = () => import('../../web/app/api/meetings/[id]/exports/route')
const fileRoute = () => import('../../web/app/api/exports/[exportId]/file/route')
const createAs = async (as: Member, id: string, body: unknown) =>
  callMember(
    as,
    (await exportsRoute()).POST,
    `/api/meetings/${id}/exports`,
    { id },
    {
      method: 'POST',
      body: JSON.stringify(body)
    }
  )
const listAs = async (as: Member, id: string) =>
  callMember(as, (await exportsRoute()).GET, `/api/meetings/${id}/exports`, { id })
const downloadAs = async (as: Member, exportId: string, range?: string) =>
  callMember(
    as,
    (await fileRoute()).GET,
    `/api/exports/${exportId}/file`,
    { exportId },
    range ? { headers: { range } } : {}
  )

const GITHUB_TOKEN = 'github_pat_E2E_SECRET_TOKEN_0001'

/** The export runner (`tm-exports`) in this process: the real stores, the real targets, `http` for the remote ones. */
function runnerDeps(http: typeof fetch): RunnerDeps {
  const { db, env, notifier } = stack
  return {
    store: runnerStore(db),
    connections: {
      get: (memberId, kind) => memberConnections(createScope(db, memberId), MASTER).get(kind),
      save: (memberId, c) => memberConnections(createScope(db, memberId), MASTER).save(c),
      markReconnect: (memberId, kind) => memberConnections(createScope(db, memberId), MASTER).markReconnect(kind)
    },
    occurrences: { get: (memberId, id) => memberOccurrences(createScope(db, memberId), env.dataRoot).get(id) },
    targets: buildTargets({ google: null, notion: null }),
    ping: (memberId, p) => notifier.notify(memberId, p),
    publicUrl: PUBLIC_URL,
    http,
    sleep: async () => undefined,
    log: () => undefined
  }
}

/** Runs every queued export, oldest first, the way the runner's loop does. */
async function runQueuedExports(http: typeof fetch = realFetch): Promise<number> {
  const deps = runnerDeps(http)
  let ran = 0
  for (let row = await deps.store.claimNext(); row !== null; row = await deps.store.claimNext()) {
    await runExport(row, deps)
    ran++
  }
  return ran
}

let finished: Promise<{ alice: Member; bob: Member; id: string; dir: string }> | undefined
/** One finished lecture shared by the export scenarios, which run in order (the last one deletes it). */
function finishedLecture() {
  finished ??= (async () => {
    const alice = await newMember(stack, 'Xena')
    const bob = await newMember(stack, 'Yusuf')
    const { id, worker } = await recordedLecture(stack, alice)
    await stack.startConsumer()
    await releaseWorker(stack, id)
    await until('completion', async () => (await rowOf(stack, id)).state === 'completed')
    return { alice, bob, id, dir: worker.dataDir }
  })()
  return finished
}

describe('exports (plan 07)', () => {
  test('zip and pdf: queued through the routes, produced by the runner, downloaded by the owner only', async () => {
    const { alice, bob, id, dir } = await finishedLecture()

    // Another member's meeting is a 404 for every export route; a bad target is a 422; nothing is queued by them.
    expect((await createAs(bob, id, { target: 'zip' })).status).toBe(404)
    expect((await listAs(bob, id)).status).toBe(404)
    expect((await createAs(alice, id, { target: 'word' })).status).toBe(422)
    expect((await createAs(alice, id, { target: 'zip', extra: 1 })).status).toBe(422)
    expect(await (await createAs(alice, id, { target: 'github' })).json()).toMatchObject({ error: 'not_connected' })
    expect(await stack.db.select().from(exportsTable).where(eq(exportsTable.occurrenceId, id))).toEqual([])

    const zip = await createAs(alice, id, { target: 'zip' })
    expect(zip.status).toBe(202)
    const zipId = ((await zip.json()) as { exportId: string }).exportId
    expect((await createAs(alice, id, { target: 'zip' })).status).toBe(409) // already queued
    const pdf = await createAs(alice, id, { target: 'pdf' })
    expect(pdf.status).toBe(202)
    const pdfId = ((await pdf.json()) as { exportId: string }).exportId
    const queued = ((await (await listAs(alice, id)).json()) as { exports: any[] }).exports
    expect(queued.map((e) => [e.target, e.status, e.downloadUrl]).sort()).toEqual([
      ['pdf', 'queued', null],
      ['zip', 'queued', null]
    ])
    expect((await downloadAs(alice, zipId)).status).toBe(404) // not made yet

    // The runner makes both files in the occurrence directory.
    expect(await runQueuedExports()).toBe(2)
    const done = ((await (await listAs(alice, id)).json()) as { exports: any[] }).exports
    expect(done.map((e) => [e.target, e.status, e.downloadUrl]).sort()).toEqual([
      ['pdf', 'succeeded', `/api/exports/${pdfId}/file`],
      ['zip', 'succeeded', `/api/exports/${zipId}/file`]
    ])
    expect(JSON.stringify(done)).not.toContain(dir) // no server path in the API
    expect((await readdir(`${dir}/exports`)).sort()).toEqual([`${pdfId}.pdf`, `${zipId}.zip`].sort())
    expect(titlesOf(alice).filter((t) => t === 'Export finished')).toHaveLength(2)

    const zipRes = await downloadAs(alice, zipId)
    expect(zipRes.status).toBe(200)
    expect(zipRes.headers.get('content-type')).toBe('application/zip')
    expect(zipRes.headers.get('content-disposition')).toMatch(
      /^attachment; filename="tolongmeeting-\d{4}-\d\d-\d\d-zip\.zip"/
    )
    const files = unzipSync(new Uint8Array(await zipRes.arrayBuffer()))
    const names = Object.keys(files)
    expect(
      names.every((n) => /^[a-z0-9-]+\/(summary\.md|transcript\.md|slides\.md|chat\.md|slides\/\d{2,3}\.webp)$/.test(n))
    ).toBe(true)
    expect(names.map((n) => n.split('/').slice(1).join('/'))).toEqual(
      expect.arrayContaining(['summary.md', 'transcript.md', 'slides/01.webp'])
    )
    const text = names
      .filter((n) => n.endsWith('.md'))
      .map((n) => new TextDecoder().decode(files[n]!))
      .join('\n')
    expect(text).toContain('Submit assignment 2')
    expect(text).toContain('Today we cover k-means')
    expect(text).not.toMatch(/SECRETPASSCODE|pwd=|zoom\.us/)

    const pdfRes = await downloadAs(alice, pdfId)
    expect(pdfRes.status).toBe(200)
    expect(pdfRes.headers.get('content-type')).toBe('application/pdf')
    const pdfBytes = new Uint8Array(await pdfRes.arrayBuffer())
    expect(new TextDecoder().decode(pdfBytes.slice(0, 5))).toBe('%PDF-')
    expect(pdfBytes.byteLength).toBeGreaterThan(2000)
    const range = await downloadAs(alice, pdfId, 'bytes=0-4')
    expect(range.status).toBe(206)
    expect(new TextDecoder().decode(await range.arrayBuffer())).toBe('%PDF-')

    // Another member gets the same 404 whether the export exists or not.
    expect((await downloadAs(bob, zipId)).status).toBe(404)
    expect((await downloadAs(bob, pdfId)).status).toBe(404)
    expect((await downloadAs(bob, '00000000-0000-4000-8000-000000000000')).status).toBe(404)
    expect((await downloadAs(alice, '../../etc/passwd')).status).toBe(404)
    expect(titlesOf(bob)).toEqual([])
    // A finished export does not block the next one.
    expect((await createAs(alice, id, { target: 'zip' })).status).toBe(202)
    expect(await runQueuedExports()).toBe(1)
    // A new download replaces the earlier one of the same meeting and target: its row stays, its file goes.
    expect((await downloadAs(alice, zipId)).status).toBe(404)
    expect((await readdir(`${dir}/exports`)).filter((n) => n.endsWith('.zip'))).toHaveLength(1)
    expect((await downloadAs(alice, pdfId)).status).toBe(200)
  })

  test('a GitHub export against a fake GitHub writes only the layout files, in one commit, and leaks no token', async () => {
    const { alice, bob, id } = await finishedLecture()
    const API = 'https://api.github.com/repos/acme/notes'
    const state = { tree: undefined as any, commit: undefined as any, blobs: 0 }
    const routes: Route[] = [
      ['GET', API, () => json({ id: 1 })],
      ['GET', `${API}/branches/main`, () => json({ name: 'main' })],
      ['GET', /\/contents\//, () => json({ message: 'Not Found' }, 404)],
      ['GET', `${API}/git/ref/heads/main`, () => json({ object: { sha: 'a'.repeat(40) } })],
      ['GET', `${API}/git/commits/${'a'.repeat(40)}`, () => json({ tree: { sha: 'b'.repeat(40) } })],
      ['POST', `${API}/git/blobs`, () => json({ sha: String(++state.blobs).padStart(40, '1') }, 201)],
      [
        'POST',
        `${API}/git/trees`,
        async (req) => {
          state.tree = await req.json()
          return json({ sha: 'c'.repeat(40) }, 201)
        }
      ],
      [
        'POST',
        `${API}/git/commits`,
        async (req) => {
          state.commit = await req.json()
          return json({ sha: 'd'.repeat(40) }, 201)
        }
      ],
      ['PATCH', `${API}/git/refs/heads/main`, () => json({}, 200)]
    ]
    const gh = routeFetch(routes)

    // The connection is saved through the same function the PUT route calls, with the fake in place of fetch.
    const { saveGitHubResponse } = await import('../../web/lib/exports')
    const { exportStores } = await import('../../web/lib/exports')
    const saved = await saveGitHubResponse(
      exportStores(alice.scope),
      new Request(`${PUBLIC_URL}/api/connections/github`, {
        method: 'PUT',
        body: JSON.stringify({ owner: 'acme', repo: 'notes', branch: 'main', folder: 'meetings', token: GITHUB_TOKEN })
      }),
      gh.fetch
    )
    expect(saved.status).toBe(200)
    const connectionsRoute = await import('../../web/app/api/connections/route')
    const summaries = await callMember(alice, connectionsRoute.GET as never, '/api/connections', {})
    const summaryText = await summaries.text()
    expect(summaryText).toContain('acme/notes')
    expect(summaryText).not.toContain(GITHUB_TOKEN)
    expect(await (await callMember(bob, connectionsRoute.GET as never, '/api/connections', {})).json()).toEqual({
      connections: []
    })
    expect((await createAs(bob, id, { target: 'github' })).status).toBe(404)

    const made = await createAs(alice, id, { target: 'github' })
    expect(made.status).toBe(202)
    expect(await runQueuedExports(gh.fetch)).toBe(1)

    const [row] = ((await (await listAs(alice, id)).json()) as { exports: any[] }).exports.filter(
      (e) => e.target === 'github'
    )
    expect(row).toMatchObject({ status: 'succeeded', downloadUrl: null })
    expect(row.url).toMatch(/^https:\/\/github\.com\/acme\/notes\/tree\/main\/meetings\/[a-z0-9-]+$/)

    // One commit; every path is a layout file under the meeting's folder; no recording, form, event or raw chat.
    const folder = row.url.split('/tree/main/')[1]
    const paths = (state.tree.tree as { path: string }[]).map((e) => e.path)
    expect(paths.length).toBeGreaterThanOrEqual(3)
    for (const path of paths) {
      expect(path.startsWith(`${folder}/`)).toBe(true)
      expect(path.slice(folder.length + 1)).toMatch(
        /^(summary\.md|transcript\.md|slides\.md|chat\.md|slides\/\d{2,3}\.webp)$/
      )
    }
    expect(state.commit.parents).toEqual(['a'.repeat(40)])
    expect(state.commit.message).toMatch(/^docs: add /)
    expect(gh.count('POST', `${API}/git/commits`)).toBe(1)
    expect(gh.calls.every((c) => new URL(c.url).origin === 'https://api.github.com')).toBe(true)
    expect(gh.calls.every((c) => c.headers.authorization === `Bearer ${GITHUB_TOKEN}`)).toBe(true)
    // What was written holds no join link, and nothing the member sees holds the token.
    const written =
      JSON.stringify(state.tree) +
      gh.calls
        .filter((c) => c.url.endsWith('/blobs'))
        .map((c) => c.body)
        .join('')
    expect(written).not.toMatch(/SECRETPASSCODE|pwd=|zoom\.us/)
    const stored = await stack.db.select().from(exportsTable).where(eq(exportsTable.occurrenceId, id))
    expect(JSON.stringify(stored)).not.toContain(GITHUB_TOKEN)
    expect(JSON.stringify(stack.ntfy.pings)).not.toContain(GITHUB_TOKEN)
    expect(titlesOf(alice).filter((t) => t === 'Export finished').length).toBeGreaterThanOrEqual(3)
  })

  test('deleting the meeting removes the export files and rows', async () => {
    const { alice, id, dir } = await finishedLecture()
    const before = await stack.db.select().from(exportsTable).where(eq(exportsTable.occurrenceId, id))
    const fileExports = before.filter((r) => r.filePath !== null)
    expect(fileExports.map((r) => r.target).sort()).toEqual(['pdf', 'zip']) // the replaced zip keeps no file
    for (const r of fileExports) expect(await exists(`${dir}/${r.filePath}`)).toBe(true)
    expect(before.some((r) => r.target === 'github' && r.url !== null)).toBe(true)

    expect(await requestDeleteNow(alice.scope, id, stack.queue)).toBeTruthy()
    await deleteOccurrenceData(stack.deps, id, new Date())
    expect((await rowOf(stack, id)).state).toBe('deleted')
    expect(await exists(dir)).toBe(false)
    for (const r of fileExports) expect((await downloadAs(alice, r.id)).status).toBe(404)
    expect((await listAs(alice, id)).status).toBe(404)
    expect((await createAs(alice, id, { target: 'zip' })).status).toBe(404)

    // The delete took the rows (titles, GitHub folder links) in the same transaction; the runner's hourly purge has none left.
    expect(await stack.db.select().from(exportsTable).where(eq(exportsTable.occurrenceId, id))).toEqual([])
    expect(await runnerStore(stack.db).purgeDeleted()).toBe(0)
  })
})

// --- Plan 08: run locations -----------------------------------------------------------------------------------------

const TAILNET = { devices: [] as TailscaleDevice[], keys: [] as Record<string, any>[], tokenCalls: 0 }
const AUTH_KEY = 'tskey-auth-E2E-SECRET-AUTH-KEY'
const NODE_IP = '100.101.102.103'
const TAILSCALE_VERSION = '1.102.5'

/** Tailscale's API as a fake on the global `fetch` (the scheduler's client is built over it); other URLs go through. */
function installTailscale() {
  process.env.TM_TAILSCALE_CLIENT_ID = 'e2e-ts-client'
  process.env.TM_TAILSCALE_CLIENT_SECRET = 'tskey-client-e2e-secret'
  process.env.TAILSCALE_VERSION = TAILSCALE_VERSION
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    const url = new URL(req.url)
    if (url.origin !== 'https://api.tailscale.com') return realFetch(req)
    if (url.pathname === '/api/v2/oauth/token') {
      TAILNET.tokenCalls++
      return Response.json({ access_token: 'ts-access-token', expires_in: 3600 })
    }
    if (url.pathname.endsWith('/devices')) return Response.json({ devices: TAILNET.devices })
    if (url.pathname.endsWith('/keys') && req.method === 'POST') {
      TAILNET.keys.push(await req.json())
      return Response.json({ key: AUTH_KEY })
    }
    return new Response('unexpected', { status: 500 })
  }) as typeof fetch
}

/** The member's home device as the tailnet lists it, and as the website stored it after the member's setup check. */
async function homeDevice(member: Member, ready: boolean) {
  const hostname = homeHostname(MASTER, member.memberId)
  const device: TailscaleDevice = {
    nodeId: `nHOME${member.memberId.slice(0, 6)}`,
    hostname,
    addresses: [NODE_IP, 'fd7a:115c:a1e0::1'],
    tags: [HOME_TAG],
    connectedToControl: ready,
    enabledRoutes: ['0.0.0.0/0', '::/0']
  }
  await dbHomeNodeStore(stack.db, member.memberId).save({
    nodeId: device.nodeId,
    hostname,
    ipv4: NODE_IP,
    checkedAt: new Date()
  })
  return device
}

/** What Docker was asked to create since `mark` (the fake Docker is shared by every scenario of the file). */
const dockerMark = () => ({ workers: stack.docker.created.length, sidecars: stack.docker.sidecars.length })
const madeSince = (mark: ReturnType<typeof dockerMark>) => ({
  workers: stack.docker.created.slice(mark.workers),
  sidecars: stack.docker.sidecars.slice(mark.sidecars)
})

describe('run locations (plan 08)', () => {
  const runLocation = () => import('../../web/app/api/identities/[id]/run-location/route')
  const move = async (as: Member, body: unknown) =>
    callMember(
      as,
      (await runLocation()).PUT,
      `/api/identities/${as.identityId}/run-location`,
      { id: as.identityId },
      {
        method: 'PUT',
        body: JSON.stringify(body)
      }
    )
  const identityOf = async (m: Member) =>
    (await stack.db.select().from(identities).where(eq(identities.id, m.identityId)))[0]!
  const profileOf = async (m: Member) =>
    (await stack.db.select().from(profiles).where(eq(profiles.identityId, m.identityId)))[0]!

  test('moving to a PC: allowed with only future meetings, refused with one starting within 75 minutes', async () => {
    const far = await newMember(stack, 'Uma')
    const near = await newMember(stack, 'Vic')
    await saveLecture(stack, far, 6 * 60) // tomorrow's lecture is a `scheduled` row far out: it will launch on the PC
    await saveLecture(stack, near, 61) // starts inside the 75 minute window
    const farPc = await FakePc.pair(far, 'Far PC')
    const nearPc = await FakePc.pair(near, 'Near PC')
    const stranger = await FakePc.pair(far, 'Second PC')

    expect((await move(far, { location: 'local', deviceId: nearPc.deviceId })).status).toBe(404) // not Uma's device
    expect((await move(far, { location: 'local' })).status).toBe(400)
    expect((await move(far, { location: 'server_via_home' })).status).toBe(409) // no home device set up
    expect(await (await move(far, { location: 'server_via_home' })).json()).toEqual({ error: 'home_route_not_set_up' })

    const refused = await move(near, { location: 'local', deviceId: nearPc.deviceId })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: 'identity_in_use' })
    expect(await identityOf(near)).toMatchObject({ runLocation: 'server', localDeviceId: null })
    expect((await profileOf(near)).location).toBe('server')
    expect(await queuedJobs(stack, QUEUES.profileDelete, '')).toEqual([])

    const allowed = await move(far, { location: 'local', deviceId: farPc.deviceId })
    expect(allowed.status).toBe(200)
    expect(await identityOf(far)).toMatchObject({ runLocation: 'local', localDeviceId: farPc.deviceId })
    expect((await profileOf(far)).location).toBe('local')
    const deleteJobs = (await stack.db.execute(sql`select data from pgboss.job where name = ${QUEUES.profileDelete}`))
      .rows as { data: { identityId: string } }[]
    expect(deleteJobs.map((j) => j.data.identityId)).toContain(far.identityId) // the server's copy is deleted
    // The PC that gained the identity is told; the other PC of the member is not.
    const told = async (pc: FakePc) => {
      const ac = new AbortController()
      const text = await readStream(await pc.events(ac.signal), 3000, (t) => t.includes('local_identities_changed'))
      ac.abort()
      return text.includes('local_identities_changed')
    }
    expect(await told(farPc)).toBe(true)
    expect(await told(stranger)).toBe(false)
    // It is the same answer when asked again, and moving it back to the server works while nothing is imminent.
    expect((await move(far, { location: 'local', deviceId: farPc.deviceId })).status).toBe(200)
    expect((await move(far, { location: 'server' })).status).toBe(200)
    expect(await identityOf(far)).toMatchObject({ runLocation: 'server', localDeviceId: null })
    expect((await profileOf(far)).location).toBe('server')
  })

  test('a server_via_home launch with the home node offline: one ping, no worker; at T-10 it fails', async () => {
    installTailscale()
    const mark = dockerMark()
    const hana = await newMember(stack, 'Hana')
    await homeDevice(hana, false)
    expect((await move(hana, { location: 'server_via_home' })).status).toBe(200)
    const { lecture, id } = await (async () => {
      const lecture = await saveLecture(stack, hana, 90)
      return { lecture, id: lecture.occurrenceId }
    })()
    const T60 = new Date(lecture.start.getTime() - HOUR)
    expect(
      await launchOccurrence(stack.deps, { occurrenceId: id, scheduledStart: lecture.start.toISOString() }, T60)
    ).toBe('deferred')
    // The occurrence holds the profile and waits for the home check; no container of any kind was made.
    expect(await rowOf(stack, id)).toMatchObject({ state: 'starting' })
    expect((await profileOf(hana)).heldBy).toBe(`occ:${id}`)
    expect(madeSince(mark)).toEqual({ workers: [], sidecars: [] })
    expect(await queuedJobs(stack, QUEUES.homeRouteRecheck, id)).toHaveLength(1)
    // The monitor leaves a `starting` row without a container alone.
    expect(await monitorTick(stack.deps, new Date(T60.getTime() + 5 * MINUTE))).toEqual({
      restarted: [],
      failed: [],
      released: []
    })

    expect(await handleHomeRouteRecheck(stack.deps, { occurrenceId: id }, T60)).toBe('waiting')
    expect(titlesOf(hana)).toEqual(['Home connection offline: Data Mining'])
    expect(pingsOf(hana)[0]!.message).toContain('before')
    expect(await handleHomeRouteRecheck(stack.deps, { occurrenceId: id }, new Date(T60.getTime() + 30 * MINUTE))).toBe(
      'waiting'
    )
    expect(titlesOf(hana)).toEqual(['Home connection offline: Data Mining']) // once
    const alerts = await stack.db
      .select({ n: count() })
      .from(events)
      .where(and(eq(events.occurrenceId, id), eq(events.type, 'alert')))
    expect(alerts[0]!.n).toBe(1)
    expect(await queuedJobs(stack, QUEUES.homeRouteRecheck, id)).toHaveLength(3) // the launch's and one per look

    // From T-10 the occurrence fails, the profile is free again and the member is told; still no worker.
    const T9 = new Date(lecture.start.getTime() - 9 * MINUTE)
    expect(await handleHomeRouteRecheck(stack.deps, { occurrenceId: id }, T9)).toBe('failed')
    expect(await rowOf(stack, id)).toMatchObject({ state: 'failed', stateReason: 'home_exit_node_offline' })
    expect((await profileOf(hana)).heldBy).toBeNull()
    expect(titlesOf(hana)).toEqual(['Home connection offline: Data Mining', 'Failed: Data Mining'])
    expect(madeSince(mark)).toEqual({ workers: [], sidecars: [] })
    expect(TAILNET.keys).toEqual([]) // no tunnel key was asked for
    expect(await handleHomeRouteRecheck(stack.deps, { occurrenceId: id }, T9)).toBe('stale') // a late job is dropped
  })

  test('a server_via_home launch with the home node ready: the sidecar and the worker pass the Docker gate', async () => {
    installTailscale()
    const mark = dockerMark()
    const ivan = await newMember(stack, 'Ivo')
    TAILNET.devices = [await homeDevice(ivan, true)]
    TAILNET.keys = []
    expect((await move(ivan, { location: 'server_via_home' })).status).toBe(200)
    const lecture = await saveLecture(stack, ivan, 90)
    const id = lecture.occurrenceId
    const T60 = new Date(lecture.start.getTime() - HOUR)
    expect(
      await launchOccurrence(stack.deps, { occurrenceId: id, scheduledStart: lecture.start.toISOString() }, T60)
    ).toBe('deferred')
    // The sidecar is healthy as soon as it is started (the real Docker reports it after a few looks).
    const start = stack.docker.start.bind(stack.docker)
    stack.docker.start = async (name) => {
      await start(name)
      for (const s of stack.docker.sidecars)
        if (s.id === name) stack.docker.inspectResults.set(s.name, { running: true, health: 'healthy' })
    }
    expect(await handleHomeRouteRecheck(stack.deps, { occurrenceId: id }, T60)).toBe('launched')
    stack.docker.start = start

    const sidecar = sidecarName(id)
    const made = madeSince(mark)
    expect(made.sidecars.map((s) => s.name)).toEqual([sidecar])
    expect(made.workers.map((c) => c.name)).toEqual([`tm-worker-${id}-a1`])
    const gate = { ...stack.env, tailscaleVersion: TAILSCALE_VERSION }
    expect(
      validateRequest(
        { method: 'POST', path: `/containers/create?name=${sidecar}`, body: made.sidecars[0]!.body },
        gate
      )
    ).toMatchObject({ ok: true })
    const worker = made.workers[0]!
    expect(
      validateRequest({ method: 'POST', path: `/containers/create?name=${worker.name}`, body: worker.body }, gate)
    ).toMatchObject({ ok: true })
    expect(JSON.stringify(worker.body)).toContain(`container:${sidecar}`)
    // The sidecar pins the member's own node; the one-time key went into a file, not into the body or a ping.
    expect(JSON.stringify(made.sidecars[0]!.body)).toContain(`nHOME${ivan.memberId.slice(0, 6)}`)
    for (const text of [
      JSON.stringify(made.sidecars[0]!.body),
      JSON.stringify(worker.body),
      JSON.stringify(stack.ntfy.pings)
    ])
      expect(text).not.toContain(AUTH_KEY)
    expect(TAILNET.keys).toHaveLength(1)
    expect(TAILNET.keys[0]).toMatchObject({
      capabilities: { devices: { create: { ephemeral: true, tags: ['tag:tm-worker'] } } }
    })
    expect(await readdir(`${stack.env.profileRoot}/_home-route`).catch(() => [])).toEqual([])
    expect(await rowOf(stack, id)).toMatchObject({ state: 'starting', attempt: 1 })
    expect(titlesOf(ivan)).toEqual([])
    // The monitor sees the worker's container as the occurrence's own.
    expect((await rowOf(stack, id)).containerName).toBe(worker.name)
  })

  test('revoking the PC of a local identity: its offered meeting fails at T-10, the next one is skipped, "no PC paired"', async () => {
    const member = await newMember(stack, 'Yana')
    const pc = await FakePc.pair(member, 'Yana PC')
    const first = await saveLecture(stack, member, 6 * 60, 'Data Mining')
    const second = await saveLecture(stack, member, 7 * 60, 'Databases')
    expect((await move(member, { location: 'local', deviceId: pc.deviceId })).status).toBe(200)
    const job = (l: typeof first) => ({ occurrenceId: l.occurrenceId, scheduledStart: l.start.toISOString() })
    const t60 = new Date(first.start.getTime() - HOUR)
    await stack.db.execute(
      sql`update device_tokens set last_used_at = ${new Date(t60.getTime() - 5000).toISOString()} where id = ${pc.deviceId}`
    )
    expect(await launchOccurrence(stack.deps, job(first), t60)).toBe('launched')
    const [offered] = await pc.jobs()
    expect((await pc.claim(offered!.id)).status).toBe(200)

    const revoke = await import('../../web/app/api/devices/[id]/revoke/route')
    const revoked = await callMember(
      member,
      revoke.POST,
      `/api/devices/${pc.deviceId}/revoke`,
      { id: pc.deviceId },
      { method: 'POST' }
    )
    expect(revoked.status).toBe(200)
    // The identity stays on "My PC" with no PC bound (it never quietly runs on the server), and the run is cancelled.
    expect(await identityOf(member)).toMatchObject({ runLocation: 'local', localDeviceId: null })
    expect((await stack.db.select().from(companionJobs).where(eq(companionJobs.id, offered!.id)))[0]!.state).toBe(
      'cancelled'
    )
    expect((await pc.claim(offered!.id)).status).toBe(401)
    // Nobody started it: the start check at T-10 fails the meeting and says so.
    const T10 = new Date(first.start.getTime() - 10 * MINUTE)
    expect(await handleLocalStartCheck(stack.deps, { jobId: offered!.id }, T10)).toBe('failed')
    expect(await rowOf(stack, first.occurrenceId)).toMatchObject({ state: 'failed', stateReason: 'pc_lost' })
    expect(titlesOf(member)).toEqual(['Failed: Data Mining'])
    // The next meeting is skipped at once with the "no PC paired" ping, and nothing runs on the server.
    const mark = dockerMark()
    expect(await launchOccurrence(stack.deps, job(second), new Date(second.start.getTime() - HOUR))).toBe(
      'skipped_pc_offline'
    )
    expect(titlesOf(member)).toEqual(['Failed: Data Mining', 'No PC paired: Databases'])
    expect(madeSince(mark)).toEqual({ workers: [], sidecars: [] })
  })

  test('the home node comes online after the first look: one ping, then the worker starts behind the sidecar', async () => {
    installTailscale()
    const mark = dockerMark()
    const jo = await newMember(stack, 'Jo')
    const device = await homeDevice(jo, false)
    TAILNET.devices = [device]
    TAILNET.keys = []
    expect((await move(jo, { location: 'server_via_home' })).status).toBe(200)
    const lecture = await saveLecture(stack, jo, 90)
    const id = lecture.occurrenceId
    const T60 = new Date(lecture.start.getTime() - HOUR)
    expect(
      await launchOccurrence(stack.deps, { occurrenceId: id, scheduledStart: lecture.start.toISOString() }, T60)
    ).toBe('deferred')
    expect(await handleHomeRouteRecheck(stack.deps, { occurrenceId: id }, T60)).toBe('waiting')
    expect(titlesOf(jo)).toEqual(['Home connection offline: Data Mining'])
    expect(pingsOf(jo)[0]!.message).toContain(device.hostname)

    // The member switches the home device on (connected, advertising the exit routes).
    device.connectedToControl = true
    const start = stack.docker.start.bind(stack.docker)
    stack.docker.start = async (name) => {
      await start(name)
      for (const s of stack.docker.sidecars)
        if (s.id === name) stack.docker.inspectResults.set(s.name, { running: true, health: 'healthy' })
    }
    expect(await handleHomeRouteRecheck(stack.deps, { occurrenceId: id }, new Date(T60.getTime() + MINUTE))).toBe(
      'launched'
    )
    stack.docker.start = start
    const made = madeSince(mark)
    expect(made.sidecars.map((s) => s.name)).toEqual([sidecarName(id)])
    expect(made.workers.map((w) => w.name)).toEqual([`tm-worker-${id}-a1`])
    expect(await rowOf(stack, id)).toMatchObject({ state: 'starting', attempt: 1, containerName: `tm-worker-${id}-a1` })
    expect(titlesOf(jo)).toEqual(['Home connection offline: Data Mining']) // no second ping, no failure
    expect(TAILNET.keys).toHaveLength(1)
    // The worker is a real one from here: it reads its job file and beats; the meeting is the ordinary server flow.
    const worker = await FakeWorker.fromJobFile(stack, jo.identityId, id, 1)
    expect((await worker.beat('starting', { stateEvent: false })).status).toBe(200)
    expect((await worker.beat('verifying_accounts')).status).toBe(200)
  })

  test('a local identity: at T-60 the meeting is offered to its online PC, or skipped with a ping when the PC is asleep', async () => {
    const mark = dockerMark()
    const online = await newMember(stack, 'Wen')
    const asleep = await newMember(stack, 'Xan')
    const onlinePc = await FakePc.pair(online, 'Wen PC')
    const asleepPc = await FakePc.pair(asleep, 'Xan PC')
    const lectures = [await saveLecture(stack, online, 6 * 60), await saveLecture(stack, asleep, 6 * 60)]
    for (const [m, pc] of [
      [online, onlinePc],
      [asleep, asleepPc]
    ] as const)
      expect((await move(m, { location: 'local', deviceId: pc.deviceId })).status).toBe(200)

    const t60 = (l: (typeof lectures)[number]) => new Date(l.start.getTime() - HOUR)
    // The scheduler's clock is T-60 (hours from now); a PC is online when it called within the last 90 seconds of that clock.
    const seen = (pc: FakePc, at: Date) =>
      stack.db.execute(sql`update device_tokens set last_used_at = ${at.toISOString()} where id = ${pc.deviceId}`)
    await onlinePc.jobs()
    await seen(onlinePc, new Date(t60(lectures[0]!).getTime() - 10_000))
    await seen(asleepPc, new Date(t60(lectures[1]!).getTime() - 10 * MINUTE))
    const job = (l: (typeof lectures)[number]) => ({
      occurrenceId: l.occurrenceId,
      scheduledStart: l.start.toISOString()
    })
    expect(await launchOccurrence(stack.deps, job(lectures[0]!), t60(lectures[0]!))).toBe('launched')
    expect(await launchOccurrence(stack.deps, job(lectures[1]!), t60(lectures[1]!))).toBe('skipped_pc_offline')
    expect(madeSince(mark)).toEqual({ workers: [], sidecars: [] }) // nothing starts on the server for a local identity
    expect(await rowOf(stack, lectures[0]!.occurrenceId)).toMatchObject({ state: 'starting' })
    expect(await rowOf(stack, lectures[1]!.occurrenceId)).toMatchObject({ state: 'skipped_pc_offline' })
    expect(titlesOf(asleep)).toEqual(['PC offline: Data Mining'])
    expect(titlesOf(online)).toEqual([])
    const offered = await onlinePc.jobs()
    expect(offered.map((j) => [j.kind, j.state])).toEqual([['local_run', 'pending']])
    expect(JSON.stringify(offered)).not.toContain(GOOD_KEY) // the AI key is fetched later, never offered
    expect((await asleepPc.jobs()).filter((j) => j.kind === 'local_run')).toEqual([])
    const claimed = await onlinePc.claim(offered[0]!.id)
    expect(claimed.status).toBe(200)
    expect((await asleepPc.claim(offered[0]!.id)).status).toBe(404) // aimed at the other device
  })
})
