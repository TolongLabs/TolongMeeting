import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Notice } from '../../components/Notice'
import { PageHeader } from '../../components/PageHeader'
import { currentMember } from '../../lib/session'
import { SignInButton } from './sign-in-button'

export const metadata: Metadata = { title: 'Sign in' }

/** What the member reads for each refusal. The code in the URL is never shown: any other code gets the last text. */
const REFUSALS: Record<string, string> = {
  NOT_A_MEMBER: 'Not an active TolongLabs member. Ask an admin to add you.',
  access_denied: 'GitHub sign-in was cancelled. Try again when you are ready.'
}
const OTHER_REFUSAL = 'Sign-in did not work. Try again. If it keeps failing, ask an admin.'

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  if (await currentMember()) redirect('/')
  const { error } = await searchParams
  const code = Array.isArray(error) ? error[0] : error
  return (
    <>
      <PageHeader title="Sign in to TolongMeeting">
        <p>Sign in with the GitHub account of a TolongLabs member.</p>
      </PageHeader>
      {code !== undefined && (
        <Notice kind="error">{Object.hasOwn(REFUSALS, code) ? REFUSALS[code] : OTHER_REFUSAL}</Notice>
      )}
      <SignInButton />
    </>
  )
}
