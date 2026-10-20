import { tmpdir } from 'node:os'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { LocalRunPayloadSchema, type OccurrenceState } from '@tm/core'
import { eq } from 'drizzle-orm'
import { companionEvents, companionJobs, deviceTokens, identities, occurrences, profiles, schema } from '@tm/web/db'
import { claimJob, listJobsForDevice } from '@tm/web/db/companion'
import { FakeNotifier } from '@tm/web/db/notifier'
import { QUEUES } from '@tm/web/db/queues'
import { sealColumn } from '@tm/web/db/secrets'
import { FakeQueue, createTestDb, dropAllTestDbs, seedMember } from '@tm/web/db/testing'
import {
  FakeDocker,
  checkLocalClaim,
  checkLocalStart,
  handleLocalStartDead,
  launchOccurrence,
  localHeartbeatTimeout,
  monitorTick,
  restartOccurrence,
  startAttempt,
  type LaunchDeps
} from '../src/index'

const MASTER = Buffer.alloc(32, 3)
const HOUR = 3_600_000
const START = '2026-10-21T06:00:00.000Z' // 14:00 in Kuala Lumpur
const IMAGE = 'ghcr.io/tl/tolongmeeting-worker:1.0.0'
const at = (hhmmss: string) => new Date(`2026-10-21T${hhmmss}+08:00`)

let tmp: string
beforeAll(async () => {
  tmp = await mkdtemp(`${tmpdir()}/local-dispatch-`)
  process.env.TM_WORKER_IMAGE_REF = IMAGE
})
afterAll(async () => {
  await dropAllTestDbs()
  await rm(tmp, { recursive: true, force: true })
}, 60_000)

interface Options {
  location?: 'local' | 'server' | 'server_via_home'
  paired?: boolean
  /** When the PC was last seen (default: just before T-60). */
  seen?: Date | null
}

/** Member A with a local identity "University" bound to PC "DESKTOP-ABC" (and a second PC), and "Data Mining" at 14:00. */
async function fixture(o: Options = {}) {
  const db = await createTestDb()
  const { memberId, identityId } = await seedMember(db, { full: false })
  await db
    .update(schema.members)
    .set({ ntfyTopic: 'tm-topic', ntfyTokenEnc: sealColumn(MASTER, memberId, 'members.ntfy_token', 'ntfy-secret') })
    .where(eq(schema.members.id, memberId))
  await db
    .update(schema.aiKeys)
    .set({ dashscopeKeyEnc: sealColumn(MASTER, memberId, 'ai_keys.dashscope_key', 'sk-dash-secret') })
    .where(eq(schema.aiKeys.memberId, memberId))
  const device = async (name: string, seen: Date | null) => {
    const [row] = await db
      .insert(deviceTokens)
      .values({ memberId, name, tokenHash: `${name}-${Math.random()}`, lastUsedAt: seen })
      .returning({ id: deviceTokens.id })
    return { deviceId: row!.id, memberId }
  }
  const a1 = await device('DESKTOP-ABC', o.seen === undefined ? at('12:59:30') : o.seen)
  const a2 = await device('LAPTOP-A', at('12:59:30'))
  const location = o.location ?? 'local'
  await db
    .update(identities)
    .set({
      name: 'University',
      runLocation: location,
      localDeviceId: location === 'local' && o.paired !== false ? a1.deviceId : null
    })
    .where(eq(identities.id, identityId))
  await db
    .update(profiles)
    .set({ location: location === 'local' ? 'local' : 'server' })
    .where(eq(profiles.identityId, identityId))

  const [entry] = await db
    .insert(schema.timetableEntries)
    .values({
      memberId,
      identityId,
      name: 'Data Mining',
      type: 'lecture',
      repeat: { kind: 'once', date: '2026-10-21' },
      startTime: '14:00',
      endTime: '16:00',
      link: { kind: 'fixed', url: 'https://example.zoom.us/j/11111111111' },
      transcription: 'live'
    })
    .returning()
  const start = new Date(START)
  const [occ] = await db
    .insert(occurrences)
    .values({
      memberId,
      identityId,
      entryId: entry!.id,
      entryName: 'Data Mining',
      entryType: 'lecture',
      transcription: 'live',
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 2 * HOUR),
      deleteAfter: new Date(start.getTime() + 30 * 24 * HOUR)
    })
    .returning()
  const id = occ!.id
  const env = {
    dataRoot: `${tmp}/${id}/data`,
    profileRoot: `${tmp}/${id}/profiles`,
    publicUrl: 'https://tm.example',
    ntfyUrl: 'https://ntfy.tm.example'
  }
  const docker = new FakeDocker()
  const queue = new FakeQueue()
  const notifier = new FakeNotifier()
  const deps: LaunchDeps = { db, queue, docker, notifier, master: MASTER, env, remux: async () => false }
  const one = async () => (await db.select().from(occurrences).where(eq(occurrences.id, id)))[0]!
  const jobRows = () => db.select().from(companionJobs).where(eq(companionJobs.occurrenceId, id))
  return {
    db,
    deps,
    docker,
    queue,
    notifier,
    env,
    id,
    memberId,
    identityId,
    a1,
    a2,
    job: { occurrenceId: id, scheduledStart: START },
    tMinus60: at('13:00'),
    occurrence: one,
    jobRows,
    setState: (state: OccurrenceState, extra: Partial<typeof occurrences.$inferInsert> = {}) =>
      db
        .update(occurrences)
        .set({ state, ...extra })
        .where(eq(occurrences.id, id)),
    heldBy: async () => (await db.select().from(profiles).where(eq(profiles.identityId, identityId)))[0]!.heldBy
  }
}

