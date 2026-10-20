'use server'

import { redirect } from 'next/navigation'
import { loadMasterKey } from '../../db/secrets'
import { AiKeysInputSchema, keyTester, removeAiKey, updateAiKeys, type KeyProvider } from '../../lib/ai-keys'
import { requireMember } from '../../lib/session'
import { testKeys } from './actions'
import type { KeyFormState } from './form-state'

// The AI key forms' handlers. They take only the form and get the member from the session. A key is read from the form
// once, sealed by the lib, and never put in a result, a redirect or a log.

const KEY_ERROR = 'Enter a key of 8 to 200 characters with no spaces.'
const WORKSPACE_ERROR = 'A Workspace ID is 3 to 64 letters, digits or dashes.'
const NO_KEY_YET = 'Enter your DashScope key.'

const text = (formData: FormData, name: string) => {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

function providerOf(formData: FormData): KeyProvider {
  const provider = formData.get('provider')
  if (provider !== 'dashscope' && provider !== 'modelscope') redirect('/ai-keys')
  return provider
}

/** Saves the DashScope key and Workspace ID, or the ModelScope key, keeps the rest, tests the keys and goes back to the page. */
export async function saveKeyFormAction(_previous: KeyFormState, formData: FormData): Promise<KeyFormState> {
  const scope = await requireMember()
  const provider = providerOf(formData)
  const fields: Record<string, string> = {}
  const patch: { dashscopeKey?: string; workspaceId?: string; modelscopeKey?: string } = {}

  if (provider === 'dashscope') {
    const key = text(formData, 'dashscope-key')
    const workspaceId = text(formData, 'workspace-id')
    if (key !== '') {
      if (!AiKeysInputSchema.shape.dashscopeKey.safeParse(key).success) fields['dashscope-key'] = KEY_ERROR
      patch.dashscopeKey = key
    }
    if (!AiKeysInputSchema.shape.workspaceId.safeParse(workspaceId).success) fields['workspace-id'] = WORKSPACE_ERROR
    patch.workspaceId = workspaceId
  } else {
    const key = text(formData, 'modelscope-key')
    if (!AiKeysInputSchema.shape.dashscopeKey.safeParse(key).success) fields['modelscope-key'] = KEY_ERROR
    patch.modelscopeKey = key
  }
  if (Object.keys(fields).length > 0) return { status: 'error', fields }

  const result = await updateAiKeys(scope, patch, { master: loadMasterKey(), tester: keyTester(), now: new Date() })
  if (!result.ok && result.error.startsWith('Add a DashScope key first')) {
    return provider === 'dashscope'
      ? { status: 'error', fields: { 'dashscope-key': NO_KEY_YET } }
      : { status: 'error', message: result.error, fields: {} }
  }
  redirect(`/ai-keys?notice=${result.ok ? 'saved' : 'saved-failing'}`)
}

/** Tests the saved keys again and goes back to the page, which shows the result. */
export async function testKeyFormAction(): Promise<void> {
  await requireMember()
  const result = await testKeys()
  redirect(`/ai-keys?notice=${result.ok ? 'tested' : 'tested-failing'}`)
}

/** Removes the key named by the form (`provider`) and goes back to the page. */
export async function removeKeyFormAction(formData: FormData): Promise<void> {
  const scope = await requireMember()
  const provider = providerOf(formData)
  await removeAiKey(scope, provider)
  redirect(`/ai-keys?notice=removed-${provider}`)
}
