import Link from 'next/link'
import type { ReactNode } from 'react'

/** "Nothing here yet", in plain words, with at most one next step as a link. */
export function EmptyState(props: { title: string; children?: ReactNode; action?: { href: string; label: string } }) {
  return (
    <section className="empty">
      <h2>{props.title}</h2>
      {props.children}
      {props.action && (
        <p>
          <Link href={props.action.href}>{props.action.label}</Link>
        </p>
      )}
    </section>
  )
}
