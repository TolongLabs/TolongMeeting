import { afterAll, beforeEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { profiles, type Db } from '@tm/web/db'
import { FakeNotifier } from '@tm/web/db/notifier'
import { createTestDb, dropAllTestDbs, FakeQueue, seedMember } from '@tm/web/db/testing'
import { FakeDocker, type LaunchDeps } from '../src/index'
import { deleteServerProfile, handleProfileDelete } from '../src/profile-delete'

let tmp: string
let db: Db
let root: string
let identityId: string

beforeEach(async () => {
  tmp ??= await mkdtemp(join(tmpdir(), 'profile-delete-'))
  root = await mkdtemp(join(tmp, 'p-'))
  db = await createTestDb()
  identityId = (await seedMember(db, { full: false })).identityId
}, 60_000)

afterAll(async () => {
  await dropAllTestDbs()
  await rm(tmp, { recursive: true, force: true })
}, 60_000)

const deps = (): LaunchDeps => ({
  db,
  queue: new FakeQueue(),
  docker: new FakeDocker(),
  notifier: new FakeNotifier(),
  master: Buffer.alloc(32, 3),
  remux: async () => false,
  env: {
    dataRoot: join(root, 'data'),
    profileRoot: root,
    publicUrl: 'https://tm.example',
    ntfyUrl: 'https://ntfy.example'
  }
})

async function files(...paths: string[]) {
  for (const p of paths) {
    await mkdir(join(root, p, '..'), { recursive: true })
    await writeFile(join(root, p), 'x')
  }
}
const row = async () => (await db.select().from(profiles).where(eq(profiles.identityId, identityId)))[0]!

test('deleteServerProfile removes only that identity', async () => {
  await files(
    'u1/work/Default/Cookies',
    'u1/checkpoints/1.tar.enc',
    'u1/job/tm-worker-x.json',
    'u2/work/x',
    '.machine-ids/u1',
    '.machine-ids/u2'
  )
  await deleteServerProfile('u1', root)
  expect(existsSync(join(root, 'u1'))).toBe(false)
  expect(existsSync(join(root, '.machine-ids/u1'))).toBe(false)
  expect(existsSync(join(root, 'u2/work/x'))).toBe(true)
  expect(existsSync(join(root, '.machine-ids/u2'))).toBe(true)
  await deleteServerProfile('u1', root) // twice is fine
})

test('deleteServerProfile unlinks a symlink instead of following it, and refuses ids that are not one segment', async () => {
  await files('outside/keep')
  await symlink(join(root, 'outside'), join(root, 'u1'))
  await deleteServerProfile('u1', root)
  expect(existsSync(join(root, 'u1'))).toBe(false)
  expect(existsSync(join(root, 'outside/keep'))).toBe(true)
  for (const bad of ['', '.', '..', '../outside', 'a/b', '.machine-ids', '/etc'])
    await expect(deleteServerProfile(bad, root)).rejects.toThrow('not an identity id')
  expect(existsSync(join(root, 'outside/keep'))).toBe(true)
  await expect(deleteServerProfile('u1', '')).rejects.toThrow('TM_PROFILE_ROOT is not set')
})

async function onMyPc() {
  await files(`${identityId}/work/Default/Cookies`, `${identityId}/checkpoints/1.tar.enc`, `.machine-ids/${identityId}`)
  await db
    .update(profiles)
    .set({
      location: 'local',
      latestCheckpoint: '1.tar.enc',
      checkpointAt: new Date(),
      accountStatus: { zoom: { signedIn: true, verifiedAt: 'x' } }
    })
    .where(eq(profiles.identityId, identityId))
}

test('the job deletes the server copy of an identity that moved to My PC and clears what the row says about it', async () => {
  await onMyPc()
  expect(await handleProfileDelete(deps(), { identityId }, new Date())).toContain('server copy deleted')
  expect(existsSync(join(root, identityId))).toBe(false)
  expect(existsSync(join(root, '.machine-ids', identityId))).toBe(false)
  expect(await row()).toMatchObject({
    location: 'local',
    latestCheckpoint: null,
    checkpointAt: null,
    accountStatus: {},
    heldBy: null
  })
})

test('the job throws, and deletes nothing, while a sign-in or meeting holds the profile', async () => {
  await onMyPc()
  await db.update(profiles).set({ heldBy: 'signin:s1' }).where(eq(profiles.identityId, identityId))
  await expect(handleProfileDelete(deps(), { identityId }, new Date())).rejects.toThrow('in use')
  expect(existsSync(join(root, identityId, 'work/Default/Cookies'))).toBe(true)
  expect((await row()).heldBy).toBe('signin:s1')
})

test('the job leaves an identity that is back on the server alone, and one that is gone', async () => {
  await onMyPc()
  await db.update(profiles).set({ location: 'server' }).where(eq(profiles.identityId, identityId))
  expect(await handleProfileDelete(deps(), { identityId }, new Date())).toContain('nothing deleted')
  expect(existsSync(join(root, identityId, 'work/Default/Cookies'))).toBe(true)
  expect((await row()).heldBy).toBeNull()
  expect(await handleProfileDelete(deps(), { identityId: randomUUID() }, new Date())).toContain('no such profile')
})

test('a job body that is not an identity id fails loudly', async () => {
  await expect(handleProfileDelete(deps(), { identityId: '../x' }, new Date())).rejects.toThrow()
  await expect(handleProfileDelete(deps(), {}, new Date())).rejects.toThrow()
})
