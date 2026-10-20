import { tmpdir } from 'node:os'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { type OccurrenceState } from '@tm/core'
import type { Ping } from '@tm/notify'
import { count, eq } from 'drizzle-orm'
import { artefacts, events, forms, occurrences, profiles } from '@tm/web/db'
import { FakeNotifier } from '@tm/web/db/notifier'
import { tryPipelineLock } from '@tm/web/db/pipeline-lock'
import { FakeQueue, createTestDb, dropAllTestDbs, seedMember } from '@tm/web/db/testing'
import { FakeDocker, OccurrenceActiveError, deleteOccurrenceData, retentionTick, type LaunchDeps } from '../src/index'

const now = new Date('2026-11-17T08:00:00Z')
const HOUR = 3_600_000

let tmp: string
beforeAll(async () => {
  tmp = await mkdtemp(`${tmpdir()}/retention-`)
})
afterAll(async () => {
  await dropAllTestDbs()
  await rm(tmp, { recursive: true, force: true })
}, 60_000)

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false
  )

interface Options {
  state?: OccurrenceState
  deleteAfter?: Date
  stateReason?: string
  files?: string[]
  withRows?: boolean
  orphanOccurrenceDir?: boolean
  orphanProfileDir?: boolean
  checkpoints?: string[]
  notifier?: FakeNotifier
}

async function retentionFixture(o: Options = {}) {
  const db = await createTestDb()
  const { memberId, identityId } = await seedMember(db, { full: false })
  const root = await mkdtemp(`${tmp}/f-`)
  const env = {
    dataRoot: `${root}/data`,
    profileRoot: `${root}/profiles`,
    publicUrl: 'https://tm.example',
    ntfyUrl: 'https://ntfy.tm.example'
  }
  const notifier = o.notifier ?? new FakeNotifier()
  const deps: LaunchDeps = {
    db,
    queue: new FakeQueue(),
    docker: new FakeDocker(),
    notifier,
    master: Buffer.alloc(32, 3),
    remux: async () => false,
    env
  }

  const start = new Date('2026-10-21T06:00:00Z')
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
      state: o.state ?? 'completed',
      stateReason: o.stateReason ?? null,
      linkUsed: 'https://example.zoom.us/j/1',
      pastedLink: 'https://example.zoom.us/j/2',
      containerName: 'tm-worker-x',
      controlTokenHash: 'abc',
      entrySnapshot: {
        name: 'Data Mining',
        link: { kind: 'fixed', url: 'https://example.zoom.us/j/1?pwd=x' }
      } as never,
      deleteAfter: o.deleteAfter ?? new Date(now.getTime() + 20 * 24 * HOUR)
    })
    .returning()
  const id = occ!.id
  const dir = `${env.dataRoot}/occurrences/${id}`
  await mkdir(dir, { recursive: true })
  for (const f of o.files ?? []) {
    await mkdir(`${dir}/${f.slice(0, f.lastIndexOf('/'))}`, { recursive: true })
    await writeFile(`${dir}/${f}`, 'data')
  }
  if (o.withRows) {
    await db.insert(forms).values({
      occurrenceId: id,
      memberId,
      formKey: 'f1',
      url: 'https://forms.example/f1',
      source: 'qr',
      state: 'submitted',
      seenAt: start
    })
    await db
      .insert(artefacts)
      .values({ occurrenceId: id, memberId, kind: 'recording', path: 'recording/meeting.mp4', bytes: 4 })
    await db.insert(events).values({
      occurrenceId: id,
      memberId,
      attempt: 1,
      at: start,
      type: 'joined',
      data: { x: 1 },
      dataHash: 'h'
    })
  }
  if (o.orphanOccurrenceDir) await mkdir(`${env.dataRoot}/occurrences/${randomUUID()}/recording`, { recursive: true })
  if (o.orphanProfileDir) await mkdir(`${env.profileRoot}/${randomUUID()}/work`, { recursive: true })
  const cpDir = `${env.profileRoot}/${identityId}/checkpoints`
  if (o.checkpoints) {
    await mkdir(cpDir, { recursive: true })
    for (const c of o.checkpoints) await writeFile(`${cpDir}/${c}`, 'x')
  }
  return {
    db,
    deps,
    notifier,
    env,
    id,
    memberId,
    identityId,
    dir,
    cpDir,
    root,
    occurrence: async () => (await db.select().from(occurrences).where(eq(occurrences.id, id)))[0]!,
    events: () => db.select().from(events).where(eq(events.occurrenceId, id)),
    count: async (t: typeof forms | typeof artefacts) =>
      (await db.select({ n: count() }).from(t).where(eq(t.occurrenceId, id)))[0]!.n,
    checkpointNames: async () => (await readdir(cpDir)).sort()
  }
}

