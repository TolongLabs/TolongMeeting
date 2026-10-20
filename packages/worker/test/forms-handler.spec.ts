import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { formIdFor, type FormProvider } from '@tm/core'
import { driverFor, FormStepError, type FormDriver } from '../src/forms/drivers'
import { loadFormRecords } from '../src/forms/store'
import { handleForm } from '../src/forms/handler'
import { candidate, testContext } from './forms/context'
import { testJob } from './forms/job'
import { googleUrl, routeFormFixtures, type FixtureServer } from './forms/route'

let fx: FixtureServer
let dir: string
test.beforeEach(async ({ context }) => {
  fx = await routeFormFixtures(context)
  dir = test.info().outputPath('occ')
})
const participant = { name: 'Classmate', role: 'participant' as const }

test('submits a two-page Google form shown as a QR code', async ({ page: desk, context }) => {
  const { ctx, pings, events } = testContext(desk, testJob(dir))
  const rec = await handleForm(candidate('google', 'attendance', 'qr'), ctx)
  expect([rec.state, rec.trustReason]).toEqual(['submitted', 'qr_on_screen'])
  expect(rec.history.map((h) => h.state)).toEqual([
    'detected',
    'resolving',
    'checking_trust',
    'opening',
    'inspecting',
    'filling',
    'inspecting',
    'filling',
    'submitting',
    'submitted'
  ])
  expect(rec.fieldsFilled.map((f) => f.detailKey)).toEqual([
    'full_name',
    'student_id',
    'course_code',
    'section',
    'programme',
    null,
    null
  ])
  expect(fx.submissions).toEqual([
    {
      fixture: 'attendance',
      sendCopy: false,
      answers: {
        'Full name': 'Test Student',
        'Matric No.': 'A00000000',
        'Course code': 'ABC1234',
        Section: '02',
        'Programme of study': 'MSc Example',
        Attendance: 'Present',
        'Attendance declaration': ['I confirm I am attending this class']
      }
    }
  ])
  expect(rec.screenshots).toEqual(
    ['filled_1.png', 'filled.png', 'confirmation.png'].map((n) => `forms/${rec.formId}/${n}`)
  )
  for (const s of rec.screenshots) expect(readFileSync(join(dir, s)).subarray(1, 4).toString()).toBe('PNG')
  expect(pings.map((p) => [p.ping.title, p.ping.priority, p.ping.attachPath])).toEqual([
    ['Attendance submitted', 'high', undefined]
  ])
  expect(rec.pings.map((p) => p.state)).toEqual(['submitted'])
  expect(JSON.stringify(events)).not.toContain('Test Student')
  expect((await loadFormRecords(dir)).records).toEqual([rec]) // what is on disk is what was returned
  expect(context.pages()).toHaveLength(1) // the form tab was closed
})

test('submits a Microsoft form the host posted in the meeting chat', async ({ page: desk }) => {
  const rec = await handleForm(
    candidate('microsoft', 'attendance', 'meeting_chat', { name: 'Host', role: 'host' }),
    testContext(desk, testJob(dir)).ctx
  )
  expect([rec.state, rec.trustReason]).toEqual(['submitted', 'host'])
  expect(fx.submissions).toHaveLength(1)
})

test("trusts a participant's form only when the provider shows it is limited to the member's organisation", async ({
  page: desk
}) => {
  const google = await handleForm(
    candidate('google', 'attendance', 'meeting_chat', participant),
    testContext(desk, testJob(dir)).ctx
  )
  expect([google.state, google.trustReason]).toEqual(['submitted', 'org_restricted'])
  fx.submissions.length = 0
  // Microsoft org trust is off: its notice is generic, so a participant's Microsoft form is never org-restricted.
  const microsoft = testContext(desk, testJob(dir))
  const ms = await handleForm(candidate('microsoft', 'attendance', 'meeting_chat', participant), microsoft.ctx)
  expect([ms.state, ms.reason, fx.submissions.length]).toEqual(['untrusted', 'not_org_restricted', 0])
  const { ctx, pings } = testContext(desk, testJob(dir))
  const rec = await handleForm(candidate('google', 'external', 'meeting_chat', participant), ctx)
  expect([rec.state, rec.reason, fx.submissions.length]).toEqual(['untrusted', 'not_org_restricted', 0])
  expect([pings[0].ping.title, pings[0].ping.priority]).toEqual(['Form seen, not submitted', 'high'])
})

test('does not open a participant form when no organisation is configured', async ({ page: desk, context }) => {
  const rec = await handleForm(
    candidate('google', 'attendance', 'meeting_chat', participant),
    testContext(desk, testJob(dir, { organisation: null })).ctx
  )
  expect([rec.state, rec.reason, fx.requests.length]).toEqual(['untrusted', 'untrusted_source', 0])
  expect(context.pages()).toHaveLength(1)
})

