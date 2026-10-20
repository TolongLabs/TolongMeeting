import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rm, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Files a container needs only at start (the job and the profile key), kept on the PC just long enough for it to read
// them. The folder is owner-only; `remove` overwrites each file with zeros before it deletes the folder.

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const DEFAULT_MAX_MS = 120_000
const ZERO_CHUNK = 1024 * 1024
const NOFOLLOW = constants.O_NOFOLLOW ?? 0

/**
 * Overwrites a regular file with zeros, in place, and flushes it. A link is never followed (the file is opened with
 * `O_NOFOLLOW` where the system has it, and must be a regular file with one name); anything else is left for the
 * caller to delete. Returns whether the contents were overwritten.
 */
async function zeroFile(file: string): Promise<boolean> {
  const before = await lstat(file)
  if (!before.isFile() || before.nlink > 1) return false
  const handle = await open(file, constants.O_WRONLY | NOFOLLOW)
  try {
    const after = await handle.stat()
    if (!after.isFile() || after.ino !== before.ino || after.dev !== before.dev) return false
    const zeros = Buffer.alloc(Math.min(ZERO_CHUNK, Math.max(after.size, 1)))
    for (let at = 0; at < after.size; at += zeros.length) {
      await handle.write(zeros, 0, Math.min(zeros.length, after.size - at), at)
    }
    await handle.sync()
    return true
  } finally {
    await handle.close()
  }
}

export interface Ephemeral {
  dir: string
  remove(): Promise<void>
}

/** Makes `<dir>/<random>/` and writes `files` into it (names, not paths). A failed write removes what was written. */
export async function writeEphemeral(dir: string, files: Record<string, string | Buffer>): Promise<Ephemeral> {
  for (const name of Object.keys(files)) {
    if (!FILE_NAME.test(name)) throw new Error('a short-lived file needs a plain file name')
  }
  const own = join(dir, randomBytes(12).toString('hex'))
  await mkdir(own, { recursive: true, mode: 0o700 })
  const remove = async (): Promise<void> => {
    // The folder goes even when a file cannot be overwritten; the failure is thrown after it is gone.
    try {
      let names: string[] = []
      try {
        names = await readdir(own)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      for (const name of names) await zeroFile(join(own, name))
    } finally {
      await rm(own, { recursive: true, force: true })
    }
  }
  try {
    for (const [name, content] of Object.entries(files))
      await writeFile(join(own, name), content, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    await rm(own, { recursive: true, force: true })
    throw error
  }
  return { dir: own, remove }
}

/**
 * Removes the files once the worker's first heartbeat arrived, or after `maxMs` (default 120 s), whichever is first.
 * The files go in both cases; a heartbeat that fails is rethrown after the removal.
 */
export async function removeAfterFirstHeartbeat(
  e: Pick<Ephemeral, 'remove'>,
  firstHeartbeat: Promise<void>,
  maxMs = DEFAULT_MAX_MS
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([firstHeartbeat, new Promise<void>((resolve) => (timer = setTimeout(resolve, maxMs)))])
  } finally {
    clearTimeout(timer)
    await e.remove()
  }
}

/** Where plaintext waits on the PC for a container or the transcriber: the key and job folders, and the job scratch. */
export interface PlaintextDirs {
  /** `%LOCALAPPDATA%\\TolongMeeting\\runs` (`localPaths(...).runs`). */
  runs: string
  /** `%LOCALAPPDATA%\\TolongMeeting\\jobs` (`jobsDir(...)`). */
  jobs: string
}

async function sweepDir(dir: string, failures: unknown[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    try {
      // `Dirent` comes from the listing itself, so a link is a link here and is only unlinked, never followed.
      if (entry.isDirectory()) {
        await sweepDir(path, failures)
        await rmdir(path)
      } else {
        if (entry.isFile()) await zeroFile(path)
        await rm(path, { force: true })
      }
    } catch (error) {
      failures.push(error)
    }
  }
}

/**
 * Run once when the app starts: a crash can leave key files, job files or audio in `runs/` and `jobs/`. Every file
 * under them is overwritten with zeros and deleted, folders included; the two folders themselves stay. A link is
 * removed, never followed. A file or folder that cannot be removed does not stop the others (nor the other folder);
 * the failures are thrown together afterwards as an `AggregateError`, so the caller can log them and go on.
 */
export async function sweepPlaintext(dirs: PlaintextDirs): Promise<void> {
  const failures: unknown[] = []
  for (const dir of [dirs.runs, dirs.jobs]) {
    try {
      const st = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (st === null) continue
      if (!st.isDirectory()) throw new Error('A folder to sweep is not a real folder')
      await sweepDir(dir, failures)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, `${failures.length} plaintext file(s) could not be removed`)
}

/**
 * `sweepPlaintext` for the app's start: what could not be removed is logged (how many, and the error names only: a
 * name never holds a path, a key or a token) and the app starts anyway, so a locked file cannot keep the PC from
 * running meetings.
 */
export async function sweepPlaintextAtStart(dirs: PlaintextDirs, log: (message: string) => void): Promise<void> {
  try {
    await sweepPlaintext(dirs)
  } catch (error) {
    if (!(error instanceof AggregateError)) throw error
    const names = new Set(error.errors.map((e: unknown) => (e instanceof Error ? e.name : typeof e)))
    log(`plaintext sweep: ${error.errors.length} item(s) could not be removed (${[...names].join(', ')})`)
  }
}
