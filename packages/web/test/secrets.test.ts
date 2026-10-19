import { afterAll, beforeAll, expect, test } from 'bun:test'
import { SecretError } from '@tm/core'
import { eq } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aiKeys, members, type Db } from '../db'
import { loadMasterKey, MasterKeyError, openColumn, sealColumn } from '../db/secrets'
import { createTestDb, dropTestDb, seedMember } from '../db/testing'
import { expectNotLogged } from './no-log'

let dir: string
let db: Db

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tm-secrets-'))
  db = await createTestDb()
})

afterAll(async () => {
  await dropTestDb(db)
  await rm(dir, { recursive: true, force: true })
})

test('a master key that is not 32 bytes is refused without echoing it', async () => {
  const f = join(dir, 'short.key')
  await writeFile(f, 'c2hvcnQ=')
  expect(() => loadMasterKey(f)).toThrow('TM_MASTER_KEY_FILE must hold 32 bytes, base64')
  expect(() => loadMasterKey(f)).toThrow(MasterKeyError)
  try {
    loadMasterKey(f)
  } catch (e) {
    expect(String(e)).not.toContain('c2hvcnQ')
  }
})

test('a master key file of 32 bytes in base64 loads, and an unset variable is refused', async () => {
  const key = randomBytes(32)
  const f = join(dir, 'master.key')
  await writeFile(f, `${key.toString('base64')}\n`)
  expect(loadMasterKey(f).equals(key)).toBe(true)
  const saved = process.env.TM_MASTER_KEY_FILE
  delete process.env.TM_MASTER_KEY_FILE
  try {
    expect(() => loadMasterKey()).toThrow('TM_MASTER_KEY_FILE is not set')
  } finally {
    if (saved !== undefined) process.env.TM_MASTER_KEY_FILE = saved
  }
})

test('a sealed column only opens for its member and column', () => {
  const s = sealColumn(Buffer.alloc(32), 'm1', 'ai_keys.dashscope_key', 'sk-test')
  expect(openColumn(Buffer.alloc(32), 'm1', 'ai_keys.dashscope_key', s)).toBe('sk-test')
  expect(() => openColumn(Buffer.alloc(32), 'm2', 'ai_keys.dashscope_key', s)).toThrow(SecretError)
  expect(() => openColumn(Buffer.alloc(32), 'm1', 'members.ntfy_token', s)).toThrow(SecretError)
  expect(() => openColumn(randomBytes(32), 'm1', 'ai_keys.dashscope_key', s)).toThrow(SecretError)
})

test('a secret stored in an *_enc column is ciphertext in Postgres and opens after a round trip', async () => {
  const master = randomBytes(32)
  const secret = `sk-${randomBytes(12).toString('hex')}`
  const { memberId } = await seedMember(db)

  await db
    .update(aiKeys)
    .set({ dashscopeKeyEnc: sealColumn(master, memberId, 'ai_keys.dashscope_key', secret) })
    .where(eq(aiKeys.memberId, memberId))
  await db
    .update(members)
    .set({ ntfyTokenEnc: sealColumn(master, memberId, 'members.ntfy_token', 'tk_ntfy') })
    .where(eq(members.id, memberId))

  const [row] = await db.select().from(aiKeys).where(eq(aiKeys.memberId, memberId))
  expect(row!.dashscopeKeyEnc).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]{22}$/)
  expect(row!.dashscopeKeyEnc).not.toContain(secret)
  expect(openColumn(master, memberId, 'ai_keys.dashscope_key', row!.dashscopeKeyEnc)).toBe(secret)

  const [member] = await db.select().from(members).where(eq(members.id, memberId))
  expect(openColumn(master, memberId, 'members.ntfy_token', member!.ntfyTokenEnc!)).toBe('tk_ntfy')
  // The ntfy token is sealed for its own column: it does not open as the AI key.
  expect(() => openColumn(master, memberId, 'ai_keys.dashscope_key', member!.ntfyTokenEnc!)).toThrow(SecretError)
})

test('sealing, opening and a refused open never log the secret', async () => {
  const master = randomBytes(32)
  const secret = `sk-${randomBytes(12).toString('hex')}`
  await expectNotLogged(secret, async () => {
    const sealed = sealColumn(master, 'm1', 'connections.token', secret)
    openColumn(master, 'm1', 'connections.token', sealed)
    try {
      openColumn(master, 'm2', 'connections.token', sealed)
    } catch (e) {
      console.error(String(e))
    }
  })
})

test('expectNotLogged fails when a secret reaches console or a stream, and restores them', async () => {
  const origLog = console.log
  const origWrite = process.stdout.write
  await expect(expectNotLogged('hunter2', async () => console.log('login with hunter2'))).rejects.toThrow(
    'A secret appeared in captured log output'
  )
  await expect(expectNotLogged('hunter2', async () => void process.stderr.write('x hunter2 y'))).rejects.toThrow(
    'A secret appeared'
  )
  await expect(expectNotLogged('hunter2', async () => console.log('nothing to see'))).resolves.toBeUndefined()
  expect(console.log).toBe(origLog)
  expect(process.stdout.write).toBe(origWrite)
})
