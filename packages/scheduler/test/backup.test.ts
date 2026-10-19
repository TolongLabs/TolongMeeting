import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { FakeNotifier } from '@tm/web/db/notifier'
import { FakeQueue } from '@tm/web/db/testing'
import {
  FakeDocker,
  backupCommands,
  expiryCommands,
  postgresEnv,
  runBackup,
  type CommandResult,
  type LaunchDeps
} from '../src/index'

test('backups dump the database, copy checkpoints and list the dated folders', () => {
  expect(
    backupCommands({
      date: '2026-10-21',
      remote: 'tm-backup:',
      workDir: '/tmp/tm-backup',
      checkpoints: [{ identityId: 'i1', path: '/srv/tolongmeeting/profiles/i1/checkpoints/20261021T060500Z.tar.enc' }]
    })
  ).toEqual([
    ['pg_dump', '--format=custom', '--file=/tmp/tm-backup/2026-10-21/db.dump'],
    ['rclone', 'copyto', '/tmp/tm-backup/2026-10-21/db.dump', 'tm-backup:2026-10-21/db.dump'],
    [
      'rclone',
      'copyto',
      '/srv/tolongmeeting/profiles/i1/checkpoints/20261021T060500Z.tar.enc',
      'tm-backup:2026-10-21/profiles/i1.tar.enc'
    ],
    ['rclone', 'lsf', '--dirs-only', 'tm-backup:']
  ])
})

test('only dated folders more than 7 days old are purged, by their date', () => {
  const listing = ['2026-11-17/', '2026-11-10/', '2026-11-09/', '2026-10-01/', 'old-notes/', '2026-13-99x/', ''].join(
    '\n'
  )
  expect(expiryCommands('tm-backup:nightly', listing, new Date('2026-11-17T19:00:00Z'))).toEqual([
    ['rclone', 'purge', 'tm-backup:nightly/2026-10-01'],
    ['rclone', 'purge', 'tm-backup:nightly/2026-11-09']
  ])
})

test('the database URL becomes libpq environment variables', () => {
  expect(postgresEnv('postgres://tm:p%40ss%2Fword@db.internal:5433/tm_prod?sslmode=require')).toEqual({
    PGHOST: 'db.internal',
    PGPORT: '5433',
    PGUSER: 'tm',
    PGPASSWORD: 'p@ss/word',
    PGDATABASE: 'tm_prod',
    PGSSLMODE: 'require'
  })
  expect(() => postgresEnv('postgres://tm@db/tm?options=-c%20x')).toThrow('not supported')
})

test('a remote path without a trailing separator gets a slash', () => {
  const cmds = backupCommands({
    date: '2026-10-21',
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

type Run = (argv: string[], opts?: { env?: Record<string, string>; capture?: boolean }) => Promise<CommandResult>
const ok = (stdout = ''): CommandResult => ({ code: 0, stdout })

function depsFor(profileRoot: string, run: Run) {
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
  const envs: (Record<string, string> | undefined)[] = []
  let workDir = ''
  await runBackup(
    depsFor(profileRoot, async (argv, opts) => {
      ran.push(argv)
      envs.push(opts?.env)
      if (argv[0] === 'pg_dump') {
        const file = argv[2]!.slice('--file='.length)
        workDir = file.slice(0, file.indexOf('/2026-11-17/'))
        await writeFile(file, 'dump')
      }
      return ok()
    }),
    new Date('2026-11-17T19:00:00Z')
  )

  expect(ran).toEqual(
    backupCommands({
      date: '2026-11-17',
      remote: 'tm-backup:',
      workDir,
      checkpoints: [
        { identityId: a, path: `${profileRoot}/${a}/checkpoints/20261021T060500Z.tar.enc` },
        { identityId: b, path: `${profileRoot}/${b}/checkpoints/20261019T000000Z.tar.enc` }
      ]
    })
  )
  // The password is in the pg_dump environment only, never in an argument.
  expect(ran.flat().join(' ')).not.toContain('s3cret')
  expect(envs[0]).toEqual({ PGHOST: 'postgres', PGUSER: 'tm', PGPASSWORD: 's3cret-pass', PGDATABASE: 'tm' })
  expect(envs.slice(1).every((e) => e === undefined)).toBe(true)
  expect(workDir.startsWith(tmpdir())).toBe(true)
  await expect(stat(workDir)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(logs).toEqual([
    'backup: pg_dump exited 0',
    'backup: rclone exited 0',
    'backup: rclone exited 0',
    'backup: rclone exited 0',
    'backup: rclone exited 0'
  ])
})

test('an old checkpoint uploaded tonight is kept, and only date folders older than 7 days are purged', async () => {
  const profileRoot = `${root}/p3`
  const idle = '44444444-4444-4444-8444-444444444444'
  const file = `${profileRoot}/${idle}/checkpoints/20261018T000000Z.tar.enc`
  await mkdir(`${profileRoot}/${idle}/checkpoints`, { recursive: true })
  await writeFile(file, 'x')
  const thirtyDaysAgo = new Date('2026-10-18T00:00:00Z')
  await utimes(file, thirtyDaysAgo, thirtyDaysAgo)

  const ran: string[][] = []
  await runBackup(
    depsFor(profileRoot, async (argv, opts) => {
      ran.push(argv)
      if (argv[0] === 'pg_dump') await writeFile(argv[2]!.slice('--file='.length), 'dump')
      // The remote already holds tonight's folder (with the 30-day-old checkpoint), a 7-day-old and an 8-day-old one.
      return argv[1] === 'lsf' && opts?.capture ? ok('2026-11-17/\n2026-11-10/\n2026-11-09/\n') : ok()
    }),
    new Date('2026-11-17T19:00:00Z')
  )

  expect(ran.some((a) => a.join(' ').includes('7d') || a.includes('delete'))).toBe(false)
  expect(ran.filter((a) => a[1] === 'copyto').map((a) => a[3])).toEqual([
    'tm-backup:2026-11-17/db.dump',
    `tm-backup:2026-11-17/profiles/${idle}.tar.enc`
  ])
  expect(ran.filter((a) => a[1] === 'purge')).toEqual([['rclone', 'purge', 'tm-backup:2026-11-09']])
  expect(ran.at(-1)).toEqual(['rclone', 'purge', 'tm-backup:2026-11-09'])
})

test('a failing step stops the backup, names only the program, never the database URL, and still removes the dump', async () => {
  const profileRoot = `${root}/p2`
  await mkdir(profileRoot)
  let workDir = ''
  let calls = 0
  const err = await runBackup(
    depsFor(profileRoot, async (argv) => {
      calls++
      workDir = argv[2]!.slice('--file='.length).replace(/\/2026-11-17\/db\.dump$/, '')
      await writeFile(argv[2]!.slice('--file='.length), 'dump')
      return { code: 1, stdout: '' }
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
