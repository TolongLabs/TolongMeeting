import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import type { OccurrenceState } from '@tm/core'
import { eq } from 'drizzle-orm'
import { events, occurrences, profiles, schema } from '@tm/web/db'
import { FakeNotifier } from '@tm/web/db/notifier'
import { sealColumn } from '@tm/web/db/secrets'
import { FakeQueue, createTestDb, dropAllTestDbs, seedMember } from '@tm/web/db/testing'
import {
  DockerError,
  FakeDocker,
  KILL_AFTER_END_MS,
  MAX_RESTARTS,
  STOP_AFTER_END_MS,
  UNREACHABLE_FAIL_MS,
  UNREACHABLE_PING_MS,
  launchOccurrence,
  monitorTick,
  restartOccurrence,
  stopJobFileWatchers,
  type LaunchDeps
} from '../src/index'

const MASTER = Buffer.alloc(32, 3)
const HOUR = 3_600_000
const START = new Date('2026-10-21T06:00:00Z')
const END = new Date('2026-10-21T08:00:00Z')
const now = new Date('2026-10-21T06:30:00Z')

let tmp: string
beforeAll(async () => {
  tmp = await mkdtemp('/home/user/.cache/tm-tmp/monitor-')
})
afterEach(stopJobFileWatchers)
afterAll(async () => {
  await dropAllTestDbs()
  await rm(tmp, { recursive: true, force: true })
}, 60_000)

interface Options {
  state?: OccurrenceState
  lastHeartbeat?: Date
  freshHeartbeats?: boolean
  attempt?: number
  restarts?: number
  end?: Date
  containerGone?: boolean
  checkpoints?: string[]
}

/** A launched occurrence (real files, real container record) that the test then puts into the state it needs. */
async function monitorFixture(o: Options = {}) {
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
  const end = o.end ?? END
  const [occ] = await db
    .insert(occurrences)
    .values({
      memberId,
      identityId,
      entryId: entry!.id,
      entryName: 'Data Mining',
      entryType: 'lecture',
      transcription: 'live',
      scheduledStart: START,
      scheduledEnd: end,
      deleteAfter: new Date(end.getTime() + 30 * 24 * HOUR)
    })
    .returning()
  const id = occ!.id
  const root = await mkdtemp(`${tmp}/f-`)
  const env = {
    dataRoot: `${root}/data`,
    profileRoot: `${root}/profiles`,
    publicUrl: 'https://tm.example',
    ntfyUrl: 'https://ntfy.tm.example'
  }
  const docker = new FakeDocker()
  const notifier = new FakeNotifier()
  const queue = new FakeQueue()
  const deps: LaunchDeps = { db, queue, docker, notifier, master: MASTER, env, exitPollMs: 60_000 }
  const launched = await launchOccurrence(
    deps,
    { occurrenceId: id, scheduledStart: START.toISOString() },
    new Date(START.getTime() - HOUR)
  )
  if (launched !== 'launched') throw new Error(`fixture launch: ${launched}`)

  const attempt = o.attempt ?? 1
  const name = `tm-worker-${id}-a${attempt}`
  await db
    .update(occurrences)
    .set({
      state: o.state ?? 'in_meeting',
      attempt,
      containerName: name,
      restarts: o.restarts ?? 0,
      lastHeartbeatAt: o.freshHeartbeats ? new Date('2026-10-21T09:00:00Z') : (o.lastHeartbeat ?? now)
    })
    .where(eq(occurrences.id, id))
  docker.inspectResults.set(name, o.containerGone ? null : { running: true })
  if (o.checkpoints) {
    const dir = `${env.profileRoot}/${identityId}/checkpoints`
    await mkdir(dir, { recursive: true })
    for (const c of o.checkpoints) await writeFile(`${dir}/${c}`, 'x')
  }
  docker.created.length = 0
  docker.started.length = 0
  notifier.sent.length = 0
  return {
    db,
    deps,
    docker,
    notifier,
    queue,
    env,
    id,
    memberId,
    identityId,
    name,
    occurrence: async () => (await db.select().from(occurrences).where(eq(occurrences.id, id)))[0]!,
    heldBy: async () => (await db.select().from(profiles).where(eq(profiles.identityId, identityId)))[0]!.heldBy,
    profile: async () => (await db.select().from(profiles).where(eq(profiles.identityId, identityId)))[0]!,
    events: () => db.select().from(events).where(eq(events.occurrenceId, id)).orderBy(events.id),
    jobFiles: async () => (await readdir(`${env.profileRoot}/${identityId}/job`)).sort()
  }
}