test('a meeting 3 days from deletion gets one warning ping', async () => {
  const f = await retentionFixture({ state: 'completed', deleteAfter: new Date('2026-11-20T08:00:00Z') })
  expect((await retentionTick(f.deps, now)).warned).toBe(1)
  expect((await retentionTick(f.deps, now)).warned).toBe(0)
  expect(f.notifier.sent).toHaveLength(1)
  expect(f.notifier.sent[0]).toMatchObject({ memberId: f.memberId })
  expect(f.notifier.sent[0]!.ping).toMatchObject({
    title: 'Deleting in 3 days: Data Mining',
    priority: 'default',
    message:
      'Data Mining (Wed 21 Oct, 14:00) will be deleted from the server on Fri 20 Nov. Export anything you want to keep before then.'
  })
  expect((await f.occurrence()).deletionWarnedAt).toEqual(now)
})

test('no warning more than 3 days ahead, and none for a meeting in progress', async () => {
  const early = await retentionFixture({ deleteAfter: new Date(now.getTime() + 3 * 24 * HOUR + 1000) })
  expect((await retentionTick(early.deps, now)).warned).toBe(0)
  const active = await retentionFixture({ state: 'in_meeting', deleteAfter: new Date(now.getTime() + HOUR) })
  expect((await retentionTick(active.deps, now)).warned).toBe(0)
})

test('a ping that fails still leaves the warning stamped', async () => {
  const notifier = new FakeNotifier()
  notifier.notify = async () => false
  const f = await retentionFixture({ deleteAfter: new Date('2026-11-20T08:00:00Z'), notifier })
  expect((await retentionTick(f.deps, now)).warned).toBe(1)
  expect((await f.occurrence()).deletionWarnedAt).toEqual(now)
  expect((await retentionTick(f.deps, now)).warned).toBe(0)
})

