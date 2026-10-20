import { readFileSync } from 'node:fs'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { STATE_FILE, type SettingsE2eState } from './state'

// One member walks through the three settings pages in order, because each step builds on the one before.
test.describe.configure({ mode: 'serial' })

const state = (): SettingsE2eState => JSON.parse(readFileSync(STATE_FILE, 'utf8'))

// The page shows a key's last four characters only for keys of 24 characters or more (lib/ai-keys.ts).
const GOOD_KEY = 'sk-e2e-good-key-long-enough-4242'
const BAD_KEY = 'sk-e2e-bad-key-long-enough-0000'
const MODELSCOPE_KEY = 'ms-e2e-good-key-long-enough-7777'
const NTFY_TOKEN = 'tk_e2e_secret_token'
const SECRETS = [GOOD_KEY, BAD_KEY, MODELSCOPE_KEY, NTFY_TOKEN]

/** One response the server sent: its URL, the server action it answers (`null` for a page) and its body. */
interface Sent {
  url: string
  action: string | null
  body: string
}

/** Everything the server sent while the test ran: pages, redirects and action replies. */
const sent: Sent[] = []
/** The server action id of the "Show token" request, set by the Notifications test. Only its reply may hold the token. */
let showTokenAction: string | null = null

test.beforeEach(async ({ page }) => {
  const { name, value } = state().cookie
  await page.context().addCookies([{ name, value, url: 'http://127.0.0.1' }])
  page.on('response', async (response) => {
    const request = response.request()
    // A redirect has no body to read.
    const body = ['document', 'fetch', 'xhr'].includes(request.resourceType())
      ? await response.text().catch(() => '')
      : ''
    sent.push({ url: response.url(), action: request.headers()['next-action'] ?? null, body })
  })
})

