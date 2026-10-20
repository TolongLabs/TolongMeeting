import { connectionsRequest, createExportRequest, listExportsRequest, type ApiResult } from '@tm/exports'
import { memberExportStores, type MemberExportStores } from '../db/exports'
import { loadMasterKey } from '../db/secrets'
import type { MemberScope } from './scope'

// The export API as the site serves it. Every function takes the member's own stores (made from their `MemberScope`),
// so a handler can only reach that member's rows. Nothing here logs: a log line could carry a token or meeting text.

let master: Buffer | undefined

/** The export stores of one member. The master key is read once per process (`TM_MASTER_KEY_FILE`). */
export function exportStores(scope: MemberScope): MemberExportStores {
  const root = process.env.TM_DATA_ROOT
  if (!root) throw new Error('TM_DATA_ROOT is not set')
  master ??= loadMasterKey()
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
