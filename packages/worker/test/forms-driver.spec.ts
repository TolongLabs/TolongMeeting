import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { canonicalFormUrl } from '@tm/core'
import { orgRestricted } from '../src/forms/rules'
import { createDriver, driverFor, loadFormSelectors, type FormDriver } from '../src/forms/drivers'
import type { Answer } from '../src/forms/types'
import { googleUrl, microsoftUrl, routeFormFixtures, type FixtureServer } from './forms/route'

const text = (questionId: string, value: string): Answer => ({
  questionId,
  kind: 'text',
  value,
  detailKey: 'x',
  via: 'label'
})
const choose = (questionId: string, option: string): Answer => ({
  questionId,
  kind: 'choose',
  option,
  detailKey: null,
  via: 'label'
})
const ORG = { name: 'Example University', emailDomain: 'example.edu.my' }
const CASES = [
  {
    provider: 'google' as const,
    url: googleUrl,
    signin: /accounts\.google\.com/,
    // What the external fixture's description copies from the provider's own elements.
    copied: ['This form was created inside of Example University.', 'student@example.edu.my'],
    org: {
      organisation: 'Example University',
      signedInAs: 'student@example.edu.my',
      orgOnly: false
    },
    assets: [] as string[]
  },
  {
    provider: 'microsoft' as const,
    url: microsoftUrl,
    signin: /login\.microsoftonline\.com/,
    copied: [
      'Hi, Test Student. When you submit this form, the owner will see your name and email address.',
      'student@example.edu.my'
    ],
    // Microsoft org trust is off (no org-specific signal yet): a signed-in account is necessary, never sufficient.
    org: { organisation: null, signedInAs: 'student@example.edu.my', orgOnly: false },
    assets: ['https://forms.office.com/Pages/fixture.js']
  }
]

