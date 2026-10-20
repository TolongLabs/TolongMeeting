import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkpointFiles, uuidEntries } from './retention'
import type { LaunchDeps } from './launch'

/** Backup folders more than this many days before today are removed from the remote. */
const KEEP_DAYS = 7
const DAY_MS = 24 * 3_600_000
const DATE_FOLDER = /^\d{4}-\d{2}-\d{2}$/
/** The last this many bytes of each step's standard error go to the log and, when clean, to a failure message. */
const STDERR_TAIL_BYTES = 4096
const REDACTED = '[redacted]'
/** The diagnostic log of the last run, in the scheduler's data root (TRD: `TM_DATA_ROOT`), mode 0600. */
const BACKUP_LOG_NAME = 'backup-last.log'

export type BackupCheckpoint = { identityId: string; path: string }

/** `stderr` is the last `STDERR_TAIL_BYTES` bytes of standard error; it is never printed as is (see `runBackup`). */
export type CommandResult = { code: number; stdout: string; stderr: string }
export type CommandOptions = {
  /** Variables added to the process environment for this command. */
  env?: Record<string, string>
  /** Return the command's standard output; otherwise it is discarded and `stdout` is empty. */
  capture?: boolean
}
/** Runs one command and gives its exit code, the tail of its standard error and, when asked, its standard output. */
export type CommandRunner = (argv: string[], opts?: CommandOptions) => Promise<CommandResult>

const joinRemote = (remote: string, name: string) =>
  `${remote}${remote.endsWith(':') || remote.endsWith('/') ? '' : '/'}${name}`

/**
 * The libpq environment variables for a database URL, so the password never appears in an argument list (where `ps`
 * shows it). Only `sslmode` is accepted from the query string; anything else throws rather than being dropped.
 */
export function postgresEnv(databaseUrl: string): Record<string, string> {
  const url = new URL(databaseUrl)
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new Error('database URL is not postgres://')
  const database = decodeURIComponent(url.pathname.slice(1))
  if (url.hostname === '' || database === '') throw new Error('database URL needs a host and a database name')
  const env: Record<string, string> = { PGHOST: url.hostname, PGDATABASE: database }
  if (url.port !== '') env.PGPORT = url.port
  if (url.username !== '') env.PGUSER = decodeURIComponent(url.username)
  if (url.password !== '') env.PGPASSWORD = decodeURIComponent(url.password)
  for (const [key, value] of url.searchParams) {
    if (key !== 'sslmode') throw new Error(`database URL parameter ${key} is not supported for backups`)
    env.PGSSLMODE = value
  }
  return env
}

/**
 * The argv lists of one nightly backup before expiry, in order: dump the database, copy the dump and each identity's
 * newest checkpoint to `<remote><date>/`, then list the remote's folders. The dump's connection settings go in the
 * environment (`postgresEnv`), never in an argument. No shell is involved.
 */
export function backupCommands(p: {
  date: string
  remote: string
  workDir: string
  checkpoints: BackupCheckpoint[]
}): string[][] {
  const dump = `${p.workDir}/${p.date}/db.dump`
  const dest = joinRemote(p.remote, p.date)
  return [
    ['pg_dump', '--format=custom', `--file=${dump}`],
    ['rclone', 'copyto', dump, `${dest}/db.dump`],
    ...p.checkpoints.map((c) => ['rclone', 'copyto', c.path, `${dest}/profiles/${c.identityId}.tar.enc`]),
    ['rclone', 'lsf', '--dirs-only', p.remote]
  ]
}

/**
 * The purge commands for dated folders more than 7 days before `now`, from the `rclone lsf --dirs-only` listing.
 * Expiry goes by the folder's date, never by file age: a checkpoint written weeks ago and uploaded tonight lives in
 * tonight's folder. Names that are not `YYYY-MM-DD` are not ours and are left alone.
 */
export function expiryCommands(remote: string, listing: string, now: Date): string[][] {
  const cutoff = Date.parse(now.toISOString().slice(0, 10)) - KEEP_DAYS * DAY_MS
  return listing
    .split('\n')
    .map((line) => line.trim().replace(/\/$/, ''))
    .filter((name) => DATE_FOLDER.test(name) && Date.parse(name) < cutoff)
    .sort()
    .map((name) => ['rclone', 'purge', joinRemote(remote, name)])
}

/** Reads a stream to its end and keeps only its last `max` bytes, so a chatty step cannot grow memory. */
async function readTail(stream: ReadableStream<Uint8Array>, max: number): Promise<string> {
  const reader = stream.getReader()
  let tail = Buffer.alloc(0)
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    tail = Buffer.concat([tail, value])
    if (tail.length > max) tail = tail.subarray(tail.length - max)
  }
  return tail.toString('utf8')
}

/** Spawns the command. Standard error is piped and its tail returned; standard output only when `capture` is set. */
const spawnRunner: CommandRunner = async (argv, opts = {}) => {
  const proc = Bun.spawn(argv, {
    env: { ...process.env, ...opts.env },
    stdin: 'ignore',
    stdout: opts.capture ? 'pipe' : 'ignore',
    stderr: 'pipe'
  })
  const [stdout, stderr, code] = await Promise.all([
    opts.capture ? new Response(proc.stdout).text() : '',
    readTail(proc.stderr, STDERR_TAIL_BYTES),
    proc.exited
  ])
  return { code, stdout, stderr }
}

