import type { ReactNode } from 'react'

/** Props to spread on the input so the label, hint and error are tied to it. */
export interface FieldProps {
  id: string
  'aria-describedby'?: string
  'aria-invalid'?: true
}

/**
 * A label, an input and the text that belongs to it. `children` gets the props to spread on the input:
 * `<FormField id="name" label="Name" error={e}>{(p) => <input {...p} name="name" />}</FormField>`.
 * The hint and the error are linked with `aria-describedby`; an error also sets `aria-invalid`.
 */
export function FormField(props: {
  id: string
  label: string
  hint?: string
  error?: string
  children: (field: FieldProps) => ReactNode
}) {
  const { id, label, hint, error } = props
  const described = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ')
  const field: FieldProps = {
    id,
    ...(described && { 'aria-describedby': described }),
    ...(error && { 'aria-invalid': true })
  }
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint && (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      )}
      {props.children(field)}
      {error && (
        <p id={`${id}-error`} className="field-error">
          Error: {error}
        </p>
      )}
    </div>
  )
}
