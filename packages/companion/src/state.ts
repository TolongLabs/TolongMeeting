import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { isMissing, Queue, writeFileAtomic } from './atomic'

/** Non-secret progress markers, so a restart carries on where the last run stopped. */
export interface CompanionState {
  ntfyLastId: string | null
  summariesAfter: string | null
  lastEventId: number
}

const StateSchema = z.strictObject({
  ntfyLastId: z.string().min(1).max(256).nullable(),
  summariesAfter: z.iso.datetime({ offset: true }).nullable(),
  lastEventId: z.int().min(0).max(Number.MAX_SAFE_INTEGER)
}) satisfies z.ZodType<CompanionState>

const INITIAL: CompanionState = { ntfyLastId: null, summariesAfter: null, lastEventId: 0 }

export class StateStore {
  private current: CompanionState
  private readonly writes = new Queue()

  /** Reads the file once, synchronously; a missing file starts from scratch and a malformed one throws. */
  constructor(private readonly file: string) {
    try {
      this.current = StateSchema.parse({ ...INITIAL, ...JSON.parse(readFileSync(file, 'utf8')) })
    } catch (e) {
      if (!isMissing(e)) throw e
      this.current = { ...INITIAL }
    }
  }

  get(): CompanionState {
    return { ...this.current }
  }

  /** Saves before it returns; the in-memory state moves only once the file is written. */
  update(patch: Partial<CompanionState>): Promise<void> {
    return this.writes.run(async () => {
      const next = StateSchema.parse({ ...this.current, ...patch })
      await writeFileAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`, 0o600)
      this.current = next
    })
  }
}