/** Each identity's newest complete checkpoint. */
async function newestCheckpoints(profileRoot: string): Promise<BackupCheckpoint[]> {
  const found: BackupCheckpoint[] = []
  for (const d of (await uuidEntries(profileRoot)).sort((x, y) => (x.name < y.name ? -1 : 1))) {
    if (!d.isDirectory()) continue
    const newest = (await checkpointFiles(profileRoot, d.name)).at(-1)
    if (newest !== undefined) found.push({ identityId: d.name, path: join(profileRoot, d.name, 'checkpoints', newest) })
  }
  return found
}

type Redaction = {
  /** Literal values, replaced wherever they occur. */
  secrets: string[]
  /** libpq values (host, user, database, port, ...) replaced as whole words, so a user `tm` does not hide `tm-backup`. */
  words: string[]
}

/**
 * What the log must not show: the database URL and its password (raw and decoded), the libpq values, and the rclone
 * remote when it carries options or credentials (a `,` or `=` or `@`, or a `://`), as in `:s3,secret_access_key=...:`.
 */
function redactionFor(databaseUrl: string, remote: string): Redaction {
  const url = new URL(databaseUrl)
  const env = postgresEnv(databaseUrl)
  const secrets = [databaseUrl, url.password, env.PGPASSWORD ?? '']
  if (/[=@,]|:\/\//.test(remote)) secrets.push(remote)
  const words = Object.entries(env)
    .filter(([key]) => key !== 'PGPASSWORD')
    .map(([, value]) => value)
  return { secrets: secrets.filter((s) => s !== ''), words: words.filter((w) => w !== '') }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Replaces the redaction values, and anything shaped like a bearer token, a secret key/value pair or URL userinfo. */
function redactLog(text: string, r: Redaction): string {
  let out = text
  for (const s of r.secrets) out = out.replaceAll(s, REDACTED)
  for (const w of r.words) out = out.replace(new RegExp(`(?<![\\w-])${escapeRegExp(w)}(?![\\w-])`, 'g'), REDACTED)
  return out
    .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, `$1 ${REDACTED}`)
    .replace(
      /\b([\w-]*(?:token|password|passwd|pwd|secret|api[_-]?key|access[_-]?key)[\w-]*)(\s*[=:]\s*)[^\s"',;]+/gi,
      `$1$2${REDACTED}`
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`)
}

/** Writes the log whole: a temp file in the same directory, then a rename, always mode 0600. */
async function writeBackupLog(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFile(tmp, text, { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, path)
}

/**
 * The nightly backup: runs `backupCommands` in order, then purges the dated folders that `rclone lsf` shows as more
 * than 7 days old. It removes the local dump afterwards, also when a step failed.
 *
 * Each step's standard error (never pg_dump's standard output) is redacted and its last 4 KB are written to
 * `<dataRoot>/backup-last.log`, which holds the last run only. A step that exits non-zero stops the run. Its error names
 * the program and exit code, and adds the redacted tail only when redaction changed nothing, so the error never carries
 * a secret that was cut out of the text. `RCLONE_CONFIG` is read by rclone from the environment.
 */
export async function runBackup(
  deps: LaunchDeps & { remote: string; databaseUrl: string; run?: CommandRunner },
  now: Date
): Promise<void> {
  const date = now.toISOString().slice(0, 10)
  const redaction = redactionFor(deps.databaseUrl, deps.remote)
  const logPath = join(deps.env.dataRoot, BACKUP_LOG_NAME)
  const report: string[] = [`backup ${date} at ${now.toISOString()}`]
  const workDir = await mkdtemp(join(tmpdir(), 'tm-backup-'))
  const run = deps.run ?? spawnRunner
  const step = async (argv: string[], opts?: CommandOptions) => {
    const result = await run(argv, opts)
    console.log(`backup: ${argv[0]} exited ${result.code}`)
    const tail = result.stderr.slice(-STDERR_TAIL_BYTES)
    const redacted = redactLog(tail, redaction)
    report.push(`== ${argv[0]} exited ${result.code} ==`, redacted)
    if (result.code === 0) return result.stdout
    const detail = redacted === tail ? redacted.trim() : ''
    throw new Error(`backup step failed: ${argv[0]} exited ${result.code}${detail === '' ? '' : `\n${detail}`}`)
  }
  try {
    await mkdir(join(workDir, date))
    const commands = backupCommands({
      date,
      remote: deps.remote,
      workDir,
      checkpoints: await newestCheckpoints(deps.env.profileRoot)
    })
    const list = commands.pop()!
    for (const argv of commands) await step(argv, argv[0] === 'pg_dump' ? { env: postgresEnv(deps.databaseUrl) } : {})
    const listing = await step(list, { capture: true })
    for (const argv of expiryCommands(deps.remote, listing, now)) await step(argv)
  } finally {
    await rm(workDir, { recursive: true, force: true })
    await writeBackupLog(logPath, `${report.join('\n')}\n`)
  }
}
