import { constants } from 'node:fs'
import { open, realpath, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { contentDisposition, downloadFileName, exportDownload } from '@tm/exports'
import type { MemberExportStores } from '../db/exports'
import { notFound, serveFile, type OpenedFile } from './files'

/** The largest download served (the same cap the runner enforces when it writes the file). */
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024

const MISSING = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'ENXIO', 'ENODEV'])

function isMissing(e: unknown): boolean {
  return e instanceof Error && MISSING.has((e as NodeJS.ErrnoException).code ?? '')
}

export interface OpenedExport {
  file: OpenedFile
  contentType: string
  /** Made on the server from the target and the date; never from the stored title. */
  fileName: string
}

/**
 * Opens the file of a finished export of the member's, or returns null (the same answer for another member's export, a
 * deleted meeting, an export that is not `succeeded`, a missing file and a refused path). The worker's neighbour
 * `exports` directory is written by `tm-exports`, which runs target code, so the file is verified on the OPEN descriptor
 * like `openMemberFile` does: opened `O_NOFOLLOW | O_NONBLOCK`, then its real path (`/proc/self/fd`, Linux) must be
 * exactly `<real occurrence directory>/exports/<exportId>.<zip|pdf>` and `fstat` must say a regular file within the cap.
 */
export async function openExportFile(stores: MemberExportStores, exportId: string): Promise<OpenedExport | null> {
  const row = await stores.exports.get(exportId)
  if (row === null) return null
  const download = exportDownload(row)
  if (download === null) return null
  const occurrence = await stores.occurrences.get(row.occurrenceId)
  if (occurrence === null || occurrence.state === 'deleted') return null

  let handle: FileHandle
  try {
    handle = await open(
      join(occurrence.dataDir, download.path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
  } catch (e) {
    if (isMissing(e)) return null
    throw e
  }
  try {
    const [actual, base, info] = await Promise.all([
      realpath(`/proc/self/fd/${handle.fd}`),
      realpath(occurrence.dataDir),
      handle.stat()
    ])
    if (info.isFile() && info.size <= MAX_DOWNLOAD_BYTES && actual === join(base, download.path)) {
      return {
        file: { handle, name: download.path },
        contentType: download.contentType,
        fileName: downloadFileName(row)
      }
    }
  } catch (e) {
    await handle.close().catch(() => undefined)
    if (isMissing(e)) return null
    throw e
  }
  await handle.close().catch(() => undefined)
  return null
}

/** The download response: an attachment with a fixed type and name, never sniffed, never cached. */
export async function exportFileResponse(
  stores: MemberExportStores,
  exportId: string,
  request: Request
): Promise<Response> {
  const opened = await openExportFile(stores, exportId)
  if (opened === null) return notFound()
  const res = await serveFile(opened.file, request.headers.get('range'), request.signal)
  if (res.status === 200 || res.status === 206) {
    res.headers.set('Content-Type', opened.contentType)
    res.headers.set('Content-Disposition', contentDisposition(opened.fileName))
  }
  return res
}