test('an online PC gets a local_run job aimed at it alone, with no secret in it', async () => {
  const f = await fixture()
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('launched')
  expect(await f.occurrence()).toMatchObject({ state: 'starting', attempt: 1 })

  const [row] = await f.jobRows()
  expect(row).toMatchObject({ kind: 'local_run', state: 'pending', targetDeviceId: f.a1.deviceId })
  const payload = LocalRunPayloadSchema.parse(row!.payload)
  expect(payload).toMatchObject({ identityName: 'University', image: IMAGE, occurrenceId: f.id })
  expect(JSON.stringify(row!.payload)).not.toMatch(/sk-dash-secret|ntfy-secret/)

  // Only the chosen PC sees it, and only it can take it.
  expect(await listJobsForDevice(f.db, f.a1)).toContainEqual(
    expect.objectContaining({ id: row!.id, kind: 'local_run' })
  )
  expect(await listJobsForDevice(f.db, f.a2)).toEqual([])
  expect(await claimJob(f.db, f.a2, row!.id, f.tMinus60)).toBeNull()
  expect(await claimJob(f.db, f.a1, row!.id, f.tMinus60)).toMatchObject({ id: row!.id, state: 'claimed' })

  const events = await f.db.select().from(companionEvents).where(eq(companionEvents.memberId, f.memberId))
  expect(events.map((e) => [e.deviceId, e.command])).toEqual([
    [f.a1.deviceId, { type: 'job_available', jobId: row!.id }]
  ])
  expect(
    f.queue.sent
      .map((s) => [s.name, s.data, s.opts?.startAfter?.toISOString()])
      .sort((a, b) => `${a[0]}`.localeCompare(`${b[0]}`))
  ).toEqual([
    [QUEUES.localClaimCheck, { jobId: row!.id }, at('13:02').toISOString()],
    [QUEUES.localStartCheck, { jobId: row!.id }, at('13:50').toISOString()]
  ])
  // Nothing runs on this machine, and the profile on the PC is not locked here.
  expect(f.docker.created).toEqual([])
  expect(await f.heldBy()).toBeNull()
  expect(f.notifier.sent).toEqual([])
})

