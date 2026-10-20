import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { profileKey } from '@tm/core'
import type { SecretStore } from '../secrets'
import type { DockerLike } from './docker'
import { writeEphemeral } from './ephemeral'

// The local profile vault. A local run keeps the member's browser profile in a Docker volume while it runs, and as
// encrypted checkpoints in a folder on the PC. The key that encrypts them never rests on disk in the clear:
// the PC's key lives in the SecretStore (Electron `safeStorage`), each identity's key is derived from it, and that
// derived key reaches the container only through a short-lived owner-only file that the caller removes after the first
// heartbeat (`removeAfterFirstHeartbeat`). It is never in argv, an env file or a log.

export interface LocalPaths {
  root: string
  data: string
  runs: string
  profiles: string
} // %LOCALAPPDATA%\TolongMeeting and its data, runs, profiles folders

const KEY_BYTES = 32
const VOLUME_PREFIX = 'tm-profile-'
const IDENTITY_ID = /^[A-Za-z0-9_-]{1,64}$/

function assertIdentity(identityId: string): void {
  if (!IDENTITY_ID.test(identityId)) throw new Error('not an identity id')
}

export function localPaths(localAppData: string): LocalPaths {
  const root = join(localAppData, 'TolongMeeting')
  return { root, data: join(root, 'data'), runs: join(root, 'runs'), profiles: join(root, 'profiles') }
}

// Two first calls at once must not each make a key: the second would replace the first and orphan its checkpoints.
const pending = new WeakMap<SecretStore, Promise<Buffer>>()

/** The PC's local key: 32 random bytes, made once and kept only in the SecretStore (as base64 under `safeStorage`). */
export function ensureProfileKey(secrets: SecretStore): Promise<Buffer> {
  const running = pending.get(secrets)
  if (running) return running
  const made = (async () => {
    const stored = await secrets.get('profileKey')
    if (stored !== null) {
      const key = Buffer.from(stored, 'base64')
      if (key.length !== KEY_BYTES) throw new Error('The stored profile key is not 32 bytes')
      return key
    }
    const key = randomBytes(KEY_BYTES)
    await secrets.set('profileKey', key.toString('base64'))
    return key
  })()
  pending.set(secrets, made)
  // A failure is not cached: the next call tries again.
  made.catch(() => pending.delete(secrets))
  return made
}

/** base64 of the identity's key, derived from the local key: the content of `/run/tm/profile.key`. */
export function identityKeyFile(localKey: Buffer, identityId: string): string {
  assertIdentity(identityId)
  return profileKey(localKey, identityId).toString('base64')
}

export function profileVolume(identityId: string): string {
  assertIdentity(identityId)
  return `${VOLUME_PREFIX}${identityId}`
}

/** `<profiles>\<identityId>\checkpoints`: bound into the container at `/tm/profiles/<id>/checkpoints`. */
export function checkpointsDir(p: LocalPaths, identityId: string): string {
  assertIdentity(identityId)
  return join(p.profiles, identityId, 'checkpoints')
}

/**
 * The volume is mounted one level above the profile (`/tm/profiles/<id>/vol`, the profile at `vol/work`). Restore
 * renames a staging folder onto the profile folder, which fails with EBUSY when that folder is itself a mount point.
 */
export function profileMounts(p: LocalPaths, identityId: string): string[] {
  return [
    `${profileVolume(identityId)}:/tm/profiles/${identityId}/vol`,
    `${checkpointsDir(p, identityId)}:/tm/profiles/${identityId}/checkpoints`
  ]
}

export interface CheckpointRun {
  docker: DockerLike
  /** The worker image (the same reference a meeting run uses). */
  image: string
  paths: LocalPaths
  localKey: Buffer
}

/**
 * Checkpoints one identity's volume with a container that runs `checkpoint-only <id>` and nothing else, waits for it
 * and removes it. Throws when it exits non-zero. The key file is removed whatever happens.
 */
export async function checkpointVolume(d: CheckpointRun, identityId: string): Promise<void> {
  assertIdentity(identityId)
  await mkdir(checkpointsDir(d.paths, identityId), { recursive: true })
  await mkdir(d.paths.runs, { recursive: true })
  const key = await writeEphemeral(d.paths.runs, { 'profile.key': identityKeyFile(d.localKey, identityId) })
  const name = `tm-ckpt-${identityId}`
  try {
    await d.docker.rm(name) // a leftover of a crashed checkpoint
    await d.docker.run([
      'run',
      '-d',
      '--name',
      name,
      '--label',
      `tm.identity=${identityId}`,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '256',
      '--memory',
      '1g',
      ...profileMounts(d.paths, identityId).flatMap((v) => ['-v', v]),
      '-v',
      `${key.dir}:/run/tm:ro`,
      '-e',
      'TM_PROFILE_ROOT=/tm/profiles',
      '-e',
      'TM_PROFILE_KEY_FILE=/run/tm/profile.key',
      d.image,
      'checkpoint-only',
      identityId
    ])
    const code = await d.docker.wait(name)
    if (code !== 0) throw new Error(`The profile checkpoint failed (exit ${code})`)
  } finally {
    await d.docker.rm(name)
    await key.remove()
  }
}

/**
 * After a crash a decrypted profile volume can be left on the PC. Every `tm-profile-<id>` volume that no running
 * container claims (label `tm.identity=<id>`) is checkpointed, then removed. A volume in use is left alone. A volume
 * whose checkpoint fails stays (its data is not saved yet); the others are still handled, and the failures are thrown
 * together afterwards. Returns the identity ids that were recovered.
 */
export async function recoverStaleVolumes(d: {
  docker: DockerLike
  checkpoint(identityId: string): Promise<void>
}): Promise<string[]> {
  const volumes = await d.docker.volumes(VOLUME_PREFIX)
  const busy = new Set((await d.docker.running()).flatMap((c) => (c.identityId === null ? [] : [c.identityId])))
  const recovered: string[] = []
  const failures: unknown[] = []
  for (const volume of volumes) {
    const id = volume.slice(VOLUME_PREFIX.length)
    if (busy.has(id)) continue
    try {
      await d.checkpoint(id)
      await d.docker.volumeRm(volume)
      recovered.push(id)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, `${failures.length} profile volume(s) could not be recovered`)
  return recovered
}
