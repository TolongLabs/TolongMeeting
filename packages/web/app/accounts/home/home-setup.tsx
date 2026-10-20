'use client'

import { useState } from 'react'
import { ConfirmForm } from '../../../components/ConfirmForm'
import { Notice } from '../../../components/Notice'
import { SubmitButton } from '../../../components/SubmitButton'

type Message = { kind: 'info' | 'warn' | 'error'; text: string }
type Issued = { key: string; hostname: string }
type Check = { status: 'ready' | 'offline' | 'not_exit_node' | 'not_enrolled'; hostname: string }

const GENERIC = 'Something went wrong. Try again.'
const REFUSALS = {
  key: {
    503: 'Home connection setup is not available on this server. Ask an admin.',
    429: 'You have asked for too many setup keys. Try again in an hour.',
    502: 'TolongMeeting could not reach Tailscale. Try again in a minute.'
  },
  check: {
    503: 'Home connection setup is not available on this server. Ask an admin.',
    429: 'You have checked too often. Try again in a few minutes.',
    502: 'TolongMeeting could not reach Tailscale. Try again in a minute.'
  }
} as const

const STATUS_TEXT: Record<Check['status'], Message> = {
  ready: { kind: 'info', text: 'Ready: your home device is online and sharing its connection.' },
  offline: {
    kind: 'warn',
    text: 'Offline: your home device is not connected to Tailscale. Turn it on, make sure it is online, then check again.'
  },
  not_exit_node: {
    kind: 'warn',
    text: 'Online, but not sharing its connection. Run the command for your device again, with --advertise-exit-node, then check again.'
  },
  not_enrolled: {
    kind: 'warn',
    text: 'Not enrolled: no device has joined with your setup key yet. Run the command for your device, then check again.'
  }
}

/** A POST to one of the home-route routes, or a fixed sentence for what went wrong. Nothing from the response is shown. */
async function post(path: string, refusals: Record<number, string>): Promise<{ body: unknown } | { problem: string }> {
  let response: Response
  try {
    response = await fetch(path, { method: 'POST', cache: 'no-store' })
  } catch (e) {
    if (!(e instanceof TypeError)) throw e
    return { problem: 'Could not reach TolongMeeting. Check your connection and try again.' }
  }
  if (!response.ok) return { problem: refusals[response.status] ?? GENERIC }
  return { body: await response.json() }
}

const isText = (value: unknown): value is string => typeof value === 'string' && value !== ''

/**
 * Asks for a setup key and checks the connection. A key is held in this component's state only: it is never in the
 * page's HTML, a URL or storage, and it is gone when the page is reloaded or left.
 */
export function HomeSetup({ hasDevice }: { hasDevice: boolean }) {
  const [issued, setIssued] = useState<Issued | null>(null)
  const [keyProblem, setKeyProblem] = useState<string | null>(null)
  const [check, setCheck] = useState<Message | null>(null)
  const [lookingFor, setLookingFor] = useState<string | null>(null)

  async function createKey() {
    setIssued(null)
    setKeyProblem(null)
    const result = await post('/api/home-route/key', REFUSALS.key)
    if ('problem' in result) return setKeyProblem(result.problem)
    const body = result.body as Partial<Issued> | null
    if (!body || !isText(body.key) || !isText(body.hostname)) return setKeyProblem(GENERIC)
    setIssued({ key: body.key, hostname: body.hostname })
  }

  async function checkConnection() {
    setCheck(null)
    const result = await post('/api/home-route/check', REFUSALS.check)
    if ('problem' in result) return setCheck({ kind: 'error', text: result.problem })
    const body = result.body as Partial<Check> | null
    if (!body || !isText(body.hostname) || !body.status || !Object.hasOwn(STATUS_TEXT, body.status))
      return setCheck({ kind: 'error', text: GENERIC })
    setLookingFor(body.hostname)
    setCheck(STATUS_TEXT[body.status])
  }

  return (
    <>
      <section aria-labelledby="key">
        <h2 id="key">Setup key</h2>
        <p>
          A new setup key makes TolongMeeting forget your current home device, if you have one. To replace a device,
          remove the old one from your Tailscale machines list first: two devices cannot join with the same name.
        </p>
        {hasDevice ? (
          <ConfirmForm
            action={createKey}
            label="Replace my home device"
            question="Ask for a new setup key? TolongMeeting forgets your current home device now. Identities that run through your home connection cannot start meetings until the new device is ready."
            confirmLabel="Create a new setup key"
          />
        ) : (
          <form action={createKey}>
            <SubmitButton pendingLabel="Creating the key...">Create setup key</SubmitButton>
          </form>
        )}
        {keyProblem && <Notice kind="error">{keyProblem}</Notice>}
        {issued && (
          <div aria-live="polite">
            <Notice kind="warn">
              This key is shown once. It works once, for one hour. If you leave or reload this page, ask for a new key.
            </Notice>
            <p>
              Setup key: <code>{issued.key}</code>
            </p>
            <p>
              Device name: <code>{issued.hostname}</code>
            </p>
            <h3>Windows (administrator terminal)</h3>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              tailscale up --auth-key={issued.key} --hostname={issued.hostname} --advertise-exit-node --unattended
            </pre>
            <h3>Linux</h3>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {`sudo sysctl -w net.ipv4.ip_forward=1 net.ipv6.conf.all.forwarding=1
echo 'net.ipv4.ip_forward = 1' | sudo tee -a /etc/sysctl.d/99-tailscale.conf
echo 'net.ipv6.conf.all.forwarding = 1' | sudo tee -a /etc/sysctl.d/99-tailscale.conf
sudo tailscale up --auth-key=${issued.key} --hostname=${issued.hostname} --advertise-exit-node`}
            </pre>
            <h3>macOS</h3>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              tailscale up --auth-key={issued.key} --hostname={issued.hostname} --advertise-exit-node
            </pre>
          </div>
        )}
      </section>

      <section aria-labelledby="check">
        <h2 id="check">Check the connection</h2>
        <form action={checkConnection}>
          <SubmitButton pendingLabel="Checking...">Check connection</SubmitButton>
        </form>
        {check && <Notice kind={check.kind}>{check.text}</Notice>}
        {lookingFor && check && check.kind !== 'info' && (
          <p>
            TolongMeeting looks for a device called <code>{lookingFor}</code>.
          </p>
        )}
      </section>
    </>
  )
}
