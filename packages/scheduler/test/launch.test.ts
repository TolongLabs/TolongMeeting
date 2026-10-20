import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { JobConfigSchema, type OccurrenceState } from '@tm/core'
import { and, eq, sql } from 'drizzle-orm'
import { events, identities, occurrences, profiles, schema, signinSessions, type Db } from '@tm/web/db'
import { FakeNotifier } from '@tm/web/db/notifier'
import { QUEUES } from '@tm/web/db/queues'
import { sealColumn } from '@tm/web/db/secrets'
import { FakeQueue, createTestDb, dropAllTestDbs, seedMember } from '@tm/web/db/testing'
import { validateRequest } from '../src/docker-gate/validate'
import {
  DockerError,
  FakeDocker,
  dockerClient,
  handleDeadLaunchJob,
  launchOccurrence,
  monitorTick,
  resumeJobFileWatchers,
  settleRemuxes,
  startAttempt,
  stopJobFileWatchers,
  type LaunchDeps
} from '../src/index'

const MASTER = Buffer.alloc(32, 3)
const sha256hex = (t: string) => createHash('sha256').update(t).digest('hex')
const HOUR = 3_600_000

let tmp: string
beforeAll(async () => {
  tmp = await mkdtemp(`${tmpdir()}/launch-`)
})
afterEach(stopJobFileWatchers)
afterAll(async () => {
  await dropAllTestDbs()
  await rm(tmp, { recursive: true, force: true })
}, 60_000)

interface Options {
  link?: { kind: 'paste' } | { kind: 'fixed'; url: string }
  pasted?: string
  clashWith?: { start: string; end: string }
  activeElsewhere?: number
  earlierHolding?: { end: string; state: OccurrenceState }
  signinHolding?: boolean
  dockerFails?: boolean
  runLocation?: 'server' | 'local'
}

const START = '2026-10-21T06:00:00.000Z'

async function launchFixture(o: Options = {}) {
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
  if (o.runLocation)
    await db.update(identities).set({ runLocation: o.runLocation }).where(eq(identities.id, identityId))

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
      link: o.link ?? { kind: 'fixed', url: 'https://example.zoom.us/j/11111111111' },
      transcription: 'live'
    })
    .returning()
  const start = new Date(START)
  const slot = (s: Date, e: Date) => ({
    memberId,
    identityId,
    entryName: 'Other',
    entryType: 'lecture' as const,
    transcription: 'live' as const,
    scheduledStart: s,
    scheduledEnd: e,
    deleteAfter: new Date(e.getTime() + 30 * 24 * HOUR)
  })
  const [occ] = await db
    .insert(occurrences)
    .values({
      ...slot(start, new Date(start.getTime() + 2 * HOUR)),
      entryId: entry!.id,
      entryName: 'Data Mining',
      pastedLink: o.pasted ?? null
    })
    .returning()
  const id = occ!.id

  if (o.clashWith) {
    await db.insert(occurrences).values(slot(new Date(o.clashWith.start), new Date(o.clashWith.end)))
  }
  for (let i = 0; i < (o.activeElsewhere ?? 0); i++) {
    const other = await seedMember(db, { full: false })
    await db.insert(occurrences).values({
      ...slot(start, new Date(start.getTime() + HOUR)),
      memberId: other.memberId,
      identityId: other.identityId,
      state: 'in_meeting'
    })
  }
  let earlierId: string | undefined
  if (o.earlierHolding) {
    const end = new Date(o.earlierHolding.end)
    const [earlier] = await db
      .insert(occurrences)
      .values({ ...slot(new Date(end.getTime() - 2 * HOUR), end), state: o.earlierHolding.state })
      .returning()
    earlierId = earlier!.id
    await db
      .update(profiles)
      .set({ heldBy: `occ:${earlierId}` })
      .where(eq(profiles.identityId, identityId))
  }
  let sessionId: string | undefined
  if (o.signinHolding) {
    const [session] = await db.insert(signinSessions).values({ memberId, identityId, mode: 'container' }).returning()
    sessionId = session!.id
    await db
      .update(profiles)
      .set({ heldBy: `signin:${sessionId}` })
      .where(eq(profiles.identityId, identityId))
  }

  const env = {
    dataRoot: `${tmp}/${id}/data`,
    profileRoot: `${tmp}/${id}/profiles`,
    publicUrl: 'https://tm.example',
    ntfyUrl: 'https://ntfy.tm.example'
  }
  const docker = new FakeDocker()
  if (o.dockerFails) docker.createError = new DockerError('create', 404, 'image not found')
  const queue = new FakeQueue()
  const notifier = new FakeNotifier()
  const deps: LaunchDeps = {
    db,
    queue,
    docker,
    notifier,
    master: MASTER,
    env,
    remux: async () => false,
    exitPollMs: 10
  }
  const one = async (table: typeof occurrences, rowId: string) =>
    (await db.select().from(table).where(eq(table.id, rowId)))[0]!
  return {
    db,
    deps,
    docker,
    queue,
    notifier,
    env,
    cfg: env,
    id,
    memberId,
    identityId,
    job: { occurrenceId: id, scheduledStart: START },
    tMinus60: new Date(start.getTime() - HOUR),
    occurrence: () => one(occurrences, id),
    earlier: () => one(occurrences, earlierId!),
    signinSession: async () => (await db.select().from(signinSessions).where(eq(signinSessions.id, sessionId!)))[0]!,
    heldBy: async () => (await db.select().from(profiles).where(eq(profiles.identityId, identityId)))[0]!.heldBy,
    eventsOf: () => db.select().from(events).where(eq(events.occurrenceId, id)),
    jobBase: () => `${env.profileRoot}/${identityId}/job/tm-worker-${id}-a1`,
    job0: async () =>
      JobConfigSchema.parse(await Bun.file(`${env.profileRoot}/${identityId}/job/tm-worker-${id}-a1.json`).json())
  }
}

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await Bun.sleep(10)
  }
}