const stoppedNames = (f: { docker: FakeDocker }) => f.docker.stopped.map((s) => s.id)

describe('crash detection', () => {
  test('30 seconds without a heartbeat restarts the worker as attempt 2 with a ping', async () => {
    const f = await monitorFixture({ lastHeartbeat: new Date(now.getTime() - 31_000) })
    const oldHash = (await f.occurrence()).controlTokenHash
    expect((await monitorTick(f.deps, now)).restarted).toEqual([f.id])
    expect(await f.occurrence()).toMatchObject({
      state: 'restarting',
      attempt: 2,
      restarts: 1,
      resumeState: 'in_meeting'
    })
    expect((await f.occurrence()).controlTokenHash).not.toBe(oldHash)
    expect(f.docker.stopped).toEqual([{ id: `tm-worker-${f.id}-a1`, timeoutS: 5 }])
    expect(f.docker.created.at(-1)!.name).toBe(`tm-worker-${f.id}-a2`)
    expect(f.notifier.sent).toHaveLength(1)
    expect(f.notifier.sent[0]!.ping).toMatchObject({
      title: 'Restarting: Data Mining',
      message: expect.stringContaining('restart 1 of 3')
    })
    expect(await f.heldBy()).toBe(`occ:${f.id}`)
  })

  test('a crash is handled once: the next pass sees the new attempt starting up', async () => {
    const f = await monitorFixture({ lastHeartbeat: new Date(now.getTime() - 31_000) })
    await monitorTick(f.deps, now)
    const again = await monitorTick(f.deps, new Date(now.getTime() + 5_000))
    expect(again).toMatchObject({ restarted: [], failed: [] })
    expect(f.docker.created).toHaveLength(1)
    expect(f.notifier.sent).toHaveLength(1)
  })

  test('29 seconds is not a crash', async () => {
    const f = await monitorFixture({ lastHeartbeat: new Date(now.getTime() - 29_000) })
    const r = await monitorTick(f.deps, now)
    expect(r).toEqual({ restarted: [], failed: [], released: [] })
    expect((await f.occurrence()).state).toBe('in_meeting')
    expect(f.docker.stopped).toEqual([])
  })

  test('a container that is gone restarts the worker once its last heartbeat is 10 seconds old', async () => {
    const f = await monitorFixture({ containerGone: true, lastHeartbeat: new Date(now.getTime() - 15_000) })
    expect((await monitorTick(f.deps, now)).restarted).toEqual([f.id])
    expect(await f.occurrence()).toMatchObject({ state: 'restarting', attempt: 2, restarts: 1 })
    // Nothing to stop: the container was already gone.
    expect(f.docker.created.at(-1)!.name).toBe(`tm-worker-${f.id}-a2`)
  })

  test('a container that is gone right after a heartbeat is not a crash yet', async () => {
    const f = await monitorFixture({ containerGone: true, lastHeartbeat: new Date(now.getTime() - 4_000) })
    expect(await monitorTick(f.deps, now)).toEqual({ restarted: [], failed: [], released: [] })
    expect((await f.occurrence()).state).toBe('in_meeting')
  })

  test('a stopped container (not removed) counts as gone', async () => {
    const f = await monitorFixture({ lastHeartbeat: new Date(now.getTime() - 15_000) })
    f.docker.inspectResults.set(f.name, { running: false })
    expect((await monitorTick(f.deps, now)).restarted).toEqual([f.id])
  })

  test('the third restart still happens; a crash after 3 restarts fails the occurrence with one ping', async () => {
    const third = await monitorFixture({
      lastHeartbeat: new Date(now.getTime() - 31_000),
      attempt: 3,
      restarts: MAX_RESTARTS - 1
    })
    expect((await monitorTick(third.deps, now)).restarted).toEqual([third.id])
    expect(third.notifier.sent[0]!.ping.message).toContain('restart 3 of 3')

    const f = await monitorFixture({
      lastHeartbeat: new Date(now.getTime() - 31_000),
      attempt: 4,
      restarts: MAX_RESTARTS
    })
    expect((await monitorTick(f.deps, now)).failed).toEqual([f.id])
    expect(await f.occurrence()).toMatchObject({ state: 'failed', stateReason: 'worker_unresponsive' })
    expect(await f.heldBy()).toBeNull()
    expect(stoppedNames(f)).toEqual([f.name])
    expect(f.docker.created).toEqual([])
    expect(f.notifier.sent).toHaveLength(1)
    expect(f.notifier.sent[0]!.ping).toMatchObject({
      title: 'Failed: Data Mining',
      message: expect.stringContaining('it crashed 3 times')
    })
    // A later pass does not ping again.
    await monitorTick(f.deps, new Date(now.getTime() + 5_000))
    expect(f.notifier.sent).toHaveLength(1)
  })

  test('a crash more than 30 minutes after the meeting ended fails instead of restarting', async () => {
    const late = new Date(END.getTime() + 31 * 60_000)
    const f = await monitorFixture({ lastHeartbeat: new Date(late.getTime() - 31_000) })
    expect((await monitorTick(f.deps, late)).failed).toEqual([f.id])
    expect(f.docker.created).toEqual([])
  })

  test('a restart whose container cannot be created fails the occurrence and sends no restart ping', async () => {
    const f = await monitorFixture({ lastHeartbeat: new Date(now.getTime() - 31_000) })
    f.docker.createError = new DockerError('create', 500, 'boom')
    expect((await monitorTick(f.deps, now)).failed).toEqual([f.id])
    expect(await f.occurrence()).toMatchObject({ state: 'failed', stateReason: 'launch_failed' })
    expect(f.notifier.sent.map((s) => s.ping.title)).toEqual(['Failed: Data Mining'])
    expect(await f.heldBy()).toBeNull()
  })

  test('restartOccurrence restarts a named occurrence directly', async () => {
    const f = await monitorFixture()
    await restartOccurrence(f.deps, f.id, now)
    expect(await f.occurrence()).toMatchObject({ state: 'restarting', attempt: 2, restarts: 1 })
  })
})

