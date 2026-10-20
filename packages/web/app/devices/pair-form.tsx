'use client'

import { useActionState } from 'react'
import { Notice } from '../../components/Notice'
import { SubmitButton } from '../../components/SubmitButton'
import { pairCodeAction } from './actions'
import type { PairState } from './pair-state'

const IDLE: PairState = { status: 'idle' }

/** The "Pair a new PC" button and, under it, the code it made. The code is shown here once and is not kept anywhere. */
export function PairForm() {
  const [state, action] = useActionState(pairCodeAction, IDLE)
  return (
    <form action={action}>
      <SubmitButton pendingLabel="Making a code...">Pair a new PC</SubmitButton>
      {state.status === 'error' && <Notice kind="error">{state.message}</Notice>}
      {state.status === 'created' && (
        <div role="status">
          <h3>Your pairing code</h3>
          <p>
            <code>{state.code}</code>
          </p>
          <p>
            The code works once and stops working at {state.validUntil} (10 minutes). It is shown only here. If you lose
            it, press the button again for a new code. The new code replaces this one.
          </p>
        </div>
      )}
    </form>
  )
}
