import { expect, test, type Page } from '@playwright/test'
import { isTerminalFormState, type FormCandidate, type FormRecord, type ResolvedForm } from '@tm/core'
import { startFormDispatcher } from '../src/forms/dispatcher'
import { makeFormContextBase } from '../src/forms/context'
import { onFormCandidate } from '../src/forms/intake'
import { formProviderOf } from '../src/forms/links'
import { loadFormRecords } from '../src/forms/store'
import { candidate } from './forms/context'
import { testJob } from './forms/job'
import { startModelStub } from './forms/model-stub'
import { routeFormFixtures } from './forms/route'

test.setTimeout(180_000)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const host = { name: 'Host', role: 'host' as const }
const participant = { name: 'Classmate', role: 'participant' as const }

// The resolver's own upper bound: it answers after 5 s, so every time below includes the full resolve.
const resolveAfter5s = async (c: FormCandidate): Promise<ResolvedForm | null> => {
  await sleep(5_000)
  const provider = formProviderOf(c.url)
  return provider === null ? null : { ...c, finalUrl: c.url, provider }
}

// Latencies of every form in this file, in ms from first sight to the submission or the first ping.
const latencies: { what: string; ms: number }[] = []
test.afterAll(() => {
  const sorted = latencies.map((l) => l.ms).sort((a, b) => a - b)
  if (sorted.length === 0) return
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!
  console.log(`speed: ${sorted.length} forms, p95 ${p95} ms, max ${sorted.at(-1)} ms (${JSON.stringify(latencies)})`)
})

// close() ends the meeting for the forms still running, so the run waits until every form has reached an end state.
async function untilSettled(dir: string, forms: number): Promise<void> {
  for (;;) {
    const { records } = await loadFormRecords(dir)
    if (records.length === forms && records.every((r) => isTerminalFormState(r.state))) return
    await sleep(100)
  }
}

async function run(desk: Page, dir: string, modelDelayMs: number, cands: ResolvedForm[]): Promise<FormRecord[]> {
  const model = await startModelStub({
    delayMs: modelDelayMs,
    reply: { matches: [{ question: 'p1q4', detail: 'programme', confidence: 'high' }] }
  })
  try {
    const job = testJob(dir, { ai: { baseUrl: model.url } })
    const d = await startFormDispatcher({ ...makeFormContextBase(job, desk, async () => {}), ping: async () => {} })
    const inFlight = new Set<string>()
    await Promise.all(
      cands.map((c) =>
        onFormCandidate(c, {
          cfg: job,
          resolve: resolveAfter5s,
          dispatcher: d,
          emitEvent: async () => {},
          ping: async () => {},
          inFlight,
          pinged: new Set<string>()
        })
      )
    )
    await untilSettled(dir, cands.length)
    return await d.close()
  } finally {
    await model.close()
  }
}

const since = (rec: FormRecord, at: string | null): number => Date.parse(at!) - Date.parse(rec.seenAt)

test('trusted forms are submitted within 2 minutes of first sight', async ({ context, page: desk }) => {
  await routeFormFixtures(context)
  const recs = await run(desk, test.info().outputPath('occ'), 0, [
    candidate('google', 'attendance', 'qr'),
    candidate('microsoft', 'attendance', 'meeting_chat', host)
  ])
  expect(recs.map((r) => r.state)).toEqual(['submitted', 'submitted'])
  for (const r of recs) {
    latencies.push({ what: `submitted ${r.provider}`, ms: since(r, r.submittedAt) })
    expect(since(r, r.submittedAt)).toBeLessThanOrEqual(120_000)
  }
})

test('fallback pings go out within 30 seconds of first sight, even with a slow model', async ({
  context,
  page: desk
}) => {
  await routeFormFixtures(context)
  const recs = await run(desk, test.info().outputPath('occ'), 10_000, [
    candidate('google', 'attendance-unmatched', 'qr'),
    candidate('google', 'quiz', 'qr'),
    candidate('microsoft', 'not-attendance', 'qr'),
    candidate('microsoft', 'external', 'meeting_chat', participant)
  ])
  expect(recs.map((r) => r.state).sort()).toEqual(['needs_member', 'not_attendance', 'quiz', 'untrusted'])
  for (const r of recs) {
    latencies.push({ what: `ping ${r.state}`, ms: since(r, r.pings[0]!.at) })
    expect(since(r, r.pings[0]!.at)).toBeLessThanOrEqual(30_000)
  }
})

test('a form page that never loads is pinged within 30 seconds', async ({ context, page: desk }) => {
  const fx = await routeFormFixtures(context)
  fx.delayMs.set('attendance', 60_000)
  const [r] = await run(desk, test.info().outputPath('occ'), 0, [candidate('google', 'attendance', 'qr')])
  expect(r).toMatchObject({ state: 'failed', reason: 'open_timeout' })
  latencies.push({ what: 'ping open_timeout', ms: since(r!, r!.pings[0]!.at) })
  expect(since(r!, r!.pings[0]!.at)).toBeLessThanOrEqual(30_000)
})
