import { constants } from 'node:fs'
import { open, realpath, type FileHandle } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import type { MemberScope } from './scope'

/**
 * What a member's meeting files are served as. Anything not listed is sent as an `application/octet-stream` download,
 * and no type is ever `text/html` or `image/svg+xml`: the files hold text from other people in the meeting.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
}

const BASE_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Accept-Ranges': 'bytes'
}

/** A fixed, path-free refusal. The same answer for a missing file, another member's file and a refused path. */
export function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
  })
}

/** Errors that mean "there is no such readable regular file here": the same uniform answer as a missing row. */
const MISSING = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'ENXIO', 'ENODEV'])

function isMissing(e: unknown): boolean {
  return e instanceof Error && MISSING.has((e as NodeJS.ErrnoException).code ?? '')
}

/** A verified, open meeting file. The holder must hand it to `serveFile` or close the handle. */
export interface OpenedFile {
  handle: FileHandle
  /** Only the extension decides the content type. */
  name: string
}

/** Test seam: runs after the artefact lookup and before the open, where a worker could swap a path component. */
export interface OpenHooks {
  afterLookup?: () => Promise<void>
}

/**
 * Opens a file the member may read, or returns null. The check is on the OPEN descriptor, so nothing a worker does to
 * the path after the open can matter (the worker that writes `occurrences/<id>/` is untrusted):
 *
 * 1. `scope.artefactFile` checks the artefact row (ownership) and the path lexically.
 * 2. The file opens `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`. `O_NOFOLLOW` refuses a final symlink and `O_NONBLOCK` keeps a
 *    FIFO from blocking the open. A symlinked directory in the middle of the path is still followed, so:
 * 3. the descriptor's real path (`/proc/self/fd/<fd>`, Linux) must lie inside `<TM_DATA_ROOT>/occurrences/<id>/`, and
 *    `fstat` must say it is a regular file.
 *
 * Any failed check closes the descriptor and gives null, the same answer as a missing file.
 */
export async function openMemberFile(
  scope: MemberScope,
  occurrenceId: string,
  relPath: string,
  hooks: OpenHooks = {}
): Promise<OpenedFile | null> {
  if (relPath.includes('\0')) return null
  const lexical = await scope.artefactFile(occurrenceId, relPath)
  if (lexical === null) return null
  await hooks.afterLookup?.()
  let handle: FileHandle
  try {
    handle = await open(lexical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (e) {
    if (isMissing(e)) return null
    throw e
  }
  try {
    const dir = resolve(process.env.TM_DATA_ROOT!, 'occurrences', occurrenceId)
    const [actual, base, info] = await Promise.all([
      realpath(`/proc/self/fd/${handle.fd}`),
      realpath(dir),
      handle.stat()
    ])
    if (info.isFile() && actual.startsWith(base + sep)) return { handle, name: lexical }
  } catch (e) {
    await handle.close().catch(() => undefined)
    if (isMissing(e)) return null
    throw e
  }
  await handle.close().catch(() => undefined)
  return null
}

/** A digit string of more than 15 digits is bigger than any file: it clamps instead of losing precision (RFC 9110). */
const number = (digits: string): number => (digits.length > 15 ? Number.MAX_SAFE_INTEGER : Number(digits))

type ByteRange = { kind: 'whole' } | { kind: 'slice'; start: number; end: number } | { kind: 'unsatisfiable' }

/**
 * RFC 9110 section 14. A header that is not `bytes=` is ignored, and so is a list of several ranges (a server may answer
 * the whole file). A malformed or out-of-range single range is unsatisfiable (416).
 */
function parseRange(header: string | null, size: number): ByteRange {
  if (header === null) return { kind: 'whole' }
  const match = /^\s*bytes\s*=(.*)$/is.exec(header)
  if (!match) return { kind: 'whole' }
  const spec = match[1]!.trim()
  if (spec.includes(',')) return { kind: 'whole' }
  const parts = /^(\d*)-(\d*)$/.exec(spec)
  if (!parts || (parts[1] === '' && parts[2] === '')) return { kind: 'unsatisfiable' }
  const [first, last] = [parts[1]!, parts[2]!]
  if (first === '') {
    const length = number(last)
    if (length === 0 || size === 0) return { kind: 'unsatisfiable' }
    return { kind: 'slice', start: Math.max(0, size - length), end: size - 1 }
  }
  const start = number(first)
  if (start >= size) return { kind: 'unsatisfiable' }
  if (last === '') return { kind: 'slice', start, end: size - 1 }
  const end = number(last)
  if (end < start) return { kind: 'unsatisfiable' }
  return { kind: 'slice', start, end: Math.min(end, size - 1) }
}

/**
 * Serves a file `openMemberFile` verified, and owns its handle: every path out of here closes it (a stream closes it
 * when it ends or is cancelled). If `signal` aborts (the client went away) the handle is closed at once.
 */
export async function serveFile(file: OpenedFile, range: string | null, signal?: AbortSignal): Promise<Response> {
  const { handle } = file
  try {
    if (signal?.aborted) {
      await handle.close()
      return notFound()
    }
    const info = await handle.stat()
    const size = info.size
    const type = CONTENT_TYPES[extname(file.name).toLowerCase()]
    const headers: Record<string, string> = { ...BASE_HEADERS }
    if (type) headers['Content-Type'] = type
    else {
      headers['Content-Type'] = 'application/octet-stream'
      headers['Content-Disposition'] = 'attachment'
    }

    const wanted = parseRange(range, size)
    if (wanted.kind === 'unsatisfiable') {
      await handle.close()
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
    }
    const [start, end, status] = wanted.kind === 'slice' ? [wanted.start, wanted.end, 206] : [0, size - 1, 200]
    if (wanted.kind === 'slice') headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    headers['Content-Length'] = String(size === 0 ? 0 : end - start + 1)
    if (size === 0) {
      await handle.close()
      return new Response(null, { status, headers })
    }
    // The stream owns the handle from here and closes it when it ends or is destroyed.
    const stream = handle.createReadStream({ start, end })
    signal?.addEventListener('abort', () => stream.destroy(), { once: true })
    // An abort during the awaits above fired before the listener existed.
    if (signal?.aborted) {
      stream.destroy()
      return notFound()
    }
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, { status, headers })
  } catch (e) {
    await handle.close().catch(() => undefined)
    throw e
  }
}
