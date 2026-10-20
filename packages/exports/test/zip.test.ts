import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, readdir, rename, rm, stat, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { unzipSync } from 'fflate'
import { loadBundle } from '../src/bundle'
import { writeDownload } from '../src/targets/download'
import { zipBundle, zipTarget } from '../src/targets/zip'
import { ExportError } from '../src/types'
import { copyFixture, fixture, removeCopies } from './fixture'
import { removeTestContexts, testContext } from './context'

afterEach(async () => {
  await removeCopies()
  await removeTestContexts()
})

const FOLDER = '2026-10-20-1400-data-mining'

test('zip holds the set under one folder', async () => {
  const entries = unzipSync(zipBundle(await loadBundle(fixture)))
  expect(Object.keys(entries)).toEqual([
    `${FOLDER}/summary.md`,
    `${FOLDER}/transcript.md`,
    `${FOLDER}/slides.md`,
    `${FOLDER}/chat.md`,
    `${FOLDER}/slides/01.webp`,
    `${FOLDER}/slides/02.webp`
  ])
  expect(entries[`${FOLDER}/slides/01.webp`]).toEqual(new Uint8Array(await readFile(join(fixture, 'slides/01.webp'))))
})

test('a summary file name never reaches the zip entry names', async () => {
  const dir = await copyFixture()
  await rename(join(dir, 'out', '2026-10-20 1400 Data Mining.md'), join(dir, 'out', '..\\..\\evil.md'))
  const bundle = await loadBundle(dir)
  const names = Object.keys(unzipSync(zipBundle(bundle)))
  expect(names[0]).toBe('evil/summary.md')
  for (const name of names) {
    expect(name.startsWith('evil/')).toBe(true)
    expect(name).not.toContain('\\')
    expect(name).not.toContain('..')
  }
})

test('zipBundle refuses a path it did not choose or a folder name that is not a slug', async () => {
  const bytes = new Uint8Array([1])
  expect(() =>
    zipBundle({ title: 't', dirName: 'ok', summaryFile: 't.md', files: [{ path: '../escape.md', bytes }] })
  ).toThrow(ExportError)
  expect(() => zipBundle({ title: 't', dirName: '../x', summaryFile: 't.md', files: [] })).toThrow(ExportError)
})

test('zipTarget writes <exportId>.zip in outDir', async () => {
  const ctx = testContext({ exportId: 'exp-1' })
  const r = await zipTarget.run(await loadBundle(fixture), ctx)
  expect(r).toEqual({
    url: null,
    filePath: join(ctx.outDir, 'exp-1.zip'),
    note: null
  })
  expect((await stat(r.filePath!)).size).toBeGreaterThan(0)
  expect(unzipSync(await readFile(r.filePath!))[`${FOLDER}/summary.md`]).toBeDefined()
  expect(await readdir(ctx.outDir)).toEqual(['exp-1.zip'])
})

test('a deleted meeting directory is never recreated', async () => {
  const ctx = testContext()
  await rm(dirname(ctx.outDir), { recursive: true })
  await expect(writeDownload(ctx, 'zip', new Uint8Array([1]))).rejects.toMatchObject({ code: 'meeting_deleted' })
  expect(existsSync(dirname(ctx.outDir))).toBe(false)
})

test('an export folder that is a symlink is refused', async () => {
  const ctx = testContext()
  await symlink(dirname(ctx.outDir), ctx.outDir)
  await expect(writeDownload(ctx, 'zip', new Uint8Array([1]))).rejects.toMatchObject({ code: 'failed' })
})

test('an export id that is not a plain token is refused', async () => {
  const ctx = testContext({ exportId: '../escape' })
  await expect(writeDownload(ctx, 'zip', new Uint8Array([1]))).rejects.toMatchObject({ code: 'failed' })
  expect(existsSync(join(dirname(ctx.outDir), 'escape.zip'))).toBe(false)
})