describe('Docker that cannot be asked', () => {
  const unreachable = () => new DockerError('inspect', 0, 'proxy unreachable')

  test('an unreachable Docker changes nothing: no restart, no failure, no release', async () => {
    const stale = await monitorFixture({ lastHeartbeat: new Date(now.getTime() - 60_000) })
    stale.docker.inspect = async () => {
      throw unreachable()
    }
    const gone = await monitorFixture({ state: 'transcribing', containerGone: true })
    gone.docker.inspect = stale.docker.inspect
    for (const f of [stale, gone]) {
      expect(await monitorTick(f.deps, now)).toEqual({ restarted: [], failed: [], released: [] })
      expect(f.docker.stopped).toEqual([])
      expect(f.docker.created).toEqual([])
      expect(f.notifier.sent).toEqual([])
    }
    expect(await stale.occurrence()).toMatchObject({ state: 'in_meeting', attempt: 1, restarts: 0 })
    expect(await gone.heldBy()).toBe(`occ:${gone.id}`)
    expect((await gone.occurrence()).containerName).toBe(gone.name)
  })

  test('a Docker that refuses (non-zero status) is unknown too, not gone', async () => {
    const f = await monitorFixture({ lastHeartbeat: new Date(now.getTime() - 60_000) })
    f.docker.inspect = async () => {
      throw new DockerError('inspect', 403, 'forbidden')
    }
    expect(await monitorTick(f.deps, now)).toEqual({ restarted: [], failed: [], released: [] })
    expect(f.docker.created).toEqual([])
  })

  test('a container that cannot be stopped is not replaced', async () => {
    const f = await monitorFixture({ lastHeartbeat: new Date(now.getTime() - 60_000) })
    f.docker.stop = async () => {
      throw unreachable()
    }
    expect(await monitorTick(f.deps, now)).toMatchObject({ restarted: [], failed: [] })
    expect(await f.occurrence()).toMatchObject({ state: 'in_meeting', attempt: 1, restarts: 0 })
    expect(f.docker.created).toEqual([])
    expect(await f.heldBy()).toBe(`occ:${f.id}`)
  })

  test('a worker that cannot be stopped keeps its profile even when it must fail', async () => {
    const f = await monitorFixture({ lastHeartbeat: new Date(now.getTime() - 60_000), restarts: MAX_RESTARTS })
    f.docker.stop = async () => {
      throw unreachable()
    }
    expect(await monitorTick(f.deps, now)).toMatchObject({ failed: [] })
    expect((await f.occurrence()).state).toBe('in_meeting')
    expect(await f.heldBy()).toBe(`occ:${f.id}`)
    expect(f.notifier.sent).toEqual([])
  })
})