test('a due occurrence launches with a private job file and a hashed token', async () => {
  const f = await launchFixture()
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('launched')
  const o = await f.occurrence()
  expect(o).toMatchObject({ state: 'starting', attempt: 1, containerName: `tm-worker-${f.id}-a1` })
  expect(o.lastHeartbeatAt).toEqual(f.tMinus60)
  expect(
    validateRequest(
      { method: 'POST', path: `/containers/create?name=${o.containerName}`, body: f.docker.created[0]!.body },
      f.cfg
    ).ok
  ).toBe(true)
  expect(f.docker.started).toEqual([f.docker.created[0]!.id])
  const jobPath = `${f.env.profileRoot}/${f.identityId}/job/${o.containerName}.json`
  expect((await stat(jobPath)).mode & 0o777).toBe(0o600)
  expect((await stat(`${f.env.profileRoot}/${f.identityId}/job/${o.containerName}.key`)).mode & 0o777).toBe(0o600)
  const job = JobConfigSchema.parse(await Bun.file(jobPath).json())
  expect(job.control!.url).toBe('https://tm.example/api/control')
  expect(job.control!.token.startsWith('1.')).toBe(true)
  expect(o.controlTokenHash).toBe(sha256hex(job.control!.token))
  expect(job).toMatchObject({
    attempt: 1,
    ai: { apiKey: 'sk-dash-secret' },
    ntfy: { url: 'https://ntfy.tm.example', topic: 'tm-topic', token: 'ntfy-secret' },
    entry: { name: 'Data Mining', start: '2026-10-21T14:00:00+08:00' },
    dataDir: `${f.env.dataRoot}/occurrences/${f.id}`,
    profileDir: `${f.env.profileRoot}/${f.identityId}/work`
  })
  expect(o.entrySnapshot).toEqual(job.entry)
  expect(o.linkUsed).toBe('https://example.zoom.us/j/11111111111')
  expect(await f.heldBy()).toBe(`occ:${f.id}`)
  expect((await f.eventsOf()).map((e) => e.data)).toMatchObject([
    { from: 'scheduled', to: 'starting', trigger: 'launch' }
  ])
  expect(f.notifier.sent).toEqual([])
})

