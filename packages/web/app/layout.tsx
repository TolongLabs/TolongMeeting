import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { currentMember } from '../lib/session'
import { Nav } from './nav'
import './globals.css'

export const metadata: Metadata = { title: { default: 'TolongMeeting', template: '%s | TolongMeeting' } }

/** Every page. Signed-out pages (sign-in) get no navigation; a signed-in member gets it, and an admin gets the Admin link. */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const scope = await currentMember()
  const admin = scope !== null && (await scope.me()).role === 'admin'
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {scope && <Nav admin={admin} />}
        <main id="main">{children}</main>
      </body>
    </html>
  )
}
