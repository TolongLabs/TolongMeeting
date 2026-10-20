import { createHash } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { z } from 'zod'
import { checkedSettings, encodePath, GITHUB_API, githubHeaders } from '../connections/github'
import { redact } from '../vault'
import { ExportError, type ExportContext, type ExportResult, type ExportTarget } from '../types'
import { SAFE_DIR, zipEntryName } from './zip'

// Commits a meeting's files to the member's repository through the Git Data API: one commit for the whole set, so a
// meeting is either all there or not there. Only the files of the zip layout are written or removed (`layoutName`), in
// a folder made from the folder setting and the meeting's `dirName`. Every error message is a fixed sentence.

/** GitHub allows 80 content-creating requests a minute; one every 800 ms stays under that. */
const WRITE_GAP_MS = 800
const MAX_COMMIT_HEADER = 50
const MAX_PROVIDER_TEXT = 200
const SHA = /^[0-9a-f]{40}$/
const LAYOUT_NAME = /^(?:summary\.md|transcript\.md|slides\.md|chat\.md|slides\/\d{2,3}\.webp)$/

const Sha = z.string().regex(SHA)
const RefAnswer = z.object({ object: z.object({ sha: Sha }) })
const CommitAnswer = z.object({ tree: z.object({ sha: Sha }) })
const ShaAnswer = z.object({ sha: Sha })
const Listing = z.array(z.object({ name: z.string(), type: z.string(), sha: Sha }))