test('the machine-id and job directories are real directories before create', async () => {
  const f = await launchFixture()
  // A worker could plant a symlink at the machine-id path between launches.
  await mkdir(`${f.env.profileRoot}/.machine-ids`, { recursive: true, mode: 0o755 })
  await writeFile(`${tmp}/${f.id}/victim`, 'secret')
  await symlink(`${tmp}/${f.id}/victim`, `${f.env.profileRoot}/.machine-ids/${f.identityId}`)
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('launched')
  const file = `${f.env.profileRoot}/.machine-ids/${f.identityId}`
  expect((await lstat(file)).isFile()).toBe(true)
  expect(await readFile(file, 'utf8')).toBe(`${createHash('sha256').update(f.identityId).digest('hex').slice(0, 32)}\n`)
  expect(await readFile(`${tmp}/${f.id}/victim`, 'utf8')).toBe('secret')
})

test('job and key files are deleted once the container has exited', async () => {
  const f = await launchFixture()
  await launchOccurrence(f.deps, f.job, f.tMinus60)
  const dir = `${f.env.profileRoot}/${f.identityId}/job`
  expect((await readdir(dir)).sort()).toEqual([`tm-worker-${f.id}-a1.json`, `tm-worker-${f.id}-a1.key`])
  await Bun.sleep(50)
  expect((await readdir(dir)).length).toBe(2) // still running
  f.docker.inspectResults.set(`tm-worker-${f.id}-a1`, null)
  await until(async () => (await readdir(dir)).length === 0)
})

test('a leftover file from an earlier container is deleted at the next launch', async () => {
  const f = await launchFixture()
  const dir = `${f.env.profileRoot}/${f.identityId}/job`
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(`${dir}/tm-worker-old-a1.key`, 'stale')
  await launchOccurrence(f.deps, f.job, f.tMinus60)
  expect(await readdir(dir)).not.toContain('tm-worker-old-a1.key')
})

test('a stale launch job does nothing', async () => {
  const f = await launchFixture()
  expect(await launchOccurrence(f.deps, { ...f.job, scheduledStart: '2026-10-21T07:00:00.000Z' }, f.tMinus60)).toBe(
    'stale'
  )
  expect(await launchOccurrence(f.deps, { ...f.job, occurrenceId: randomUUID() }, f.tMinus60)).toBe('stale')
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('launched')
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('stale') // no longer scheduled
  expect(f.docker.created.length).toBe(1)
})

test('a job that runs after the meeting is over fails the occurrence instead of leaving it scheduled', async () => {
  const f = await launchFixture()
  expect(await launchOccurrence(f.deps, f.job, new Date('2026-10-21T08:00:00Z'))).toBe('failed')
  expect(await f.occurrence()).toMatchObject({ state: 'failed', stateReason: 'launch_missed' })
  expect(f.docker.created).toEqual([])
  expect((await f.eventsOf()).length).toBe(2)
  expect(f.notifier.sent[0]!.ping.message).toContain("it couldn't start")
})

describe('a launch job whose retries are spent', () => {
  test('fails a scheduled occurrence that is past its start, pings once and then drops the repeat', async () => {
    const f = await launchFixture()
    const late = new Date('2026-10-21T06:05:00Z')
    expect(await handleDeadLaunchJob(f.deps, f.job, late)).toBe('failed')
    expect(await f.occurrence()).toMatchObject({ state: 'failed', stateReason: 'launch_failed' })
    expect(f.notifier.sent).toHaveLength(1)
    expect(f.notifier.sent[0]!.ping.message).toContain("it couldn't start")
    expect(await handleDeadLaunchJob(f.deps, f.job, late)).toBe('stale')
    expect(f.notifier.sent).toHaveLength(1)
  })

  test('waits for the start before it fails anything', async () => {
    const f = await launchFixture()
    expect(await handleDeadLaunchJob(f.deps, f.job, f.tMinus60)).toBe('deferred')
    expect(await f.occurrence()).toMatchObject({ state: 'scheduled' })
    expect(f.notifier.sent).toEqual([])
    expect(f.queue.sent).toEqual([{ name: QUEUES.launchDead, data: f.job, opts: { startAfter: new Date(START) } }])
  })

  test('leaves an occurrence that has moved on, or moved, alone', async () => {
    const f = await launchFixture()
    expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('launched')
    expect(await handleDeadLaunchJob(f.deps, f.job, new Date('2026-10-21T06:05:00Z'))).toBe('stale')
    expect(await f.occurrence()).toMatchObject({ state: 'starting' })
    expect(await handleDeadLaunchJob(f.deps, { ...f.job, occurrenceId: randomUUID() }, new Date(START))).toBe('stale')
    expect(f.notifier.sent).toEqual([])
  })
})