describe('a worker that cannot be checked', () => {
  const unreachable = () => new DockerError('inspect', 0, 'proxy unreachable')
  const at = (ms: number) => new Date(now.getTime() + ms)
  const titles = (f: { notifier: FakeNotifier }) => f.notifier.sent.map((s) => s.ping.title)

  async function silentWorker(o: Options = {}) {
    const f = await monitorFixture({ lastHeartbeat: new Date(now.getTime() - 60_000), ...o })
    return f
  }

  // The worker's last heartbeat is 60 s before `now`, so its clock started 30 s before `now`.
  const ANCHOR_MS = 30_000

  test('unknown Docker: one ping after 5 minutes, a failure after 15 that keeps the profile held', async () => {
    const f = await silentWorker()
    f.docker.inspect = async () => {
      throw unreachable()
    }
    for (const ms of [0, 60_000, UNREACHABLE_PING_MS - ANCHOR_MS - 5_000]) {
      expect(await monitorTick(f.deps, at(ms))).toEqual({ restarted: [], failed: [], released: [] })
    }
    expect(f.notifier.sent).toEqual([])

    await monitorTick(f.deps, at(UNREACHABLE_PING_MS - ANCHOR_MS))
    expect(titles(f)).toEqual(["Can't check your meeting bot: Data Mining"])
    // The ping is sent once, however many passes follow.
    await monitorTick(f.deps, at(UNREACHABLE_PING_MS + 5_000))
    await monitorTick(f.deps, at(UNREACHABLE_FAIL_MS - ANCHOR_MS - 5_000))
    expect(titles(f)).toHaveLength(1)
    expect((await f.occurrence()).state).toBe('in_meeting')

    expect((await monitorTick(f.deps, at(UNREACHABLE_FAIL_MS - ANCHOR_MS))).failed).toEqual([f.id])
    expect(await f.occurrence()).toMatchObject({
      state: 'failed',
      stateReason: 'worker_unreachable',
      containerName: f.name,
      pendingCommands: ['stop']
    })
    expect(await f.heldBy()).toBe(`occ:${f.id}`)
    expect(titles(f)).toEqual(["Can't check your meeting bot: Data Mining", 'Failed: Data Mining'])
    expect(f.notifier.sent[1]!.ping.message).toBe(
      "The bot for Data Mining couldn't be reached, so the meeting was marked failed."
    )
    // Nothing changed in Docker, and later passes neither fail nor ping again.
    expect(f.docker.stopped).toEqual([])
    expect(f.docker.created).toEqual([])
    expect(await monitorTick(f.deps, at(UNREACHABLE_FAIL_MS + 5_000))).toEqual({
      restarted: [],
      failed: [],
      released: []
    })
    expect(titles(f)).toHaveLength(2)

    // Once Docker answers and the container is gone, the profile is freed.
    f.docker.inspect = async () => null
    expect((await monitorTick(f.deps, at(UNREACHABLE_FAIL_MS + 10_000))).released).toEqual([f.id])
    expect(await f.heldBy()).toBeNull()
  })

  test('a container that cannot be stopped reaches the same ceilings', async () => {
    const f = await silentWorker()
    f.docker.stop = async () => {
      throw unreachable()
    }
    for (const ms of [0, 5_000, 60_000]) await monitorTick(f.deps, at(ms))
    expect(f.notifier.sent).toEqual([])
    // The failed stop hands the claim back, so the worker stays stale and the next pass tries again.
    expect((await f.occurrence()).lastHeartbeatAt).toEqual(new Date(now.getTime() - 60_000))
    await monitorTick(f.deps, at(UNREACHABLE_PING_MS))
    expect(titles(f)).toEqual(["Can't check your meeting bot: Data Mining"])
    expect((await monitorTick(f.deps, at(UNREACHABLE_FAIL_MS))).failed).toEqual([f.id])
    expect(await f.occurrence()).toMatchObject({ state: 'failed', stateReason: 'worker_unreachable' })
    expect(await f.heldBy()).toBe(`occ:${f.id}`)
    expect(titles(f)).toEqual(["Can't check your meeting bot: Data Mining", 'Failed: Data Mining'])
    expect(f.docker.created).toEqual([])
  })

  test('a worker past its hard stop that cannot be stopped fails the same way', async () => {
    const f = await monitorFixture({ freshHeartbeats: true })
    f.docker.stop = async () => {
      throw unreachable()
    }
    const t0 = END.getTime() + KILL_AFTER_END_MS + 60_000
    // The worker is alive and beating throughout; only its container can't be stopped.
    const tick = async (ms: number) => {
      await f.db
        .update(occurrences)
        .set({ lastHeartbeatAt: new Date(t0 + ms) })
        .where(eq(occurrences.id, f.id))
      return monitorTick(f.deps, new Date(t0 + ms))
    }
    await tick(0)
    await tick(UNREACHABLE_PING_MS)
    expect(titles(f)).toEqual(["Can't check your meeting bot: Data Mining"])
    expect((await tick(UNREACHABLE_FAIL_MS)).failed).toEqual([f.id])
    expect(await f.occurrence()).toMatchObject({ state: 'failed', stateReason: 'worker_unreachable' })
    expect(await f.heldBy()).toBe(`occ:${f.id}`)
  })

  test('a heartbeat in between starts the clock over', async () => {
    const f = await silentWorker()
    f.docker.inspect = async () => {
      throw unreachable()
    }
    await monitorTick(f.deps, at(0))
    await monitorTick(f.deps, at(4 * 60_000))
    // The worker beats again, then goes quiet again.
    await f.db
      .update(occurrences)
      .set({ lastHeartbeatAt: at(4 * 60_000 + 30_000) })
      .where(eq(occurrences.id, f.id))
    await monitorTick(f.deps, at(4 * 60_000 + 35_000))
    await monitorTick(f.deps, at(8 * 60_000))
    await monitorTick(f.deps, at(8 * 60_000 + 60_000))
    expect(f.notifier.sent).toEqual([])
    await monitorTick(f.deps, at(8 * 60_000 + UNREACHABLE_PING_MS))
    expect(titles(f)).toEqual(["Can't check your meeting bot: Data Mining"])
    expect((await f.occurrence()).state).toBe('in_meeting')
  })

  test('a scheduler that lost its clocks neither waits another 5 minutes nor pings twice', async () => {
    const f = await silentWorker()
    f.docker.inspect = async () => {
      throw unreachable()
    }
    // The first pass this process makes comes 6 minutes after the last heartbeat: the ping is already due.
    await monitorTick(f.deps, at(UNREACHABLE_PING_MS))
    expect(titles(f)).toEqual(["Can't check your meeting bot: Data Mining"])
    // A restart forgets the clocks (here: a pass that sees the occurrence inactive drops them).
    await f.db.update(occurrences).set({ state: 'transcribing' }).where(eq(occurrences.id, f.id))
    await monitorTick(f.deps, at(UNREACHABLE_PING_MS + 5_000))
    await f.db.update(occurrences).set({ state: 'in_meeting' }).where(eq(occurrences.id, f.id))
    await monitorTick(f.deps, at(UNREACHABLE_PING_MS + 10_000))
    expect(titles(f)).toHaveLength(1)
    // The failure is still due 15 minutes after the last heartbeat plus 30 seconds.
    expect((await monitorTick(f.deps, at(UNREACHABLE_FAIL_MS - ANCHOR_MS))).failed).toEqual([f.id])
  })

  test('a Docker problem is logged at most once a minute per occurrence', async () => {
    const f = await silentWorker()
    f.docker.inspect = async () => {
      throw unreachable()
    }
    const log = spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (let i = 0; i < 12; i++) await monitorTick(f.deps, at(i * 5_000))
      const mine = () => log.mock.calls.filter((c) => String(c[0]).includes('proxy unreachable')).length
      expect(mine()).toBe(1)
      await monitorTick(f.deps, at(61_000))
      expect(mine()).toBe(2)
    } finally {
      log.mockRestore()
    }
  })
})

