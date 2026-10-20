import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { DEVICE_ONLINE_WINDOW_MS, chatWatchAllowed, watchGateFromEnv, type RunLocation } from '@tm/core'
import { ConfirmForm } from '../../components/ConfirmForm'
import { EmptyState } from '../../components/EmptyState'
import { Notice } from '../../components/Notice'
import { PageHeader } from '../../components/PageHeader'
import { RelativeTime } from '../../components/RelativeTime'
import { SubmitButton } from '../../components/SubmitButton'
import { scopeHomeNodeStore } from '../../db/home-route'
import { listDevices } from '../../lib/companion/tokens'
import { accountStatus, listIdentities, MOVE_BLOCK_WINDOW_MS, type IdentityRow } from '../../lib/identities'
import { BAN_RISK_NOTICE, TEAMS_PRESENCE_NOTE, watchingNotAllowedMessage } from '../../lib/link-notices'
import { requireMember } from '../../lib/session'
import { deleteIdentityFormAction, moveIdentityFormAction } from './form-actions'
import { IdentityForm } from './identity-form'
import { OpenOnPc } from './open-on-pc'

export const metadata: Metadata = { title: 'Accounts' }

const NOTICES: Record<string, string> = {
  created: 'The identity was added.',
  saved: 'The settings were saved.',
  deleted: 'The identity was deleted.',
  moved: 'The identity was moved.'
}

const MOVE_WINDOW_MINUTES = MOVE_BLOCK_WINDOW_MS / 60_000
const NOT_FINISHED = 'This identity has a meeting or sign-in that has not finished.'
const PROBLEMS: Record<string, string> = {
  move_busy: `${NOT_FINISHED} A meeting that starts within ${MOVE_WINDOW_MINUTES} minutes also blocks a move. Try again after it ends.`,
  move_gone: 'This identity was not found. Reload the page.',
  move_no_pc: 'That PC is not paired any more. Pair it again on the Devices page, then try again.',
  move_no_home: 'Set up your home connection first, then move the identity there.',
  delete_has_entries: 'This identity still has timetable entries. Move or delete those entries first.',
  delete_busy: `${NOT_FINISHED} Try again after it ends.`,
  delete_failed: 'The identity could not be deleted. Try again.',
  gone: 'This identity was not found. Reload the page.'
}

const WHERE: Record<RunLocation, string> = {
  server: 'The server',
  server_via_home: 'The server, through your home connection',
  local: 'My PC'
}

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

function MoveButton(props: { identityId: string; where: string; children: string }) {
  return (
    <form action={moveIdentityFormAction}>
      <input type="hidden" name="id" value={props.identityId} />
      <input type="hidden" name="where" value={props.where} />
      <SubmitButton pendingLabel="Moving...">{props.children}</SubmitButton>
    </form>
  )
}