/** The git blob id of `bytes`: sha1 of `blob <length>\0` followed by the bytes. */
export function gitBlobSha(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

/** `docs: <verb> <title>`, at most 50 characters: a long title is cut back to its last whole word that fits. */
export function commitMessage(verb: 'add' | 'update', title: string): string {
  const head = `docs: ${verb} `
  const clean = title
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const room = MAX_COMMIT_HEADER - head.length
  if (clean.length <= room) return head + clean
  const cut = clean.slice(0, room + 1)
  const space = cut.lastIndexOf(' ')
  return head + (space > 0 ? cut.slice(0, space) : clean.slice(0, room))
}

interface Wanted {
  /** Path inside the meeting folder: `summary.md`, `slides/01.webp`. */
  rel: string
  bytes: Uint8Array
}

interface TreeEntry {
  path: string
  mode: '100644'
  type: 'blob'
  content?: string
  sha?: string | null
}

function rateLimited(res: Response): boolean {
  if (res.status === 429) return true
  return res.status === 403 && (res.headers.has('retry-after') || res.headers.get('x-ratelimit-remaining') === '0')
}

export const githubTarget: ExportTarget = {
  id: 'github',
  async run(bundle, ctx): Promise<ExportResult> {
    const c = ctx.connection
    if (c?.kind !== 'github') throw new ExportError('not_connected', 'Connect GitHub on the Connections page first.')
    const { owner, repo, branch, folder } = checkedSettings(c)
    const token = c.token
    if (!SAFE_DIR.test(bundle.dirName)) throw new ExportError('failed', 'This meeting has no usable folder name.')
    const base = folder === '' ? bundle.dirName : `${folder}/${bundle.dirName}`
    const wanted: Wanted[] = bundle.files.map((f) => ({ rel: zipEntryName(f, bundle.summaryFile), bytes: f.bytes }))
    const repoPath = `/repos/${owner}/${repo}`
    const folderUrl = `https://github.com/${owner}/${repo}/tree/${encodePath(branch)}/${encodePath(base)}`

    async function request(
      http: ExportContext['http'],
      method: string,
      path: string,
      opts: { body?: unknown; allow?: number[] } = {}
    ): Promise<Response> {
      const headers = githubHeaders(token)
      const init: RequestInit = { method, headers, redirect: 'error' }
      if (opts.body !== undefined) {
        init.body = JSON.stringify(opts.body)
        headers['Content-Type'] = 'application/json'
      }
      const res = await http(`${GITHUB_API}${path}`, init)
      if (res.ok || opts.allow?.includes(res.status)) return res
      return fail(res)
    }

    async function fail(res: Response): Promise<never> {
      if (rateLimited(res)) throw new ExportError('rate_limited', 'GitHub is limiting requests. Try again later.')
      if (res.status === 401) {
        throw new ExportError(
          'reconnect_needed',
          'GitHub rejected the token. It may have expired; add a new one on the Connections page.'
        )
      }
      if (res.status === 403) {
        throw new ExportError(
          'reconnect_needed',
          `GitHub refused this token for ${owner}/${repo}. Check its repository access and Contents permission, or add a new one on the Connections page.`
        )
      }
      if (res.status === 404) {
        throw new ExportError(
          'not_found',
          `TolongMeeting can't write to ${owner}/${repo} on branch ${branch} with this token. Check its repository access and Contents permission.`
        )
      }
      // Any other answer: its status, and a short piece of what GitHub said, with the token taken out.
      const said = redact((await res.text()).slice(0, MAX_PROVIDER_TEXT), [token])
      throw new ExportError('failed', `GitHub answered ${res.status}: ${said} Try again.`)
    }

    const http = ctx.http
    const get = (path: string, allow?: number[]) => request(http, 'GET', path, { allow })

    async function answer<T>(schema: z.ZodType<T>, res: Response): Promise<T> {
      const parsed = schema.safeParse(await res.json())
      if (!parsed.success) throw new ExportError('failed', 'GitHub sent an answer TolongMeeting did not understand.')
      return parsed.data
    }

    // Existing files of the meeting folder (and its slides folder) with their blob ids; null when the folder is new.
    async function listFolder(path: string): Promise<Map<string, string> | null> {
      const res = await get(`${repoPath}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`, [404])
      if (res.status === 404) {
        await res.body?.cancel()
        return null
      }
      const json: unknown = await res.json()
      if (!Array.isArray(json)) throw new ExportError('failed', 'A file is in the way of the meeting folder.')
      const parsed = Listing.safeParse(json)
      if (!parsed.success) throw new ExportError('failed', 'GitHub sent an answer TolongMeeting did not understand.')
      return new Map(parsed.data.filter((e) => e.type === 'file').map((e) => [e.name, e.sha]))
    }

    const existing = new Map<string, string>()
    const top = await listFolder(base)
    for (const [name, sha] of top ?? []) existing.set(name, sha)
    if (top !== null) {
      for (const [name, sha] of (await listFolder(`${base}/slides`)) ?? []) existing.set(`slides/${name}`, sha)
    }

    const keep = new Set(wanted.map((w) => w.rel))
    const changed = wanted.filter((w) => existing.get(w.rel) !== gitBlobSha(w.bytes))
    const stale = [...existing.keys()].filter((rel) => LAYOUT_NAME.test(rel) && !keep.has(rel))
    if (changed.length === 0 && stale.length === 0)
      return { url: folderUrl, filePath: null, note: 'No changes since the last export' }
    const message = commitMessage(top === null ? 'add' : 'update', bundle.title)

    let wrote = false
    const write = async (method: string, path: string, body: unknown, allow?: number[]): Promise<Response> => {
      if (wrote) await ctx.sleep(WRITE_GAP_MS)
      wrote = true
      return request(http, method, path, { body, allow })
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const headSha = (await answer(RefAnswer, await get(`${repoPath}/git/ref/heads/${encodePath(branch)}`))).object.sha
      const head = await answer(CommitAnswer, await get(`${repoPath}/git/commits/${headSha}`))

      const entries: TreeEntry[] = []
      for (const w of changed) {
        const path = `${base}/${w.rel}`
        if (isUtf8(w.bytes)) {
          entries.push({ path, mode: '100644', type: 'blob', content: new TextDecoder().decode(w.bytes) })
        } else {
          const blob = await answer(
            ShaAnswer,
            await write('POST', `${repoPath}/git/blobs`, {
              content: Buffer.from(w.bytes).toString('base64'),
              encoding: 'base64'
            })
          )
          entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha })
        }
      }
      for (const rel of stale) entries.push({ path: `${base}/${rel}`, mode: '100644', type: 'blob', sha: null })

      const tree = await answer(
        ShaAnswer,
        await write('POST', `${repoPath}/git/trees`, { base_tree: head.tree.sha, tree: entries })
      )
      const commit = await answer(
        ShaAnswer,
        await write('POST', `${repoPath}/git/commits`, { message, tree: tree.sha, parents: [headSha] })
      )
      const moved = await write(
        'PATCH',
        `${repoPath}/git/refs/heads/${encodePath(branch)}`,
        { sha: commit.sha, force: false },
        [422]
      )
      if (moved.status !== 422) return { url: folderUrl, filePath: null, note: null }
      await moved.body?.cancel()
    }
    throw new ExportError('failed', 'The branch changed during the export. Try again.')
  }
}
