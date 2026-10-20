import type { OccurrenceState } from '@tm/core'

export type ExportTargetId = 'zip' | 'pdf' | 'github' | 'gdocs' | 'notion'
export type ExportStatus = 'queued' | 'running' | 'succeeded' | 'failed'
export type ConnectionKind = 'github' | 'google' | 'notion'

export const TARGET_LABEL: Record<ExportTargetId, string> = {
  zip: 'Markdown zip',
  pdf: 'PDF',
  github: 'GitHub',
  gdocs: 'Google Docs',
  notion: 'Notion'
}

/** The most exports one member may have queued or running at once, across all meetings. */
export const MAX_ACTIVE_EXPORTS_PER_MEMBER = 3
/** The note a download keeps after a newer export of the same meeting and target replaced its file. */
export const REPLACED_NOTE = 'Replaced by a newer export.'

export const TARGET_CONNECTION: Record<ExportTargetId, ConnectionKind | null> = {
  zip: null,
  pdf: null,
  github: 'github',
  gdocs: 'google',
  notion: 'notion'
}

/** One file of a bundle. `path` is relative to the bundle root, e.g. "slides/01.webp". */
export interface BundleFile {
  path: string
  bytes: Uint8Array
}

export interface ExportBundle {
  /** The summary file name without ".md": "YYYY-MM-DD HHmm <entry name>". */
  title: string
  /** `slugify(title)`: the folder name in zips and repositories. */
  dirName: string
  /** `${title}.md` */
  summaryFile: string
  /** Summary, transcript.md, slides.md, chat.md, slides/NN.webp: only those that exist. */
  files: BundleFile[]
}

export interface GitHubConnection {
  kind: 'github'
  token: string
  owner: string
  repo: string
  branch: string
  folder: string
}

export interface GoogleConnection {
  kind: 'google'
  refreshToken: string
  account: string
  folderId: string
  folderName: string
  folderIsDefault: boolean
}

export interface NotionParent {
  type: 'page_id' | 'data_source_id'
  id: string
  name: string
  titleProperty: string
}

export interface NotionConnection {
  kind: 'notion'
  accessToken: string
  refreshToken: string | null
  workspace: string
  parent: NotionParent | null
}

export type Connection = GitHubConnection | GoogleConnection | NotionConnection

export interface ConnectionSummary {
  kind: ConnectionKind
  status: 'ok' | 'reconnect_needed'
  ready: boolean
  label: string
  detail: string
}

export interface OAuthClient {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export interface ExportContext {
  exportId: string
  memberId: string
  /** `${occurrence dir}/exports` */
  outDir: string
  connection: Connection | null
  /** Saves rotated tokens and a recreated default folder. */
  saveConnection(c: Connection): Promise<void>
  http: typeof fetch
  sleep(ms: number): Promise<void>
  /** Aborts at the export's deadline. Work that is not a network call checks it before it changes anything. */
  signal: AbortSignal
  /** The page URL of this member's latest finished export of the same meeting and target, or null. Updates use it. */
  previousUrl?: string | null
}

export interface ExportResult {
  url: string | null
  filePath: string | null
  note: string | null
}

export interface ExportTarget {
  readonly id: ExportTargetId
  run(bundle: ExportBundle, ctx: ExportContext): Promise<ExportResult>
}

export type ExportErrorCode =
  | 'not_connected'
  | 'reconnect_needed'
  | 'invalid_settings'
  | 'not_found'
  | 'already_running'
  | 'not_ready'
  | 'meeting_deleted'
  | 'rate_limited'
  | 'interrupted'
  | 'failed'

export class ExportError extends Error {
  /** The message is shown to the member as it is. */
  constructor(
    readonly code: ExportErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ExportError'
  }
}

export interface OccurrenceInfo {
  id: string
  memberId: string
  state: OccurrenceState
  dataDir: string
}

/** Resolves to null unless the member owns the occurrence. */
export interface OccurrenceLookup {
  get(memberId: string, occurrenceId: string): Promise<OccurrenceInfo | null>
}
