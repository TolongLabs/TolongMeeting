import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { SigninJobSchema, controlTokenHash } from '@tm/core'
import { eq } from 'drizzle-orm'
import { occurrences, profiles, signinSessions } from '@tm/web/db'
import { FakeNotifier } from '@tm/web/db/notifier'
import { FakeQueue, createTestDb, dropAllTestDbs, seedMember } from '@tm/web/db/testing'
import { validateRequest } from '../src/docker-gate/validate'
import {
  DockerError,
  FakeDocker,
  SIGNIN_SILENT_MS,
  SIGNIN_MAX_MS,
  SIGNIN_START_MS,
  SIGNIN_UNREACHABLE_FAIL_MS,
  monitorTick,
  startSigninContainer,
  stopJobFileWatchers,
  type LaunchDeps
} from '../src/index'

const HOUR = 3_600_000
const NOW = new Date('2026-10-21T06:30:00Z')

let tmp: string
beforeAll(async () => {
  tmp = await mkdtemp(`${tmpdir()}/signin-`)
})
afterEach(stopJobFileWatchers)
afterAll(async () => {
  await dropAllTestDbs()
  await rm(tmp, { recursive: true, force: true })
}, 60_000)

interface Options {
  /** A meeting worker in this state holds the identity. */
  workerHolding?: { state: 'in_meeting' | 'restarting'; attempt: number; lastHeartbeatAt?: Date }
  /** An earlier sign-in's session (ended) still holds the profile. */
  earlierSignin?: boolean
  doneRequested?: boolean
  state?: 'starting' | 'ready' | 'ended'
  mode?: 'container' | 'worker'
  startedAt?: Date
  lastHeartbeatAt?: Date | null
  /** The profile is already held by this session (a container is expected). */
  holding?: boolean
  endedAt?: Date
  dockerFails?: boolean
}

async function signinLaunchFixture(o: Options = {}) {
  const db = await createTestDb()
  const { memberId, identityId } = await seedMember(db, { full: false })
  let occurrenceId: string | null = null
  if (o.workerHolding) {
    const start = new Date(NOW.getTime() - HOUR)
    const [occ] = await db
      .insert(occurrences)
      .values({
        memberId,
        identityId,
        entryName: 'Data Mining',
        entryType: 'lecture',
        transcription: 'live',
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + 2 * HOUR),
        deleteAfter: new Date(start.getTime() + 30 * 24 * HOUR),
        state: o.workerHolding.state,
        attempt: o.workerHolding.attempt,
        lastHeartbeatAt: o.workerHolding.lastHeartbeatAt ?? NOW,
        containerName: `tm-worker-x-a${o.workerHolding.attempt}`
      })
      .returning()
    occurrenceId = occ!.id
    await db
      .update(profiles)
      .set({ heldBy: `occ:${occurrenceId}` })
      .where(eq(profiles.identityId, identityId))
  }
  let earlierId: string | null = null
  if (o.earlierSignin) {
    const [earlier] = await db
      .insert(signinSessions)
      .values({ memberId, identityId, mode: 'container', state: 'ended', endedAt: NOW })
      .returning()
    earlierId = earlier!.id
    await db
      .update(profiles)
      .set({ heldBy: `signin:${earlierId}` })
      .where(eq(profiles.identityId, identityId))
  }
  const mode = o.mode ?? 'container'
  const [session] = await db
    .insert(signinSessions)
    .values({
      memberId,
      identityId,
      mode,
      state: o.state ?? 'starting',
      doneRequested: o.doneRequested ?? false,
      startedAt: o.startedAt ?? NOW,
      lastHeartbeatAt: o.lastHeartbeatAt ?? null,
      endedAt: o.endedAt ?? null,
      ...(mode === 'worker' && occurrenceId
        ? { occurrenceId, upstream: `tm-worker-${occurrenceId}-a${o.workerHolding!.attempt}:6080` }
        : o.holding || o.state === 'ready'
          ? { upstream: 'x' }
          : {})
    })
    .returning()
  const sessionId = session!.id
  if (o.holding)
    await db
      .update(profiles)
      .set({ heldBy: `signin:${sessionId}` })
      .where(eq(profiles.identityId, identityId))

  const env = {
    dataRoot: `${tmp}/${sessionId}/data`,
    profileRoot: `${tmp}/${sessionId}/profiles`,
    publicUrl: 'https://tm.example',
    ntfyUrl: 'https://ntfy.tm.example'
  }
  const docker = new FakeDocker()
  if (o.dockerFails) docker.createError = new DockerError('create', 404, 'image not found')
  const queue = new FakeQueue()
  const deps: LaunchDeps = {
    db,
    queue,
    docker,
    notifier: new FakeNotifier(),
    master: Buffer.alloc(32, 3),
    env,
    remux: async () => false,
    exitPollMs: 60_000
  }
  return {
    db,
    deps,
    docker,
    queue,
    env,
    cfg: env,
    memberId,
    identityId,
    sessionId,
    occurrenceId,
    earlierId,
    now: NOW,
    session: async () => (await db.select().from(signinSessions).where(eq(signinSessions.id, sessionId)))[0]!,
    occurrence: async () => (await db.select().from(occurrences).where(eq(occurrences.id, occurrenceId!)))[0]!,
    heldBy: async () => (await db.select().from(profiles).where(eq(profiles.identityId, identityId)))[0]!.heldBy,
    base: () => `${env.profileRoot}/${identityId}/job/tm-signin-${sessionId}`,
    name: `tm-signin-${sessionId}`
  }
}

