'use client'

import { useActionState, useState } from 'react'
import { FormField } from '../../components/FormField'
import { Notice } from '../../components/Notice'
import { SubmitButton } from '../../components/SubmitButton'
import { saveKeyFormAction } from './form-actions'
import type { KeyFormState } from './form-state'

const IDLE: KeyFormState = { status: 'idle' }

/**
 * The form for one provider's key. The key box is write-only: it is always empty, because the page never has the saved
 * key. `saved` says a key is saved, so a DashScope form may leave the key blank to change only the Workspace ID.
 */
export function KeyForm(props: { provider: 'dashscope' | 'modelscope'; saved: boolean; workspaceId: string | null }) {
  const [state, action] = useActionState(saveKeyFormAction, IDLE)
  // A failed save keeps the Workspace ID the member typed, not the saved one the page was rendered with.
  const [workspaceId, setWorkspaceId] = useState(props.workspaceId ?? '')
  const errors = state.status === 'error' ? state.fields : {}
  const dashscope = props.provider === 'dashscope'
  const keyId = dashscope ? 'dashscope-key' : 'modelscope-key'
  return (
    <form action={action}>
      {state.status === 'error' && state.message && <Notice kind="error">{state.message}</Notice>}
      <input type="hidden" name="provider" value={props.provider} />
      <FormField
        id={keyId}
        label={
          props.saved
            ? `Replace the ${dashscope ? 'DashScope' : 'ModelScope'} key`
            : `${dashscope ? 'DashScope' : 'ModelScope'} key`
        }
        hint={
          dashscope
            ? `Use a Singapore (international) region key. ${props.saved ? 'Leave this empty to keep the saved key. ' : ''}The key is never shown again after you save it.`
            : 'The key is never shown again after you save it.'
        }
        error={errors[keyId]}
      >
        {(field) => <input {...field} name={keyId} type="password" autoComplete="off" spellCheck={false} />}
      </FormField>
      {dashscope && (
        <FormField
          id="workspace-id"
          label="Workspace ID (optional)"
          hint="Use this only if Alibaba Cloud gave you a workspace for the Singapore region. Empty means the standard endpoint."
          error={errors['workspace-id']}
        >
          {(field) => (
            <input
              {...field}
              name="workspace-id"
              type="text"
              autoComplete="off"
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.target.value)}
            />
          )}
        </FormField>
      )}
      <SubmitButton pendingLabel="Saving and testing...">
        {props.saved ? 'Save and test' : `Add the ${dashscope ? 'DashScope' : 'ModelScope'} key`}
      </SubmitButton>
    </form>
  )
}
