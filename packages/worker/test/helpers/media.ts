import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface Probe {
  video: string
  width: number
  height: number
  fps: number
  audio: string
}

// The first video and audio stream of a media file, from ffprobe.
export async function probe(file: string): Promise<Probe> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file])
  const streams = (JSON.parse(stdout) as { streams: Record<string, string | number>[] }).streams
  const v = streams.find((s) => s.codec_type === 'video')
  const a = streams.find((s) => s.codec_type === 'audio')
  if (!v || !a) throw new Error(`${file}: expected a video and an audio stream`)
  const [num, den] = String(v.r_frame_rate).split('/').map(Number)
  return {
    video: String(v.codec_name),
    width: Number(v.width),
    height: Number(v.height),
    fps: num! / den!,
    audio: String(a.codec_name)
  }
}

export async function durationSeconds(file: string): Promise<number> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
  return Number(stdout)
}

// Seconds into a segment where its last frame ends, from the packets ffprobe finds (a killed file has no duration).
export async function lastPacketEnd(file: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'packet=pts_time,duration_time',
    '-of',
    'csv=p=0',
    file
  ])
  return Math.max(
    ...stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [pts, duration] = line.split(',').map(Number)
        return pts! + (duration || 0)
      })
  )
}

// Sends `signal` to the one ffmpeg whose command line names `dir`: how memory pressure kills the recorder's ffmpeg.
export function killFfmpeg(dir: string, signal: NodeJS.Signals = 'SIGKILL'): void {
  const pids = execFileSync('pgrep', ['-f', `ffmpeg.*${dir}`])
    .toString()
    .trim()
    .split('\n')
    .map(Number)
  if (pids.length !== 1) throw new Error(`expected one ffmpeg recording into ${dir}, found ${pids.length}`)
  process.kill(pids[0]!, signal)
}