test('refuses a form with an unmatched required question', async ({ page: desk }) => {
  const { ctx, pings } = testContext(desk, testJob(dir))
  const rec = await handleForm(candidate('google', 'attendance-unmatched', 'qr'), ctx)
  expect([rec.state, rec.unmatched, fx.submissions.length]).toEqual(['needs_member', ['What did you learn today?'], 0])
  expect(pings[0].ping.message).toContain('"What did you learn today?"')
})

test('refuses quiz and non-attendance forms at normal priority', async ({ page: desk }) => {
  for (const [fixture, state] of [
    ['quiz', 'quiz'],
    ['not-attendance', 'not_attendance']
  ] as const) {
    const { ctx, pings } = testContext(desk, testJob(dir))
    expect((await handleForm(candidate('microsoft', fixture, 'qr'), ctx)).state).toBe(state)
    expect(pings[0].ping.priority).toBe('default')
  }
  expect(fx.submissions).toHaveLength(0)
})

test('records already answered on opening and after Submit', async ({ page: desk }) => {
  expect(
    (await handleForm(candidate('google', 'already-responded', 'qr'), testContext(desk, testJob(dir)).ctx)).state
  ).toBe('already_answered')
  fx.submitResult.set('attendance', 'already-responded')
  const rec = await handleForm(candidate('microsoft', 'attendance', 'qr'), testContext(desk, testJob(dir)).ctx)
  expect(rec.history.slice(-2).map((h) => h.state)).toEqual(['submitting', 'already_answered'])
})

test('opens a prefilled link at its canonical URL', async ({ page: desk }) => {
  const f = {
    ...candidate('google', 'attendance', 'qr'),
    finalUrl: `${googleUrl('attendance')}?usp=pp_url&entry.111=Absent`
  }
  expect((await handleForm(f, testContext(desk, testJob(dir)).ctx)).state).toBe('submitted')
  expect(fx.requests.some((u) => u.includes('entry.'))).toBe(false)
  expect(fx.submissions[0].answers.Attendance).toBe('Present')
})

test('fails closed and CAPTCHA pages with a high-priority ping', async ({ page: desk, context }) => {
  for (const [fixture, reason] of [
    ['closed', 'form_closed'],
    ['captcha', 'captcha']
  ] as const) {
    const { ctx, pings } = testContext(desk, testJob(dir))
    expect(await handleForm(candidate('google', fixture, 'qr'), ctx)).toMatchObject({ state: 'failed', reason })
    expect([pings[0].ping.title, pings[0].ping.priority]).toEqual(['Form needs you', 'high'])
    expect(context.pages()).toHaveLength(1)
  }
})

test('never passes the form description to the matcher', async ({ page: desk }) => {
  const { ctx, matchCalls } = testContext(desk, testJob(dir))
  await handleForm(candidate('google', 'attendance', 'qr'), ctx)
  expect(JSON.stringify(matchCalls)).not.toContain('Fill in during the lecture')
  expect(matchCalls.flat().map((q) => q.label)).toEqual(['Programme of study', 'Any comments?'])
})

test('stops at the 2-minute deadline', async ({ page: desk }) => {
  const rec = await handleForm(
    candidate('google', 'attendance', 'qr', undefined, 121_000),
    testContext(desk, testJob(dir)).ctx
  )
  expect(rec).toMatchObject({ state: 'failed', reason: 'deadline' })
  expect(fx.submissions).toHaveLength(0)
})

test('records the form as submitting on disk before Submit is clicked', async ({ page: desk, context }) => {
  let onDisk: string | undefined
  await context.route('https://docs.google.com/forms/d/e/*/formResponse', async (route) => {
    onDisk = (await loadFormRecords(dir)).records[0]?.state
    await route.fallback()
  })
  await handleForm(candidate('google', 'attendance', 'qr'), testContext(desk, testJob(dir)).ctx)
  expect(onDisk).toBe('submitting')
})

test('fails with meeting_ended, and submits nothing, when the meeting ends after submitting is recorded', async ({
  page: desk
}) => {
  const { ctx, abort } = testContext(desk, testJob(dir))
  const emitEvent = ctx.emitEvent
  ctx.emitEvent = async (type, data) => {
    await emitEvent(type, data)
    if (data.state === 'submitting') abort.abort() // the meeting ends just before the click
  }
  const rec = await handleForm(candidate('google', 'attendance', 'qr'), ctx)
  expect(rec).toMatchObject({ state: 'failed', reason: 'meeting_ended' })
  expect(fx.submissions).toEqual([])
})

