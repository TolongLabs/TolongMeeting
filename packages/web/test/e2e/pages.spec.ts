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

const ZOOM_MEETING_ID = '12345678901'
const ZOOM_PASSCODE = 'SECRETPW'
const ZOOM_LINK = `https://example.zoom.us/j/${ZOOM_MEETING_ID}?pwd=${ZOOM_PASSCODE}`
const ALL_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** No page of the timetable ever carries a meeting link or its passcode. */
async function expectNoLink(page: Page) {
  const html = await page.content()
  expect(html).not.toContain(ZOOM_PASSCODE)
  expect(html).not.toContain('pwd=')
  expect(html).not.toContain(`/j/${ZOOM_MEETING_ID}`)
}

/** Waits until React has taken over the form, so what the test types is not lost to hydration. */
async function formReady(page: Page) {
  await page.waitForFunction(() => {
    const form = document.querySelector('main form')
    return form !== null && Object.keys(form).some((key) => key.startsWith('__reactFiber'))
  })
}

async function openNewEntry(page: Page) {
  await page.goto('/timetable/new')
  await formReady(page)
}

/** Fills the new-entry form for a lecture that runs every day, with a fixed Zoom link. */
async function fillEveryDayLecture(page: Page, name: string, start: string, end: string) {
  await page.getByLabel('Name', { exact: true }).fill(name)
  for (const day of ALL_DAYS) await page.getByRole('checkbox', { name: day }).check()
  await page.getByLabel('Start time').fill(start)
  await page.getByLabel('Expected end time').fill(end)
  await page.getByLabel('Meeting link').fill(ZOOM_LINK)
}

