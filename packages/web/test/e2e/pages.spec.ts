import { readFileSync } from 'node:fs'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { STATE_FILE, type E2eState } from './state'

const state = (): E2eState => JSON.parse(readFileSync(STATE_FILE, 'utf8'))

async function signInAs(page: Page, who: 'admin' | 'member') {
  const { name, value } = state().cookies[who]
  await page.context().addCookies([{ name, value, url: 'http://127.0.0.1' }])
}

async function expectNoAxeViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze()
  expect(
    violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}: ${n.any[0]?.message ?? v.help}`))
  ).toEqual([])
}

const NAV = ['Home', 'Timetable', 'Accounts', 'My details', 'Notifications', 'AI keys', 'Devices', 'Connections']

test.describe('signed out', () => {
  test('the sign-in page has a heading, one button and no navigation', async ({ page }) => {
    await page.goto('/sign-in')
    await expect(page).toHaveTitle('Sign in | TolongMeeting')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in to TolongMeeting')
    await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible()
    await expect(page.getByRole('navigation')).toHaveCount(0)
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expectNoAxeViolations(page)
  })

  test('a refused member reads the refusal; an unknown code is not echoed', async ({ page }) => {
    await page.goto('/sign-in?error=NOT_A_MEMBER')
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'Not an active TolongLabs member. Ask an admin to add you.'
    )
    await expectNoAxeViolations(page)
    await page.goto('/sign-in?error=%3Cb%3Eoops%3C%2Fb%3E')
    await expect(page.getByRole('main').getByRole('alert')).toContainText('Sign-in did not work.')
    await expect(page.getByRole('main').getByRole('alert')).not.toContainText('oops')
  })

  test('the button starts the GitHub sign-in', async ({ page }) => {
    await page.route('https://github.com/**', (route) => route.abort())
    await page.goto('/sign-in')
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/auth/sign-in/social')),
      page.getByRole('button', { name: 'Sign in with GitHub' }).click()
    ])
    expect(response.status()).toBe(200)
  })

  test('home sends a signed-out visitor to sign-in', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/sign-in$/)
  })

  test('an unknown page says so in plain words', async ({ page }) => {
    const response = await page.goto('/no-such-page')
    expect(response?.status()).toBe(404)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found')
    await expectNoAxeViolations(page)
  })
})

test.describe('signed in', () => {
  test('home shows the navigation, the meetings and the warnings, in both colour schemes', async ({ page }) => {
    await signInAs(page, 'admin')
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.goto('/')
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home')
      const nav = page.getByRole('navigation', { name: 'Main' })
      await expect(nav.getByRole('link')).toHaveText([...NAV, 'Admin'])
      await expect(nav.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page')
      await expect(page.getByRole('heading', { level: 2, name: 'Next meeting' })).toBeVisible()
      await expect(page.getByRole('link', { name: 'Seed lecture' })).toBeVisible()
      await expect(page.getByRole('link', { name: 'Live standup' })).toBeVisible()
      await expect(page.getByText('In the meeting')).toBeVisible()
      await expect(page.getByText('Notifications are not set up.')).toBeVisible()
      await expect(page.getByText('Old lecture').first()).toContainText('will be deleted within 3 days')
      await expect(page.getByRole('heading', { level: 2, name: 'Recent meetings' })).toBeVisible()
      await expectNoAxeViolations(page)
    }
  })

  test('the first Tab stop is the skip link, and it reaches the content', async ({ page }) => {
    await signInAs(page, 'admin')
    await page.goto('/')
    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/#main$/)
  })

  test('a member who is not an admin has no Admin link, and the page has no empty-state clutter', async ({ page }) => {
    await signInAs(page, 'member')
    await page.goto('/')
    const nav = page.getByRole('navigation', { name: 'Main' })
    await expect(nav.getByRole('link')).toHaveText(NAV)
    await expect(page.getByRole('heading', { level: 2, name: 'No meetings yet' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Add your first timetable entry' })).toHaveAttribute(
      'href',
      '/timetable'
    )
    await expectNoAxeViolations(page)
  })

  test('sign-in sends a signed-in member home, and no page leaks the session', async ({ page }) => {
    await signInAs(page, 'admin')
    await page.goto('/sign-in')
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/)
    const html = await page.content()
    expect(html).not.toContain(decodeURIComponent(state().cookies.admin.value).split('.')[0]!)
    expect(html).not.toMatch(/passcode|pwd=/i)
  })
})