test('the later of two clashing occurrences is skipped with a ping', async () => {
  const f = await launchFixture({ clashWith: { start: '2026-10-21T05:30:00Z', end: '2026-10-21T07:00:00Z' } })
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('skipped_identity_clash')
  expect(await f.occurrence()).toMatchObject({ state: 'skipped_identity_clash' })
  expect(f.notifier.sent[0]!.ping.title).toBe('Skipped: Data Mining')
  expect(f.docker.created).toEqual([])
})

test('a third server worker is skipped with a capacity ping', async () => {
  const f = await launchFixture({ activeElsewhere: 2 })
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('skipped_capacity')
  expect(await f.occurrence()).toMatchObject({ state: 'skipped_capacity' })
  expect(f.notifier.sent[0]!.ping.title).toBe('Skipped: Data Mining (server full)')
  expect(await f.heldBy()).toBeNull()
})

test('back-to-back occurrences on one identity wait for the earlier worker', async () => {
  const f = await launchFixture({ earlierHolding: { end: '2026-10-21T06:00:00Z', state: 'in_meeting' } })
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('deferred')
  expect(f.queue.sent.at(-1)).toMatchObject({
    name: QUEUES.launch,
    data: f.job,
    opts: { startAfter: new Date(f.tMinus60.getTime() + 15_000) }
  })
  expect(f.queue.sent.at(-1)!.opts?.singletonKey).toBeUndefined()
  expect((await f.earlier()).pendingCommands).toEqual([])
  expect(await launchOccurrence(f.deps, f.job, new Date('2026-10-21T06:00:00Z'))).toBe('deferred')
  expect((await f.earlier()).pendingCommands).toEqual(['stop'])
  expect(await launchOccurrence(f.deps, f.job, new Date('2026-10-21T06:00:15Z'))).toBe('deferred')
  expect((await f.earlier()).pendingCommands).toEqual(['stop']) // asked once
  expect((await f.occurrence()).state).toBe('scheduled')
  expect(f.docker.created).toEqual([])
})

test('an identity held by a sign-in is asked to finish first', async () => {
  const f = await launchFixture({ signinHolding: true })
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('deferred')
  expect((await f.signinSession()).doneRequested).toBe(true)
})

test('a pasted link becomes the job link', async () => {
  const f = await launchFixture({
    link: { kind: 'paste' },
    pasted: 'https://example.zoom.us/j/00000000000?pwd=PASSCODE'
  })
  await launchOccurrence(f.deps, f.job, f.tMinus60)
  expect((await f.job0()).entry.link).toEqual({
    kind: 'fixed',
    url: 'https://example.zoom.us/j/00000000000?pwd=PASSCODE'
  })
  expect((await f.occurrence()).linkUsed).toBe('https://example.zoom.us/j/00000000000?pwd=PASSCODE')
})

test("a container that can't be created fails the occurrence, pings and deletes the job files", async () => {
  const f = await launchFixture({ dockerFails: true })
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('failed')
  expect(await f.occurrence()).toMatchObject({ state: 'failed', stateReason: 'launch_failed' })
  expect(await f.heldBy()).toBeNull()
  expect(f.notifier.sent[0]!.ping.message).toContain("it couldn't start")
  expect(await readdir(`${f.env.profileRoot}/${f.identityId}/job`)).toEqual([])
})

test('an identity that is not the occurrence member’s is refused', async () => {
  const f = await launchFixture()
  const other = await seedMember(f.db, { full: false })
  // The composite foreign key would stop this row; drop it to model a forged one.
  await f.db.execute(sql`alter table occurrences drop constraint occurrences_identity_id_identities_id_fk`)
  await f.db.update(occurrences).set({ identityId: other.identityId }).where(eq(occurrences.id, f.id))
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('failed')
  expect(await f.occurrence()).toMatchObject({ state: 'failed', stateReason: 'identity_not_owned' })
  expect(f.docker.created).toEqual([])
})

