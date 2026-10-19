import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { remuxArgs, remuxRecording } from '../src/remux'

let tmp: string
beforeAll(async () => {
  tmp = await mkdtemp('/home/user/.cache/tm-tmp/remux-')
})
afterAll(() => rm(tmp, { recursive: true, force: true }))

/** A real Matroska clip of `seconds` seconds (video and audio) at `path`. */
function clip(path: string, seconds: number): void {
  execFileSync('ffmpeg', [
    ...['-hide_banner', '-loglevel', 'error', '-y'],
    ...['-f', 'lavfi', '-i', `testsrc=size=160x120:rate=10:duration=${seconds}`],
    ...['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`],
    ...['-c:v', 'libx264', '-c:a', 'aac', '-shortest', path]
  ])
}

const probe = (path: string): string =>
  execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]).toString().trim()

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false
  )

async function occurrenceDir(name: string): Promise<string> {
  const dir = `${tmp}/${name}`
  await mkdir(`${dir}/recording`, { recursive: true })
  return dir
}

describe('remuxArgs', () => {
  test('the recording is read as Matroska through the file protocol only and copied into a fast-start MP4', () => {
    expect(remuxArgs('/d/in.mkv', '/d/out.mp4')).toEqual([
      '-y',
      '-f',
      'matroska',
      '-protocol_whitelist',
      'file',
      '-i',
      '/d/in.mkv',
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      '/d/out.mp4'
    ])
  })
})

