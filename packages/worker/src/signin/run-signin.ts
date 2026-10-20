import type { AccountCheckData, SigninHeartbeat, SigninJob, SigninReply } from '@tm/core'
import { IDLE_CLOSE_MS, SIGNIN_START_URLS } from '../control/vnc'
import type { Stopper } from '../types'

const HEARTBEAT_MS = 5_000
/** This many heartbeats in a row that fail end the session: nobody can say "Done", and the container must not linger. */
const MAX_POST_FAILURES = 12
// The most each ending step may take, so that the whole ending fits in the 60 s that `docker stop` gives (50 s at most
// here: 8 + 10 + 10 + 20 + 4).
const BOUND = { stopVnc: 8_000, accounts: 10_000, close: 10_000, checkpoint: 20_000, finalPost: 4_000 }

export type SigninDeps = {
  /** Restores the profile, starts the screen and the browser. `close` closes the browser, then stops the screen. */
  openDesk(): Promise<{
    openTabs(urls: string[]): Promise<void>
    close(): Promise<void>
    /** What the open browser shows of the member's accounts. Called once, after the member finished. */
    checkAccounts?(): Promise<AccountCheckData[]>
  }>
  startVnc(): Promise<Stopper>
  idleMs(): Promise<number>
  checkpoint(): Promise<void>
  post(hb: SigninHeartbeat): Promise<SigninReply>
  clock: { every(ms: number, fn: () => void): Stopper }
  /** Aborted on SIGTERM or SIGINT: the session ends as `done`, inside the stop timeout. */
  signal?: AbortSignal
}

type Reason = NonNullable<SigninHeartbeat['reason']>

// Runs a step with a time limit. A step that overruns is abandoned, and the overrun is an error like any other.
async function within<T>(name: string, ms: number, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} did not finish within ${ms / 1000} s`)), ms)
  })
  try {
    return await Promise.race([fn(), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One sign-in session in its own container: opens the desk with the sign-in pages, starts the remote view and tells the
 * server every 5 s how long the member has been idle. It ends when the reply holds `stop` (or `resume_after_signin`):
 * `done`; after 15 minutes idle: `idle`; on a failure: `error`. Ending stops the view, checks the accounts, closes the
 * browser, checkpoints the profile (only when the browser closed, so the copy is never half-written), and posts
 * `ended: true`. A failure in any of that is thrown once everything else has run.
 */
export async function runSignin(job: SigninJob, deps: SigninDeps): Promise<void> {
  const { sessionId } = job
  const errors: unknown[] = []
  let desk: Awaited<ReturnType<SigninDeps['openDesk']>> | null = null
  let vnc: Stopper | null = null
  let idle = 0
  let reason: Reason = 'error'

  let due = false
  let wake: (() => void) | null = null
  const ticks = deps.clock.every(HEARTBEAT_MS, () => {
    due = true
    wake?.()
  })
  const aborted = new Promise<void>((resolve) => {
    if (deps.signal?.aborted) resolve()
    else deps.signal?.addEventListener('abort', () => resolve(), { once: true })
  })
  const nextTick = async (): Promise<void> => {
    if (!due) await Promise.race([new Promise<void>((resolve) => (wake = resolve)), aborted])
    due = false
    wake = null
  }

  try {
    desk = await deps.openDesk()
    await desk.openTabs(SIGNIN_START_URLS)
    vnc = await deps.startVnc()
    let failures = 0
    for (;;) {
      idle = await deps.idleMs()
      let reply: SigninReply | null = null
      try {
        reply = await deps.post({ sessionId, idleMs: idle, ended: false })
        failures = 0
      } catch (error) {
        failures += 1
        console.error(`signin: heartbeat not delivered (${error instanceof Error ? error.name : 'error'})`)
        if (failures >= MAX_POST_FAILURES) throw new Error(`the control server took none of ${failures} heartbeats`)
      }
      if (reply?.commands.some((c) => c === 'stop' || c === 'resume_after_signin')) {
        reason = 'done'
        break
      }
      if (idle >= IDLE_CLOSE_MS) {
        reason = 'idle'
        break
      }
      await nextTick()
      if (deps.signal?.aborted) {
        reason = 'done'
        break
      }
    }
  } catch (error) {
    errors.push(error)
  }

  await ticks.stop()
  // Each ending step has its own try: one that fails must not skip the next. True when the step finished.
  const attempt = async (name: string, ms: number, fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await within(name, ms, fn)
      return true
    } catch (error) {
      errors.push(error)
      return false
    }
  }
  if (vnc) await attempt('stop the remote view', BOUND.stopVnc, () => vnc!.stop())
  // The accounts are only worth checking when the member said they are done, and there is time.
  let accounts: AccountCheckData[] = []
  const open = desk
  if (open?.checkAccounts && reason !== 'error' && deps.signal?.aborted !== true) {
    await attempt('check the accounts', BOUND.accounts, async () => void (accounts = await open.checkAccounts!()))
  }
  // The profile is copied only once the browser has closed: an open profile could be copied half-written.
  if (open && (await attempt('close the browser', BOUND.close, () => open.close()))) {
    await attempt('checkpoint the profile', BOUND.checkpoint, () => deps.checkpoint())
  }
  const final: SigninHeartbeat = {
    sessionId,
    idleMs: idle,
    ended: true,
    reason,
    ...(accounts.length > 0 ? { accounts } : {})
  }
  await attempt('report the end', BOUND.finalPost, () => deps.post(final))
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'the sign-in session did not end cleanly')
}