const sha256hex = (t: string) => createHash('sha256').update(t).digest('hex')
const at = (ms: number) => new Date(NOW.getTime() + ms)

describe('startSigninContainer', () => {
  test('a sign-in container gets the identity profile and nothing else', async () => {
    const f = await signinLaunchFixture()
    expect(await startSigninContainer(f.deps, f.sessionId, f.now)).toBe('started')
    expect(f.docker.created).toHaveLength(1)
    const c = f.docker.created[0]!
    expect(c.name).toBe(f.name)
    const profile = `${f.env.profileRoot}/${f.identityId}`
    expect(c.body.HostConfig.Binds).toEqual([
      `${profile}:${profile}`,
      `${f.env.profileRoot}/.machine-ids/${f.identityId}:/etc/machine-id:ro`
    ])
    expect(c.body.Labels).toEqual({ 'tm.role': 'signin', 'tm.session': f.sessionId })
    expect(validateRequest({ method: 'POST', path: `/containers/create?name=${c.name}`, body: c.body }, f.cfg).ok).toBe(
      true
    )
    expect(f.docker.started).toEqual([c.id])
    expect(await f.heldBy()).toBe(`signin:${f.sessionId}`)
  })

  test('the job holds a hashed-once token and the session knows only its hash and upstream', async () => {
    const f = await signinLaunchFixture()
    await startSigninContainer(f.deps, f.sessionId, f.now)
    const jobPath = `${f.base()}.json`
    expect((await stat(jobPath)).mode & 0o777).toBe(0o600)
    expect((await stat(`${f.base()}.key`)).mode & 0o777).toBe(0o600)
    const job = SigninJobSchema.parse(await Bun.file(jobPath).json())
    expect(job).toMatchObject({
      sessionId: f.sessionId,
      identityId: f.identityId,
      profileDir: `${f.env.profileRoot}/${f.identityId}/work`,
      checkpointsDir: `${f.env.profileRoot}/${f.identityId}/checkpoints`,
      control: { url: 'https://tm.example/api/control' }
    })
    expect(job.control.token).toMatch(/^s\.[A-Za-z0-9_-]{43}$/)
    expect(await f.session()).toMatchObject({
      controlTokenHash: controlTokenHash(job.control.token),
      upstream: `${f.name}:6080`,
      state: 'starting'
    })
    expect((await f.session()).controlTokenHash).toBe(sha256hex(job.control.token))
  })

  test('running the job again does not create a second container', async () => {
    const f = await signinLaunchFixture()
    expect(await startSigninContainer(f.deps, f.sessionId, f.now)).toBe('started')
    expect(await startSigninContainer(f.deps, f.sessionId, f.now)).toBe('started')
    expect(f.docker.created).toHaveLength(1)
  })

  test('a worker that took the identity meanwhile gets the session instead', async () => {
    const f = await signinLaunchFixture({ workerHolding: { state: 'in_meeting', attempt: 2 } })
    expect(await startSigninContainer(f.deps, f.sessionId, f.now)).toBe('worker')
    expect(f.docker.created).toEqual([])
    expect(await f.session()).toMatchObject({
      mode: 'worker',
      occurrenceId: f.occurrenceId,
      upstream: `tm-worker-${f.occurrenceId}-a2:6080`
    })
    expect((await f.occurrence()).pendingCommands).toEqual(['pause_for_signin'])
    expect(await f.heldBy()).toBe(`occ:${f.occurrenceId}`)
    // The converted job is not run again as a container.
    expect(await startSigninContainer(f.deps, f.sessionId, f.now)).toBe('worker')
    expect((await f.occurrence()).pendingCommands).toEqual(['pause_for_signin'])
  })

  test('a profile that something else holds sends the job again in 5 seconds', async () => {
    const f = await signinLaunchFixture({ earlierSignin: true })
    expect(await startSigninContainer(f.deps, f.sessionId, f.now)).toBe('deferred')
    expect(f.docker.created).toEqual([])
    expect(f.queue.sent).toEqual([
      { name: 'signin-start', data: { sessionId: f.sessionId }, opts: { startAfter: at(5000) } }
    ])
    expect(await f.heldBy()).toBe(`signin:${f.earlierId}`)

    const g = await signinLaunchFixture({ workerHolding: { state: 'restarting', attempt: 1 } })
    expect(await startSigninContainer(g.deps, g.sessionId, g.now)).toBe('deferred')
    expect((await g.occurrence()).pendingCommands).toEqual([])
  })

  test('Done before the container began, or an ended session, starts nothing', async () => {
    const f = await signinLaunchFixture({ doneRequested: true })
    expect(await startSigninContainer(f.deps, f.sessionId, f.now)).toBe('ended')
    expect(await f.session()).toMatchObject({ state: 'ended', endReason: 'done' })
    expect(await f.heldBy()).toBeNull()

    const g = await signinLaunchFixture({ state: 'ended' })
    expect(await startSigninContainer(g.deps, g.sessionId, g.now)).toBe('ended')
    expect(g.docker.created).toEqual([])
  })

  test('a Docker failure ends the session, deletes the files and gives the profile back', async () => {
    const f = await signinLaunchFixture({ dockerFails: true })
    expect(await startSigninContainer(f.deps, f.sessionId, f.now)).toBe('ended')
    expect(await f.session()).toMatchObject({ state: 'ended', endReason: 'launch_failed' })
    expect(await f.heldBy()).toBeNull()
    expect(
      (await readdir(`${f.env.profileRoot}/${f.identityId}/job`)).filter((n) => n.startsWith('tm-signin'))
    ).toEqual([])
  })

  test('a start that may have gone through ends the session but keeps the profile until the container is gone', async () => {
    const f = await signinLaunchFixture()
    f.docker.startError = Object.assign(new Error('no answer'), { name: 'TimeoutError' })
    expect(await startSigninContainer(f.deps, f.sessionId, f.now)).toBe('ended')
    expect(await f.session()).toMatchObject({ state: 'ended', endReason: 'launch_failed' })
    expect(
      (await readdir(`${f.env.profileRoot}/${f.identityId}/job`)).filter((n) => n.startsWith('tm-signin'))
    ).toEqual([])
    expect(await f.heldBy()).toBe(`signin:${f.sessionId}`)
    f.docker.inspectResults.set(f.name, { running: true })
    await monitorTick(f.deps, f.now)
    expect(await f.heldBy()).toBe(`signin:${f.sessionId}`)
    expect(f.docker.removed).toEqual([])
    // It never started after all: the monitor removes the stopped container, then frees the profile.
    f.docker.inspectResults.set(f.name, { running: false })
    await monitorTick(f.deps, f.now)
    expect(f.docker.removed).toEqual([f.name])
    expect(await f.heldBy()).toBeNull()
  })

  test('a start that Docker refused removes the created container and gives the profile back at once', async () => {
    const f = await signinLaunchFixture()
    f.docker.startError = new DockerError('start', 500, 'no such image')
    expect(await startSigninContainer(f.deps, f.sessionId, f.now)).toBe('ended')
    expect(f.docker.removed).toEqual(['fake-1'])
    expect(await f.heldBy()).toBeNull()
  })

  test('a refused start keeps the profile held while the container cannot be removed', async () => {
    const f = await signinLaunchFixture()
    f.docker.startError = new DockerError('start', 500, 'no such image')
    f.docker.removeError = new DockerError('remove', 403, 'container is not stopped')
    expect(await startSigninContainer(f.deps, f.sessionId, f.now)).toBe('ended')
    expect(await f.heldBy()).toBe(`signin:${f.sessionId}`)
    f.docker.removeError = null
    f.docker.inspectResults.set(f.name, { running: false })
    await monitorTick(f.deps, f.now)
    expect(f.docker.removed).toEqual([f.name])
    expect(await f.heldBy()).toBeNull()
  })

  test('an ended session whose container is still running is never removed', async () => {
    const f = await signinLaunchFixture()
    f.docker.startError = Object.assign(new Error('no answer'), { name: 'TimeoutError' })
    expect(await startSigninContainer(f.deps, f.sessionId, f.now)).toBe('ended')
    f.docker.inspectResults.set(f.name, { running: true })
    await monitorTick(f.deps, f.now)
    expect(f.docker.removed).toEqual([])
    expect(await f.heldBy()).toBe(`signin:${f.sessionId}`)
  })

  test('a session that does not exist is an error, not a silent no-op', async () => {
    const f = await signinLaunchFixture()
    await expect(startSigninContainer(f.deps, crypto.randomUUID(), f.now)).rejects.toThrow('No sign-in session')
  })
})

