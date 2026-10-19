import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
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
  test('the recording is copied into a fast-start MP4', () => {
    expect(remuxArgs('/d')).toEqual([
      '-y',
      '-i',
      '/d/recording/meeting.mkv',
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      '/d/recording/meeting.mp4'
    ])
  })
})

describe('remuxRecording', () => {
  test('makes the MP4 and deletes the MKV', async () => {
    const dir = await occurrenceDir('plain')
    clip(`${dir}/recording/meeting.mkv`, 3)
    await remuxRecording(dir)
    expect(await exists(`${dir}/recording/meeting.mp4`)).toBe(true)
    expect(await exists(`${dir}/recording/meeting.mkv`)).toBe(false)
  })

  test('a second run changes nothing', async () => {
    const dir = await occurrenceDir('twice')
    clip(`${dir}/recording/meeting.mkv`, 2)
    await remuxRecording(dir)
    const before = await stat(`${dir}/recording/meeting.mp4`)
    await remuxRecording(dir)
    expect((await stat(`${dir}/recording/meeting.mp4`)).mtimeMs).toBe(before.mtimeMs)
  })

  test('segments a worker did not join are joined first', async () => {
    const dir = await occurrenceDir('segments')
    clip(`${dir}/recording/attempt_1_seg_001.mkv`, 2)
    clip(`${dir}/recording/attempt_1_seg_002.mkv`, 2)
    await remuxRecording(dir)
    expect(await exists(`${dir}/recording/meeting.mp4`)).toBe(true)
    expect(await exists(`${dir}/recording/meeting.mkv`)).toBe(false)
    expect((await readdir(`${dir}/recording`)).filter((n) => n.startsWith('.join-'))).toEqual([])
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
    await remuxRecording(dir)
    expect(await readdir(`${dir}/recording`)).toEqual([])
    await remuxRecording(`${tmp}/no-such-dir`)
  })

  test('a recording ffmpeg cannot read is kept and the error is thrown', async () => {
    const dir = await occurrenceDir('broken')
    await Bun.write(`${dir}/recording/meeting.mkv`, 'not a video')
    await expect(remuxRecording(dir)).rejects.toThrow('ffmpeg failed')
    expect(await exists(`${dir}/recording/meeting.mkv`)).toBe(true)
    expect(await exists(`${dir}/recording/meeting.mp4`)).toBe(false)
  })
})
