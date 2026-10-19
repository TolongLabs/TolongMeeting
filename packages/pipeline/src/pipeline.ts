import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { AiKeyError } from '@tm/ai'
import { canonicalFormUrl, type JobConfig } from '@tm/core'
import { sendPing, summaryFailedPing, summaryReadyPing } from '@tm/notify'
import { z } from 'zod'
import { buildChat, loadChat } from './chat'
import { describeError } from './errors'
import { scrub } from './scrub'
import { buildSlides, type Slide } from './slides'
import { buildTranscript } from './transcript'
import { buildInventory } from './summary/inventory'
import { summaryFileName } from './summary/name'
import { renderLectureSummary } from './summary/render'

export interface PipelineResult {
  summaryPath: string
  transcriptPath: string
  slidesPath: string
  chatPath: string
}

const PINGED_MARKER = 'summary-pinged'
// A run that holds the ping lock longer than this is taken to have died.
const LOCK_STALE_MS = 10 * 60_000
const ATTENDANCE_UNREADABLE = 'a form was seen but could not be read; check the meeting page'
const ATTENDANCE_SEEN = 'a form was seen; check the meeting page'
const MIN_NAME_LETTERS = 6

// Both record shapes (the 1A pinger's and the 1B FormRecord) carry these; 1B adds the resolved `finalUrl`.
const FormRecordFile = z.object({
  state: z.string(),
  url: z.string(),
  finalUrl: z.string().optional(),
  seenAt: z.string().optional()
})

// Words the live transcript may have misheard: the entry's saved detail values and the capitalised words on the slides.
function vocabulary(cfg: JobConfig, slides: Slide[]): string[] {
  const words = slides.flatMap((s) => `${s.title}\n${s.text}`.match(/\p{Lu}\p{L}{5,}/gu) ?? [])
  return [...new Set([...Object.values(cfg.entry.formDetails), ...words])].filter((w) => w !== '')
}

// The text after "Attendance: ". It comes only from the form records, and it is never "not seen" once a form
// directory exists: a record that cannot be read must not look like no form.
async function attendanceText(dataDir: string): Promise<string> {
  const forms = join(dataDir, 'forms')
  const entries = await readdir(forms, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return []
    throw err
  })
  const dirs = entries.filter((e) => e.isDirectory())
  const waiting: { sortKey: string; url: string }[] = []
  let unreadable = 0
  for (const entry of dirs) {
    const raw = await readFile(join(forms, entry.name, 'record.json'), 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    try {
      if (raw === null) throw new Error('no record.json')
      const record = FormRecordFile.parse(JSON.parse(raw))
      if (record.state !== 'needs_member') continue
      // The canonical page, so a pre-filled answer in the query never reaches the summary.
      waiting.push({
        sortKey: `${record.seenAt ?? ''}|${entry.name}`,
        url: canonicalFormUrl(record.finalUrl ?? record.url)
      })
    } catch {
      // A torn, foreign or missing record is skipped; only the form's id is reported, never its content.
      unreadable++
      console.error(`tm-pipeline: forms/${entry.name}/record.json is unreadable and was skipped`)
    }
  }
  waiting.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0))
  if (waiting.length > 0) {
    const more = waiting.length > 1 ? ` (+${waiting.length - 1} more)` : ''
    const unread = unreadable > 0 ? '; another form could not be read' : ''
    return `needs you: ${waiting[0]!.url}${more}${unread}`
  }
  if (unreadable > 0) return ATTENDANCE_UNREADABLE
  return dirs.length > 0 ? ATTENDANCE_SEEN : 'not seen'
}

// Writes the whole file to a temporary name of its own, flushes it, then renames it over the target.
async function writeAtomic(path: string, text: string): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    const handle = await open(temp, 'w')
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path)
  } catch (err) {
    await rm(temp, { force: true })
    throw err
  }
}

