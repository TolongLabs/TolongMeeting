import type { EventType } from '@tm/core'
import { alertPing, type AlertKind, type Ping } from '@tm/notify'
import { redact } from './events'

/** The same alert is sent at most once in this window. */
export const ALERT_WINDOW_MS = 10 * 60_000

export interface Alerter {
  /** Records an `alert` event and sends the ping, unless the same alert went out in the last 10 minutes. Never rejects. */
  alert(kind: AlertKind, detail?: string, opts?: { recorded?: boolean }): void
  /** Resolves when every alert started so far has been sent or has failed, and records the alerts held back. */
  idle(): Promise<void>
}

export interface AlerterDeps {
  entry: string
  send: (p: Ping) => Promise<void>
  emit: (type: EventType, data: Record<string, unknown>) => Promise<void>
  now: () => Date
}

export type Limiter = ((key: string, windowMs: number) => boolean) & {
  /** Forgets a key, so the next call for it is allowed (an alert that could not be sent must be able to try again). */
  release(key: string): void
}

// Remembers when each key last fired; the limiter returns true at most once per window.
export function createLimiter(now: () => Date): Limiter {
  const last = new Map<string, number>()
  const allow = (key: string, windowMs: number): boolean => {
    const at = now().getTime()
    const before = last.get(key)
    if (before !== undefined && at - before < windowMs) return false
    last.set(key, at)
    return true
  }
  return Object.assign(allow, { release: (key: string) => void last.delete(key) })
}

// These kinds name what failed in their detail: a dead chat capture must not hide a dead audio source, a Google
// sign-in expiry must not hide a Microsoft one, and a second join failure for another reason is news too.
const KEYED_BY_DETAIL = new Set<AlertKind>(['component_failed', 'signin_forms', 'join_failed', 'recording_gap'])

export function createAlerter(deps: AlerterDeps): Alerter {
  const allow = createLimiter(deps.now)
  const running = new Set<Promise<void>>()
  const suppressed = new Map<string, { kind: AlertKind; detail: string | undefined; count: number }>()

  const detailOf = (detail: string | undefined) => (detail === undefined ? {} : { detail })

  async function fire(key: string, kind: AlertKind, detail: string | undefined, recorded: boolean): Promise<void> {
    if (!recorded) {
      await deps.emit('alert', { kind, ...detailOf(detail) }).catch((e: unknown) => {
        console.error(`alert event not written (${kind}): ${(e as Error).message}`)
      })
    }
    try {
      await deps.send(alertPing(deps.entry, kind, detail))
    } catch (e) {
      // Not rethrown: an alert that cannot be sent must not end the meeting. The event keeps the record, and the
      // slot is released so the next occurrence of this alert tries the ping again.
      const message = (redact((e as Error).message) as string) || 'unknown error'
      console.error(`alert ping not sent (${kind}): ${message}`)
      allow.release(key)
      await deps
        .emit('alert', { kind: 'alert_failed', failed: kind, ...detailOf(detail), message })
        .catch(() => undefined)
    }
  }

  return {
    alert(kind, rawDetail, opts = {}) {
      // Ping text never carries a link or a token.
      const detail = rawDetail === undefined ? undefined : String(redact(rawDetail))
      const key = KEYED_BY_DETAIL.has(kind) ? `${kind}:${detail}` : kind
      if (!allow(key, ALERT_WINDOW_MS)) {
        const before = suppressed.get(key)
        suppressed.set(key, { kind, detail, count: (before?.count ?? 0) + 1 })
        return
      }
      const task: Promise<void> = fire(key, kind, detail, opts.recorded ?? false).finally(() => running.delete(task))
      running.add(task)
    },
    async idle() {
      while (running.size > 0) await Promise.all([...running])
      // One event per alert that was held back, with how many times it was.
      for (const { kind, detail, count } of suppressed.values()) {
        await deps
          .emit('alert', { kind: 'alerts_suppressed', suppressed: kind, ...detailOf(detail), count })
          .catch((e: unknown) => console.error(`alert event not written (suppressed ${kind}): ${(e as Error).message}`))
      }
      suppressed.clear()
    }
  }
}