describe('a stuck tick', () => {
  test('after 60 seconds the next tick runs; the stuck one cannot undo it', async () => {
    const f = await monitorFixture({ lastHeartbeat: new Date(now.getTime() - 60_000) })
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let calls = 0
    f.docker.inspect = async () => {
      if (calls++ === 0) await gate
      return { running: true }
    }
    const log = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const stuck = monitorTick(f.deps, now)
      await Bun.sleep(100)
      // Within 60 seconds the guard still holds.
      expect(await monitorTick(f.deps, new Date(now.getTime() + 10_000))).toEqual({
        restarted: [],
        failed: [],
        released: []
      })
      expect(calls).toBe(1)
      const next = await monitorTick(f.deps, new Date(now.getTime() + 61_000))
      expect(next.restarted).toEqual([f.id])
      expect(log.mock.calls.some((c) => String(c[0]).includes('STUCK'))).toBe(true)

      release()
      const late = await stuck
      // Its claim finds the worker already claimed by the newer tick.
      expect(late).toEqual({ restarted: [], failed: [], released: [] })
      expect(await f.occurrence()).toMatchObject({ state: 'restarting', attempt: 2, restarts: 1 })
      expect(f.notifier.sent).toHaveLength(1)
    } finally {
      log.mockRestore()
      release()
    }
  })
})

