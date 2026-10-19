import type { JobConfig } from '@tm/core'
import { sendPing } from '@tm/notify'
import type { Page } from 'playwright'
import { driverFor } from './drivers'
import { matchWithModel } from './model-match'
import { waitForTabSignin } from './open'
import type { FormLinks } from './pings'
import { errorText } from './redact'
import type { FormContextBase } from './types'

// The parts of a FormContext that do not depend on one form. A failed ping is reported as an `error` event, never thrown:
// the form's record already holds the outcome.
export function makeFormContextBase(
  cfg: JobConfig,
  desk: Page,
  emitEvent: FormContextBase['emitEvent'],
  links: FormLinks = { meetingPage: null, signIn: null }
): FormContextBase {
  return {
    cfg,
    desk,
    links,
    emitEvent,
    async ping(p) {
      try {
        await sendPing(cfg.ntfy, p)
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
