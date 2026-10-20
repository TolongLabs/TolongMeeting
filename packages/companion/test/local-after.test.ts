import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LocalRunPayload } from '@tm/core'
import { flacArgs as serverFlacArgs } from '../../pipeline/src/native/flac'
import {
  ffmpegFlacArgs,
  finishLocalRun,
  flacArgs,
  IncompleteUploadError,
  localReporter,
  occurrenceDir,
  resumeOutcome,
  type AfterDeps,
  type LocalJob
} from '../src/local/after'
import { checkRunArgs, DockerError, UnsafeDockerInput, type DockerLike } from '../src/local/docker'
import type { SpawnLike } from '../src/jobs/whisper'
import { defaultSettings } from '../src/settings'
import { fakeServer, type FakeServer } from './fake-upload-server'

const REF = 'ghcr.io/tl/tolongmeeting-worker:1.0.0'
const PREFIX = 'ghcr.io/tl/'
const OCC = '11111111-1111-4111-8111-111111111111'

const roots: string[] = []
async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tm-after-'))
  roots.push(dir)
  return dir
}
afterAll(() => Promise.all(roots.map((d) => rm(d, { recursive: true, force: true }))))

function localJob(transcription: 'live' | 'native'): LocalJob {
  const payload: LocalRunPayload = {
    occurrenceId: OCC,
    identityId: 'u1',
    identityName: 'Ali',
    image: REF,
    job: {
      occurrenceId: OCC,
      attempt: 1,
      entry: {
        name: 'Data Mining',
        type: 'lecture',
        start: '2026-10-21T09:00:00+08:00',
        end: '2026-10-21T10:00:00+08:00',
        timeZone: 'Asia/Kuala_Lumpur',
        link: { kind: 'fixed', url: 'https://zoom.us/j/123456789' },
        trustedSenders: [],
        transcription,
        formDetails: {},
        attendanceKeywords: []
      },
      identity: { id: 'u1', name: 'Ali', zoomGuestName: 'Ali', formProviders: [], organisation: null },
      member: { id: 'm1', displayName: 'Ali', mentionNames: [] },
      ai: {
        baseUrl: 'https://ai.example.com/v1',
        asrUrl: 'wss://asr.example.com/ws',
        models: { summary: 's', vision: 'v', formMatch: 'f', asr: 'a' }
      },
      ntfy: { url: 'https://ntfy.example.com', topic: 'tm-topic' },
      dataDir: `/tm/data/occurrences/${OCC}`,
      profileDir: '/tm/profiles/u1/work'
    }
  }
  return { id: 'j1', state: 'claimed', occurrenceId: OCC, attempts: 1, kind: 'local_run', payload }
}

async function ffmpeg(args: string[]): Promise<number> {
  const p = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', ...args], {
    stdout: 'ignore',
    stderr: 'ignore'
  })
  return p.exited
}
async function probe(file: string): Promise<{ codec: string; channels: number; rate: number }> {
  const p = Bun.spawn(
    [
      'ffprobe',
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=codec_name,channels,sample_rate',
      '-of',
      'json',
      file
    ],
    { stdout: 'pipe', stderr: 'ignore' }
  )
  const out = JSON.parse(await new Response(p.stdout).text()) as {
    streams: { codec_name: string; channels: number; sample_rate: string }[]
  }
  const s = out.streams[0]!
  return { codec: s.codec_name, channels: s.channels, rate: Number(s.sample_rate) }
}

let sample: Buffer = Buffer.from('placeholder recording sample for environments without ffmpeg')
const hasFfmpeg = Bun.which('ffmpeg') !== null
beforeAll(async () => {
  if (!hasFfmpeg) return
  // Two seconds of stereo 44.1 kHz sound and a small picture, as a Matroska file (not what the FLAC must look like).
  const file = join(await tmp(), 'sample.mkv')
  const code = await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=44100:duration=2',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=64x64:r=5:d=2',
    '-ac',
    '2',
    '-c:a',
    'pcm_s16le',
    '-c:v',
    'mpeg4',
    file
  ])
  if (code !== 0) throw new Error('ffmpeg could not make the sample recording')
  sample = Buffer.from(await readFile(file))
})

