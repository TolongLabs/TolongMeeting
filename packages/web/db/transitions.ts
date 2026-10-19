import { createHash } from 'node:crypto'
import {
  ACTIVE_STATES,
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

/**
 * Applies `trigger` to an occurrence: locks its row, checks the move with `nextOccurrenceState` (an illegal trigger
 * throws before anything is written), then writes the new state, `state_reason` and a `state` event in one
 * transaction. A trigger that leaves the state where it is is a no-op: nothing is written and no event is recorded.
 */
export async function applyTrigger(
  db: Db,
  occurrenceId: string,
  trigger: OccurrenceTrigger,
  opts: { reason?: string; recordEvent?: boolean } = {}
): Promise<{ from: OccurrenceState; to: OccurrenceState }> {
  const { reason, recordEvent = true } = opts
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(occurrences).where(eq(occurrences.id, occurrenceId)).for('update')
    if (!row) throw new Error(`No occurrence ${occurrenceId}`)
    const from = row.state
    const to = nextOccurrenceState(from, trigger)
    if (to === from) return { from, to }

    const leavingPasscodeScope = !ACTIVE_STATES.has(to) && to !== 'scheduled'
    const snapshot = row.entrySnapshot
    const entrySnapshot =
      leavingPasscodeScope && snapshot && snapshot.link.kind === 'fixed'
        ? { ...snapshot, link: { ...snapshot.link, url: stripPasscode(snapshot.link.url) } }
        : snapshot

    const updated = await tx
      .update(occurrences)
      .set({
        state: to,
        stateReason: reason ?? null,
        ...(leavingPasscodeScope && {
          linkUsed: stripNullable(row.linkUsed),
          pastedLink: stripNullable(row.pastedLink),
          entrySnapshot
        })
      })
      .where(and(eq(occurrences.id, occurrenceId), eq(occurrences.state, from)))
      .returning({ id: occurrences.id })
    if (updated.length !== 1) throw new Error(`Occurrence ${occurrenceId} changed state during ${trigger}`)

    if (recordEvent) {
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
    return { from, to }
  })
}
