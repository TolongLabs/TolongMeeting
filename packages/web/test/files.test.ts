import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { link, mkdir, mkdtemp, open, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { artefacts, type Db } from '../db'
import { createTestDb, dropAllTestDbs, seedMember } from '../db/testing'
import { openMemberFile, openOccurrenceFile, serveFile, type OpenedFile } from '../lib/files'
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

/** Opens a plain file the way `openMemberFile` would hand it over; `serveFile` closes it. */
const opened = async (path: string): Promise<OpenedFile> => ({ handle: await open(path, 'r'), name: path })
const serve = async (path: string, range: string | null, signal?: AbortSignal) =>
  serveFile(await opened(path), range, signal)

const thousand = () => new Uint8Array(1000).map((_, i) => i % 251)

test('a range request returns 206 with the slice', async () => {
  const p = await file('v.mp4', thousand())
  const r = await serve(p, 'bytes=0-99')
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
  const tail = await serve(p, 'bytes=900-')
  expect([tail.status, tail.headers.get('content-range')]).toEqual([206, 'bytes 900-999/1000'])
  const suffix = await serve(p, 'bytes=-10')
  expect([suffix.status, suffix.headers.get('content-range')]).toEqual([206, 'bytes 990-999/1000'])
  expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(thousand().slice(990))
  const long = await serve(p, 'bytes=990-5000')
  expect([long.status, long.headers.get('content-range')]).toEqual([206, 'bytes 990-999/1000'])
  const big = await serve(p, 'bytes=-5000')
  expect([big.status, big.headers.get('content-range')]).toEqual([206, 'bytes 0-999/1000'])
})

test('no range returns the whole file; a bad range returns 416', async () => {
  const p = await file('v.mp4', thousand())
  const whole = await serve(p, null)
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
    const bad = await serve(p, range)
    expect([range, bad.status, bad.headers.get('content-range')]).toEqual([range, 416, 'bytes */1000'])
  }
})

test('a range in another unit, or several ranges, is ignored', async () => {
  const p = await file('v.mp4', thousand())
  for (const range of ['items=0-9', 'bytes=0-9,20-29']) {
    const r = await serve(p, range)
    expect([range, r.status, (await r.arrayBuffer()).byteLength]).toEqual([range, 200, 1000])
  }
})

test('an empty file serves with no body, and every range on it is 416', async () => {
  const p = await file('empty.txt', '')
  expect((await serve(p, null)).status).toBe(200)
  expect((await serve(p, 'bytes=0-0')).status).toBe(416)
})