test('treats a Submit that never confirms as maybe-submitted: one submission, a ping, no retry', async ({
  page: desk,
  context
}) => {
  fx.submitResult.set('attendance', 'still-form')
  const { ctx, pings } = testContext(desk, testJob(dir))
  const rec = await handleForm(candidate('google', 'attendance', 'qr'), ctx)
  expect(rec).toMatchObject({ state: 'failed', reason: 'submit_unconfirmed' })
  expect(rec.history.slice(-2).map((h) => h.state)).toEqual(['submitting', 'failed'])
  expect(fx.submissions).toHaveLength(1)
  expect([pings[0].ping.title, pings[0].ping.priority]).toEqual(['Form needs you', 'high'])
  expect(pings[0].ping.message).toContain("couldn't confirm it went through")
  expect(context.pages()).toHaveLength(1)
})

test('closes the tab when the form does not load in time', async ({ page: desk, context }) => {
  test.setTimeout(60_000)
  fx.delayMs.set('attendance', 20_000)
  const { ctx, pings } = testContext(desk, testJob(dir))
  const rec = await handleForm(candidate('google', 'attendance', 'qr'), ctx)
  expect(rec).toMatchObject({ state: 'failed', reason: 'open_timeout' })
  expect(pings[0].ping.priority).toBe('high')
  expect(context.pages()).toHaveLength(1)
})

// Runs `fn` with some of the provider's real driver methods replaced (the driver is cached per provider, so every
// handler run sees the change); the originals come back afterwards.
async function withDriver(
  provider: FormProvider,
  patch: (real: FormDriver) => Partial<FormDriver>,
  fn: () => Promise<void>
): Promise<void> {
  const driver = await driverFor(provider)
  const original = { ...driver }
  Object.assign(driver, patch(original))
  try {
    await fn()
  } finally {
    Object.assign(driver, original)
  }
}

const SECRETS = ['Test Student', 'A00000000', 'ABC1234', 'Dr Example'] // typed values and a formDetails value

test('keeps member values out of every event, alert and error', async ({ page: desk }) => {
  const message = `Timeout 1000ms exceeded typing Test Student, ABC1234 and a00000000.\nCall log:\n  - fill("MSc Example")`
  for (const make of [
    () => new Error(message),
    () => new FormStepError('dropdown_failed', message),
    () => new Error(`${message}\nCall log:`)
  ]) {
    const { ctx, events } = testContext(desk, testJob(dir))
    await withDriver(
      'google',
      () => ({
        fill: async () => {
          throw make()
        }
      }),
      async () => {
        const rec = await handleForm(candidate('google', 'attendance', 'qr'), ctx)
        expect(rec.state).toBe('failed')
      }
    )
    const errors = events.filter((e) => e.type === 'error')
    expect(errors.length).toBeGreaterThan(0)
    const text = JSON.stringify(events)
    for (const value of [...SECRETS, 'MSc Example', 'Call log'])
      expect(text.toLowerCase()).not.toContain(value.toLowerCase())
    expect(text).toContain('[value]')
  }
})

test('says why a driver step failed, with the message redacted', async ({ page: desk }) => {
  const { ctx, events } = testContext(desk, testJob(dir))
  await withDriver(
    'google',
    () => ({
      next: async () => {
        throw new FormStepError('next_failed', 'Next refused Test Student')
      }
    }),
    async () => {
      const rec = await handleForm(candidate('google', 'attendance', 'qr'), ctx)
      expect(rec).toMatchObject({ state: 'failed', reason: 'next_failed' })
    }
  )
  expect(events.filter((e) => e.type === 'error')).toEqual([
    {
      type: 'error',
      where: 'form_step',
      formId: expect.any(String),
      code: 'next_failed',
      message: 'Next refused [value]'
    }
  ])
})

test('refuses a form whose second page is a quiz, and submits nothing', async ({ page: desk, context }) => {
  const { ctx, pings } = testContext(desk, testJob(dir))
  const rec = await handleForm(candidate('google', 'attendance-quiz-p2', 'qr'), ctx)
  expect(rec.state).toBe('quiz')
  expect(fx.submissions).toHaveLength(0)
  expect(pings.map((p) => p.ping.priority)).toEqual(['default'])
  expect(context.pages()).toHaveLength(1)
})

test('refuses a form whose second page has an unmatched required question, and pings the member', async ({
  page: desk
}) => {
  const { ctx, pings } = testContext(desk, testJob(dir))
  const rec = await handleForm(candidate('google', 'attendance-unmatched-p2', 'qr'), ctx)
  expect([rec.state, rec.unmatched]).toEqual(['needs_member', ['What did you learn today?']])
  expect(fx.submissions).toHaveLength(0)
  expect(pings.map((p) => p.ping.title)).toEqual(['Form needs you'])
})

