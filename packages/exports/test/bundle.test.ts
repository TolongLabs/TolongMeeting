import { execFileSync } from 'node:child_process'
import { afterEach, expect, test } from 'bun:test'
import { mkdir, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadBundle, MAX_BUNDLE_BYTES, MAX_IMAGE_BYTES, MAX_SLIDES, MAX_TEXT_BYTES } from '../src/bundle'
import { copyFixture, fixture, removeCopies } from './fixture'

afterEach(removeCopies)

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const SUMMARY = '2026-10-20 1400 Data Mining.md'

test('loads the set in order', async () => {
  const b = await loadBundle(fixture)
  expect(b.title).toBe('2026-10-20 1400 Data Mining')
  expect(b.summaryFile).toBe(SUMMARY)
  expect(b.dirName).toBe('2026-10-20-1400-data-mining')
  expect(b.files.map((f) => f.path)).toEqual([
    SUMMARY,
    'transcript.md',
    'slides.md',
    'chat.md',
    'slides/01.webp',
    'slides/02.webp'
  ])
})

test('rewrites the slide image links of slides.md only', async () => {
  const b = await loadBundle(fixture)
  const slides = text(b.files.find((f) => f.path === 'slides.md')!.bytes)
  expect(slides).toContain('![Slide 01: Welcome](slides/01.webp)')
  expect(slides).toContain('![Slide 02: Agenda](slides/02.webp)')
  expect(slides).not.toContain('../slides/')
  const transcript = b.files.find((f) => f.path === 'transcript.md')!
  expect(text(transcript.bytes)).toBe(await Bun.file(join(fixture, 'out/transcript.md')).text())
})

test('keeps files byte for byte and in memory', async () => {
  const dir = await copyFixture()
  const b = await loadBundle(dir)
  await rm(dir, { recursive: true })
  const image = b.files.find((f) => f.path === 'slides/01.webp')!
  expect(Buffer.from(image.bytes).equals(await Bun.file(join(fixture, 'slides/01.webp')).bytes())).toBe(true)
  expect(text(b.files.find((f) => f.path === 'chat.md')!.bytes)).toContain('谢谢')
})

test('skips missing optional files', async () => {
  const dir = await copyFixture()
  await rm(join(dir, 'out/chat.md'))
  await rm(join(dir, 'slides'), { recursive: true })
  expect((await loadBundle(dir)).files.map((f) => f.path)).toEqual([SUMMARY, 'transcript.md', 'slides.md'])
})

test('ignores slide files that do not match NN.webp', async () => {
  const dir = await copyFixture()
  await writeFile(join(dir, 'slides/notes.webp'), 'x')
  await writeFile(join(dir, 'slides/1.webp'), 'x')
  expect((await loadBundle(dir)).files.map((f) => f.path).filter((p) => p.startsWith('slides/'))).toEqual([
    'slides/01.webp',
    'slides/02.webp'
  ])
})

test('no summary is not_ready', async () => {
  const dir = await copyFixture()
  await rm(join(dir, 'out', SUMMARY))
  await expect(loadBundle(dir)).rejects.toMatchObject({
    code: 'not_ready',
    message: 'This meeting has no summary yet.'
  })
})

test('no out directory is not_ready', async () => {
  const dir = await copyFixture()
  await rm(join(dir, 'out'), { recursive: true })
  await expect(loadBundle(dir)).rejects.toMatchObject({ code: 'not_ready' })
})

test('the newest summary wins', async () => {
  const dir = await copyFixture()
  await writeFile(join(dir, 'out/2026-10-20 1400 Data Mining Renamed.md'), 'x')
  await utimes(join(dir, 'out', SUMMARY), new Date('2026-10-20'), new Date('2026-10-20'))
  expect((await loadBundle(dir)).title).toBe('2026-10-20 1400 Data Mining Renamed')
})

test('refuses a symlinked file in out/', async () => {
  const dir = await copyFixture()
  const outside = await copyFixture()
  await rm(join(dir, 'out/transcript.md'))
  await symlink(join(outside, 'out/transcript.md'), join(dir, 'out/transcript.md'))
  await expect(loadBundle(dir)).rejects.toMatchObject({ code: 'failed' })
})

test('refuses a symlinked slides directory that points outside', async () => {
  const dir = await copyFixture()
  const outside = await copyFixture()
  await rm(join(dir, 'slides'), { recursive: true })
  await symlink(join(outside, 'slides'), join(dir, 'slides'))
  await expect(loadBundle(dir)).rejects.toMatchObject({ code: 'failed' })
})

