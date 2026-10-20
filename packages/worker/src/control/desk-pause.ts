import type { SigninEventData } from '@tm/core'
import type { Stopper } from '../types'
import { IDLE_CLOSE_MS, SIGNIN_START_URLS } from './vnc'

const IDLE_CHECK_MS = 10_000
/** This many idle checks in a row that fail take the desk back (one failure may be a blip). */
const MAX_IDLE_FAILURES = 2

export type ResumeReason = 'command' | 'idle'

export type DeskReopenEvent = { desk: 'reopened'; count: number }

export type DeskPauseDeps = {
  startVnc(): Promise<Stopper>
  idleMs(): Promise<number>
  /** Opens the sign-in pages in new desk tabs; the result closes them. */
  openTabs(urls: string[]): Promise<() => Promise<void>>
  /** Puts the desk page's anchor tab back when the member closed it. Runs before the pause tabs close. */
  anchor(): Promise<void>
  checkpoint(): Promise<void>
  emit(data: SigninEventData | DeskReopenEvent): void
  /** A failure the pause cannot throw to anyone (the idle check runs on a timer). Never given a secret. */
  report?(error: unknown): void
  /** Registers a listener called when the desk window/page is closed. */
  onDeskClose?(handler: () => void | Promise<void>): Stopper | (() => void)
}

export type DeskPauseClock = { now(): number; every(ms: number, fn: () => void): Stopper }

export const realClock: DeskPauseClock = {
  now: () => Date.now(),
  every(ms, fn) {
    const timer = setInterval(fn, ms)
    return { stop: async () => clearInterval(timer) }
  }
}

/**
 * The desk handed to the member for a sign-in during a meeting. Recording and the stage go on; only the desk is
 * exposed, through the remote view. The pause ends when the member presses Done (`resume('command')`), after 15 minutes
 * without input (`resume('idle')`), or at teardown (`close`).
 *
 * Desk automation calls `whenOpen()` before it touches the desk and waits there while the member has it. A caller that
 * waits for the member to finish signing in calls `nextResume()`.
 * A driver call runs through `deskStep()`: a pause waits for the step in flight to finish before it exposes the desk.
 */
export class DeskPause {
  private pausing: Promise<void> | null = null
  private resuming: Promise<void> | null = null
  private isPaused = false
  private closed = false
  private pausedAt = 0
  private idleFailures = 0
  private vnc: Stopper | null = null
  private closeTabs: (() => Promise<void>) | null = null
  private timer: Stopper | null = null
  private open: (() => void)[] = []
  private next: ((reason: ResumeReason) => void)[] = []
  private busy = 0
  private drained: (() => void)[] = []
  private deskCloses = 0
  private reopening: Promise<void> | null = null
  private deskCloseStopper: Stopper | (() => void) | null = null

  constructor(
    private readonly deps: DeskPauseDeps,
    private readonly clock: DeskPauseClock = realClock
  ) {}

  /** True while the member has the desk. */
  get paused(): boolean {
    return this.isPaused
  }

