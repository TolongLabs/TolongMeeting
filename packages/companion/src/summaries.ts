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

/**
 * Downloads the summaries ready since the stored time and writes each to the folder under a Windows-safe name.
 * A name that already exists is skipped, never overwritten, so a repeat download writes nothing. Each item advances
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
      const target = join(root, name)
      if (dirname(target) !== root || name === '.' || name === '..') {
        throw new Error('A summary file name would leave the summaries folder')
      }
      if (await isFree(target)) {
        await writeFileAtomic(target, await d.api.summary(item.occurrenceId), 0o600)
        written.push(target)
      }
      await d.state.update({ summariesAfter: item.readyAt })
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
