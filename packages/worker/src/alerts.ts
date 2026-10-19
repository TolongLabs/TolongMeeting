import type { EventType } from '@tm/core'
import { alertPing, type AlertKind, type Ping } from '@tm/notify'
import { redact } from './events'

/** The same alert is sent at most once in this window. */
export const ALERT_WINDOW_MS = 10 * 60_000

export interface Alerter {
  /** Records an `alert` event and sends the ping, unless the same alert went out in the last 10 minutes. Never rejects. */
  alert(kind: AlertKind, detail?: string, opts?: { recorded?: boolean }): void
  /** Resolves when every alert started so far has been sent or has failed. */
  idle(): Promise<void>
}

export interface AlerterDeps {
  entry: string
  send: (p: Ping) => Promise<void>
  emit: (type: EventType, data: Record<string, unknown>) => Promise<void>
  now: () => Date
}

// Remembers when each key last fired; `allow` is true at most once per window.
export function createLimiter(now: () => Date): (key: string, windowMs: number) => boolean {
  const last = new Map<string, number>()
  return (key, windowMs) => {
    const at = now().getTime()
    const before = last.get(key)
    if (before !== undefined && at - before < windowMs) return false
    last.set(key, at)
    return true
  }
}

export function createAlerter(deps: AlerterDeps): Alerter {
  const allow = createLimiter(deps.now)
  const running = new Set<Promise<void>>()

  async function fire(kind: AlertKind, detail: string | undefined, recorded: boolean): Promise<void> {
    if (!recorded) {
      await deps.emit('alert', { kind, ...(detail === undefined ? {} : { detail }) }).catch((e: unknown) => {
        console.error(`alert event not written (${kind}): ${(e as Error).message}`)
      })
    }
    try {
      await deps.send(alertPing(deps.entry, kind, detail))
    } catch (e) {
      // Not rethrown: an alert that cannot be sent must not end the meeting. The event above keeps the record.
      console.error(`alert ping not sent (${kind}): ${(redact((e as Error).message) as string) || 'unknown error'}`)
    }
  }

  return {
    alert(kind, rawDetail, opts = {}) {
      // Ping text never carries a link or a token.
      const detail = rawDetail === undefined ? undefined : String(redact(rawDetail))
      // These kinds name what failed in their detail: a dead chat capture must not hide a dead audio source, and a
      // Google sign-in expiry must not hide a Microsoft one.
      const key = kind === 'component_failed' || kind === 'signin_forms' ? `${kind}:${detail}` : kind
      if (!allow(key, ALERT_WINDOW_MS)) return
      const task: Promise<void> = fire(kind, detail, opts.recorded ?? false).finally(() => running.delete(task))
      running.add(task)
    },
    async idle() {
      while (running.size > 0) await Promise.all([...running])
    }
  }
}
