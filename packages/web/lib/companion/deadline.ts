// A deadline for reading an upload body. A device that stops sending, or sends one byte at a time, must not hold a
// connection and the bytes it has buffered for ever (the caps bound the size, these bound the time).

/** The longest silence between two reads of a body. */
export const IDLE_MS = 60_000
/** The longest a whole body may take to arrive. */
export const TOTAL_MS = 10 * 60_000

export interface Deadlines {
  idleMs?: number
  totalMs?: number
}

/** The body did not arrive in time. `kind` says which limit it passed. */
export class StreamDeadline extends Error {
  constructor(readonly kind: 'idle' | 'total') {
    super(`the body was too slow (${kind})`)
    this.name = 'StreamDeadline'
  }
}

/**
 * Reads a body like `getReader()`, but each `read()` gives up with a `StreamDeadline` after `idleMs` of silence, and
 * every `read()` after `totalMs` since this call gives up at once. The caller cancels the reader on any failure.
 */
export function deadlineReader(body: ReadableStream<Uint8Array>, limits: Deadlines = {}) {
  const idleMs = limits.idleMs ?? IDLE_MS
  const totalMs = limits.totalMs ?? TOTAL_MS
  const reader = body.getReader()
  const endsAt = Date.now() + totalMs
  return {
    async read() {
      const left = endsAt - Date.now()
      if (left <= 0) throw new StreamDeadline('total')
      const kind = left < idleMs ? 'total' : 'idle'
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StreamDeadline(kind)), Math.min(idleMs, left))
      })
      try {
        return await Promise.race([reader.read(), late])
      } finally {
        clearTimeout(timer)
      }
    },
    cancel: () => reader.cancel().catch(() => undefined)
  }
}
