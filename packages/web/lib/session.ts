import { cache } from 'react'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { getAuth } from './auth'
import { scopeForAuthUser, type MemberScope } from './scope'

/**
 * The scope of the signed-in member, or `null` without a session or a linked member. It never redirects, so the layout
 * and the sign-in page can use it. Cached for one request, so the layout and the page share one lookup.
 */
export const currentMember = cache(async (): Promise<MemberScope | null> => {
  // Read the headers first: that makes the page dynamic, so `next build` never reaches `getAuth()` (it needs secrets).
  const requestHeaders = await headers()
  const session = await getAuth().api.getSession({ headers: requestHeaders })
  return session ? await scopeForAuthUser(session.user.id) : null
})

/** The scope of the signed-in member. Redirects to `/sign-in` without a session or a linked member. */
export async function requireMember(): Promise<MemberScope> {
  const scope = await currentMember()
  if (!scope) redirect('/sign-in')
  return scope
}

/** Like `requireMember`, and answers not-found unless the member is an admin. */
export async function requireAdmin(): Promise<MemberScope> {
  const scope = await requireMember()
  if ((await scope.me()).role !== 'admin') notFound()
  return scope
}
