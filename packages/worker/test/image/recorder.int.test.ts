// Runs in the worker image only (needs Xvfb, openbox and the tm_sink PulseAudio sink):
//   docker run --rm --shm-size=2g tm-worker:dev unit packages/worker/test/image/recorder.int.test.ts
import { expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startScreen } from '../../src/display/screen'
import { startRecorder } from '../../src/recorder/recorder'
import { killFfmpeg, probe } from '../helpers/media'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test.skipIf(process.env.TM_IN_IMAGE !== '1')(
  'records 1920x1080 at 15 fps with AAC from the sink, survives an ffmpeg kill, logs the gap',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tm-recorder-'))
    const screen = await startScreen()
    try {
      const gaps: { from: Date; to: Date }[] = []
      const r = await startRecorder(screen, dir, 1, { segmentSeconds: 5 })
      r.onGap((g) => gaps.push(g))
      await sleep(6000)
      killFfmpeg(dir)
      await sleep(8000)
      await r.stop()
      const segs = (await readdir(dir)).filter((f) => f.endsWith('.mkv')).sort()
      expect(segs[0]).toBe('attempt_1_seg_000.mkv')
      expect(new Set(segs).size).toBe(segs.length)
      expect(await probe(join(dir, segs[0]!))).toMatchObject({
        video: 'h264',
        width: 1920,
        height: 1080,
        fps: 15,
        audio: 'aac'
      })
      expect(gaps.length).toBe(1)
      // restart delay 1 s + ffmpeg start-up + the 1 s muxer flush; 3 s failed 2 of 4 runs on a loaded host
      expect(+gaps[0]!.to - +gaps[0]!.from).toBeLessThan(5000)
      expect(JSON.parse(await readFile(join(dir, 'attempts.json'), 'utf8'))[0].stoppedAt).toBeString()
    } finally {
      await screen.stop()
      await rm(dir, { recursive: true, force: true })
    }
  },
  60_000
)
