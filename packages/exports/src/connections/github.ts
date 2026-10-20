import { z } from 'zod'
import type { ApiResult } from '../api'
import type { MemberConnections } from '../store-types'
import { ExportError, type ConnectionSummary, type GitHubConnection } from '../types'

// GitHub is the one connection with no OAuth app: the member pastes a fine-grained token limited to one repository.
// Nothing here stores or logs a token, and every message is a fixed sentence (never text from GitHub).

export const GITHUB_API = 'https://api.github.com'
export const FOLDER_MESSAGE = 'Use a folder path inside the repository, without ".." or ".git".'
const TOKEN_MESSAGE = 'Use a fine-grained token (it starts with github_pat_) limited to this repository.'
const SETTINGS_MESSAGE = 'Check the owner, repository, branch and folder.'
const NAME_MESSAGE = 'Use the owner and repository name exactly as they appear on GitHub.'
const BRANCH_MESSAGE = 'Use the branch name exactly as it appears on GitHub.'
const MAX_BODY_CHARS = 4096
const MAX_FOLDER_CHARS = 200

const OWNER = /^[A-Za-z0-9_.-]{1,39}$/
const REPO = /^[A-Za-z0-9_.-]{1,100}$/
const TOKEN = /^github_pat_\w{1,500}$/
/** Control characters and invisible format characters (zero-width space and joiners, bidi marks, the byte order mark). */
const CONTROL = /[\p{Cc}\p{Cf}]/u
/** Names Git treats as its own folder: `.git`, `.git.` and `.git ` (Windows drops trailing dots and spaces), and `git~1`. */
const GIT_DIR = /^(\.git|git~1)$/i

/** `.` and `..` match the name patterns but would climb out of `/repos/<owner>/<repo>` in a URL path. */
function isDotName(name: string): boolean {
  return name === '.' || name === '..'
}

export function isOwner(owner: string): boolean {
  return OWNER.test(owner) && !isDotName(owner)
}

export function isRepo(repo: string): boolean {
  return REPO.test(repo) && !isDotName(repo)
}

/** A branch name that is safe in a URL path and in a ref: no `..`, no empty or dotted segment, no `.lock` ending. */
export function isBranch(branch: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch)) return false
  if (branch.endsWith('/') || branch.endsWith('.') || branch.includes('//') || branch.includes('..')) return false
  return branch.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'))
}

/**
 * The folder inside the repository, as `a/b/c` or '' for the root. Backslashes count as slashes, empty and `.` segments
 * go, and a `..` segment, a `.git` or `git~1` segment (also with trailing dots or spaces) or a control or zero-width character is refused. A leading slash is dropped, so the result is
 * always relative.
 */
export function normaliseRepoFolder(input: string): string {
  // Checked before `trim`, which would also drop a byte order mark or a zero-width space at the edge of a segment.
  // Plain white space around the whole input is still forgiven (a pasted line end).
  if (CONTROL.test(input.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '')))
    throw new ExportError('invalid_settings', FOLDER_MESSAGE)
  const parts = input
    .trim()
    .replaceAll('\\', '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part !== '' && part !== '.')
  for (const part of parts) {
    if (part === '..' || GIT_DIR.test(part.replace(/[. ]+$/, '')))
      throw new ExportError('invalid_settings', FOLDER_MESSAGE)
  }
  const folder = parts.join('/')
  if (folder.length > MAX_FOLDER_CHARS) throw new ExportError('invalid_settings', FOLDER_MESSAGE)
  return folder
}

/** The stored settings of a connection, checked again before any request is built from them. */
export function checkedSettings(c: Pick<GitHubConnection, 'owner' | 'repo' | 'branch' | 'folder'>): {
  owner: string
  repo: string
  branch: string
  folder: string
} {
  if (!isOwner(c.owner) || !isRepo(c.repo)) throw new ExportError('invalid_settings', NAME_MESSAGE)
  if (!isBranch(c.branch)) throw new ExportError('invalid_settings', BRANCH_MESSAGE)
  return { owner: c.owner, repo: c.repo, branch: c.branch, folder: normaliseRepoFolder(c.folder) }
}

