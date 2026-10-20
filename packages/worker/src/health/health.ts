export type HealthAlert = 'black_frames' | 'frozen_silent'

export interface HealthSample {
  /** Sample time in milliseconds on any steady clock. */
  atMs: number
  /** Mean brightness of the stage frame, 0 to 255. */
  meanLuma: number
  /** Mean difference from the previous frame, 0 to 255. */
  diffPrev: number
  /**
   * Sink level over the last second, in dBFS, passed straight from `AudioSource.levelDb(1000)`. It is `null` when the
   * source has failed (its `onFatal` reports the fault) or has not yet heard a second of audio. A null level is an
   * unknown level: it never counts as silent, and it never throws here.
   */
  levelDb: number | null
  /** Participant count from the adapter, or `null` when it cannot be read. */
  participants: number | null
}

export const BLACK_LUMA = 10
export const BLACK_MS = 10_000
export const FROZEN_DIFF = 0.5
export const SILENT_DB = -50
export const FROZEN_MS = 300_000
export const MIN_PARTICIPANTS = 2
/** Samples further apart than this many expected intervals break a run: the gap was not observed. */
export const GAP_FACTOR = 3

// Tracks one condition: it fires once it has held for `holdMs`, and re-arms after one sample without it. A gap between
// samples longer than `maxGapMs` also ends the run, so one sample after a long gap cannot complete it.
class Condition {
  private since: number | null = null
  private fired = false
  private last: number | null = null

  constructor(
    private readonly holdMs: number,
    private readonly maxGapMs: number
  ) {}

  /** Returns true on the sample that makes the condition alert. */
  update(holds: boolean, atMs: number): boolean {
    const gapped = this.last !== null && atMs - this.last > this.maxGapMs
    this.last = atMs
    if (!holds || gapped) {
      this.since = null
      this.fired = false
    }
    if (!holds) return false
    this.since ??= atMs
    if (this.fired || atMs - this.since < this.holdMs) return false
    this.fired = true
    return true
  }
}

/**
 * Raises `black_frames` after 10 s of black frames, and `frozen_silent` after 5 minutes of an unchanged frame with a
 * silent sink while at least two participants are present (a frozen slide alone is normal).
 */
export class HealthMonitor {
  private readonly black: Condition
  private readonly frozen: Condition

  /**
   * `expectedIntervalMs` is how often the caller samples (2 s by default, the frame interval). A gap of more than
   * `GAP_FACTOR` times that restarts both runs.
   */
  constructor(
    private readonly onAlert: (kind: HealthAlert) => void,
    expectedIntervalMs = 2000
  ) {
    if (!(expectedIntervalMs > 0))
      throw new RangeError(`expectedIntervalMs must be positive, got ${expectedIntervalMs}`)
    const maxGapMs = GAP_FACTOR * expectedIntervalMs
    this.black = new Condition(BLACK_MS, maxGapMs)
    this.frozen = new Condition(FROZEN_MS, maxGapMs)
  }

  sample(s: HealthSample): void {
    if (this.black.update(s.meanLuma < BLACK_LUMA, s.atMs)) this.onAlert('black_frames')
    const frozenSilent =
      s.diffPrev < FROZEN_DIFF &&
      s.levelDb !== null &&
      s.levelDb < SILENT_DB &&
      s.participants !== null &&
      s.participants >= MIN_PARTICIPANTS
    if (this.frozen.update(frozenSilent, s.atMs)) this.onAlert('frozen_silent')
  }
}
