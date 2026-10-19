import { mkdir, open, readFile, truncate } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Page } from 'playwright'
import type { ChatMessage, EventType } from '@tm/core'
import type { PlatformAdapter } from '../adapters/types'
import type { Stopper } from '../types'

export interface ChatCapture extends Stopper {
  sweepNow(): Promise<void>
}

export interface ChatCaptureOptions {
  pollMs?: number
  sweepMs?: number
  append?: (file: string, data: string) => Promise<void>
  // Receives the error events of a failed step. Without it, the event goes to stderr with its message only.
  emit?: (type: EventType, data: Record<string, unknown>) => Promise<void>
}

const POLL_MS = 3_000
const SWEEP_MS = 600_000

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const codeOf = (err: unknown): string | null =>
  err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : null

// Appends `data` and fsyncs before it resolves. On a failed write the file is cut back to its size before the append,
// so the retry does not write the same rows twice.
export async function appendDurably(file: string, data: string): Promise<void> {
  const handle = await open(file, 'a')
  try {
    const { size } = await handle.stat()
    try {
      await handle.appendFile(data)
      await handle.sync()
    } catch (err) {
      await handle.truncate(size)
      throw err
    }
  } finally {
    await handle.close()
  }
}

// Creates the file if missing, and fsyncs the directory so the new entry itself is durable.
async function createDurably(file: string): Promise<void> {
  const created = await open(file, 'a')
  try {
    await created.sync()
  } finally {
    await created.close()
  }
  const dir = await open(dirname(file), 'r')
  try {
    await dir.sync()
  } finally {
    await dir.close()
  }
}

// Keys of the rows already in the file. A last line with no newline is a write a crash cut short: it was never
// acknowledged, so it is cut off and the message is read again. Any other unparseable line is an error.
async function loadWritten(file: string): Promise<Set<string>> {
  const bytes = await readFile(file)
  const complete = bytes.lastIndexOf(0x0a) + 1
  if (complete !== bytes.length) await truncate(file, complete)
  const keys = new Set<string>()
  for (const line of bytes.subarray(0, complete).toString('utf8').split('\n')) {
    if (line !== '') keys.add((JSON.parse(line) as ChatMessage).key)
  }
  return keys
}

const stderrEmit = async (type: EventType, data: Record<string, unknown>): Promise<void> => {
  console.error(`chat capture ${type}: ${JSON.stringify(data)}`)
}

// Reads the meeting chat into `file` (one ChatMessage per line) and calls `onMessage` for each new message.
// A row is appended and fsynced before the cursor moves or `onMessage` runs, so a restart never writes it twice. Polls
// and sweeps run one at a time through one queue. A failed step emits an `error` event and the next tick tries again.
export async function startChatCapture(
  page: Page,
  adapter: PlatformAdapter,
  file: string,
  onMessage: (m: ChatMessage) => Promise<void>,
  opts: ChatCaptureOptions = {}
): Promise<ChatCapture> {
  const pollMs = opts.pollMs ?? POLL_MS
  const sweepMs = opts.sweepMs ?? SWEEP_MS
  const append = opts.append ?? appendDurably
  const emit = opts.emit ?? stderrEmit

  await mkdir(dirname(file), { recursive: true })
  await createDurably(file)
  // The cursor the adapter reads against: every key durably written. It only grows after an append resolves.
  const seen = await loadWritten(file)
  let stopped = false
  let queue: Promise<void> = Promise.resolve()
  let pollQueued = false
  let sweepQueued: Promise<void> | null = null

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    queue = queue.then(task)
    return queue
  }

  // Each tick catches its own failure, so one failed read or write never ends the capture.
  async function report(where: 'read' | 'sweep' | 'append' | 'deliver', err: unknown): Promise<void> {
    const data = { where: 'chat', step: where, code: codeOf(err), message: messageOf(err) }
    try {
      await emit('error', data)
    } catch (emitErr) {
      console.error(`chat capture: error event not emitted for step=${where}: ${messageOf(emitErr)}`)
    }
  }

  // Writes the unseen messages in one append, then marks them seen and delivers them in order. Duplicates within
  // `found`, or rows already written by an earlier poll or sweep, are dropped here.
  async function record(found: ChatMessage[]): Promise<void> {
    const batch = new Map<string, ChatMessage>()
    for (const m of found) if (!seen.has(m.key) && !batch.has(m.key)) batch.set(m.key, m)
    if (batch.size === 0) return
    const fresh = [...batch.values()]
    try {
      await append(file, fresh.map((m) => `${JSON.stringify(m)}\n`).join(''))
    } catch (err) {
      // Nothing is marked seen, so the next poll or sweep finds these rows again and retries.
      await report('append', err)
      return
    }
    for (const m of fresh) seen.add(m.key)
    for (const m of fresh) {
      try {
        await onMessage(m)
      } catch (err) {
        // The row is written, so it is not read again; the failure is reported and the rest still go out.
        await report('deliver', err)
      }
    }
  }

  async function tick(where: 'read' | 'sweep', found: () => Promise<ChatMessage[]>): Promise<void> {
    if (stopped) return
    let messages: ChatMessage[]
    try {
      messages = await found()
    } catch (err) {
      await report(where, err)
      return
    }
    await record(messages)
  }

  const poll = (): Promise<void> =>
    tick('read', async () => (await adapter.readChat(page, { seenKeys: [...seen] })).messages)
  const sweep = (): Promise<void> => tick('sweep', () => adapter.sweepChat(page))

  const pollTimer = setInterval(() => {
    // A poll queued behind a long sweep is enough: more would only pile up.
    if (pollQueued) return
    pollQueued = true
    void enqueue(poll).finally(() => {
      pollQueued = false
    })
  }, pollMs)
  const sweepTimer = setInterval(() => void sweepNow(), sweepMs)

  function sweepNow(): Promise<void> {
    sweepQueued ??= enqueue(sweep).finally(() => {
      sweepQueued = null
    })
    return sweepQueued
  }

  return {
    sweepNow,
    async stop() {
      stopped = true
      clearInterval(pollTimer)
      clearInterval(sweepTimer)
      await queue
    }
  }
}
