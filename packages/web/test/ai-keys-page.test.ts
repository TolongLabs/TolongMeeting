import { afterAll, beforeAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { aiKeys, type Db } from '../db'
import { createTestDb, dropAllTestDbs, seedMember } from '../db/testing'
import { loadAiKeyStatus, removeAiKey, updateAiKeys, type KeyDeps, type KeyTester } from '../lib/ai-keys'
import { createScope, type MemberScope } from '../lib/scope'

let db: Db

beforeAll(async () => {
  db = await createTestDb()
})

afterAll(async () => {
  await dropAllTestDbs()
})

const master = Buffer.alloc(32, 7)
const now = new Date('2026-10-20T09:00:00Z')
const DASH = 'sk-dashscope-secret-1234'
const MODEL = 'ms-modelscope-secret-5678'
const tester = (modelscopeOk = true): KeyTester => ({
  dashscope: async () => ({ ok: true }),
  modelscope: async () => (modelscopeOk ? { ok: true } : { ok: false, error: 'ModelScope rejected the key.' })
})
const deps = (t: KeyTester = tester()): KeyDeps => ({ master, tester: t, now })

async function seedBare(): Promise<MemberScope> {
  const { memberId } = await seedMember(db, { full: false })
  await db.delete(aiKeys).where(eq(aiKeys.memberId, memberId))
  return createScope(db, memberId)
}

test('the status of a member with no key is null', async () => {
  expect(await loadAiKeyStatus(await seedBare(), master)).toBeNull()
})

test('the status shows the last four characters and never a whole key', async () => {
  const scope = await seedBare()
  expect(await updateAiKeys(scope, { dashscopeKey: DASH, modelscopeKey: MODEL }, deps())).toEqual({ ok: true })
  const status = await loadAiKeyStatus(scope, master)
  expect(status).toMatchObject({ dashscopeSuffix: '1234', dashscopeOk: true, modelscope: { suffix: '5678', ok: true } })
  expect(status!.testedAt).toEqual(now)
  const json = JSON.stringify(status)
  expect(json).not.toContain(DASH)
  expect(json).not.toContain(MODEL)
})

test('changing the Workspace ID keeps both saved keys', async () => {
  const scope = await seedBare()
  await updateAiKeys(scope, { dashscopeKey: DASH, modelscopeKey: MODEL }, deps())
  await updateAiKeys(scope, { workspaceId: 'ws-team-1' }, deps())
  expect(await loadAiKeyStatus(scope, master)).toMatchObject({
    dashscopeSuffix: '1234',
    workspaceId: 'ws-team-1',
    modelscope: { suffix: '5678' }
  })
  await updateAiKeys(scope, { workspaceId: '' }, deps())
  expect((await loadAiKeyStatus(scope, master))!.workspaceId).toBeNull()
})

test('a ModelScope key cannot be saved without a DashScope key', async () => {
  const scope = await seedBare()
  const result = await updateAiKeys(scope, { modelscopeKey: MODEL }, deps())
  expect(result).toEqual({ ok: false, error: expect.stringContaining('Add a DashScope key first') })
  expect(await loadAiKeyStatus(scope, master)).toBeNull()
})

test('a failing test is saved with its fixed sentence', async () => {
  const scope = await seedBare()
  await updateAiKeys(scope, { dashscopeKey: DASH, modelscopeKey: MODEL }, deps(tester(false)))
  expect(await loadAiKeyStatus(scope, master)).toMatchObject({
    dashscopeOk: true,
    modelscope: { ok: false },
    testError: 'ModelScope rejected the key.'
  })
})

test('removing the ModelScope key keeps the DashScope key and clears the ModelScope failure', async () => {
  const scope = await seedBare()
  await updateAiKeys(scope, { dashscopeKey: DASH, modelscopeKey: MODEL }, deps(tester(false)))
  await removeAiKey(scope, 'modelscope')
  expect(await loadAiKeyStatus(scope, master)).toMatchObject({
    dashscopeSuffix: '1234',
    dashscopeOk: true,
    modelscope: null,
    testError: null
  })
})

test('removing the DashScope key removes the row, and removing again does nothing', async () => {
  const scope = await seedBare()
  await updateAiKeys(scope, { dashscopeKey: DASH, modelscopeKey: MODEL }, deps())
  await removeAiKey(scope, 'dashscope')
  expect(await loadAiKeyStatus(scope, master)).toBeNull()
  await removeAiKey(scope, 'dashscope')
  await removeAiKey(scope, 'modelscope')
})

test("removing one member's key leaves another member's key", async () => {
  const a = await seedBare()
  const b = await seedBare()
  await updateAiKeys(a, { dashscopeKey: DASH }, deps())
  await updateAiKeys(b, { dashscopeKey: 'sk-other-key-9999' }, deps())
  await removeAiKey(a, 'dashscope')
  expect((await loadAiKeyStatus(b, master))!.dashscopeSuffix).toBe('9999')
})
