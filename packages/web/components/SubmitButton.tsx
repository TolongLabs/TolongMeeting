'use client'

import type { ReactNode } from 'react'
import { useFormStatus } from 'react-dom'

/** The form's submit button. Disabled while its form's action runs, so a double click sends once. Use inside a `<form>`. */
export function SubmitButton({ children, pendingLabel }: { children: ReactNode; pendingLabel?: string }) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending} aria-disabled={pending}>
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  )
}
