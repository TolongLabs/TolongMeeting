import { expect, test, type Page } from '@playwright/test'
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

test('fails with meeting_ended, and opens no new tab, when the meeting ends as sign-in completes', async ({
  context,
  page: desk
}) => {
  const fx = await routeFormFixtures(context)
  fx.signedOut.add('attendance')
  const { ctx, events, abort } = testContext(desk, testJob(test.info().outputPath('occ')))
  const opened: Page[] = []
  context.on('page', (p) => opened.push(p))
  const waitForSignin = ctx.waitForSignin
  ctx.waitForSignin = async (tab, provider, signal) => {
    const signedIn = await waitForSignin(tab, provider, signal)
    expect(signedIn).toBe(true)
    abort.abort() // the meeting ends in the same moment the member finishes signing in
    return signedIn
  }
  const running = handleForm(candidate('google', 'attendance', 'qr'), ctx)
  await expect.poll(() => stateOf(events)).toBe('awaiting_signin')
  fx.signedOut.delete('attendance')
  await context
    .pages()
    .find((p) => p.url().startsWith('https://accounts.google.com'))!
    .click('text=Continue')
  expect(await running).toMatchObject({ state: 'failed', reason: 'meeting_ended' })
  expect(opened).toHaveLength(1) // only the first form tab: the retry tab never opened
  expect(fx.submissions).toEqual([])
})

test('fails with meeting_ended, and submits nothing, when the meeting ends after the retry tab opened', async ({
  context,
  page: desk
}) => {
  const fx = await routeFormFixtures(context)
  fx.signedOut.add('attendance')
  const { ctx, events, matchCalls, abort } = testContext(desk, testJob(test.info().outputPath('occ')))
  const opened: Page[] = []
  context.on('page', (p) => opened.push(p))
  const matchLabels = ctx.matchLabels
  ctx.matchLabels = async (questions, keys) => {
    abort.abort() // the meeting ends while the retry tab is being read: the form is never filled or submitted
    return matchLabels(questions, keys)
  }
  const running = handleForm(candidate('google', 'attendance', 'qr'), ctx)
  await expect.poll(() => stateOf(events)).toBe('awaiting_signin')
  fx.signedOut.delete('attendance')
  await context
    .pages()
    .find((p) => p.url().startsWith('https://accounts.google.com'))!
    .click('text=Continue')
  expect(await running).toMatchObject({ state: 'failed', reason: 'meeting_ended', signinRetried: true })
  expect(matchCalls).toHaveLength(1) // the retry tab was open and reached the matcher
  expect(opened).toHaveLength(2)
  expect(fx.submissions).toEqual([])
})

test('gives the retry a fresh deadline: a form seen more than 2 minutes ago still submits', async ({
  context,
  page: desk
}) => {
  const fx = await routeFormFixtures(context)
  fx.signedOut.add('attendance')
  const { ctx, events } = testContext(desk, testJob(test.info().outputPath('occ')))
  const running = handleForm(candidate('google', 'attendance', 'qr', undefined, 121_000), ctx)
  await expect.poll(() => stateOf(events)).toBe('awaiting_signin')
  fx.signedOut.delete('attendance')
  await context
    .pages()
    .find((p) => p.url().startsWith('https://accounts.google.com'))!
    .click('text=Continue')
  expect(await running).toMatchObject({ state: 'submitted', signinRetried: true })
  expect(fx.submissions).toHaveLength(1)
})

test('runs the gates again on the retry tab, and submits nothing when it serves a quiz', async ({
  context,
  page: desk
}) => {
  const fx = await routeFormFixtures(context)
  fx.signedOut.add('quiz')
  const { ctx, events } = testContext(desk, testJob(test.info().outputPath('occ')))
  const running = handleForm(candidate('google', 'quiz', 'qr'), ctx)
  await expect.poll(() => stateOf(events)).toBe('awaiting_signin')
  fx.signedOut.delete('quiz')
  await context
    .pages()
    .find((p) => p.url().startsWith('https://accounts.google.com'))!
    .click('text=Continue')
  expect(await running).toMatchObject({ state: 'quiz', signinRetried: true })
  expect(fx.submissions).toEqual([])
})
