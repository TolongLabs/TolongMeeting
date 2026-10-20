import {
  connectionsRequest,
  createExportRequest,
  listExportsRequest,
  notionClientFromEnv,
  removeConnection,
  saveGitHubConnection,
  type ApiResult,
  type ConnectionKind
} from '@tm/exports/api'
import { memberExportStores, type MemberExportStores } from '../db/exports'
import { cachedMasterKey } from '../db/secrets'
import { providerFetch } from './provider-fetch'
import type { MemberScope } from './scope'

// The export API as the site serves it. Every function takes the member's own stores (made from their `MemberScope`),
// so a handler can only reach that member's rows. Nothing here logs: a log line could carry a token or meeting text.

/** The export stores of one member. The master key is read once per key file (`TM_MASTER_KEY_FILE`). */
export function exportStores(scope: MemberScope): MemberExportStores {
  const root = process.env.TM_DATA_ROOT
  if (!root) throw new Error('TM_DATA_ROOT is not set')
  const master = cachedMasterKey()
  return memberExportStores(scope, master, root)
}

const NO_STORE = { 'Cache-Control': 'no-store' }

function send(result: ApiResult): Response {
  return Response.json(result.body, { status: result.status, headers: NO_STORE })
}

export async function createExportResponse(
  stores: MemberExportStores,
  occurrenceId: string,
  request: Request
): Promise<Response> {
  return send(await createExportRequest(occurrenceId, await request.text(), stores))
}

export async function listExportsResponse(stores: MemberExportStores, occurrenceId: string): Promise<Response> {
  return send(await listExportsRequest(occurrenceId, stores))
}

export async function connectionsResponse(stores: MemberExportStores): Promise<Response> {
  return send(await connectionsRequest(stores))
}

/** Saves the GitHub connection from a `PUT`. `http` is the network seam; the site uses the real `fetch`. */
export async function saveGitHubResponse(
  stores: MemberExportStores,
  request: Request,
  http: typeof fetch = providerFetch
): Promise<Response> {
  return send(await saveGitHubConnection(await request.text(), { connections: stores.connections, http }))
}

/**
 * Removes the member's connection of `kind` from a `DELETE`, and asks Google or Notion to revoke the grant. `http` is the
 * network seam. A failed revoke is logged by provider and status only; no token is returned or logged.
 */
export async function removeConnectionResponse(
  stores: MemberExportStores,
  kind: ConnectionKind,
  http: typeof fetch = providerFetch,
  log: (line: string) => void = (line) => console.error(line)
): Promise<Response> {
  return send(
    await removeConnection(kind, { connections: stores.connections, http, notionClient: notionClientFromEnv(), log })
  )
}