// Takes the lock beside the marker, or says another run holds it. A lock older than LOCK_STALE_MS is taken over by
// renaming it to a name of this run's own: of several runs that see the same stale lock, one rename wins.
async function claimLock(lock: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await (await open(lock, 'wx')).close()
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const held = await stat(lock).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    if (held === null) continue
    if (Date.now() - held.mtimeMs < LOCK_STALE_MS) return false
    const taken = `${lock}.${randomUUID()}`
    try {
      await rename(lock, taken)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue // another run took it over first
      throw err
    }
    // The file this run now holds may be a live lock that replaced the stale one in between: put it back.
    const grabbed = await stat(taken)
    if (Date.now() - grabbed.mtimeMs < LOCK_STALE_MS) {
      await link(taken, lock).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'EEXIST') throw err
      })
      await rm(taken, { force: true })
      return false
    }
    await rm(taken, { force: true })
  }
  return false
}

async function build(cfg: JobConfig): Promise<{ result: PipelineResult; md: string }> {
  const outDir = join(cfg.dataDir, 'out')
  await mkdir(outDir, { recursive: true })
  const { slides, mdPath: slidesPath } = await buildSlides(cfg)
  const transcriptPath = await buildTranscript(cfg, vocabulary(cfg, slides))
  const chatPath = await buildChat(cfg)
  const inventory = await buildInventory(cfg, {
    transcriptMd: await Bun.file(transcriptPath).text(),
    slides,
    chat: await loadChat(cfg)
  })
  const attendance = cfg.entry.type === 'lecture' ? await attendanceText(cfg.dataDir) : null
  const md = renderLectureSummary(inventory, {
    cfg,
    attendance,
    outDir,
    unreadSlides: slides.filter((s) => s.failed === true).map((s) => s.n)
  })
  // The last gate: whatever the model or a record put in the text, no join link or passcode is written or pinged.
  const safe = scrub(md)
  const summaryPath = join(outDir, summaryFileName(cfg))
  await writeAtomic(summaryPath, safe)
  return { result: { summaryPath, transcriptPath, slidesPath, chatPath }, md: safe }
}

/**
 * Builds the transcript, slides, chat and summary files in `<dataDir>/out` and pings that the summary is ready, once:
 * a marker file written after the ping succeeds stops a re-run from pinging again. A rejected AI key sends the
 * "summary failed" ping (unless `pingOnKeyError` is false) and rethrows; the inputs stay untouched either way.
 */
export async function runPipeline(cfg: JobConfig, opts?: { pingOnKeyError?: boolean }): Promise<PipelineResult> {
  const pingOnKeyError = opts?.pingOnKeyError ?? true
  let built: { result: PipelineResult; md: string }
  try {
    built = await build(cfg)
  } catch (e) {
    if (e instanceof AiKeyError && pingOnKeyError) {
      // The key error is what the caller needs; a failed ping is logged beside it, not instead of it.
      await sendPing(cfg.ntfy, summaryFailedPing(cfg.entry.name, e.status)).catch((pingError: unknown) => {
        console.error(`tm-pipeline: the summary-failed ping was not sent: ${describeError(pingError)}`)
      })
    }
    throw e
  }
  const marker = join(cfg.dataDir, 'out', PINGED_MARKER)
  if (await Bun.file(marker).exists()) return built.result
  // Two runs at once must not both ping: one takes the lock, pings, writes the marker, then lets go.
  const lock = `${marker}.lock`
  if (!(await claimLock(lock))) {
    console.error('tm-pipeline: another run is sending the summary ping; this run did not')
    return built.result
  }
  try {
    if (!(await Bun.file(marker).exists())) {
      await sendPing(cfg.ntfy, summaryReadyPing(cfg.entry.name, built.md))
      await writeAtomic(marker, `${new Date().toISOString()}\n`)
    }
  } finally {
    await rm(lock, { force: true })
  }
  return built.result
}
