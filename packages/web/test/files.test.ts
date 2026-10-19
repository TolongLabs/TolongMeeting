import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { artefacts, type Db } from '../db'
import { createTestDb, dropAllTestDbs, seedMember } from '../db/testing'
import { memberFile, serveFile } from '../lib/files'
import { createScope } from '../lib/scope'

let db: Db
let work: string
let previousRoot: string | undefined

beforeAll(async () => {
  db = await createTestDb()
  work = await mkdtemp(join(tmpdir(), 'tm-files-'))
  previousRoot = process.env.TM_DATA_ROOT
  process.env.TM_DATA_ROOT = join(work, 'data')
}, 30_000)

afterAll(async () => {
  if (previousRoot === undefined) delete process.env.TM_DATA_ROOT
  else process.env.TM_DATA_ROOT = previousRoot
  await rm(work, { recursive: true, force: true })
  await dropAllTestDbs()
}, 30_000)

async function file(name: string, bytes: Uint8Array | string): Promise<string> {
  const path = join(work, name)
  await writeFile(path, bytes)
  return path
}

const thousand = () => new Uint8Array(1000).map((_, i) => i % 251)

test('a range request returns 206 with the slice', async () => {
  const p = await file('v.mp4', thousand())
  const r = await serveFile(p, 'bytes=0-99')
  expect(r.status).toBe(206)
  expect(r.headers.get('content-range')).toBe('bytes 0-99/1000')
  expect(r.headers.get('content-length')).toBe('100')
  expect(r.headers.get('cache-control')).toBe('private, no-store')
  expect(r.headers.get('x-content-type-options')).toBe('nosniff')
  expect(r.headers.get('accept-ranges')).toBe('bytes')
  expect(r.headers.get('content-type')).toBe('video/mp4')
  expect(new Uint8Array(await r.arrayBuffer())).toEqual(thousand().slice(0, 100))
})

test('open-ended, suffix and over-long ranges are clamped to the file', async () => {
  const p = await file('v.mp4', thousand())
  const open = await serveFile(p, 'bytes=900-')
  expect([open.status, open.headers.get('content-range')]).toEqual([206, 'bytes 900-999/1000'])
  const suffix = await serveFile(p, 'bytes=-10')
  expect([suffix.status, suffix.headers.get('content-range')]).toEqual([206, 'bytes 990-999/1000'])
  expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(thousand().slice(990))
  const long = await serveFile(p, 'bytes=990-5000')
  expect([long.status, long.headers.get('content-range')]).toEqual([206, 'bytes 990-999/1000'])
  const big = await serveFile(p, 'bytes=-5000')
  expect([big.status, big.headers.get('content-range')]).toEqual([206, 'bytes 0-999/1000'])
})

test('no range returns the whole file; a bad range returns 416', async () => {
  const p = await file('v.mp4', thousand())
  const whole = await serveFile(p, null)
  expect(whole.status).toBe(200)
  expect(whole.headers.get('content-range')).toBeNull()
  expect((await whole.arrayBuffer()).byteLength).toBe(1000)
  for (const range of [
    'bytes=2000-',
    'bytes=1000-1000',
    'bytes=5-2',
    'bytes=-0',
    'bytes=-',
    'bytes=a-b',
    'bytes=1-2-3'
  ]) {
    const bad = await serveFile(p, range)
    expect([range, bad.status, bad.headers.get('content-range')]).toEqual([range, 416, 'bytes */1000'])
  }
})

test('a range in another unit, or several ranges, is ignored', async () => {
  const p = await file('v.mp4', thousand())
  for (const range of ['items=0-9', 'bytes=0-9,20-29']) {
    const r = await serveFile(p, range)
    expect([range, r.status, (await r.arrayBuffer()).byteLength]).toEqual([range, 200, 1000])
  }
})

test('an empty file serves with no body, and every range on it is 416', async () => {
  const p = await file('empty.txt', '')
  expect((await serveFile(p, null)).status).toBe(200)
  expect((await serveFile(p, 'bytes=0-0')).status).toBe(416)
})