  /**
   * Hands the desk over: starts the remote view, opens the sign-in pages and tells the server. Idempotent. A pause asked
   * for while the last one is still ending waits for that to finish, then starts a new one: it is never dropped.
   */
  pause(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('the desk pause is closed'))
    if (this.resuming !== null) return this.resuming.then(undefined, () => undefined).then(() => this.pause())
    this.pausing ??= this.doPause().catch((error: unknown) => {
      this.pausing = null
      // Desk actions that queued behind a pause that never began go on.
      this.release(null)
      throw error
    })
    return this.pausing
  }

  private async doPause(): Promise<void> {
    // The desk is exposed only once no desk step is in flight.
    while (this.busy > 0) await new Promise<void>((resolve) => this.drained.push(resolve))
    if (this.closed) return
    // The member can only reach the desk once the view runs; a failure after that stops it again.
    const vnc = await this.deps.startVnc()
    try {
      this.closeTabs = await this.deps.openTabs(SIGNIN_START_URLS)
    } catch (error) {
      await vnc.stop()
      throw error
    }
    if (this.closed) {
      // The run began to end while the view was starting.
      try {
        await this.closeTabs?.()
      } finally {
        this.closeTabs = null
        await vnc.stop()
      }
      return
    }
    this.vnc = vnc
    this.isPaused = true
    this.pausedAt = this.clock.now()
    this.idleFailures = 0
    this.deskCloses = 0
    this.deskCloseStopper = this.deps.onDeskClose?.(() => void this.deskClosed()) ?? null
    this.timer = this.clock.every(IDLE_CHECK_MS, () => void this.checkIdle())
    this.deps.emit({ signin: 'paused' })
  }

  // The idle time is the shorter of what X reports and the time since the pause began: X counts from the last input
  // at all, and the desk may have sat untouched for hours before the member arrived.
  private async checkIdle(): Promise<void> {
    if (!this.isPaused || this.resuming !== null) return
    let idle: number
    try {
      idle = Math.min(await this.deps.idleMs(), this.clock.now() - this.pausedAt)
      this.idleFailures = 0
    } catch (error) {
      // An idle time that cannot be read cannot show the member is there, but one miss may be a blip: two in a row take
      // the desk back.
      this.deps.report?.(error)
      this.idleFailures += 1
      if (this.idleFailures < MAX_IDLE_FAILURES) return
      idle = IDLE_CLOSE_MS
    }
    if (idle >= IDLE_CLOSE_MS) {
      await this.resume('idle').catch((error: unknown) => this.deps.report?.(error))
    }
  }

  /**
   * Takes the desk back: stops the view, restores the anchor tab, closes the tabs the pause opened, checkpoints the
   * profile, tells the server and releases the waiters. The waiters are released even when a step fails; the failure is
   * thrown after that.
   */
  resume(reason: ResumeReason): Promise<void> {
    if (this.resuming !== null) return this.resuming
    this.resuming = (async () => {
      await this.pausing?.catch(() => undefined)
      if (!this.isPaused) return
      const errors: unknown[] = []
      const attempt = async (step: () => Promise<void>): Promise<void> => {
        try {
          await step()
        } catch (error) {
          errors.push(error)
        }
      }
      await this.timer?.stop()
      this.timer = null
      const stopper = this.deskCloseStopper
      this.deskCloseStopper = null
      if (typeof stopper === 'function') stopper()
      else await stopper?.stop()
      // The view goes first: nothing else may stay reachable while the rest is slow.
      await attempt(async () => this.vnc?.stop())
      // The anchor first: the desk window must never be left without a tab.
      await attempt(() => this.deps.anchor())
      await attempt(async () => this.closeTabs?.())
      await attempt(() => this.deps.checkpoint())
      this.vnc = null
      this.closeTabs = null
      this.isPaused = false
      this.pausing = null
      this.deps.emit({ signin: 'resumed', reason })
      this.release(reason)
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) throw new AggregateError(errors, 'the desk pause did not end cleanly')
    })().finally(() => {
      this.resuming = null
    })
    return this.resuming
  }

  /** Resolves at once while the desk is not paused, else when the pause ends. */
  whenOpen(): Promise<void> {
    if (!this.isPaused && this.pausing === null) return Promise.resolve()
    return new Promise((resolve) => this.open.push(resolve))
  }

  /**
   * Runs one desk step (a form driver call). A step waits while a pause is starting or running; a pause waits for a step
   * already in flight.
   */
  async deskStep<T>(step: () => Promise<T>): Promise<T> {
    while (!this.closed && (this.isPaused || this.pausing !== null)) await this.whenOpen()
    this.busy += 1
    try {
      return await step()
    } finally {
      this.busy -= 1
      if (this.busy === 0) for (const resolve of this.drained.splice(0)) resolve()
    }
  }

  /** Resolves with the reason when the next pause ends, whether or not one is running now. */
  nextResume(): Promise<ResumeReason> {
    return new Promise((resolve) => this.next.push(resolve))
  }

  /**
   * The run is ending: stops the view and the idle timer and releases `whenOpen` waiters. It does not checkpoint (the
   * run's own final checkpoint follows) and leaves the tabs to the browser's close. `nextResume` waiters stay pending:
   * the run races them against its stop signal.
   */
  async close(): Promise<void> {
    this.closed = true
    await this.timer?.stop()
    this.timer = null
    const stopper = this.deskCloseStopper
    this.deskCloseStopper = null
    if (typeof stopper === 'function') stopper()
    else await stopper?.stop()
    const vnc = this.vnc
    this.vnc = null
    this.isPaused = false
    this.release(null)
    await vnc?.stop()
  }

  /**
   * Called when the desk page or window is closed while a pause is active. Reopens the desk with the existing anchor
   * (openDeskTab), at most 5 times per pause session; exceeding that ends the pause via its failure path.
   */
  async deskClosed(): Promise<void> {
    if (!this.isPaused || this.closed) return
    if (this.reopening !== null) return this.reopening
    this.deskCloses += 1
    if (this.deskCloses > 5) {
      this.deps.report?.(new Error('the desk window was closed more than 5 times'))
      await this.resume('idle').catch((error: unknown) => this.deps.report?.(error))
      return
    }
    this.reopening = (async () => {
      try {
        await this.deps.anchor()
        this.deps.emit({ desk: 'reopened', count: this.deskCloses })
      } catch (error) {
        this.deps.report?.(error)
        await this.resume('idle').catch((err: unknown) => this.deps.report?.(err))
      } finally {
        this.reopening = null
      }
    })()
    return this.reopening
  }

  private release(reason: ResumeReason | null): void {
    for (const resolve of this.open.splice(0)) resolve()
    if (reason !== null) for (const resolve of this.next.splice(0)) resolve(reason)
  }
}
