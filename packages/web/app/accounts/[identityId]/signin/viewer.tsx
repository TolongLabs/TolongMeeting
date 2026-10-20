'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { Notice } from '../../../../components/Notice'
import { SubmitButton } from '../../../../components/SubmitButton'
import { finishSigninAction, signinStatusAction, startSigninAction, vncPasswordAction } from './actions'

const POLL_MS = 2000
/** A container that has not come up after this long is not going to. */
const START_TIMEOUT_MS = 120_000

type Phase =
  | { name: 'idle' }
  | { name: 'starting'; sessionId: string }
  | { name: 'live'; sessionId: string; connected: boolean; finishing: boolean }
  | { name: 'ended'; afterDone: boolean }
  | { name: 'failed'; message: string }

const START_FAILED = 'The sign-in could not start. Try again. If it keeps failing, tell an admin.'
const START_TIMED_OUT = 'The sign-in view did not start in time. Try again. If it keeps failing, tell an admin.'
const VIEW_FAILED = 'The view could not open. Try again.'
const CONNECTION_LOST = 'The connection to the view was lost. Press Start to open it again.'
const STATUS_FAILED = 'The state of the sign-in could not be read. Check your connection, then reload the page.'

/**
 * The remote view of the bot's browser. It starts a sign-in only when the member presses Start, polls its state every
 * 2 seconds, and opens noVNC on `/vnc/<session>/websockify` (Caddy checks the member there) once the view is ready.
 * The view's password comes from a server action, is held in memory only and goes to noVNC as its credentials: it is
 * never in the page, a URL or storage.
 */
export function SigninViewer({ identityId }: { identityId: string }) {
  const [phase, setPhase] = useState<Phase>({ name: 'idle' })
  const stage = useRef<HTMLDivElement>(null)
  const sessionId = 'sessionId' in phase ? phase.sessionId : null
  const liveId = phase.name === 'live' ? phase.sessionId : null

  // Poll the session while one is open.
  useEffect(() => {
    if (sessionId === null) return
    const startedAt = Date.now()
    const timer = setInterval(() => {
      signinStatusAction(sessionId).then(
        (state) =>
          setPhase((p) => {
            if (state === 'ready' && p.name === 'starting')
              return { name: 'live', sessionId, connected: false, finishing: false }
            if (state === 'ended') {
              if (p.name === 'starting') return { name: 'failed', message: START_FAILED }
              if (p.name === 'live') return { name: 'ended', afterDone: p.finishing }
            }
            if (p.name === 'starting' && Date.now() - startedAt > START_TIMEOUT_MS)
              return { name: 'failed', message: START_TIMED_OUT }
            return p
          }),
        () => setPhase({ name: 'failed', message: STATUS_FAILED })
      )
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [sessionId])

  // Open noVNC once the view is ready; close it when the page or the phase changes.
  useEffect(() => {
    if (liveId === null) return
    let cancelled = false
    let client: { disconnect(): void } | null = null
    let disconnected = false
    const failed = (message: string) =>
      setPhase((p) => (p.name === 'live' && !p.finishing ? { name: 'failed', message } : p))
    ;(async () => {
      const password = await vncPasswordAction(liveId)
      // noVNC touches the browser at load time, so it is imported here and never on the server.
      const { default: RFB } = await import('@novnc/novnc')
      if (cancelled || !stage.current) return
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const rfb = new RFB(stage.current, `${scheme}://${window.location.host}/vnc/${liveId}/websockify`, {
        credentials: { password }
      })
      rfb.scaleViewport = true
      rfb.addEventListener('connect', () => {
        setPhase((p) => (p.name === 'live' ? { ...p, connected: true } : p))
        rfb.focus()
      })
      rfb.addEventListener('disconnect', () => {
        disconnected = true
        failed(CONNECTION_LOST)
      })
      rfb.addEventListener('securityfailure', () => failed(VIEW_FAILED))
      rfb.addEventListener('credentialsrequired', () => failed(VIEW_FAILED))
      client = rfb
    })().catch(() => failed(VIEW_FAILED))
    return () => {
      cancelled = true
      if (!disconnected) client?.disconnect()
    }
  }, [liveId])

  async function start() {
    try {
      const { sessionId: id } = await startSigninAction(identityId)
      setPhase({ name: 'starting', sessionId: id })
    } catch {
      setPhase({ name: 'failed', message: START_FAILED })
    }
  }

  async function done() {
    if (phase.name !== 'live') return
    setPhase({ ...phase, finishing: true })
    try {
      await finishSigninAction(phase.sessionId)
    } catch {
      setPhase({ name: 'failed', message: STATUS_FAILED })
    }
  }

  const startForm = (label: string) => (
    <form action={start}>
      <SubmitButton pendingLabel="Starting...">{label}</SubmitButton>
    </form>
  )

  return (
    <section aria-labelledby="view">
      <h2 id="view">The view</h2>
      {phase.name === 'idle' && (
        <>
          <p>Press Start to open the view. It can take up to a minute.</p>
          {startForm('Start sign-in')}
        </>
      )}
      {phase.name === 'starting' && (
        <Notice kind="info">Starting the sign-in view. This can take up to a minute. Keep this page open.</Notice>
      )}
      {phase.name === 'live' && (
        <>
          <Notice kind="info">
            {phase.finishing
              ? 'Saving your sign-in. The view closes in a few seconds.'
              : phase.connected
                ? 'Sign in to your accounts in the view below. Press Done when you have finished.'
                : 'Connecting to the view...'}
          </Notice>
          <div
            ref={stage}
            role="group"
            aria-label="Remote view of the bot's browser"
            style={{ height: '70vh', minHeight: '24rem' }}
          />
          {!phase.finishing && (
            <form action={done}>
              <SubmitButton pendingLabel="Saving...">Done</SubmitButton>
            </form>
          )}
        </>
      )}
      {phase.name === 'ended' && (
        <>
          {phase.afterDone ? (
            <Notice kind="info">Done. Your sign-in is saved.</Notice>
          ) : (
            <Notice kind="warn">
              The sign-in view closed. It closes after 15 minutes without input, or when the sign-in ends.
            </Notice>
          )}
          <p>
            <Link href="/accounts">Back to Accounts</Link> to see the state of each account.
          </p>
          {!phase.afterDone && startForm('Start sign-in again')}
        </>
      )}
      {phase.name === 'failed' && (
        <>
          <Notice kind="error">{phase.message}</Notice>
          {startForm('Try again')}
        </>
      )}
    </section>
  )
}
