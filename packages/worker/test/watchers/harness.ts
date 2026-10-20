import type { FormCandidate } from '@tm/core'
import { configureWatchers, type WatcherEnv, type WatcherStatus } from '../../src/watchers/loop'
import type { WatchPhase } from '../../src/watchers/rules'

const SLEEP_MS = 20

export interface WatchHarness {
  /** Pass this as the watcher's `onLink`. */
  onLink: (c: FormCandidate | { meetingUrl: string }) => void
  meeting: { meetingUrl: string }[]
  forms: FormCandidate[]
  /** Every delay the loop asked for, with the phase it was asked in. */
  delays: { phase: WatchPhase; ms: number }[]
  statuses: WatcherStatus[]
  /** Changes the watcher's environment; takes effect at once. */
  set(over: Partial<WatcherEnv>): void
  /** Resolves once `n` polls that began after this call have finished. */
  polls(n: number): Promise<void>
}

/**
 * Wires the watcher loop to a fake clock for a spec. The loop's sleep records the delay and waits 20 ms. Call
 * `resetWatcherEnv()` in `beforeEach` so one spec's environment never leaks into the next.
 */
export function watchHarness(over: Partial<WatcherEnv> = {}): WatchHarness {
  const state: Partial<WatcherEnv> = {}
  const delays: WatchHarness['delays'] = []
  const waiting: { until: number; resolve: () => void }[] = []

  const harness: WatchHarness = {
    onLink(c) {
      if ('meetingUrl' in c) harness.meeting.push(c)
      else harness.forms.push(c)
    },
    meeting: [],
    forms: [],
    delays,
    statuses: [],
    set(next) {
      Object.assign(state, next)
      configureWatchers(next)
    },
    polls(n) {
      // The loop sleeps, then polls, then sleeps again: the sleep after the next `n` full polls is number
      // `started + n + 1`, and a poll that was already running when this was called does not count.
      const until = delays.length + n + 1
      return new Promise((resolve) => {
        if (delays.length >= until) resolve()
        else waiting.push({ until, resolve })
      })
    }
  }

  const sleep = async (ms: number) => {
    delays.push({ phase: (state.phase ?? (() => 'before' as const))(), ms })
    for (const w of waiting.splice(0)) {
      if (delays.length >= w.until) w.resolve()
      else waiting.push(w)
    }
    await new Promise((resolve) => setTimeout(resolve, SLEEP_MS))
  }

  harness.set({ sleep, onStatus: (s) => harness.statuses.push(s), ...over })
  return harness
}
