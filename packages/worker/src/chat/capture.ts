import { mkdir, open, readFile, truncate } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Page } from 'playwright'
import type { ChatMessage, EventType } from '@tm/core'
import type { PlatformAdapter } from '../adapters/types'
import type { Stopper } from '../types'

export interface ChatCapture extends Stopper {
  // Rows already in the file when capture started, in file order. `onReplay` is called for each of them.
  readonly loaded: readonly ChatMessage[]
  sweepNow(): Promise<void>
}

export interface ChatCaptureOptions {
  pollMs?: number
  sweepMs?: number
  append?: (file: string, data: string) => Promise<void>
  // Receives the error events of a failed step. Without it, the event goes to stderr.
  emit?: (type: EventType, data: Record<string, unknown>) => Promise<void>
  // Called once per row already in the file, in file order, before the first poll. A restart re-offers those rows here.
  onReplay?: (m: ChatMessage) => Promise<void> | void
}

// The part of a file handle that appendDurably uses. The opener is a seam so a test can inject a failing write.
export interface AppendHandle {
  stat(): Promise<{ size: number }>
  appendFile(data: string): Promise<void>
  sync(): Promise<void>
  truncate(len: number): Promise<void>
  close(): Promise<void>
}

type Step = 'read' | 'sweep' | 'append' | 'deliver' | 'load'

const POLL_MS = 3_000
const SWEEP_MS = 600_000
const UNREADABLE_ROW = 'chat.jsonl has a row that is not valid JSON'
const DELIVERY_FAILED = 'delivery failed'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const codeOf = (err: unknown): string | null =>
  err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : null

// Appends `data` and fsyncs before it resolves. On a failed write the file is cut back to its size before the append,
// so the retry does not write the same rows twice. If the cut-back also fails, the write's error is the one thrown.
export async function appendDurably(
  file: string,
  data: string,
  openHandle: (file: string) => Promise<AppendHandle> = (path) => open(path, 'a')
): Promise<void> {
  const handle = await openHandle(file)
  try {
    const { size } = await handle.stat()
    try {
      await handle.appendFile(data)
      await handle.sync()
    } catch (err) {
      await handle.truncate(size).catch((cutErr: unknown) => {
        console.error(`chat capture: could not cut ${file} back to ${size} bytes: ${codeOf(cutErr) ?? 'no code'}`)
      })
      throw err
    }
  } finally {
    await handle.close()
  }
}

// Creates the file if missing, and fsyncs the directory so the new entry itself is durable.
export async function createDurably(file: string): Promise<void> {
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

const parseRow = (line: string): ChatMessage | null => {
  try {
    return JSON.parse(line) as ChatMessage
  } catch {
    return null
  }
}

// Rows already in the file, in file order. A last line with no newline is a write a crash cut short: it was never
// acknowledged, so it is cut off and the message is read again. Any other unparseable line fails the start. Its
// error event carries no row text, since a row is chat.
async function loadRows(file: string, emit: NonNullable<ChatCaptureOptions['emit']>): Promise<ChatMessage[]> {
  const bytes = await readFile(file)
  const complete = bytes.lastIndexOf(0x0a) + 1
  if (complete !== bytes.length) await truncate(file, complete)
  const rows: ChatMessage[] = []
  for (const line of bytes.subarray(0, complete).toString('utf8').split('\n')) {
    if (line === '') continue
    const row = parseRow(line)
    if (row === null) {
      await emit('error', { where: 'chat', step: 'load', code: null, message: UNREADABLE_ROW })
      throw new Error(UNREADABLE_ROW)
    }
    rows.push(row)
  }
  return rows
}

const stderrEmit = async (type: EventType, data: Record<string, unknown>): Promise<void> => {
  console.error(`chat capture ${type}: ${JSON.stringify(data)}`)
}

// Reads the meeting chat into `file` (one ChatMessage per line) and delivers each new message to `onMessage`.
//
// Writes and delivery:
// - A row is appended and fsynced before its cursor moves or `onMessage` runs, so no row is written twice.
// - A row whose delivery fails stays at the head of a pending queue and is retried on the next tick. Rows behind it wait,
//   so delivery stays in file order. A row still pending at `stop()` is on disk: the next start replays it.
// - On start every row already in the file is queued for `onReplay`, in file order, before the first poll.
// - Delivery is therefore at-least-once across restarts; the callee must dedupe (the form pinger does).
//
// Callers: `await sweepNow()` before `stop()`, so the rows the polls missed are written first. A sweep reads the list
// top to bottom and can append older rows after newer ones, so the file is not sorted; the pipeline sorts it.
//
// Polls and sweeps run one at a time through one queue. A failed step emits an `error` event with its code and step,
// and the next tick tries again.
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
  const onReplay = opts.onReplay

  await mkdir(dirname(file), { recursive: true })
  await createDurably(file)
  const loaded = await loadRows(file, emit)
  // The cursor the adapter reads against: every key durably written. It only grows after an append resolves.
  const seen = new Set(loaded.map((m) => m.key))
  // Deliveries not yet done, in file order. A thunk that throws stays at the head until a later tick succeeds.
  const pending: Array<() => Promise<void> | void> = []
  if (onReplay) for (const m of loaded) pending.push(() => onReplay(m))
  let stopped = false
  let queue: Promise<void> = Promise.resolve()
  let pollQueued = false
  let sweepQueued: Promise<void> | null = null

  // A task that rejects must not stop the ticks queued after it, so each task runs whatever the one before did.
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    queue = queue.then(task, task)
    return queue
  }

  // Each tick catches its own failure, so one failed read or write never ends the capture. The event carries the
  // code and the step only for a delivery failure, so no chat text can reach it.
  async function report(step: Step, err: unknown, message: string = messageOf(err)): Promise<void> {
    const data = { where: 'chat', step, code: codeOf(err), message }
    try {
      await emit('error', data)
    } catch (emitErr) {
      console.error(`chat capture: error event not emitted for step=${step}: ${codeOf(emitErr) ?? 'no code'}`)
    }
  }

  // Runs the pending deliveries in order. Stops at the first failure, which stays at the head for the next tick.
  async function deliverPending(): Promise<void> {
    while (pending.length > 0) {
      try {
        await pending[0]()
      } catch (err) {
        await report('deliver', err, DELIVERY_FAILED)
        return
      }
      pending.shift()
    }
  }

  // Writes the unseen messages in one append, then marks them seen and queues them for delivery. Duplicates within
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
    for (const m of fresh) pending.push(() => onMessage(m))
    await deliverPending()
  }

  async function tick(step: 'read' | 'sweep', found: () => Promise<ChatMessage[]>): Promise<void> {
    if (stopped) return
    // Earlier failed deliveries and the replay of loaded rows go first, so replay runs before the first poll.
    await deliverPending()
    let messages: ChatMessage[]
    try {
      messages = await found()
    } catch (err) {
      await report(step, err)
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
    loaded,
    sweepNow,
    async stop() {
      stopped = true
      clearInterval(pollTimer)
      clearInterval(sweepTimer)
      await queue
    }
  }
}
