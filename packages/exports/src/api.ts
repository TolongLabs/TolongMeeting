import { z } from 'zod'
import type { ExportRow, MemberConnections, MemberExports, MemberOccurrences } from './store-types'
import {
  TARGET_CONNECTION,
  TARGET_LABEL,
  type ConnectionSummary,
  type ExportErrorCode,
  type ExportStatus,
  type ExportTargetId
} from './types'

// The member-facing export API, as plain functions over stores that are already bound to one member (a `MemberScope`
// made them, see `packages/web/db/exports.ts`). So no function here takes a member id, and none can name another
// member's row. The Route Handlers in `packages/web/app/api` only authenticate, call one of these and send the result.

/** The member-bound stores the API needs. `connections.get` is left out on purpose: the API never opens a token. */
export interface ApiDeps {
  exports: MemberExports
  connections: Pick<MemberConnections, 'summaries'>
  occurrences: MemberOccurrences
}

export interface ApiResult {
  status: number
  body: unknown
}

export interface ExportView {
  id: string
  target: ExportTargetId
  label: string
  status: ExportStatus
  createdAt: string
  finishedAt: string | null
  /** A download whose file was removed because a newer export of the same meeting and target replaced it. */
  replaced: boolean
  /** The page the provider made (always https), or null. */
  url: string | null
  downloadUrl: string | null
  note: string | null
  /** A fixed sentence for the error code. The stored text is never sent: it can quote what a provider said. */
  error: string | null
}

const TARGETS = ['zip', 'pdf', 'github', 'gdocs', 'notion'] as const satisfies readonly ExportTargetId[]
/** Anything past this is not a request body this API knows. */
const MAX_BODY_CHARS = 1024
const MAX_NOTE_CHARS = 200

export const MESSAGES = {
  alreadyRunning: 'This export is already running.',
  notReady: 'This meeting is still being processed.',
  notFound: 'Meeting not found.',
  tooMany: 'You have too many exports running. Wait for one to finish.',
  invalidTarget: 'Choose one of the export buttons.',
  failedFallback: 'The export failed. Try again.'
} as const

const NOT_FOUND: ApiResult = { status: 404, body: { error: 'not_found' } }

/** The one request body: `{ target }` and nothing else. */
const CreateBody = z.strictObject({ target: z.enum(TARGETS) })

const ERROR_TEXT: Record<ExportErrorCode, string> = {
  not_connected: 'Connect this service on the Connections page and try again.',
  reconnect_needed: 'Connect this service again on the Connections page.',
  invalid_settings: 'Check the settings on the Connections page and try again.',
  not_found: 'The export could not find its meeting or destination.',
  already_running: MESSAGES.alreadyRunning,
  not_ready: MESSAGES.notReady,
  meeting_deleted: 'This meeting has been deleted from TolongMeeting.',
  rate_limited: 'The service asked us to slow down. Try again in a few minutes.',
  interrupted: 'The export was interrupted. Try again.',
  failed: MESSAGES.failedFallback
}

const isDownloadTarget = (target: ExportTargetId): target is 'zip' | 'pdf' => target === 'zip' || target === 'pdf'

/** The download an export row stands for: only a finished zip or PDF, at exactly the path the runner is allowed to write. */
export function exportDownload(row: ExportRow): { path: string; contentType: string; ext: 'zip' | 'pdf' } | null {
  if (row.status !== 'succeeded') return null
  if (!isDownloadTarget(row.target)) return null
  const path = `exports/${row.id}.${row.target}`
  if (row.filePath !== path) return null
  return { path, ext: row.target, contentType: row.target === 'zip' ? 'application/zip' : 'application/pdf' }
}

/**
 * The name a download is saved as: made here from the target and the date the export was queued, never from the
 * stored title (that is text from the meeting, and the file name goes into a header).
 */
export function downloadFileName(row: ExportRow): string {
  const ext = row.target === 'pdf' ? 'pdf' : 'zip'
  return `tolongmeeting-${row.createdAt.toISOString().slice(0, 10)}-${row.target}.${ext}`
}