export default async function AccountsPage({
  searchParams
}: {
  searchParams: Promise<{ notice?: string | string[]; problem?: string | string[]; for?: string | string[] }>
}) {
  const scope = await requireMember()
  const now = new Date()
  const query = await searchParams
  const [me, identities, devices, homeNode] = await Promise.all([
    scope.me(),
    listIdentities(scope),
    listDevices(scope),
    scopeHomeNodeStore(scope).get()
  ])
  const gate = watchGateFromEnv(process.env)
  const pcs = devices.filter((d) => d.revokedAt === null)
  const pcOnline = (lastUsedAt: Date | null) =>
    lastUsedAt !== null && now.getTime() - lastUsedAt.getTime() <= DEVICE_ONLINE_WINDOW_MS

  // Only a code from the lists is shown; anything else in the URL is ignored and never echoed.
  const noticeCode = one(query.notice)
  const problemCode = one(query.problem)
  const notice = noticeCode !== undefined && Object.hasOwn(NOTICES, noticeCode) ? NOTICES[noticeCode] : undefined
  const problem = problemCode !== undefined && Object.hasOwn(PROBLEMS, problemCode) ? PROBLEMS[problemCode] : undefined
  const forId = identities.find((i) => i.id === one(query.for))?.id

  const statuses = await Promise.all(identities.map((i) => accountStatus(scope, i.id)))

  function Outcome({ identityId }: { identityId: string | null }) {
    // A result that names an identity shows in that identity's section; one that names none shows at the top.
    if (identityId !== (forId ?? null)) return null
    return (
      <>
        {notice && <Notice kind="info">{notice}</Notice>}
        {problem && <Notice kind="error">{problem}</Notice>}
      </>
    )
  }

  function Where({ identity }: { identity: IdentityRow }) {
    const bound = pcs.find((d) => d.id === identity.localDeviceId)
    const moves: ReactNode[] = []
    if (identity.runLocation !== 'server')
      moves.push(
        <li key="server">
          <MoveButton identityId={identity.id} where="server">
            Move to the server
          </MoveButton>
        </li>
      )
    if (identity.runLocation !== 'server_via_home')
      moves.push(
        <li key="home">
          {homeNode ? (
            <MoveButton identityId={identity.id} where="server_via_home">
              Move to the server through my home connection
            </MoveButton>
          ) : (
            <>
              The server through my home connection: <Link href="/accounts/home">set up your home connection</Link>{' '}
              first.
            </>
          )}
        </li>
      )
    for (const pc of pcs)
      if (!(identity.runLocation === 'local' && identity.localDeviceId === pc.id))
        moves.push(
          <li key={pc.id}>
            <ConfirmForm
              action={moveIdentityFormAction}
              label={`Move to my PC ${pc.name}`}
              question={`Move ${identity.name} to ${pc.name}? The browser profile kept on the server for this identity is deleted, and you sign in again on your PC.`}
              confirmLabel={`Move to ${pc.name}`}
            >
              <input type="hidden" name="id" value={identity.id} />
              <input type="hidden" name="where" value={`local:${pc.id}`} />
            </ConfirmForm>
          </li>
        )
    if (pcs.length === 0)
      moves.push(
        <li key="no-pc">
          My PC: no PC is paired yet. Pair one on the <Link href="/devices">Devices</Link> page.
        </li>
      )
    return (
      <>
        <p>
          <strong>{WHERE[identity.runLocation]}</strong>
          {identity.runLocation === 'local' &&
            (bound
              ? ` (${bound.name}, ${pcOnline(bound.lastUsedAt) ? 'online' : 'offline'})`
              : ' (no PC is paired for it)')}
        </p>
        <ul className="list">{moves}</ul>
      </>
    )
  }

  function SignIn({ identity, anySignedOut }: { identity: IdentityRow; anySignedOut: boolean }) {
    if (identity.runLocation === 'server' || identity.runLocation === 'server_via_home')
      return (
        <>
          <p>
            <Link href={`/accounts/${identity.id}/signin`}>
              {anySignedOut ? `Sign in again to ${identity.name}` : `Sign in to ${identity.name}`}
            </Link>
          </p>
          {identity.runLocation === 'server_via_home' && <p>Sign-in goes through your home connection.</p>}
        </>
      )
    if (identity.runLocation === 'local') {
      const bound = pcs.find((d) => d.id === identity.localDeviceId)
      return bound ? (
        <OpenOnPc identityId={identity.id} pcName={bound.name} />
      ) : (
        <p>No PC is paired for this identity. Pair a PC on the Devices page, then move the identity to it again.</p>
      )
    }
    return (
      <p>
        Remote sign-in is only for identities that run on the server. To sign in to this identity, move it to the server
        first. A sign-in on the server comes from the server&apos;s address, not from your home connection.
      </p>
    )
  }

  return (
    <>
      <PageHeader title="Accounts">
        <p>
          Each identity has its own kept browser profile and signs in to its own accounts. Your times are shown in{' '}
          {me.timeZone}.
        </p>
      </PageHeader>

      <Outcome identityId={null} />
      <Notice kind="warn">{BAN_RISK_NOTICE}</Notice>

      <section aria-labelledby="where-rules">
        <h2 id="where-rules">Where an identity runs</h2>
        <ul>
          <li>The server: the default.</li>
          <li>
            The server through your home connection: the bot runs on the server but its traffic leaves through a device
            at home, which must be on during meetings. <Link href="/accounts/home">Set up your home connection</Link>.
          </li>
          <li>My PC: the TolongMeeting desktop app runs the bot, and the browser profile stays on your PC.</li>
        </ul>
        <p>
          You can move an identity when none of its meetings is running and none starts within {MOVE_WINDOW_MINUTES}{' '}
          minutes. Meetings further away start at the new place.
        </p>
      </section>

      {identities.length === 0 ? (
        <EmptyState title="No identities yet">
          <p>
            An identity is a name such as University or Work, with its own kept browser profile. Add one below, then
            sign in to its accounts.
          </p>
        </EmptyState>
      ) : (
        identities.map((identity, index) => {
          const accounts = statuses[index]!
          const signedOut = accounts.filter((a) => a.signedIn === false)
          return (
            <section key={identity.id} aria-labelledby={`identity-${identity.id}`}>
              <h2 id={`identity-${identity.id}`}>{identity.name}</h2>
              <Outcome identityId={identity.id} />
              <p>
                Zoom display name for guest joins: {identity.zoomGuestName}.
                {identity.orgName && ` Organisation: ${identity.orgName} (${identity.orgEmailDomain}).`}
              </p>

              <h3>Run location</h3>
              <Where identity={identity} />

              <h3>Accounts</h3>
              {signedOut.length > 0 && (
                <Notice kind="warn">
                  {signedOut.map((a) => a.label).join(', ')} {signedOut.length === 1 ? 'is' : 'are'} signed out.
                  Meetings that need {signedOut.length === 1 ? 'it' : 'them'} will not start until you sign in again.
                </Notice>
              )}
              <table aria-label={`Accounts of ${identity.name}`}>
                <thead>
                  <tr>
                    <th scope="col">Account</th>
                    <th scope="col">Status</th>
                    <th scope="col">Last checked</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => (
                    <tr key={a.kind}>
                      <th scope="row">{a.label}</th>
                      <td>{a.signedIn === null ? 'Not checked yet' : a.signedIn ? 'Signed in' : 'Signed out'}</td>
                      <td>{a.verifiedAt ? <RelativeTime at={a.verifiedAt} timeZone={me.timeZone} /> : 'Never'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(['whatsapp', 'discord'] as const)
                .filter((app) => !chatWatchAllowed(app, identity.runLocation, gate))
                .map((app) => (
                  <p key={app}>{watchingNotAllowedMessage(app, gate)}</p>
                ))}
              <SignIn identity={identity} anySignedOut={signedOut.length > 0} />

              <details>
                <summary>Edit settings</summary>
                <IdentityForm
                  prefix={`edit-${identity.id}`}
                  identityId={identity.id}
                  initial={{
                    name: identity.name,
                    zoomGuestName: identity.zoomGuestName,
                    orgName: identity.orgName ?? '',
                    orgEmailDomain: identity.orgEmailDomain ?? ''
                  }}
                />
              </details>
              <ConfirmForm
                action={deleteIdentityFormAction}
                label={`Delete ${identity.name}`}
                question={`Delete ${identity.name}? Its past meetings, with their recordings and summaries, and its kept browser profile are removed. A timetable entry, or a meeting or sign-in that has not finished, stops the delete.`}
                confirmLabel="Delete this identity"
              >
                <input type="hidden" name="id" value={identity.id} />
              </ConfirmForm>
            </section>
          )
        })
      )}

      <section aria-labelledby="notes">
        <h2 id="notes">Good to know</h2>
        <p>{TEAMS_PRESENCE_NOTE}</p>
        <p>TolongMeeting never stores your passwords. You sign in yourself, in a view of the bot&apos;s browser.</p>
      </section>

      <section aria-labelledby="add">
        <h2 id="add">Add an identity</h2>
        <IdentityForm
          prefix="new"
          initial={{ name: '', zoomGuestName: me.displayName, orgName: '', orgEmailDomain: '' }}
        />
      </section>
    </>
  )
}
