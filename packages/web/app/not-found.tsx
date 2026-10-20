import Link from 'next/link'
import { PageHeader } from '../components/PageHeader'

export default function NotFound() {
  return (
    <>
      <PageHeader title="Page not found">
        <p>This page does not exist, or it is not yours to see.</p>
      </PageHeader>
      <p>
        <Link href="/">Go to Home</Link>
      </p>
    </>
  )
}