function httpsOrNull(url: string | null): string | null {
  if (url === null) return null
  try {
    return new URL(url).protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/** A row as the page sees it: no file path, no stored error text, no title. */
export function toExportView(row: ExportRow): ExportView {
  return {
    id: row.id,
    target: row.target,
    label: TARGET_LABEL[row.target],
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    replaced: isDownloadTarget(row.target) && row.status === 'succeeded' && row.filePath === null,
    url: httpsOrNull(row.url),
    downloadUrl: exportDownload(row) ? `/api/exports/${row.id}/file` : null,
    note: row.note === null ? null : row.note.slice(0, MAX_NOTE_CHARS),
    error: row.status === 'failed' ? ERROR_TEXT[row.errorCode ?? 'failed'] : null
  }
}

function invalid(error: string, message: string): ApiResult {
  return { status: 422, body: { error, message } }
}

/** Why a target cannot run with this connection, or null when it can. */
function connectionProblem(target: ExportTargetId, summaries: ConnectionSummary[]): ApiResult | null {
  const kind = TARGET_CONNECTION[target]
  if (kind === null) return null
  const label = TARGET_LABEL[target]
  const found = summaries.find((s) => s.kind === kind)
  if (!found) return invalid('not_connected', `Connect ${label} on the Connections page first.`)
  if (found.status === 'reconnect_needed')
    return invalid('reconnect_needed', `${label} needs you to connect again on the Connections page.`)
  if (!found.ready) {
    return invalid(
      'invalid_settings',
      kind === 'notion'
        ? 'Pick a Notion page or database for exports on the Connections page.'
        : `Finish the ${label} settings on the Connections page.`
    )
  }
  return null
}

/**
 * Queues an export. Order: the body (strict), the meeting (not yours and deleted are the same 404; only a finished
 * one can be exported), the connection and its settings, then the store, whose own refusals are mapped too.
 */
export async function createExportRequest(occurrenceId: string, rawBody: string, deps: ApiDeps): Promise<ApiResult> {
  let json: unknown
  try {
    json = rawBody.length > MAX_BODY_CHARS ? undefined : JSON.parse(rawBody)
  } catch {
    json = undefined
  }
  const parsed = CreateBody.safeParse(json)
  if (!parsed.success) return invalid('invalid_target', MESSAGES.invalidTarget)
  const { target } = parsed.data

  const occurrence = await deps.occurrences.get(occurrenceId)
  if (occurrence === null || occurrence.state === 'deleted') return NOT_FOUND
  if (occurrence.state !== 'completed') return { status: 409, body: { error: 'not_ready', message: MESSAGES.notReady } }

  const problem = connectionProblem(target, await deps.connections.summaries())
  if (problem) return problem

  const made = await deps.exports.create(occurrenceId, target)
  if (made.ok) return { status: 202, body: { exportId: made.row.id } }
  if (made.code === 'not_found') return NOT_FOUND
  if (made.code === 'not_ready') return { status: 409, body: { error: 'not_ready', message: MESSAGES.notReady } }
  if (made.code === 'too_many') return { status: 429, body: { error: 'too_many_exports', message: MESSAGES.tooMany } }
  return { status: 409, body: { error: 'already_running', message: MESSAGES.alreadyRunning } }
}

export async function listExportsRequest(occurrenceId: string, deps: ApiDeps): Promise<ApiResult> {
  const occurrence = await deps.occurrences.get(occurrenceId)
  if (occurrence === null || occurrence.state === 'deleted') return NOT_FOUND
  const rows = await deps.exports.listForOccurrence(occurrenceId)
  return { status: 200, body: { exports: rows.map(toExportView) } }
}

/** The masked status of each connection (what `summaries` returns: no token, no secret setting). */
export async function connectionsRequest(deps: Pick<ApiDeps, 'connections'>): Promise<ApiResult> {
  return { status: 200, body: { connections: await deps.connections.summaries() } }
}

/** What a button does, for the panel: remote targets need a ready connection, and a running export blocks its button. */
export function buttonState(
  target: ExportTargetId,
  connections: ConnectionSummary[],
  rows: Pick<ExportView, 'target' | 'status'>[]
): { enabled: boolean; hint: string | null } {
  if (rows.some((r) => r.target === target && (r.status === 'queued' || r.status === 'running')))
    return { enabled: false, hint: 'Exporting' }
  const kind = TARGET_CONNECTION[target]
  if (kind === null) return { enabled: true, hint: null }
  const label = TARGET_LABEL[target]
  const found = connections.find((c) => c.kind === kind)
  if (!found) return { enabled: false, hint: `Connect ${label} on the Connections page` }
  if (found.status === 'reconnect_needed') return { enabled: false, hint: `Reconnect ${label} on the Connections page` }
  if (!found.ready) return { enabled: false, hint: `Pick a ${label} page on the Connections page` }
  return { enabled: true, hint: null }
}
