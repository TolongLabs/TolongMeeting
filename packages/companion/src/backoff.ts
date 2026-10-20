/** Waits between reconnects, by attempt (0 is the first retry). The last step repeats. */
const LADDER_MS = [1000, 2000, 5000, 10_000, 30_000] as const

export const MAX_RECONNECT_DELAY_MS = LADDER_MS[LADDER_MS.length - 1]
/** A connection that stayed up this long counts as healthy: the next failure starts the ladder again. */
export const STABLE_CONNECTION_MS = 60_000

/**
 * Capped exponential-style backoff with jitter: 1, 2, 5, 10, then 30 seconds, each scaled by a random factor in
 * [0.8, 1.2) so many companions do not reconnect in step. The result never exceeds `MAX_RECONNECT_DELAY_MS`.
 * `random` returns a number in [0, 1) and is a test seam.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  if (!Number.isInteger(attempt) || attempt < 0)
    throw new RangeError(`attempt must be a non-negative integer: ${attempt}`)
  const base = LADDER_MS[Math.min(attempt, LADDER_MS.length - 1)]
  return Math.min(MAX_RECONNECT_DELAY_MS, Math.round(base * (0.8 + 0.4 * random())))
}