test('a PC not seen for 90 seconds gets no job; the member is pinged once and the meeting is skipped', async () => {
  const f = await fixture({ seen: at('12:58:00') })
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('skipped_pc_offline')
  expect(await f.occurrence()).toMatchObject({ state: 'skipped_pc_offline' })
  expect(await f.jobRows()).toEqual([])
  expect(f.docker.created).toEqual([])
  expect(f.notifier.sent).toHaveLength(1)
  expect(f.notifier.sent[0]!.ping).toMatchObject({
    title: 'PC offline: Data Mining',
    message: "Data Mining (14:00) runs on DESKTOP-ABC, which is asleep or off, so the bot won't join.",
    priority: 'high'
  })
  // A repeat of the launch job changes nothing and says nothing.
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('stale')
  expect(f.notifier.sent).toHaveLength(1)
})

test('an identity without a paired PC is skipped with its own ping and never runs on the server', async () => {
  const f = await fixture({ paired: false })
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('skipped_pc_offline')
  expect(f.notifier.sent.map((s) => s.ping.message)).toEqual([
    "Data Mining (14:00) runs on My PC, but no PC is paired for University, so the bot won't join."
  ])
  expect(f.docker.created).toEqual([])
  expect(await f.heldBy()).toBeNull()
})

test('a revoked PC is handed no job and cannot claim one', async () => {
  const f = await fixture()
  await launchOccurrence(f.deps, f.job, f.tMinus60)
  const [job] = await f.jobRows()
  await f.db
    .update(deviceTokens)
    .set({ revokedAt: at('13:01') })
    .where(eq(deviceTokens.id, f.a1.deviceId))
  expect(await listJobsForDevice(f.db, f.a1)).toEqual([])
  expect(await claimJob(f.db, f.a1, job!.id, at('13:01'))).toBeNull()
})

test('an unclaimed offer is cancelled after 120 s, the meeting skipped and the member pinged once', async () => {
  const f = await fixture()
  await launchOccurrence(f.deps, f.job, f.tMinus60)
  const [job] = await f.jobRows()
  expect(await checkLocalClaim(f.deps, job!.id, at('13:02'))).toBe('skipped_pc_offline')
  expect((await f.jobRows())[0]!.state).toBe('cancelled')
  expect(await f.occurrence()).toMatchObject({ state: 'skipped_pc_offline' })
  expect(f.notifier.sent.map((s) => s.ping.title)).toEqual(['PC offline: Data Mining'])
  expect(await checkLocalClaim(f.deps, job!.id, at('13:03'))).toBe('stale')
  expect(f.notifier.sent).toHaveLength(1)
})

test('a claimed offer passes the claim check', async () => {
  const f = await fixture()
  await launchOccurrence(f.deps, f.job, f.tMinus60)
  const [job] = await f.jobRows()
  await claimJob(f.db, f.a1, job!.id, at('13:01'))
  expect(await checkLocalClaim(f.deps, job!.id, at('13:02'))).toBe('claimed')
  expect(await f.occurrence()).toMatchObject({ state: 'starting' })
  expect(f.notifier.sent).toEqual([])
})

test('a PC that claims but never starts is failed once at T-10 with its last reason and a ping', async () => {
  const f = await fixture()
  await launchOccurrence(f.deps, f.job, f.tMinus60)
  const [job] = await f.jobRows()
  await claimJob(f.db, f.a1, job!.id, at('13:01'))
  await f.db.update(companionJobs).set({ error: 'docker_unavailable' }).where(eq(companionJobs.id, job!.id))
  expect(await checkLocalStart(f.deps, job!.id)).toBe('failed')
  expect(await f.occurrence()).toMatchObject({ state: 'failed', stateReason: 'docker_unavailable' })
  expect((await f.jobRows())[0]).toMatchObject({ state: 'failed', error: 'docker_unavailable' })
  expect(f.notifier.sent.map((s) => s.ping.message)).toEqual([
    "The bot stopped and won't retry (Docker Desktop wasn't running). Anything it recorded is on the meeting page."
  ])
  // The companion's next call finds nothing to hold; a repeat says nothing more.
  expect(await listJobsForDevice(f.db, f.a1)).toEqual([])
  expect(await checkLocalStart(f.deps, job!.id)).toBe('stale')
  expect(await handleLocalStartDead(f.deps, { jobId: job!.id }, at('13:52'))).toBe('stale')
  expect(f.notifier.sent).toHaveLength(1)
})

