import { constants } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { slugify } from './names'
import { ExportError, type BundleFile, type ExportBundle } from './types'

/** The pipeline's fixed file names in `out/`; any other `.md` there is the summary. */
const FIXED = ['transcript.md', 'slides.md', 'chat.md'] as const
const SLIDE_FILE = /^\d{2,3}\.webp$/

/** Caps on what a worker-written occurrence directory may hand the exporter. */
export const MAX_TEXT_BYTES = 8 * 1024 * 1024
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024
export const MAX_SLIDES = 500
export const MAX_BUNDLE_BYTES = 256 * 1024 * 1024

const MISSING = new Set(['ENOENT', 'ENOTDIR'])

function isMissing(e: unknown): boolean {
  return e instanceof Error && MISSING.has((e as NodeJS.ErrnoException).code ?? '')
}

function refused(rel: string, why: string): ExportError {
  return new ExportError('failed', `The meeting file "${rel}" cannot be exported: ${why}.`)
}

/**
 * Reads one file of a finished occurrence. The occurrence directory is written by an untrusted worker, so the check is
 * on the OPEN descriptor (the same rules as `openMemberFile` in `packages/web/lib/files.ts`): the file opens
 * `O_NOFOLLOW | O_NONBLOCK` (no final symlink, a FIFO can't block), `fstat` must say regular file, and the descriptor's
 * real path (`/proc/self/fd/<fd>`, Linux) must lie inside the occurrence directory (a symlinked directory in the
 * middle of the path is followed by `open`, and caught here). Returns null when there is no such file.
 */
async function readMember(
  base: string,
  rel: string,
  maxBytes: number
): Promise<{ bytes: Uint8Array; mtimeMs: number } | null> {
  let handle
  try {
    handle = await open(join(base, rel), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (e) {
    if (isMissing(e)) return null
    if ((e as NodeJS.ErrnoException).code === 'ELOOP') throw refused(rel, 'it is a symbolic link')
    throw e
  }
  try {
    const [actual, info] = await Promise.all([realpath(`/proc/self/fd/${handle.fd}`), handle.stat()])
    if (!info.isFile()) throw refused(rel, 'it is not a regular file')
    if (!actual.startsWith(base + sep)) throw refused(rel, 'it is outside the meeting folder')
    if (info.size > maxBytes) throw refused(rel, `it is larger than ${Math.floor(maxBytes / (1024 * 1024))} MB`)
    const bytes = new Uint8Array(await handle.readFile())
    if (bytes.length > maxBytes) throw refused(rel, `it is larger than ${Math.floor(maxBytes / (1024 * 1024))} MB`)
    return { bytes, mtimeMs: info.mtimeMs }
  } finally {
    await handle.close()
  }
}

/** The regular files directly inside `<base>/<dir>` (symlinks and other kinds are not listed), or [] if no such directory. */
async function listFiles(base: string, dir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(join(base, dir), { withFileTypes: true })
  } catch (e) {
    if (isMissing(e)) return []
    throw e
  }
  const real = await realpath(join(base, dir))
  if (real !== join(base, dir)) throw refused(dir, 'it is outside the meeting folder')
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
}

/** The 01a pipeline writes `![..](../slides/NN.webp)` in `out/slides.md`. The bundle puts `slides.md` next to `slides/`. */
function relinkSlides(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(bytes)
  return new TextEncoder().encode(text.replaceAll('](../slides/', '](slides/'))
}

/**
 * Reads a finished occurrence's summary, transcript, slides, chat and slide images into memory, so that deleting the
 * directory later can't corrupt a running export. Missing optional files are left out. `slides.md` is the one file not
 * kept byte for byte: its image links are rewritten from `../slides/NN.webp` to `slides/NN.webp`.
 */
export async function loadBundle(dataDir: string): Promise<ExportBundle> {
  const base = await realpath(dataDir)
  let total = 0
  const take = (file: BundleFile): BundleFile => {
    total += file.bytes.length
    if (total > MAX_BUNDLE_BYTES) throw new ExportError('failed', 'This meeting is too large to export.')
    return file
  }

  const outNames = await listFiles(base, 'out')
  const candidates: { name: string; mtimeMs: number }[] = []
  for (const name of outNames) {
    if (!name.endsWith('.md') || (FIXED as readonly string[]).includes(name)) continue
    candidates.push({ name, mtimeMs: (await stat(join(base, 'out', name))).mtimeMs })
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : 1))
  const newest = candidates[0]
  if (newest === undefined) throw new ExportError('not_ready', 'This meeting has no summary yet.')
  const summaryFile = newest.name
  const title = summaryFile.slice(0, -'.md'.length)

  const files: BundleFile[] = []
  const summary = await readMember(base, `out/${summaryFile}`, MAX_TEXT_BYTES)
  if (summary === null) throw new ExportError('not_ready', 'This meeting has no summary yet.')
  files.push(take({ path: summaryFile, bytes: summary.bytes }))

  for (const name of FIXED) {
    const read = await readMember(base, `out/${name}`, MAX_TEXT_BYTES)
    if (read === null) continue
    files.push(take({ path: name, bytes: name === 'slides.md' ? relinkSlides(read.bytes) : read.bytes }))
  }

  const slides = (await listFiles(base, 'slides')).filter((name) => SLIDE_FILE.test(name)).sort()
  if (slides.length > MAX_SLIDES) throw new ExportError('failed', `This meeting has more than ${MAX_SLIDES} slides.`)
  for (const name of slides) {
    const read = await readMember(base, `slides/${name}`, MAX_IMAGE_BYTES)
    if (read !== null) files.push(take({ path: `slides/${name}`, bytes: read.bytes }))
  }

  return { title, dirName: slugify(title), summaryFile, files }
}