test('markdown is plain text, and unlisted types (html, svg) are downloads that no browser runs', async () => {
  const md = await serveFile(await file('s.md', '# x'), null)
  expect(md.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  for (const name of ['x.html', 'x.svg', 'x.bin', 'noext']) {
    const r = await serveFile(await file(name, '<script>alert(1)</script>'), null)
    expect([name, r.headers.get('content-type'), r.headers.get('content-disposition')]).toEqual([
      name,
      'application/octet-stream',
      'attachment'
    ])
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
  }
})

test('a directory, a missing file and a symlink answer 404 with no path in the body', async () => {
  const dir = join(work, 'a-dir')
  await mkdir(dir, { recursive: true })
  const real = await file('real.txt', 'hello')
  await symlink(real, join(work, 'link.txt'))
  for (const path of [dir, join(work, 'missing.txt'), join(work, 'link.txt')]) {
    const r = await serveFile(path, null)
    expect([r.status, await r.text()]).toEqual([404, 'Not found'])
  }
})

async function occurrenceFixture() {
  const a = await seedMember(db)
  const b = await seedMember(db)
  const occurrenceId = a.ids.occurrences
  const dir = join(process.env.TM_DATA_ROOT!, 'occurrences', occurrenceId)
  await mkdir(join(dir, 'recording'), { recursive: true })
  return { scope: createScope(db, a.memberId), other: createScope(db, b.memberId), occurrenceId, dir }
}

async function register(scope: ReturnType<typeof createScope>, occurrenceId: string, path: string) {
  await scope.insert(artefacts, { occurrenceId, kind: 'recording', path, bytes: 1 })
}

test('memberFile returns the real path of a registered regular file, only to its owner', async () => {
  const { scope, other, occurrenceId, dir } = await occurrenceFixture()
  await writeFile(join(dir, 'recording', 'meeting.mp4'), 'video')
  await register(scope, occurrenceId, 'recording/meeting.mp4')
  const found = await memberFile(scope, occurrenceId, 'recording/meeting.mp4')
  expect(found).toEndWith(`/occurrences/${occurrenceId}/recording/meeting.mp4`)
  expect(await memberFile(other, occurrenceId, 'recording/meeting.mp4')).toBeNull()
  expect(await memberFile(scope, occurrenceId, 'recording/other.mp4')).toBeNull()
  expect(await memberFile(scope, occurrenceId, '../../x')).toBeNull()
  expect(await memberFile(scope, occurrenceId, 'recording/meeting.mp4\0.png')).toBeNull()
})

test('memberFile refuses a symlink that points outside the occurrence directory', async () => {
  const { scope, occurrenceId, dir } = await occurrenceFixture()
  const secret = await file('secret.txt', 'not yours')
  await symlink(secret, join(dir, 'recording', 'leak.mp4'))
  await symlink(work, join(dir, 'linked-dir'))
  await register(scope, occurrenceId, 'recording/leak.mp4')
  await register(scope, occurrenceId, 'linked-dir/secret.txt')
  expect(await memberFile(scope, occurrenceId, 'recording/leak.mp4')).toBeNull()
  expect(await memberFile(scope, occurrenceId, 'linked-dir/secret.txt')).toBeNull()
})

test('memberFile allows a symlink that stays inside, and refuses a directory or a file that is gone', async () => {
  const { scope, occurrenceId, dir } = await occurrenceFixture()
  await writeFile(join(dir, 'recording', 'meeting.mkv'), 'video')
  await symlink(join(dir, 'recording', 'meeting.mkv'), join(dir, 'recording', 'alias.mkv'))
  await mkdir(join(dir, 'forms'), { recursive: true })
  for (const path of ['recording/alias.mkv', 'forms', 'recording/gone.mp4']) await register(scope, occurrenceId, path)
  expect(await memberFile(scope, occurrenceId, 'recording/alias.mkv')).toEndWith('/recording/meeting.mkv')
  expect(await memberFile(scope, occurrenceId, 'forms')).toBeNull()
  expect(await memberFile(scope, occurrenceId, 'recording/gone.mp4')).toBeNull()
})
