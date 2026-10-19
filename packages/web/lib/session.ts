import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getAuth } from './auth'
import { scopeForAuthUser, type MemberScope } from './scope'

/** The scope of the signed-in member. Redirects to `/sign-in` without a session or a linked member. */
export async function requireMember(): Promise<MemberScope> {
  const session = await getAuth().api.getSession({ headers: await headers() })
  const scope = session ? await scopeForAuthUser(session.user.id) : null
  if (!scope) redirect('/sign-in')
  return scope
}

/** Like `requireMember`, and redirects to `/` unless the member is an admin. */
export async function requireAdmin(): Promise<MemberScope> {
  const scope = await requireMember()
  if ((await scope.me()).role !== 'admin') redirect('/')
  return scope
}