for (const c of CASES)
  test.describe(c.provider, () => {
    let fx: FixtureServer
    let driver: FormDriver
    test.beforeEach(async ({ context }) => {
      fx = await routeFormFixtures(context)
      driver = await driverFor(c.provider)
    })

    test('reads label, type, options and required for each widget', async ({ page }) => {
      await page.goto(c.url('widgets'))
      const p = await driver.readPage(page, 1)
      expect(p.questions.map((q) => [q.id, q.label, q.type, q.required])).toEqual([
        ['p1q0', 'Short answer', 'text', true],
        ['p1q1', 'Long answer', 'paragraph', false],
        ['p1q2', 'Pick one', 'radio', true],
        ['p1q3', 'Pick some', 'checkbox', false],
        ['p1q4', 'Choose a section', 'dropdown', true],
        ['p1q5', 'Date', 'other', false]
      ])
      expect([p.questions[2]!.options, p.questions[4]!.options, p.questions[4]!.value]).toEqual([
        ['Present', 'Absent'],
        ['01', '02', '03'],
        null
      ])
      expect([p.sendCopy, p.quiz, p.hasNext, p.hasSubmit]).toEqual([false, false, false, true])
    })

    test('fills every widget and unticks send-a-copy', async ({ page }) => {
      await page.goto(c.url('widgets') + '#copy-on')
      const before = await driver.readPage(page, 1)
      expect(before.sendCopy).toBe(true)
      await driver.fill(page, before, [
        text('p1q0', 'abc'),
        { questionId: 'p1q2', kind: 'choose', option: 'Present', detailKey: null, via: 'confirmation' },
        { questionId: 'p1q3', kind: 'choose', option: 'Tutorial', detailKey: 'y', via: 'label' },
        { questionId: 'p1q4', kind: 'choose', option: '02', detailKey: 'section', via: 'label' }
      ])
      const after = await driver.readPage(page, 1)
      expect(after.questions.map((q) => q.value)).toEqual(['abc', null, 'Present', ['Tutorial'], '02', null])
      expect(after.sendCopy).toBe(false)
    })

    test('moves through Next and submits', async ({ page }) => {
      await page.goto(c.url('attendance'))
      const p1 = await driver.readPage(page, 1)
      expect([p1.hasNext, p1.hasSubmit]).toEqual([true, false])
      await driver.fill(page, p1, [
        text('p1q0', 'Test Student'),
        text('p1q1', 'A00000000'),
        text('p1q2', 'ABC1234'),
        choose('p1q3', '02')
      ])
      await driver.next(page)
      const p2 = await driver.readPage(page, 2)
      expect(p2.questions.map((q) => `${q.id} ${q.label}`)).toEqual([
        'p2q0 Attendance',
        'p2q1 Attendance declaration',
        'p2q2 Any comments?'
      ])
      await driver.fill(page, p2, [choose('p2q0', 'Present'), choose('p2q1', 'I confirm I am attending this class')])
      await driver.submit(page)
      expect(await driver.pageKind(page)).toBe('confirmation')
      expect(fx.submissions[0]).toEqual({
        fixture: 'attendance',
        sendCopy: false,
        answers: {
          'Full name': 'Test Student',
          'Matric No.': 'A00000000',
          'Course code': 'ABC1234',
          Section: '02',
          Attendance: 'Present',
          'Attendance declaration': ['I confirm I am attending this class']
        }
      })
    })

    test('a submit that finds the form already answered ends on that page', async ({ page }) => {
      fx.submitResult.set('quiz', 'already-responded')
      await page.goto(c.url('quiz'))
      const p = await driver.readPage(page, 1)
      await driver.fill(page, p, [choose('p1q1', 'Week 5'), choose('p1q2', 'Yes')])
      await driver.submit(page)
      expect(await driver.pageKind(page)).toBe('already_answered')
    })

    test('Next with an empty required question fails with next_failed', async ({ page }) => {
      await page.goto(c.url('attendance'))
      await expect(driver.next(page)).rejects.toMatchObject({ code: 'next_failed' })
    })

    test('Submit with an empty required question fails with submit_failed and posts nothing', async ({ page }) => {
      await page.goto(c.url('widgets'))
      await expect(driver.submit(page)).rejects.toMatchObject({ code: 'submit_failed' })
      expect(fx.submissions).toHaveLength(0)
    })

    test('a required free-text question is read as required text and takes a typed answer', async ({ page }) => {
      await page.goto(c.url('attendance-unmatched'))
      const p = await driver.readPage(page, 1)
      const last = p.questions.at(-1)!
      expect([last.id, last.label, last.type, last.required]).toEqual([
        'p1q5',
        'What did you learn today?',
        'paragraph',
        true
      ])
      await driver.fill(page, p, [text('p1q5', 'Recursion')])
      expect((await driver.readPage(page, 1)).questions.at(-1)!.value).toBe('Recursion')
    })

    test('fills only the planned answers', async ({ page }) => {
      await page.goto(c.url('widgets') + '#copy-on')
      const form = await driver.readPage(page, 1)
      await driver.fill(page, form, [text('p1q0', 'abc')])
      const after = await driver.readPage(page, 1)
      expect(after.questions.map((q) => q.value)).toEqual(['abc', null, null, null, null, null])
    })

    test('marks a quiz from its points lines and keeps them out of labels', async ({ page }) => {
      await page.goto(c.url('quiz'))
      const p = await driver.readPage(page, 1)
      expect(p.quiz).toBe(true)
      expect(p.questions.map((q) => q.label)).toEqual(['Full name', 'Which week is it?', 'Is this a quiz?'])
      expect(p.questions.every((q) => !/point/.test(q.label))).toBe(true)
      await page.goto(c.url('not-attendance'))
      expect((await driver.readPage(page, 1)).quiz).toBe(false)
    })

    test('classifies pages', async ({ page }) => {
      for (const [name, kind] of [
        ['attendance', 'form'],
        ['captcha', 'captcha'],
        ['already-responded', 'already_answered'],
        ['closed', 'closed']
      ] as const) {
        await page.goto(c.url(name))
        expect(await driver.pageKind(page)).toBe(kind)
      }
      fx.signedOut.add('attendance')
      await page.goto(c.url('attendance'))
      await page.waitForURL(c.signin)
      expect(await driver.pageKind(page)).toBe('signin')
    })

    test('a dropdown whose popup renders late is still read and chosen', async ({ page }) => {
      await page.goto(c.url('widgets') + '#options-delay=300')
      const form = await driver.readPage(page, 1)
      expect(form.questions[4]!.options).toEqual(['01', '02', '03'])
      await driver.fill(page, form, [choose('p1q4', '03')])
      expect((await driver.readPage(page, 1)).questions[4]!.value).toBe('03')
    })

    test('next() on a Submit-only page and submit() on a Next-only page throw and send nothing', async ({ page }) => {
      await page.goto(c.url('widgets'))
      await expect(driver.next(page)).rejects.toMatchObject({ code: 'next_failed' })
      await page.goto(c.url('attendance'))
      await expect(driver.submit(page)).rejects.toMatchObject({ code: 'submit_failed' })
      expect(fx.submissions).toHaveLength(0)
    })

    test('no action runs on a captcha, a sign-in page or another site', async ({ page }) => {
      await page.goto(c.url('attendance'))
      const form = await driver.readPage(page, 1)
      await page.goto(c.url('captcha'))
      for (const act of [
        () => driver.readPage(page, 1),
        () => driver.fill(page, form, [text('p1q0', 'x')]),
        () => driver.next(page),
        () => driver.submit(page)
      ]) {
        await expect(act()).rejects.toMatchObject({ code: 'not_a_form' })
      }
      expect(await page.locator('input').first().inputValue()).toBe('')
      fx.signedOut.add('attendance')
      await page.goto(c.url('attendance'))
      await page.waitForURL(c.signin)
      await expect(driver.next(page)).rejects.toMatchObject({ code: 'not_a_form' })
      await page.goto('about:blank')
      await expect(driver.readPage(page, 1)).rejects.toMatchObject({ code: 'not_a_form' })
      expect(fx.submissions).toHaveLength(0)
    })

    test('reads organisation evidence from the provider elements only', async ({ page }) => {
      await page.goto(c.url('attendance'))
      const own = (await driver.readPage(page, 1)).restriction
      expect(own).toEqual(c.org)
      expect(orgRestricted(own, ORG)).toBe(c.org.orgOnly || c.org.organisation !== null)
      await page.goto(c.url('external'))
      const spoof = await driver.readPage(page, 1)
      // The description copies the provider's sentence and an email: none of it is provider-owned.
      for (const copied of c.copied) expect(spoof.description).toContain(copied)
      expect(spoof.restriction).toEqual({ organisation: null, signedInAs: null, orgOnly: false })
      expect(orgRestricted(spoof.restriction, ORG)).toBe(false)
    })

    test('never requests a formResponse or prefilled URL while reading and filling', async ({ page }) => {
      await page.goto(c.url('attendance'))
      const form = await driver.readPage(page, 1)
      await driver.fill(page, form, [text('p1q0', 'Test Student')])
      expect(fx.requests).toEqual([c.url('attendance'), ...c.assets])
    })
  })

