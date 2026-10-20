import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { AiKeyError, chatText, type AiConfig } from '@tm/ai'
import { aiConfigFor, WORKSPACE_ID_PATTERN } from '../db/job-config'
import { aiKeys } from '../db/schema'
import { openColumn, sealColumn } from '../db/secrets'
import type { MemberScope } from './scope'

export const MODELSCOPE_BASE_URL = 'https://api-inference.modelscope.cn/v1'

const KEY_TEST_TIMEOUT_MS = 10_000
const INPUT_ERROR = 'Check the key and Workspace ID. Keys are 8 to 200 characters with no spaces.'
const NOT_SAVED = 'No DashScope key is saved yet.'

// A blank form field means "not given", not an invalid value.
const blankAsAbsent = (value: unknown) => (value === '' ? undefined : value)
const KEY = z.string().min(8).max(200).regex(/^\S+$/)

export const AiKeysInputSchema = z.object({
  dashscopeKey: KEY,
  workspaceId: z.preprocess(blankAsAbsent, z.string().regex(WORKSPACE_ID_PATTERN).optional()),
  modelscopeKey: z.preprocess(blankAsAbsent, KEY.optional())
})

export type KeyTestResult = { ok: true } | { ok: false; error: string }

/** Checks keys against the providers. The results are fixed messages, never the provider's own text. */
export interface KeyTester {
  dashscope(cfg: AiConfig): Promise<KeyTestResult>
  modelscope(key: string): Promise<KeyTestResult>
}

export interface KeyDeps {
  master: Buffer
  tester: KeyTester
  now: Date
}

const DASHSCOPE_REGION_ERROR = 'DashScope rejected the key. Check it is a Singapore (international) region key.'

function dashscopeError(e: unknown): string {
  if (e instanceof AiKeyError) {
    if (e.status === 401) return DASHSCOPE_REGION_ERROR
    if (e.status === 402) return 'The DashScope account is out of credit.'
    return 'DashScope is rate-limiting this key or its quota is used up.'
  }
  return 'Could not reach DashScope. Try again in a minute.'
}

/**
 * The real key tester. `chat` and `fetchFn` default to the live providers; tests pass fakes. Only the provider call is
 * caught: any failure becomes one of the fixed messages.
 */
export function keyTester(
  chat: typeof chatText = chatText,
  fetchFn: (input: string, init?: RequestInit) => Promise<Response> = fetch
): KeyTester {
  return {
    async dashscope(cfg) {
      try {
        await chat(cfg, 'qwen-flash', [{ role: 'user', content: 'Reply with OK.' }], KEY_TEST_TIMEOUT_MS)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: dashscopeError(e) }
      }
    },
    async modelscope(key) {
      try {
        const res = await fetchFn(`${MODELSCOPE_BASE_URL}/models`, {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(KEY_TEST_TIMEOUT_MS)
        })
        await res.body?.cancel()
        if (res.ok) return { ok: true }
        if (res.status === 401 || res.status === 403) return { ok: false, error: 'ModelScope rejected the key.' }
        return { ok: false, error: 'Could not reach ModelScope.' }
      } catch {
        return { ok: false, error: 'Could not reach ModelScope.' }
      }
    }
  }
}

interface PlainKeys {
  dashscopeKey: string
  workspaceId: string | null
  modelscopeKey: string | null
}

type AiKeyValues = Omit<typeof aiKeys.$inferInsert, 'memberId'>

/** Seals the keys, runs both tests and stores the outcome. The DashScope result gates scheduling; ModelScope is optional. */
async function checkAndStore(scope: MemberScope, deps: KeyDeps, keys: PlainKeys): Promise<KeyTestResult> {
  const dashscopeKeyEnc = sealColumn(deps.master, scope.memberId, 'ai_keys.dashscope_key', keys.dashscopeKey)
  const modelscopeKeyEnc = keys.modelscopeKey
    ? sealColumn(deps.master, scope.memberId, 'ai_keys.modelscope_key', keys.modelscopeKey)
    : null

  const dashscope = await deps.tester.dashscope(
    aiConfigFor({ dashscopeKey: keys.dashscopeKey, workspaceId: keys.workspaceId })
  )
  const modelscope = keys.modelscopeKey ? await deps.tester.modelscope(keys.modelscopeKey) : null

  const failure = [dashscope, modelscope].find((r): r is { ok: false; error: string } => r !== null && !r.ok)
  const values: AiKeyValues = {
    dashscopeKeyEnc,
    workspaceId: keys.workspaceId,
    modelscopeKeyEnc,
    testOk: dashscope.ok,
    testError: failure?.error ?? null,
    testedAt: deps.now,
    modelscopeTestOk: modelscope ? modelscope.ok : null,
    updatedAt: deps.now
  }
  const updated = await scope.update(aiKeys, values, eq(aiKeys.memberId, scope.memberId))
  if (updated === 0) await scope.insert(aiKeys, values)
  return failure ?? { ok: true }
}

