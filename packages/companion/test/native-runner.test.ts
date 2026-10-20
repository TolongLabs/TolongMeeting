import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CompanionJob } from '@tm/core'
import { CompanionApiError, MAX_AUDIO_BYTES } from '../src/api'
import { buildWhisperArgv, nodeSpawn, runWhisper, whisperTimeoutMs, type SpawnLike } from '../src/jobs/whisper'
import { audioLimitBytes, NativeRunner, type NativeRunnerDeps } from '../src/jobs/native-runner'
import { KeepAwake } from '../src/keep-awake'
import type { DesktopNotification } from '../src/notifier'
import type { Settings } from '../src/settings'

const roots: string[] = []
async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tm-native-'))
  roots.push(dir)
  return dir
}
afterAll(() => Promise.all(roots.map((d) => rm(d, { recursive: true, force: true }))))

// A stand-in for whisper-transcriber, run as a real child process. `{model}` in the command picks its behaviour.
const FAKE = `
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const [mode, outDir] = process.argv.slice(2)
const segs = JSON.stringify({ segments: [{ start: 0, end: 1.5, text: 'secret words' }] })
const write = (name, text) => fs.writeFileSync(path.join(outDir, name), text)
const all = (json) => { write('audio.txt', 'secret words'); write('audio.srt', '1'); write('audio.json', json) }
const pids = () => {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  fs.writeFileSync(path.join(__dirname, 'pids-' + mode), JSON.stringify([process.pid, grandchild.pid]))
}
if (mode === 'ok') all(segs)
else if (mode === 'slow') setTimeout(() => { all(segs) }, 300)
else if (mode === 'crash') { console.error('Traceback\\nRuntimeError: CUDA out of memory in C:\\\\Users\\\\A B\\\\whisper\\\\model.py'); process.exit(3) }
else if (mode === 'badjson') all('{"segments": [')
else if (mode === 'schema') all('{"segments": [{"start": -4, "end": 1, "text": "x"}]}')
else if (mode === 'big') { all(segs); fs.writeFileSync(path.join(outDir, 'audio.txt'), Buffer.alloc(51 * 1024 * 1024, 97)) }
else if (mode === 'partial') write('audio.txt', 'only text')
else if (mode === 'hang') { pids(); setInterval(() => {}, 1000) }
`