test.describe('timetable', () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page, 'member')
  })

  test('an empty timetable points to the first entry', async ({ page }) => {
    await page.goto('/timetable')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Timetable')
    await expect(page.getByRole('heading', { level: 2, name: 'No timetable entries yet' })).toBeVisible()
    await expectNoAxeViolations(page)
    await page.getByRole('link', { name: 'Add your first entry' }).click()
    await expect(page).toHaveURL(/\/timetable\/new$/)
  })

  test('a refused form names each problem and ties it to its field', async ({ page }) => {
    await openNewEntry(page)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Add a timetable entry')
    await expect(page.getByText('TolongMeeting records this meeting')).toBeVisible()
    await expectNoAxeViolations(page)
    await page.getByRole('button', { name: 'Add entry' }).click()
    const alert = page.getByRole('main').getByRole('alert')
    await expect(alert).toContainText('The entry was not saved.')
    await expect(alert).toContainText('Enter a name.')
    await expect(alert).toContainText('Choose at least one day.')
    const name = page.getByLabel('Name', { exact: true })
    await expect(name).toHaveAttribute('aria-invalid', 'true')
    await expect(page.locator('#name-error')).toHaveText('Error: Enter a name.')
    await expect(name).toHaveAttribute('aria-describedby', 'name-error')
    await expect(page.getByLabel('Start time')).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByLabel('Meeting link')).toHaveAttribute('aria-invalid', 'true')
    await expectNoAxeViolations(page)
    // What was chosen stays after a refusal.
    await page.getByLabel('Name', { exact: true }).fill('Kept name')
    await page.getByRole('button', { name: 'Add entry' }).click()
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Kept name')
  })

  test('add, list, edit without the link, clash, pause, delete', async ({ page }) => {
    // Add.
    await openNewEntry(page)
    await fillEveryDayLecture(page, 'Data Mining', '14:00', '16:00')
    await page.getByRole('button', { name: 'Add entry' }).click()
    await expect(page).toHaveURL(/\/timetable\?notice=saved$/)
    await expect(page.getByText('Entry saved.')).toBeVisible()

    // Listed, with the host and meeting id of the link and nothing else.
    const item = page.getByRole('listitem').filter({ hasText: 'Data Mining' })
    await expect(item).toContainText('Lecture. Every Monday')
    await expect(item).toContainText('14:00 to 16:00')
    await expect(item).toContainText(`Fixed link on example.zoom.us, meeting ${ZOOM_MEETING_ID}`)
    await expect(item).toContainText('Next session:')
    await expectNoLink(page)
    await expectNoAxeViolations(page)

    // Edit without retyping the link: the form offers to keep it and never shows it.
    await item.getByRole('link', { name: 'Data Mining' }).click()
    await formReady(page)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Edit Data Mining')
    const keep = page.getByRole('radio', { name: /Keep the current link/ })
    await expect(keep).toBeChecked()
    await expect(keep).toHaveAccessibleName(
      `Keep the current link (Fixed link on example.zoom.us, meeting ${ZOOM_MEETING_ID})`
    )
    await expect(page.getByLabel('Meeting link')).toHaveCount(0)
    await expectNoLink(page)
    await expectNoAxeViolations(page)
    await page.getByLabel('Name', { exact: true }).fill('Data Mining II')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page).toHaveURL(/\/timetable\?notice=saved$/)
    const renamed = page.getByRole('listitem').filter({ hasText: 'Data Mining II' })
    await expect(renamed).toContainText(`Fixed link on example.zoom.us, meeting ${ZOOM_MEETING_ID}`)

    // A second entry that overlaps the first on the same identity is saved with a clash warning.
    await openNewEntry(page)
    await fillEveryDayLecture(page, 'Statistics', '15:00', '17:00')
    await page.getByRole('button', { name: 'Add entry' }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'Saved, with a clash' })).toBeVisible()
    await expect(page.getByRole('main').getByText(/Statistics overlaps Data Mining II on/)).toBeVisible()
    await expectNoAxeViolations(page)
    await page.getByRole('link', { name: 'Edit this entry' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Edit Statistics')

    // Pause it from the list, and see the entry say so.
    await page.goto('/timetable')
    await page.getByRole('button', { name: 'Pause Statistics' }).click()
    await expect(page).toHaveURL(/\/timetable\?notice=paused$/)
    const paused = page.getByRole('listitem').filter({ hasText: 'Statistics' })
    await expect(paused).toContainText('Paused: no sessions are scheduled.')
    await expect(paused.getByRole('button', { name: 'Resume Statistics' })).toBeVisible()
    await expectNoAxeViolations(page)

    // Saving an edit keeps it paused, and keeps the link.
    await paused.getByRole('link', { name: 'Statistics' }).click()
    await formReady(page)
    await expect(page.getByRole('heading', { level: 2, name: 'Paused' })).toBeVisible()
    await page.getByLabel('Expected end time').fill('17:30')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByRole('listitem').filter({ hasText: 'Statistics' })).toContainText('Paused: no sessions')
    await expect(page.getByRole('listitem').filter({ hasText: 'Statistics' })).toContainText('15:00 to 17:30')

    // Delete both, each behind a second step.
    for (const name of ['Statistics', 'Data Mining II']) {
      await page.goto('/timetable')
      await page.getByRole('listitem').filter({ hasText: name }).getByRole('link', { name }).click()
      await formReady(page)
      await page.getByText('Delete this entry', { exact: true }).click()
      await expect(page.getByText(`Delete "${name}" and all its future sessions?`)).toBeVisible()
      await expectNoAxeViolations(page)
      await page.getByRole('button', { name: 'Yes, delete this entry' }).click()
      await expect(page).toHaveURL(/\/timetable\?notice=deleted$/)
    }
    await expect(page.getByRole('heading', { level: 2, name: 'No timetable entries yet' })).toBeVisible()
  })

  test('an entry that is not yours, or not an entry, is not found', async ({ page }) => {
    const response = await page.goto('/timetable/00000000-0000-4000-8000-000000000000')
    expect(response?.status()).toBe(404)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found')
    expect((await page.goto('/timetable/not-an-id'))?.status()).toBe(404)
  })
})

test.describe('timetable, signed out', () => {
  test('the pages send a visitor to sign-in', async ({ page }) => {
    for (const path of ['/timetable', '/timetable/new']) {
      await page.goto(path)
      await expect(page).toHaveURL(/\/sign-in$/)
    }
  })
})
