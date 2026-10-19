import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { machineIdPath } from './container-spec'

async function writeAtomic(path: string, data: string | Uint8Array, mode: number): Promise<void> {
  const tmp = `${dirname(path)}/.tmp.${randomBytes(8).toString('hex')}`
  try {
    await writeFile(tmp, data, { flag: 'wx', mode })
    await chmod(tmp, mode)
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

/** Deletes the job and key files of earlier containers in `dir`; `keepBase` (a file base) is left alone. */
export async function removeStaleJobFiles(dir: string, keepBase: string): Promise<void> {
  const keep = keepBase.slice(keepBase.lastIndexOf('/') + 1)
  for (const name of await readdir(dir)) {
    const m = /^(tm-(?:worker|signin)-.+)\.(?:json|key)$/.exec(name)
    if (m && m[1] !== keep) await rm(`${dir}/${name}`, { force: true })
  }
}

/** Creates `path` when missing and requires it to be a real directory: a symlink or a file is refused. */
export async function ensureRealDir(path: string, mode: number): Promise<void> {
  await mkdir(path, { mode }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'EEXIST') throw e
  })
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${path} must be a real directory`)
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
 * identity's profile directory and its `job/` directory (mode 0700). Returns the `job/` directory.
 */
export async function prepareHostDirs(
  env: { dataRoot: string; profileRoot: string },
  identityId: string,
  occurrenceId: string
): Promise<string> {
  await ensureMachineId(env.profileRoot, identityId)
  await mkdir(`${env.dataRoot}/occurrences`, { recursive: true, mode: 0o755 })
  await ensureRealDir(`${env.dataRoot}/occurrences/${occurrenceId}`, 0o755)
  const profileDir = `${env.profileRoot}/${identityId}`
  await ensureRealDir(profileDir, 0o755)
  const jobDir = `${profileDir}/job`
  await ensureRealDir(jobDir, 0o700)
  return jobDir
}
