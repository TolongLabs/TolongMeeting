import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createCipheriv, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  CheckpointAuthError,
  CheckpointFormatError,
  ProfileHostMismatch,
  checkpointProfile,
  latestCheckpoint,
  listCheckpoints,
  prepareProfile,
  restoreProfile,
  scheduleTicks,
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

async function put(path: string, body: string | Buffer): Promise<void> {
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

// A raw ustar entry, so a test can put hostile names and link types into an archive that tar.c would never write.
function tarEntry(name: string, type: '0' | '1' | '2', body: Buffer = Buffer.alloc(0), linkname = ''): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124)
  header.write('00000000000\0', 136)
  header.fill(' ', 148, 156)
  header.write(type, 156)
  header.write(linkname, 157, 100, 'utf8')
  header.write('ustar\0', 257)
  header.write('00', 263)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512)
  body.copy(padded)
  return Buffer.concat([header, padded])
}

function tarArchive(entries: Buffer[]): Buffer {
  return Buffer.concat([...entries, Buffer.alloc(1024)])
}

// Encrypts any tar bytes in the TMCK1 layout, so the result authenticates and only its contents are hostile.
function sealRaw(tarBytes: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(tarBytes), cipher.final()])
  return Buffer.concat([Buffer.from('TMCK1\n'), iv, body, cipher.getAuthTag()])
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

test('look-alike names are kept and only the excluded cache folders are dropped', async () => {
  for (const p of [
    'MyCache/a',
    'Default/MyCache/b',
    'Service Worker/Other/c',
    'Default/Service Worker/Database/d',
    'Default/Cache/e',
    'Default/Service Worker/CacheStorage/f',
    'Default/GPUCache/g',
    'Crashpad/h'
  ]) {
    await put(join(dir, p), 'v')
  }
  const key = randomBytes(32)
  const file = await checkpointProfile(dir, out, key)
  const restored = join(root, 'lookalike')
  await restoreProfile(file, restored, key)
  expect(await tree(restored)).toEqual([
    'Default/MyCache/b',
    'Default/Service Worker/Database/d',
    'MyCache/a',
    'Service Worker/Other/c'
  ])
})

test('two checkpoints of the same data use different IVs', async () => {
  await put(join(dir, 'Default/Cookies'), 'same data')
  const key = randomBytes(32)
  const first = await checkpointProfile(dir, out, key, () => new Date(Date.UTC(2026, 9, 20, 10, 0, 0)))
  const second = await checkpointProfile(dir, out, key, () => new Date(Date.UTC(2026, 9, 20, 10, 0, 1)))
  const a = await readFile(first)
  const b = await readFile(second)
  expect(a.subarray(6, 18).equals(b.subarray(6, 18))).toBe(false)
  expect(a.equals(b)).toBe(false)
})

test('a truncated checkpoint is refused', async () => {
  await put(join(dir, 'Default/Cookies'), 'v')
  const key = randomBytes(32)
  const file = await checkpointProfile(dir, out, key)
  const bytes = await readFile(file)

  await writeFile(file, bytes.subarray(0, bytes.length - 40))
  await expect(restoreProfile(file, join(root, 'cut-tail'), key)).rejects.toBeInstanceOf(CheckpointAuthError)

  await writeFile(file, bytes.subarray(0, 28))
  await expect(restoreProfile(file, join(root, 'cut-to-tag'), key)).rejects.toBeInstanceOf(CheckpointFormatError)

  await writeFile(file, bytes.subarray(0, 10))
  await expect(restoreProfile(file, join(root, 'cut-short'), key)).rejects.toBeInstanceOf(CheckpointFormatError)
  expect(existsSync(join(root, 'cut-short'))).toBe(false)
})