interface Rig {
  dir: string
  jobsDir: string
  pidsFile: (mode: string) => string
  command: (mode: string) => string
}
async function rig(): Promise<Rig> {
  const dir = await tmp()
  const script = join(dir, 'fake-transcriber.cjs')
  await writeFile(script, FAKE)
  const jobsDir = join(dir, 'jobs')
  return {
    dir,
    jobsDir,
    pidsFile: (mode) => join(dir, `pids-${mode}`),
    command: () => `"${process.execPath}" "${script}" {model} {outDir}`
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function until(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await Bun.sleep(10)
  }
}

function pending(id: string): CompanionJob {
  return {
    id,
    kind: 'native_transcription',
    state: 'pending',
    occurrenceId: `occ_${id}`,
    attempts: 0,
    payload: {
      occurrenceId: `occ_${id}`,
      entryName: 'Maths',
      start: '2026-10-21T08:00:00Z',
      timeZone: 'Asia/Kuala_Lumpur',
      durationSec: 60,
      flacBytes: 1000
    }
  }
}

type Api = NativeRunnerDeps['api']
class FakeApi implements Api {
  claims: string[] = []
  uploads: { jobId: string; files: string[] }[] = []
  uploadBodies: { txt: string; srt: string; json: string }[] = []
  uploadAttempts = 0
  uploadFailures = 0
  uploadStatus = 0
  flacPresentAtEachUpload: boolean[] = []
  progressCalls = 0
  progressStatus = 0
  failures: { jobId: string; error: string }[] = []
  constructor(private readonly jobsDir: string) {}
  async claim(id: string) {
    this.claims.push(id)
    return pending(id)
  }
  async progress() {
    this.progressCalls++
    if (this.progressStatus) throw new CompanionApiError(this.progressStatus)
  }
  async fail(jobId: string, error: string) {
    this.failures.push({ jobId, error })
  }
  downloadLimits: number[] = []
  async downloadAudio(jobId: string, dest: string, _signal?: AbortSignal, maxBytes?: number) {
    this.downloadLimits.push(maxBytes ?? -1)
    await writeFile(dest, Buffer.alloc(1000))
    void jobId
  }
  async uploadTranscript(jobId: string, files: { txt: string; srt: string; json: string }) {
    this.uploadAttempts++
    this.flacPresentAtEachUpload.push(existsSync(join(this.jobsDir, jobId, 'audio.flac')))
    if (this.uploadStatus) throw new CompanionApiError(this.uploadStatus)
    if (this.uploadFailures-- > 0) throw new CompanionApiError(503)
    this.uploadBodies.push(files)
    this.uploads.push({ jobId, files: ['audio.txt', 'audio.srt', 'audio.json'] })
  }
}

function blocker() {
  const calls: string[] = []
  return {
    calls,
    start: (t: 'prevent-app-suspension') => (calls.push(`start ${t}`), 7),
    stop: (id: number) => void calls.push(`stop ${id}`)
  }
}

let r: Rig
let api: FakeApi
let power: ReturnType<typeof blocker>
let shown: DesktopNotification[]
let opened: number
beforeEach(async () => {
  r = await rig()
  api = new FakeApi(r.jobsDir)
  power = blocker()
  shown = []
  opened = 0
})

function runnerWith(
  over: {
    mode?: string
    cwd?: string | null
    spawn?: SpawnLike
    timeoutMs?: number
    progressMs?: number
    command?: string
  } = {}
): NativeRunner {
  const unexpected: unknown[] = []
  const settings: Settings = {
    serverUrl: 'https://tm.example',
    summariesDir: join(r.dir, 'summaries'),
    whisper: {
      command: over.command ?? r.command(over.mode ?? 'ok'),
      cwd: over.cwd === undefined ? r.dir : over.cwd,
      model: over.mode ?? 'ok'
    }
  }
  return new NativeRunner({
    api,
    settings: () => settings,
    jobsDir: r.jobsDir,
    keepAwake: new KeepAwake(power),
    spawn: over.spawn ?? nodeSpawn,
    notifier: { show: (n) => void shown.push(n) },
    openSettings: () => void opened++,
    progressMs: over.progressMs ?? 20,
    uploadRetryMs: 10,
    timeoutMs: () => over.timeoutMs ?? 20_000,
    onError: (e) => void unexpected.push(e)
  })
}
const idle = (runner: NativeRunner) => until(() => !runner.busy)

describe('command and timeout', () => {
  test('buildWhisperArgv keeps paths with spaces as one argument', () => {
    expect(
      buildWhisperArgv('uv run transcriber {audio} -m {model} -f txt,srt,json -o {outDir}', {
        audio: 'C:\\Users\\A B\\a.flac',
        model: 'medium',
        outDir: 'C:\\Users\\A B\\out'
      })
    ).toEqual([
      'uv',
      'run',
      'transcriber',
      'C:\\Users\\A B\\a.flac',
      '-m',
      'medium',
      '-f',
      'txt,srt,json',
      '-o',
      'C:\\Users\\A B\\out'
    ])
  })

  test('quotes group words and a value is never read as a template again', () => {
    expect(
      buildWhisperArgv('"C:\\Program Files\\uv.exe" run {audio}', { audio: '{model}', model: 'm', outDir: 'o' })
    ).toEqual(['C:\\Program Files\\uv.exe', 'run', '{model}'])
    expect(() => buildWhisperArgv('uv "run', { audio: 'a', model: 'm', outDir: 'o' })).toThrow('unclosed')
  })

  test('whisperTimeoutMs is at least 30 minutes and 6 times the audio', () => {
    expect(whisperTimeoutMs(60)).toBe(1_800_000)
    expect(whisperTimeoutMs(5400)).toBe(32_400_000)
  })

  test('runWhisper spawns hidden, without a shell, in the configured folder', async () => {
    const calls: unknown[][] = []
    const result = await runWhisper({
      argv: ['uv', 'run', 'transcriber'],
      cwd: 'C:\\wt',
      timeoutMs: 1000,
      spawn: (c, a, o) => (
        calls.push([c, a, o]),
        { exited: Promise.resolve(0), stdout: () => '', stderrTail: () => '', kill: () => {} }
      )
    })
    expect(result).toEqual({ ok: true })
    expect(calls[0]).toEqual(['uv', ['run', 'transcriber'], { cwd: 'C:\\wt', shell: false, windowsHide: true }])
  })

  test('a relative program path is refused before anything starts', async () => {
    let started = false
    const result = await runWhisper({
      argv: ['.\\tool.exe', 'x'],
      cwd: '/w',
      timeoutMs: 1000,
      spawn: () => {
        started = true
        throw new Error('must not start')
      }
    })
    expect(result.ok).toBe(false)
    expect(started).toBe(false)
  })
})

describe('NativeRunner', () => {
  test('one job at a time: the runner claims the next job only when idle', async () => {
    const runner = runnerWith({ mode: 'slow' })
    runner.offer([pending('j1'), pending('j2')])
    runner.offer([pending('j2')])
    await Bun.sleep(10)
    expect(api.claims).toEqual(['j1'])
    expect(runner.busy).toBe(true)
    await idle(runner)
    runner.offer([pending('j2')])
    await until(() => api.claims.length === 2)
    expect(api.claims).toEqual(['j1', 'j2'])
    await idle(runner)
  })

  test('a successful job uploads txt, srt and json, deletes the job folder and releases keep-awake', async () => {
    const runner = runnerWith()
    runner.offer([pending('j1')])
    await idle(runner)
    expect(api.uploads).toEqual([{ jobId: 'j1', files: ['audio.txt', 'audio.srt', 'audio.json'] }])
    expect(api.uploadBodies[0].txt).toBe('secret words')
    expect(existsSync(join(r.jobsDir, 'j1'))).toBe(false)
    expect(power.calls).toEqual(['start prevent-app-suspension', 'stop 7'])
    expect(api.failures).toEqual([])
  })

  test('the recording download is capped by the job length, not by the 16 GiB ceiling', async () => {
    const runner = runnerWith()
    runner.offer([pending('j1')])
    await idle(runner)
    expect(api.downloadLimits).toEqual([audioLimitBytes(60)])
    expect(audioLimitBytes(60)).toBe(60 * 192_000 + 16 * 1024 ** 2)
    expect(audioLimitBytes(60)).toBeLessThan(MAX_AUDIO_BYTES)
    expect(audioLimitBytes(10 * 3600)).toBe(10 * 3600 * 192_000 + 16 * 1024 ** 2)
    expect(audioLimitBytes(1e9)).toBe(MAX_AUDIO_BYTES)
  })

  test('the lease is renewed while the transcriber runs', async () => {
    const runner = runnerWith({ mode: 'slow', progressMs: 20 })
    runner.offer([pending('j1')])
    await idle(runner)
    expect(api.progressCalls).toBeGreaterThan(2)
    const seen = api.progressCalls
    await Bun.sleep(60)
    expect(api.progressCalls).toBe(seen)
  })

  test('a failed upload keeps the FLAC and retries with progress calls in between', async () => {
    api.uploadFailures = 2
    const runner = runnerWith()
    runner.offer([pending('j1')])
    await idle(runner)
    expect(api.uploadAttempts).toBe(3)
    expect(api.flacPresentAtEachUpload).toEqual([true, true, true])
    expect(api.uploads).toHaveLength(1)
  })

  test('an upload the website refuses for good is reported, not retried', async () => {
    api.uploadStatus = 413
    const runner = runnerWith()
    runner.offer([pending('j1')])
    await idle(runner)
    expect(api.uploadAttempts).toBe(1)
    expect(api.failures).toEqual([{ jobId: 'j1', error: 'The website refused the transcript' }])
    expect(existsSync(join(r.jobsDir, 'j1'))).toBe(false)
  })

  test('a job the website took back (404) ends quietly: no report, folder gone', async () => {
    api.uploadStatus = 404
    const runner = runnerWith()
    runner.offer([pending('j1')])
    await idle(runner)
    expect(api.failures).toEqual([])
    expect(existsSync(join(r.jobsDir, 'j1'))).toBe(false)
    expect(power.calls).toEqual(['start prevent-app-suspension', 'stop 7'])
  })

  test('losing the lease while the transcriber runs kills it and reports nothing', async () => {
    const runner = runnerWith({ mode: 'hang', progressMs: 20 })
    runner.offer([pending('j1')])
    // The lease is lost only once the transcriber has started, so there is a process to kill on any machine speed.
    await until(() => existsSync(r.pidsFile('hang')))
    api.progressStatus = 409
    await idle(runner)
    expect(api.failures).toEqual([])
    expect(api.uploads).toEqual([])
    const pids: number[] = JSON.parse(await readFile(r.pidsFile('hang'), 'utf8'))
    await until(() => pids.every((p) => !alive(p)))
    expect(existsSync(join(r.jobsDir, 'j1'))).toBe(false)
  })

  test('a transcriber crash reports a fixed reason, never its own words, and cleans up', async () => {
    const runner = runnerWith({ mode: 'crash' })
    runner.offer([pending('j1')])
    await idle(runner)
    expect(api.failures).toEqual([{ jobId: 'j1', error: 'The transcriber stopped with exit code 3' }])
    expect(JSON.stringify(api.failures)).not.toMatch(/CUDA|Users|model\.py/)
    expect(existsSync(join(r.jobsDir, 'j1'))).toBe(false)
    expect(power.calls).toEqual(['start prevent-app-suspension', 'stop 7'])
  })

  test('a timeout kills the transcriber and its children, reports a fixed sentence and cleans up', async () => {
    const runner = runnerWith({ mode: 'hang', timeoutMs: 300 })
    runner.offer([pending('j1')])
    await idle(runner)
    expect(api.failures).toEqual([{ jobId: 'j1', error: 'The transcriber took too long and was stopped' }])
    const pids: number[] = JSON.parse(await readFile(r.pidsFile('hang'), 'utf8'))
    expect(pids).toHaveLength(2)
    await until(() => pids.every((p) => !alive(p)))
    expect(existsSync(join(r.jobsDir, 'j1'))).toBe(false)
    expect(power.calls).toEqual(['start prevent-app-suspension', 'stop 7'])
  })

  test('an oversize output is refused before upload', async () => {
    const runner = runnerWith({ mode: 'big' })
    runner.offer([pending('j1')])
    await idle(runner)
    expect(api.uploadAttempts).toBe(0)
    expect(api.failures).toEqual([{ jobId: 'j1', error: 'The transcript is too large to upload' }])
    expect(existsSync(join(r.jobsDir, 'j1'))).toBe(false)
  })

  test('malformed JSON and a JSON that breaks the schema are refused, with no transcript text in the report', async () => {
    for (const mode of ['badjson', 'schema']) {
      api = new FakeApi(r.jobsDir)
      const runner = runnerWith({ mode })
      runner.offer([pending('j1')])
      await idle(runner)
      expect(api.uploadAttempts).toBe(0)
      expect(api.failures).toEqual([{ jobId: 'j1', error: 'The transcriber wrote a transcript this app cannot read' }])
    }
  })

  test('missing outputs are reported with a fixed sentence', async () => {
    const runner = runnerWith({ mode: 'partial' })
    runner.offer([pending('j1')])
    await idle(runner)
    expect(api.failures).toEqual([{ jobId: 'j1', error: 'The transcriber did not write the expected files' }])
  })

  test('a command that is not installed is reported, not thrown', async () => {
    const runner = runnerWith({ command: 'tm-no-such-program-xyz {audio}' })
    runner.offer([pending('j1')])
    await idle(runner)
    expect(api.failures).toHaveLength(1)
    expect(api.failures[0].error).toMatch(/ENOENT|not found/i)
    expect(api.failures[0].error).not.toContain(r.dir)
    expect(existsSync(join(r.jobsDir, 'j1'))).toBe(false)
  })

  test('stop mid-run: the child and its child are gone, the folder is gone, keep-awake is released, nothing is reported', async () => {
    const runner = runnerWith({ mode: 'hang' })
    runner.offer([pending('j1')])
    await until(() => existsSync(r.pidsFile('hang')))
    const pids: number[] = JSON.parse(await readFile(r.pidsFile('hang'), 'utf8'))
    expect(pids.every(alive)).toBe(true)
    expect(existsSync(join(r.jobsDir, 'j1', 'audio.flac'))).toBe(true)
    expect(power.calls).toEqual(['start prevent-app-suspension'])

    await runner.stop()

    expect(runner.busy).toBe(false)
    await until(() => pids.every((p) => !alive(p)))
    expect(existsSync(join(r.jobsDir, 'j1'))).toBe(false)
    expect(power.calls).toEqual(['start prevent-app-suspension', 'stop 7'])
    expect(api.failures).toEqual([])
    const calls = api.progressCalls
    await Bun.sleep(60)
    expect(api.progressCalls).toBe(calls)
    runner.offer([pending('j2')])
    expect(api.claims).toEqual(['j1'])
  })

  test('an old job folder is replaced, not reused', async () => {
    await mkdir(join(r.jobsDir, 'j1', 'out'), { recursive: true })
    await writeFile(
      join(r.jobsDir, 'j1', 'out', 'audio.json'),
      '{"segments": [{"start": 0, "end": 1, "text": "stale"}]}'
    )
    const runner = runnerWith({ mode: 'partial' })
    runner.offer([pending('j1')])
    await idle(runner)
    expect(api.failures[0].error).toBe('The transcriber did not write the expected files')
  })

  test('without a whisper folder the runner claims nothing and notifies once', () => {
    const runner = runnerWith({ cwd: null })
    runner.offer([pending('j1')])
    runner.offer([pending('j1')])
    expect(api.claims).toEqual([])
    expect(shown).toEqual([
      expect.objectContaining({
        title: 'Set up native transcription',
        body: 'A meeting is waiting to be transcribed. Click to choose your whisper-transcriber folder.'
      })
    ])
  })

  test('jobs that are not pending native jobs are ignored', () => {
    const runner = runnerWith({ cwd: null })
    runner.offer([{ ...pending('j1'), state: 'claimed' }])
    expect(shown).toEqual([])
    expect(runner.busy).toBe(false)
  })
})