test('an identity that does not run on the server fails the launch', async () => {
  const f = await launchFixture({ runLocation: 'local' })
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('failed')
  expect(await f.occurrence()).toMatchObject({ state: 'failed', stateReason: 'run_location_unavailable' })
})

test('startAttempt for a later attempt writes its own token and names', async () => {
  const f = await launchFixture()
  await launchOccurrence(f.deps, f.job, f.tMinus60)
  const first = await f.occurrence()
  await startAttempt(f.deps, f.id, 2, new Date(f.tMinus60.getTime() + 60_000))
  const second = await f.occurrence()
  expect(second).toMatchObject({ attempt: 2, containerName: `tm-worker-${f.id}-a2` })
  expect(second.controlTokenHash).not.toBe(first.controlTokenHash)
  expect(f.docker.created.map((c) => c.name)).toEqual([`tm-worker-${f.id}-a1`, `tm-worker-${f.id}-a2`])
})

test('no secret reaches the logs', async () => {
  const logs: string[] = []
  const spies = (['error', 'warn', 'log'] as const).map((k) => {
    const orig = console[k]
    console[k] = (...args: unknown[]) => void logs.push(args.join(' '))
    return () => (console[k] = orig)
  })
  try {
    const f = await launchFixture({ dockerFails: true })
    await launchOccurrence(f.deps, f.job, f.tMinus60)
    await launchOccurrence(f.deps, f.job, f.tMinus60)
  } finally {
    spies.forEach((restore) => restore())
  }
  expect(logs.length).toBeGreaterThan(0)
  expect(logs.join('\n')).not.toMatch(/sk-dash-secret|ntfy-secret|pwd=/)
})

test('a Docker call that never answers times out and fails the launch with the profile key deleted', async () => {
  const f = await launchFixture()
  const hang = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
    })) as unknown as typeof fetch
  const docker = dockerClient('http://docker-proxy:2375', hang, { quickMs: 20, slowMs: 20 })
  expect(await launchOccurrence({ ...f.deps, docker }, f.job, f.tMinus60)).toBe('failed')
  expect(await f.occurrence()).toMatchObject({ state: 'failed', stateReason: 'launch_failed' })
  expect(await f.heldBy()).toBeNull()
  expect(await readdir(`${f.env.profileRoot}/${f.identityId}/job`)).toEqual([])
})

test('a start that may have gone through keeps the profile held until the container is gone', async () => {
  const f = await launchFixture()
  f.docker.startError = Object.assign(new Error('no answer'), { name: 'TimeoutError' })
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('failed')
  expect(await f.occurrence()).toMatchObject({ state: 'failed', stateReason: 'launch_failed' })
  expect(await readdir(`${f.env.profileRoot}/${f.identityId}/job`)).toEqual([])
  const name = `tm-worker-${f.id}-a1`
  expect(await f.heldBy()).toBe(`occ:${f.id}`)
  // The fake Docker has the created container running: the profile stays held through the monitor's passes.
  f.docker.inspectResults.set(name, { running: true })
  await monitorTick(f.deps, f.tMinus60)
  await settleRemuxes()
  expect(await f.heldBy()).toBe(`occ:${f.id}`)
  expect(f.docker.removed).toEqual([])
  // It never started after all: stopped, so the monitor removes it and then gives the profile back.
  f.docker.inspectResults.set(name, { running: false })
  await monitorTick(f.deps, f.tMinus60)
  await settleRemuxes()
  await monitorTick(f.deps, f.tMinus60)
  expect(f.docker.removed).toEqual([name])
  expect(await f.heldBy()).toBeNull()
})

test('a start that timed out and then exited on its own (AutoRemove) is released without a remove', async () => {
  const f = await launchFixture()
  f.docker.startError = Object.assign(new Error('no answer'), { name: 'TimeoutError' })
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('failed')
  expect(f.docker.removed).toEqual([])
  f.docker.inspectResults.set(`tm-worker-${f.id}-a1`, null)
  await monitorTick(f.deps, f.tMinus60)
  await settleRemuxes()
  await monitorTick(f.deps, f.tMinus60)
  expect(f.docker.removed).toEqual([])
  expect(await f.heldBy()).toBeNull()
})

