import type { ReactNode } from 'react'
import { SubmitButton } from './SubmitButton'

/**
 * A destructive action with a second step. The first control only opens the question; the action runs only from the
 * confirm button. It uses `<details>`, so it works with the keyboard and without JavaScript. `children` are hidden
 * inputs for the action (for example the id).
 */
export function ConfirmForm(props: {
  action: (formData: FormData) => void | Promise<void>
  label: string
  question: string
  confirmLabel: string
  children?: ReactNode
}) {
  return (
    <details className="confirm">
      <summary>{props.label}</summary>
      <form action={props.action}>
        <p>{props.question}</p>
        {props.children}
        <SubmitButton>{props.confirmLabel}</SubmitButton> <span>To cancel, close this question.</span>
      </form>
    </details>
  )
}
