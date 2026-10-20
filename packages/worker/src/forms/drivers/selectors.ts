import type { FormProvider } from '@tm/core'
import { z } from 'zod'
import { loadSelectors } from '../../adapters/selectors'

const selector = z.string().min(1)
const phrase = z.string().min(1)

// A regular expression with exactly one capture group, checked when the map loads and not on a live form.
const capturePattern = z.string().refine(
  (source) => {
    try {
      return new RegExp(`${source}|`, 'i').exec('')?.length === 2
    } catch {
      return false
    }
  },
  { message: 'not a regular expression with exactly one capture group' }
)

// `question`, `title`, `description`, the buttons, `validationError`, `sendCopy`, `accountLine`, `orgFooter`,
// `orgOnlyNotice` and `captcha` are Playwright selectors. Every selector that runs inside a question (`label`
// through `unsupported`, `timeHour` and `timeMinute`) and `optionTextAttrs` are evaluated in the page, so they must be plain CSS.
export const FormSelectorsSchema = z
  .object({
    formHosts: z.array(phrase).min(1), // any other host means a sign-in or MFA step
    question: selector, // one element per question on the current page
    label: selector, // inside question
    required: selector, // inside question; present means required
    textInput: selector,
    paragraphInput: selector,
    radioOption: selector,
    checkboxOption: selector,
    listbox: selector, // dropdown trigger, inside question
    listboxOption: selector, // options, searched page-wide once the listbox is open
    listboxPlaceholders: z.array(phrase), // trigger texts that mean nothing is chosen
    dateInput: selector, // inside question: the date picker, an input[type=date] or a text input that names its format
    timeInput: selector, // inside question: the time widget, an input[type=time] or a group of hour and minute inputs
    timeHour: selector.nullable(), // inside timeInput; null when the widget is itself the input
    timeMinute: selector.nullable(), // inside timeInput; null when the widget is itself the input
    unsupported: selector, // inside question: makes its type 'other'
    optionTextAttrs: z.array(phrase), // attributes tried in order for an option's text, then its text content
    title: selector,
    description: selector,
    nextButton: selector,
    submitButton: selector,
    validationError: selector,
    sendCopy: selector, // outside the questions
    accountLine: selector, // the provider's own signed-in account element
    orgFooter: selector.nullable(),
    orgFooterPattern: capturePattern.nullable(), // one capture group for the organisation
    orgOnlyNotice: selector.nullable(),
    orgOnlyTexts: z.array(phrase),
    captcha: selector,
    texts: z.object({
      signin: z.array(phrase).min(1),
      alreadyAnswered: z.array(phrase).min(1),
      confirmation: z.array(phrase).min(1),
      closed: z.array(phrase).min(1),
      noAccess: z.array(phrase).min(1)
    })
  })
  .refine((map) => (map.orgFooter === null) === (map.orgFooterPattern === null), {
    message: 'orgFooter and orgFooterPattern are both set or both null',
    path: ['orgFooterPattern']
  })
  .refine((map) => map.orgOnlyNotice !== null || map.orgOnlyTexts.length === 0, {
    message: 'orgOnlyTexts needs an orgOnlyNotice',
    path: ['orgOnlyTexts']
  })
export type FormSelectors = z.infer<typeof FormSelectorsSchema>

// Reads `<dir>/google-forms.json` or `<dir>/microsoft-forms.json` through the shared selector loader.
export function loadFormSelectors(provider: FormProvider, dir?: string): Promise<FormSelectors> {
  return loadSelectors(`${provider}-forms`, FormSelectorsSchema, dir)
}