test('no word from the PC at all fails with pc_lost, and the dead-letter handler does the same', async () => {
  const f = await fixture()
  await launchOccurrence(f.deps, f.job, f.tMinus60)
  const [job] = await f.jobRows()
  expect(await handleLocalStartDead(f.deps, { jobId: job!.id }, at('13:55'))).toBe('failed')
  expect(await f.occurrence()).toMatchObject({ state: 'failed', stateReason: 'pc_lost' })
  expect(f.notifier.sent.map((s) => s.ping.message)).toEqual([
    "The bot stopped and won't retry (your PC stopped responding). Anything it recorded is on the meeting page."
  ])
})

test('a run that has started is running at T-10', async () => {
  const f = await fixture()
  await launchOccurrence(f.deps, f.job, f.tMinus60)
  const [job] = await f.jobRows()
  await f.setState('in_meeting')
  expect(await checkLocalStart(f.deps, job!.id)).toBe('running')
  expect(f.notifier.sent).toEqual([])
})

test('a local run times out after 120 s of silence, but never once it is uploading', () => {
  expect(localHeartbeatTimeout('in_meeting', 119_999)).toBe('none')
  expect(localHeartbeatTimeout('in_meeting', 120_001)).toBe('pc_lost')
  expect(localHeartbeatTimeout('uploading', 36_000_000)).toBe('none')
  expect(localHeartbeatTimeout('transcribing', 36_000_000)).toBe('none')
  expect(localHeartbeatTimeout('starting', 36_000_000)).toBe('none')
})

test('the monitor fails a silent local run once with pc_lost and never starts a server worker for it', async () => {
  const f = await fixture()
  await launchOccurrence(f.deps, f.job, f.tMinus60)
  await f.setState('in_meeting', { lastHeartbeatAt: at('14:00') })
  const quiet = await monitorTick(f.deps, at('14:01:59'))
  expect(quiet).toEqual({ restarted: [], failed: [], released: [] })
  expect(await f.occurrence()).toMatchObject({ state: 'in_meeting' })

  const lost = await monitorTick(f.deps, at('14:02:01'))
  expect(lost.failed).toEqual([f.id])
  expect(lost.restarted).toEqual([])
  expect(await f.occurrence()).toMatchObject({ state: 'failed', stateReason: 'pc_lost' })
  expect((await f.jobRows())[0]).toMatchObject({ state: 'failed', error: 'pc_lost' })
  expect(f.notifier.sent.map((s) => s.ping.message)).toEqual([
    "The bot stopped and won't retry (your PC stopped responding). Anything it recorded is on the meeting page."
  ])
  await monitorTick(f.deps, at('14:03'))
  expect(f.notifier.sent).toHaveLength(1)
  expect(f.docker.created).toEqual([])
})

test('the monitor leaves a local run alone while it starts and while it uploads', async () => {
  const f = await fixture()
  await launchOccurrence(f.deps, f.job, f.tMinus60)
  // Still waiting for the PC to start, an hour later than its last word.
  expect(await monitorTick(f.deps, at('13:40'))).toEqual({ restarted: [], failed: [], released: [] })
  expect(await f.occurrence()).toMatchObject({ state: 'starting' })
  await f.setState('uploading', { lastHeartbeatAt: at('16:00') })
  expect(await monitorTick(f.deps, at('20:00'))).toEqual({ restarted: [], failed: [], released: [] })
  expect(await f.occurrence()).toMatchObject({ state: 'uploading' })
  expect(f.docker.created).toEqual([])
})

