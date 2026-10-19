import { mkdir, open, readdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { AiKeyError } from '@tm/ai'
import { canonicalFormUrl, type JobConfig } from '@tm/core'
import { sendPing, summaryFailedPing, summaryReadyPing } from '@tm/notify'
import { z } from 'zod'
import { buildChat, loadChat } from './chat'
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

// The text after "Attendance: ". A form the bot left for the member to submit is the only thing it knows about.
async function attendanceText(dataDir: string): Promise<string> {
  const forms = join(dataDir, 'forms')
  const entries = await readdir(forms, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return []
    throw err
  })
  const waiting: { sortKey: string; url: string }[] = []
  for (const entry of entries.filter((e) => e.isDirectory())) {
    const raw = await readFile(join(forms, entry.name, 'record.json'), 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    if (raw === null) continue
    let record: z.infer<typeof FormRecordFile>
    try {
      record = FormRecordFile.parse(JSON.parse(raw))
    } catch {
      // A torn or foreign record is skipped; only the form's id is reported, never its content.
      console.error(`tm-pipeline: forms/${entry.name}/record.json is unreadable and was skipped`)
      continue
    }
    if (record.state !== 'needs_member') continue
    // The canonical page, so a pre-filled answer in the query never reaches the summary.
    waiting.push({
      sortKey: `${record.seenAt ?? ''}|${entry.name}`,
      url: canonicalFormUrl(record.finalUrl ?? record.url)
    })
  }
  waiting.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0))
  return waiting.length > 0 ? `needs you: ${waiting[0]!.url}` : 'not seen'
}

// Writes the whole file to a temporary name, flushes it, then renames it over the target.
async function writeAtomic(path: string, text: string): Promise<void> {
  const temp = `${path}.tmp`
  const handle = await open(temp, 'w')
  try {
    await handle.writeFile(text)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, path)
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
  const summaryPath = join(outDir, summaryFileName(cfg))
  await writeAtomic(summaryPath, md)
  return { result: { summaryPath, transcriptPath, slidesPath, chatPath }, md }
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
        console.error(`tm-pipeline: the summary-failed ping was not sent: ${String(pingError)}`)
      })
    }
    throw e
  }
  const marker = join(cfg.dataDir, 'out', PINGED_MARKER)
  if (!(await Bun.file(marker).exists())) {
    await sendPing(cfg.ntfy, summaryReadyPing(cfg.entry.name, built.md))
    await writeAtomic(marker, `${new Date().toISOString()}\n`)
  }
  return built.result
}
