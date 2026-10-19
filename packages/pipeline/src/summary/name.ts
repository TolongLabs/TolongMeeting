import { localParts, type JobConfig } from '@tm/core'

const UNSAFE = /[/\\:*?"<>|]/g
const MAX_NAME_CHARS = 120

// `<date> <hhmm> <name>.md` in the entry's time zone, safe as a file name on every platform.
export function summaryFileName(cfg: JobConfig): string {
  const { date, hhmm } = localParts(cfg.entry.start, cfg.entry.timeZone)
  const name = cfg.entry.name.replace(UNSAFE, '-').replace(/\s+/g, ' ').trim()
  const cut = [...name].slice(0, MAX_NAME_CHARS).join('').trim()
  return `${date} ${hhmm} ${cut}.md`
}
