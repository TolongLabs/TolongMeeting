import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { EventType, MeetingEvent } from '@tm/core'
import { appendDurably } from './chat/capture'

export interface EventLog {
  emit(type: EventType, data: Record<string, unknown>): Promise<void>
}

const URL_PATTERN = /https?:\/\/[^\s<>"'()[\]{}]+/gi
const BEARER = /\bBearer\s+\S+/gi
const SECRET_PARAM = /\b(pwd|token)=[^\s&"'<>]+/gi
// Keys that hold a secret whatever the value looks like.
const SECRET_KEY = /^(api_?key|token|secret|password|passcode|authorization)$/i

function redactText(text: string): string {
  return text
    .replace(URL_PATTERN, (url) => {
      if (!URL.canParse(url)) return '<url>'
      const u = new URL(url)
      return `<${u.host}${u.pathname}>`
    })
    .replace(BEARER, 'Bearer REDACTED')
    .replace(SECRET_PARAM, '$1=REDACTED')
}

// Replaces `pwd=` and `token=` values and Bearer tokens, and rewrites every URL to `<host/path>`. Walks objects,
// arrays and errors; other values pass through.
export function redact(v: unknown): unknown {
  if (typeof v === 'string') return redactText(v)
  if (Array.isArray(v)) return v.map(redact)
  if (v instanceof Error) return { name: v.name, message: redactText(v.message) }
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v).map(([key, value]) => [key, SECRET_KEY.test(key) ? 'REDACTED' : redact(value)])
    )
  }
  return v
}

// Appends one MeetingEvent per line to `file`, redacted and fsynced. Emits run one after the other; a failed write
// rejects that emit only.
export function createEventLog(file: string, occurrenceId: string, attempt: number): EventLog {
  let queue: Promise<unknown> = Promise.resolve()
  return {
    emit(type, data) {
      const event: MeetingEvent = {
        occurrenceId,
        attempt,
        at: new Date().toISOString(),
        type,
        data: redact(data) as Record<string, unknown>
      }
      const write = queue.then(async () => {
        await mkdir(dirname(file), { recursive: true })
        await appendDurably(file, `${JSON.stringify(event)}\n`)
      })
      queue = write.catch(() => undefined)
      return write
    }
  }
}
