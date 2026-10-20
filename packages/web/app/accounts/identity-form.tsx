'use client'

import { useActionState } from 'react'
import { FormField } from '../../components/FormField'
import { Notice } from '../../components/Notice'
import { SubmitButton } from '../../components/SubmitButton'
import { saveIdentityFormAction } from './form-actions'
import type { IdentityFormState, IdentityFormValues } from './form-state'

/** Adds an identity (no `identityId`) or edits one. `prefix` keeps the field ids unique when the page holds several forms. */
export function IdentityForm(props: { prefix: string; identityId?: string; initial: IdentityFormValues }) {
  const [state, action] = useActionState<IdentityFormState, FormData>(saveIdentityFormAction, { status: 'idle' })
  const shown = state.status === 'error' ? state.values : props.initial
  const errors = state.status === 'error' ? state.fields : {}
  const { prefix } = props
  return (
    <form action={action} noValidate>
      {props.identityId && <input type="hidden" name="id" value={props.identityId} />}
      {state.status === 'error' && state.message && <Notice kind="error">{state.message}</Notice>}
      <FormField id={`${prefix}-name`} label="Name" hint="For example University or Work." error={errors.name}>
        {(p) => <input {...p} name="name" defaultValue={shown.name} required maxLength={40} />}
      </FormField>
      <FormField
        id={`${prefix}-zoom`}
        label="Zoom display name for guest joins"
        hint="The name the bot shows when it joins a Zoom meeting without signing in."
        error={errors.zoomGuestName}
      >
        {(p) => <input {...p} name="zoomGuestName" defaultValue={shown.zoomGuestName} required maxLength={64} />}
      </FormField>
      <FormField
        id={`${prefix}-org`}
        label="Organisation name (optional)"
        hint="Fill this in and the email domain together, or leave both empty."
        error={errors.orgName}
      >
        {(p) => <input {...p} name="orgName" defaultValue={shown.orgName} maxLength={100} />}
      </FormField>
      <FormField
        id={`${prefix}-domain`}
        label="Organisation email domain (optional)"
        hint="For example uni.edu.my."
        error={errors.orgEmailDomain}
      >
        {(p) => <input {...p} name="orgEmailDomain" defaultValue={shown.orgEmailDomain} maxLength={253} />}
      </FormField>
      <SubmitButton pendingLabel="Saving...">{props.identityId ? 'Save settings' : 'Add identity'}</SubmitButton>
    </form>
  )
}
