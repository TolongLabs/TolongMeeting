import { lstat, mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { CompanionApi } from './api'
import { isMissing, writeFileAtomic } from './atomic'
import type { DesktopNotifier } from './notifier'
import type { StateStore } from './state'

/** The server's page size for `summaries(after)`: a shorter page is the last one. */
const PAGE = 50
/** Longest file name kept, in UTF-16 units (the Windows path limit counts these), extension included. */
const MAX_NAME = 200
/** How many files may share one name before the sync gives up. */
const MAX_CLASHES = 100
const FORBIDDEN = /[<>:"/\\|?*\p{Cc}]/gu
/** A device name by itself, or before the first dot, with or without an extension (`CON.md`, `nul .txt`). */
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i

/**
 * Makes a server-supplied file name safe for a Windows folder. Separators, `<>:"|?*` and control characters become `-`;
 * runs of dots become `-`, so no `..` survives; the stem loses leading and trailing dots and spaces; a reserved device
 * name gets a `_` prefix; the name is cut to `MAX_NAME` units, keeping the extension. An empty stem becomes `Summary`.
 */
export function windowsSafeFileName(name: string): string {
  const cleaned = name.replace(FORBIDDEN, '-').replace(/\.{2,}/g, '-')
  const dot = cleaned.lastIndexOf('.')
  const tail = dot === -1 ? '' : cleaned.slice(dot + 1).replace(/ +$/, '')
  const hasExt = /^[^ .]{1,16}$/.test(tail)
  const ext = hasExt ? tail : ''
  let stem = (hasExt ? cleaned.slice(0, dot) : cleaned).replace(/^[ .]+|[ .]+$/g, '')
  if (stem === '') stem = 'Summary'
  if (RESERVED.test(stem.split('.')[0]!.replace(/ +$/, ''))) stem = `_${stem}`
  const room = ext ? MAX_NAME - ext.length - 1 : MAX_NAME
  stem = stem.slice(0, room)
  // Never end on half a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(stem)) stem = stem.slice(0, -1)
  stem = stem.replace(/[ .]+$/, '') || 'Summary'
  return ext ? `${stem}.${ext}` : stem
}

export interface SummarySyncDeps {
  api: Pick<CompanionApi, 'summaries' | 'summary'>
  /** The configured summaries folder. Created if missing. */
  dir: string
  state: StateStore
}

/** Whether nothing at all (file, folder or symlink) sits at `path`. A symlink counts as taken and is never followed. */
async function isFree(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return false
  } catch (e) {
    if (isMissing(e)) return true
    throw e
  }
}

/** `name (2).md` for `name.md`, cut so the whole name stays within `MAX_NAME` units. */
function numbered(name: string, n: number): string {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot) : ''
  const suffix = ` (${n})`
  let stem = (dot > 0 ? name.slice(0, dot) : name).slice(0, MAX_NAME - ext.length - suffix.length)
  if (/[\uD800-\uDBFF]$/.test(stem)) stem = stem.slice(0, -1)
  return `${stem}${suffix}${ext}`
}

/** A Windows path compares without case. */
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/**
 * Downloads the summaries ready since the stored time and writes each to the folder under a Windows-safe name.
 * A name that already exists is skipped, never overwritten, so a repeat download writes nothing; but when the name
 * holds a summary of a different occurrence (kept in `state.summaryFiles`), the new one is saved as `<name> (2).md`
 * (then `(3)`, and so on). Each item advances
 * `summariesAfter` once it is handled, so an interrupted sync resumes where it stopped. Returns the paths newly written.
 */
export async function syncSummaries(d: SummarySyncDeps): Promise<string[]> {
  let after = d.state.get().summariesAfter
  if (after === null) throw new Error('This PC has no summary start time; pair it again')
  await mkdir(d.dir, { recursive: true })
  const root = await realpath(d.dir)
  const written: string[] = []
  for (;;) {
    const page = await d.api.summaries(after)
    for (const item of page) {
      const name = windowsSafeFileName(item.fileName)
      if (dirname(join(root, name)) !== root || name === '.' || name === '..') {
        throw new Error('A summary file name would leave the summaries folder')
      }
      const files = { ...d.state.get().summaryFiles }
      const saved = files[item.occurrenceId]
      const heldByOther = (path: string) =>
        Object.entries(files).some(([id, p]) => id !== item.occurrenceId && same(p, path))
      let target: string | null = null
      if (saved === undefined || (await isFree(saved))) {
        for (let n = 1; n <= MAX_CLASHES && target === null; n++) {
          const candidate = join(root, n === 1 ? name : numbered(name, n))
          if (await isFree(candidate)) target = candidate
          else if (!heldByOther(candidate))
            break // the member's own file, or this summary again: leave it
          else if (n === MAX_CLASHES) throw new Error('Too many summaries share one file name')
        }
      }
      if (target !== null) {
        await writeFileAtomic(target, await d.api.summary(item.occurrenceId), 0o600)
        written.push(target)
        files[item.occurrenceId] = target
        await d.state.update({ summaryFiles: files, summariesAfter: item.readyAt })
      } else await d.state.update({ summariesAfter: item.readyAt })
    }
    if (page.length < PAGE) return written
    const last = page[page.length - 1]!.readyAt
    if (Date.parse(last) <= Date.parse(after)) throw new Error('The summary list did not move past the last page')
    after = last
  }
}

/**
 * Shows the "Summary ready" notification for a saved file. The click opens the file, or the folder when the file was
 * moved. Nothing is opened here.
 */
export function showSummaryNotification(
  path: string,
  dir: string,
  d: {
    notifier: DesktopNotifier
    openPath(p: string): Promise<string>
    exists(p: string): boolean
  }
): void {
  const file = basename(path.replace(/\\/g, '/'))
  d.notifier.show(
    { title: 'Summary ready', body: file.replace(/\.md$/i, ''), sticky: false, buttons: [] },
    {
      click: () => {
        void d.openPath(d.exists(path) ? path : dir)
      },
      action: () => {}
    }
  )
}
