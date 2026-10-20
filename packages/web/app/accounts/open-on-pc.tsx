'use client'

import { useState } from 'react'
import { Notice } from '../../components/Notice'
import { SubmitButton } from '../../components/SubmitButton'

type Outcome = { kind: 'info' | 'warn' | 'error'; text: string }

const OPEN_FAILED = 'Could not ask your PC to open the sign-in. Try again.'

/**
 * "Sign in" for an identity that runs on the member's PC: the website cannot reach the PC, so it queues a command that
 * the TolongMeeting desktop app reads, and the app opens the sign-in window on the PC.
 */
export function OpenOnPc(props: { identityId: string; pcName: string }) {
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  async function open() {
    setOutcome(null)
    let response: Response
    try {
      response = await fetch(`/api/identities/${props.identityId}/open-signin`, { method: 'POST', cache: 'no-store' })
    } catch (e) {
      // Only a network failure is expected here; the page shows it as a fixed sentence.
      if (!(e instanceof TypeError)) throw e
      setOutcome({ kind: 'error', text: OPEN_FAILED })
      return
    }
    if (response.status === 404) return setOutcome({ kind: 'error', text: 'This identity was not found.' })
    if (!response.ok) return setOutcome({ kind: 'error', text: OPEN_FAILED })
    const body = (await response.json()) as { opened: true; pcName: string } | { opened: false; reason: string }
    if (body.opened)
      return setOutcome({
        kind: 'info',
        text: `Opened on ${body.pcName}. Finish signing in in the TolongMeeting window on that PC, then press Done there.`
      })
    setOutcome(
      body.reason === 'pc_offline'
        ? {
            kind: 'warn',
            text: `Your PC ${props.pcName} is offline. Turn it on and open the TolongMeeting app, then try again.`
          }
        : { kind: 'warn', text: 'This identity no longer runs on your PC. Reload the page.' }
    )
  }

  return (
    <form action={open}>
      <SubmitButton pendingLabel="Asking your PC...">Sign in on my PC</SubmitButton>
      {outcome && <Notice kind={outcome.kind}>{outcome.text}</Notice>}
    </form>
  )
}
