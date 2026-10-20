import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { watchGateFromEnv, chatWatchAllowed } from '@tm/core'
import { Notice } from '../../../../components/Notice'
import { PageHeader } from '../../../../components/PageHeader'
import { listDevices } from '../../../../lib/companion/tokens'
import { listIdentities } from '../../../../lib/identities'
import { BAN_RISK_NOTICE, signinNotes } from '../../../../lib/link-notices'
import { requireMember } from '../../../../lib/session'
import { OpenOnPc } from '../../open-on-pc'
import { SigninViewer } from './viewer'

export const metadata: Metadata = { title: 'Sign in to your accounts' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export default async function SigninPage({ params }: { params: Promise<{ identityId: string }> }) {
  const scope = await requireMember()
  const { identityId } = await params
  // An identity of another member is the same 404 as one that does not exist.
  const identity = UUID.test(identityId) ? (await listIdentities(scope)).find((i) => i.id === identityId) : undefined
  if (!identity) notFound()

  const header = (
    <PageHeader title={`Sign in: ${identity.name}`}>
      <p>
        <Link href="/accounts">Back to Accounts</Link>
      </p>
    </PageHeader>
  )

  if (identity.runLocation === 'local') {
    const pc = (await listDevices(scope)).find((d) => d.id === identity.localDeviceId && d.revokedAt === null)
    return (
      <>
        {header}
        <p>This identity runs on your PC, so you sign in on your PC. Its browser profile never leaves the PC.</p>
        {pc ? (
          <>
            <p>
              Press the button to open the sign-in window of the TolongMeeting desktop app on <strong>{pc.name}</strong>
              . Sign in to your accounts there, then press Done in that window.
            </p>
            <OpenOnPc identityId={identity.id} pcName={pc.name} />
          </>
        ) : (
          <Notice kind="warn">
            No PC is paired for this identity. Pair a PC on the <Link href="/devices">Devices</Link> page, then move the
            identity to it on the <Link href="/accounts">Accounts</Link> page.
          </Notice>
        )}
      </>
    )
  }

  if (identity.runLocation !== 'server') {
    return (
      <>
        {header}
        <Notice kind="warn">
          Remote sign-in is only for identities that run on the server. To sign in to this identity, move it to the
          server on the <Link href="/accounts">Accounts</Link> page first. A sign-in on the server comes from the
          server&apos;s address, not from your home connection.
        </Notice>
      </>
    )
  }

  const gate = watchGateFromEnv(process.env)
  const notes = signinNotes(identity.runLocation, gate)
  const banRisk =
    chatWatchAllowed('whatsapp', identity.runLocation, gate) || chatWatchAllowed('discord', identity.runLocation, gate)
  return (
    <>
      {header}
      <p>
        This is a view of the bot&apos;s own browser for <strong>{identity.name}</strong>. You sign in yourself: the app
        never sees or stores your passwords.
      </p>
      <section aria-labelledby="what">
        <h2 id="what">What to sign in to</h2>
        <ul>
          <li>Zoom: sign in at zoom.us.</li>
          <li>Microsoft: sign in with your Microsoft account.</li>
          <li>Google: sign in with your Google account.</li>
          <li>{notes.whatsapp}</li>
          <li>{notes.discord}</li>
          <li>Teams: open Teams in the view and sign in.</li>
        </ul>
        {banRisk && <Notice kind="warn">{BAN_RISK_NOTICE}</Notice>}
        <p>
          If a meeting is running for this identity, the view shows the bot&apos;s desk and pauses the bot until you
          press Done.
        </p>
        <p>
          This view shows only the unrecorded side of the bot&apos;s screen. It closes after 15 minutes without input.
        </p>
      </section>
      <SigninViewer identityId={identity.id} />
    </>
  )
}