test('refuses a symlinked out directory that points outside', async () => {
  const dir = await copyFixture()
  const outside = await copyFixture()
  await rm(join(dir, 'out'), { recursive: true })
  await symlink(join(outside, 'out'), join(dir, 'out'))
  await expect(loadBundle(dir)).rejects.toMatchObject({ code: 'failed' })
})

test('a symlink named like a summary is never the summary', async () => {
  const dir = await copyFixture()
  const outside = await copyFixture()
  await symlink(join(outside, 'out', SUMMARY), join(dir, 'out/zzz.md'))
  expect((await loadBundle(dir)).summaryFile).toBe(SUMMARY)
})

test('refuses a file over the size cap', async () => {
  const dir = await copyFixture()
  await writeFile(join(dir, 'out/chat.md'), Buffer.alloc(8 * 1024 * 1024 + 1, 'a'))
  await expect(loadBundle(dir)).rejects.toMatchObject({ code: 'failed' })
})

test('a directory named like a slide is not read', async () => {
  const dir = await copyFixture()
  await mkdir(join(dir, 'slides/03.webp'))
  expect((await loadBundle(dir)).files.map((f) => f.path)).not.toContain('slides/03.webp')
})

test('a directory that is gone is meeting_deleted', async () => {
  const dir = await copyFixture()
  await rm(dir, { recursive: true })
  await expect(loadBundle(dir)).rejects.toMatchObject({
    code: 'meeting_deleted',
    message: 'This meeting has been deleted from TolongMeeting.'
  })
})

test('a FIFO named like a pipeline file is refused without blocking', async () => {
  const dir = await copyFixture()
  await rm(join(dir, 'out/chat.md'))
  execFileSync('mkfifo', [join(dir, 'out/chat.md')])
  await expect(loadBundle(dir)).rejects.toMatchObject({
    code: 'failed',
    message: expect.stringContaining('regular file')
  })
})

test('a FIFO named like a slide is never listed or opened', async () => {
  const dir = await copyFixture()
  execFileSync('mkfifo', [join(dir, 'slides/03.webp')])
  expect((await loadBundle(dir)).files.map((f) => f.path)).not.toContain('slides/03.webp')
})

test('a text file of exactly the cap is read and one byte more is refused', async () => {
  const dir = await copyFixture()
  await writeFile(join(dir, 'out/chat.md'), Buffer.alloc(MAX_TEXT_BYTES, 'a'))
  const chat = (await loadBundle(dir)).files.find((f) => f.path === 'chat.md')!
  expect(chat.bytes.length).toBe(MAX_TEXT_BYTES)
  await writeFile(join(dir, 'out/chat.md'), Buffer.alloc(MAX_TEXT_BYTES + 1, 'a'))
  await expect(loadBundle(dir)).rejects.toMatchObject({ code: 'failed' })
})

test('an image over the image cap is refused', async () => {
  const dir = await copyFixture()
  await truncate(join(dir, 'slides/01.webp'), MAX_IMAGE_BYTES + 1)
  await expect(loadBundle(dir)).rejects.toMatchObject({ code: 'failed', message: expect.stringContaining('16 MB') })
})

test('more than the slide cap is refused before any is read', async () => {
  const dir = await copyFixture()
  for (let i = 3; i <= MAX_SLIDES + 1; i++) await writeFile(join(dir, `slides/${String(i).padStart(3, '0')}.webp`), 'x')
  await expect(loadBundle(dir)).rejects.toMatchObject({ code: 'failed', message: expect.stringContaining('slides') })
})

test('exactly the slide cap is read', async () => {
  const dir = await copyFixture()
  await rm(join(dir, 'slides/02.webp'))
  for (let i = 2; i <= MAX_SLIDES; i++) await writeFile(join(dir, `slides/${String(i).padStart(3, '0')}.webp`), 'x')
  // 01.webp (fixture) is two digits, 002..500 are three: 500 files.
  expect((await loadBundle(dir)).files.filter((f) => f.path.startsWith('slides/'))).toHaveLength(MAX_SLIDES)
})

test('a meeting whose files add up to more than the total cap is refused', async () => {
  const dir = await copyFixture()
  // Sparse files: cheap on disk, each read as a full 16 MB of zeros.
  const need = Math.floor(MAX_BUNDLE_BYTES / MAX_IMAGE_BYTES) + 1
  for (let i = 0; i < need; i++) {
    const file = join(dir, `slides/${String(i + 10)}.webp`)
    await writeFile(file, '')
    await truncate(file, MAX_IMAGE_BYTES)
  }
  await expect(loadBundle(dir)).rejects.toMatchObject({
    code: 'failed',
    message: 'This meeting is too large to export.'
  })
}, 60_000)
