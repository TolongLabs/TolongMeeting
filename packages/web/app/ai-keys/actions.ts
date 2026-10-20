'use server'

import { loadMasterKey } from '../../db/secrets'
import { keyTester, saveAiKeys, testAiKeys, type KeyTestResult } from '../../lib/ai-keys'
import { requireMember } from '../../lib/session'

// Server actions: public endpoints, so each gets the member from the session and never from client input. Results carry
// a fixed message or nothing; a saved key is never returned.

/** Saves the member's AI keys and tests them. Returns the test result only. */
export async function saveKeys(input: unknown): Promise<KeyTestResult> {
  const scope = await requireMember()
  return saveAiKeys(scope, input, { master: loadMasterKey(), tester: keyTester(), now: new Date() })
}

/** Re-tests the member's saved AI keys (the "Test again" button). */
export async function testKeys(): Promise<KeyTestResult> {
  const scope = await requireMember()
  return testAiKeys(scope, { master: loadMasterKey(), tester: keyTester(), now: new Date() })
}
