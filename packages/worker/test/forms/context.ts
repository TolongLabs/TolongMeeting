import type { Page } from '@playwright/test'
import type { FormProvider, FormSource, JobConfig, ResolvedForm, SenderRole } from '@tm/core'
import type { Ping } from '@tm/notify'
import { makeFormContextBase } from '../../src/forms/context'
import { driverFor } from '../../src/forms/drivers'
import { waitForTabSignin } from '../../src/forms/open'
import type { FormContext, MatchQuestion } from '../../src/forms/types'
import { googleUrl, microsoftUrl } from './route'

// A FormContext whose pings, events (every type, as `{ type, ...data }`) and model calls are recorded. The matcher maps "Programme of study" to `programme`.
export function testContext(
  desk: Page,
  job: JobConfig,
  opts: { signinTimeoutMs?: number } = {}
): {
  ctx: FormContext
  pings: { ping: Ping; at: number }[]
  events: Record<string, unknown>[]
  matchCalls: MatchQuestion[][]
  abort: AbortController
} {
  const pings: { ping: Ping; at: number }[] = []
  const events: Record<string, unknown>[] = []
  const matchCalls: MatchQuestion[][] = []
  const abort = new AbortController()
  const base = makeFormContextBase(job, desk, async (type, data) => {
    events.push({ type, ...data })
  })
  const ctx: FormContext = {
    ...base,
    previous: null,
    signal: abort.signal,
    ping: async (ping) => {
      pings.push({ ping, at: Date.now() })
    },
    matchLabels: async (questions) => {
      matchCalls.push(questions)
      return new Map(questions.filter((q) => q.label === 'Programme of study').map((q) => [q.id, 'programme']))
    },
    waitForSignin: async (tab, provider, signal) =>
      waitForTabSignin(tab, await driverFor(provider), signal, opts.signinTimeoutMs ?? 30_000)
  }
  return { ctx, pings, events, matchCalls, abort }
}

export function candidate(
  provider: FormProvider,
  fixture: string,
  source: FormSource,
  sender?: { name: string; role: SenderRole },
  seenAgoMs = 0
): ResolvedForm {
  const url = provider === 'google' ? googleUrl(fixture) : microsoftUrl(fixture)
  return {
    url,
    finalUrl: url,
    provider,
    source,
    sender: sender?.name ?? null,
    senderRole: sender?.role ?? null,
    seenAt: new Date(Date.now() - seenAgoMs).toISOString()
  }
}
