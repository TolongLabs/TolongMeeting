import { spawn as nodeSpawnChild } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import { NATIVE_UPLOAD_MAX_FILE_BYTES, WhisperJsonSchema } from '@tm/core'

// The transcriber is the member's own command from Settings. It runs with an argument array and no shell, so a
// meeting title or a path can never become a command. Whatever it prints is untrusted: only a short, path-free
// sentence ever leaves this module.

const MIN_TIMEOUT_MS = 30 * 60_000
const STDERR_TAIL_BYTES = 2048
const STDOUT_KEEP_BYTES = 64 * 1024
const REASON_MAX = 300
const KILL_GRACE_MS = 10_000

export interface WhisperVars {
  audio: string
  model: string
  outDir: string
}

/**
 * Splits the command template on whitespace outside double quotes, then fills `{audio}`, `{model}` and `{outDir}`
 * inside each word. A value with spaces stays one argument, and a value is never read as a template again.
 */
export function buildWhisperArgv(template: string, vars: WhisperVars): string[] {
  const words: string[] = []
  let word = ''
  let started = false
  let quoted = false
  for (const ch of template) {
    if (ch === '"') {
      quoted = !quoted
      started = true
    } else if (!quoted && /\s/u.test(ch)) {
      if (started) words.push(word)
      word = ''
      started = false
    } else {
      word += ch
      started = true
    }
  }
  if (quoted) throw new Error('The transcriber command has an unclosed double quote')
  if (started) words.push(word)
  return words.map((w) => w.replace(/\{(audio|model|outDir)\}/g, (_m, key: keyof WhisperVars) => vars[key]))
}

/** At least 30 minutes, and 6 times the audio. */
export function whisperTimeoutMs(durationSec: number): number {
  return Math.max(MIN_TIMEOUT_MS, 6 * durationSec * 1000)
}

export type SpawnLike = (
  cmd: string,
  args: string[],
  opts: { cwd: string; shell: false; windowsHide: true }
) => {
  exited: Promise<number>
  stdout(): string
  stderrTail(): string
  kill(): void
}

/**
 * The real process starter. On Windows `kill()` ends the process and everything it started (`taskkill /T /F`); on
 * other systems the process leads its own group and the group gets SIGKILL. Only this process's own tree is touched.
 */
export const nodeSpawn: SpawnLike = (cmd, args, opts) => {
  const child = nodeSpawnChild(cmd, args, {
    cwd: opts.cwd,
    shell: opts.shell,
    windowsHide: opts.windowsHide,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  })
  let out = ''
  let err = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out = (out + chunk).slice(-STDOUT_KEEP_BYTES)))
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err = (err + chunk).slice(-STDERR_TAIL_BYTES * 4)))
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code ?? -1))
  })
  // A caller that only wants the kill still must not see an unhandled rejection.
  exited.catch(() => {})
  return {
    exited,
    stdout: () => out,
    stderrTail: () => err.slice(-STDERR_TAIL_BYTES),
    kill() {
      const pid = child.pid
      if (pid === undefined) return
      if (process.platform === 'win32') {
        const killer = nodeSpawnChild('taskkill', ['/pid', String(pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore'
        })
        killer.once('error', () => child.kill())
        return
      }
      try {
        process.kill(-pid, 'SIGKILL')
      } catch (e) {
        if (!(e instanceof Error && 'code' in e && e.code === 'ESRCH')) throw e
      }
    }
  }
}

/**
 * One line that is safe to show: ANSI colour and control characters removed, anything shaped like a file path
 * replaced, cut to 300 characters. It takes the last non-empty line, where a crash puts its reason.
 */
export function safeReason(text: string, fallback: string): string {
  const line =
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
      .split(/\r?\n/u)
      .map((l) => l.replace(/\p{Cc}/gu, ' ').trim())
      .filter((l) => l !== '')
      .at(-1) ?? ''
  const clean = line
    .replace(/(?<![\w])[A-Za-z]:[\\/]\S*/gu, '<path>')
    .replace(/\S*[\\/]\S*/gu, '<path>')
    .replace(/(?:<path>\s*){2,}/gu, '<path> ')
    .trim()
    .slice(0, REASON_MAX)
  return clean === '' ? fallback : clean
}

export type WhisperResult = { ok: true } | { ok: false; error: string; stopped?: true }

const absolute = (p: string) => posix.isAbsolute(p) || win32.isAbsolute(p)

