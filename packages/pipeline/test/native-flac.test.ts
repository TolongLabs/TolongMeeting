import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { extractFlac, flacArgs } from '../src/native/flac'
import { probeAudio, toneMkv } from './native-fixtures'

let tmp: string
beforeAll(async () => {
  tmp = await mkdtemp(`${tmpdir()}/native-flac-`)
})
afterAll(() => rm(tmp, { recursive: true, force: true }))

async function occurrenceDir(name: string): Promise<string> {
  const dir = `${tmp}/${name}`
  await mkdir(`${dir}/recording`, { recursive: true })
  return dir
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false
  )

describe('flacArgs', () => {
  test('the recording is read as Matroska through the file protocol only, and nothing is overwritten', () => {
    const args = flacArgs('/d/in.mkv', '/w/audio.flac')
    expect(args.slice(0, 5)).toEqual(['-f', 'matroska', '-protocol_whitelist', 'file', '-i'])
    expect(args).not.toContain('-y')
    expect(args.at(-1)).toBe('/w/audio.flac')
  })
})

describe('extractFlac', () => {
  test('cuts a 48 kHz mono FLAC from a generated tone recording and reports its size and length', async () => {
    const dir = await occurrenceDir('tone')
    toneMkv(`${dir}/recording/meeting.mkv`, 3)
    const out = await extractFlac(dir)
    expect(out.path).toBe(`${dir}/audio.flac`)
    expect(probeAudio(out.path)).toMatchObject({ codec: 'flac', rate: 48000, channels: 1 })
    expect(out.durationSec).toBeCloseTo(3, 0)
    expect(out.bytes).toBe((await stat(out.path)).size)
    expect(out.bytes).toBeGreaterThan(1000)
    // The recording stays for the later remux, and no work directory is left.
    expect(await exists(`${dir}/recording/meeting.mkv`)).toBe(true)
    expect((await readdir(dir)).sort()).toEqual(['audio.flac', 'recording'])
  })

  test('joins the segments of a worker that stopped before it could, then cuts from the joined file', async () => {
    const dir = await occurrenceDir('segments')
    toneMkv(`${dir}/recording/attempt_1_seg_000.mkv`, 2)
    toneMkv(`${dir}/recording/attempt_1_seg_001.mkv`, 2)
    const out = await extractFlac(dir)
    expect(out.durationSec).toBeCloseTo(4, 0)
    expect(await exists(`${dir}/recording/meeting.mkv`)).toBe(true)
  })

  test('replaces a planted audio.flac link instead of writing through it', async () => {
    const dir = await occurrenceDir('planted')
    toneMkv(`${dir}/recording/meeting.mkv`, 2)
    const victim = `${tmp}/victim.txt`
    await writeFile(victim, 'keep me')
    await symlink(victim, `${dir}/audio.flac`)
    await extractFlac(dir)
    expect(await readFile(victim, 'utf8')).toBe('keep me')
    expect((await lstat(`${dir}/audio.flac`)).isFile()).toBe(true)
    expect(probeAudio(`${dir}/audio.flac`).codec).toBe('flac')
  })

  test('replaces an earlier audio.flac', async () => {
    const dir = await occurrenceDir('again')
    toneMkv(`${dir}/recording/meeting.mkv`, 2)
    await writeFile(`${dir}/audio.flac`, 'old')
    const out = await extractFlac(dir)
    expect(out.bytes).toBeGreaterThan(3)
  })

  test('a recording with no audio stream throws with the ffmpeg message and leaves nothing behind', async () => {
    const dir = await occurrenceDir('silent')
    toneMkv(`${dir}/recording/meeting.mkv`, 2, { audio: false })
    await expect(extractFlac(dir)).rejects.toThrow('ffmpeg failed')
    expect((await readdir(dir)).sort()).toEqual(['recording'])
  })

  test('a text file named meeting.mkv is refused before ffmpeg reads it', async () => {
    const dir = await occurrenceDir('text')
    await writeFile(`${dir}/recording/meeting.mkv`, '#EXTM3U\nfile:///etc/passwd\n')
    await expect(extractFlac(dir)).rejects.toThrow('not a Matroska file')
    expect(await exists(`${dir}/audio.flac`)).toBe(false)
  })

  test('a meeting.mkv that is a link is never followed', async () => {
    const dir = await occurrenceDir('link')
    toneMkv(`${tmp}/elsewhere.mkv`, 2)
    await symlink(`${tmp}/elsewhere.mkv`, `${dir}/recording/meeting.mkv`)
    await expect(extractFlac(dir)).rejects.toThrow('There is no recording')
    expect(await exists(`${dir}/audio.flac`)).toBe(false)
  })

  test('an occurrence directory that is a link is refused, even when it holds a recording', async () => {
    const real = await occurrenceDir('real')
    toneMkv(`${real}/recording/meeting.mkv`, 2)
    await symlink(real, `${tmp}/linked`)
    await expect(extractFlac(`${tmp}/linked`)).rejects.toThrow('not a plain directory')
    expect(await exists(`${real}/audio.flac`)).toBe(false)
  })

  test('a directory with no recording throws', async () => {
    const dir = await occurrenceDir('empty')
    await expect(extractFlac(dir)).rejects.toThrow('There is no recording')
  })

  test('an aborted signal stops the cut', async () => {
    const dir = await occurrenceDir('aborted')
    toneMkv(`${dir}/recording/meeting.mkv`, 2)
    await expect(extractFlac(dir, AbortSignal.abort(new Error('job expired')))).rejects.toThrow('job expired')
    expect(await exists(`${dir}/audio.flac`)).toBe(false)
  })
})
