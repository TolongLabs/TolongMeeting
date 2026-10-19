import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { FakeNotifier } from '@tm/web/db/notifier'
import { FakeQueue } from '@tm/web/db/testing'
import { FakeDocker, backupCommands, runBackup, type LaunchDeps } from '../src/index'

test('backups dump the database, copy checkpoints and expire copies older than 7 days', () => {
  expect(
    backupCommands({
      date: '2026-10-21',
      databaseUrl: 'postgres://tm@postgres/tm',
      remote: 'tm-backup:',
      workDir: '/tmp/tm-backup',
      checkpoints: [{ identityId: 'i1', path: '/srv/tolongmeeting/profiles/i1/checkpoints/20261021T060500Z.tar.enc' }]
    })
  ).toEqual([
    ['pg_dump', '--format=custom', '--dbname=postgres://tm@postgres/tm', '--file=/tmp/tm-backup/2026-10-21/db.dump'],
    ['rclone', 'copyto', '/tmp/tm-backup/2026-10-21/db.dump', 'tm-backup:2026-10-21/db.dump'],
    [
      'rclone',
      'copyto',
      '/srv/tolongmeeting/profiles/i1/checkpoints/20261021T060500Z.tar.enc',
      'tm-backup:2026-10-21/profiles/i1.tar.enc'
    ],
    ['rclone', 'delete', '--min-age', '7d', 'tm-backup:'],
    ['rclone', 'rmdirs', '--leave-root', 'tm-backup:']
  ])
})

test('a remote path without a trailing separator gets a slash', () => {
  const cmds = backupCommands({
    date: '2026-10-21',
    databaseUrl: 'postgres://x',
    remote: 'tm-backup:nightly',
    workDir: '/w',
    checkpoints: []
  })
  expect(cmds[1]![3]).toBe('tm-backup:nightly/2026-10-21/db.dump')
})

const DB_URL = 'postgres://tm:s3cret-pass@postgres/tm'
let root: string
beforeAll(async () => {
  root = await mkdtemp('/home/user/.cache/tm-tmp/backup-')
})
afterAll(() => rm(root, { recursive: true, force: true }))

function depsFor(profileRoot: string, run: (argv: string[]) => Promise<number>) {
  const base: LaunchDeps = {
    db: undefined as never,
    queue: new FakeQueue(),
    docker: new FakeDocker(),
    notifier: new FakeNotifier(),
    master: Buffer.alloc(32, 3),
    env: { dataRoot: `${root}/data`, profileRoot, publicUrl: 'https://tm.example', ntfyUrl: 'https://ntfy.tm.example' }
  }
  return { ...base, remote: 'tm-backup:', databaseUrl: DB_URL, run }
}

const logs: string[] = []
const spies = [
  spyOn(console, 'log').mockImplementation((...a) => void logs.push(a.join(' '))),
  spyOn(console, 'error').mockImplementation((...a) => void logs.push(a.join(' ')))
]
afterEach(() => (logs.length = 0))
afterAll(() => spies.forEach((s) => s.mockRestore()))

test('runBackup runs the commands in order with each identity newest checkpoint, logs no arguments and removes the dump', async () => {
  const profileRoot = `${root}/p1`
  const a = '11111111-1111-4111-8111-111111111111'
  const b = '22222222-2222-4222-8222-222222222222'
  for (const [id, files] of [
    [a, ['20261020T000000Z.tar.enc', '20261021T060500Z.tar.enc']],
    [b, ['20261019T000000Z.tar.enc']]
  ] as const) {
    await mkdir(`${profileRoot}/${id}/checkpoints`, { recursive: true })
    for (const f of files) await writeFile(`${profileRoot}/${id}/checkpoints/${f}`, 'x')
  }
  // Identities with no checkpoint, and names that are not identities, are not backed up.
  await mkdir(`${profileRoot}/33333333-3333-4333-8333-333333333333/work`, { recursive: true })
  await mkdir(`${profileRoot}/.machine-ids`, { recursive: true })

  const ran: string[][] = []
  let workDir = ''
  await runBackup(
    depsFor(profileRoot, async (argv) => {
      ran.push(argv)
      if (argv[0] === 'pg_dump') {
        const file = argv[3]!.slice('--file='.length)
        workDir = file.slice(0, file.indexOf('/2026-11-17/'))
        await writeFile(file, 'dump')
      }
      return 0
    }),
    new Date('2026-11-17T19:00:00Z')
  )

  expect(ran).toEqual(
    backupCommands({
      date: '2026-11-17',
      databaseUrl: DB_URL,
      remote: 'tm-backup:',
      workDir,
      checkpoints: [
        { identityId: a, path: `${profileRoot}/${a}/checkpoints/20261021T060500Z.tar.enc` },
        { identityId: b, path: `${profileRoot}/${b}/checkpoints/20261019T000000Z.tar.enc` }
      ]
    })
  )
  expect(workDir.startsWith(tmpdir())).toBe(true)
  await expect(stat(workDir)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(logs).toEqual([
    'backup: pg_dump exited 0',
    'backup: rclone exited 0',
    'backup: rclone exited 0',
    'backup: rclone exited 0',
    'backup: rclone exited 0',
    'backup: rclone exited 0'
  ])
})

test('a failing step stops the backup, names only the program, never the database URL, and still removes the dump', async () => {
  const profileRoot = `${root}/p2`
  await mkdir(profileRoot)
  let workDir = ''
  let calls = 0
  const err = await runBackup(
    depsFor(profileRoot, async (argv) => {
      calls++
      workDir = argv[3]!.slice('--file='.length).replace(/\/2026-11-17\/db\.dump$/, '')
      await writeFile(argv[3]!.slice('--file='.length), 'dump')
      return 1
    }),
    new Date('2026-11-17T19:00:00Z')
  ).then(
    () => null,
    (e: Error) => e
  )
  expect(err?.message).toBe('backup step failed: pg_dump exited 1')
  expect(calls).toBe(1)
  await expect(readdir(workDir)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(logs.join('\n')).not.toContain('s3cret')
  expect(String(err?.stack)).not.toContain('s3cret')
})