/** Validates and saves the member's keys, then tests them. The key is sealed before it is stored and never returned. */
export async function saveAiKeys(scope: MemberScope, input: unknown, deps: KeyDeps): Promise<KeyTestResult> {
  const parsed = AiKeysInputSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: INPUT_ERROR }
  return checkAndStore(scope, deps, {
    dashscopeKey: parsed.data.dashscopeKey,
    workspaceId: parsed.data.workspaceId ?? null,
    modelscopeKey: parsed.data.modelscopeKey ?? null
  })
}

/** Re-tests the saved keys (the "Test again" button). */
export async function testAiKeys(scope: MemberScope, deps: KeyDeps): Promise<KeyTestResult> {
  const [row] = await scope.select(aiKeys)
  if (!row) return { ok: false, error: NOT_SAVED }
  return checkAndStore(scope, deps, {
    dashscopeKey: openColumn(deps.master, scope.memberId, 'ai_keys.dashscope_key', row.dashscopeKeyEnc),
    workspaceId: row.workspaceId,
    modelscopeKey: row.modelscopeKeyEnc
      ? openColumn(deps.master, scope.memberId, 'ai_keys.modelscope_key', row.modelscopeKeyEnc)
      : null
  })
}

/** True when the saved DashScope key passed its last test. Scheduling needs this. */
export async function hasWorkingKey(scope: MemberScope): Promise<boolean> {
  const rows = await scope.select(aiKeys, eq(aiKeys.testOk, true))
  return rows.length > 0
}

export type KeyProvider = 'dashscope' | 'modelscope'

/** What the AI keys page shows. A key is never in it: only the last four characters of each. */
export interface AiKeyStatus {
  dashscopeSuffix: string
  workspaceId: string | null
  /** False when the last test of the DashScope key failed. */
  dashscopeOk: boolean
  modelscope: { suffix: string; ok: boolean | null } | null
  /** The fixed sentence from the last failed test, or `null`. */
  testError: string | null
  testedAt: Date | null
}

const ADD_DASHSCOPE_FIRST = 'Add a DashScope key first. ModelScope is an extra key and cannot be saved alone.'

/**
 * The part of a key the page may show: its last four characters, and only when the key is long enough that they are a
 * small part of it. A short key shows nothing at all.
 */
export function keySuffix(key: string): string {
  return key.length >= 24 ? key.slice(-4) : ''
}

/** The member's saved keys as the page may show them, or `null` when none is saved. */
export async function loadAiKeyStatus(scope: MemberScope, master: Buffer): Promise<AiKeyStatus | null> {
  const [row] = await scope.select(aiKeys)
  if (!row) return null
  return {
    dashscopeSuffix: keySuffix(openColumn(master, scope.memberId, 'ai_keys.dashscope_key', row.dashscopeKeyEnc)),
    workspaceId: row.workspaceId,
    dashscopeOk: row.testOk,
    modelscope: row.modelscopeKeyEnc
      ? {
          suffix: keySuffix(openColumn(master, scope.memberId, 'ai_keys.modelscope_key', row.modelscopeKeyEnc)),
          ok: row.modelscopeTestOk
        }
      : null,
    testError: row.testError,
    testedAt: row.testedAt
  }
}

/**
 * Adds or replaces one provider's key (or the Workspace ID) and keeps the rest of what is saved, then tests all keys.
 * `workspaceId` present, even blank, sets or clears the Workspace ID. ModelScope cannot be saved without a DashScope key.
 */
export async function updateAiKeys(
  scope: MemberScope,
  patch: { dashscopeKey?: string; workspaceId?: string; modelscopeKey?: string },
  deps: KeyDeps
): Promise<KeyTestResult> {
  const [row] = await scope.select(aiKeys)
  const open = (column: 'dashscope_key' | 'modelscope_key', sealed: string) =>
    openColumn(deps.master, scope.memberId, `ai_keys.${column}`, sealed)
  const dashscopeKey = patch.dashscopeKey ?? (row ? open('dashscope_key', row.dashscopeKeyEnc) : undefined)
  if (dashscopeKey === undefined) return { ok: false, error: ADD_DASHSCOPE_FIRST }
  return saveAiKeys(
    scope,
    {
      dashscopeKey,
      workspaceId: 'workspaceId' in patch ? patch.workspaceId : (row?.workspaceId ?? undefined),
      modelscopeKey:
        patch.modelscopeKey ?? (row?.modelscopeKeyEnc ? open('modelscope_key', row.modelscopeKeyEnc) : undefined)
    },
    deps
  )
}

/**
 * Removes one provider's key. DashScope is the required key, so removing it removes the row, ModelScope key included.
 * Removing the ModelScope key keeps the DashScope key and its last test.
 */
export async function removeAiKey(scope: MemberScope, provider: KeyProvider): Promise<void> {
  if (provider === 'dashscope') {
    await scope.remove(aiKeys, eq(aiKeys.memberId, scope.memberId))
    return
  }
  const [row] = await scope.select(aiKeys)
  if (!row) return
  await scope.update(
    aiKeys,
    { modelscopeKeyEnc: null, modelscopeTestOk: null, ...(row.testOk && { testError: null }), updatedAt: new Date() },
    eq(aiKeys.memberId, scope.memberId)
  )
}