/** A path made of URL-encoded segments, for `/repos/.../contents/<path>` and `branches/<name>`. */
export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

/** The headers of every GitHub request. The token is only ever in `Authorization`. */
export function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'TolongMeeting'
  }
}

const Body = z.strictObject({
  owner: z.string(),
  repo: z.string(),
  branch: z.string(),
  folder: z.string(),
  token: z.string().optional()
})

function invalid(message: string): ApiResult {
  return { status: 400, body: { error: 'invalid_settings', message } }
}

type SaveDeps = { connections: Pick<MemberConnections, 'get' | 'save'>; http: typeof fetch }

async function probe(http: typeof fetch, token: string, path: string): Promise<number> {
  const res = await http(`${GITHUB_API}${path}`, { method: 'GET', headers: githubHeaders(token), redirect: 'error' })
  await res.body?.cancel()
  return res.status
}

/**
 * `PUT /api/connections/github`: `{ owner, repo, branch, folder, token? }`. The token may be left out to keep the stored
 * one. The settings are checked, then GitHub is asked whether the token can see the repository and the branch. Only
 * then is the connection saved (the store seals the token). Every answer is a fixed sentence.
 */
export async function saveGitHubConnection(rawBody: string, deps: SaveDeps): Promise<ApiResult> {
  let json: unknown
  try {
    json = rawBody.length > MAX_BODY_CHARS ? undefined : JSON.parse(rawBody)
  } catch {
    json = undefined
  }
  const parsed = Body.safeParse(json)
  if (!parsed.success) return invalid(SETTINGS_MESSAGE)
  const { owner, repo, branch } = parsed.data

  const supplied = parsed.data.token?.trim() ?? ''
  let token: string
  if (supplied !== '') {
    if (!TOKEN.test(supplied)) return invalid(TOKEN_MESSAGE)
    token = supplied
  } else {
    const stored = await deps.connections.get('github')
    if (stored?.connection.kind !== 'github') return invalid(TOKEN_MESSAGE)
    token = stored.connection.token
  }

  if (!isOwner(owner) || !isRepo(repo)) return invalid(NAME_MESSAGE)
  if (!isBranch(branch)) return invalid(BRANCH_MESSAGE)
  let folder: string
  try {
    folder = normaliseRepoFolder(parsed.data.folder)
  } catch (e) {
    if (e instanceof ExportError) return invalid(e.message)
    throw e
  }

  const unavailable: ApiResult = {
    status: 502,
    body: { error: 'github_unavailable', message: 'GitHub did not answer as expected. Try again later.' }
  }
  const rejected = invalid('GitHub rejected this token.')
  const repoStatus = await probe(deps.http, token, `/repos/${owner}/${repo}`)
  if (repoStatus === 401) return rejected
  if (repoStatus === 403 || repoStatus === 404)
    return invalid(`This token can't see ${owner}/${repo}. Give it access to that repository.`)
  if (repoStatus !== 200) return unavailable
  const branchStatus = await probe(deps.http, token, `/repos/${owner}/${repo}/branches/${encodePath(branch)}`)
  if (branchStatus === 401) return rejected
  if (branchStatus === 404) return invalid(`Branch ${branch} doesn't exist in ${owner}/${repo}.`)
  if (branchStatus !== 200) return unavailable

  await deps.connections.save({ kind: 'github', token, owner, repo, branch, folder })
  const connection: ConnectionSummary = {
    kind: 'github',
    status: 'ok',
    ready: true,
    label: `${owner}/${repo}`,
    detail: `branch ${branch}, folder ${folder || '/'}`
  }
  return { status: 200, body: { connection } }
}
