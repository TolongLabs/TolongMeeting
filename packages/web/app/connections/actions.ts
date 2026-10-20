'use server'

import {
  ExportError,
  oauthClientFromEnv,
  saveGitHubConnection,
  setGoogleFolder,
  type ConnectionKind
} from '@tm/exports/api'
import { redirect } from 'next/navigation'
import { exportStores, removeConnectionResponse } from '../../lib/exports'
import { providerFetch } from '../../lib/provider-fetch'
import { removalNoticeKey } from '../../lib/connections-view'
import { requireMember } from '../../lib/session'
import type { FolderFormState, GitHubFormState } from './form-state'

// Server actions: public endpoints, so each gets the member from the session and never from client input. A token is
// read from the form once and handed to the export API, which seals it. No result, redirect or log carries it, and
// every refusal is the fixed sentence the export API answered with.

const KINDS: readonly ConnectionKind[] = ['github', 'google', 'notion']
const TRY_AGAIN = 'The connection was not saved. Try again.'

const text = (formData: FormData, name: string) => {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/** The `message` of an export API answer, which is always a fixed sentence. */
function messageOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('message' in body)) return null
  return typeof body.message === 'string' ? body.message : null
}

/** Checks the token and repository at GitHub, saves the connection and goes back to the page. */
export async function saveGitHubAction(_previous: GitHubFormState, formData: FormData): Promise<GitHubFormState> {
  const scope = await requireMember()
  const values = {
    owner: text(formData, 'owner'),
    repo: text(formData, 'repo'),
    branch: text(formData, 'branch'),
    folder: text(formData, 'folder')
  }
  const token = text(formData, 'token')
  const result = await saveGitHubConnection(JSON.stringify({ ...values, ...(token !== '' && { token }) }), {
    connections: exportStores(scope).connections,
    http: providerFetch
  })
  if (result.status === 200) redirect('/connections?notice=github-saved')
  return { status: 'error', message: messageOf(result.body) ?? TRY_AGAIN, values }
}

/** Sends exports back to the "TolongMeeting Exports" folder in the member's Drive. */
export async function defaultFolderAction(): Promise<FolderFormState> {
  const scope = await requireMember()
  const client = oauthClientFromEnv('google')
  if (client === null) return { status: 'error', message: 'Google Docs export is not set up on this server.' }
  const result = await setGoogleFolder(JSON.stringify({ useDefault: true }), {
    connections: exportStores(scope).connections,
    http: providerFetch,
    client
  })
  if (result.status === 200) redirect('/connections?notice=folder-default')
  return { status: 'error', message: messageOf(result.body) ?? TRY_AGAIN }
}

function failureRedirect(kind: ConnectionKind): never {
  if (kind === 'google') redirect('/connections?google=google_unavailable')
  if (kind === 'notion') redirect('/connections?notion=notion_unavailable')
  redirect('/connections?notice=not-connected')
}

/** Removes the connection named by the form (`kind`), asks the provider to revoke where it can, and goes back. */
export async function removeConnectionAction(formData: FormData): Promise<void> {
  const scope = await requireMember()
  const kind = KINDS.find((k) => k === formData.get('kind'))
  if (!kind) redirect('/connections')
  let response: Response
  try {
    response = await removeConnectionResponse(exportStores(scope), kind)
  } catch (e) {
    if (e instanceof ExportError) failureRedirect(kind)
    throw e
  }
  if (response.status === 404) redirect('/connections?notice=not-connected')
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // If response body was not valid JSON, messageOf returns null.
  }
  const message = messageOf(body)
  if (response.status !== 200 || message === null) failureRedirect(kind)
  redirect(`/connections?notice=${removalNoticeKey(kind, message)}`)
}