test('markdown is plain text, and unlisted types (html, svg) are downloads that no browser runs', async () => {
  const md = await serve(await file('s.md', '# x'), null)
  expect(md.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  for (const name of ['x.html', 'x.svg', 'x.bin', 'noext']) {
    const r = await serve(await file(name, '<script>alert(1)</script>'), null)
    expect([name, r.headers.get('content-type'), r.headers.get('content-disposition')]).toEqual([
      name,
      'application/octet-stream',
      'attachment'
    ])
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
  }
})

test('a range number longer than 15 digits clamps to the file instead of failing', async () => {
  const p = await file('v.mp4', thousand())
  const r = await serve(p, 'bytes=0-99999999999999999999')
  expect([r.status, r.headers.get('content-range'), (await r.arrayBuffer()).byteLength]).toEqual([
    206,
    'bytes 0-999/1000',
    1000
  ])
  const suffix = await serve(p, 'bytes=-99999999999999999999')
  expect([suffix.status, suffix.headers.get('content-range')]).toEqual([206, 'bytes 0-999/1000'])
  const past = await serve(p, 'bytes=99999999999999999999-')
  expect([past.status, past.headers.get('content-range')]).toEqual([416, 'bytes */1000'])
})

test('serveFile closes the handle when the request is already aborted, and when it aborts mid-stream', async () => {
  const p = await file('big.mp4', new Uint8Array(4 * 1024 * 1024))
  const gone = await opened(p)
  const early = await serveFile(gone, null, AbortSignal.abort())
  expect([early.status, await early.text()]).toEqual([404, 'Not found'])
  expect(gone.handle.fd).toBe(-1)

  const live = await opened(p)
  const controller = new AbortController()
  const r = await serveFile(live, null, controller.signal)
  expect(r.status).toBe(200)
  controller.abort()
  for (let i = 0; i < 50 && live.handle.fd !== -1; i++) await Bun.sleep(20)
  expect(live.handle.fd).toBe(-1)
  await r.body?.cancel().catch(() => undefined)
})

async function occurrenceFixture() {
  const a = await seedMember(db)
  const b = await seedMember(db)
  const occurrenceId = a.ids.occurrences
  const dir = join(process.env.TM_DATA_ROOT!, 'occurrences', occurrenceId)
  const otherId = b.ids.occurrences
  const otherDir = join(process.env.TM_DATA_ROOT!, 'occurrences', otherId)
  await mkdir(join(dir, 'recording'), { recursive: true })
  await mkdir(otherDir, { recursive: true })
  return { scope: createScope(db, a.memberId), other: createScope(db, b.memberId), occurrenceId, dir, otherDir }
}

async function register(scope: ReturnType<typeof createScope>, occurrenceId: string, path: string) {
  await scope.insert(artefacts, { occurrenceId, kind: 'recording', path, bytes: 1 })
}

/** Opens, reads and closes, so a test can compare what `openMemberFile` handed over. */
async function readOpened(f: OpenedFile | null): Promise<string | null> {
  if (f === null) return null
  try {
    return await f.handle.readFile('utf8')
  } finally {
    await f.handle.close()
  }
}

test('openMemberFile opens a registered regular file, only for its owner', async () => {
  const { scope, other, occurrenceId, dir } = await occurrenceFixture()
  await writeFile(join(dir, 'recording', 'meeting.mp4'), 'video')
  await register(scope, occurrenceId, 'recording/meeting.mp4')
  expect(await readOpened(await openMemberFile(scope, occurrenceId, 'recording/meeting.mp4'))).toBe('video')
  expect(await openMemberFile(other, occurrenceId, 'recording/meeting.mp4')).toBeNull()
  expect(await openMemberFile(scope, occurrenceId, 'recording/other.mp4')).toBeNull()
  expect(await openMemberFile(scope, occurrenceId, '../../x')).toBeNull()
  expect(await openMemberFile(scope, occurrenceId, 'recording/meeting.mp4\0.png')).toBeNull()
})

test('openMemberFile refuses a symlink that points outside the occurrence directory', async () => {
  const { scope, occurrenceId, dir } = await occurrenceFixture()
  const secret = await file('secret.txt', 'not yours')
  await symlink(secret, join(dir, 'recording', 'leak.mp4'))
  await symlink(work, join(dir, 'linked-dir'))
  await register(scope, occurrenceId, 'recording/leak.mp4')
  await register(scope, occurrenceId, 'linked-dir/secret.txt')
  expect(await openMemberFile(scope, occurrenceId, 'recording/leak.mp4')).toBeNull()
  expect(await openMemberFile(scope, occurrenceId, 'linked-dir/secret.txt')).toBeNull()
})

test('openMemberFile refuses a final symlink even inside, a directory, a file that is gone and a FIFO', async () => {
  const { scope, occurrenceId, dir } = await occurrenceFixture()
  await writeFile(join(dir, 'recording', 'meeting.mkv'), 'video')
  await symlink(join(dir, 'recording', 'meeting.mkv'), join(dir, 'recording', 'alias.mkv'))
  await mkdir(join(dir, 'forms'), { recursive: true })
  execFileSync('mkfifo', [join(dir, 'recording', 'pipe')])
  for (const path of ['recording/alias.mkv', 'forms', 'recording/gone.mp4', 'recording/pipe'])
    await register(scope, occurrenceId, path)
  for (const path of ['recording/alias.mkv', 'forms', 'recording/gone.mp4', 'recording/pipe']) {
    expect([path, await openMemberFile(scope, occurrenceId, path)]).toEqual([path, null])
  }
})

test('openMemberFile and openOccurrenceFile refuse a hard link to a file outside the occurrence directory', async () => {
  const { scope, occurrenceId, dir } = await occurrenceFixture()
  const secret = await file('hard-secret.txt', 'not yours')
  await link(secret, join(dir, 'recording', 'hard.mp4'))
  await register(scope, occurrenceId, 'recording/hard.mp4')
  expect(await openMemberFile(scope, occurrenceId, 'recording/hard.mp4')).toBeNull()
  expect(await openOccurrenceFile(dir, 'recording/hard.mp4')).toBeNull()
  // Once the outside name is gone the file is the occurrence's own again.
  await unlink(secret)
  expect(await readOpened(await openOccurrenceFile(dir, 'recording/hard.mp4'))).toBe('not yours')
})

test('openMemberFile allows a path through a directory symlink that stays inside the occurrence', async () => {
  const { scope, occurrenceId, dir } = await occurrenceFixture()
  await mkdir(join(dir, 'real'), { recursive: true })
  await writeFile(join(dir, 'real', 'a.txt'), 'inside')
  await symlink(join(dir, 'real'), join(dir, 'alias'))
  await register(scope, occurrenceId, 'alias/a.txt')
  expect(await readOpened(await openMemberFile(scope, occurrenceId, 'alias/a.txt'))).toBe('inside')
})

test("a directory swapped for a symlink to another member's occurrence after the lookup is refused", async () => {
  const { scope, occurrenceId, dir, otherDir } = await occurrenceFixture()
  await mkdir(join(dir, 'sub'), { recursive: true })
  await writeFile(join(dir, 'sub', 'x.txt'), 'mine')
  await writeFile(join(otherDir, 'x.txt'), 'THEIRS')
  await register(scope, occurrenceId, 'sub/x.txt')
  // Without the swap the file opens.
  expect(await readOpened(await openMemberFile(scope, occurrenceId, 'sub/x.txt'))).toBe('mine')
  const swapped = await openMemberFile(scope, occurrenceId, 'sub/x.txt', {
    afterLookup: async () => {
      await rename(join(dir, 'sub'), join(dir, 'sub.old'))
      await symlink(otherDir, join(dir, 'sub'))
    }
  })
  expect(swapped).toBeNull()
})

test('a file swapped for a FIFO after the lookup does not hang and is refused', async () => {
  const { scope, occurrenceId, dir } = await occurrenceFixture()
  await writeFile(join(dir, 'recording', 'meeting.mp4'), 'video')
  await register(scope, occurrenceId, 'recording/meeting.mp4')
  const swapped = await openMemberFile(scope, occurrenceId, 'recording/meeting.mp4', {
    afterLookup: async () => {
      await unlink(join(dir, 'recording', 'meeting.mp4'))
      execFileSync('mkfifo', [join(dir, 'recording', 'meeting.mp4')])
    }
  })
  expect(swapped).toBeNull()
})
