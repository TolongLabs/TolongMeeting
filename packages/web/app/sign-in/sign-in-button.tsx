'use client'

import { useActionState } from 'react'
import { SubmitButton } from '../../components/SubmitButton'
import { Notice } from '../../components/Notice'
import { authClient } from '../../lib/auth-client'

/** Starts the GitHub sign-in. On success the browser leaves for GitHub, so the button stays disabled until then. */
export function SignInButton() {
  const [failure, start] = useActionState(async (): Promise<string | null> => {
    const { error } = await authClient.signIn.social({
      provider: 'github',
      callbackURL: '/',
      errorCallbackURL: '/sign-in'
    })
    return error ? 'Could not open GitHub. Try again.' : null
  }, null)
  return (
    <form action={start}>
      {failure && <Notice kind="error">{failure}</Notice>}
      <SubmitButton pendingLabel="Opening GitHub...">Sign in with GitHub</SubmitButton>
      <noscript>
        <p>Signing in needs JavaScript. Turn it on for this site.</p>
      </noscript>
    </form>
  )
}