test('a ping that throws for one meeting does not stop the warnings for the others', async () => {
  const notifier = new FakeNotifier()
  const send = notifier.notify.bind(notifier)
  let calls = 0
  notifier.notify = async (memberId, ping) => {
    if (++calls === 1) throw new Error('ntfy down')
    return await send(memberId, ping)
  }
  const f = await retentionFixture({ deleteAfter: new Date('2026-11-20T08:00:00Z'), notifier })
  const [first] = await f.db.select().from(occurrences).where(eq(occurrences.id, f.id))
  const [second] = await f.db
    .insert(occurrences)
    .values({ ...first!, id: randomUUID(), scheduledStart: new Date('2026-10-22T06:00:00Z') })
    .returning()
  const err = await retentionTick(f.deps, now).then(
    () => null,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(AggregateError)
  expect((err as AggregateError).message).toBe('retention: 1 failure(s): ntfy down')
  expect(f.notifier.sent).toHaveLength(1)
  const stamped = await f.db.select({ at: occurrences.deletionWarnedAt }).from(occurrences)
  expect(stamped.map((r) => r.at)).toEqual([now, now])
  expect(second!.id).not.toBe(f.id)
})

test('a meeting past its deletion time is gone from disk and database', async () => {
  const f = await retentionFixture({
    state: 'completed',
    deleteAfter: new Date(now.getTime() - 1000),
    files: ['recording/meeting.mp4', 'forms/f1/filled.png'],
    withRows: true
  })
  expect((await retentionTick(f.deps, now)).deleted).toBe(1)
  expect(await exists(f.dir)).toBe(false)
  expect([await f.count(forms), await f.count(artefacts)]).toEqual([0, 0])
  const left = await f.events()
  expect(left.map((e) => e.data.to)).toEqual(['deleted'])
  expect(left[0]!.data.reason).toBe('expired')
  expect(await f.occurrence()).toMatchObject({
    state: 'deleted',
    entryName: 'Data Mining',
    linkUsed: null,
    pastedLink: null,
    entrySnapshot: null,
    containerName: null,
    controlTokenHash: null
  })
})

test('a meeting in progress is never deleted', async () => {
  const f = await retentionFixture({
    state: 'in_meeting',
    deleteAfter: new Date(now.getTime() - 1000),
    files: ['recording/meeting.mp4']
  })
  expect(await retentionTick(f.deps, now)).toMatchObject({ deleted: 0, orphansRemoved: 0 })
  expect((await f.occurrence()).state).toBe('in_meeting')
  expect(await exists(`${f.dir}/recording/meeting.mp4`)).toBe(true)
})

test('deleting an occurrence that became active, or holds the profile, is refused', async () => {
  const active = await retentionFixture({ state: 'in_meeting', files: ['a.txt'] })
  await expect(deleteOccurrenceData(active.deps, active.id, now)).rejects.toBeInstanceOf(OccurrenceActiveError)
  expect(await exists(`${active.dir}/a.txt`)).toBe(true)

  const held = await retentionFixture({ state: 'completed', files: ['a.txt'] })
  await held.db
    .update(profiles)
    .set({ heldBy: `occ:${held.id}` })
    .where(eq(profiles.identityId, held.identityId))
  await expect(deleteOccurrenceData(held.deps, held.id, now)).rejects.toBeInstanceOf(OccurrenceActiveError)
  expect((await held.occurrence()).state).toBe('completed')
})

test('a meeting still in the pipeline is busy: delete is refused and the tick skips and counts it', async () => {
  for (const state of ['transcribing', 'waiting_for_pc', 'post_processing'] as const) {
    const f = await retentionFixture({
      state,
      deleteAfter: new Date(now.getTime() - 1000),
      files: ['recording/meeting.mp4'],
      withRows: true
    })
    await expect(deleteOccurrenceData(f.deps, f.id, now)).rejects.toBeInstanceOf(OccurrenceActiveError)
    expect(await retentionTick(f.deps, now)).toMatchObject({ deleted: 0, skipped: 1 })
    expect((await f.occurrence()).state).toBe(state)
    expect(await exists(`${f.dir}/recording/meeting.mp4`)).toBe(true)
    expect(await f.count(artefacts)).toBe(1)
  }
})

test('a meeting stuck in the pipeline 40 days past its time is failed and deleted', async () => {
  for (const state of ['transcribing', 'waiting_for_pc', 'post_processing'] as const) {
    const f = await retentionFixture({
      state,
      stateReason: state === 'post_processing' ? 'ai_key_error' : undefined,
      deleteAfter: new Date(now.getTime() - 40 * 24 * HOUR),
      files: ['recording/meeting.mp4'],
      withRows: true
    })
    expect(await retentionTick(f.deps, now)).toMatchObject({ deleted: 1, skipped: 0 })
    expect(await f.occurrence()).toMatchObject({ state: 'deleted' })
    expect(await exists(f.dir)).toBe(false)
    expect(await f.count(artefacts)).toBe(0)
    expect((await f.events()).map((e) => e.data.to)).toEqual(['deleted'])
  }
})

test('a stuck meeting is only taken over after 3 hours past its time', async () => {
  const young = await retentionFixture({ state: 'post_processing', deleteAfter: new Date(now.getTime() - 2 * HOUR) })
  expect(await retentionTick(young.deps, now)).toMatchObject({ deleted: 0, skipped: 1 })
  expect((await young.occurrence()).state).toBe('post_processing')
  const old = await retentionFixture({ state: 'post_processing', deleteAfter: new Date(now.getTime() - 4 * HOUR) })
  expect(await retentionTick(old.deps, now)).toMatchObject({ deleted: 1, skipped: 0 })
})

test('a stuck meeting whose pipeline holds the lock is skipped, and deleted once the lock is free', async () => {
  const f = await retentionFixture({
    state: 'post_processing',
    stateReason: 'ai_key_error',
    deleteAfter: new Date(now.getTime() - 40 * 24 * HOUR),
    files: ['recording/meeting.mp4']
  })
  let release = () => {}
  const released = new Promise<void>((resolve) => (release = resolve))
  let locked = () => {}
  const lockTaken = new Promise<void>((resolve) => (locked = resolve))
  // The consumer's own lock call, held in a transaction the way a running pipeline holds it.
  const pipeline = f.db.transaction(async (tx) => {
    expect(await tryPipelineLock(tx, f.id)).toBe(true)
    locked()
    await released
  })
  await lockTaken
  expect(await retentionTick(f.deps, now)).toMatchObject({ deleted: 0, skipped: 1 })
  expect(await f.occurrence()).toMatchObject({ state: 'post_processing', stateReason: 'ai_key_error' })
  expect(await exists(`${f.dir}/recording/meeting.mp4`)).toBe(true)
  release()
  await pipeline
  expect(await retentionTick(f.deps, now)).toMatchObject({ deleted: 1, skipped: 0 })
  expect((await f.occurrence()).state).toBe('deleted')
})

test('a stuck meeting that holds the profile is never taken over', async () => {
  const f = await retentionFixture({
    state: 'transcribing',
    deleteAfter: new Date(now.getTime() - 40 * 24 * HOUR),
    files: ['a.txt']
  })
  await f.db
    .update(profiles)
    .set({ heldBy: `occ:${f.id}` })
    .where(eq(profiles.identityId, f.identityId))
  expect(await retentionTick(f.deps, now)).toMatchObject({ deleted: 0, skipped: 1 })
  expect((await f.occurrence()).state).toBe('transcribing')
  expect(await exists(`${f.dir}/a.txt`)).toBe(true)
})

test('retrying a tombstone also removes artefact rows left behind', async () => {
  const f = await retentionFixture({ state: 'completed', files: ['a.txt'], withRows: true })
  await deleteOccurrenceData(f.deps, f.id, now)
  await f.db
    .insert(artefacts)
    .values({ occurrenceId: f.id, memberId: f.memberId, kind: 'recording', path: 'recording/late.mp4', bytes: 4 })
  await mkdir(`${f.dir}/leftover`, { recursive: true })
  await deleteOccurrenceData(f.deps, f.id, now)
  expect(await f.count(artefacts)).toBe(0)
  expect(await exists(f.dir)).toBe(false)
  expect((await f.occurrence()).state).toBe('deleted')
})

test('delete now deletes before the expiry date and records the member as the reason', async () => {
  const f = await retentionFixture({ state: 'completed', stateReason: 'deleting', files: ['a.txt'], withRows: true })
  await deleteOccurrenceData(f.deps, f.id, now)
  expect(await exists(f.dir)).toBe(false)
  expect((await f.events()).map((e) => e.data.reason)).toEqual(['member'])
  expect((await f.occurrence()).state).toBe('deleted')
})

test('deletion never follows a symlink out of the occurrence directory', async () => {
  const f = await retentionFixture({
    state: 'completed',
    deleteAfter: new Date(now.getTime() - 1000),
    files: ['a.txt']
  })
  const outside = `${f.root}/outside`
  await mkdir(outside)
  await writeFile(`${outside}/keep.txt`, 'keep')
  await symlink(`${outside}/keep.txt`, `${f.dir}/link-to-file`)
  await symlink(outside, `${f.dir}/link-to-dir`)
  expect((await retentionTick(f.deps, now)).deleted).toBe(1)
  expect(await exists(f.dir)).toBe(false)
  expect(await readFile(`${outside}/keep.txt`, 'utf8')).toBe('keep')
})

test('an occurrence directory that is itself a symlink is unlinked, not followed', async () => {
  const f = await retentionFixture({ state: 'completed', deleteAfter: new Date(now.getTime() - 1000) })
  const outside = `${f.root}/outside`
  await mkdir(outside)
  await writeFile(`${outside}/keep.txt`, 'keep')
  await rm(f.dir, { recursive: true })
  await symlink(outside, f.dir)
  expect((await retentionTick(f.deps, now)).deleted).toBe(1)
  expect(await exists(f.dir)).toBe(false)
  expect(await readFile(`${outside}/keep.txt`, 'utf8')).toBe('keep')
})

test('a directory that cannot be removed leaves a tombstone that the next pass retries', async () => {
  const f = await retentionFixture({
    state: 'completed',
    deleteAfter: new Date(now.getTime() - 1000),
    files: ['a.txt']
  })
  // A file where the directory should be makes the removal fail after the database step.
  await rm(f.dir, { recursive: true })
  await writeFile(f.dir, 'not a directory')
  await expect(retentionTick(f.deps, now)).rejects.toBeInstanceOf(AggregateError)
  expect((await f.occurrence()).state).toBe('deleted')
  await rm(f.dir)
  await mkdir(`${f.dir}/leftover`, { recursive: true })
  expect(await retentionTick(f.deps, now)).toMatchObject({ deleted: 0, orphansRemoved: 1 })
  expect(await exists(f.dir)).toBe(false)
})

test('a failing expiry query does not skip the orphan and checkpoint steps', async () => {
  const f = await retentionFixture({
    orphanOccurrenceDir: true,
    checkpoints: ['1', '2', '3', '4'].map((n) => `2026110${n}T000000Z.tar.enc`)
  })
  // The warning step selects first and the expiry step second; the second select fails.
  let selects = 0
  const db = new Proxy(f.db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (prop !== 'select') return typeof value === 'function' ? value.bind(target) : value
      return (...args: unknown[]) => {
        if (++selects === 2) throw new Error('expiry query down')
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    }
  })
  const err = await retentionTick({ ...f.deps, db }, now).then(
    () => null,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(AggregateError)
  expect((err as AggregateError).errors).toHaveLength(1)
  expect((err as AggregateError).message).toContain('expiry query down')
  expect(await f.checkpointNames()).toHaveLength(3)
  expect((await readdir(`${f.env.dataRoot}/occurrences`)).sort()).toEqual([f.id])
})

test('orphaned directories go and only 3 checkpoints stay', async () => {
  const f = await retentionFixture({
    orphanOccurrenceDir: true,
    orphanProfileDir: true,
    checkpoints: ['20261101T000000Z', '20261102T000000Z', '20261103T000000Z', '20261104T000000Z'].map(
      (t) => `${t}.tar.enc`
    )
  })
  expect(await retentionTick(f.deps, now)).toMatchObject({ orphansRemoved: 2, checkpointsPruned: 1 })
  expect(await f.checkpointNames()).toEqual([
    '20261102T000000Z.tar.enc',
    '20261103T000000Z.tar.enc',
    '20261104T000000Z.tar.enc'
  ])
  expect(await exists(f.dir)).toBe(true)
})

test('only UUID-named directories are orphans: .machine-ids and other names stay', async () => {
  const f = await retentionFixture()
  await mkdir(`${f.env.profileRoot}/.machine-ids`, { recursive: true })
  await writeFile(`${f.env.profileRoot}/.machine-ids/${f.identityId}`, 'id')
  await mkdir(`${f.env.profileRoot}/not-a-uuid/work`, { recursive: true })
  await mkdir(`${f.env.dataRoot}/occurrences/lost+found`, { recursive: true })
  await mkdir(`${f.env.profileRoot}/${f.identityId}/work`, { recursive: true })
  expect((await retentionTick(f.deps, now)).orphansRemoved).toBe(0)
  for (const p of [
    `${f.env.profileRoot}/.machine-ids/${f.identityId}`,
    `${f.env.profileRoot}/not-a-uuid/work`,
    `${f.env.dataRoot}/occurrences/lost+found`,
    `${f.env.profileRoot}/${f.identityId}/work`,
    f.dir
  ])
    expect(await exists(p)).toBe(true)
})

test('an orphan that is a symlink is unlinked without touching its target', async () => {
  const f = await retentionFixture()
  const outside = `${f.root}/outside`
  await mkdir(outside)
  await writeFile(`${outside}/keep.txt`, 'keep')
  const stray = randomUUID()
  await mkdir(f.env.profileRoot, { recursive: true })
  await symlink(outside, `${f.env.profileRoot}/${stray}`)
  await symlink(outside, `${f.env.dataRoot}/occurrences/${randomUUID()}`)
  expect((await retentionTick(f.deps, now)).orphansRemoved).toBe(2)
  expect(await exists(`${f.env.profileRoot}/${stray}`)).toBe(false)
  expect(await readFile(`${outside}/keep.txt`, 'utf8')).toBe('keep')
})

test('checkpoint pruning keeps the newest by name, spares fresh temp files and never follows links', async () => {
  const names = ['20261101T000000Z', '20261102T000000Z', '20261103T000000Z', '20261104T000000Z', '20261105T000000Z']
  const f = await retentionFixture({ checkpoints: names.map((t) => `${t}.tar.enc`).reverse() })
  const fresh = `${f.cpDir}/20261106T000000Z.tar.enc.tmp-aaaa`
  const stale = `${f.cpDir}/20261106T000000Z.tar.enc.tmp-bbbb`
  await writeFile(fresh, 'x')
  await writeFile(stale, 'x')
  const old = new Date(now.getTime() - 120_000)
  await utimes(stale, old, old)
  await utimes(fresh, new Date(now.getTime() - 5_000), new Date(now.getTime() - 5_000))
  // A link named like the oldest checkpoint, pointing outside, must survive pruning untouched.
  const outside = `${f.root}/outside`
  await mkdir(outside)
  await writeFile(`${outside}/keep.txt`, 'keep')
  await symlink(`${outside}/keep.txt`, `${f.cpDir}/20261100T000000Z.tar.enc`)

  expect((await retentionTick(f.deps, now)).checkpointsPruned).toBe(2)
  expect(await f.checkpointNames()).toEqual([
    '20261100T000000Z.tar.enc',
    '20261103T000000Z.tar.enc',
    '20261104T000000Z.tar.enc',
    '20261105T000000Z.tar.enc',
    '20261106T000000Z.tar.enc.tmp-aaaa'
  ])
  expect(await readFile(`${outside}/keep.txt`, 'utf8')).toBe('keep')
})

test('checkpoints of an identity whose profile is held are not pruned', async () => {
  const f = await retentionFixture({ checkpoints: ['1', '2', '3', '4', '5'].map((n) => `2026110${n}T000000Z.tar.enc`) })
  await f.db
    .update(profiles)
    .set({ heldBy: `occ:${f.id}` })
    .where(eq(profiles.identityId, f.identityId))
  expect((await retentionTick(f.deps, now)).checkpointsPruned).toBe(0)
  expect(await f.checkpointNames()).toHaveLength(5)
  await f.db.update(profiles).set({ heldBy: null }).where(eq(profiles.identityId, f.identityId))
  expect((await retentionTick(f.deps, now)).checkpointsPruned).toBe(2)
})

test('a checkpoints directory that is a symlink is left alone', async () => {
  const f = await retentionFixture()
  const outside = `${f.root}/outside`
  await mkdir(outside)
  for (const t of ['1', '2', '3', '4', '5']) await writeFile(`${outside}/2026110${t}T000000Z.tar.enc`, 'x')
  await mkdir(`${f.env.profileRoot}/${f.identityId}`, { recursive: true })
  await symlink(outside, f.cpDir)
  expect((await retentionTick(f.deps, now)).checkpointsPruned).toBe(0)
  expect(await readdir(outside)).toHaveLength(5)
})
