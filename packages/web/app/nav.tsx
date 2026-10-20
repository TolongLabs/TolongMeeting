'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const LINKS = [
  { href: '/', label: 'Home' },
  { href: '/timetable', label: 'Timetable' },
  { href: '/accounts', label: 'Accounts' },
  { href: '/details', label: 'My details' },
  { href: '/notifications', label: 'Notifications' },
  { href: '/ai-keys', label: 'AI keys' },
  { href: '/devices', label: 'Devices' },
  { href: '/connections', label: 'Connections' }
]

/** The top navigation of a signed-in member. `admin` adds the Admin link. The current page gets `aria-current`. */
export function Nav({ admin }: { admin: boolean }) {
  const path = usePathname()
  const links = admin ? [...LINKS, { href: '/admin', label: 'Admin' }] : LINKS
  return (
    <nav className="site-nav" aria-label="Main">
      <ul>
        {links.map(({ href, label }) => (
          <li key={href}>
            <Link href={href} aria-current={(href === '/' ? path === '/' : path.startsWith(href)) ? 'page' : undefined}>
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
