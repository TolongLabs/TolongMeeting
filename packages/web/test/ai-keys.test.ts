import { afterAll, beforeAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { AiKeyError, type AiConfig } from '@tm/ai'
import { aiKeys, type Db } from '../db'
import { createTestDb, dropAllTestDbs, seedMember } from '../db/testing'
import { aiConfigFor } from '../db/job-config'
import {
  AiKeysInputSchema,
  hasWorkingKey,
  keyTester,
  MODELSCOPE_BASE_URL,
  saveAiKeys,
  testAiKeys,
  type KeyDeps,
  type KeyTester
} from '../lib/ai-keys'
import { createScope, type MemberScope } from '../lib/scope'
import { expectNotLogged } from './no-log'

let db: Db

beforeAll(async () => {
  db = await createTestDb()
})

afterAll(async () => {
  await dropAllTestDbs()
})

const now = new Date('2026-10-20T09:00:00Z')
const master = Buffer.alloc(32, 7)
const ok: KeyTester = {
  dashscope: async () => ({ ok: true }),
  modelscope: async () => ({ ok: true })
}

/** A member with an identity and profile but no AI key row. */
async function seedBare(): Promise<MemberScope> {
  const { memberId } = await seedMember(db, { full: false })
  await db.delete(aiKeys).where(eq(aiKeys.memberId, memberId))
  return createScope(db, memberId)
}

function deps(tester: KeyTester): KeyDeps {
  return { master, tester, now }
}

function keyError(status: 401 | 402 | 429): AiKeyError {
  return new AiKeyError(status, `AI request failed with HTTP ${status}`)
}

const chatOk = async (): Promise<string> => 'OK'

/** A DashScope chat fake that fails with `error`. */
function chatFailing(error: unknown): Parameters<typeof keyTester>[0] {
  return async () => {
    throw error
  }
}

const cfg: AiConfig = aiConfigFor({ dashscopeKey: 'sk-test-1234', workspaceId: null })

/** A ModelScope fetch fake that answers with `status`, or fails to connect when `status` is `null`. */
function fetchAnswering(status: number | null, calls: { url: string; auth: string | null }[] = []) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') })
    if (status === null) throw new TypeError('fetch failed')
    return new Response('{}', { status })
  }
}

test('a Workspace ID must be a plain identifier', () => {
  expect(
    AiKeysInputSchema.safeParse({
      dashscopeKey: 'sk-test-1234',
      workspaceId: 'evil.example/x'
    }).success
  ).toBe(false)
})

test('the key must be 8 to 200 characters with no whitespace, and a blank optional field is absent', () => {
  expect(AiKeysInputSchema.safeParse({ dashscopeKey: 'short' }).success).toBe(false)
  expect(AiKeysInputSchema.safeParse({ dashscopeKey: 'sk-has space-1234' }).success).toBe(false)
  expect(AiKeysInputSchema.safeParse({ dashscopeKey: 'x'.repeat(201) }).success).toBe(false)
  expect(
    AiKeysInputSchema.safeParse({ dashscopeKey: 'sk-test-1234', workspaceId: '', modelscopeKey: '' }).success
  ).toBe(true)
})

test('saving seals the key and records a passing test', async () => {
  const scope = await seedBare()
  expect(await saveAiKeys(scope, { dashscopeKey: 'sk-test-1234' }, deps(ok))).toEqual({ ok: true })
  const [row] = await scope.select(aiKeys)
  expect(row!.dashscopeKeyEnc).toMatch(/^v1\./)
  expect(row!.dashscopeKeyEnc).not.toContain('sk-test-1234')
  expect(row!.testOk).toBe(true)
  expect(row!.testedAt).toEqual(now)
  expect(await hasWorkingKey(scope)).toBe(true)
})

test('invalid input is refused and nothing is stored', async () => {
  const scope = await seedBare()
  expect(await saveAiKeys(scope, { dashscopeKey: 'short' }, deps(ok))).toEqual({
    ok: false,
    error: 'Check the key and Workspace ID. Keys are 8 to 200 characters with no spaces.'
  })
  expect(await scope.select(aiKeys)).toEqual([])
})

test('a rejected key is recorded with the region hint', async () => {
  const scope = await seedBare()
  const tester = keyTester(chatFailing(keyError(401)))
  const r = await saveAiKeys(scope, { dashscopeKey: 'sk-test-1234' }, deps(tester))
  const message = 'DashScope rejected the key. Check it is a Singapore (international) region key.'
  expect(r).toEqual({ ok: false, error: message })
  const [row] = await scope.select(aiKeys)
  expect(row!.testError).toBe(message)
  expect(row!.testOk).toBe(false)
  expect(await hasWorkingKey(scope)).toBe(false)
})

test('the key is never logged', async () => {
  const scope = await seedBare()
  const tester = keyTester(chatFailing(new Error('boom sk-secret-123456')))
  await expectNotLogged('sk-secret-123456', () => saveAiKeys(scope, { dashscopeKey: 'sk-secret-123456' }, deps(tester)))
})

