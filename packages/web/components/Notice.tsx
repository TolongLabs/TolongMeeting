import type { ReactNode } from 'react'

const LABELS = { info: 'Note', warn: 'Warning', error: 'Error' } as const

/**
 * A message in a box. `error` is announced at once (`role="alert"`); `info` and `warn` are announced politely
 * (`role="status"`). The label word makes the kind clear without colour.
 */
export function Notice({ kind = 'info', children }: { kind?: keyof typeof LABELS; children: ReactNode }) {
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <strong>{LABELS[kind]}:</strong> {children}
    </div>
  )
}
