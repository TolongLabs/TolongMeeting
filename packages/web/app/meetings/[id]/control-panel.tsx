'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import type { OccurrenceState } from '@tm/core'
import { Notice } from '../../../components/Notice'
import { CONTROL_COPY, waitUntilLeft } from '../../../lib/meeting-control'
import { leaveAction, takeOverAction } from './control-actions'

type Phase =
  | { kind: 'idle' }
  | { kind: 'waiting' }
  | { kind: 'refused'; message: string }
  | { kind: 'unchecked' }
  | { kind: 'left'; mode: 'leave' | 'take-over'; opened: Opened | null; alreadyLeft: boolean }
  | { kind: 'timeout'; mode: 'leave' | 'take-over'; opened: Opened | null }

/** What a take-over response gave: a link to open (only if it is `https:`), and whether its passcode is in the chat. */
interface Opened {
  link: string | null
  passcodeFromChat: boolean
}

/** The link if it is a plain `https:` link, else null. A page never opens any other kind of link. */
function httpsOnly(link: string | null): string | null {
  return link !== null && URL.canParse(link) && new URL(link).protocol === 'https:' ? link : null
}

async function fetchState(id: string): Promise<OccurrenceState> {
  const response = await fetch(`/api/meetings/${encodeURIComponent(id)}/state`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`state route answered ${response.status}`)
  return ((await response.json()) as { state: OccurrenceState }).state
}

function OpenLink({ link, label }: { link: string; label: string }) {
  return (
    <p>
      <a href={link} rel="noopener noreferrer">
        {label}
      </a>
    </p>
  )
}

/**
 * The button of the leave and take-over pages. Nothing happens until it is pressed. It asks the server, waits for the
 * bot to leave by polling the state route (up to 60 s), then says so. For take over it opens the meeting link, which
 * lives only in this component's memory: the server action returns it to this member, and nothing stores it.
 */
export function ControlPanel({ id, mode }: { id: string; mode: 'leave' | 'take-over' }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  async function start() {
    setPhase({ kind: 'waiting' })
    let opened: Opened | null = null
    if (mode === 'leave') {
      const result = await leaveAction(id)
      if (!result.ok) return setPhase({ kind: 'refused', message: result.error })
    } else {
      const result = await takeOverAction(id)
      if (!result.ok) return setPhase({ kind: 'refused', message: result.error })
      opened = { link: httpsOnly(result.link), passcodeFromChat: result.passcodeFromChat }
      if (result.alreadyLeft) return setPhase({ kind: 'left', mode, opened, alreadyLeft: true })
    }
    let outcome: 'left' | 'timeout'
    try {
      // A page that was closed stops asking: any state outside the meeting ends the wait at once.
      outcome = await waitUntilLeft(async () => (mounted.current ? await fetchState(id) : 'left_by_member'))
    } catch (e) {
      console.error(e)
      return setPhase({ kind: 'unchecked' })
    }
    if (!mounted.current) return
    if (outcome === 'left' && mode === 'take-over' && opened?.link && !opened.passcodeFromChat) {
      window.location.assign(opened.link)
    }
    setPhase(
      outcome === 'left' ? { kind: 'left', mode, opened, alreadyLeft: false } : { kind: 'timeout', mode, opened }
    )
  }

  const button = mode === 'leave' ? CONTROL_COPY.leaveButton : CONTROL_COPY.takeOverButton
  switch (phase.kind) {
    case 'idle':
      return (
        <button type="button" onClick={() => void start()}>
          {button}
        </button>
      )
    case 'waiting':
      return (
        <p role="status">
          <button type="button" disabled>
            {button}
          </button>{' '}
          {CONTROL_COPY.waiting}
        </p>
      )
    case 'refused':
      return <Notice kind="error">{phase.message}</Notice>
    case 'unchecked':
      return (
        <Notice kind="error">
          We could not check whether the bot has left. <Link href={`/meetings/${id}`}>Open the meeting page</Link> to
          see.
        </Notice>
      )
    case 'left': {
      if (phase.mode === 'leave') {
        return (
          <>
            <Notice>{CONTROL_COPY.leaveDone}</Notice>
            <p>
              <Link href={`/meetings/${id}`}>Back to the meeting page</Link>
            </p>
          </>
        )
      }
      const link = phase.opened?.link ?? null
      return (
        <>
          <Notice>{phase.alreadyLeft ? CONTROL_COPY.takeOverAlreadyLeft : 'The bot has left.'}</Notice>
          {link === null ? (
            <Notice kind="warn">{CONTROL_COPY.takeOverNoLink}</Notice>
          ) : (
            <>
              {phase.opened?.passcodeFromChat && <Notice kind="warn">{CONTROL_COPY.takeOverPasscodeFromChat}</Notice>}
              <OpenLink link={link} label="Open the meeting" />
            </>
          )}
        </>
      )
    }
    case 'timeout': {
      if (phase.mode === 'leave') return <Notice kind="warn">{CONTROL_COPY.leaveTimeout}</Notice>
      const link = phase.opened?.link ?? null
      return (
        <>
          <Notice kind="warn">{CONTROL_COPY.takeOverTimeout}</Notice>
          {link === null ? (
            <Notice kind="warn">{CONTROL_COPY.takeOverNoLink}</Notice>
          ) : (
            <>
              {phase.opened?.passcodeFromChat && <Notice kind="warn">{CONTROL_COPY.takeOverPasscodeFromChat}</Notice>}
              <OpenLink link={link} label={CONTROL_COPY.takeOverAnyway} />
            </>
          )}
        </>
      )
    }
  }
}