test('a start that Docker refused removes the created container and gives the profile back at once', async () => {
  const f = await launchFixture()
  f.docker.startError = new DockerError('start', 500, 'no such image')
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('failed')
  expect(f.docker.removed).toEqual(['fake-1'])
  expect(await f.heldBy()).toBeNull()
})

test('a start that Docker refused keeps the profile held when the container cannot be removed; the monitor removes it', async () => {
  const f = await launchFixture()
  f.docker.startError = new DockerError('start', 500, 'no such image')
  f.docker.removeError = new DockerError('remove', 0, 'proxy unreachable')
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('failed')
  expect(f.docker.removed).toEqual([])
  expect(await f.heldBy()).toBe(`occ:${f.id}`)
  const name = `tm-worker-${f.id}-a1`
  // Docker is back and the container never ran.
  f.docker.removeError = null
  f.docker.inspectResults.set(name, { running: false })
  await monitorTick(f.deps, f.tMinus60)
  await settleRemuxes()
  await monitorTick(f.deps, f.tMinus60)
  expect(f.docker.removed).toEqual([name])
  expect(await f.heldBy()).toBeNull()
})

test('a create that failed removes nothing', async () => {
  const f = await launchFixture({ dockerFails: true })
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('failed')
  expect(f.docker.removed).toEqual([])
})

test('an error that is not a Docker or filesystem failure is not hidden as launch_failed, and the key is deleted', async () => {
  const f = await launchFixture()
  f.docker.createError = new Error('something else')
  await expect(launchOccurrence(f.deps, f.job, f.tMinus60)).rejects.toThrow('something else')
  expect(await readdir(`${f.env.profileRoot}/${f.identityId}/job`)).toEqual([])
  expect((await f.occurrence()).state).toBe('scheduled') // the transaction rolled back
})

test('a filesystem error while preparing the job directory fails the launch', async () => {
  const f = await launchFixture()
  // A job directory the scheduler can't write to: opening the temp file fails with EACCES.
  const jobDir = `${f.env.profileRoot}/${f.identityId}/job`
  await mkdir(`${f.env.profileRoot}/${f.identityId}`, { recursive: true, mode: 0o755 })
  await mkdir(jobDir, { mode: 0o500 })
  expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('failed')
  expect(await f.occurrence()).toMatchObject({ state: 'failed', stateReason: 'launch_failed' })
})

describe('an occurrence that can no longer launch never stays scheduled', () => {
  test('its member is gone', async () => {
    const f = await launchFixture()
    // The foreign keys make this impossible in practice; drop them (and the events' one) to model a corrupt row.
    const fks = await f.db.execute(
      sql`select conrelid::regclass::text as tbl, conname from pg_constraint
        where conrelid in ('occurrences'::regclass, 'events'::regclass) and contype = 'f'`
    )
    for (const { tbl, conname } of fks.rows as { tbl: string; conname: string }[]) {
      await f.db.execute(sql.raw(`alter table ${tbl} drop constraint "${conname}"`))
    }
    await f.db.update(occurrences).set({ memberId: randomUUID() }).where(eq(occurrences.id, f.id))
    expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('failed')
    expect(await f.occurrence()).toMatchObject({ state: 'failed', stateReason: 'member_missing' })
    expect(f.notifier.sent).toEqual([])
    expect(f.docker.created).toEqual([])
  })

  test('its timetable entry was deleted', async () => {
    const f = await launchFixture()
    await f.db.delete(schema.timetableEntries)
    expect((await f.occurrence()).entryId).toBeNull()
    expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('failed')
    expect(await f.occurrence()).toMatchObject({ state: 'failed', stateReason: 'entry_missing' })
    expect(f.notifier.sent[0]!.ping.message).toContain("it couldn't start")
    expect(f.docker.created).toEqual([])
  })

  test('its identity has no profile', async () => {
    const f = await launchFixture()
    await f.db.delete(profiles).where(eq(profiles.identityId, f.identityId))
    expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('failed')
    expect(await f.occurrence()).toMatchObject({ state: 'failed', stateReason: 'profile_missing' })
    expect(f.docker.created).toEqual([])
  })

  test('its profile is held by something the launcher does not know', async () => {
    const f = await launchFixture()
    await f.db.update(profiles).set({ heldBy: 'who-knows' }).where(eq(profiles.identityId, f.identityId))
    expect(await launchOccurrence(f.deps, f.job, f.tMinus60)).toBe('failed')
    expect(await f.occurrence()).toMatchObject({ state: 'failed', stateReason: 'holder_unknown' })
    expect(await f.heldBy()).toBe('who-knows')
    expect(f.queue.sent).toEqual([])
  })
})