describe('remuxRecording', () => {
  test('makes the MP4 and deletes the MKV', async () => {
    const dir = await occurrenceDir('plain')
    clip(`${dir}/recording/meeting.mkv`, 3)
    expect(await remuxRecording(dir)).toBe(true)
    expect(await exists(`${dir}/recording/meeting.mp4`)).toBe(true)
    expect(await exists(`${dir}/recording/meeting.mkv`)).toBe(false)
    expect((await readdir(dir)).filter((n) => n.startsWith('.'))).toEqual([])
  })

  test('a second run changes nothing', async () => {
    const dir = await occurrenceDir('twice')
    clip(`${dir}/recording/meeting.mkv`, 2)
    await remuxRecording(dir)
    const before = await stat(`${dir}/recording/meeting.mp4`)
    expect(await remuxRecording(dir)).toBe(true)
    expect((await stat(`${dir}/recording/meeting.mp4`)).mtimeMs).toBe(before.mtimeMs)
  })

  test('segments a worker did not join are joined first', async () => {
    const dir = await occurrenceDir('segments')
    clip(`${dir}/recording/attempt_1_seg_001.mkv`, 2)
    clip(`${dir}/recording/attempt_1_seg_002.mkv`, 2)
    await remuxRecording(dir)
    expect(await exists(`${dir}/recording/meeting.mp4`)).toBe(true)
    expect(await exists(`${dir}/recording/meeting.mkv`)).toBe(false)
    expect((await readdir(dir)).filter((n) => n.startsWith('.'))).toEqual([])
    const seconds = Number(
      execFileSync('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'csv=p=0',
        `${dir}/recording/meeting.mp4`
      ])
        .toString()
        .trim()
    )
    expect(seconds).toBeGreaterThan(3)
  })

  test('a directory with no recording is left alone', async () => {
    const dir = await occurrenceDir('empty')
    expect(await remuxRecording(dir)).toBe(false)
    expect(await readdir(`${dir}/recording`)).toEqual([])
    expect(await remuxRecording(`${tmp}/no-such-dir`)).toBe(false)
  })

  test('a recording ffmpeg cannot read is kept and the error is thrown', async () => {
    const dir = await occurrenceDir('broken')
    await Bun.write(`${dir}/recording/meeting.mkv`, 'not a video')
    await expect(remuxRecording(dir)).rejects.toThrow('ffmpeg failed')
    expect(await exists(`${dir}/recording/meeting.mkv`)).toBe(true)
    expect(await exists(`${dir}/recording/meeting.mp4`)).toBe(false)
  })

  test('a stale or partial meeting.mp4 is replaced', async () => {
    const dir = await occurrenceDir('stale')
    clip(`${dir}/recording/meeting.mkv`, 3)
    await writeFile(`${dir}/recording/meeting.mp4`, 'half a file')
    expect(await remuxRecording(dir)).toBe(true)
    expect(Number(probe(`${dir}/recording/meeting.mp4`))).toBeGreaterThan(2)
  })

  test('an MP4 from an earlier run that is not a video is reported as no recording', async () => {
    const dir = await occurrenceDir('bad-mp4')
    await writeFile(`${dir}/recording/meeting.mp4`, 'not a video')
    expect(await remuxRecording(dir)).toBe(false)
  })

  test('a symlinked segment is never read: its target is not in the output', async () => {
    const dir = await occurrenceDir('seg-link')
    const outside = `${tmp}/outside-seg.mkv`
    clip(outside, 5)
    clip(`${dir}/recording/attempt_1_seg_001.mkv`, 2)
    await symlink(outside, `${dir}/recording/attempt_1_seg_002.mkv`)
    expect(await remuxRecording(dir)).toBe(true)
    const seconds = Number(probe(`${dir}/recording/meeting.mp4`))
    expect(seconds).toBeGreaterThan(1)
    expect(seconds).toBeLessThan(4)
  })

  test('a symlinked meeting.mp4 is replaced by a real file and its target is untouched', async () => {
    const dir = await occurrenceDir('mp4-link')
    const outside = `${tmp}/outside.mp4`
    await writeFile(outside, 'precious')
    clip(`${dir}/recording/meeting.mkv`, 2)
    await symlink(outside, `${dir}/recording/meeting.mp4`)
    expect(await remuxRecording(dir)).toBe(true)
    expect(await readFile(outside, 'utf8')).toBe('precious')
    expect((await lstat(`${dir}/recording/meeting.mp4`)).isFile()).toBe(true)
  })

  test('a symlinked meeting.mkv is not read', async () => {
    const dir = await occurrenceDir('mkv-link')
    const outside = `${tmp}/outside-mkv.mkv`
    clip(outside, 2)
    await symlink(outside, `${dir}/recording/meeting.mkv`)
    expect(await remuxRecording(dir)).toBe(false)
    expect(await exists(`${dir}/recording/meeting.mp4`)).toBe(false)
  })

  test('a symlinked recording directory is skipped', async () => {
    const dir = `${tmp}/dir-link`
    const outside = `${tmp}/outside-recording`
    await mkdir(outside, { recursive: true })
    await mkdir(dir, { recursive: true })
    clip(`${outside}/meeting.mkv`, 2)
    await symlink(outside, `${dir}/recording`)
    expect(await remuxRecording(dir)).toBe(false)
    expect(await readdir(outside)).toEqual(['meeting.mkv'])
  })

  test('a text file named like a segment is not read as a playlist', async () => {
    const dir = await occurrenceDir('text-seg')
    const secret = `${tmp}/secret.txt`
    await writeFile(secret, 'top secret')
    await writeFile(`${dir}/recording/attempt_1_seg_001.mkv`, `#EXTM3U\n#EXTINF:1,\nfile://${secret}\n#EXT-X-ENDLIST\n`)
    await writeFile(`${dir}/recording/attempt_1_seg_002.mkv`, `ffconcat version 1.0\nfile '${secret}'\n`)
    expect(await remuxRecording(dir)).toBe(false)
    expect(await exists(`${dir}/recording/meeting.mp4`)).toBe(false)
  })

  test('a playlist named meeting.mkv is not read as one', async () => {
    const dir = await occurrenceDir('text-mkv')
    const secret = `${tmp}/secret2.txt`
    await writeFile(secret, 'top secret')
    await writeFile(`${dir}/recording/meeting.mkv`, `ffconcat version 1.0\nfile '${secret}'\n`)
    await expect(remuxRecording(dir)).rejects.toThrow('ffmpeg failed')
    expect(await exists(`${dir}/recording/meeting.mp4`)).toBe(false)
  })
})