describe('flacArgs', () => {
  const o = { image: REF, imagePrefix: PREFIX, dataDir: '/home/u/data', occurrenceId: 'o1' }
  const occ = occurrenceDir('/home/u/data', 'o1')

  test('is a docker run that the app allows: offline, no capabilities, ffmpeg as the entrypoint', () => {
    const args = flacArgs(o)
    expect(() => checkRunArgs(args, PREFIX, ['/home/u/data'])).not.toThrow()
    expect(args.slice(0, 2)).toEqual(['run', '-d'])
    expect(args).not.toContain('--rm')
    expect(args).toContain('none')
    expect(args.slice(args.indexOf('--entrypoint'), args.indexOf('--entrypoint') + 3)).toEqual([
      '--entrypoint',
      'ffmpeg',
      REF
    ])
    expect(args.at(-1)).toBe('/tm/data/audio.flac')
    expect(args).not.toContain('-y')
  })

  test('mounts only that occurrence folder, never the data root', () => {
    const args = flacArgs(o)
    expect(args.filter((a, i) => args[i - 1] === '-v')).toEqual([`${occ}:/tm/data`])
    expect(args.join(' ')).not.toContain('/home/u/data:')
    expect(() => checkRunArgs(args, PREFIX, [occ])).not.toThrow()
  })

  test('refuses an image outside the prefix, on a / boundary (R15)', () => {
    expect(() => flacArgs({ ...o, image: 'ghcr.io/tl-evil/worker:1' })).toThrow(UnsafeDockerInput)
    expect(() => flacArgs({ ...o, image: 'ghcr.io/evil/worker:1' })).toThrow(UnsafeDockerInput)
    expect(() => flacArgs({ ...o, imagePrefix: 'ghcr.io/tl' })).not.toThrow()
  })

  test('uses the same ffmpeg flags as the website (pipeline flacArgs)', () => {
    const input = '/tm/data/recording/meeting.mkv'
    const output = '/tm/data/audio.flac'
    const mine = ffmpegFlacArgs(input, output)
    const theirs = serverFlacArgs(input, output)
    // The website's `tool` puts these three in front of every ffmpeg call; the rest is `flacArgs` itself.
    expect(mine).toEqual(['-hide_banner', '-loglevel', 'error', '-nostdin', ...theirs])
    expect(flacArgs(o).slice(-mine.length)).toEqual(mine)
  })

  test.skipIf(!hasFfmpeg)('real ffmpeg cuts a 48 kHz mono FLAC from those flags', async () => {
    const dir = await tmp()
    await mkdir(join(dir, 'recording'))
    await writeFile(join(dir, 'recording', 'meeting.mkv'), sample)
    const code = await ffmpeg(ffmpegFlacArgs(join(dir, 'recording', 'meeting.mkv'), join(dir, 'audio.flac')).slice(4))
    expect(code).toBe(0)
    expect(await probe(join(dir, 'audio.flac'))).toEqual({ codec: 'flac', channels: 1, rate: 48000 })
  })
})

// --- finishLocalRun ---

interface Rig {
  d: AfterDeps
  server: FakeServer
  dataDir: string
  occ: string
  log: string[]
  /** The docker calls the cut made, in order. */
  calls: string[]
  whisperRuns: () => number
  dockerRuns: () => number
}

const servers: FakeServer[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.stop()
})

