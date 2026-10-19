import { afterEach, beforeEach, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  CheckpointAuthError,
  ProfileHostMismatch,
  checkpointProfile,
  prepareProfile,
  restoreProfile,
  startCheckpoints
} from '../src/profile/profile'
import { hostnameFor, machineIdFor } from '../src/profile/keys'

let root: string
let dir: string
let out: string
let midFile: string
let okHost: { hostname: string; machineIdPath: string }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tm-profile-'))
  dir = join(root, 'profile')
  out = join(root, 'checkpoints')
  await mkdir(dir)
  midFile = join(root, 'machine-id')
  await writeFile(midFile, `${machineIdFor('id-1')}\n`)
  okHost = { hostname: hostnameFor('id-1'), machineIdPath: midFile }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function put(path: string, body: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body)
}

async function tree(base: string): Promise<string[]> {
  const found: string[] = []
  async function walk(rel: string): Promise<void> {
    for (const entry of await readdir(join(base, rel), { withFileTypes: true })) {
      const next = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) await walk(next)
      else found.push(next)
    }
  }
  await walk('')
  return found.sort()
}

async function flipByte(file: string, offset: number): Promise<void> {
  const bytes = await readFile(file)
  bytes[offset] ^= 0xff
  await writeFile(file, bytes)
}

test('prepare removes Chrome singleton files and keeps the rest', async () => {
  await symlink('tm-host-123', join(dir, 'SingletonLock'))
  await writeFile(join(dir, 'SingletonSocket'), '')
  await writeFile(join(dir, 'SingletonCookie'), '')
  await writeFile(join(dir, 'Local State'), '{}')
  await prepareProfile(dir, 'id-1', okHost)
  expect(await readdir(dir)).toEqual(['Local State'])
})

test('prepare refuses a host that does not match the identity', async () => {
  await expect(prepareProfile(dir, 'id-1', { hostname: 'other', machineIdPath: midFile })).rejects.toBeInstanceOf(
    ProfileHostMismatch
  )
})

test('prepare refuses a machine id that does not match the identity', async () => {
  const wrongId = join(root, 'wrong-machine-id')
  await writeFile(wrongId, `${machineIdFor('someone-else')}\n`)
  await expect(
    prepareProfile(dir, 'id-1', { hostname: hostnameFor('id-1'), machineIdPath: wrongId })
  ).rejects.toBeInstanceOf(ProfileHostMismatch)
})

test('checkpoint strips caches and restores with the right key only', async () => {
  for (const p of [
    'Default/Cache/a',
    'Default/Code Cache/b',
    'Default/GPUCache/c',
    'Default/Service Worker/CacheStorage/d',
    'Crashpad/e',
    'Default/Cookies',
    'Default/IndexedDB/x'
  ]) {
    await put(join(dir, p), 'v')
  }
  const key = randomBytes(32)
  const file = await checkpointProfile(dir, out, key)
  expect(basename(file)).toMatch(/^\d{8}T\d{6}Z\.tar\.enc$/)
  expect((await readFile(file)).subarray(0, 6).toString()).toBe('TMCK1\n')

  const restored = join(root, 'restored')
  await restoreProfile(file, restored, key)
  expect(await tree(restored)).toEqual(['Default/Cookies', 'Default/IndexedDB/x'])

  await expect(restoreProfile(file, join(root, 'other'), randomBytes(32))).rejects.toBeInstanceOf(CheckpointAuthError)
  expect(existsSync(join(root, 'other'))).toBe(false)

  await flipByte(file, 40)
  const other2 = join(root, 'other2')
  await expect(restoreProfile(file, other2, key)).rejects.toBeInstanceOf(CheckpointAuthError)
  expect(existsSync(other2)).toBe(false)
})

test('only the newest 3 checkpoints are kept and no .tmp file is left', async () => {
  await put(join(dir, 'Default/Cookies'), 'v')
  const key = randomBytes(32)
  const clockAt = (i: number) => () => new Date(Date.UTC(2026, 9, 20, 10, 0, i))
  const written: string[] = []
  for (let i = 0; i < 5; i++) written.push(basename(await checkpointProfile(dir, out, key, clockAt(i))))

  const files = await readdir(out)
  expect(files.filter((f) => f.endsWith('.tar.enc')).length).toBe(3)
  expect(files.some((f) => f.endsWith('.tmp'))).toBe(false)
  expect(files.sort()).toEqual(written.slice(2).sort())
})

test('startCheckpoints writes checkpoints on an interval and stop waits for the last one', async () => {
  await put(join(dir, 'Default/Cookies'), 'v')
  const key = randomBytes(32)
  const runner = startCheckpoints(dir, out, key, 20)
  const deadline = Date.now() + 5000
  while (!existsSync(out) || (await readdir(out)).filter((f) => f.endsWith('.tar.enc')).length === 0) {
    if (Date.now() > deadline) throw new Error('no checkpoint written within 5 s')
    await Bun.sleep(10)
  }
  await runner.stop()
  const files = await readdir(out)
  expect(files.some((f) => f.endsWith('.tmp'))).toBe(false)
  const restored = join(root, 'from-interval')
  await restoreProfile(
    join(
      out,
      files.find((f) => f.endsWith('.tar.enc'))!
    ),
    restored,
    key
  )
  expect(await tree(restored)).toEqual(['Default/Cookies'])
})