test.describe('google selector map', () => {
  const mapPath = join(process.env.TM_SELECTORS_DIR!, 'google-forms.json')
  const withMap = async (dir: string, patch: Record<string, unknown> | string) => {
    await mkdir(dir, { recursive: true })
    const map =
      typeof patch === 'string' ? patch : JSON.stringify({ ...JSON.parse(await readFile(mapPath, 'utf8')), ...patch })
    await writeFile(join(dir, 'google-forms.json'), map)
    return dir
  }

  test('loads from the given directory and names the file when it is wrong', async ({}, info) => {
    expect((await loadFormSelectors('google')).formHosts).toEqual(['docs.google.com'])
    const bad = await withMap(info.outputPath('bad'), '{ not json')
    await expect(loadFormSelectors('google', bad)).rejects.toThrow(/google-forms\.json is not valid JSON/)
    const noGroup = await withMap(info.outputPath('no-group'), { orgFooterPattern: 'inside of .+' })
    await expect(loadFormSelectors('google', noGroup)).rejects.toThrow(
      /google-forms\.json is invalid[\s\S]*capture group/
    )
    const half = await withMap(info.outputPath('half'), { orgFooter: null })
    await expect(loadFormSelectors('google', half)).rejects.toThrow(/orgFooter and orgFooterPattern/)
    await expect(loadFormSelectors('google', info.outputPath('missing'))).rejects.toThrow(/ENOENT/)
  })

  test('a notice or account copied into the description or a label is not provider evidence', async ({
    page,
    context
  }, info) => {
    await routeFormFixtures(context)
    const dir = await withMap(info.outputPath('notice'), {
      orgOnlyNotice: '.form-notice',
      orgOnlyTexts: ['the owner will see your name']
    })
    const driver = createDriver('google', await loadFormSelectors('google', dir))
    await page.goto(googleUrl('external'))
    await page.evaluate(() => {
      document
        .querySelector('.form-description')!
        .append(' Hi. When you submit, the owner will see your name and email.')
      document.querySelector("div[role='heading'][aria-level='3']")!.append(' student@example.edu.my')
    })
    expect((await driver.readPage(page, 1)).restriction).toEqual({
      organisation: null,
      signedInAs: null,
      orgOnly: false
    })
    await page.evaluate(() => {
      const notice = document.createElement('div')
      notice.className = 'form-notice'
      notice.textContent = 'Hi. When you submit, the owner will see your name and email.'
      document.body.append(notice)
    })
    expect((await driver.readPage(page, 1)).restriction.orgOnly).toBe(true)
  })

  test('a page that is not https is unknown, not a sign-in step', async ({ page }) => {
    await page.goto('about:blank')
    expect(await (await driverFor('google')).pageKind(page)).toBe('unknown')
  })
})

