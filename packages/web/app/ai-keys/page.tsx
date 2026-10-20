import type { Metadata } from 'next'
import { ConfirmForm } from '../../components/ConfirmForm'
import { Notice } from '../../components/Notice'
import { PageHeader } from '../../components/PageHeader'
import { RelativeTime } from '../../components/RelativeTime'
import { SubmitButton } from '../../components/SubmitButton'
import { loadMasterKey } from '../../db/secrets'
import { loadAiKeyStatus, type AiKeyStatus } from '../../lib/ai-keys'
import { requireMember } from '../../lib/session'
import { removeKeyFormAction, testKeyFormAction } from './form-actions'
import { KeyForm } from './key-form'

export const metadata: Metadata = { title: 'AI keys' }

/** What `?notice=` may say. Anything else is ignored, so the address can't put words on the page. */
const NOTICES: Record<string, { kind: 'info' | 'warn'; text: string }> = {
  saved: { kind: 'info', text: 'Saved. The key passed its test.' },
  'saved-failing': { kind: 'warn', text: 'Saved, but the test failed. The reason is under the key.' },
  tested: { kind: 'info', text: 'The test passed.' },
  'tested-failing': { kind: 'warn', text: 'The test failed. The reason is under the key.' },
  'removed-dashscope': { kind: 'info', text: 'The DashScope key is removed.' },
  'removed-modelscope': { kind: 'info', text: 'The ModelScope key is removed.' }
}

function TestResult(props: { ok: boolean | null; error: string | null; testedAt: Date | null; timeZone: string }) {
  if (props.testedAt === null || props.ok === null) {
    return <p>Not tested yet. Press Test again to check this key.</p>
  }
  return props.ok ? (
    <p>
      Working. Last tested <RelativeTime at={props.testedAt} timeZone={props.timeZone} />.
    </p>
  ) : (
    <>
      <p>
        <strong>Failing.</strong> Last tested <RelativeTime at={props.testedAt} timeZone={props.timeZone} />.
      </p>
      {props.error && <Notice kind="error">{props.error}</Notice>}
    </>
  )
}

function Providers({ status, timeZone }: { status: AiKeyStatus | null; timeZone: string }) {
  return (
    <>
      <section aria-labelledby="dashscope">
        <h2 id="dashscope">DashScope key (required)</h2>
        {status ? (
          <>
            <p>
              {status.dashscopeSuffix ? (
                <>
                  Saved key ending in <code>{status.dashscopeSuffix}</code>.
                </>
              ) : (
                'Saved key.'
              )}
              {status.workspaceId ? ` Workspace ID: ${status.workspaceId}.` : ' No Workspace ID.'}
            </p>
            <TestResult
              ok={status.dashscopeOk}
              error={status.dashscopeOk ? null : status.testError}
              testedAt={status.testedAt}
              timeZone={timeZone}
            />
          </>
        ) : (
          <Notice kind="warn">
            No DashScope key is saved. Meetings that need cloud AI cannot be scheduled until you add a working key.
          </Notice>
        )}
        <KeyForm provider="dashscope" saved={status !== null} workspaceId={status?.workspaceId ?? null} />
        {status && (
          <>
            <form action={testKeyFormAction}>
              <SubmitButton pendingLabel="Testing...">Test again</SubmitButton>
            </form>
            <ConfirmForm
              action={removeKeyFormAction}
              label="Remove the DashScope key"
              question="Remove the DashScope key? Your ModelScope key is removed too, and you cannot schedule meetings that need cloud AI until you add a new key."
              confirmLabel="Yes, remove the key"
            >
              <input type="hidden" name="provider" value="dashscope" />
            </ConfirmForm>
          </>
        )}
      </section>

      <section aria-labelledby="modelscope">
        <h2 id="modelscope">ModelScope key (optional)</h2>
        <p>An alternative provider for text tasks. The bot does not send your meetings to it yet.</p>
        {status === null ? (
          <p>Add a DashScope key first.</p>
        ) : (
          <>
            {status.modelscope ? (
              <>
                <p>
                  {status.modelscope.suffix ? (
                    <>
                      Saved key ending in <code>{status.modelscope.suffix}</code>.
                    </>
                  ) : (
                    'Saved key.'
                  )}
                </p>
                <TestResult
                  ok={status.modelscope.ok}
                  error={status.modelscope.ok === false && status.dashscopeOk ? status.testError : null}
                  testedAt={status.testedAt}
                  timeZone={timeZone}
                />
              </>
            ) : (
              <p>No ModelScope key is saved.</p>
            )}
            <KeyForm provider="modelscope" saved={status.modelscope !== null} workspaceId={null} />
            {status.modelscope && (
              <ConfirmForm
                action={removeKeyFormAction}
                label="Remove the ModelScope key"
                question="Remove the ModelScope key? Your DashScope key stays."
                confirmLabel="Yes, remove the key"
              >
                <input type="hidden" name="provider" value="modelscope" />
              </ConfirmForm>
            )}
          </>
        )}
      </section>
    </>
  )
}

export default async function AiKeysPage({ searchParams }: { searchParams: Promise<{ notice?: string | string[] }> }) {
  const scope = await requireMember()
  const [status, me, { notice }] = await Promise.all([
    loadAiKeyStatus(scope, loadMasterKey()),
    scope.me(),
    searchParams
  ])
  // Only a code from the list is shown; anything else in the URL is ignored and never echoed.
  const message = typeof notice === 'string' && Object.hasOwn(NOTICES, notice) ? NOTICES[notice] : undefined

  return (
    <>
      <PageHeader title="AI keys">
        <p>
          The bot uses your own Alibaba Cloud (DashScope) key to write summaries, read slides and match forms. You pay
          Alibaba for what it uses. Meetings that need cloud AI cannot be scheduled without a working key.
        </p>
      </PageHeader>

      {message && <Notice kind={message.kind}>{message.text}</Notice>}

      <Providers status={status} timeZone={me.timeZone} />

      <section aria-labelledby="privacy">
        <h2 id="privacy">Where your data goes</h2>
        <ul>
          <li>
            Transcripts, slides and form questions go to Alibaba Cloud, Singapore region, on your key. Alibaba keeps
            prompts and responses for up to 30 days. Under its policy updated on 1 October 2026, it does not use
            business inputs for training without consent.
          </li>
          <li>Keys are tied to a region. Create a Singapore (international) key in the Alibaba Cloud console.</li>
          <li>
            Your keys are stored encrypted. This page shows only the last four characters, and never the whole key.
          </li>
        </ul>
      </section>
    </>
  )
}
