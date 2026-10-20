'use client'

import Link from 'next/link'
import { PageHeader } from '../components/PageHeader'

/** Shows no message, stack or id from the error: the server log has them. */
export default function ErrorPage({ retry }: { error: unknown; retry: () => void }) {
  return (
    <>
      <PageHeader title="Something went wrong">
        <p>This page could not load. Try again. If it keeps failing, tell an admin.</p>
      </PageHeader>
      <p>
        <button type="button" onClick={() => retry()}>
          Try again
        </button>{' '}
        <Link href="/">Go to Home</Link>
      </p>
    </>
  )
}
