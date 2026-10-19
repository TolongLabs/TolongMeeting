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

export class FormStepError extends Error {
  constructor(
    readonly code: 'next_failed' | 'submit_failed',
    message: string
  ) {
    super(message)
    this.name = 'FormStepError'
  }
}

export interface FormDriver {
  readonly provider: FormProvider
  pageKind(page: Page): Promise<PageKind>
  readPage(page: Page, index: number): Promise<FormPage>
  fill(page: Page, form: FormPage, answers: Answer[]): Promise<void> // also unticks "send me a copy"
  next(page: Page): Promise<void> // resolves when a new page's questions show; FormStepError('next_failed') on a validation error or after 10 s
  submit(page: Page): Promise<void> // FormStepError('submit_failed') on a validation error; else resolves when pageKind is no longer 'form' or after 15 s
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

// Runs in the page: the text of each element, by the same rule as an option inside a question.
function extractTexts(elements: Element[], attrs: string[]): string[] {
  return elements.map((el) => {
    for (const attr of attrs) {
      const value = (el.getAttribute(attr) ?? '').replace(/\s+/g, ' ').trim()
      if (value !== '') return value
    }
    return (el.textContent ?? '').replace(/\s+/g, ' ').trim()
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

export function createDriver(provider: FormProvider, map: FormSelectors): FormDriver {
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

  async function dropdownOptions(page: Page, question: Locator): Promise<string[]> {
    await question.locator(map.listbox).first().click()
    const options = visible(page, map.listboxOption)
    const found = (await options.evaluateAll(extractTexts, map.optionTextAttrs)).filter(
      (text) => text !== '' && !placeholders.has(normaliseText(text))
    )
    await closeDropdown(page)
    return found
  }

  async function closeDropdown(page: Page): Promise<void> {
    await page.keyboard.press('Escape')
    const deadline = Date.now() + CLOSE_TIMEOUT_MS
    while ((await visible(page, map.listboxOption).count()) > 0) {
      if (Date.now() > deadline) throw new Error('a dropdown stayed open after Escape')
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

  async function readPage(page: Page, index: number): Promise<FormPage> {
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
        options = await dropdownOptions(page, questions(page).nth(n))
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
    const [live] = await element.locator(map.label).evaluateAll((els) => els.map((el) => (el as HTMLElement).innerText))
    if (live === undefined || !live.includes(question.label)) {
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
      await element.locator(map.listbox).first().click()
      const options = visible(page, map.listboxOption)
      const index = (await options.evaluateAll(extractTexts, map.optionTextAttrs)).indexOf(answer.option)
      if (index < 0) throw new Error(`question ${question.id} has no option "${answer.option}"`)
      await options.nth(index).click()
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
    for (const answer of answers) await fillAnswer(page, form, answer)
    await untickCopy(page)
  }

  const hasError = async (page: Page) =>
    (await visible(page, map.validationError).filter({ hasText: /\S/ }).count()) > 0

  // The labels on show: the validation message sits inside a question, so only labels say the page changed.
  const labels = async (page: Page) =>
    (
      await questions(page)
        .locator(map.label)
        .evaluateAll((els) => els.map((el) => (el as HTMLElement).innerText))
    ).join('\n')

  async function click(page: Page, selector: string, code: FormStepError['code'], what: string): Promise<void> {
    const button = visible(page, selector)
    if ((await button.count()) === 0) throw new FormStepError(code, `no ${what} button on the page`)
    await button.first().click()
  }

  async function next(page: Page): Promise<void> {
    const before = await labels(page)
    await click(page, map.nextButton, 'next_failed', 'Next')
    const deadline = Date.now() + NEXT_TIMEOUT_MS
    while (Date.now() < deadline) {
      const now = await labels(page)
      if (now !== '' && now !== before) return
      if (await hasError(page)) throw new FormStepError('next_failed', 'the form shows a validation error')
      await sleep(POLL_MS)
    }
    throw new FormStepError('next_failed', `no new page after ${NEXT_TIMEOUT_MS / 1000} s`)
  }

  async function submit(page: Page): Promise<void> {
    await click(page, map.submitButton, 'submit_failed', 'Submit')
    const deadline = Date.now() + SUBMIT_TIMEOUT_MS
    while (Date.now() < deadline) {
      if ((await pageKind(page)) !== 'form') return
      if (await hasError(page)) throw new FormStepError('submit_failed', 'the form shows a validation error')
      await sleep(POLL_MS)
    }
  }

  return { provider, pageKind, readPage, fill, next, submit }
}
