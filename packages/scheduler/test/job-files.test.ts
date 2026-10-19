import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import {
  ensureMachineId,
  machineIdFor,
  prepareHostDirs,
  removeJobFiles,
  removeStaleJobFiles,
  writeJobFiles
} from '../src/job-files'

let root: string
beforeAll(async () => {
  root = await mkdtemp('/home/user/.cache/tm-tmp/job-files-')
})
afterAll(() => rm(root, { recursive: true, force: true }))

const idn = '22222222-2222-4222-8222-222222222222'
const occ = '11111111-1111-4111-8111-111111111111'

test('job files are private and removeJobFiles deletes both', async () => {
  const base = `${root}/a/job/tm-worker-x-a1`
  const key = Buffer.alloc(32, 9)
  const { jobPath, keyPath } = await writeJobFiles(base, { hello: 'world' }, key)
  expect((await stat(jobPath)).mode & 0o777).toBe(0o600)
  expect((await stat(keyPath)).mode & 0o777).toBe(0o600)
  expect((await stat(`${root}/a/job`)).mode & 0o777).toBe(0o700)
  expect(JSON.parse(await readFile(jobPath, 'utf8'))).toEqual({ hello: 'world' })
  expect(Buffer.from((await readFile(keyPath, 'utf8')).trim(), 'base64')).toEqual(key)
  expect((await readdir(`${root}/a/job`)).sort()).toEqual(['tm-worker-x-a1.json', 'tm-worker-x-a1.key'])
  await removeJobFiles(base)
  expect(await readdir(`${root}/a/job`)).toEqual([])
  await removeJobFiles(base)
})

test('files of other containers are swept and the current one is kept', async () => {
  const dir = `${root}/sweep`
  await mkdir(dir)
  for (const f of ['tm-worker-a-a1.json', 'tm-worker-a-a1.key', 'tm-worker-b-a1.json', 'notes.txt']) {
    await writeFile(`${dir}/${f}`, 'x')
  }
  await removeStaleJobFiles(dir, `${dir}/tm-worker-b-a1`)
  expect((await readdir(dir)).sort()).toEqual(['notes.txt', 'tm-worker-b-a1.json'])
})

test('a machine-id that is a symlink, a hard link or missing is replaced by a regular file', async () => {
  const profileRoot = `${root}/machine`
  const file = await ensureMachineId(profileRoot, idn)
  expect(file).toBe(`${profileRoot}/.machine-ids/${idn}`)
  const want = `${machineIdFor(idn)}\n`
  expect(await readFile(file, 'utf8')).toBe(want)
  expect((await stat(file)).mode & 0o777).toBe(0o644)
  expect((await stat(`${profileRoot}/.machine-ids`)).mode & 0o777).toBe(0o755)

  // A symlink planted in its place: the link is replaced, its target is untouched.
  const target = `${root}/victim`
  await writeFile(target, 'secret')
  await rm(file)
  await symlink(target, file)
  await ensureMachineId(profileRoot, idn)
  expect((await lstat(file)).isSymbolicLink()).toBe(false)
  expect(await readFile(file, 'utf8')).toBe(want)
  expect(await readFile(target, 'utf8')).toBe('secret')

  // A hard link (link count 2) is replaced by a fresh file, so the other name keeps what it had.
  await rm(file)
  await writeFile(`${root}/other-name`, 'other')
  await link(`${root}/other-name`, file)
  await ensureMachineId(profileRoot, idn)
  expect((await lstat(file)).nlink).toBe(1)
  expect(await readFile(file, 'utf8')).toBe(want)
  expect(await readFile(`${root}/other-name`, 'utf8')).toBe('other')
})

test('a machine-id directory or a symlinked .machine-ids is refused', async () => {
  const dirRoot = `${root}/m-dir`
  await mkdir(`${dirRoot}/.machine-ids/${idn}`, { recursive: true })
  await expect(ensureMachineId(dirRoot, idn)).rejects.toThrow()

  const linkRoot = `${root}/m-link`
  await mkdir(linkRoot)
  await mkdir(`${root}/elsewhere`)
  await symlink(`${root}/elsewhere`, `${linkRoot}/.machine-ids`)
  await expect(ensureMachineId(linkRoot, idn)).rejects.toThrow('real directory')
  expect(await readlink(`${linkRoot}/.machine-ids`)).toBe(`${root}/elsewhere`)
})

test('host directories are real directories and a symlinked job dir is refused', async () => {
  const env = { dataRoot: `${root}/prep-data`, profileRoot: `${root}/prep-profiles` }
  const jobDir = await prepareHostDirs(env, idn, occ)
  expect(jobDir).toBe(`${env.profileRoot}/${idn}/job`)
  expect((await stat(jobDir)).mode & 0o777).toBe(0o700)
  expect((await lstat(`${env.dataRoot}/occurrences/${occ}`)).isDirectory()).toBe(true)

  await rm(jobDir, { recursive: true })
  await symlink(`${root}/elsewhere`, jobDir)
  await expect(prepareHostDirs(env, idn, occ)).rejects.toThrow('real directory')
})