async function rig(
  o: {
    files?: [string, string | Buffer][]
    whisper?: 'ok' | 'fail'
    docker?: 'ok' | 'fail' | 'hang'
    flacTimeoutMs?: number
    retryMs?: number
    signal?: AbortSignal
    chunkBytes?: number
    server?: FakeServer
  } = {}
): Promise<Rig> {
  const dataDir = await tmp()
  const occ = join(dataDir, 'occurrences', OCC)
  for (const [rel, content] of o.files ?? [
    ['events.jsonl', '{"type":"state"}\n'],
    ['recording/meeting.mkv', sample]
  ]) {
    await mkdir(join(occ, rel, '..'), { recursive: true })
    await writeFile(join(occ, rel), content)
  }
  const server = o.server ?? fakeServer()
  servers.push(server)
  let whisper = 0
  let docker = 0
  const settings = defaultSettings(dataDir, server.url)
  settings.whisper.cwd = dataDir
  settings.whisper.command = 'fake-whisper {audio} {model} {outDir}'

  const calls: string[] = []
  let cut: Promise<number> = Promise.resolve(0)
  const run = async (args: string[]): Promise<string> => {
    checkRunArgs(args, PREFIX, [dataDir])
    docker++
    calls.push('run')
    server.log.push('docker flac')
    if (o.docker === 'fail') throw new DockerError('run', 'exit', 1)
    // Run the real ffmpeg on the host files the container would see: the occurrence folder is /tm/data.
    const image = args.indexOf(REF)
    const map = (a: string) => a.replace('/tm/data/', `${occ}/`)
    cut = ffmpeg(
      args
        .slice(image + 1)
        .slice(4)
        .map(map)
    )
    return 'container-id'
  }
  const dockerFake: DockerLike = {
    run,
    rm: async () => void calls.push('rm'),
    info: async () => null,
    imagePresent: async () => true,
    pull: async () => true,
    wait: async () => (o.docker === 'hang' ? new Promise<number>(() => {}) : cut),
    logs: async () => '',
    stop: async () => {},
    volumeRm: async () => {},
    volumes: async () => [],
    running: async () => [],
    port: async () => null,
    ensureNetwork: async () => {}
  }
  const spawn: SpawnLike = (_cmd, args) => {
    whisper++
    server.log.push('whisper')
    const outDir = args[2]!
    if (o.whisper === 'fail') {
      return { exited: Promise.resolve(3), stdout: () => '', stderrTail: () => 'model not found', kill: () => {} }
    }
    writeFileSync(join(outDir, 'audio.txt'), 'hello world')
    writeFileSync(join(outDir, 'audio.srt'), '1\n00:00:00,000 --> 00:00:01,500\nhello world\n')
    writeFileSync(
      join(outDir, 'audio.json'),
      JSON.stringify({ segments: [{ start: 0, end: 1.5, text: 'hello world' }] })
    )
    return { exited: Promise.resolve(0), stdout: () => '', stderrTail: () => '', kill: () => {} }
  }
  const api = server.api()
  const d: AfterDeps = {
    api,
    docker: dockerFake,
    imagePrefix: PREFIX,
    flacTimeoutMs: o.flacTimeoutMs,
    settings: () => settings,
    spawn,
    report: localReporter(api, localJob('native'), dataDir),
    retryMs: o.retryMs ?? 10,
    signal: o.signal,
    chunkBytes: o.chunkBytes
  }
  return { d, server, dataDir, occ, log: server.log, calls, whisperRuns: () => whisper, dockerRuns: () => docker }
}

