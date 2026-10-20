import type { Metadata } from 'next'
import Link from 'next/link'
import { MAX_DEVICES_PER_MEMBER } from '@tm/core'
import { ConfirmForm } from '../../components/ConfirmForm'
import { EmptyState } from '../../components/EmptyState'
import { Notice } from '../../components/Notice'
import { PageHeader } from '../../components/PageHeader'
import { RelativeTime } from '../../components/RelativeTime'
import { listDevices } from '../../lib/companion/tokens'
import { requireMember } from '../../lib/session'
import { revokeDeviceAction } from './actions'
import { PairForm } from './pair-form'

export const metadata: Metadata = { title: 'Devices' }

/** What `?notice=` may say. Anything else is ignored, so the address can't put words on the page. */
const NOTICES: Record<string, { kind: 'info' | 'warn'; text: string }> = {
  revoked: { kind: 'info', text: 'The PC is removed. It stops working at once.' },
  'not-found': { kind: 'warn', text: 'That PC was already removed, or it is not yours.' }
}

const REVOKE_QUESTION = (name: string) =>
  `Remove "${name}"? It stops working at once and shows "This PC was removed from your account." ` +
  'A meeting that is running on it now is cancelled. Accounts set to run on this PC lose the link to it, ' +
  'and their meetings are skipped until you pair a PC again. A transcript it was making goes to another paired PC.'

export default async function DevicesPage({ searchParams }: { searchParams: Promise<{ notice?: string | string[] }> }) {
  const scope = await requireMember()
  const [devices, me, { notice }] = await Promise.all([listDevices(scope), scope.me(), searchParams])
  const message = typeof notice === 'string' && Object.hasOwn(NOTICES, notice) ? NOTICES[notice] : undefined
  const publicUrl = process.env.TM_PUBLIC_URL
  if (!publicUrl) throw new Error('TM_PUBLIC_URL is not set')
  const address = new URL(publicUrl).origin
  const notificationsReady = Boolean(me.ntfyTopic && me.ntfyTokenEnc)
  const paired = devices.filter((d) => d.revokedAt === null)
  const removed = devices.filter((d) => d.revokedAt !== null)

  return (
    <>
      <PageHeader title="Devices">
        <p>
          A paired PC runs the TolongMeeting companion. It saves your summaries as files and can transcribe meetings
          with your own hardware. You can pair up to {MAX_DEVICES_PER_MEMBER} PCs.
        </p>
      </PageHeader>

      {message && <Notice kind={message.kind}>{message.text}</Notice>}

      <section aria-labelledby="your-pcs">
        <h2 id="your-pcs">Your PCs</h2>
        {paired.length === 0 ? (
          <EmptyState title="No PC is paired yet">
            <p>Pair a PC below to get summaries as files and to transcribe on your own hardware.</p>
          </EmptyState>
        ) : (
          <ul className="list">
            {paired.map((device) => (
              <li key={device.id}>
                <strong>{device.name}</strong>. Paired <RelativeTime at={device.createdAt} timeZone={me.timeZone} />.{' '}
                {device.lastUsedAt ? (
                  <>
                    Last seen <RelativeTime at={device.lastUsedAt} timeZone={me.timeZone} />.
                  </>
                ) : (
                  'Not seen yet.'
                )}
                <ConfirmForm
                  action={revokeDeviceAction}
                  label={`Remove ${device.name}`}
                  question={REVOKE_QUESTION(device.name)}
                  confirmLabel="Yes, remove this PC"
                >
                  <input type="hidden" name="id" value={device.id} />
                </ConfirmForm>
              </li>
            ))}
          </ul>
        )}
        {removed.length > 0 && (
          <>
            <h3>Removed PCs</h3>
            <ul className="list">
              {removed.map((device) => (
                <li key={device.id}>
                  <strong>{device.name}</strong>. Removed <RelativeTime at={device.revokedAt!} timeZone={me.timeZone} />
                  . It cannot sign in again. To use it, pair it again.
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section aria-labelledby="pair">
        <h2 id="pair">Pair a new PC</h2>
        {!notificationsReady && (
          <Notice kind="warn">
            A paired PC needs your notification topic. <Link href="/notifications">Set up notifications</Link> first.
          </Notice>
        )}
        <ol>
          <li>Press &ldquo;Pair a new PC&rdquo; below. The page shows a code.</li>
          <li>On your PC, open the TolongMeeting companion from its tray icon and choose its pairing window.</li>
          <li>
            Enter the website address <code>{address}</code> and the code.
          </li>
          <li>Give the PC a name. It appears in the list above.</li>
        </ol>
        <PairForm />
      </section>
    </>
  )
}