test('two launches for one identity window at once: one launches, the other is skipped', async () => {
  const f = await launchFixture()
  const [entry] = await f.db
    .insert(schema.timetableEntries)
    .values({
      memberId: f.memberId,
      identityId: f.identityId,
      name: 'Second',
      type: 'lecture',
      repeat: { kind: 'once', date: '2026-10-21' },
      startTime: '14:00',
      endTime: '16:00',
      link: { kind: 'fixed', url: 'https://example.zoom.us/j/22222222222' },
      transcription: 'live'
    })
    .returning()
  const start = new Date(START)
  const [second] = await f.db
    .insert(occurrences)
    .values({
      memberId: f.memberId,
      identityId: f.identityId,
      entryId: entry!.id,
      entryName: 'Second',
      entryType: 'lecture',
      transcription: 'live',
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 2 * HOUR),
      deleteAfter: new Date(start.getTime() + 30 * 24 * HOUR)
    })
    .returning()
  const results = await Promise.all([
    launchOccurrence(f.deps, f.job, f.tMinus60),
    launchOccurrence(f.deps, { occurrenceId: second!.id, scheduledStart: START }, f.tMinus60)
  ])
  expect([...results].sort()).toEqual(['launched', 'skipped_identity_clash'])
  expect(f.docker.created.length).toBe(1)
  expect(f.notifier.sent.length).toBe(1)
})

test('after a scheduler restart, leftover job files go with their dead container and the running one is watched', async () => {
  const f = await launchFixture()
  const dir = `${f.env.profileRoot}/${f.identityId}/job`
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await mkdir(`${f.env.profileRoot}/.machine-ids`, { recursive: true })
  const dead = `tm-worker-${randomUUID()}-a1`
  const alive = `tm-worker-${randomUUID()}-a2`
  for (const name of [dead, alive]) {
    await writeFile(`${dir}/${name}.json`, '{}')
    await writeFile(`${dir}/${name}.key`, 'key')
  }
  await writeFile(`${dir}/.tmp.0123abcd`, 'half-written key')
  await writeFile(`${dir}/notes.txt`, 'not ours')

  const docker = new FakeDocker() // a fresh process: it remembers nothing
  docker.inspectResults.set(dead, null)
  docker.inspectResults.set(alive, { running: true })
  expect(await resumeJobFileWatchers({ ...f.deps, docker })).toEqual({ removed: 1, watching: 1 })
  expect((await readdir(dir)).sort()).toEqual(['notes.txt', `${alive}.json`, `${alive}.key`])

  docker.inspectResults.set(alive, { running: false })
  await until(async () => (await readdir(dir)).join() === 'notes.txt')
})

test('a Docker that is down at restart leaves the files to the watcher, which deletes them once it answers', async () => {
  const f = await launchFixture()
  const dir = `${f.env.profileRoot}/${f.identityId}/job`
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const name = `tm-signin-${randomUUID()}`
  await writeFile(`${dir}/${name}.key`, 'key')
  let up = false
  const docker = new FakeDocker()
  docker.inspect = async () => {
    if (!up) throw new DockerError('inspect', 0, 'proxy unreachable')
    return null
  }
  const spy = console.error
  console.error = () => {}
  try {
    expect(await resumeJobFileWatchers({ ...f.deps, docker })).toEqual({ removed: 0, watching: 1 })
    await Bun.sleep(40)
    expect(await readdir(dir)).toEqual([`${name}.key`])
    up = true
    await until(async () => (await readdir(dir)).length === 0)
  } finally {
    console.error = spy
  }
})