describe('finishLocalRun', () => {
  test('native: upload, cut the FLAC, transcribe on the PC, upload the transcript, complete, then clean up', async () => {
    const { d, dataDir, occ, log, server } = await rig()
    await finishLocalRun(d, localJob('native'), dataDir, 'ended')
    expect(log).toEqual([
      'report uploading',
      'upload events.jsonl',
      'upload recording/meeting.mkv',
      'report transcribing',
      'docker flac',
      'whisper',
      'upload transcript/native/audio.txt',
      'upload transcript/native/audio.srt',
      'upload transcript/native/audio.json',
      'complete'
    ])
    expect(server.files.get('recording/meeting.mkv')?.equals(sample)).toBe(true)
    expect(server.files.get('transcript/native/audio.txt')?.toString()).toBe('hello world')
    expect(existsSync(occ)).toBe(false)
    expect(existsSync(dataDir)).toBe(true)
  })

  test('live: upload and complete, no FLAC and no transcriber', async () => {
    const { d, dataDir, occ, log } = await rig()
    await finishLocalRun(d, localJob('live'), dataDir, 'ended')
    expect(log).toEqual(['report uploading', 'upload events.jsonl', 'upload recording/meeting.mkv', 'complete'])
    expect(existsSync(occ)).toBe(false)
  })

  test('a crashed run uploads what exists, reports worker_crashed and cleans up, without transcribing', async () => {
    const { d, dataDir, occ, log } = await rig()
    await finishLocalRun(d, localJob('native'), dataDir, 'crashed')
    expect(log).toEqual([
      'report uploading',
      'upload events.jsonl',
      'upload recording/meeting.mkv',
      'fail worker_crashed'
    ])
    expect(existsSync(occ)).toBe(false)
  })

  test('a failed complete keeps the local data and retries', async () => {
    const server = fakeServer()
    server.completeFailures = 1
    const { d, dataDir, occ } = await rig({ server })
    await finishLocalRun(d, localJob('live'), dataDir, 'ended')
    expect(server.requests.filter((r) => r.url.endsWith('/complete'))).toHaveLength(2)
    expect(existsSync(occ)).toBe(false)
  })

  test('a failure that cannot pass keeps the recording, leaves nothing partial, and a second call finishes', async () => {
    const server = fakeServer()
    server.completeFailures = 1000
    const abort = new AbortController()
    const { d, dataDir, occ, whisperRuns } = await rig({ server, signal: abort.signal, retryMs: 5 })
    const origPush = server.requests.push.bind(server.requests)
    server.requests.push = (...items) => {
      const res = origPush(...items)
      if (server.requests.filter((r) => r.url.endsWith('/complete')).length >= 2 && !abort.signal.aborted) {
        abort.abort()
      }
      return res
    }
    const interval = setInterval(() => {
      if (server.requests.filter((r) => r.url.endsWith('/complete')).length >= 2 && !abort.signal.aborted) {
        abort.abort()
        clearInterval(interval)
      }
    }, 5)
    try {
      await expect(finishLocalRun(d, localJob('native'), dataDir, 'ended')).rejects.toThrow('HTTP 503')
    } finally {
      clearInterval(interval)
      server.requests.push = origPush
    }
    expect(existsSync(join(occ, 'recording', 'meeting.mkv'))).toBe(true)
    const left = readdirSync(occ).filter((n) => n === 'audio.flac' || n.startsWith('.'))
    expect(left).toEqual([])
    expect(existsSync(join(occ, 'transcript', 'native', 'audio.json'))).toBe(true)

    // The retry continues: the recording is not sent again and the transcript is not made again.
    server.completeFailures = 0
    const ranges = server.ranges.length
    await finishLocalRun({ ...d, signal: undefined }, localJob('native'), dataDir, 'ended')
    expect(server.ranges.length).toBe(ranges)
    expect(whisperRuns()).toBe(1)
    expect(existsSync(occ)).toBe(false)
  })

  test('a retry after a crash resumes the recording from the server offset', async () => {
    const server = fakeServer()
    const recording = Buffer.alloc(100, 7)
    const { d, dataDir, occ } = await rig({
      server,
      files: [
        ['events.jsonl', 'e'],
        ['recording/meeting.mkv', recording]
      ],
      chunkBytes: 30
    })
    // A first run died after 60 bytes and 2 chunks.
    server.files.set('recording/meeting.mkv', recording.subarray(0, 60))
    await finishLocalRun(d, localJob('live'), dataDir, 'ended')
    expect(server.ranges).toEqual(['bytes 0-0/1', 'bytes 60-89/100', 'bytes 90-99/100'])
    expect(server.files.get('recording/meeting.mkv')?.equals(recording)).toBe(true)
    expect(existsSync(occ)).toBe(false)
  })

  test('the transcriber failing twice fails the job, and the folder goes (the recording is on the server)', async () => {
    const { d, dataDir, occ, log, whisperRuns } = await rig({ whisper: 'fail' })
    await finishLocalRun(d, localJob('native'), dataDir, 'ended')
    expect(whisperRuns()).toBe(2)
    expect(log.at(-1)).toBe('fail native_transcription_failed')
    expect(log).not.toContain('complete')
    expect(existsSync(occ)).toBe(false)
  })

  test('the FLAC cut failing twice fails the job the same way and leaves no FLAC', async () => {
    const { d, dataDir, occ, log, dockerRuns } = await rig({ docker: 'fail' })
    await finishLocalRun(d, localJob('native'), dataDir, 'ended')
    expect(dockerRuns()).toBe(2)
    expect(log.at(-1)).toBe('fail native_transcription_failed')
    expect(existsSync(occ)).toBe(false)
  })

  test('the cut runs detached and is waited for, then the container is removed', async () => {
    const { d, dataDir, calls, server } = await rig()
    await finishLocalRun(d, localJob('native'), dataDir, 'ended')
    expect(calls).toEqual(['rm', 'run', 'rm'])
    expect(server.files.get('transcript/native/audio.json')).toBeDefined()
  })

  test('a cut that outlives its time limit is removed and fails the job, not left running', async () => {
    const { d, dataDir, calls, log } = await rig({ docker: 'hang', flacTimeoutMs: 30 })
    await finishLocalRun(d, localJob('native'), dataDir, 'ended')
    expect(calls).toEqual(['rm', 'run', 'rm', 'rm', 'run', 'rm'])
    expect(log.at(-1)).toBe('fail native_transcription_failed')
  })

  test('stopping the app during the cut removes the container and throws an AbortError', async () => {
    const stop = new AbortController()
    const { d, dataDir, calls } = await rig({ docker: 'hang', signal: stop.signal })
    setTimeout(() => stop.abort(), 30)
    await expect(finishLocalRun(d, localJob('native'), dataDir, 'ended')).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toEqual(['rm', 'run', 'rm'])
  })

  test('a recording without sound fails the cut and the job', async () => {
    const { d, dataDir, log } = await rig({
      files: [
        ['events.jsonl', 'e'],
        ['recording/meeting.mkv', 'not a recording']
      ]
    })
    await finishLocalRun(d, localJob('native'), dataDir, 'ended')
    expect(log.at(-1)).toBe('fail native_transcription_failed')
  })

  test('a link planted in the transcript folder is replaced, not written through', async () => {
    const outside = await tmp()
    const { d, dataDir, occ, server } = await rig()
    await symlink(outside, join(occ, 'transcript'))
    await symlink(join(outside, 'planted'), join(occ, 'audio.flac'))
    await finishLocalRun(d, localJob('native'), dataDir, 'ended')
    expect(readdirSync(outside)).toEqual([])
    expect(server.files.get('transcript/native/audio.json')).toBeDefined()
  })

  test('a file that is a link is left out of the upload', async () => {
    const outside = join(await tmp(), 'secret')
    await writeFile(outside, 'TOP SECRET')
    const { d, dataDir, occ, server } = await rig()
    await rm(join(occ, 'events.jsonl'))
    await symlink(outside, join(occ, 'chat.jsonl'))
    await finishLocalRun(d, localJob('live'), dataDir, 'ended')
    // The link is not part of the set; the rest goes and the run completes.
    expect(server.files.has('chat.jsonl')).toBe(false)
    expect(existsSync(outside)).toBe(true)
  })

  test('a complete that lists missing files throws and keeps the data', async () => {
    const { d, dataDir, occ } = await rig()
    const refusing = {
      ...d,
      api: Object.assign(Object.create(d.api), {
        complete: async () => ({ ok: false as const, missing: ['events.jsonl'] })
      })
    }
    await expect(finishLocalRun(refusing, localJob('live'), dataDir, 'ended')).rejects.toBeInstanceOf(
      IncompleteUploadError
    )
    expect(existsSync(occ)).toBe(true)
  })

  test('nothing the run touched ends up in an error message', async () => {
    const server = fakeServer()
    server.completeFailures = 1000
    const abort = new AbortController()
    const { d, dataDir } = await rig({ server, signal: abort.signal, retryMs: 5 })
    setTimeout(() => abort.abort(), 40)
    const e = await finishLocalRun(d, localJob('live'), dataDir, 'ended').then(
      () => new Error('did not fail'),
      (err: Error) => err
    )
    for (const secret of ['tmd_', dataDir, 'zoom.us', OCC]) expect(e.message).not.toContain(secret)
  })
})

describe('resumeOutcome', () => {
  test('is null without local data, ended with a joined recording, crashed without one', async () => {
    const { dataDir } = await rig()
    expect(await resumeOutcome(localJob('live'), dataDir)).toBe('ended')
    const bare = await rig({ files: [['events.jsonl', 'e']] })
    expect(await resumeOutcome(localJob('live'), bare.dataDir)).toBe('crashed')
    expect(await resumeOutcome(localJob('live'), await tmp())).toBeNull()
  })
})

describe('localReporter', () => {
  test('sends the PC heartbeat with the last attempt that left a segment', async () => {
    const { dataDir, server } = await rig({
      files: [
        ['events.jsonl', 'e'],
        ['recording/attempt_1_seg_000.mkv', 'a'],
        ['recording/attempt_3_seg_002.mkv', 'a']
      ]
    })
    await localReporter(server.api(), localJob('live'), dataDir)('uploading')
    const hb = JSON.parse(server.requests.at(-1)!.body.toString())
    expect(hb).toEqual({
      occurrenceId: OCC,
      attempt: 3,
      state: 'uploading',
      recording: false,
      participants: null,
      events: []
    })
  })
})
