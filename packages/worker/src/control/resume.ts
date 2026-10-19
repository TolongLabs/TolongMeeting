import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  MeetingEventSchema,
  StateEventDataSchema,
  WORKER_STATES,
  type MeetingEvent,
  type OccurrenceState
} from '@tm/core'
import { z } from 'zod'
import { writeFileAtomic } from '../forms/store'
import { earlierFiles, readOutboxFile } from './outbox'

const FILE = 'resume.json'
/** What the first attempt knows without asking: it starts in `starting`. */
const START = { attempt: 1, state: 'starting' as OccurrenceState }

// The state the server had when an attempt started, and which attempt that was. Events of earlier attempts no longer count.
const BaseSchema = z.object({ attempt: z.number().int().min(1), state: z.string() })

const keyOf = (e: MeetingEvent): string => `${e.attempt}|${e.at}|${JSON.stringify(e.data)}`
const stateOf = (e: MeetingEvent): OccurrenceState | null => {
  if (e.type !== 'state') return null
  const change = StateEventDataSchema.safeParse(e.data)
  return change.success ? change.data.state : null
}
const isWorkerState = (state: OccurrenceState): boolean => (WORKER_STATES as ReadonlySet<string>).has(state)

async function readBase(dir: string): Promise<{ attempt: number; state: OccurrenceState }> {
  let text: string
  try {
    text = await readFile(join(dir, FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return START
    throw error
  }
  const base = BaseSchema.parse(JSON.parse(text))
  return { attempt: base.attempt, state: StateEventDataSchema.parse({ state: base.state }).state }
}

async function readLog(eventsFile: string): Promise<MeetingEvent[]> {
  let text: string
  try {
    text = await readFile(eventsFile, 'utf8')
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
 * The state the server has acknowledged for this occurrence, which a restarted worker reports first: the server accepts
 * only the state it applied before the crash (`resume_state`), and the event log can be ahead of that. It is the state
 * event just before the first state change still unsent in the earlier outbox files (the last one if none is unsent),
 * among the worker states, and `starting` when there is none. Read before `EventOutbox.open`, which drops those files.
 *
 * An attempt that sends nothing leaves the state it began with in `resume.json` in the outbox directory, so a second
 * restart (with the server still unreachable) does not mistake the first restart's log for acknowledged work.
 */
export async function acknowledgedState(dir: string, attempt: number, eventsFile: string): Promise<OccurrenceState> {
  const base = await readBase(dir)
  const log = (await readLog(eventsFile)).filter((e) => e.attempt >= base.attempt && stateOf(e) !== null)
  let firstUnsent: string | null = null
  for (const f of await earlierFiles(dir, attempt)) {
    const { events } = await readOutboxFile(join(dir, f.name))
    const unsent = events.find((e) => e.attempt >= base.attempt && stateOf(e) !== null)
    if (unsent) {
      firstUnsent = keyOf(unsent)
      break
    }
  }
  // An unsent change the log does not hold cannot be placed: nothing in the log is known to be acknowledged.
  const at = firstUnsent === null ? log.length : log.findIndex((e) => keyOf(e) === firstUnsent)
  const known = log
    .slice(0, Math.max(at, 0))
    .map((e) => stateOf(e)!)
    .filter(isWorkerState)
  return known.at(-1) ?? base.state
}

/** Keeps `state` as what the server had when this attempt started. */
export async function rememberState(dir: string, attempt: number, state: OccurrenceState): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFileAtomic(join(dir, FILE), `${JSON.stringify({ attempt, state })}\n`)
}
