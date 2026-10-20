import type { CompanionJob } from '@tm/core'
import { DeviceRevokedError, type CompanionApi } from '../api'
import { reconnectDelayMs } from '../backoff'

export const DEFAULT_POLL_MS = 60_000

export interface JobPollerDeps {
  api: Pick<CompanionApi, 'jobs'>
  /**
   * The hand-off to the runner (03 T15): `NativeRunner.offer`. It gets the jobs the website lists for this PC and
   * claims at most one itself, only when idle. The poller waits for a returned promise, so polls never overlap.
   */
  onJobs(jobs: CompanionJob[]): void | Promise<void>
  /** `NativeRunner.busy`. While it is true the poller does not list jobs: nothing could be claimed. */
  busy?(): boolean
  /** Default 60000. The wait starts when a poll ends. */
  intervalMs?: number
  /** Failed polls, and errors from `onJobs`. Never carries the token. */
  onError?(error: Error): void
  /** The website said this PC is unpaired ("PC was unpaired"). The poller stops for good; the API already cleared the secrets. */
  onRevoked?(error: DeviceRevokedError): void
  /** Test seam: the wait after the n-th failed poll in a row. Default `reconnectDelayMs`. */
  delayMs?: (attempt: number) => number
}

/**
 * Lists this PC's jobs at once, then every `intervalMs`, and after `trigger()`. One poll runs at a time: a trigger during
 * a poll (or during `onJobs`) queues exactly one more poll, so a burst of `job_available` events, or a replay after a
 * stream reconnect, never makes two overlapping lists. A failed poll (offline, 5xx, a 401 that is not "unpaired")
 * backs off with the stream's ladder and ignores triggers until the wait ends. A 401 `device_revoked_or_unknown`
 * stops the poller.
 */
export function startJobPoller(d: JobPollerDeps): { trigger(): void; stop(): void } {
  const intervalMs = d.intervalMs ?? DEFAULT_POLL_MS
  const delayMs = d.delayMs ?? ((attempt: number) => reconnectDelayMs(attempt))
  const report = (e: unknown) => d.onError?.(e instanceof Error ? e : new Error(String(e)))

  let stopped = false
  let polling = false
  let backingOff = false
  let again = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let wake: (() => void) | null = null

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve
      timer = setTimeout(resolve, ms)
    })

  /** Returns true when the poll worked. */
  async function pollOnce(): Promise<boolean> {
    polling = true
    try {
      if (d.busy?.() === true) return true
      const jobs = await d.api.jobs()
      if (stopped) return true
      try {
        await d.onJobs(jobs)
      } catch (e) {
        // A failing handler is a bug to see, not a reason to back off the website.
        report(new Error(`the job handler failed: ${e instanceof Error ? e.message : String(e)}`))
      }
      return true
    } catch (e) {
      if (stopped) return true
      if (e instanceof DeviceRevokedError) {
        stopped = true
        d.onRevoked?.(e)
        return true
      }
      report(e)
      return false
    } finally {
      polling = false
    }
  }

  async function run(): Promise<void> {
    let failures = 0
    while (!stopped) {
      again = false
      const ok = await pollOnce()
      if (stopped) return
      failures = ok ? 0 : failures + 1
      // A trigger that arrived during a good poll means a job may have appeared after the list was read.
      if (ok && again) continue
      backingOff = !ok
      await sleep(ok ? intervalMs : delayMs(failures - 1))
      backingOff = false
    }
  }

  void run()

  return {
    trigger() {
      if (stopped || backingOff) return
      if (polling) again = true
      else wake?.()
    },
    stop() {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      wake?.()
    }
  }
}