/**
 * Runs the transcriber to the end, to the timeout, or to the abort signal, and always leaves no process behind: on a
 * timeout or an abort it kills the process tree and waits for it. The error text carries no path.
 */
export async function runWhisper(o: {
  argv: string[]
  cwd: string
  timeoutMs: number
  spawn: SpawnLike
  signal?: AbortSignal
  killGraceMs?: number
}): Promise<WhisperResult> {
  const [cmd, ...args] = o.argv
  if (cmd === undefined || cmd === '') return { ok: false, error: 'The transcriber command is empty' }
  // A program name is looked up on PATH and an absolute path is used as it is; a relative path (`.\tool`) is not.
  if (!absolute(cmd) && /[\\/]/u.test(cmd))
    return { ok: false, error: 'The transcriber command must be a program name or an absolute path' }

  let proc: ReturnType<SpawnLike>
  try {
    proc = o.spawn(cmd, args, { cwd: o.cwd, shell: false, windowsHide: true })
  } catch (e) {
    return { ok: false, error: safeReason(e instanceof Error ? e.message : '', 'The transcriber could not start') }
  }

  let why: 'timeout' | 'stopped' | null = null
  let giveUp: () => void = () => {}
  const stuck = new Promise<'stuck'>((resolve) => (giveUp = () => resolve('stuck')))
  const timers: ReturnType<typeof setTimeout>[] = []
  const halt = (reason: 'timeout' | 'stopped') => {
    if (why !== null) return
    why = reason
    proc.kill()
    timers.push(setTimeout(giveUp, o.killGraceMs ?? KILL_GRACE_MS))
  }
  timers.push(setTimeout(() => halt('timeout'), o.timeoutMs))
  const onAbort = () => halt('stopped')
  if (o.signal?.aborted) onAbort()
  else o.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const outcome = await Promise.race([
      proc.exited.then(
        (code) => ({ code }),
        (error: unknown) => ({ error })
      ),
      stuck
    ])
    if (outcome === 'stuck') return { ok: false, error: 'The transcriber could not be stopped' }
    if (why === 'timeout') return { ok: false, error: 'The transcriber took too long and was stopped' }
    if (why === 'stopped') return { ok: false, error: 'The transcriber was stopped', stopped: true }
    if ('error' in outcome) {
      const message = outcome.error instanceof Error ? outcome.error.message : ''
      return { ok: false, error: safeReason(message, 'The transcriber could not start') }
    }
    if (outcome.code !== 0)
      return {
        ok: false,
        error: safeReason(proc.stderrTail(), `The transcriber stopped with exit code ${outcome.code}`)
      }
    return { ok: true }
  } finally {
    for (const t of timers) clearTimeout(t)
    o.signal?.removeEventListener('abort', onAbort)
  }
}

export type WhisperOutputs =
  { ok: true; files: { txt: string; srt: string; json: string } } | { ok: false; error: string }

const EXTENSIONS = ['txt', 'srt', 'json'] as const

/**
 * Finds the transcriber's `txt`, `srt` and `json` in `outDir`: `audio.<ext>` if present, else the only file with that
 * extension. Each must be a regular file (no link) under the upload size cap. The JSON must match the core schema.
 */
export async function collectOutputs(outDir: string): Promise<WhisperOutputs> {
  const entries = (await readdir(outDir, { withFileTypes: true })).filter((e) => e.isFile())
  const text: Partial<Record<(typeof EXTENSIONS)[number], string>> = {}
  for (const ext of EXTENSIONS) {
    const named = entries.filter((e) => e.name.toLowerCase().endsWith(`.${ext}`))
    const pick = named.find((e) => e.name === `audio.${ext}`) ?? (named.length === 1 ? named[0] : undefined)
    if (!pick) return { ok: false, error: 'The transcriber did not write the expected files' }
    const file = join(outDir, pick.name)
    if ((await stat(file)).size > NATIVE_UPLOAD_MAX_FILE_BYTES)
      return { ok: false, error: 'The transcript is too large to upload' }
    text[ext] = await readFile(file, 'utf8')
  }
  const files = { txt: text.txt ?? '', srt: text.srt ?? '', json: text.json ?? '' }
  let parsed: unknown
  try {
    parsed = JSON.parse(files.json)
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e
    return { ok: false, error: 'The transcriber wrote a transcript this app cannot read' }
  }
  if (!WhisperJsonSchema.safeParse(parsed).success)
    return { ok: false, error: 'The transcriber wrote a transcript this app cannot read' }
  return { ok: true, files }
}