describe('hard stop', () => {
  test('a worker past its hard stop is told to stop once, then stopped', async () => {
    const f = await monitorFixture({ freshHeartbeats: true })
    await monitorTick(f.deps, new Date(END.getTime() + STOP_AFTER_END_MS - 1_000))
    expect((await f.occurrence()).pendingCommands).toEqual([])

    await monitorTick(f.deps, new Date(END.getTime() + STOP_AFTER_END_MS + 60_000))
    expect((await f.occurrence()).pendingCommands).toEqual(['stop'])
    // The worker took the command (a heartbeat cleared it); the monitor does not append it again.
    await f.db.update(occurrences).set({ pendingCommands: [] }).where(eq(occurrences.id, f.id))
    await monitorTick(f.deps, new Date(END.getTime() + STOP_AFTER_END_MS + 120_000))
    expect((await f.occurrence()).pendingCommands).toEqual([])
    expect(f.docker.stopped).toEqual([])

    expect((await monitorTick(f.deps, new Date(END.getTime() + KILL_AFTER_END_MS + 60_000))).failed).toEqual([f.id])
    expect(await f.occurrence()).toMatchObject({ state: 'failed', stateReason: 'overran_hard_stop' })
    expect(stoppedNames(f)).toEqual([f.name])
    expect(await f.heldBy()).toBeNull()
    expect(f.notifier.sent.map((s) => s.ping.message)).toEqual([expect.stringContaining('it ran past the hard stop')])
  })

  test('a worker that is no longer in a worker state is not hard-stopped', async () => {
    const f = await monitorFixture({ state: 'restarting', freshHeartbeats: true })
    await monitorTick(f.deps, new Date(END.getTime() + KILL_AFTER_END_MS + 60_000))
    expect((await f.occurrence()).state).toBe('restarting')
  })
})

