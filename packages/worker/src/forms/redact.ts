import type { JobConfig } from '@tm/core'
import { buildDetailPool } from './details'

const CALL_LOG = '\nCall log:'
const MASK = '[value]'

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Removes what the member typed from a message before it is logged, evented or alerted. Playwright echoes typed text in
// some errors and lists every action in a "Call log:" section, so the message is cut there first. Every value the
// handler can type is masked (the member's details, the derived date and time, and the entry's form details), longest
// first so a value inside a longer one cannot leave part of the longer one behind.
export function redact(cfg: JobConfig, text: string): string {
  const logAt = text.indexOf(CALL_LOG)
  const head = logAt === -1 ? text : text.slice(0, logAt)
  const values = [...new Set(buildDetailPool(cfg).map((d) => d.value))].sort((a, b) => b.length - a.length)
  if (values.length === 0) return head
  return head.replace(new RegExp(values.map(escapeRegExp).join('|'), 'gi'), MASK)
}

// The redacted message of an error. It never throws: a message that cannot be redacted is withheld, not sent as is.
export function errorText(cfg: JobConfig, error: unknown): string {
  try {
    return redact(cfg, error instanceof Error ? error.message : String(error))
  } catch {
    return '[message withheld: it could not be redacted]'
  }
}
