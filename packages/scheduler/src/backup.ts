import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkpointFiles, uuidEntries } from './retention'
import type { LaunchDeps } from './launch'

/** Backup folders more than this many days before today are removed from the remote. */
const KEEP_DAYS = 7
const DAY_MS = 24 * 3_600_000
const DATE_FOLDER = /^\d{4}-\d{2}-\d{2}$/

export type BackupCheckpoint = { identityId: string; path: string }

export type CommandResult = { code: number; stdout: string }
export type CommandOptions = {
  /** Variables added to the process environment for this command. */
  env?: Record<string, string>
  /** Return the command's standard output; otherwise it is discarded and `stdout` is empty. */
  capture?: boolean
}
/** Runs one command and gives its exit code and, when asked, its standard output. */
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

/** Spawns the command. Standard error is discarded: pg_dump and rclone may echo the connection string or remote. */
const spawnRunner: CommandRunner = async (argv, opts = {}) => {
  const proc = Bun.spawn(argv, {
    env: { ...process.env, ...opts.env },
    stdin: 'ignore',
    stdout: opts.capture ? 'pipe' : 'ignore',
    stderr: 'ignore'
  })
  const [stdout, code] = await Promise.all([opts.capture ? new Response(proc.stdout).text() : '', proc.exited])
  return { code, stdout }
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

/**
 * The nightly backup: runs `backupCommands` in order, then purges the dated folders that `rclone lsf` shows as more
 * than 7 days old. It logs each step's first word and exit code only, and removes the local dump afterwards, also when
 * a step failed. `RCLONE_CONFIG` is read by rclone from the environment. A step that exits non-zero stops the run with
 * an error naming only that step.
 */
export async function runBackup(
  deps: LaunchDeps & { remote: string; databaseUrl: string; run?: CommandRunner },
  now: Date
): Promise<void> {
  const date = now.toISOString().slice(0, 10)
  const workDir = await mkdtemp(join(tmpdir(), 'tm-backup-'))
  const run = deps.run ?? spawnRunner
  const step = async (argv: string[], opts?: CommandOptions) => {
    const result = await run(argv, opts)
    console.log(`backup: ${argv[0]} exited ${result.code}`)
    if (result.code !== 0) throw new Error(`backup step failed: ${argv[0]} exited ${result.code}`)
    return result.stdout
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
  }
}