describe('monitoring sign-in sessions', () => {
  test('a sign-in session silent for 30 seconds is ended and its container stopped', async () => {
    const f = await signinLaunchFixture({
      state: 'ready',
      holding: true,
      lastHeartbeatAt: at(-(SIGNIN_SILENT_MS + 1000))
    })
    f.docker.inspectResults.set(f.name, { running: true })
    await monitorTick(f.deps, f.now)
    expect(await f.session()).toMatchObject({ state: 'ended', endReason: 'lost' })
    expect(f.docker.stopped).toEqual([{ id: f.name, timeoutS: 5 }])
    // The profile stays held while the container might still run, and goes once Docker says it is gone.
    expect(await f.heldBy()).toBe(`signin:${f.sessionId}`)
    f.docker.inspectResults.set(f.name, null)
    await monitorTick(f.deps, f.now)
    expect(await f.heldBy()).toBeNull()
  })

  test('a session that reported 10 seconds ago is left alone', async () => {
    const f = await signinLaunchFixture({ state: 'ready', holding: true, lastHeartbeatAt: at(-10_000) })
    await monitorTick(f.deps, f.now)
    expect(await f.session()).toMatchObject({ state: 'ready' })
    expect(f.docker.stopped).toEqual([])
    expect(await f.heldBy()).toBe(`signin:${f.sessionId}`)
  })

  test('a container that never reported is given 2 minutes, then ended', async () => {
    const f = await signinLaunchFixture({ holding: true, startedAt: at(-(SIGNIN_START_MS - 1000)) })
    await monitorTick(f.deps, f.now)
    expect((await f.session()).state).toBe('starting')
    await monitorTick(f.deps, at(2000))
    expect(await f.session()).toMatchObject({ state: 'ended', endReason: 'lost' })
  })

  test('Docker that cannot be asked keeps the session open until the ceiling, and never frees the profile', async () => {
    const f = await signinLaunchFixture({
      state: 'ready',
      holding: true,
      lastHeartbeatAt: at(-(SIGNIN_SILENT_MS + 1000))
    })
    const down = async () => {
      throw new DockerError('stop', 0, 'proxy unreachable')
    }
    f.docker.stop = down
    f.docker.inspect = async () => {
      throw new DockerError('inspect', 0, 'proxy unreachable')
    }
    await monitorTick(f.deps, f.now)
    await monitorTick(f.deps, at(SIGNIN_UNREACHABLE_FAIL_MS - 1000))
    expect((await f.session()).state).toBe('ready')
    await monitorTick(f.deps, at(SIGNIN_UNREACHABLE_FAIL_MS + 1000))
    expect((await f.session()).state).toBe('ended')
    await monitorTick(f.deps, at(SIGNIN_UNREACHABLE_FAIL_MS + 6000))
    expect(await f.heldBy()).toBe(`signin:${f.sessionId}`)
  })

  test('a desk pause whose worker stopped heartbeating ends, and the worker is told to resume', async () => {
    const f = await signinLaunchFixture({
      mode: 'worker',
      state: 'ready',
      workerHolding: { state: 'in_meeting', attempt: 1, lastHeartbeatAt: at(-(SIGNIN_SILENT_MS + 1000)) }
    })
    await monitorTick(f.deps, f.now)
    expect(await f.session()).toMatchObject({ state: 'ended', endReason: 'lost' })
    expect((await f.occurrence()).pendingCommands).toContain('resume_after_signin')
    expect(f.docker.stopped.map((s) => s.id)).not.toContain(f.name)
  })

  test('a desk pause on a worker that crashed and restarted ends: the new attempt is another desk', async () => {
    const f = await signinLaunchFixture({
      mode: 'worker',
      state: 'ready',
      workerHolding: { state: 'in_meeting', attempt: 1, lastHeartbeatAt: at(-5000) }
    })
    await f.db
      .update(signinSessions)
      .set({ upstream: `tm-worker-${f.occurrenceId}-a1:6080` })
      .where(eq(signinSessions.id, f.sessionId))
    await f.db.update(occurrences).set({ attempt: 2 }).where(eq(occurrences.id, f.occurrenceId!))
    await monitorTick(f.deps, f.now)
    expect(await f.session()).toMatchObject({ state: 'ended', endReason: 'lost' })
  })

  test('a desk pause with a heartbeating worker stays open', async () => {
    const f = await signinLaunchFixture({
      mode: 'worker',
      state: 'ready',
      workerHolding: { state: 'in_meeting', attempt: 1, lastHeartbeatAt: at(-5000) }
    })
    await monitorTick(f.deps, f.now)
    expect((await f.session()).state).toBe('ready')
    expect((await f.occurrence()).pendingCommands).toEqual([])
  })

  test('a container still running a minute after its session ended is stopped', async () => {
    const f = await signinLaunchFixture({ state: 'ended', holding: true, endedAt: at(-61_000) })
    f.docker.inspectResults.set(f.name, { running: true })
    await monitorTick(f.deps, f.now)
    expect(f.docker.stopped).toEqual([{ id: f.name, timeoutS: 5 }])
    expect(await f.heldBy()).toBe(`signin:${f.sessionId}`)
    // Within the minute the container is left to finish.
    const g = await signinLaunchFixture({ state: 'ended', holding: true, endedAt: at(-30_000) })
    g.docker.inspectResults.set(g.name, { running: true })
    await monitorTick(g.deps, g.now)
    expect(g.docker.stopped).toEqual([])
  })

  test('the job files go once the container has reported', async () => {
    const f = await signinLaunchFixture()
    // The job files' age is real time, so this test runs on the real clock.
    await startSigninContainer(f.deps, f.sessionId, new Date())
    const files = async () =>
      (await readdir(`${f.env.profileRoot}/${f.identityId}/job`)).filter((n) => n.startsWith('tm-signin')).sort()
    expect(await files()).toEqual([`${f.name}.json`, `${f.name}.key`])
    await monitorTick(f.deps, new Date())
    expect(await files()).toHaveLength(2)
    await f.db
      .update(signinSessions)
      .set({ state: 'ready', lastHeartbeatAt: new Date(Date.now() + 5000) })
      .where(eq(signinSessions.id, f.sessionId))
    await monitorTick(f.deps, new Date(Date.now() + 6000))
    expect(await files()).toEqual([])
  })
  test('a session older than an hour is ended however active it is', async () => {
    const f = await signinLaunchFixture({
      state: 'ready',
      holding: true,
      startedAt: at(-(SIGNIN_MAX_MS + 1000)),
      lastHeartbeatAt: at(-1000)
    })
    await monitorTick(f.deps, f.now)
    expect(await f.session()).toMatchObject({ state: 'ended', endReason: 'lost' })
  })

  test('the job files of an ended session go when its container is gone', async () => {
    const f = await signinLaunchFixture()
    await startSigninContainer(f.deps, f.sessionId, new Date())
    await f.db
      .update(signinSessions)
      .set({ state: 'ended', endedAt: new Date(), endReason: 'done' })
      .where(eq(signinSessions.id, f.sessionId))
    const files = async () =>
      (await readdir(`${f.env.profileRoot}/${f.identityId}/job`)).filter((n) => n.startsWith('tm-signin'))
    expect(await files()).toHaveLength(2)
    f.docker.inspectResults.set(f.name, { running: true })
    await monitorTick(f.deps, new Date())
    expect(await files()).toHaveLength(2)
    f.docker.inspectResults.set(f.name, null)
    await monitorTick(f.deps, new Date())
    expect(await files()).toEqual([])
    expect(await f.heldBy()).toBeNull()
  })

  /** A second member's session in the same database, silent for long enough to be lost. */
  async function otherLostSession(f: Awaited<ReturnType<typeof signinLaunchFixture>>) {
    const other = await seedMember(f.db, { full: false })
    const [row] = await f.db
      .insert(signinSessions)
      .values({
        memberId: other.memberId,
        identityId: other.identityId,
        mode: 'container',
        state: 'ready',
        upstream: 'x',
        startedAt: at(-HOUR),
        lastHeartbeatAt: at(-(SIGNIN_SILENT_MS + 1000))
      })
      .returning()
    return { ...other, sessionId: row!.id, name: `tm-signin-${row!.id}` }
  }

  test('one session that throws does not stop the others, and the pass fails loudly after them', async () => {
    const f = await signinLaunchFixture({
      state: 'ready',
      holding: true,
      startedAt: at(-60_000),
      lastHeartbeatAt: at(-(SIGNIN_SILENT_MS + 1000))
    })
    const g = await otherLostSession(f)
    const stop = f.docker.stop.bind(f.docker)
    f.docker.stop = async (id, timeoutS) => {
      if (id === f.name || id === g.name) {
        await stop(id, timeoutS)
        if (id === f.name) throw new Error('boom')
        return
      }
      await stop(id, timeoutS)
    }
    const error = await monitorTick(f.deps, f.now).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors.map((e: Error) => e.message)).toEqual(['boom'])
    const state = async (id: string) =>
      (await f.db.select().from(signinSessions).where(eq(signinSessions.id, id)))[0]!.state
    expect(await state(g.sessionId)).toBe('ended')
    expect(await state(f.sessionId)).toBe('ready')
  })

  test('one held profile that throws does not stop another from being released', async () => {
    const f = await signinLaunchFixture({ state: 'ended', holding: true, endedAt: at(-1000) })
    const other = await seedMember(f.db, { full: false })
    const [row] = await f.db
      .insert(signinSessions)
      .values({
        memberId: other.memberId,
        identityId: other.identityId,
        mode: 'container',
        state: 'ended',
        endedAt: NOW
      })
      .returning()
    await f.db
      .update(profiles)
      .set({ heldBy: `signin:${row!.id}` })
      .where(eq(profiles.identityId, other.identityId))
    f.docker.inspect = async (id) => {
      if (id === f.name) throw new Error('boom')
      return null
    }
    await expect(monitorTick(f.deps, f.now)).rejects.toBeInstanceOf(AggregateError)
    const held = async (identityId: string) =>
      (await f.db.select().from(profiles).where(eq(profiles.identityId, identityId)))[0]!.heldBy
    expect(await held(other.identityId)).toBeNull()
    expect(await held(f.identityId)).toBe(`signin:${f.sessionId}`)
  })

  test('a worker watch that throws does not skip the sign-in sessions', async () => {
    const f = await signinLaunchFixture({
      workerHolding: { state: 'in_meeting', attempt: 1, lastHeartbeatAt: at(-(SIGNIN_SILENT_MS + 1000)) }
    })
    const g = await otherLostSession(f)
    f.docker.inspect = async (id) => {
      if (id === 'tm-worker-x-a1') throw new Error('boom')
      return null
    }
    await expect(monitorTick(f.deps, f.now)).rejects.toThrow('boom')
    expect((await f.db.select().from(signinSessions).where(eq(signinSessions.id, g.sessionId)))[0]!.state).toBe('ended')
  })

  test('queued commands: a lost session drops a pause the worker never got, a new pause drops a stale resume', async () => {
    const f = await signinLaunchFixture({
      mode: 'worker',
      state: 'ready',
      workerHolding: { state: 'in_meeting', attempt: 1, lastHeartbeatAt: at(-(SIGNIN_SILENT_MS + 1000)) }
    })
    await f.db
      .update(occurrences)
      .set({ pendingCommands: ['pause_for_signin'] })
      .where(eq(occurrences.id, f.occurrenceId!))
    await monitorTick(f.deps, f.now)
    expect((await f.occurrence()).pendingCommands).toEqual(['resume_after_signin'])

    const g = await signinLaunchFixture({ workerHolding: { state: 'in_meeting', attempt: 1 } })
    await g.db
      .update(occurrences)
      .set({ pendingCommands: ['resume_after_signin'] })
      .where(eq(occurrences.id, g.occurrenceId!))
    expect(await startSigninContainer(g.deps, g.sessionId, g.now)).toBe('worker')
    expect((await g.occurrence()).pendingCommands).toEqual(['pause_for_signin'])
  })
})
