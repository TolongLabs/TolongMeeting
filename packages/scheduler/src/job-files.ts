import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { machineIdPath } from './container-spec'

/** The uid the worker image runs as. Bind-mounted host files are owned by it, so the scheduler must run as it too. */
export const WORKER_UID = 1000

/** A host directory or identity the launcher refuses. The message names paths and uids only, never values. */
export class HostDirError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostDirError'
  }
}

/** The uid workers run as: `WORKER_UID`, or `TM_WORKER_UID` on a host that maps it differently (and in tests). */
function expectedUid(): number {
  const raw = process.env.TM_WORKER_UID
  if (raw === undefined || raw === '') return WORKER_UID
  const uid = Number(raw)
  if (!Number.isInteger(uid) || uid < 0) throw new HostDirError(`TM_WORKER_UID must be a user id, got ${raw}`)
  return uid
}

async function writeAtomic(path: string, data: string | Uint8Array, mode: number): Promise<void> {
  const tmp = `${dirname(path)}/.tmp.${randomBytes(8).toString('hex')}`
  try {
    // chmod on the open handle, so a path swapped for a symlink in between can't redirect it.
    const file = await open(tmp, 'wx', mode)
    try {
      await file.writeFile(data)
      await file.chmod(mode)
    } finally {
      await file.close()
    }
    await rename(tmp, path)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
}

/**
 * Writes `<base>.json` (the job) and `<base>.key` (the profile key, base64) with mode 0600, each through a temp file in
 * the same directory and a rename, so a worker never reads half a file. A missing directory is created with mode 0700.
 */
export async function writeJobFiles(
  base: string,
  job: object,
  key: Buffer
): Promise<{ jobPath: string; keyPath: string }> {
  await mkdir(dirname(base), { recursive: true, mode: 0o700 })
  const jobPath = `${base}.json`
  const keyPath = `${base}.key`
  try {
    await writeAtomic(keyPath, `${key.toString('base64')}\n`, 0o600)
    await writeAtomic(jobPath, JSON.stringify(job), 0o600)
  } catch (e) {
    await removeJobFiles(base)
    throw e
  }
  return { jobPath, keyPath }
}

/** Deletes `<base>.json` and `<base>.key`. A file that is already gone is fine. */
export async function removeJobFiles(base: string): Promise<void> {
  await Promise.all([rm(`${base}.json`, { force: true }), rm(`${base}.key`, { force: true })])
}

const JOB_FILE_RE = /^(tm-(?:worker|signin)-.+)\.(?:json|key)$/
const TMP_FILE_RE = /^\.tmp\.[0-9a-f]+$/

/**
 * Deletes the job and key files of earlier containers in `dir`, and any `.tmp.<hex>` file a crash left half-written
 * (it can hold the key). `keepBase` (a file base) is left alone.
 */
export async function removeStaleJobFiles(dir: string, keepBase: string): Promise<void> {
  const keep = keepBase.slice(keepBase.lastIndexOf('/') + 1)
  for (const name of await readdir(dir)) {
    const m = JOB_FILE_RE.exec(name)
    if (TMP_FILE_RE.test(name) || (m && m[1] !== keep)) await rm(`${dir}/${name}`, { force: true })
  }
}

/**
 * Finds the job-file bases (`<profileRoot>/<identityId>/job/tm-worker-...`) left on disk, and deletes leftover
 * `.tmp.<hex>` files on the way. Hidden directories (`.machine-ids`) and symlinks are not entered.
 */
export async function findJobFileBases(profileRoot: string): Promise<string[]> {
  const bases = new Set<string>()
  const identities = await readdir(profileRoot, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return []
    throw e
  })
  for (const identity of identities) {
    if (!identity.isDirectory() || identity.name.startsWith('.')) continue
    const dir = `${profileRoot}/${identity.name}/job`
    const info = await lstat(dir).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return null
      throw e
    })
    if (!info?.isDirectory()) continue
    for (const name of await readdir(dir)) {
      const m = JOB_FILE_RE.exec(name)
      if (m) bases.add(`${dir}/${m[1]}`)
      else if (TMP_FILE_RE.test(name)) await rm(`${dir}/${name}`, { force: true })
    }
  }
  return [...bases]
}

/**
 * Creates `path` when missing and requires it to be a real directory (a symlink or a file is refused) that is owned by
 * `uid` (default: the worker uid) and that no other user can write to.
 */
export async function ensureRealDir(path: string, mode: number, uid: number = expectedUid()): Promise<void> {
  await mkdir(path, { mode }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'EEXIST') throw e
  })
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new HostDirError(`${path} must be a real directory`)
  if (info.uid !== uid) throw new HostDirError(`${path} must be owned by uid ${uid}, not uid ${info.uid}`)
  if ((info.mode & 0o022) !== 0) throw new HostDirError(`${path} must not be writable by group or others`)
}

/** The first 32 hex characters of sha256(identity id): the same machine id `run-job.sh` writes. */
export const machineIdFor = (identityId: string): string =>
  createHash('sha256').update(identityId).digest('hex').slice(0, 32)

/**
 * Makes sure the identity's machine-id file is a regular file with one link, in a real `.machine-ids` directory (mode
 * 755). Anything else (a symlink, a directory, a hard-linked file, nothing) is replaced through a temp file in the same
 * directory and a rename, which swaps a symlink itself and never what it points at.
 */
export async function ensureMachineId(profileRoot: string, identityId: string): Promise<string> {
  const dir = `${profileRoot}/.machine-ids`
  await mkdir(profileRoot, { recursive: true, mode: 0o755 })
  await ensureRealDir(dir, 0o755)
  await chmod(dir, 0o755)
  const file = machineIdPath(profileRoot, identityId)
  const info = await lstat(file).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null
    throw e
  })
  if (!info || !info.isFile() || info.nlink !== 1) await writeAtomic(file, `${machineIdFor(identityId)}\n`, 0o644)
  return file
}

/**
 * Prepares the host paths a worker container binds, as real directories: the occurrence's data directory, the
 * identity's profile directory and its `job/` directory (mode 0700). Returns the `job/` directory. The scheduler must
 * run as the worker uid (1000, or `TM_WORKER_UID`): it never chowns, and it refuses existing directories owned by
 * another user or writable by group or others.
 */
export async function prepareHostDirs(
  env: { dataRoot: string; profileRoot: string },
  identityId: string,
  occurrenceId: string
): Promise<string> {
  const want = expectedUid()
  const actual = process.getuid?.()
  if (actual !== want) {
    throw new HostDirError(
      `the scheduler must run as uid ${want} (the worker uid) so that bind-mounted files are shared; it runs as uid ${actual}`
    )
  }
  await ensureMachineId(env.profileRoot, identityId)
  await mkdir(`${env.dataRoot}/occurrences`, { recursive: true, mode: 0o755 })
  await ensureRealDir(`${env.dataRoot}/occurrences/${occurrenceId}`, 0o755)
  const profileDir = `${env.profileRoot}/${identityId}`
  await ensureRealDir(profileDir, 0o755)
  const jobDir = `${profileDir}/job`
  await ensureRealDir(jobDir, 0o700)
  return jobDir
}
