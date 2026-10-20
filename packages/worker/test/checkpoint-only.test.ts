import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkpointOnly } from '../src/profile/checkpoint-only'
import { listCheckpoints, restoreProfile } from '../src/profile/profile'

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const key = Buffer.alloc(32, 5)
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tm-ckpt-'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

// The profile at <root>/u1/vol/work, as the volume mount puts it.
async function profile(files: Record<string, string>): Promise<string> {
  const work = join(root, 'u1', 'vol', 'work')
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(work, name, '..'), { recursive: true })
    await writeFile(join(work, name), content)
  }
  return work
}

test('checkpoint-only writes one checkpoint that restores, and writes nothing else', async () => {
  await profile({ 'Default/Cookies': 'c', 'Default/Cache/x': 'cache' })
  const file = await checkpointOnly('u1', { root, loadProfileKey: () => key })
  expect(file).not.toBeNull()
  expect(await listCheckpoints(join(root, 'u1', 'checkpoints'))).toEqual([file!])
  expect((await readdir(join(root, 'u1'))).sort()).toEqual(['checkpoints', 'vol'])
  // Restoring goes through the strict extraction into vol/work, never onto the mount point `vol`.
  const restored = join(root, 'restored', 'work')
  await mkdir(join(root, 'restored'))
  await restoreProfile(file!, restored, key)
  expect(await Bun.file(join(restored, 'Default/Cookies')).text()).toBe('c')
  expect(await Bun.file(join(restored, 'Default/Cache/x')).exists()).toBe(false)
})

test('a volume with no profile gets no checkpoint, so an empty one never hides a real one', async () => {
  expect(await checkpointOnly('u1', { root, loadProfileKey: () => key })).toBeNull()
  await mkdir(join(root, 'u1', 'vol', 'work'), { recursive: true })
  expect(await checkpointOnly('u1', { root, loadProfileKey: () => key })).toBeNull()
  expect(await listCheckpoints(join(root, 'u1', 'checkpoints'))).toEqual([])
})

test('an identity id that is a path is refused', async () => {
  await expect(checkpointOnly('../u1', { root, loadProfileKey: () => key })).rejects.toThrow()
})

test('the tm-worker mode reads the key file, checkpoints and exits 0 without a job', async () => {
  await profile({ 'Default/Cookies': 'c' })
  const keyFile = join(root, 'profile.key')
  await writeFile(keyFile, key.toString('base64'))
  const env = { ...process.env, TM_PROFILE_ROOT: root, TM_PROFILE_KEY_FILE: keyFile }
  const r = Bun.spawnSync(['bun', cli, '--checkpoint-only', 'u1'], { env, stdout: 'pipe', stderr: 'pipe' })
  expect(r.exitCode).toBe(0)
  expect(r.stderr.toString()).not.toContain(key.toString('base64'))
  const [file] = await listCheckpoints(join(root, 'u1', 'checkpoints'))
  const restored = join(root, 'again')
  await restoreProfile(file!, restored, key)
  expect(await Bun.file(join(restored, 'Default/Cookies')).text()).toBe('c')
})

test('the tm-worker mode needs exactly one identity id, and fails loudly without a key', async () => {
  const run = (...args: string[]) =>
    Bun.spawnSync(['bun', cli, ...args], {
      env: { ...process.env, TM_PROFILE_ROOT: root },
      stdout: 'pipe',
      stderr: 'pipe'
    })
  expect(run('--checkpoint-only').exitCode).toBe(64)
  expect(run('--checkpoint-only', 'u1', '--job', 'x').exitCode).toBe(64)
  await profile({ 'Default/Cookies': 'c' })
  const r = Bun.spawnSync(['bun', cli, '--checkpoint-only', 'u1'], {
    env: { ...process.env, TM_PROFILE_ROOT: root, TM_PROFILE_KEY_FILE: '', TM_MASTER_KEY_FILE: '' },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  expect(r.exitCode).toBe(1)
})
