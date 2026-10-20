'use client'

import { useActionState } from 'react'
import { FormField } from '../../components/FormField'
import { Notice } from '../../components/Notice'
import { SubmitButton } from '../../components/SubmitButton'
import { saveDetailsFormAction } from './form-actions'
import type { DetailsFormState } from './form-state'

const IDLE: DetailsFormState = { status: 'idle' }

export interface DetailRow {
  key: string
  label: string
  value: string
  labels: string[]
  hint?: string
}

/**
 * The details form. The built-in rows are fixed; `custom` holds the member's own pairs and then some empty rows.
 * After a failed save the form keeps what the member typed.
 */
export function DetailsForm(props: {
  builtin: DetailRow[]
  custom: { name: string; value: string; labels: string[] }[]
  mentionNames: string[]
  mentionHint: string
}) {
  const [state, action] = useActionState(saveDetailsFormAction, IDLE)
  const errors = state.status === 'error' ? state.fields : {}
  const typed = (name: string, initial: string) => (state.status === 'error' ? (state.values[name] ?? '') : initial)
  const lines = (list: string[]) => list.join('\n')

  return (
    <form action={action}>
      {state.status === 'error' && (
        <Notice kind="error">
          {state.message ?? 'Nothing was saved. Fix the fields marked Error and save again.'}
        </Notice>
      )}

      <fieldset>
        <legend>Your details</legend>
        {props.builtin.map((row) => (
          <div key={row.key}>
            <FormField id={`value-${row.key}`} label={row.label} hint={row.hint} error={errors[`value-${row.key}`]}>
              {(field) => (
                <input
                  {...field}
                  name={`value-${row.key}`}
                  type="text"
                  defaultValue={typed(`value-${row.key}`, row.value)}
                />
              )}
            </FormField>
            <FormField
              id={`labels-${row.key}`}
              label={`Other names for ${row.label.toLowerCase()}, one per line (optional)`}
              error={errors[`labels-${row.key}`]}
            >
              {(field) => (
                <textarea
                  {...field}
                  name={`labels-${row.key}`}
                  rows={2}
                  defaultValue={typed(`labels-${row.key}`, lines(row.labels))}
                />
              )}
            </FormField>
          </div>
        ))}
      </fieldset>

      <fieldset>
        <legend>Your own details</legend>
        <p>
          Add anything else a form may ask for, such as a staff number or a matric number. Leave a row empty to skip it.
          To remove a detail, clear its name and value.
        </p>
        {props.custom.map((row, i) => (
          <div key={i}>
            <FormField id={`custom-name-${i}`} label={`Detail ${i + 1}: name`} error={errors[`custom-name-${i}`]}>
              {(field) => (
                <input
                  {...field}
                  name={`custom-name-${i}`}
                  type="text"
                  defaultValue={typed(`custom-name-${i}`, row.name)}
                />
              )}
            </FormField>
            <FormField id={`custom-value-${i}`} label={`Detail ${i + 1}: value`} error={errors[`custom-value-${i}`]}>
              {(field) => (
                <input
                  {...field}
                  name={`custom-value-${i}`}
                  type="text"
                  defaultValue={typed(`custom-value-${i}`, row.value)}
                />
              )}
            </FormField>
            <FormField
              id={`custom-labels-${i}`}
              label={`Detail ${i + 1}: other names, one per line (optional)`}
              error={errors[`custom-labels-${i}`]}
            >
              {(field) => (
                <textarea
                  {...field}
                  name={`custom-labels-${i}`}
                  rows={2}
                  defaultValue={typed(`custom-labels-${i}`, lines(row.labels))}
                />
              )}
            </FormField>
          </div>
        ))}
      </fieldset>

      <fieldset>
        <legend>Names you answer to</legend>
        <FormField
          id="mention-names"
          label="Names, one per line"
          hint={props.mentionHint}
          error={errors['mention-names']}
        >
          {(field) => (
            <textarea
              {...field}
              name="mention-names"
              rows={4}
              defaultValue={typed('mention-names', lines(props.mentionNames))}
            />
          )}
        </FormField>
      </fieldset>

      <SubmitButton pendingLabel="Saving...">Save details</SubmitButton>
    </form>
  )
}