test.describe('microsoft selector map', () => {
  test('loads and has no organisation footer', async () => {
    const map = await loadFormSelectors('microsoft')
    expect(map.formHosts).toEqual(['forms.office.com', 'forms.microsoft.com'])
    expect([map.orgFooter, map.orgFooterPattern]).toEqual([null, null])
    expect([map.orgOnlyNotice, map.orgOnlyTexts]).toEqual([null, []])
  })

  test('a notice or account copied into the description or a label is not provider evidence', async ({
    page,
    context
  }) => {
    await routeFormFixtures(context)
    const driver = await driverFor('microsoft')
    await page.goto(microsoftUrl('external'))
    await page.evaluate(() => {
      document
        .querySelector("[data-automation-id='formDescription']")!
        .append(' Hi. When you submit this form, the owner will see your name and email address.')
      document.querySelector("span[data-automation-id='questionTitle']")!.append(' student@example.edu.my')
    })
    expect((await driver.readPage(page, 1)).restriction).toEqual({
      organisation: null,
      signedInAs: null,
      orgOnly: false
    })
    await page.evaluate(() => {
      const notice = document.createElement('div')
      notice.dataset.automationId = 'respondentNotice'
      notice.textContent = 'Hi. When you submit this form, the owner will see your name and email address.'
      const account = document.createElement('div')
      account.dataset.automationId = 'userEmail'
      account.textContent = 'student@example.edu.my'
      document.body.append(notice, account)
    })
    expect((await driver.readPage(page, 1)).restriction).toEqual({
      organisation: null,
      signedInAs: 'student@example.edu.my',
      orgOnly: false
    })
  })

  test('a genuine owner notice and account on an outside form are not organisation evidence', async ({
    page,
    context
  }) => {
    await routeFormFixtures(context)
    await page.goto(microsoftUrl('external-record-name'))
    const form = await (await driverFor('microsoft')).readPage(page, 1)
    expect(form.restriction).toEqual({ organisation: null, signedInAs: 'student@example.edu.my', orgOnly: false })
    expect(orgRestricted(form.restriction, ORG)).toBe(false)
  })

  test('a mixed-case form id is a different form: the canonical URL keeps its case', () => {
    expect(canonicalFormUrl(microsoftUrl('attendance'))).toBe(microsoftUrl('attendance'))
    expect(canonicalFormUrl(microsoftUrl('Attendance'))).toBe(microsoftUrl('Attendance'))
    expect(canonicalFormUrl(microsoftUrl('Attendance'))).not.toBe(canonicalFormUrl(microsoftUrl('attendance')))
  })

  test('forms.microsoft.com is a form host', async ({ page, context }) => {
    await routeFormFixtures(context)
    await page.goto('https://forms.microsoft.com/Pages/ResponsePage.aspx?id=attendance')
    expect(await (await driverFor('microsoft')).pageKind(page)).toBe('form')
  })

  test('a look-alike host or plain http is never a form, and no action runs there', async ({ page, context }) => {
    const fx = await routeFormFixtures(context)
    const driver = await driverFor('microsoft')
    await page.goto(microsoftUrl('attendance'))
    const form = await driver.readPage(page, 1)
    for (const [url, kind] of [
      ['https://forms.office.com.evil.test/Pages/ResponsePage.aspx?id=attendance', 'signin'],
      ['http://forms.office.com/Pages/ResponsePage.aspx?id=attendance', 'unknown']
    ] as const) {
      await page.goto(url)
      expect(await driver.pageKind(page)).toBe(kind)
      await expect(driver.readPage(page, 1)).rejects.toMatchObject({ code: 'not_a_form' })
      await expect(driver.fill(page, form, [text('p1q0', 'x')])).rejects.toMatchObject({ code: 'not_a_form' })
      await expect(driver.next(page)).rejects.toMatchObject({ code: 'not_a_form' })
      await expect(driver.submit(page)).rejects.toMatchObject({ code: 'not_a_form' })
    }
    expect(fx.submissions).toHaveLength(0)
  })

  test('a page that is not https is unknown, not a sign-in step', async ({ page }) => {
    await page.goto('about:blank')
    expect(await (await driverFor('microsoft')).pageKind(page)).toBe('unknown')
  })
})

