import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkpointFiles, uuidEntries } from './retention'
import type { LaunchDeps } from './launch'

/** Backups on the remote older than this are deleted, so a deleted meeting doesn't linger past it. */
const KEEP_DAYS = 7

export type BackupCheckpoint = { identityId: string; path: string }

/** Runs one command and gives its exit code. */
export type CommandRunner = (argv: string[]) => Promise<number>

/**
 * The argv lists of one nightly backup, in order: dump the database, copy the dump and each identity's newest
 * checkpoint to `<remote><date>/`, then expire copies older than 7 days. No shell is involved. `databaseUrl` is in the
 * first list, so a caller must never log these lists.
 */
export function backupCommands(p: {
  date: string
  databaseUrl: string
  remote: string
  workDir: string
  checkpoints: BackupCheckpoint[]
}): string[][] {
  const dump = `${p.workDir}/${p.date}/db.dump`
  const dest = `${p.remote}${p.remote.endsWith(':') || p.remote.endsWith('/') ? '' : '/'}${p.date}`
  return [
    ['pg_dump', '--format=custom', `--dbname=${p.databaseUrl}`, `--file=${dump}`],
    ['rclone', 'copyto', dump, `${dest}/db.dump`],
    ...p.checkpoints.map((c) => ['rclone', 'copyto', c.path, `${dest}/profiles/${c.identityId}.tar.enc`]),
    ['rclone', 'delete', '--min-age', `${KEEP_DAYS}d`, p.remote],
    ['rclone', 'rmdirs', '--leave-root', p.remote]
  ]
}

/** Spawns the command with its output discarded: pg_dump and rclone may echo the connection string or remote. */
const spawnRunner: CommandRunner = async (argv) => {
  const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  return await proc.exited
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
 * The nightly backup: runs `backupCommands` in order, logs each step's first word and exit code only (the arguments
 * hold the database URL), and removes the local dump afterwards, also when a step failed. `RCLONE_CONFIG` is read by
 * rclone from the environment. A step that exits non-zero stops the run with an error naming only that step.
 */
export async function runBackup(
  deps: LaunchDeps & { remote: string; databaseUrl: string; run?: CommandRunner },
  now: Date
): Promise<void> {
  const date = now.toISOString().slice(0, 10)
  const workDir = await mkdtemp(join(tmpdir(), 'tm-backup-'))
  const run = deps.run ?? spawnRunner
  try {
    await mkdir(join(workDir, date))
    const commands = backupCommands({
      date,
      databaseUrl: deps.databaseUrl,
      remote: deps.remote,
      workDir,
      checkpoints: await newestCheckpoints(deps.env.profileRoot)
    })
    for (const argv of commands) {
      const code = await run(argv)
      console.log(`backup: ${argv[0]} exited ${code}`)
      if (code !== 0) throw new Error(`backup step failed: ${argv[0]} exited ${code}`)
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}
