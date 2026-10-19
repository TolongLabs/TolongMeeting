export type HealthAlert = 'black_frames' | 'frozen_silent'

export interface HealthSample {
  /** Sample time in milliseconds on any steady clock. */
  atMs: number
  /** Mean brightness of the stage frame, 0 to 255. */
  meanLuma: number
  /** Mean difference from the previous frame, 0 to 255. */
  diffPrev: number
  /** Sink level over the last second, in dBFS. */
  levelDb: number
  /** Participant count from the adapter, or `null` when it cannot be read. */
  participants: number | null
}

export const BLACK_LUMA = 10
export const BLACK_MS = 10_000
export const FROZEN_DIFF = 0.5
export const SILENT_DB = -50
export const FROZEN_MS = 300_000
export const MIN_PARTICIPANTS = 2

// Tracks one condition: it fires once it has held for `holdMs`, and re-arms after one sample without it.
class Condition {
  private since: number | null = null
  private fired = false

  constructor(private readonly holdMs: number) {}

  /** Returns true on the sample that makes the condition alert. */
  update(holds: boolean, atMs: number): boolean {
    if (!holds) {
      this.since = null
      this.fired = false
      return false
    }
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
  private readonly black = new Condition(BLACK_MS)
  private readonly frozen = new Condition(FROZEN_MS)

  constructor(private readonly onAlert: (kind: HealthAlert) => void) {}

  sample(s: HealthSample): void {
    if (this.black.update(s.meanLuma < BLACK_LUMA, s.atMs)) this.onAlert('black_frames')
    const frozenSilent =
      s.diffPrev < FROZEN_DIFF && s.levelDb < SILENT_DB && s.participants !== null && s.participants >= MIN_PARTICIPANTS
    if (this.frozen.update(frozenSilent, s.atMs)) this.onAlert('frozen_silent')
  }
}
