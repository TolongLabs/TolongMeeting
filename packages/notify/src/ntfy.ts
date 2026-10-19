import { basename } from 'node:path'
import type { NtfyConfig } from '@tm/core'

export interface PingAction {
  label: string
  url: string
}

export interface Ping {
  title: string
  message: string
  priority: 'high' | 'default'
  actions?: PingAction[]
  attachPath?: string
}

export class PingError extends Error {
  status: number | null

  constructor(message: string, status: number | null) {
    super(message)
    this.name = 'PingError'
    this.status = status
  }
}

const PRIORITY = { high: 4, default: 3 } as const
const TIMEOUT_MS = 10_000
const RETRY_DELAYS_MS = [1_000, 2_000]

export async function sendPing(cfg: NtfyConfig, ping: Ping): Promise<void> {
  const auth = { Authorization: `Bearer ${cfg.token}` }
  if (ping.attachPath === undefined) {
    await send(cfg.url, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: cfg.topic,
        title: ping.title,
        message: ping.message,
        priority: PRIORITY[ping.priority],
        actions: ping.actions?.map((a) => ({ action: 'view', label: a.label, url: a.url, clear: false }))
      })
    })
    return
  }

  const body = await readAttachment(ping.attachPath)
  const headers: Record<string, string> = {
    ...auth,
    Title: headerValue(ping.title),
    Message: headerValue(ping.message),
    Priority: String(PRIORITY[ping.priority]),
    Filename: headerValue(basename(ping.attachPath))
  }
  if (ping.actions && ping.actions.length > 0) {
    headers.Actions = headerValue(ping.actions.map((a) => `view, ${a.label}, ${a.url}`).join('; '))
  }
  await send(`${cfg.url}/${cfg.topic}`, { method: 'PUT', headers, body })
}

// A Blob can be sent again on a retry, unlike a consumed stream.
async function readAttachment(path: string): Promise<Blob> {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    throw new Error(`attachment not found: ${path}`)
  }
  return file
}

// Non-ASCII header values are sent as RFC 2047 encoded words, which ntfy decodes.
function headerValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) {
    return value
  }
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

// Retries network errors and 5xx responses; any other failure throws at once.
async function send(url: string, init: RequestInit): Promise<void> {
  for (let retry = 0; ; retry++) {
    const canRetry = retry < RETRY_DELAYS_MS.length
    let res: Response
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (err) {
      if (canRetry) {
        await Bun.sleep(RETRY_DELAYS_MS[retry])
        continue
      }
      throw new PingError(`ntfy request failed: ${err instanceof Error ? err.message : String(err)}`, null)
    }
    await res.body?.cancel()
    if (res.ok) {
      return
    }
    if (res.status >= 500 && canRetry) {
      await Bun.sleep(RETRY_DELAYS_MS[retry])
      continue
    }
    throw new PingError(`ntfy responded ${res.status}`, res.status)
  }
}
