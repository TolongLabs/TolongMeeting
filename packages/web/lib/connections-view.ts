import type { ConnectionKind, ConnectionSummary } from '@tm/exports/api'

// What the Connections page says, kept apart from the page so a test can read it. Every sentence here is fixed: the
// address can pick one of them by key, and a key it does not know says nothing.

export type NoticeKind = 'info' | 'warn' | 'error'
export interface PageNotice {
  kind: NoticeKind
  text: string
}

const INVALID_STATE = 'The sign-in link is invalid or has expired. Start again.'

/** What `?notice=` may say: the result of a form on the page. */
const NOTICES: Record<string, PageNotice> = {
  'github-saved': { kind: 'info', text: 'GitHub is connected. Exports can now go to your repository.' },
  'folder-default': { kind: 'info', text: 'Exports now go to "TolongMeeting Exports" in your Google Drive.' },
  'not-connected': { kind: 'warn', text: 'That service is not connected.' },
  'removed-github': {
    kind: 'info',
    text: 'GitHub is removed. Also delete the token on GitHub: Settings, Developer settings, Personal access tokens, Fine-grained tokens.'
  },
  'removed-google': { kind: 'info', text: 'Google is removed, and Google access is revoked.' },
  'removed-google-manual': {
    kind: 'warn',
    text: 'Google is removed. To end access fully, remove TolongMeeting in your Google Account under Security, Third-party access.'
  },
  'removed-notion': { kind: 'info', text: 'Notion is removed, and Notion access is revoked.' },
  'removed-notion-manual': {
    kind: 'warn',
    text: 'Notion is removed. To end access fully, disconnect TolongLabs in Notion under Settings, Connections.'
  }
}

/** What `?google=` may say: how the Google sign-in ended. */
const GOOGLE_RESULTS: Record<string, PageNotice> = {
  connected: {
    kind: 'info',
    text: 'Google is connected. Exports go to "TolongMeeting Exports" unless you pick a folder.'
  },
  google_denied: { kind: 'warn', text: 'Google sign-in was cancelled.' },
  google_rejected: { kind: 'error', text: 'Google rejected the sign-in. Try connecting again.' },
  google_scope: { kind: 'error', text: 'Allow TolongMeeting to create files in Google Drive, then try again.' },
  google_no_refresh_token: {
    kind: 'error',
    text: "Google didn't send a refresh token. Remove TolongMeeting from your Google account's third-party access, then connect again."
  },
  google_unavailable: { kind: 'error', text: 'Google did not answer as expected. Try again later.' },
  invalid_state: { kind: 'error', text: INVALID_STATE }
}

/** What `?notion=` may say: how the Notion sign-in ended. */
const NOTION_RESULTS: Record<string, PageNotice> = {
  connected: { kind: 'info', text: 'Notion is connected. Now choose the page or database that exports go under.' },
  not_granted: { kind: 'warn', text: 'Notion access was not granted. Start again and choose the pages to share.' },
  notion_rejected: { kind: 'error', text: 'Notion did not accept the sign-in. Start again.' },
  notion_unavailable: { kind: 'error', text: 'Notion did not answer as expected. Try again later.' },
  invalid_state: { kind: 'error', text: INVALID_STATE }
}

type Param = string | string[] | undefined

/** The entry for `key` in `table`, or undefined. Only the table's own keys count, so `__proto__` finds nothing. */
const own = <T>(table: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined

/** The one notice the address asks for, if it names a known one. A provider result wins over a form result. */
export function connectionNotice(params: { notice?: Param; google?: Param; notion?: Param }): PageNotice | undefined {
  const { notice, google, notion } = params
  if (typeof google === 'string')
    return (
      own(GOOGLE_RESULTS, google) ?? { kind: 'error', text: 'Google sign-in did not finish. Try connecting again.' }
    )
  if (typeof notion === 'string')
    return (
      own(NOTION_RESULTS, notion) ?? { kind: 'error', text: 'Notion sign-in did not finish. Try connecting again.' }
    )
  return typeof notice === 'string' ? own(NOTICES, notice) : undefined
}

/**
 * The `?notice=` key for a finished removal. `message` is the fixed sentence the remove API answered with; Google and
 * Notion say "revoked" when the provider ended the access, and otherwise ask the member to do it.
 */
export function removalNoticeKey(kind: ConnectionKind, message: string): string {
  if (kind === 'github') return 'removed-github'
  return /\brevoked\b/.test(message) ? `removed-${kind}` : `removed-${kind}-manual`
}

export interface GitHubFields {
  owner: string
  repo: string
  branch: string
  folder: string
}

/** The GitHub form's starting values: what the connection's summary says, else a blank form on `main`. */
export function githubFields(summary: ConnectionSummary | undefined): GitHubFields {
  const blank: GitHubFields = { owner: '', repo: '', branch: 'main', folder: '' }
  if (summary?.kind !== 'github') return blank
  const [owner, repo] = summary.label.split('/')
  const where = /^branch (\S+), folder (.*)$/.exec(summary.detail)
  if (!owner || !repo || !where) return blank
  return { owner, repo, branch: where[1]!, folder: where[2] === '/' ? '' : where[2]! }
}
