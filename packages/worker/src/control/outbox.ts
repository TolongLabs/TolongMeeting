import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { MeetingEventSchema, StateEventDataSchema, MAX_HEARTBEAT_EVENTS, type MeetingEvent } from '@tm/core'
import { appendDurably } from '../chat/capture'
import { writeFileAtomic } from '../forms/store'

const FILE = /^attempt_(\d+)\.jsonl$/

const encode = (events: MeetingEvent[]): string => events.map((e) => `${JSON.stringify(e)}\n`).join('')

/**
 * The events in a file, in order, up to the first line that does not parse (a line cut short by a crash, or damage).
 * `damaged` is true when a line was left out.
 */
export async function readOutboxFile(file: string): Promise<{ events: MeetingEvent[]; damaged: boolean }> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], damaged: false }
    throw error
  }
  const events: MeetingEvent[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      events.push(MeetingEventSchema.parse(JSON.parse(line)) as MeetingEvent)
    } catch {
      return { events, damaged: true }
    }
  }
  return { events, damaged: false }
}

// The earlier attempts' files in `dir`, oldest attempt first. A directory that does not exist yet holds none.
export async function earlierFiles(dir: string, attempt: number): Promise<{ name: string; n: number }[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return names
    .map((name) => ({ name, n: Number(FILE.exec(name)?.[1] ?? Number.NaN) }))
    .filter((f) => Number.isInteger(f.n) && f.n < attempt)
    .sort((a, b) => a.n - b.n)
}

/**
 * Events not yet acknowledged by the server, in the order they happened. They are kept in a file, one directory per
 * occurrence and one file per attempt (`<dir>/attempt_<N>.jsonl`), so a restart or a long outage loses none. A restarted
 * worker adopts the unsent events of the earlier attempts' files (all but their plain state changes, which the new
 * worker's own states replace) before it sends anything.
 *
 * A file that does not parse to its end is renamed `<name>.damaged` (kept for a look) and its readable start is used;
 * `damaged` lists such files so the caller can report them.
 *
 * `push` and `ack` return at once; the disk writes follow in order. `settled()` resolves when they are done, and
 * rejects with the first write that failed.
 */
export class EventOutbox {
  private items: MeetingEvent[]
  private writes: Promise<void> = Promise.resolve()
  private failure: unknown = null

  /** The files that were damaged, as renamed (`attempt_<N>.jsonl.damaged`). */
  damaged: string[] = []

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
    const earlier = await earlierFiles(dir, attempt)
    const damaged: string[] = []
    // Reads a file; one that is damaged is renamed aside first, and what could be read is kept.
    const read = async (name: string): Promise<MeetingEvent[]> => {
      const path = join(dir, name)
      const { events, damaged: bad } = await readOutboxFile(path)
      if (bad) {
        await rename(path, `${path}.damaged`)
        damaged.push(`${name}.damaged`)
      }
      return events
    }
    const adopted: MeetingEvent[] = []
    for (const f of earlier) {
      const events = await read(f.name)
      adopted.push(...events.filter((e) => !(e.type === 'state' && StateEventDataSchema.safeParse(e.data).success)))
    }
    const own = await read(`attempt_${attempt}.jsonl`)
    const outbox = new EventOutbox(file, [...adopted, ...own])
    outbox.damaged = damaged
    if (earlier.length > 0 || damaged.length > 0) {
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
