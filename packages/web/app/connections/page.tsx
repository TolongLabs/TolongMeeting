import type { Metadata } from 'next'
import { notionClientFromEnv, oauthClientFromEnv, type ConnectionKind, type ConnectionSummary } from '@tm/exports/api'
import { ConfirmForm } from '../../components/ConfirmForm'
import { Notice } from '../../components/Notice'
import { PageHeader } from '../../components/PageHeader'
import { connectionNotice, githubFields } from '../../lib/connections-view'
import { exportStores } from '../../lib/exports'
import { requireMember } from '../../lib/session'
import { removeConnectionAction } from './actions'
import { DefaultFolderForm, GitHubForm } from './forms'
import { GoogleFolderPicker } from './google-picker'
import { NotionParent } from './notion-parent'

export const metadata: Metadata = { title: 'Connections' }

type Param = string | string[] | undefined

/** "Connected", "Reconnect needed" or "Not connected", in words. */
function Status({ summary, children }: { summary: ConnectionSummary | undefined; children?: React.ReactNode }) {
  if (!summary) return <p>Status: Not connected.</p>
  if (summary.status === 'reconnect_needed')
    return (
      <Notice kind="warn">
        Reconnect needed. {summary.label} no longer works, so exports to it fail until you connect again.
      </Notice>
    )
  return (
    <p>
      Status: Connected.{' '}
      {children ?? (
        <>
          {summary.label}. {summary.detail}.
        </>
      )}
    </p>
  )
}

function Remove(props: { kind: ConnectionKind; label: string; question: string }) {
  return (
    <ConfirmForm
      action={removeConnectionAction}
      label={`Remove ${props.label}`}
      question={props.question}
      confirmLabel={`Yes, remove ${props.label}`}
    >
      <input type="hidden" name="kind" value={props.kind} />
    </ConfirmForm>
  )
}

export default async function ConnectionsPage({
  searchParams
}: {
  searchParams: Promise<{ notice?: Param; google?: Param; notion?: Param }>
}) {
  const scope = await requireMember()
  const [summaries, params] = await Promise.all([exportStores(scope).connections.summaries(), searchParams])
  const byKind = (kind: ConnectionKind) => summaries.find((s) => s.kind === kind)
  const github = byKind('github')
  const google = byKind('google')
  const notion = byKind('notion')
  const googleReady = oauthClientFromEnv('google') !== null
  const notionReady = notionClientFromEnv() !== null
  const notice = connectionNotice(params)

  return (
    <>
      <PageHeader title="Connections">
        <p>
          Connect GitHub, Google Docs and Notion to export a finished meeting to your own copy. Each export is yours:
          deleting a meeting in TolongMeeting does not touch it.
        </p>
      </PageHeader>

      {notice && <Notice kind={notice.kind}>{notice.text}</Notice>}

      <section aria-labelledby="github">
        <h2 id="github">GitHub</h2>
        <Status summary={github} />
        <ol>
          <li>
            On GitHub, open Settings, Developer settings, Personal access tokens, Fine-grained tokens, and generate a
            new token.
          </li>
          <li>
            Under Repository access, choose &ldquo;Only select repositories&rdquo; and pick the repository for your
            notes.
          </li>
          <li>Under Repository permissions, set Contents to &ldquo;Read and write&rdquo;.</li>
          <li>Paste the token here. TolongMeeting keeps it encrypted and only uses it to commit your exports.</li>
        </ol>
        <GitHubForm fields={githubFields(github)} connected={github !== undefined} />
        {github && (
          <Remove
            kind="github"
            label="GitHub"
            question="Remove the GitHub connection? Exports to GitHub stop. TolongMeeting cannot delete your token on GitHub: delete it yourself under Settings, Developer settings, Personal access tokens, Fine-grained tokens."
          />
        )}
      </section>

      <section aria-labelledby="google">
        <h2 id="google">Google Docs</h2>
        <p>
          TolongMeeting can only see files it creates or that you pick. Exports go to &ldquo;TolongMeeting
          Exports&rdquo; in your Drive unless you pick another folder.
        </p>
        {!googleReady ? (
          <Notice kind="warn">Google Docs export is not set up on this server.</Notice>
        ) : (
          <>
            <Status summary={google}>
              {google && (
                <>
                  Signed in as {google.label}. Exports go to the folder {google.detail}.
                </>
              )}
            </Status>
            {(!google || google.status === 'reconnect_needed') && (
              <p>
                <a href="/api/connections/google/start">{google ? 'Connect Google again' : 'Connect Google'}</a>
              </p>
            )}
            {google?.status === 'ok' && (
              <>
                <GoogleFolderPicker />
                <DefaultFolderForm />
              </>
            )}
          </>
        )}
        {google && (
          <Remove
            kind="google"
            label="Google"
            question="Remove the Google connection? TolongMeeting asks Google to end its access. Documents already exported stay in your Drive."
          />
        )}
      </section>

      <section aria-labelledby="notion">
        <h2 id="notion">Notion</h2>
        <p>
          When Notion asks, select the page or database exports should go under. You can share more later from the
          page&rsquo;s menu, under Connections.
        </p>
        {!notionReady ? (
          <Notice kind="warn">Notion export is not set up on this server.</Notice>
        ) : (
          <>
            <Status summary={notion}>
              {notion && (
                <>
                  Workspace {notion.label}.{' '}
                  {notion.ready ? `Exports go under ${notion.detail}.` : 'No page is chosen yet.'}
                </>
              )}
            </Status>
            {(!notion || notion.status === 'reconnect_needed') && (
              <p>
                <a href="/api/connections/notion/start">{notion ? 'Connect Notion again' : 'Connect Notion'}</a>
              </p>
            )}
            {notion?.status === 'ok' && <NotionParent chosen={notion.ready} />}
          </>
        )}
        {notion && (
          <Remove
            kind="notion"
            label="Notion"
            question="Remove the Notion connection? TolongMeeting asks Notion to end its access. Pages already exported stay in Notion."
          />
        )}
      </section>
    </>
  )
}