test('a server never restarts or starts a worker for a local occurrence', async () => {
  const f = await fixture()
  await launchOccurrence(f.deps, f.job, f.tMinus60)
  await f.setState('in_meeting', { lastHeartbeatAt: at('14:00') })
  await expect(restartOccurrence(f.deps, f.id, at('14:01'))).rejects.toThrow('runs on a PC')
  await expect(startAttempt(f.deps, f.id, 2, at('14:01'))).rejects.toThrow('runs on a PC')
  expect(f.docker.created).toEqual([])
  expect(await f.occurrence()).toMatchObject({ state: 'in_meeting', restarts: 0 })
})

test('local runs use no server slot', async () => {
  const f = await fixture({ location: 'server' })
  for (let i = 0; i < 2; i++) {
    const other = await seedMember(f.db, { full: false })
    await f.db.update(identities).set({ runLocation: 'local' }).where(eq(identities.id, other.identityId))
    await f.db.insert(occurrences).values({
      memberId: other.memberId,
      identityId: other.identityId,
      entryName: 'Other',
      entryType: 'lecture',
      transcription: 'live',
      scheduledStart: new Date(START),
      scheduledEnd: new Date(new Date(START).getTime() + HOUR),
      deleteAfter: new Date(new Date(START).getTime() + 30 * 24 * HOUR),
      state: 'in_meeting'
    })
  }
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('launched')
  expect(f.docker.created).toHaveLength(1)
})

test('a home-route occurrence takes the profile and starts before any worker, then waits for the exit node', async () => {
  const f = await fixture({ location: 'server_via_home' })
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('deferred')
  expect(await f.occurrence()).toMatchObject({ state: 'starting', containerName: null })
  expect(await f.heldBy()).toBe(`occ:${f.id}`)
  expect(f.docker.created).toEqual([])
  expect(f.queue.sent.map((s) => [s.name, s.data])).toEqual([[QUEUES.homeRouteRecheck, { occurrenceId: f.id }]])
  // No container yet is not a crash: the monitor leaves it to the recheck.
  expect(await monitorTick(f.deps, at('13:10'))).toEqual({ restarted: [], failed: [], released: [] })
  expect(await f.occurrence()).toMatchObject({ state: 'starting', restarts: 0 })
  expect(f.docker.created).toEqual([])
})

/** A second meeting of the same identity (so the same PC) that starts at `start`. */
async function secondMeeting(f: Awaited<ReturnType<typeof fixture>>, name: string, start: Date) {
  const [entry] = await f.db.select().from(schema.timetableEntries)
  const [occ] = await f.db
    .insert(occurrences)
    .values({
      memberId: f.memberId,
      identityId: f.identityId,
      entryId: entry!.id,
      entryName: name,
      entryType: 'lecture',
      transcription: 'live',
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + HOUR),
      deleteAfter: new Date(start.getTime() + 30 * 24 * HOUR)
    })
    .returning()
  const row = () =>
    f.db
      .select()
      .from(occurrences)
      .where(eq(occurrences.id, occ!.id))
      .then((r) => r[0]!)
  return { id: occ!.id, job: { occurrenceId: occ!.id, scheduledStart: start.toISOString() }, row }
}

const SECOND_START = new Date('2026-10-21T08:00:00.000Z') // 16:00

