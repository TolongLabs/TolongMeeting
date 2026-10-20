'use client'

import { useActionState } from 'react'
import { FormField } from '../../components/FormField'
import { Notice } from '../../components/Notice'
import { SubmitButton } from '../../components/SubmitButton'
import { addMemberAction } from './actions'
import type { AddMemberState } from './form-state'

const IDLE: AddMemberState = { status: 'idle' }

/** Adds a member to the allow-list. A refused form keeps what was typed and ties each problem to its field. */
export function AddMemberForm() {
  const [state, action] = useActionState(addMemberAction, IDLE)
  const errors = state.status === 'error' ? state.fields : {}
  const values = state.status === 'error' ? state.values : {}
  return (
    <form action={action}>
      {state.status === 'error' && state.message && <Notice kind="error">{state.message}</Notice>}
      <FormField
        id="github-login"
        label="GitHub username"
        hint="The person signs in with this GitHub account. They must also belong to the GitHub organisation."
        error={errors.githubLogin}
      >
        {(field) => (
          <input {...field} name="githubLogin" defaultValue={values.githubLogin} autoComplete="off" required />
        )}
      </FormField>
      <FormField id="display-name" label="Name" error={errors.displayName}>
        {(field) => (
          <input {...field} name="displayName" defaultValue={values.displayName} autoComplete="off" required />
        )}
      </FormField>
      <FormField
        id="time-zone"
        label="Time zone"
        hint="For example Asia/Kuala_Lumpur. The member can change it later."
        error={errors.timeZone}
      >
        {(field) => (
          <input
            {...field}
            name="timeZone"
            defaultValue={values.timeZone ?? 'Asia/Kuala_Lumpur'}
            autoComplete="off"
            required
          />
        )}
      </FormField>
      <FormField id="role" label="Role" error={errors.role}>
        {(field) => (
          <select {...field} name="role" defaultValue={values.role ?? 'member'}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        )}
      </FormField>
      <SubmitButton pendingLabel="Adding...">Add member</SubmitButton>
    </form>
  )
}
