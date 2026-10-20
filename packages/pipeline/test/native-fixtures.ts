import { execFileSync } from 'node:child_process'

/** A real Matroska recording of `seconds` seconds at `path`: a 440 Hz tone, with a test picture unless `audio` is false. */
export function toneMkv(path: string, seconds: number, opts: { audio?: boolean; video?: boolean } = {}): void {
  const { audio = true, video = true } = opts
  execFileSync('ffmpeg', [
    ...['-hide_banner', '-loglevel', 'error', '-y'],
    ...(video ? ['-f', 'lavfi', '-i', `testsrc=size=160x120:rate=10:duration=${seconds}`] : []),
    ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${seconds}`] : []),
    ...(video ? ['-c:v', 'libx264'] : []),
    ...(audio ? ['-c:a', 'aac'] : []),
    ...['-f', 'matroska', path]
  ])
}

/** `{ codec, rate, channels, duration }` of the first audio stream of `path`, as ffprobe reports them. */
export function probeAudio(path: string): { codec: string; rate: number; channels: number; duration: number } {
  const out = JSON.parse(
    execFileSync('ffprobe', [
      ...['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels'],
      ...['-show_entries', 'format=duration', '-of', 'json', path]
    ]).toString()
  ) as { streams: { codec_name: string; sample_rate: string; channels: number }[]; format: { duration: string } }
  const stream = out.streams[0]!
  return {
    codec: stream.codec_name,
    rate: Number(stream.sample_rate),
    channels: stream.channels,
    duration: Number(out.format.duration)
  }
}
