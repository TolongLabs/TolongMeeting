import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { profileKey } from '@tm/core'
import { SecretStore, type SafeStorageLike } from '../src/secrets'
import { checkRunArgs } from '../src/local/docker'
import type { DockerLike } from '../src/local/docker'
import { removeAfterFirstHeartbeat, writeEphemeral } from '../src/local/ephemeral'
import {
  checkpointsDir,
  checkpointVolume,
  ensureProfileKey,
  identityKeyFile,
  localPaths,
  profileMounts,
  profileVolume,
  recoverStaleVolumes
} from '../src/local/vault'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tm-vault-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const fakeSafe = (): SafeStorageLike => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().replace(/^enc:/, '')
})

const IMAGE = 'ghcr.io/tl/tolongmeeting-worker:1.0.0'

// A DockerLike that records what it is asked and refuses any `run` the real allow-list would refuse.
function fakeDocker(init: {
  volumes?: string[]
  running?: { name: string; identityId: string | null }[]
  exit?: number
}) {
  const log = { runs: [] as string[][], removedVolumes: [] as string[], removedContainers: [] as string[], keyFile: '' }
  const docker: DockerLike = {
    info: async () => ({ memTotal: 1 }),
    imagePresent: async () => true,
    pull: async () => true,
    run: async (args) => {
      checkRunArgs(args)
      log.runs.push(args)
      const mount = args.find((a) => a.endsWith(':/run/tm:ro'))!
      const folder = mount.slice(0, -':/run/tm:ro'.length)
      // The key file exists while the container would run.
      log.keyFile = join(folder, 'profile.key')
      expect(existsSync(log.keyFile)).toBe(true)
      return 'id'
    },
    wait: async () => init.exit ?? 0,
    stop: async () => {},
    rm: async (name) => {
      log.removedContainers.push(name)
    },
    volumeRm: async (name) => {
      log.removedVolumes.push(name)
    },
    volumes: async (prefix) => (init.volumes ?? []).filter((v) => v.startsWith(prefix)),
    running: async () => init.running ?? [],
    port: async () => null,
    ensureNetwork: async () => {}
  }
  return { docker, log }
}

test('the profile key is 32 bytes, made once, and kept only in the SecretStore', async () => {
  const file = join(dir, 'secrets.json')
  const secrets = new SecretStore(file, fakeSafe())
  const [a, b] = await Promise.all([ensureProfileKey(secrets), ensureProfileKey(secrets)])
  expect(a.length).toBe(32)
  expect(b.equals(a)).toBe(true)
  expect((await ensureProfileKey(secrets)).equals(a)).toBe(true)
  // A new store over the same file reads the same key; the file never holds the key in the clear.
  expect((await ensureProfileKey(new SecretStore(file, fakeSafe()))).equals(a)).toBe(true)
  const text = await Bun.file(file).text()
  expect(text).not.toContain(a.toString('base64'))
  expect(text).not.toContain(a.toString('hex'))
})

test('the key file holds the per-identity key derived from the local key', () => {
  expect(
    Buffer.from(identityKeyFile(Buffer.alloc(32), 'i1'), 'base64').equals(profileKey(Buffer.alloc(32), 'i1'))
  ).toBe(true)
  expect(identityKeyFile(Buffer.alloc(32), 'i1')).not.toBe(identityKeyFile(Buffer.alloc(32), 'i2'))
  expect(() => identityKeyFile(Buffer.alloc(32), '../x')).toThrow()
})

test('names and folders follow the identity id', () => {
  const p = localPaths(join(dir, 'Local'))
  expect(p.profiles).toBe(join(dir, 'Local', 'TolongMeeting', 'profiles'))
  expect(profileVolume('u1')).toBe('tm-profile-u1')
  expect(checkpointsDir(p, 'u1')).toBe(join(p.profiles, 'u1', 'checkpoints'))
  // The volume is mounted above the profile folder, so the restore rename never targets a mount point.
  expect(profileMounts(p, 'u1')[0]).toBe('tm-profile-u1:/tm/profiles/u1/vol')
  expect(profileMounts(p, 'u1')[1]).toEndWith(':/tm/profiles/u1/checkpoints')
})