test('a busy PC defers the next local meeting, then fails it with its own ping when it is due', async () => {
  const f = await fixture()
  await launchOccurrence(f.deps, f.job, f.tMinus60)
  await f.setState('in_meeting', { lastHeartbeatAt: at('14:00') })
  await f.db
    .update(deviceTokens)
    .set({ lastUsedAt: at('15:00') })
    .where(eq(deviceTokens.id, f.a1.deviceId))
  const second = await secondMeeting(f, 'Algorithms', SECOND_START)

  // Not due yet: looked at again in 15 seconds, nothing offered, nobody pinged.
  expect(await launchOccurrence(f.deps, second.job, at('15:00'))).toBe('deferred')
  expect(await second.row()).toMatchObject({ state: 'scheduled' })
  expect(f.queue.sent.filter((s) => s.name === QUEUES.launch).map((s) => s.opts?.startAfter?.toISOString())).toEqual([
    at('15:00:15').toISOString()
  ])
  expect(await f.db.select().from(companionJobs).where(eq(companionJobs.occurrenceId, second.id))).toEqual([])
  expect(f.notifier.sent).toEqual([])

  // Due and the PC is still running the first meeting: failed once, with the busy copy and not "asleep or off".
  await f.db
    .update(deviceTokens)
    .set({ lastUsedAt: at('16:00') })
    .where(eq(deviceTokens.id, f.a1.deviceId))
  expect(await launchOccurrence(f.deps, second.job, at('16:00'))).toBe('failed')
  expect(await second.row()).toMatchObject({ state: 'failed', stateReason: 'pc_busy' })
  expect(f.notifier.sent.map((s) => s.ping.message)).toEqual([
    "Your PC is still busy with Data Mining, so the bot won't join Algorithms."
  ])
  expect(await launchOccurrence(f.deps, second.job, at('16:00:15'))).toBe('stale')
  expect(f.notifier.sent).toHaveLength(1)
  // The first meeting is untouched.
  expect(await f.occurrence()).toMatchObject({ state: 'in_meeting' })
})

test('a meeting waits while the earlier one uploads or is cut on the PC, and is offered once the PC is free', async () => {
  const f = await fixture()
  await launchOccurrence(f.deps, f.job, f.tMinus60)
  const [job] = await f.jobRows()
  await claimJob(f.db, f.a1, job!.id, at('13:01'))
  await f.db
    .update(deviceTokens)
    .set({ lastUsedAt: at('16:00') })
    .where(eq(deviceTokens.id, f.a1.deviceId))
  const second = await secondMeeting(f, 'Algorithms', SECOND_START)

  await f.setState('uploading')
  expect(await launchOccurrence(f.deps, second.job, at('15:50'))).toBe('deferred')
  // `transcribing` while the PC still holds the job: it is cutting and transcribing the audio.
  await f.setState('transcribing')
  expect(await launchOccurrence(f.deps, second.job, at('15:50:15'))).toBe('deferred')
  // The job is done: the PC is free, and a launch after that goes out.
  await f.db.update(companionJobs).set({ state: 'done' }).where(eq(companionJobs.id, job!.id))
  expect(await launchOccurrence(f.deps, second.job, at('15:50:30'))).toBe('launched')
  expect(await second.row()).toMatchObject({ state: 'starting' })
  expect(f.notifier.sent).toEqual([])
})

test('a PC only waits for meetings that start before the one being launched', async () => {
  const f = await fixture()
  const second = await secondMeeting(f, 'Algorithms', SECOND_START)
  // The later meeting is already running; the 14:00 one is not held up by it.
  await f.db.update(occurrences).set({ state: 'in_meeting' }).where(eq(occurrences.id, second.id))
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('launched')
})

test('a late offer gives the PC five minutes before the start check', async () => {
  const f = await fixture({ seen: at('13:54:30') })
  expect(await launchOccurrence(f.deps, f.job, at('13:55'))).toBe('launched')
  const check = f.queue.sent.find((s) => s.name === QUEUES.localStartCheck)!
  expect(check.opts?.startAfter?.toISOString()).toBe(at('14:00').toISOString())
  // An early offer keeps T-10.
  const g = await fixture()
  await launchOccurrence(g.deps, g.job, g.tMinus60)
  expect(g.queue.sent.find((s) => s.name === QUEUES.localStartCheck)!.opts?.startAfter?.toISOString()).toBe(
    at('13:50').toISOString()
  )
})
