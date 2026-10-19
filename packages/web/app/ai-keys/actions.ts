import { loadMasterKey } from '../../db/secrets'
import { keyTester, saveAiKeys, testAiKeys, type KeyTestResult } from '../../lib/ai-keys'
import type { MemberScope } from '../../lib/scope'

// Plain functions, not `'use server'` actions yet: the member's scope comes from `requireMember()` (plan 01c Task 5,
// `lib/session.ts`), which doesn't exist yet. The server-action wrappers that call it land with the page. Results carry
// a fixed message or nothing; a saved key is never returned.

/** Saves the member's AI keys and tests them. Returns the test result only. */
export function saveKeysFor(scope: MemberScope, input: unknown): Promise<KeyTestResult> {
  return saveAiKeys(scope, input, { master: loadMasterKey(), tester: keyTester(), now: new Date() })
}

/** Re-tests the member's saved AI keys (the "Test again" button). */
export function testKeysFor(scope: MemberScope): Promise<KeyTestResult> {
  return testAiKeys(scope, { master: loadMasterKey(), tester: keyTester(), now: new Date() })
}
