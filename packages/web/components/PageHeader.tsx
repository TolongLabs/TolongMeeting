import type { ReactNode } from 'react'

/** The page's one `<h1>`, with an optional short intro and actions under it. */
export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="page-header">
      <h1>{title}</h1>
      {children}
    </header>
  )
}
