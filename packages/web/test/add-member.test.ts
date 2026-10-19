import { afterAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { members } from '../db'
import { createTestDb, dropAllTestDbs, testDbUrl } from '../db/testing'

afterAll(dropAllTestDbs, 60_000)

const script = join(import.meta.dir, '..', 'scripts', 'add-member.ts')

async function run(databaseUrl: string, ...args: string[]) {
  const proc = Bun.spawn(['bun', 'run', script, ...args], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  return { stdout, stderr, code }
}

test('add-member creates the first admin with a lower-cased login', async () => {
  const db = await createTestDb()
  const r = await run(
    testDbUrl(db),
    '--login',
    'Octo-Admin',
    '--name',
    'Octo Admin',
    '--tz',
    'Asia/Singapore',
    '--admin'
  )
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('Added octo-admin as admin')
  const rows = await db.select().from(members)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    githubLogin: 'octo-admin',
    displayName: 'Octo Admin',
    timeZone: 'Asia/Singapore',
    role: 'admin',
    githubId: null,
    authUserId: null
  })
})

test('add-member makes a plain member by default and refuses a duplicate login', async () => {
  const db = await createTestDb()
  const url = testDbUrl(db)
  expect((await run(url, '--login', 'octo', '--name', 'Octo')).code).toBe(0)
  expect((await db.select().from(members))[0]).toMatchObject({ role: 'member', timeZone: 'Asia/Kuala_Lumpur' })
  const again = await run(url, '--login', 'OCTO', '--name', 'Octo Again')
  expect(again.code).not.toBe(0)
  expect(await db.$count(members)).toBe(1)
})

test('add-member rejects a bad login, a bad zone and a missing name before touching the database', async () => {
  const db = await createTestDb()
  const url = testDbUrl(db)
  for (const args of [
    ['--login', 'not a login', '--name', 'X'],
    ['--login', 'octo', '--name', 'X', '--tz', 'Mars/Base'],
    ['--login', 'octo']
  ]) {
    const r = await run(url, ...args)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('Usage:')
  }
  expect(await db.$count(members)).toBe(0)
})
