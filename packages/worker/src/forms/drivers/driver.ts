import type { FormProvider } from '@tm/core'
import type { Locator, Page } from 'playwright'
import { isPointsLine, normaliseText } from '../rules'
import type { Answer, FormPage, FormQuestion, PageKind, QuestionType, Restriction } from '../types'
import type { FormSelectors } from './selectors'

export const NEXT_TIMEOUT_MS = 10_000
export const SUBMIT_TIMEOUT_MS = 15_000
const POLL_MS = 100
const CLOSE_TIMEOUT_MS = 2_000
const EMAIL = /[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[^\s@<>()[\]",;:]*[^\s@<>()[\]",;:.]/

export type FormStepCode =
  | 'next_failed' // Next was not clicked, or no new page opened
  | 'submit_failed' // Submit was NOT clicked, or the form refused it with a validation error on a question: nothing was sent
  | 'submit_unconfirmed' // Submit WAS clicked (or an earlier call clicked it) and the outcome is unknown: maybe recorded
  | 'dropdown_failed' // a dropdown's options never showed, or the list stayed open
  | 'not_a_form' // the page is not a form page on a form host (sign-in, captcha, status page, other site)

export class FormStepError extends Error {
  constructor(
    readonly code: FormStepCode,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'FormStepError'
  }
}

export interface DriverTimeouts {
  stepMs: number // each click, a dropdown's options showing, and Next showing a new page
  submitMs: number // after the Submit click, waiting for the provider's response page
}

export const DEFAULT_TIMEOUTS: DriverTimeouts = { stepMs: NEXT_TIMEOUT_MS, submitMs: SUBMIT_TIMEOUT_MS }

export interface FormDriver {
  readonly provider: FormProvider
  pageKind(page: Page): Promise<PageKind>
  // readPage, fill, next and submit first check that the page is a form on a form host; otherwise FormStepError('not_a_form')
  readPage(page: Page, index: number): Promise<FormPage>
  fill(page: Page, form: FormPage, answers: Answer[]): Promise<void> // also unticks "send me a copy"
  next(page: Page): Promise<void> // resolves when a new page's questions show; FormStepError('next_failed') on a validation error, a blocked click or after 10 s
  /**
   * Resolves only when the provider's response page shows (pageKind 'confirmation' or 'already_answered').
   * FormStepError('submit_failed'): Submit was not clicked, or the form refused it with a validation error; nothing was sent.
   * FormStepError('submit_unconfirmed'): Submit WAS clicked and the outcome is unknown (still on the form after 15 s, a
   * captcha, sign-in or unknown page, or a failed read). The caller MUST treat this as maybe-submitted: record the form
   * as handled, never retry or call submit again, and ping the member to check.
   */
  submit(page: Page): Promise<void>
}

interface RawQuestion {
  labelText: string
  requiredText: string | null // null: not required
  lines: string[]
  kind: QuestionType
  options: { text: string; checked: boolean }[] // radio and checkbox options
  inputValue: string // text and paragraph
  triggerText: string // dropdown
}

interface QuestionSelectors {
  label: string
  required: string
  text: string
  paragraph: string
  radio: string
  checkbox: string
  listbox: string
  unsupported: string
  attrs: string[]
}

// Runs in the page: reads every question element in one round trip. Everything it uses is declared inside it.
function extractQuestions(elements: Element[], s: QuestionSelectors): RawQuestion[] {
  const clean = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim()
  const optionText = (el: Element) => {
    for (const attr of s.attrs) {
      const value = clean(el.getAttribute(attr))
      if (value !== '') return value
    }
    return clean(el.textContent)
  }
  const isChosen = (el: Element) =>
    el.getAttribute('aria-checked') === 'true' || (el as HTMLInputElement).checked === true
  const kinds: [QuestionType, string][] = [
    ['text', s.text],
    ['paragraph', s.paragraph],
    ['radio', s.radio],
    ['checkbox', s.checkbox],
    ['dropdown', s.listbox]
  ]
  return elements.map((q) => {
    const label = q.querySelector(s.label) as HTMLElement | null
    const required = q.querySelector(s.required)
    const first = q.querySelector(kinds.map(([, selector]) => selector).join(', '))
    let kind: QuestionType = 'other'
    if (first !== null && q.querySelector(s.unsupported) === null)
      kind = kinds.find(([, sel]) => first.matches(sel))![0]
    const options =
      kind === 'radio' || kind === 'checkbox' ? [...q.querySelectorAll(kind === 'radio' ? s.radio : s.checkbox)] : []
    return {
      labelText: label?.innerText ?? '',
      requiredText: required === null ? null : clean(required.textContent),
      lines: ((q as HTMLElement).innerText ?? '')
        .split('\n')
        .map(clean)
        .filter((line) => line !== ''),
      kind,
      options: options.map((el) => ({ text: optionText(el), checked: isChosen(el) })),
      inputValue: kind === 'text' || kind === 'paragraph' ? (first as HTMLInputElement).value : '',
      triggerText: kind === 'dropdown' ? clean(q.querySelector(s.listbox)?.textContent) : ''
    }
  })
}

// Runs in the page: the text and ticked state of each option element.
function extractStates(elements: Element[], attrs: string[]): { text: string; checked: boolean }[] {
  const texts = elements.map((el) => {
    for (const attr of attrs) {
      const value = (el.getAttribute(attr) ?? '').replace(/\s+/g, ' ').trim()
      if (value !== '') return value
    }
    return (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  })
  return elements.map((el, i) => ({
    text: texts[i]!,
    checked: el.getAttribute('aria-checked') === 'true' || (el as HTMLInputElement).checked === true
  }))
}

// Runs in the page: whether the first element is ticked; null when there is none.
function firstTicked(elements: Element[]): boolean | null {
  const el = elements[0]
  if (el === undefined) return null
  return el.getAttribute('aria-checked') === 'true' || (el as HTMLInputElement).checked === true
}

// Runs in the page: whether the element is on screen and is what the browser finds at its own centre (or contains it).
// Reads only; it dispatches no mouse or pointer event, so a covered button is found without touching the page's scripts.
function isUncoveredAtCentre(el: Element): boolean {
  const box = el.getBoundingClientRect()
  if (box.width === 0 || box.height === 0) return false
  const x = box.left + box.width / 2
  const y = box.top + box.height / 2
  if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false
  const hit = document.elementFromPoint(x, y)
  return hit !== null && (hit === el || el.contains(hit))
}

// Pages whose Submit was really clicked. A page in here is never submitted again, whatever it shows now.
const submitClicked = new WeakSet<Page>()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stripLabel(raw: RawQuestion): string {
  const marker = raw.requiredText
  const lines = raw.labelText
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '' && !isPointsLine(line) && line !== marker)
  let label = lines.join(' ')
  if (marker !== null && marker !== '' && label.endsWith(marker)) label = label.slice(0, -marker.length).trim()
  return label
}

const isTimeout = (error: unknown) => error instanceof Error && error.name === 'TimeoutError'
// A read that raced a navigation: the page is moving, so the poll tries again.
const isNavigating = (error: unknown) => /Execution context was destroyed|detached/i.test(String(error))

export function createDriver(
  provider: FormProvider,
  map: FormSelectors,
  timeouts: Partial<DriverTimeouts> = {}
): FormDriver {
  const { stepMs, submitMs } = { ...DEFAULT_TIMEOUTS, ...timeouts }
  const placeholders = new Set(map.listboxPlaceholders.map(normaliseText))
  const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true })
  const questions = (page: Page) => visible(page, map.question)
  const selectors: QuestionSelectors = {
    label: map.label,
    required: map.required,
    text: map.textInput,
    paragraph: map.paragraphInput,
    radio: map.radioOption,
    checkbox: map.checkboxOption,
    listbox: map.listbox,
    unsupported: map.unsupported,
    attrs: map.optionTextAttrs
  }

  const hasText = (haystack: string, phrases: string[]) => {
    const text = normaliseText(haystack)
    return phrases.some((phrase) => text.includes(normaliseText(phrase)))
  }

  // Only elements the provider owns can say anything about the member's account or organisation.
  const texts = (page: Page, selector: string) =>
    page.locator(selector).evaluateAll((els) => els.map((el) => (el as HTMLElement).innerText))

  async function pageKind(page: Page): Promise<PageKind> {
    const url = new URL(page.url())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'unknown'
    if (!map.formHosts.includes(url.hostname.toLowerCase())) return 'signin'
    if ((await page.locator(map.captcha).count()) > 0) return 'captcha'
    if ((await questions(page).count()) > 0) return 'form'
    const text = await page.evaluate(() => document.body?.innerText ?? '')
    if (hasText(text, map.texts.signin)) return 'signin'
    if (hasText(text, map.texts.alreadyAnswered)) return 'already_answered'
    if (hasText(text, map.texts.confirmation)) return 'confirmation'
    if (hasText(text, map.texts.closed)) return 'closed'
    if (hasText(text, map.texts.noAccess)) return 'no_access'
    return 'unknown'
  }

  // Opens the question's listbox and waits for its options to show: a popup may render after the click.
  async function openDropdown(page: Page, question: Locator, label: string): Promise<Locator> {
    const options = visible(page, map.listboxOption)
    try {
      await question.locator(map.listbox).first().click({ timeout: stepMs })
      await options.first().waitFor({ state: 'visible', timeout: stepMs })
    } catch (error) {
      if (!isTimeout(error)) throw error
      await page.keyboard.press('Escape') // a popup that is only late must not stay open over the form
      throw new FormStepError('dropdown_failed', `the options of "${label}" did not show`, error)
    }
    return options
  }

  async function dropdownOptions(page: Page, question: Locator, label: string): Promise<string[]> {
    const options = await openDropdown(page, question, label)
    const found = (await options.evaluateAll(extractStates, map.optionTextAttrs))
      .map((state) => state.text)
      .filter((text) => text !== '' && !placeholders.has(normaliseText(text)))
    await closeDropdown(page)
    return found
  }

  async function closeDropdown(page: Page): Promise<void> {
    await page.keyboard.press('Escape')
    const deadline = Date.now() + CLOSE_TIMEOUT_MS
    while ((await visible(page, map.listboxOption).count()) > 0) {
      if (Date.now() > deadline) throw new FormStepError('dropdown_failed', 'a dropdown stayed open after Escape')
      await sleep(POLL_MS)
    }
  }

  async function restriction(page: Page): Promise<Restriction> {
    const account = (await texts(page, map.accountLine)).join('\n')
    const signedInAs = EMAIL.exec(account)?.[0] ?? null
    let organisation: string | null = null
    if (map.orgFooter !== null && map.orgFooterPattern !== null) {
      const pattern = new RegExp(map.orgFooterPattern, 'i')
      for (const footer of await texts(page, map.orgFooter)) {
        const captured = pattern.exec(footer)?.[1]?.trim()
        if (captured) {
          organisation = captured
          break
        }
      }
    }
    let orgOnly = false
    if (map.orgOnlyNotice !== null && map.orgOnlyTexts.length > 0) {
      orgOnly = hasText((await texts(page, map.orgOnlyNotice)).join('\n'), map.orgOnlyTexts)
    }
    return { organisation, signedInAs, orgOnly }
  }

  // The driver never types or clicks on a sign-in page, a captcha, a status page or another site.
  async function assertForm(page: Page): Promise<void> {
    const kind = await pageKind(page)
    if (kind !== 'form') throw new FormStepError('not_a_form', `the page is not a form (${kind}) at ${page.url()}`)
  }

  async function readPage(page: Page, index: number): Promise<FormPage> {
    await assertForm(page)
    const raws = await questions(page).evaluateAll(extractQuestions, selectors)
    const list: FormQuestion[] = []
    for (const [n, raw] of raws.entries()) {
      let options = raw.options.map((o) => o.text)
      let value: FormQuestion['value'] = null
      if (raw.kind === 'text' || raw.kind === 'paragraph') value = raw.inputValue === '' ? null : raw.inputValue
      else if (raw.kind === 'radio') value = raw.options.find((o) => o.checked)?.text ?? null
      else if (raw.kind === 'checkbox') {
        const chosen = raw.options.filter((o) => o.checked).map((o) => o.text)
        value = chosen.length > 0 ? chosen : null
      } else if (raw.kind === 'dropdown') {
        value = raw.triggerText === '' || placeholders.has(normaliseText(raw.triggerText)) ? null : raw.triggerText
        options = await dropdownOptions(page, questions(page).nth(n), stripLabel(raw))
      }
      list.push({
        id: `p${index}q${n}`,
        label: stripLabel(raw),
        type: raw.kind,
        options,
        required: raw.requiredText !== null,
        value
      })
    }
    const [title = ''] = await texts(page, map.title)
    const [description = ''] = await texts(page, map.description)
    const copy = await page.locator(map.sendCopy).evaluateAll(firstTicked)
    return {
      index,
      title: title.trim(),
      description: description.trim(),
      questions: list,
      quiz: raws.some((raw) => raw.lines.some(isPointsLine)),
      sendCopy: copy,
      hasNext: (await visible(page, map.nextButton).count()) > 0,
      hasSubmit: (await visible(page, map.submitButton).count()) > 0,
      restriction: await restriction(page)
    }
  }

  async function fillAnswer(page: Page, form: FormPage, answer: Answer): Promise<void> {
    const question = form.questions.find((q) => q.id === answer.questionId)
    if (question === undefined) throw new Error(`no question ${answer.questionId} on page ${form.index}`)
    const position = Number(/q(\d+)$/.exec(question.id)?.[1])
    const element = questions(page).nth(position)
    // The same reading as readPage: the stripped label must equal the planned one, and an empty label never matches.
    const [live] = await element.evaluateAll(extractQuestions, selectors)
    if (live === undefined) {
      throw new FormStepError('not_a_form', `question ${question.id} is gone: the page left the form during the fill`)
    }
    const liveLabel = stripLabel(live)
    if (liveLabel === '' || liveLabel !== question.label || live.kind !== question.type) {
      throw new Error(`question ${question.id} is not "${question.label}" on the page: the form changed under the fill`)
    }
    if (answer.kind === 'text') {
      if (question.type !== 'text' && question.type !== 'paragraph') {
        throw new Error(`question ${question.id} (${question.type}) cannot take a text answer`)
      }
      await element
        .locator(question.type === 'text' ? map.textInput : map.paragraphInput)
        .first()
        .fill(answer.value)
      return
    }
    if (question.type === 'dropdown') {
      const options = await openDropdown(page, element, question.label)
      const index = (await options.evaluateAll(extractStates, map.optionTextAttrs)).findIndex(
        (state) => state.text === answer.option
      )
      if (index < 0) throw new Error(`question ${question.id} has no option "${answer.option}"`)
      await options.nth(index).click({ timeout: stepMs })
      return
    }
    if (question.type !== 'radio' && question.type !== 'checkbox') {
      throw new Error(`question ${question.id} (${question.type}) cannot take a choice`)
    }
    const options = element.locator(question.type === 'radio' ? map.radioOption : map.checkboxOption)
    const states = await options.evaluateAll(extractStates, map.optionTextAttrs)
    const index = states.findIndex((s) => s.text === answer.option)
    if (index < 0) throw new Error(`question ${question.id} has no option "${answer.option}"`)
    if (!states[index]!.checked) await options.nth(index).click()
  }

  async function untickCopy(page: Page): Promise<void> {
    const box = page.locator(map.sendCopy)
    if ((await box.evaluateAll(firstTicked)) !== true) return
    await box.first().click()
    const deadline = Date.now() + CLOSE_TIMEOUT_MS
    while ((await box.evaluateAll(firstTicked)) === true) {
      if (Date.now() > deadline) throw new Error('the "send me a copy" box stayed ticked after a click')
      await sleep(POLL_MS)
    }
  }

  async function fill(page: Page, form: FormPage, answers: Answer[]): Promise<void> {
    await assertForm(page)
    for (const answer of answers) await fillAnswer(page, form, answer)
    await untickCopy(page)
  }

  // Visible alerts with a message; a validation error shows as one more than before the click.
  const alertCount = (page: Page) => visible(page, map.validationError).filter({ hasText: /\S/ }).count()

  // Visible alerts with a message that sit inside a question, the way a validation error does.
  const questionAlertCount = (page: Page) =>
    questions(page).locator(map.validationError).filter({ visible: true }).filter({ hasText: /\S/ }).count()

  // The labels on show: the validation message sits inside a question, so only labels say the page changed.
  const labels = async (page: Page) =>
    (
      await questions(page)
        .locator(map.label)
        .evaluateAll((els) => els.map((el) => (el as HTMLElement).innerText))
    ).join('\n')

  async function button(page: Page, selector: string, code: 'next_failed' | 'submit_failed', what: string) {
    const found = visible(page, selector)
    if ((await found.count()) === 0) throw new FormStepError(code, `no ${what} button on the page`)
    return found.first()
  }

  async function next(page: Page): Promise<void> {
    await assertForm(page)
    const before = await labels(page)
    const alertsBefore = await alertCount(page)
    const target = await button(page, map.nextButton, 'next_failed', 'Next')
    try {
      await target.click({ timeout: stepMs })
    } catch (error) {
      if (!isTimeout(error)) throw error
      throw new FormStepError('next_failed', 'the Next button could not be clicked', error)
    }
    const deadline = Date.now() + stepMs
    while (Date.now() < deadline) {
      try {
        const now = await labels(page)
        if (now !== '' && now !== before) return
        if ((await alertCount(page)) > alertsBefore) {
          throw new FormStepError('next_failed', 'the form shows a validation error')
        }
      } catch (error) {
        if (!isNavigating(error)) throw error
      }
      await sleep(POLL_MS)
    }
    throw new FormStepError('next_failed', `no new page after ${stepMs / 1000} s`)
  }

  // Everything here only reads the page: no click, hover or key is sent until the one real click.
  async function submitTarget(page: Page): Promise<Locator> {
    const found = visible(page, map.submitButton)
    try {
      const count = await found.count()
      if (count !== 1) throw new FormStepError('submit_failed', `${count} Submit buttons on the page, not exactly one`)
      if (!(await found.isEnabled({ timeout: stepMs }))) throw new FormStepError('submit_failed', 'Submit is disabled')
      await found.scrollIntoViewIfNeeded({ timeout: stepMs })
      if (!(await found.evaluate(isUncoveredAtCentre))) {
        throw new FormStepError('submit_failed', 'something covers the Submit button, or it is off screen')
      }
    } catch (error) {
      if (error instanceof FormStepError) throw error
      throw new FormStepError('submit_failed', 'the Submit button could not be checked', error)
    }
    return found
  }

  async function submit(page: Page): Promise<void> {
    if (submitClicked.has(page)) {
      throw new FormStepError('submit_unconfirmed', 'Submit was already clicked on this page: never submit twice')
    }
    await assertForm(page)
    const alertsBefore = await alertCount(page)
    const inQuestionBefore = await questionAlertCount(page)
    const labelsBefore = await labels(page)
    const target = await submitTarget(page)
    await assertForm(page) // the page may have moved on while the button was checked
    // From the click on, the response may be on its way: every failure is "unconfirmed", never "failed".
    submitClicked.add(page)
    try {
      await target.click({ timeout: stepMs })
    } catch (error) {
      throw new FormStepError('submit_unconfirmed', 'the Submit click did not finish cleanly', error)
    }
    const deadline = Date.now() + submitMs
    let last: PageKind | 'reading' = 'reading'
    while (Date.now() < deadline) {
      try {
        last = await pageKind(page)
        if (last === 'confirmation' || last === 'already_answered') return
        if (last === 'form' && (await alertCount(page)) > alertsBefore) {
          // Only a new alert inside a question, on the same form and with no other new alert, is a validation error.
          const newInQuestion = (await questionAlertCount(page)) - inQuestionBefore
          const newAlerts = (await alertCount(page)) - alertsBefore
          if (newInQuestion === newAlerts && (await labels(page)) === labelsBefore) {
            throw new FormStepError('submit_failed', 'the form shows a validation error')
          }
          throw new FormStepError('submit_unconfirmed', 'the page shows an alert that is not a validation error')
        }
      } catch (error) {
        if (error instanceof FormStepError) throw error
        if (!isNavigating(error))
          throw new FormStepError('submit_unconfirmed', 'reading the page after Submit failed', error)
      }
      await sleep(POLL_MS)
    }
    throw new FormStepError('submit_unconfirmed', `no response page ${submitMs / 1000} s after Submit (last: ${last})`)
  }

  return { provider, pageKind, readPage, fill, next, submit }
}