test('a checkpoint with a bad magic header is refused as a format error', async () => {
  await put(join(dir, 'Default/Cookies'), 'v')
  const key = randomBytes(32)
  const file = await checkpointProfile(dir, out, key)
  await flipByte(file, 0)
  const err = await restoreProfile(file, join(root, 'bad-magic'), key).then(
    () => null,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(CheckpointFormatError)
  expect((err as Error).message).toContain('bad header')
})

test('only the newest 3 checkpoints are kept and no tmp file is left', async () => {
  await put(join(dir, 'Default/Cookies'), 'v')
  const key = randomBytes(32)
  const clockAt = (i: number) => () => new Date(Date.UTC(2026, 9, 20, 10, 0, i))
  const written: string[] = []
  for (let i = 0; i < 5; i++) written.push(basename(await checkpointProfile(dir, out, key, clockAt(i))))

  const files = await readdir(out)
  expect(files.filter((f) => f.endsWith('.tar.enc')).length).toBe(3)
  expect(files.some((f) => f.includes('.tmp'))).toBe(false)
  expect(files.sort()).toEqual(written.slice(2).sort())
})

test('a checkpoint removes stale tmp files and keeps a fresh one', async () => {
  await mkdir(out, { recursive: true })
  const stale = join(out, '20261020T090000Z.tar.enc.tmp-deadbeef0000')
  const fresh = join(out, '20261020T095900Z.tar.enc.tmp-cafe00000000')
  await writeFile(stale, 'left by a killed process')
  await writeFile(fresh, 'still being written')
  const twoMinutesAgo = new Date(Date.now() - 120_000)
  await utimes(stale, twoMinutesAgo, twoMinutesAgo)
  await put(join(dir, 'Default/Cookies'), 'v')

  await checkpointProfile(dir, out, randomBytes(32))
  const files = await readdir(out)
  expect(files.includes(basename(stale))).toBe(false)
  expect(files.includes(basename(fresh))).toBe(true)
})

test('startCheckpoints writes checkpoints on an interval and stop waits for the last one', async () => {
  await put(join(dir, 'Default/Cookies'), 'v')
  const key = randomBytes(32)
  const errors: unknown[] = []
  const runner = startCheckpoints(dir, out, key, (err) => errors.push(err), 20)
  try {
    const deadline = Date.now() + 5000
    while (!existsSync(out) || (await readdir(out)).filter((f) => f.endsWith('.tar.enc')).length === 0) {
      if (Date.now() > deadline) throw new Error('no checkpoint written within 5 s')
      await Bun.sleep(10)
    }
  } finally {
    await runner.stop()
  }
  expect(errors).toEqual([])
  const files = await readdir(out)
  expect(files.some((f) => f.includes('.tmp'))).toBe(false)
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

test('scheduled ticks never overlap a tick that is still running', async () => {
  // Each tick takes 15 ms and the timer fires every 1 ms, so an overlapping tick would show up as two in flight.
  let inFlight = 0
  let maxInFlight = 0
  let finished = 0
  const errors: unknown[] = []
  const runner = scheduleTicks(
    async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Bun.sleep(15)
      inFlight--
      finished++
    },
    (err) => errors.push(err),
    1
  )
  try {
    const deadline = Date.now() + 3000
    while (finished < 3) {
      if (Date.now() > deadline) throw new Error('fewer than 3 ticks finished within 3 s')
      await Bun.sleep(5)
    }
  } finally {
    await runner.stop()
  }
  expect(errors).toEqual([])
  expect(maxInFlight).toBe(1)
})

test('a failed tick goes to onError and the timer keeps running', async () => {
  await put(join(dir, 'Default/Cookies'), 'v')
  await writeFile(out, 'a file where the checkpoint folder should be')
  const errors: unknown[] = []
  const runner = startCheckpoints(dir, out, randomBytes(32), (err) => errors.push(err), 10)
  try {
    const deadline = Date.now() + 5000
    while (errors.length < 2) {
      if (Date.now() > deadline) throw new Error('onError was not called twice within 5 s')
      await Bun.sleep(10)
    }
  } finally {
    await runner.stop()
  }
  expect(errors[0]).toBeInstanceOf(Error)
})

const hostile: Array<{ label: string; archive: (base: string) => Buffer; refusal: RegExp }> = [
  {
    label: 'a ../ path',
    archive: () => tarArchive([tarEntry('../evil', '0', Buffer.from('x'))]),
    refusal: /escapes the profile/
  },
  {
    label: 'an absolute path',
    archive: (base) => tarArchive([tarEntry(join(base, 'abs-evil'), '0', Buffer.from('x'))]),
    refusal: /escapes the profile/
  },
  {
    label: 'a hardlink',
    archive: () =>
      tarArchive([
        tarEntry('Default/a', '0', Buffer.from('a')),
        tarEntry('Default/b', '1', Buffer.alloc(0), 'Default/a')
      ]),
    refusal: /type Link is not allowed/
  },
  {
    label: 'a symlink to .. followed by a file through it',
    archive: () =>
      tarArchive([tarEntry('esc', '2', Buffer.alloc(0), '..'), tarEntry('esc/pwned', '0', Buffer.from('x'))]),
    refusal: /points outside the profile/
  },
  {
    label: 'a symlink to an absolute path',
    archive: () => tarArchive([tarEntry('link', '2', Buffer.alloc(0), '/etc')]),
    refusal: /points outside the profile/
  }
]

for (const { label, archive, refusal } of hostile) {
  test(`restore refuses an authentic checkpoint with ${label} and writes nothing`, async () => {
    const key = randomBytes(32)
    await mkdir(out, { recursive: true })
    const file = join(out, '20261020T100000Z.tar.enc')
    await writeFile(file, sealRaw(archive(root), key))
    const before = (await readdir(root)).sort()

    await expect(restoreProfile(file, join(root, 'restored'), key)).rejects.toThrow(refusal)
    expect((await readdir(root)).sort()).toEqual(before)
    expect(existsSync(join(root, 'evil'))).toBe(false)
    expect(existsSync(join(root, 'pwned'))).toBe(false)
    expect(existsSync(join(root, 'abs-evil'))).toBe(false)
  })
}

test('restore accepts a symlink that stays inside the profile', async () => {
  const key = randomBytes(32)
  await mkdir(out, { recursive: true })
  const file = join(out, '20261020T100000Z.tar.enc')
  await writeFile(
    file,
    sealRaw(
      tarArchive([
        tarEntry('Default/Cookies', '0', Buffer.from('v')),
        tarEntry('Default/Cookies.bak', '2', Buffer.alloc(0), 'Cookies')
      ]),
      key
    )
  )
  const restored = join(root, 'restored-link')
  await restoreProfile(file, restored, key)
  expect(await tree(restored)).toEqual(['Default/Cookies', 'Default/Cookies.bak'])
})

test('the latest checkpoint is the newest timestamp', async () => {
  await mkdir(out)
  for (const name of ['20261021T060000Z.tar.enc', '20261021T060500Z.tar.enc', '20261020T235959Z.tar.enc', 'notes.txt'])
    await writeFile(join(out, name), '')
  await writeFile(join(out, '20261022T000000Z.tar.enc.tmp-ab'), '')
  expect(await latestCheckpoint(out)).toBe(join(out, '20261021T060500Z.tar.enc'))
  expect((await listCheckpoints(out)).map((f) => basename(f))).toEqual([
    '20261021T060500Z.tar.enc',
    '20261021T060000Z.tar.enc',
    '20261020T235959Z.tar.enc'
  ])
})

test('no checkpoint directory, or an empty one, holds no latest checkpoint', async () => {
  expect(await latestCheckpoint(join(root, 'missing'))).toBeNull()
  await mkdir(out)
  expect(await latestCheckpoint(out)).toBeNull()
})