test('DashScope failures map to the fixed messages, and the provider text never reaches the store', async () => {
  const cases: [unknown, string][] = [
    [keyError(402), 'The DashScope account is out of credit.'],
    [keyError(429), 'DashScope is rate-limiting this key or its quota is used up.'],
    [new Error('socket hang up sk-leak-98765'), 'Could not reach DashScope. Try again in a minute.']
  ]
  for (const [error, message] of cases) {
    expect(await keyTester(chatFailing(error)).dashscope(cfg)).toEqual({ ok: false, error: message })
  }
  const scope = await seedBare()
  await saveAiKeys(scope, { dashscopeKey: 'sk-test-1234' }, deps(keyTester(chatFailing(new Error('sk-leak-98765')))))
  const [row] = await scope.select(aiKeys)
  expect(row!.testError).toBe('Could not reach DashScope. Try again in a minute.')
})

test('the DashScope test sends one short chat to qwen-flash on the given endpoint', async () => {
  const seen: unknown[][] = []
  const chat = async (...args: unknown[]): Promise<string> => {
    seen.push(args)
    return 'OK'
  }
  expect(await keyTester(chat).dashscope(cfg)).toEqual({ ok: true })
  expect(seen).toEqual([[cfg, 'qwen-flash', [{ role: 'user', content: 'Reply with OK.' }], 10_000]])
})

test('ModelScope is tested with the key in a Bearer header, never in the URL', async () => {
  const calls: { url: string; auth: string | null }[] = []
  expect(await keyTester(undefined, fetchAnswering(200, calls)).modelscope('ms-key-123456')).toEqual({ ok: true })
  expect(calls).toEqual([{ url: `${MODELSCOPE_BASE_URL}/models`, auth: 'Bearer ms-key-123456' }])
  expect(calls[0]!.url).not.toContain('ms-key-123456')
})

test('ModelScope failures map to the fixed messages', async () => {
  const tester = (status: number | null) => keyTester(undefined, fetchAnswering(status)).modelscope('ms-key-123456')
  expect(await tester(401)).toEqual({ ok: false, error: 'ModelScope rejected the key.' })
  expect(await tester(403)).toEqual({ ok: false, error: 'ModelScope rejected the key.' })
  expect(await tester(500)).toEqual({ ok: false, error: 'Could not reach ModelScope.' })
  expect(await tester(null)).toEqual({ ok: false, error: 'Could not reach ModelScope.' })
})

test('a failing optional ModelScope key is reported and stored without blocking scheduling', async () => {
  const scope = await seedBare()
  const tester = keyTester(chatOk, fetchAnswering(401))
  const r = await saveAiKeys(scope, { dashscopeKey: 'sk-test-1234', modelscopeKey: 'ms-key-123456' }, deps(tester))
  expect(r).toEqual({ ok: false, error: 'ModelScope rejected the key.' })
  const [row] = await scope.select(aiKeys)
  expect(row!.modelscopeKeyEnc).toMatch(/^v1\./)
  expect(row!.modelscopeKeyEnc).not.toContain('ms-key-123456')
  expect(row!.modelscopeTestOk).toBe(false)
  expect(row!.testOk).toBe(true)
  expect(await hasWorkingKey(scope)).toBe(true)
})

test('Test again opens the saved key, tests it on its own endpoint, and stores the new result', async () => {
  const scope = await seedBare()
  await saveAiKeys(scope, { dashscopeKey: 'sk-test-1234', workspaceId: 'ws-abc123' }, deps(ok))

  const seen: AiConfig[] = []
  const recheck: KeyTester = {
    dashscope: async (c) => {
      seen.push(c)
      return { ok: false, error: 'The DashScope account is out of credit.' }
    },
    modelscope: async () => ({ ok: true })
  }
  expect(await testAiKeys(scope, deps(recheck))).toEqual({
    ok: false,
    error: 'The DashScope account is out of credit.'
  })
  expect(seen).toEqual([aiConfigFor({ dashscopeKey: 'sk-test-1234', workspaceId: 'ws-abc123' })])
  expect(seen[0]!.baseUrl).toBe('https://ws-abc123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1')
  expect(await hasWorkingKey(scope)).toBe(false)
})

test('Test again with no saved key says so', async () => {
  const scope = await seedBare()
  expect(await testAiKeys(scope, deps(ok))).toEqual({ ok: false, error: 'No DashScope key is saved yet.' })
})

test('another member cannot read or re-test this member’s key', async () => {
  const owner = await seedBare()
  await saveAiKeys(owner, { dashscopeKey: 'sk-test-1234' }, deps(ok))
  const other = await seedBare()
  expect(await hasWorkingKey(other)).toBe(false)
  expect(await testAiKeys(other, deps(ok))).toEqual({ ok: false, error: 'No DashScope key is saved yet.' })
})
