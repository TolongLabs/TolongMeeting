import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { MeetingEventSchema, StateEventDataSchema, MAX_HEARTBEAT_EVENTS, type MeetingEvent } from '@tm/core'
import { appendDurably } from '../chat/capture'
import { writeFileAtomic } from '../forms/store'

const FILE = /^attempt_(\d+)\.jsonl$/

const encode = (events: MeetingEvent[]): string => events.map((e) => `${JSON.stringify(e)}\n`).join('')

// The events in a file, in order. A line that does not parse is an error: the file is only ever written by this class.
async function readEvents(file: string): Promise<MeetingEvent[]> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => MeetingEventSchema.parse(JSON.parse(line)) as MeetingEvent)
}

/**
 * Events not yet acknowledged by the server, in the order they happened. They are kept in a file, one directory per
 * occurrence and one file per attempt (`<dir>/attempt_<N>.jsonl`), so a restart or a long outage loses none. A restarted
 * worker adopts the unsent events of the earlier attempts' files (all but their plain state changes, which the new
 * worker's own states replace) before it sends anything.
 *
 * `push` and `ack` return at once; the disk writes follow in order. `settled()` resolves when they are done, and
 * rejects with the first write that failed.
 */
export class EventOutbox {
  private items: MeetingEvent[]
  private writes: Promise<void> = Promise.resolve()
  private failure: unknown = null

  private constructor(
    private readonly file: string,
    items: MeetingEvent[]
  ) {
    this.items = items
  }

  /** Opens the outbox of `attempt` in `dir`, adopting the unsent events of earlier attempts. */
  static async open(dir: string, attempt: number): Promise<EventOutbox> {
    await mkdir(dir, { recursive: true })
    const file = join(dir, `attempt_${attempt}.jsonl`)
    const earlier = (await readdir(dir))
      .map((name) => ({ name, n: Number(FILE.exec(name)?.[1] ?? Number.NaN) }))
      .filter((f) => Number.isInteger(f.n) && f.n < attempt)
      .sort((a, b) => a.n - b.n)
    const adopted: MeetingEvent[] = []
    for (const f of earlier) {
      const events = await readEvents(join(dir, f.name))
      adopted.push(...events.filter((e) => !(e.type === 'state' && StateEventDataSchema.safeParse(e.data).success)))
    }
    const own = await readEvents(file)
    const outbox = new EventOutbox(file, [...adopted, ...own])
    if (earlier.length > 0) {
      // The adopted events are on disk in this attempt's file before the old files go.
      await writeFileAtomic(file, encode(outbox.items))
      for (const f of earlier) await rm(join(dir, f.name), { force: true })
    }
    return outbox
  }

  push(e: MeetingEvent): void {
    this.items.push(e)
    this.write(() => appendDurably(this.file, encode([e])))
  }

  /** The next `max` events, oldest first. They stay until acknowledged. */
  pending(max = MAX_HEARTBEAT_EVENTS): MeetingEvent[] {
    return this.items.slice(0, max)
  }

  /** Forgets the first `n` events. */
  ack(n: number): void {
    if (!Number.isInteger(n) || n < 0 || n > this.items.length) {
      throw new RangeError(`cannot acknowledge ${n} of ${this.items.length} events`)
    }
    if (n === 0) return
    this.items = this.items.slice(n)
    const rest = this.items
    this.write(() => writeFileAtomic(this.file, encode(rest)))
  }

  get size(): number {
    return this.items.length
  }

  /** Resolves when every write so far is on disk; rejects with the first write that failed. */
  async settled(): Promise<void> {
    await this.writes
    if (this.failure !== null) throw this.failure
  }

  private write(task: () => Promise<void>): void {
    this.writes = this.writes.then(task).catch((error: unknown) => {
      this.failure ??= error
      console.error(`event outbox not written: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}
