import type { FormProvider, JobConfig } from '@tm/core'
import { sendPing, type Ping } from '@tm/notify'
import type { Page } from 'playwright'
import { driverFor } from './drivers'
import { matchWithModel } from './model-match'
import type { DeskPause } from '../control/desk-pause'
import { SIGNIN_WAIT_MS, waitForTabSignin } from './open'
import type { FormLinks } from './pings'
import { errorText } from './redact'
import type { FormContextBase } from './types'

// Waits for the end of the sign-in pause (the member pressing Done, or leaving the desk for 15 minutes), the signal, or
// the sign-in time limit. True when the member finished; after an idle end the tab is read once, since they may have
// got through before they left.
async function waitForResume(
  pause: DeskPause,
  tab: Page,
  provider: FormProvider,
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted) return false
  const timeout = AbortSignal.timeout(SIGNIN_WAIT_MS)
  const reason = await new Promise<'command' | 'idle' | null>((resolve) => {
    const stop = () => resolve(null)
    signal.addEventListener('abort', stop, { once: true })
    timeout.addEventListener('abort', stop, { once: true })
    void pause.nextResume().then(resolve)
  })
  if (reason === null) return false
  if (reason === 'command') return true
  return waitForTabSignin(tab, await driverFor(provider), signal, 0)
}

// The parts of a FormContext that do not depend on one form. A failed ping is reported as an `error` event, never thrown:
// the form's record already holds the outcome. `send` is how a ping goes out (default: ntfy from the job's config).
// `pause` is the desk pause of a run with a control channel: desk work waits for it, and so does the sign-in wait.
// `desk` can be a function: the desk page is replaced when the member closes it, and each form then reads the current one.
export function makeFormContextBase(
  cfg: JobConfig,
  desk: Page | (() => Page),
  emitEvent: FormContextBase['emitEvent'],
  links: FormLinks = { meetingPage: null, signIn: null },
  send: (p: Ping) => Promise<void> = (p) => sendPing(cfg.ntfy, p),
  pause: DeskPause | null = null
): FormContextBase {
  return {
    cfg,
    get desk() {
      return typeof desk === 'function' ? desk() : desk
    },
    links,
    emitEvent,
    async ping(p) {
      try {
        await send(p)
      } catch (error) {
        await emitEvent('error', {
          where: 'form_ping',
          message: errorText(cfg, error)
        })
      }
    },
    matchLabels: (questions, detailKeys) => matchWithModel(cfg.ai, questions, detailKeys),
    waitForSignin: async (tab, provider, signal) =>
      pause === null
        ? waitForTabSignin(tab, await driverFor(provider), signal)
        : waitForResume(pause, tab, provider, signal),
    ...(pause === null ? {} : { deskOpen: () => pause.whenOpen() })
  }
}
