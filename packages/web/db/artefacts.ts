import { lstat, readdir, realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { sql } from 'drizzle-orm'
import { artefacts, type ArtefactKind, type Db } from './index'

const SUMMARY_NAME = /^\d{4}-\d{2}-\d{2} \d{4} .+\.md$/
const SLIDE_IMAGE = /^\d{2,}\.webp$/
const FORM_ID = /^[0-9a-f]{16}$/
const FORM_SHOTS = ['filled.png', 'confirmation.png']
const OUT_FILES: Record<string, ArtefactKind> = {
  'transcript.md': 'transcript',
  'slides.md': 'slides',
  'chat.md': 'chat'
}

interface Found {
  path: string
  kind: ArtefactKind
  bytes: number
}

const noEntry = (err: NodeJS.ErrnoException): null => {
  if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null
  throw err
}

/** The names in `<root>/<rel>` (a plain directory, not a link); none when it is missing or is not a directory. */
async function names(root: string, rel: string): Promise<string[]> {
  const info = await lstat(join(root, rel)).catch(noEntry)
  if (info === null || !info.isDirectory()) return []
  return readdir(join(root, rel))
}

/**
 * The file at `<root>/<rel>` when it is a real regular file inside `root`: `lstat` says regular file (so not a link,
 * FIFO or directory) and its real path is `root` plus `rel`, so no directory on the way is a link either. `root` is
 * already a real path. The worker that writes this directory is not trusted, so every file is checked here.
 */
async function regularFile(root: string, rel: string): Promise<{ bytes: number } | null> {
  const full = join(root, rel)
  const info = await lstat(full).catch(noEntry)
  if (info === null || !info.isFile()) return null
  const real = await realpath(full).catch(noEntry)
  if (real !== `${root}${sep}${rel.split('/').join(sep)}`) return null
  return { bytes: info.size }
}

async function scan(root: string): Promise<Found[]> {
  const candidates: { path: string; kind: ArtefactKind }[] = [{ path: 'recording/meeting.mp4', kind: 'recording' }]
  for (const name of await names(root, 'out')) {
    if (name in OUT_FILES) candidates.push({ path: `out/${name}`, kind: OUT_FILES[name]! })
    else if (SUMMARY_NAME.test(name)) candidates.push({ path: `out/${name}`, kind: 'summary' })
  }
  candidates.push({ path: 'slides/slides.json', kind: 'slides_json' })
  for (const name of await names(root, 'slides')) {
    if (SLIDE_IMAGE.test(name)) candidates.push({ path: `slides/${name}`, kind: 'slide_image' })
  }
  for (const formId of await names(root, 'forms')) {
    if (!FORM_ID.test(formId)) continue
    for (const shot of FORM_SHOTS) candidates.push({ path: `forms/${formId}/${shot}`, kind: 'form_screenshot' })
  }
  const found: Found[] = []
  for (const c of candidates) {
    const file = await regularFile(root, c.path)
    if (file !== null) found.push({ ...c, bytes: file.bytes })
  }
  return found
}

/**
 * Records the known files of an occurrence directory in `artefacts` and returns how many it recorded. Only the paths
 * the data layout names are looked at, and only real regular files inside the directory count (see `regularFile`);
 * everything else is ignored. Idempotent: a row is keyed by `(occurrence_id, path)`, and a second call updates its size.
 * A directory that does not exist (a worker that never started) records nothing.
 */
export async function registerArtefacts(db: Db, occ: { id: string; memberId: string }, dir: string): Promise<number> {
  const root = await realpath(dir).catch(noEntry)
  if (root === null) return 0
  const found = await scan(root)
  if (found.length === 0) return 0
  await db
    .insert(artefacts)
    .values(found.map((f) => ({ occurrenceId: occ.id, memberId: occ.memberId, ...f })))
    .onConflictDoUpdate({
      target: [artefacts.occurrenceId, artefacts.path],
      set: { kind: sql`excluded.kind`, bytes: sql`excluded.bytes` }
    })
  return found.length
}