test('short-lived files go after the first heartbeat, or after 120 s at most', async () => {
  const e = await writeEphemeral(dir, { 'job.json': '{}', 'profile.key': 'a2V5' })
  let beat!: () => void
  const done = removeAfterFirstHeartbeat(e, new Promise<void>((r) => (beat = r)), 1000)
  expect(existsSync(join(e.dir, 'profile.key'))).toBe(true)
  beat()
  await done
  expect(existsSync(e.dir)).toBe(false)
  const e2 = await writeEphemeral(dir, { 'profile.key': 'a2V5' })
  await removeAfterFirstHeartbeat(e2, new Promise(() => {}), 20)
  expect(existsSync(e2.dir)).toBe(false)
})

test('short-lived files are removed even when the heartbeat fails, and refuse paths as names', async () => {
  const e = await writeEphemeral(dir, { 'profile.key': 'a2V5' })
  await expect(removeAfterFirstHeartbeat(e, Promise.reject(new Error('no beat')), 1000)).rejects.toThrow('no beat')
  expect(existsSync(e.dir)).toBe(false)
  await expect(writeEphemeral(dir, { '../escape': 'x' })).rejects.toThrow()
  expect(readdirSync(dir)).toEqual([])
})

test('a stale profile volume is checkpointed, then removed; a volume in use is left alone', async () => {
  const { docker, log } = fakeDocker({
    volumes: ['tm-profile-u1', 'tm-profile-u2'],
    running: [{ name: 'tm-run-o1-1', identityId: 'u1' }]
  })
  const checkpointed: string[] = []
  expect(
    await recoverStaleVolumes({
      docker,
      checkpoint: async (id) => {
        checkpointed.push(id)
      }
    })
  ).toEqual(['u2'])
  expect(checkpointed).toEqual(['u2'])
  expect(log.removedVolumes).toEqual(['tm-profile-u2'])
})

test('a volume whose checkpoint fails is kept, and the others are still recovered', async () => {
  const { docker, log } = fakeDocker({ volumes: ['tm-profile-u1', 'tm-profile-u2'] })
  const attempt = recoverStaleVolumes({
    docker,
    checkpoint: async (id) => {
      if (id === 'u1') throw new Error('checkpoint failed')
    }
  })
  await expect(attempt).rejects.toBeInstanceOf(AggregateError)
  expect(log.removedVolumes).toEqual(['tm-profile-u2'])
})

test('the checkpoint container passes the docker allow-list, gets its key from a file, and leaves nothing behind', async () => {
  const p = localPaths(dir)
  const { docker, log } = fakeDocker({})
  const localKey = Buffer.alloc(32, 9)
  await checkpointVolume({ docker, image: IMAGE, paths: p, localKey }, 'u1')
  const args = log.runs[0]!
  expect(args.slice(-3)).toEqual([IMAGE, 'checkpoint-only', 'u1'])
  expect(args).toContain('tm-profile-u1:/tm/profiles/u1/vol')
  // The checkpoint needs no network at all.
  expect(args.join(' ')).toContain('--network none')
  // The key is on no command line and in no environment value.
  expect(args.join(' ')).not.toContain(identityKeyFile(localKey, 'u1'))
  expect(existsSync(log.keyFile)).toBe(false)
  expect(log.removedContainers.at(-1)).toBe('tm-ckpt-u1')
})

test('a checkpoint container that fails throws, and its key file is still removed', async () => {
  const { docker, log } = fakeDocker({ exit: 1 })
  await expect(
    checkpointVolume({ docker, image: IMAGE, paths: localPaths(dir), localKey: Buffer.alloc(32, 9) }, 'u1')
  ).rejects.toThrow('exit 1')
  expect(existsSync(log.keyFile)).toBe(false)
})
