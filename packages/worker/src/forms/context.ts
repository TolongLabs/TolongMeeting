import type { JobConfig } from '@tm/core'
import { sendPing, type Ping } from '@tm/notify'
import type { Page } from 'playwright'
import { driverFor } from './drivers'
import { matchWithModel } from './model-match'
import { waitForTabSignin } from './open'
import type { FormLinks } from './pings'
import { errorText } from './redact'
import type { FormContextBase } from './types'

// The parts of a FormContext that do not depend on one form. A failed ping is reported as an `error` event, never thrown:
// the form's record already holds the outcome. `send` is how a ping goes out (default: ntfy from the job's config).
export function makeFormContextBase(
  cfg: JobConfig,
  desk: Page,
  emitEvent: FormContextBase['emitEvent'],
  links: FormLinks = { meetingPage: null, signIn: null },
  send: (p: Ping) => Promise<void> = (p) => sendPing(cfg.ntfy, p)
): FormContextBase {
  return {
    cfg,
    desk,
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
    waitForSignin: async (tab, provider, signal) => waitForTabSignin(tab, await driverFor(provider), signal)
  }
}
