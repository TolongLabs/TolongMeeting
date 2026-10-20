import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { AiKeyError } from '@tm/ai'
import type { JobConfig } from '@tm/core'
import { sendPing, summaryFailedPing, summaryReadyPing } from '@tm/notify'
import { buildChat, loadChat } from './chat'
import { describeError } from './errors'
import { scrub } from './scrub'
import { buildSlides, type Slide } from './slides'
import { buildTranscript } from './transcript'
import { attendanceLine } from './summary/attendance'
import { buildInventory } from './summary/inventory'
import { summaryFileName } from './summary/name'
import { renderLectureSummary } from './summary/render'
import { buildWorkInventory, renderWorkSummary } from './summary/work'

export interface PipelineResult {
  summaryPath: string
  transcriptPath: string
  slidesPath: string
  chatPath: string
}

const PINGED_MARKER = 'summary-pinged'
// A run that holds the ping lock longer than this is taken to have died.
const LOCK_STALE_MS = 10 * 60_000
const MIN_NAME_LETTERS = 6

// Words the live transcript may have misheard: the entry's saved detail values and the capitalised words on the slides.
function vocabulary(cfg: JobConfig, slides: Slide[]): string[] {
  const words = slides.flatMap((s) => `${s.title}\n${s.text}`.match(/\p{Lu}\p{L}{5,}/gu) ?? [])
  return [...new Set([...Object.values(cfg.entry.formDetails), ...words])].filter((w) => w !== '')
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

// Removes `<lock>.<uuid>` files that a run died holding (it took over a stale lock and never finished), once they
// are older than LOCK_STALE_MS. A live takeover is a moment long and its file is removed by that run itself.
async function removeStaleTakeovers(lock: string): Promise<void> {
  const name = basename(lock)
  for (const file of await readdir(dirname(lock))) {
    if (!file.startsWith(`${name}.`)) continue
    const path = join(dirname(lock), file)
    const info = await stat(path).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    if (info !== null && Date.now() - info.mtimeMs >= LOCK_STALE_MS) await rm(path, { force: true })
  }
}

// Takes the lock beside the marker, or says another run holds it. A lock older than LOCK_STALE_MS is taken over by
// renaming it to a name of this run's own: of several runs that see the same stale lock, one rename wins.
async function claimLock(lock: string): Promise<boolean> {
  await removeStaleTakeovers(lock)
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
    try {
      // The file this run now holds may be a live lock that replaced the stale one in between: put it back. When
      // the lock name is taken again (EEXIST), another run owns it: this run does not ping.
      const grabbed = await stat(taken).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null // a clean-up by another run removed it: the lock is free again
        throw err
      })
      if (grabbed === null) continue
      if (Date.now() - grabbed.mtimeMs < LOCK_STALE_MS) {
        await link(taken, lock).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'EEXIST') throw err
        })
        return false
      }
    } finally {
      await rm(taken, { force: true })
    }
  }
  return false
}

// The member's meeting page, `${TM_PUBLIC_URL}/meetings/<occurrenceId>`; null when the variable is unset. A value that is
// not an https URL is an error: a summary must not carry a link the member cannot open.
function meetingUrl(cfg: JobConfig, publicUrl: string | undefined = process.env.TM_PUBLIC_URL): string | null {
  if (publicUrl === undefined || publicUrl === '') return null
  if (!URL.canParse(publicUrl) || new URL(publicUrl).protocol !== 'https:') {
    throw new Error('TM_PUBLIC_URL must be an https URL')
  }
  return `${new URL(publicUrl).origin}/meetings/${encodeURIComponent(cfg.occurrenceId)}`
}

async function build(cfg: JobConfig, signal?: AbortSignal): Promise<{ result: PipelineResult; md: string }> {
  const outDir = join(cfg.dataDir, 'out')
  await mkdir(outDir, { recursive: true })
  const { slides, mdPath: slidesPath } = await buildSlides(cfg)
  signal?.throwIfAborted()
  const transcriptPath = await buildTranscript(cfg, vocabulary(cfg, slides))
  signal?.throwIfAborted()
  const chatPath = await buildChat(cfg)
  signal?.throwIfAborted()
  const input = {
    transcriptMd: await Bun.file(transcriptPath).text(),
    slides,
    chat: await loadChat(cfg)
  }
  const unreadSlides = slides.filter((s) => s.failed === true).map((s) => s.n)
  const md =
    cfg.entry.type === 'work'
      ? renderWorkSummary(await buildWorkInventory(cfg, input), {
          cfg,
          meetingUrl: meetingUrl(cfg),
          outDir,
          unreadSlides
        })
      : renderLectureSummary(await buildInventory(cfg, input), {
          cfg,
          attendance: await attendanceLine(cfg.dataDir, cfg.entry.timeZone),
          outDir,
          unreadSlides
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
export async function runPipeline(
  cfg: JobConfig,
  opts?: { pingOnKeyError?: boolean; signal?: AbortSignal }
): Promise<PipelineResult> {
  const pingOnKeyError = opts?.pingOnKeyError ?? true
  let built: { result: PipelineResult; md: string }
  try {
    built = await build(cfg, opts?.signal)
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