test('stops at the page limit', async ({ page: desk }) => {
  test.setTimeout(180_000)
  const { ctx, pings } = testContext(desk, testJob(dir))
  const rec = await handleForm(candidate('google', 'attendance-endless', 'qr'), ctx)
  expect(rec).toMatchObject({ state: 'failed', reason: 'unknown_page' })
  expect(rec.screenshots).toHaveLength(30)
  expect(fx.submissions).toHaveLength(0)
  expect(pings).toHaveLength(1)
})

test('treats an unexpected exception after Submit as maybe-submitted, with no retry', async ({ page: desk }) => {
  const { ctx, pings, events } = testContext(desk, testJob(dir))
  await withDriver(
    'google',
    (real) => ({
      submit: async (tab) => {
        await real.submit(tab)
        throw new Error('the connection to Test Student dropped')
      }
    }),
    async () => {
      const rec = await handleForm(candidate('google', 'attendance', 'qr'), ctx)
      expect(rec).toMatchObject({ state: 'failed', reason: 'submit_unconfirmed' })
    }
  )
  expect(fx.submissions).toHaveLength(1)
  expect(pings.map((p) => p.ping.message)).toEqual([expect.stringContaining("couldn't confirm it went through")])
  expect(JSON.stringify(events)).not.toContain('Test Student')
})

test('a failure to save before the Submit click is not maybe-submitted', async ({ page: desk }) => {
  const { ctx, pings } = testContext(desk, testJob(dir))
  const url = googleUrl('attendance')
  const matchLabels = ctx.matchLabels
  ctx.matchLabels = async (questions, keys) => {
    // On the last page, make the next save of the record fail.
    if (questions.some((q) => q.label === 'Any comments?'))
      mkdirSync(join(dir, 'forms', formIdFor(url), 'record.json.tmp'))
    return matchLabels(questions, keys)
  }
  const rec = await handleForm(candidate('google', 'attendance', 'qr'), ctx)
  expect(rec).toMatchObject({ state: 'failed', reason: 'unexpected_error' })
  expect(rec.history.map((h) => h.state)).not.toContain('submitting')
  expect(fx.submissions).toHaveLength(0)
  expect(pings).toHaveLength(1)
})

test('sends the ping even when the event sink fails', async ({ page: desk }) => {
  const { ctx, pings } = testContext(desk, testJob(dir))
  ctx.emitEvent = async () => {
    throw new Error('the event sink is down')
  }
  const rec = await handleForm(candidate('google', 'attendance', 'qr'), ctx)
  expect(rec.state).toBe('submitted')
  expect(pings.map((p) => p.ping.title)).toEqual(['Attendance submitted'])
  expect(rec.pings.map((p) => p.state)).toEqual(['submitted'])
})

test('sends the terminal ping again when the first attempt threw', async ({ page: desk }) => {
  const { ctx, pings } = testContext(desk, testJob(dir))
  const record = ctx.ping
  let calls = 0
  ctx.ping = async (ping) => {
    if (++calls === 1) throw new Error('ntfy is down')
    await record(ping)
  }
  const rec = await handleForm(candidate('google', 'closed', 'qr'), ctx)
  expect([rec.state, calls, pings.length]).toEqual(['failed', 2, 1])
  expect(rec.pings.map((p) => p.state)).toEqual(['failed'])
  expect((await loadFormRecords(dir)).records).toEqual([rec])
})

test('never throws, and never submits again, for a record it cannot continue', async ({ page: desk }) => {
  const first = await handleForm(candidate('google', 'attendance', 'qr'), testContext(desk, testJob(dir)).ctx)
  expect(first.state).toBe('submitted')
  const { ctx, pings, events } = testContext(desk, testJob(dir))
  const again = await handleForm(candidate('google', 'attendance', 'qr'), { ...ctx, previous: first })
  expect(again).toEqual(first)
  expect(fx.submissions).toHaveLength(1)
  expect(pings).toHaveLength(0)
  expect(events.filter((e) => e.type === 'error')).toHaveLength(1)
})

test('fails loudly when seenAt is unreadable instead of dropping the deadline', async ({ page: desk }) => {
  const { ctx, events } = testContext(desk, testJob(dir))
  const rec = await handleForm({ ...candidate('google', 'attendance', 'qr'), seenAt: 'not a time' }, ctx)
  expect(rec).toMatchObject({ state: 'failed', reason: 'unexpected_error' })
  expect(fx.requests).toHaveLength(0)
  expect(JSON.stringify(events.filter((e) => e.type === 'error'))).toContain('seenAt')
})
