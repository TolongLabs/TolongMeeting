import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
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

const MISSING = new Set(['ENOENT', 'ENOTDIR', 'ELOOP'])

function isMissing(e: unknown): boolean {
  return e instanceof Error && MISSING.has((e as NodeJS.ErrnoException).code ?? '')
}

/**
 * The real path of a file the member may read, or null. `scope.artefactFile` checks the artefact row and the path
 * lexically; this adds what it leaves to the serving code: the file is resolved through every symlink and must still be
 * inside `<TM_DATA_ROOT>/occurrences/<occurrenceId>/`, and it must be a regular file.
 */
export async function memberFile(scope: MemberScope, occurrenceId: string, relPath: string): Promise<string | null> {
  if (relPath.includes('\0')) return null
  const lexical = await scope.artefactFile(occurrenceId, relPath)
  if (lexical === null) return null
  const dir = resolve(process.env.TM_DATA_ROOT!, 'occurrences', occurrenceId)
  try {
    const [real, base] = await Promise.all([realpath(lexical), realpath(dir)])
    if (!real.startsWith(base + sep)) return null
    return (await stat(real)).isFile() ? real : null
  } catch (e) {
    if (isMissing(e)) return null
    throw e
  }
}

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
  const parts = /^(\d{0,15})-(\d{0,15})$/.exec(spec)
  if (!parts || (parts[1] === '' && parts[2] === '')) return { kind: 'unsatisfiable' }
  const [first, last] = [parts[1]!, parts[2]!]
  if (first === '') {
    const length = Number(last)
    if (length === 0 || size === 0) return { kind: 'unsatisfiable' }
    return { kind: 'slice', start: Math.max(0, size - length), end: size - 1 }
  }
  const start = Number(first)
  if (start >= size) return { kind: 'unsatisfiable' }
  if (last === '') return { kind: 'slice', start, end: size - 1 }
  const end = Number(last)
  if (end < start) return { kind: 'unsatisfiable' }
  return { kind: 'slice', start, end: Math.min(end, size - 1) }
}

/**
 * Serves one regular file. The caller has already decided the member may read `absPath` (see `memberFile`). The file is
 * opened without following a symlink at its last component, and a directory or other non-regular file answers 404.
 */
export async function serveFile(absPath: string, range: string | null): Promise<Response> {
  let handle
  try {
    handle = await open(absPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (e) {
    if (isMissing(e)) return notFound()
    throw e
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) {
      await handle.close()
      return notFound()
    }
    const size = info.size
    const type = CONTENT_TYPES[extname(absPath).toLowerCase()]
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
    // The stream owns the handle from here and closes it when it ends or is cancelled.
    const body = Readable.toWeb(handle.createReadStream({ start, end })) as unknown as ReadableStream<Uint8Array>
    return new Response(body, { status, headers })
  } catch (e) {
    await handle.close().catch(() => undefined)
    throw e
  }
}