async function expectNoAxeViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze()
  expect(
    violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}: ${n.any[0]?.message ?? v.help}`))
  ).toEqual([])
}

test('My details: saves details and names, keeps typed values on an error, warns about a short name', async ({
  page
}) => {
  await page.goto('/details')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('My details')
  await expect(page.getByText('Shorter names are not watched', { exact: false })).toBeVisible()
  await expectNoAxeViolations(page)

  // An invalid email stops the save, names its own field and keeps the other values.
  await page.getByLabel('Full name as registered', { exact: true }).fill('Aisyah Binti Rahman')
  await page.getByLabel('University email', { exact: true }).fill('not-an-email')
  await page.getByRole('button', { name: 'Save details' }).click()
  const email = page.getByLabel('University email', { exact: true })
  await expect(email).toHaveAttribute('aria-invalid', 'true')
  await expect(page.locator('#value-university_email-error')).toHaveText(
    'Error: Enter a valid university email address.'
  )
  await expect(email).toHaveAccessibleDescription(/Enter a valid university email address/)
  await expect(page.getByLabel('Full name as registered', { exact: true })).toHaveValue('Aisyah Binti Rahman')
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Nothing was saved')
  await expectNoAxeViolations(page)

  await email.fill('aisyah@student.example.edu')
  await page.getByLabel('Student ID', { exact: true }).fill('A21CS0001')
  await page.getByLabel('Other names for student id, one per line (optional)').fill('Matric No.\nNo. Matrik')
  await page.getByLabel('Detail 1: name').fill('Staff number')
  await page.getByLabel('Detail 1: value').fill('S-778')
  await page.getByLabel('Names, one per line', { exact: true }).fill('Aisyah\nAi')
  await page.getByRole('button', { name: 'Save details' }).click()

  await expect(page).toHaveURL(/\/details\?notice=saved$/)
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'saved but not watched: Ai.' })).toBeVisible()
  await expect(page.getByLabel('Student ID', { exact: true })).toHaveValue('A21CS0001')
  await expect(page.getByLabel('Other names for student id, one per line (optional)')).toHaveValue(
    'Matric No.\nNo. Matrik'
  )
  await expect(page.getByLabel('Detail 1: name')).toHaveValue('staff number')
  await expect(page.getByLabel('Detail 1: value')).toHaveValue('S-778')
  await expect(page.getByLabel('Names, one per line', { exact: true })).toHaveValue(/Aisyah/)
  await expectNoAxeViolations(page)
})

test('Notifications: set up, show the token on request, test ping', async ({ page }) => {
  // An object-prototype name in ?notice= is not a notice: the page loads with no notice box.
  await page.goto('/notifications?notice=__proto__')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Notifications')
  await expect(page.locator('.notice-info')).toHaveCount(0)
  await page.goto('/notifications')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Notifications')
  await expect(page.getByText('Notifications are not set up.')).toBeVisible()
  await expect(page.getByRole('heading', { level: 3, name: 'High priority: you may need to act now' })).toBeVisible()
  await expectNoAxeViolations(page)

  await page.getByRole('button', { name: 'Set up notifications' }).click()
  await expect(page).toHaveURL(/\/notifications\?notice=ready$/)
  const topic = (await page.locator('dd code').nth(1).textContent())!
  expect(topic).toMatch(/^tm-[a-z2-7]{24}$/)
  await expect(page.locator('dd code').first()).toHaveText(state().ntfyOrigin)
  await expect(page.getByRole('heading', { level: 2, name: 'Subscribe on your phone' })).toBeVisible()
  await expect(page.getByRole('listitem').filter({ hasText: 'Install the ntfy app' })).toBeVisible()
  // The token is not in the page before the button is pressed.
  expect(await page.content()).not.toContain(NTFY_TOKEN)
  await expectNoAxeViolations(page)

  // Show token: the token appears, from this click's reply only, which is not cached.
  const showReply = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.request().headers()['next-action'] !== undefined
  )
  await page.getByRole('button', { name: 'Show token' }).click()
  const reply = await showReply
  showTokenAction = reply.request().headers()['next-action']!
  expect(reply.status()).toBe(200)
  expect(reply.headers()['cache-control']).toContain('no-store')
  expect(await reply.text()).toContain(NTFY_TOKEN)
  await expect(page.getByText(NTFY_TOKEN, { exact: true })).toBeVisible()
  await expectNoAxeViolations(page)
  await page.getByRole('button', { name: 'Hide token' }).click()
  await expect(page.getByText(NTFY_TOKEN, { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'Send a test ping' }).click()
  await expect(page).toHaveURL(/\/notifications\?notice=ping-sent$/)
  await expect(page.getByRole('status').filter({ hasText: 'The test ping was sent.' })).toBeVisible()
  const pings = (await (await fetch(`${state().ntfyOrigin}/__pings`)).json()) as {
    topic: string
    title: string
    auth: string
  }[]
  expect(pings).toEqual([{ topic, title: 'TolongMeeting test', auth: `Bearer ${NTFY_TOKEN}` }])
  await expectNoAxeViolations(page)

  // Setting up again changes nothing: the member keeps the same topic.
  await page.goto('/notifications')
  await expect(page.locator('dd code').nth(1)).toHaveText(topic)
  expect(await page.content()).not.toContain(NTFY_TOKEN)
})

test('AI keys: add a failing key, replace it, add and remove ModelScope, remove the DashScope key', async ({
  page
}) => {
  await page.goto('/ai-keys')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('AI keys')
  await expect(page.getByText('No DashScope key is saved.')).toBeVisible()
  await expect(page.getByText('Alibaba keeps prompts and responses for up to 30 days', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Test again' })).toHaveCount(0)
  await expectNoAxeViolations(page)

  // A malformed key is stopped before it is sent anywhere, on its own field.
  await page.getByLabel('DashScope key', { exact: true }).fill('short')
  await page.getByRole('button', { name: 'Add the DashScope key' }).click()
  await expect(page.locator('#dashscope-key-error')).toHaveText(
    'Error: Enter a key of 8 to 200 characters with no spaces.'
  )
  await expect(page.getByLabel('DashScope key', { exact: true })).toHaveAttribute('aria-invalid', 'true')
  await expectNoAxeViolations(page)

  // A key the provider rejects is saved, and the page says it is failing and why.
  await page.getByLabel('DashScope key', { exact: true }).fill(BAD_KEY)
  await page.getByRole('button', { name: 'Add the DashScope key' }).click()
  await expect(page).toHaveURL(/\/ai-keys\?notice=saved-failing$/)
  await expect(page.getByText('Failing.')).toBeVisible()
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'DashScope rejected the key. Check it is a Singapore'
  )
  await expect(page.getByText('0000', { exact: true })).toBeVisible()
  await expectNoAxeViolations(page)

  // A working key replaces it. It is shown masked, with the time of the test.
  await page.getByLabel('Replace the DashScope key').fill(GOOD_KEY)
  await page.getByRole('button', { name: 'Save and test' }).click()
  await expect(page).toHaveURL(/\/ai-keys\?notice=saved$/)
  await expect(page.getByText('Saved key ending in').first()).toContainText('4242')
  await expect(page.getByText('Working. Last tested')).toBeVisible()
  await expect(page.getByLabel('Replace the DashScope key')).toHaveValue('')
  await expectNoAxeViolations(page)

  await page.getByLabel('ModelScope key', { exact: true }).fill(MODELSCOPE_KEY)
  await page.getByRole('button', { name: 'Add the ModelScope key' }).click()
  await expect(page.getByText('7777', { exact: true })).toBeVisible()
  await expect(page.getByText('4242', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Test again' }).click()
  await expect(page).toHaveURL(/\/ai-keys\?notice=tested$/)

  // Removing the ModelScope key asks first, and keeps the DashScope key.
  await page.getByText('Remove the ModelScope key', { exact: true }).click()
  await expect(page.getByText('Your DashScope key stays.')).toBeVisible()
  await expectNoAxeViolations(page)
  await page.getByRole('button', { name: 'Yes, remove the key' }).click()
  await expect(page).toHaveURL(/\/ai-keys\?notice=removed-modelscope$/)
  await expect(page.getByText('No ModelScope key is saved.')).toBeVisible()
  await expect(page.getByText('4242', { exact: true })).toBeVisible()

  await page.getByText('Remove the DashScope key', { exact: true }).click()
  await page.getByRole('button', { name: 'Yes, remove the key' }).click()
  await expect(page).toHaveURL(/\/ai-keys\?notice=removed-dashscope$/)
  await expect(page.getByText('No DashScope key is saved.')).toBeVisible()
  await expect(page.getByText('4242', { exact: true })).toHaveCount(0)
  await expectNoAxeViolations(page)
})

test('no key, token or secret appears in any page, redirect or other action reply', async ({ page }) => {
  // Visit every page the member can reach after the steps above, and add a key once more so it is in the database.
  await page.goto('/ai-keys')
  await page.getByLabel('DashScope key', { exact: true }).fill(GOOD_KEY)
  await page.getByRole('button', { name: 'Add the DashScope key' }).click()
  await expect(page.getByText('Working. Last tested')).toBeVisible()
  const pages = ['/', '/details', '/notifications', '/ai-keys']
  const html: string[] = []
  for (const path of pages) {
    await page.goto(path)
    html.push(await page.content())
  }
  // Only the Show token reply may hold the ntfy token. Every other response must be free of every secret.
  const isShowToken = (s: Sent) => showTokenAction !== null && s.action === showTokenAction
  const replies = sent.map((s) => (isShowToken(s) ? s.body.replaceAll(NTFY_TOKEN, '') : s.body))
  const everything = [...html, ...sent.map((s) => s.url), ...replies].join('\n')
  for (const secret of SECRETS) expect(everything, secret).not.toContain(secret)
  expect(sent.some((s) => isShowToken(s) && s.body.includes(NTFY_TOKEN))).toBe(true)
})