describe('finished containers', () => {
  test('a finished container releases the identity and records the newest checkpoint', async () => {
    const f = await monitorFixture({
      state: 'transcribing',
      containerGone: true,
      checkpoints: ['20261021T060000Z.tar.enc', '20261021T060500Z.tar.enc']
    })
    expect((await monitorTick(f.deps, now)).released).toEqual([f.id])
    expect(await f.heldBy()).toBeNull()
    const profile = await f.profile()
    expect(profile.latestCheckpoint).toBe(`${f.env.profileRoot}/${f.identityId}/checkpoints/20261021T060500Z.tar.enc`)
    expect(profile.checkpointAt).toBeInstanceOf(Date)
    expect((await f.occurrence()).containerName).toBeNull()
    expect((await monitorTick(f.deps, now)).released).toEqual([])
  })

  test('a container that still runs keeps the identity', async () => {
    const f = await monitorFixture({ state: 'transcribing' })
    expect((await monitorTick(f.deps, now)).released).toEqual([])
    expect(await f.heldBy()).toBe(`occ:${f.id}`)
  })

  test('an occurrence without checkpoints on disk is still released', async () => {
    const f = await monitorFixture({ state: 'failed', containerGone: true })
    expect((await monitorTick(f.deps, now)).released).toEqual([f.id])
    expect((await f.profile()).latestCheckpoint).toBeNull()
  })
})

describe('job files', () => {
  test('they go once a heartbeat arrived after the launch', async () => {
    const f = await monitorFixture({ lastHeartbeat: now })
    const base = `${f.env.profileRoot}/${f.identityId}/job/${f.name}`
    const launched = new Date(now.getTime() - 20_000)
    await utimes(`${base}.json`, launched, launched)
    await utimes(`${base}.key`, launched, launched)
    await f.db
      .update(occurrences)
      .set({ lastHeartbeatAt: new Date(launched.getTime() - 1_000) })
      .where(eq(occurrences.id, f.id))
    await monitorTick(f.deps, new Date(launched.getTime() + 5_000))
    expect(await f.jobFiles()).toEqual([`${f.name}.json`, `${f.name}.key`])
    await f.db
      .update(occurrences)
      .set({ lastHeartbeatAt: new Date(launched.getTime() + 4_000) })
      .where(eq(occurrences.id, f.id))
    await monitorTick(f.deps, new Date(launched.getTime() + 5_000))
    expect(await f.jobFiles()).toEqual([])
  })

  test('they go 120 seconds after the launch even without a heartbeat', async () => {
    // Docker can't be asked, so the quiet worker is not treated as crashed.
    const f = await monitorFixture({ lastHeartbeat: now })
    f.docker.inspect = async () => {
      throw new DockerError('inspect', 0, 'proxy unreachable')
    }
    const base = `${f.env.profileRoot}/${f.identityId}/job/${f.name}`
    const launched = new Date(now.getTime() - 1_000)
    await utimes(`${base}.json`, launched, launched)
    await f.db
      .update(occurrences)
      .set({ lastHeartbeatAt: new Date(launched.getTime() - 1_000) })
      .where(eq(occurrences.id, f.id))
    await monitorTick(f.deps, new Date(launched.getTime() + 119_000))
    expect(await f.jobFiles()).toHaveLength(2)
    await monitorTick(f.deps, new Date(launched.getTime() + 120_000))
    expect(await f.jobFiles()).toEqual([])
    expect((await f.occurrence()).state).toBe('in_meeting')
  })
})
