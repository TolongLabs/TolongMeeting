import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ConfirmForm } from '../../components/ConfirmForm'
import { Notice } from '../../components/Notice'
import { PageHeader } from '../../components/PageHeader'
import { RelativeTime } from '../../components/RelativeTime'
import { adminScope } from '../../lib/scope'
import { requireMember } from '../../lib/session'
import { removeMemberAction, setRoleAction } from './actions'
import { AddMemberForm } from './add-member-form'

export const metadata: Metadata = { title: 'Admin' }

/** What `?notice=` may say. Anything else is ignored, so the address can't put words on the page. */
const NOTICES: Record<string, { kind: 'info' | 'warn'; text: string }> = {
  added: { kind: 'info', text: 'Member added. They can now sign in with GitHub.' },
  'role-changed': { kind: 'info', text: 'The role is changed.' },
  removed: { kind: 'info', text: 'Member removed, with their data.' },
  'last-admin': {
    kind: 'warn',
    text: 'The last admin cannot be removed or made a member. Make someone else an admin first.'
  },
  busy: { kind: 'warn', text: 'This member has a meeting or a sign-in in progress. Try again when it has ended.' }
}

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ notice?: string | string[] }> }) {
  // A member who is not an admin gets the not-found page, so the page does not say it exists.
  const scope = await requireMember()
  const me = await scope.me()
  if (me.role !== 'admin') notFound()
  const [members, { notice }] = await Promise.all([adminScope().listMembers(), searchParams])
  const message = typeof notice === 'string' && Object.hasOwn(NOTICES, notice) ? NOTICES[notice] : undefined
  const ntfyReady = Boolean(process.env.NTFY_URL && process.env.NTFY_ADMIN_TOKEN)

  return (
    <>
      <PageHeader title="Admin">
        <p>Add and remove members. You see who the members are, never their meetings, links, keys or summaries.</p>
      </PageHeader>

      {message && <Notice kind={message.kind}>{message.text}</Notice>}

      <section aria-labelledby="members">
        <h2 id="members">Members</h2>
        <ul className="list">
          {members.map((member) => {
            const self = member.id === scope.memberId
            const admin = member.role === 'admin'
            return (
              <li key={member.id}>
                <strong>{member.displayName}</strong> (GitHub: {member.githubLogin}
                {self && ', you'}). {admin ? 'Admin' : 'Member'}. Time zone {member.timeZone}. Added{' '}
                <RelativeTime at={member.createdAt} timeZone={me.timeZone} />.
                <form action={setRoleAction}>
                  <input type="hidden" name="id" value={member.id} />
                  <input type="hidden" name="role" value={admin ? 'member' : 'admin'} />
                  <button type="submit">
                    {admin ? `Make ${member.displayName} a member` : `Make ${member.displayName} an admin`}
                  </button>
                </form>
                {ntfyReady && (
                  <ConfirmForm
                    action={removeMemberAction}
                    label={`Remove ${member.displayName}`}
                    question={`Remove ${member.displayName}${self ? ' (you)' : ''}? This deletes their timetable, accounts, summaries and recordings, and their notification user. It cannot be undone. It is refused while they have a meeting or a sign-in in progress, and for the last admin.`}
                    confirmLabel="Yes, remove this member"
                  >
                    <input type="hidden" name="id" value={member.id} />
                  </ConfirmForm>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      <section aria-labelledby="add-member">
        <h2 id="add-member">Add a member</h2>
        <p>
          There is no public sign-up. A person can sign in only after you add their GitHub username here and they belong
          to the GitHub organisation.
        </p>
        <AddMemberForm />
      </section>

      <section aria-labelledby="ntfy">
        <h2 id="ntfy">Notification server</h2>
        {ntfyReady ? (
          <p>
            The notification server (ntfy) is set up. Each member gets their own private topic there. Removing a member
            also deletes their user on it.
          </p>
        ) : (
          <Notice kind="warn">
            The notification server is not set up on this server (NTFY_URL and NTFY_ADMIN_TOKEN). Members cannot get
            pings, and members cannot be removed until it is.
          </Notice>
        )}
      </section>
    </>
  )
}
