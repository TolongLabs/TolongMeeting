import { expect, test } from '@playwright/test'
import { newFormRecord } from '@tm/core'
import { handleForm } from '../src/forms/handler'
import { candidate, testContext } from './forms/context'
import { testJob } from './forms/job'
import { routeFormFixtures } from './forms/route'

const stateOf = (events: Record<string, unknown>[]) => events.at(-1)?.state

test('pings "Sign in again", then retries once after the member signs in and submits', async ({
  context,
  page: desk
}) => {
  const fx = await routeFormFixtures(context)
  fx.signedOut.add('attendance')
  const { ctx, pings, events } = testContext(desk, testJob(test.info().outputPath('occ')))
  const f = candidate('google', 'attendance', 'qr')
  const running = handleForm(f, ctx)
  await expect.poll(() => stateOf(events)).toBe('awaiting_signin')
  expect(pings[0]!.ping).toMatchObject({
    title: 'Sign in again',
    priority: 'high',
    actions: [{ label: 'Sign in again', url: f.finalUrl }]
  })
  expect(pings[0]!.at - Date.parse(f.seenAt)).toBeLessThanOrEqual(30_000)
  const tab = context.pages().find((p) => p.url().startsWith('https://accounts.google.com'))!
  expect([await tab.inputValue('input[type=email]'), fx.submissions.length]).toEqual(['', 0])
  fx.signedOut.delete('attendance')
  await tab.click('text=Continue')
  const rec = await running
  expect([rec.state, rec.signinRetried]).toEqual(['submitted', true])
  expect(rec.history.map((h) => h.state)).toContain('awaiting_signin')
  expect(pings.map((p) => p.ping.title)).toEqual(['Sign in again', 'Attendance submitted'])
  expect(fx.submissions).toHaveLength(1)
  expect(context.pages()).toHaveLength(1) // the sign-in tab and the retry tab are both closed
})

test('fails when sign-in is asked for again after the retry', async ({ context, page: desk }) => {
  const fx = await routeFormFixtures(context)
  fx.signedOut.add('attendance')
  const { ctx, events } = testContext(desk, testJob(test.info().outputPath('occ')))
  const running = handleForm(candidate('google', 'attendance', 'qr'), ctx)
  await expect.poll(() => stateOf(events)).toBe('awaiting_signin')
  fx.signedOut.delete('attendance')
  fx.onFormLoad = (name) => fx.signedOut.add(name) // the session drops again right after the member's sign-in
  await context
    .pages()
    .find((p) => p.url().startsWith('https://accounts.google.com'))!
    .click('text=Continue')
  expect(await running).toMatchObject({
    state: 'failed',
    reason: 'signin_required_again'
  })
  expect(fx.submissions).toEqual([])
})

test('fails with meeting_ended when the dispatcher closes during the wait', async ({ context, page: desk }) => {
  const fx = await routeFormFixtures(context)
  fx.signedOut.add('attendance')
  const { ctx, events, abort } = testContext(desk, testJob(test.info().outputPath('occ')))
  const running = handleForm(candidate('microsoft', 'attendance', 'qr'), ctx)
  await expect.poll(() => stateOf(events)).toBe('awaiting_signin')
  abort.abort()
  expect(await running).toMatchObject({
    state: 'failed',
    reason: 'meeting_ended'
  })
})

test('fails with signin_not_completed when the wait times out', async ({ context, page: desk }) => {
  const fx = await routeFormFixtures(context)
  fx.signedOut.add('attendance')
  const { ctx } = testContext(desk, testJob(test.info().outputPath('occ')), {
    signinTimeoutMs: 1_000
  })
  expect(await handleForm(candidate('google', 'attendance', 'qr'), ctx)).toMatchObject({
    state: 'failed',
    reason: 'signin_not_completed'
  })
})

test('never retries a form that was already retried', async ({ context, page: desk }) => {
  const fx = await routeFormFixtures(context)
  fx.signedOut.add('attendance')
  const { ctx, pings } = testContext(desk, testJob(test.info().outputPath('occ')))
  const f = candidate('google', 'attendance', 'qr')
  const first = newFormRecord(f, ctx.cfg.occurrenceId)
  ctx.previous = {
    ...first,
    state: 'untrusted',
    signinRetried: true,
    history: [...first.history, { state: 'untrusted', at: new Date().toISOString() }]
  }
  expect(await handleForm(f, ctx)).toMatchObject({ state: 'failed', reason: 'signin_required_again' })
  expect(pings.map((p) => p.ping.title)).not.toContain('Sign in again')
})

test('never retries a form whose Submit was clicked', async ({ context, page: desk }) => {
  const fx = await routeFormFixtures(context)
  fx.signedOut.add('attendance')
  const { ctx, pings } = testContext(desk, testJob(test.info().outputPath('occ')))
  const f = candidate('google', 'attendance', 'qr')
  const first = newFormRecord(f, ctx.cfg.occurrenceId)
  const at = new Date().toISOString()
  ctx.previous = {
    ...first,
    state: 'untrusted',
    history: [...first.history, { state: 'submitting', at }, { state: 'untrusted', at }]
  }
  const rec = await handleForm(f, ctx)
  expect([rec.state, rec.signinRetried]).toEqual(['failed', false])
  expect(pings.map((p) => p.ping.title)).not.toContain('Sign in again')
  expect(context.pages()).toHaveLength(1)
})
