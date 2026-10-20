import { createHash } from 'node:crypto'
import {
  ACTIVE_STATES,
  IllegalTransition,
  nextOccurrenceState,
  stripPasscode,
  type OccurrenceState,
  type OccurrenceTrigger
} from '@tm/core'
import { and, eq } from 'drizzle-orm'
import { events, occurrences, type Db } from './index'

/** SHA-256 of the canonical (sorted-key) JSON of `data`, as stored in `events.data_hash`. */
export function hashEventData(data: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, canonical(x)])
          )
        : v
  return createHash('sha256')
    .update(JSON.stringify(canonical(data)))
    .digest('hex')
}

const stripNullable = (link: string | null): string | null => (link === null ? null : stripPasscode(link))

export interface TriggerResult {
  from: OccurrenceState
  to: OccurrenceState
  /** The occurrence's `restarts` count after this trigger. The caller fails the occurrence once it passes 3. */
  restarts: number
  /** The occurrence's `knocks` count after this trigger. The caller stops knocking once it passes 2. */
  knocks: number
}

/**
 * Applies `trigger` to an occurrence: locks its row, checks the move with `nextOccurrenceState` (an illegal trigger
 * throws before anything is written), then writes the new state, `state_reason` and a `state` event in one
 * transaction.
 *
 * - `crash` stores the pre-crash state in `resume_state` and adds 1 to `restarts`. A crash while already `restarting`
 *   keeps `resume_state`, adds 1 to `restarts` and records no state event.
 * - `resume:<s>` is illegal unless `s` equals `resume_state`; it clears `resume_state`.
 * - `knock_again` adds 1 to `knocks` and records no state event.
 * - Any other trigger that leaves the state where it is writes nothing.
 */
export async function applyTrigger(
  db: Db,
  occurrenceId: string,
  trigger: OccurrenceTrigger,
  opts: { reason?: string; recordEvent?: boolean } = {}
): Promise<TriggerResult> {
  const { reason, recordEvent = true } = opts
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(occurrences).where(eq(occurrences.id, occurrenceId)).for('update')
    if (!row) throw new Error(`No occurrence ${occurrenceId}`)
    const from = row.state
    const to = nextOccurrenceState(from, trigger)
    if (trigger.startsWith('resume:') && trigger !== `resume:${row.resumeState}`)
      throw new IllegalTransition(from, trigger)

    const counters = {
      restarts: trigger === 'crash' ? row.restarts + 1 : row.restarts,
      knocks: trigger === 'knock_again' ? row.knocks + 1 : row.knocks
    }
    const selfLoop = to === from
    if (selfLoop && trigger !== 'crash' && trigger !== 'knock_again') return { from, to, ...counters }

    const leavingPasscodeScope = !selfLoop && !ACTIVE_STATES.has(to) && to !== 'scheduled'
    const snapshot = row.entrySnapshot
    // TODO(plan 02): chat-kind links (`link.chat` as a URL) can carry passcodes too; strip those here.
    const entrySnapshot =
      leavingPasscodeScope && snapshot && snapshot.link.kind === 'fixed'
        ? { ...snapshot, link: { ...snapshot.link, url: stripPasscode(snapshot.link.url) } }
        : snapshot

    const updated = await tx
      .update(occurrences)
      .set({
        ...counters,
        ...(!selfLoop && {
          state: to,
          stateReason: reason ?? null,
          // Written on a crash, cleared by any move out of restarting.
          resumeState: trigger === 'crash' ? from : null
        }),
        ...(leavingPasscodeScope && {
          linkUsed: stripNullable(row.linkUsed),
          pastedLink: stripNullable(row.pastedLink),
          entrySnapshot
        })
      })
      .where(and(eq(occurrences.id, occurrenceId), eq(occurrences.state, from)))
      .returning({ id: occurrences.id })
    if (updated.length !== 1) throw new Error(`Occurrence ${occurrenceId} changed state during ${trigger}`)

    if (recordEvent && !selfLoop) {
      const data = { from, to, trigger, ...(reason !== undefined && { reason }) }
      await tx.insert(events).values({
        occurrenceId,
        memberId: row.memberId,
        attempt: row.attempt,
        at: new Date(),
        type: 'state',
        data,
        dataHash: hashEventData(data)
      })
    }
    return { from, to, ...counters }
  })
}
