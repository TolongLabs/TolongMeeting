import type { Metadata } from 'next'
import { Notice } from '../../components/Notice'
import { PageHeader } from '../../components/PageHeader'
import { SubmitButton } from '../../components/SubmitButton'
import { requireMember } from '../../lib/session'
import { sendTestPingFormAction, setUpNotificationsFormAction } from './form-actions'
import { TokenReveal } from './token-reveal'

export const metadata: Metadata = { title: 'Notifications' }

/** What `?notice=` may say. Anything else is ignored, so the address can't put words on the page. */
const NOTICES: Record<string, { kind: 'info' | 'warn' | 'error'; text: string }> = {
  ready: { kind: 'info', text: 'Notifications are set up. Now subscribe on your phone, then send a test ping.' },
  'setup-failed': {
    kind: 'error',
    text: 'The notification server refused the set-up. Try again in a minute. If it keeps failing, tell an admin.'
  },
  'ping-sent': { kind: 'info', text: 'The test ping was sent. Check your phone. It can take a few seconds.' },
  'ping-failed': {
    kind: 'error',
    text: 'The test ping did not go out. Try again in a minute. If it keeps failing, tell an admin.'
  }
}

function ntfyUrl(): string {
  const url = process.env.NTFY_URL
  if (!url) throw new Error('NTFY_URL is not set')
  return url
}

export default async function NotificationsPage({
  searchParams
}: {
  searchParams: Promise<{ notice?: string | string[] }>
}) {
  const scope = await requireMember()
  const [me, { notice }] = await Promise.all([scope.me(), searchParams])
  // Own keys only: `?notice=__proto__` or `constructor` must not find Object.prototype entries.
  const message = typeof notice === 'string' && Object.hasOwn(NOTICES, notice) ? NOTICES[notice] : undefined
  const topic = me.ntfyTopic && me.ntfyTokenEnc ? me.ntfyTopic : null

  return (
    <>
      <PageHeader title="Notifications">
        <p>
          The bot sends pings to your own private topic on the TolongLabs notification server (ntfy). Nobody else can
          read your topic.
        </p>
      </PageHeader>

      {message && <Notice kind={message.kind}>{message.text}</Notice>}

      {topic === null ? (
        <section aria-labelledby="setup">
          <h2 id="setup">Set up notifications</h2>
          <Notice kind="warn">
            Notifications are not set up. You will not get pings about your meetings until you set them up.
          </Notice>
          <form action={setUpNotificationsFormAction}>
            <SubmitButton pendingLabel="Setting up...">Set up notifications</SubmitButton>
          </form>
        </section>
      ) : (
        <>
          <section aria-labelledby="topic">
            <h2 id="topic">Your topic</h2>
            <dl>
              <dt>Server</dt>
              <dd>
                <code>{ntfyUrl()}</code>
              </dd>
              <dt>Topic</dt>
              <dd>
                <code>{topic}</code>
              </dd>
            </dl>
            <p>
              Your access token is secret. It is hidden until you press Show token in the phone steps below, and it is
              never saved on this page.
            </p>
          </section>

          <section aria-labelledby="phone">
            <h2 id="phone">Subscribe on your phone</h2>
            <ol>
              <li>Install the ntfy app from Google Play, F-Droid or the App Store.</li>
              <li>Open the app and press the plus button to add a subscription.</li>
              <li>
                Turn on &ldquo;Use another server&rdquo; and enter the server address above, then enter the topic above.
              </li>
              <li>If the app asks for a token or a login for this server, use the access token shown below.</li>
              <li>Press Subscribe, then send a test ping below.</li>
            </ol>
            <TokenReveal />
            <h3>On your computer</h3>
            <p>
              Open the server address in your browser, subscribe to the same topic and allow browser notifications. The
              TolongMeeting PC app, when you pair it on the Devices page, shows the same pings as desktop notifications.
            </p>
          </section>

          <section aria-labelledby="test">
            <h2 id="test">Send a test ping</h2>
            <form action={sendTestPingFormAction}>
              <SubmitButton pendingLabel="Sending...">Send a test ping</SubmitButton>
            </form>
          </section>
        </>
      )}

      <section aria-labelledby="priorities">
        <h2 id="priorities">What each ping means</h2>
        <h3>High priority: you may need to act now</h3>
        <ul>
          <li>A form was submitted.</li>
          <li>A form needs you, or an untrusted form was seen and not submitted.</li>
          <li>Someone said your name.</li>
          <li>A login expired.</li>
          <li>No meeting link by the start time.</li>
          <li>Two meetings clash.</li>
          <li>The bot failed, or dropped out of the meeting.</li>
        </ul>
        <h3>Normal priority: good to know</h3>
        <ul>
          <li>The bot joined.</li>
          <li>A form was seen but not submitted, because it is not an attendance form or it is a quiz.</li>
          <li>The meeting ended and the summary is ready.</li>
          <li>The transcript is waiting for your PC.</li>
          <li>An export finished.</li>
          <li>A meeting will be deleted in 3 days.</li>
        </ul>
        <p>Pings never contain meeting passcodes.</p>
      </section>
    </>
  )
}
