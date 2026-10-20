'use client'

import { useState } from 'react'
import { Notice } from '../../components/Notice'
import { showNtfyTokenAction } from './actions'

type State = { name: 'hidden' } | { name: 'loading' } | { name: 'shown'; token: string } | { name: 'failed' }

/**
 * The "Show token" button. The token comes only from this click's action reply, into component state. It is not in the
 * page HTML, it is not stored, and it is gone after a reload.
 */
export function TokenReveal() {
  const [state, setState] = useState<State>({ name: 'hidden' })

  async function show() {
    setState({ name: 'loading' })
    try {
      setState({ name: 'shown', token: await showNtfyTokenAction() })
    } catch {
      setState({ name: 'failed' })
    }
  }

  if (state.name === 'shown') {
    return (
      <div>
        <p>
          Access token: <code>{state.token}</code>
        </p>
        <button type="button" onClick={() => setState({ name: 'hidden' })}>
          Hide token
        </button>
      </div>
    )
  }

  return (
    <div>
      {state.name === 'failed' && (
        <Notice kind="error">
          The token could not be shown. Try again in a minute. If it keeps failing, tell an admin.
        </Notice>
      )}
      <button type="button" onClick={show} disabled={state.name === 'loading'} aria-disabled={state.name === 'loading'}>
        {state.name === 'loading' ? 'Showing...' : 'Show token'}
      </button>
    </div>
  )
}
