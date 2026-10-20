import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ExportError, type ExportContext } from '../types'

const SAFE_ID = /^[A-Za-z0-9_-]+$/

function codeOf(e: unknown): string | undefined {
  return e instanceof Error ? (e as NodeJS.ErrnoException).code : undefined
}

/**
 * Writes a finished download to `<outDir>/<exportId>.<ext>` and returns that path. The occurrence directory must still
 * exist: `outDir` is created without `recursive`, so a meeting deleted mid-export is never recreated. An `outDir` that is
 * not a plain directory (a symlink planted by the worker) is refused. The file lands by rename, so a reader never sees a
 * partial download.
 */
export async function writeDownload(ctx: ExportContext, ext: 'zip' | 'pdf', bytes: Uint8Array): Promise<string> {
  if (!SAFE_ID.test(ctx.exportId)) throw new ExportError('failed', 'The export has an invalid id.')
  try {
    await mkdir(ctx.outDir)
  } catch (e) {
    if (codeOf(e) === 'ENOENT')
      throw new ExportError('meeting_deleted', 'This meeting has been deleted from TolongMeeting.')
    if (codeOf(e) !== 'EEXIST') throw e
  }
  const dir = await lstat(ctx.outDir)
  if (!dir.isDirectory()) throw new ExportError('failed', 'The export folder is not a folder.')

  const target = join(ctx.outDir, `${ctx.exportId}.${ext}`)
  const temp = join(ctx.outDir, `.${ctx.exportId}.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, bytes, { flag: 'wx' })
    await rename(temp, target)
  } catch (e) {
    await rm(temp, { force: true })
    throw e
  }
  return target
}