// The short timeouts make the failure paths fast; the defaults are 10 s a step and 15 s for Submit.
for (const c of CASES)
  test.describe(`${c.provider} typed failures`, () => {
    let fx: FixtureServer
    let driver: FormDriver
    test.beforeEach(async ({ context }) => {
      fx = await routeFormFixtures(context)
      driver = createDriver(c.provider, await loadFormSelectors(c.provider), { stepMs: 700, submitMs: 1500 })
    })

    const widgetAnswers = [text('p1q0', 'abc'), choose('p1q2', 'Present'), choose('p1q4', '01')]

    test('a dropdown whose options never show fails with dropdown_failed, in readPage and in fill', async ({
      page
    }) => {
      await page.goto(c.url('widgets'))
      const form = await driver.readPage(page, 1)
      await page.evaluate(() => (location.hash = '#options-delay=4000'))
      await expect(driver.readPage(page, 1)).rejects.toMatchObject({ code: 'dropdown_failed' })
      await expect(driver.fill(page, form, [choose('p1q4', '01')])).rejects.toMatchObject({ code: 'dropdown_failed' })
    })

    test('a Next button under an overlay fails with next_failed', async ({ page }) => {
      await page.goto(c.url('attendance') + '#overlay')
      await expect(driver.next(page)).rejects.toMatchObject({ code: 'next_failed' })
    })

    test('a Submit button under an overlay fails with submit_failed and sends nothing', async ({ page }) => {
      await page.goto(c.url('widgets') + '#overlay')
      await expect(driver.submit(page)).rejects.toMatchObject({ code: 'submit_failed' })
      expect(fx.submissions).toHaveLength(0)
      expect(await page.evaluate(() => (window as unknown as { mouseEvents: number }).mouseEvents)).toBe(0)
    })

    test('an error banner outside every question after the click is submit_unconfirmed', async ({ page }) => {
      await page.goto(c.url('widgets') + '#banner')
      await driver.fill(page, await driver.readPage(page, 1), widgetAnswers)
      await expect(driver.submit(page)).rejects.toMatchObject({ code: 'submit_unconfirmed' })
    })

    test('a second submit() on a page that was clicked never clicks again', async ({ page }) => {
      fx.submitResult.set('widgets', 'still-form')
      await page.goto(c.url('widgets'))
      await driver.fill(page, await driver.readPage(page, 1), widgetAnswers)
      await expect(driver.submit(page)).rejects.toMatchObject({ code: 'submit_unconfirmed' })
      expect(fx.submissions).toHaveLength(1)
      // The provider shows the form again, ready to submit: a second click would post a second response.
      await driver.fill(page, await driver.readPage(page, 1), widgetAnswers)
      await expect(driver.submit(page)).rejects.toMatchObject({ code: 'submit_unconfirmed' })
      expect(fx.submissions).toHaveLength(1)
    })

    test('a question that vanishes during a fill is not_a_form', async ({ page }) => {
      await page.goto(c.url('widgets'))
      const form = await driver.readPage(page, 1)
      const gone = { ...form, questions: [...form.questions, { ...form.questions[0]!, id: 'p1q9' }] }
      await expect(driver.fill(page, gone, [text('p1q9', 'x')])).rejects.toMatchObject({ code: 'not_a_form' })
    })

    for (const [name, result] of [
      ['still on the form', 'still-form'],
      ['on a captcha', 'captcha']
    ] as const)
      test(`a submit that ends ${name} is submit_unconfirmed`, async ({ page }) => {
        fx.submitResult.set('widgets', result)
        await page.goto(c.url('widgets'))
        await driver.fill(page, await driver.readPage(page, 1), widgetAnswers)
        await expect(driver.submit(page)).rejects.toMatchObject({ code: 'submit_unconfirmed' })
        expect(fx.submissions).toHaveLength(1)
      })

    test('a stale alert does not fail a Next that moves on', async ({ page }) => {
      await page.goto(c.url('attendance'))
      await expect(driver.next(page)).rejects.toMatchObject({ code: 'next_failed' })
      await driver.fill(page, await driver.readPage(page, 1), [
        text('p1q0', 'Test Student'),
        text('p1q1', 'A00000000'),
        text('p1q2', 'ABC1234'),
        choose('p1q3', '02')
      ])
      await driver.next(page)
      expect((await driver.readPage(page, 2)).questions[0]!.label).toBe('Attendance')
    })
  })
