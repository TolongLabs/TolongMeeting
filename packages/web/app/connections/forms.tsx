'use client'

import { useActionState } from 'react'
import { FormField } from '../../components/FormField'
import { Notice } from '../../components/Notice'
import { SubmitButton } from '../../components/SubmitButton'
import { defaultFolderAction, saveGitHubAction } from './actions'
import type { FolderFormState, GitHubFields, GitHubFormState } from './form-state'

const IDLE = { status: 'idle' } as const

/**
 * The GitHub settings and the token. The token box is write-only: it is always empty, because the page never has the
 * saved token. With a connection saved, an empty box keeps the saved token. `fields` are the saved settings.
 */
export function GitHubForm(props: { fields: GitHubFields; connected: boolean }) {
  const [state, action] = useActionState<GitHubFormState, FormData>(saveGitHubAction, IDLE)
  const shown = state.status === 'error' ? state.values : props.fields
  return (
    <form action={action}>
      {state.status === 'error' && <Notice kind="error">{state.message}</Notice>}
      <FormField id="github-owner" label="Repository owner">
        {(field) => <input {...field} name="owner" defaultValue={shown.owner} autoComplete="off" required />}
      </FormField>
      <FormField id="github-repo" label="Repository name">
        {(field) => <input {...field} name="repo" defaultValue={shown.repo} autoComplete="off" required />}
      </FormField>
      <FormField id="github-branch" label="Branch">
        {(field) => <input {...field} name="branch" defaultValue={shown.branch} autoComplete="off" required />}
      </FormField>
      <FormField id="github-folder" label="Folder" hint="Leave blank for the top level of the repository.">
        {(field) => <input {...field} name="folder" defaultValue={shown.folder} autoComplete="off" />}
      </FormField>
      <FormField
        id="github-token"
        label={props.connected ? 'Replace the token' : 'Token'}
        hint={`${props.connected ? 'Leave this empty to keep the saved token. ' : ''}The token is never shown again after you save it.`}
      >
        {(field) => (
          <input
            {...field}
            name="token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            required={!props.connected}
          />
        )}
      </FormField>
      <SubmitButton pendingLabel="Checking with GitHub...">
        {props.connected ? 'Save and check' : 'Connect GitHub'}
      </SubmitButton>
    </form>
  )
}

/** The button that sends exports back to the default Drive folder. */
export function DefaultFolderForm() {
  const [state, action] = useActionState<FolderFormState, FormData>(defaultFolderAction, IDLE)
  return (
    <form action={action}>
      <SubmitButton pendingLabel="Saving...">Use &ldquo;TolongMeeting Exports&rdquo;</SubmitButton>
      {state.status === 'error' && <Notice kind="error">{state.message}</Notice>}
    </form>
  )
}
