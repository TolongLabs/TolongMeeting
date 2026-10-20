import type { Metadata } from 'next'
import Link from 'next/link'
import { PageHeader } from '../../../components/PageHeader'
import { RelativeTime } from '../../../components/RelativeTime'
import { scopeHomeNodeStore } from '../../../db/home-route'
import { requireMember } from '../../../lib/session'
import { HomeSetup } from './home-setup'

export const metadata: Metadata = { title: 'Home connection' }

export default async function HomeConnectionPage() {
  const scope = await requireMember()
  const [me, node] = await Promise.all([scope.me(), scopeHomeNodeStore(scope).get()])
  return (
    <>
      <PageHeader title="Home connection">
        <p>
          <Link href="/accounts">Back to Accounts</Link>
        </p>
        <p>
          Your bot can join through your home internet connection, so your university and work sign-ins come from your
          usual address.
        </p>
      </PageHeader>

      <section aria-labelledby="state">
        <h2 id="state">Your home device</h2>
        {node ? (
          <p>
            A home device was found ready on <RelativeTime at={node.checkedAt} timeZone={me.timeZone} />. Press Check
            connection to see how it is now.
          </p>
        ) : (
          <p>No home device is set up yet.</p>
        )}
      </section>

      <section aria-labelledby="steps">
        <h2 id="steps">How to set it up</h2>
        <ol>
          <li>
            Pick a device that stays on at home during your meetings: a desktop PC, a mini PC or a Raspberry Pi, plugged
            in and on your home network. A phone or a laptop that sleeps won&apos;t do. If the device already uses
            Tailscale for another network, use a different one: a device joins one Tailscale network at a time.
          </li>
          <li>
            Install Tailscale from <a href="https://tailscale.com/download">tailscale.com/download</a>.
          </li>
          <li>Press Create setup key below. The key works once, within an hour.</li>
          <li>Run the command for your device. The commands appear below, with your key and device name filled in.</li>
          <li>Set the device never to sleep while it&apos;s plugged in.</li>
          <li>Press Check connection. It says Ready when the device is online and sharing its connection.</li>
        </ol>
        <p>
          Only your bot&apos;s traffic goes through this device, and only during your meetings. TolongMeeting can&apos;t
          reach other devices on your home network, and your other devices aren&apos;t affected.
        </p>
      </section>

      <HomeSetup hasDevice={node !== null} />
    </>
  )
}
