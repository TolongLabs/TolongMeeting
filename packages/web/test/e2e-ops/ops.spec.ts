import { readFileSync } from 'node:fs'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import {
  GITHUB_REPO,
  GITHUB_TOKEN,
  GOOGLE_ACCESS_TOKEN,
  GOOGLE_FOLDER,
  OPS_PORT,
  NOTION_PARENT,
  STATE_FILE,
  type OpsState,
  type Who
} from './state'

const state = (): OpsState => JSON.parse(readFileSync(STATE_FILE, 'utf8'))

async function signInAs(page: Page, who: Who) {
  const { name, value } = state().cookies[who]
  await page.context().addCookies([{ name, value, url: 'http://127.0.0.1' }])
}

async function expectNoAxeViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze()
  expect(
    violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}: ${n.any[0]?.message ?? v.help}`))
  ).toEqual([])
}

/** Messages the browser prints when it refuses something on the page for its Content-Security-Policy. */
function watchCsp(page: Page): string[] {
  const refusals: string[] = []
  page.on('console', (message) => {
    if (/content security policy/i.test(message.text())) refusals.push(message.text())
  })
  page.on('pageerror', (error) => refusals.push(error.message))
  return refusals
}

/** Waits until React has taken over the page, so what the test clicks or types is not lost to hydration. */
async function hydrated(page: Page) {
  await page.waitForFunction(() =>
    Object.keys(document.querySelector('main')?.firstElementChild ?? {}).some((key) => key.startsWith('__react'))
  )
}

test.describe('signed out', () => {
  test('the three pages send a visitor to sign-in', async ({ page }) => {
    for (const path of ['/devices', '/connections', '/admin']) {
      await page.goto(path)
      await expect(page).toHaveURL(/\/sign-in$/)
    }
  })
})

test.describe('devices', () => {
  test.describe.configure({ mode: 'serial' })
  let code = ''
  let deviceToken = ''

  test('a member with no PC sees the steps, and a code that is shown once', async ({ page }) => {
    await signInAs(page, 'member')
    await page.goto('/devices')
    await expect(page).toHaveTitle('Devices | TolongMeeting')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Devices')
    await expect(page.getByRole('heading', { level: 2, name: 'No PC is paired yet' })).toBeVisible()
    await expect(page.getByText('Enter the website address')).toContainText(`http://127.0.0.1:${OPS_PORT}`)
    await expectNoAxeViolations(page)

    await page.getByRole('button', { name: 'Pair a new PC' }).click()
    const shown = page.getByRole('status').filter({ hasText: 'Your pairing code' })
    await expect(shown).toBeVisible()
    code = (await shown.locator('code').innerText()).trim()
    expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/)
    await expect(shown).toContainText('The code works once and stops working at')
    await expect(shown).toContainText('10 minutes')
    await expectNoAxeViolations(page)

    // The code is not on the page after a reload, nor in the address or storage.
    await page.reload()
    expect(await page.content()).not.toContain(code)
    expect(page.url()).not.toContain(code)
  })

  test('a PC that pairs with the code is listed, and the code works once', async ({ page }) => {
    await signInAs(page, 'member')
    const paired = await page.request.post('/api/companion/pair', { data: { code, deviceName: 'Test laptop' } })
    expect(paired.status()).toBe(200)
    deviceToken = ((await paired.json()) as { token: string }).token
    const again = await page.request.post('/api/companion/pair', { data: { code, deviceName: 'Second laptop' } })
    expect(again.status()).toBe(400)

    await page.goto('/devices')
    const item = page.getByRole('listitem').filter({ hasText: 'Test laptop' })
    await expect(item).toContainText('Paired')
    await expect(item).toContainText('Not seen yet.')
    const html = await page.content()
    expect(html).not.toContain(deviceToken)
    expect(html).not.toContain(code)
    await expectNoAxeViolations(page)
  })

  test('removing a PC asks first, says what happens to a running job, and then removes it', async ({ page }) => {
    await signInAs(page, 'member')
    await page.goto('/devices')
    await hydrated(page)
    await page.getByText('Remove Test laptop', { exact: true }).click()
    await expect(page.getByText('A meeting that is running on it now is cancelled.')).toBeVisible()
    await expectNoAxeViolations(page)
    await page.getByRole('button', { name: 'Yes, remove this PC' }).click()
    await expect(page).toHaveURL(/\/devices\?notice=revoked$/)
    await expect(page.getByText('The PC is removed. It stops working at once.')).toBeVisible()
    await expect(page.getByRole('heading', { level: 3, name: 'Removed PCs' })).toBeVisible()
    await expect(page.getByRole('listitem').filter({ hasText: 'Test laptop' })).toContainText('Removed')
    await expect(page.getByRole('button', { name: 'Yes, remove this PC' })).toHaveCount(0)
    await expectNoAxeViolations(page)
    // The token of a removed PC no longer opens the device routes.
    const refused = await page.request.get('/api/companion/jobs', {
      headers: { authorization: `Bearer ${deviceToken}` }
    })
    expect(refused.status()).toBe(401)
  })

  test('a member without a notification topic is told to set it up first', async ({ page }) => {
    await signInAs(page, 'admin')
    await page.goto('/devices')
    await expect(page.getByRole('status').filter({ hasText: 'needs your notification topic' })).toBeVisible()
    await page.getByRole('button', { name: 'Pair a new PC' }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'Set up notifications first.' })).toBeVisible()
    await expectNoAxeViolations(page)
  })

  test('an unknown notice says nothing, also one that names a built-in object property', async ({ page }) => {
    await signInAs(page, 'member')
    await page.goto('/devices?notice=%3Cb%3Eoops%3C%2Fb%3E')
    await expect(page.getByRole('main')).not.toContainText('oops')
    for (const key of ['__proto__', 'constructor', 'toString']) {
      const response = await page.goto(`/devices?notice=${key}`)
      expect(response?.status()).toBe(200)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Devices')
    }
  })
})

test.describe('connections', () => {
  test.describe.configure({ mode: 'serial' })

  test('GitHub: a refused token says so, a good one connects, and the token is nowhere in the HTML', async ({
    page
  }) => {
    const csp = watchCsp(page)
    await signInAs(page, 'member')
    await page.goto('/connections')
    await hydrated(page)
    await expect(page).toHaveTitle('Connections | TolongMeeting')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Connections')
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(['GitHub', 'Google Docs', 'Notion'])
    await expect(page.getByText('Status: Not connected.')).toHaveCount(3)
    await expectNoAxeViolations(page)

    // A token GitHub does not accept.
    await page.getByLabel('Repository owner').fill(GITHUB_REPO.owner)
    await page.getByLabel('Repository name').fill(GITHUB_REPO.repo)
    await page.getByLabel('Branch').fill(GITHUB_REPO.branch)
    await page.getByLabel('Folder').fill('meetings')
    await page.getByLabel('Token', { exact: true }).fill('github_pat_WRONGTOKEN')
    await page.getByRole('button', { name: 'Connect GitHub' }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'GitHub rejected this token.' })).toBeVisible()
    await expect(page.getByLabel('Repository owner')).toHaveValue(GITHUB_REPO.owner)
    await expect(page.getByLabel('Token', { exact: true })).toHaveValue('')
    expect(await page.content()).not.toContain('WRONGTOKEN')
    await expectNoAxeViolations(page)

    // The right token.
    await page.getByLabel('Token', { exact: true }).fill(GITHUB_TOKEN)
    await page.getByRole('button', { name: 'Connect GitHub' }).click()
    await expect(page).toHaveURL(/\/connections\?notice=github-saved$/)
    await expect(page.getByText('GitHub is connected. Exports can now go to your repository.')).toBeVisible()
    await expect(page.getByText('Status: Connected. acme/notes. branch main, folder meetings.')).toBeVisible()
    await expect(page.getByLabel('Repository owner')).toHaveValue('acme')
    await expect(page.getByLabel('Folder')).toHaveValue('meetings')
    await expect(page.getByLabel('Replace the token')).toHaveValue('')
    expect(await page.content()).not.toContain(GITHUB_TOKEN)
    await expectNoAxeViolations(page)
    expect(csp).toEqual([])
  })

  test('GitHub: removing it asks first and says to delete the token on GitHub', async ({ page }) => {
    await signInAs(page, 'member')
    await page.goto('/connections')
    await page.getByText('Remove GitHub', { exact: true }).click()
    await expect(page.getByText('delete it yourself under Settings, Developer settings')).toBeVisible()
    await expectNoAxeViolations(page)
    await page.getByRole('button', { name: 'Yes, remove GitHub' }).click()
    await expect(page).toHaveURL(/\/connections\?notice=removed-github$/)
    await expect(page.getByText('Also delete the token on GitHub:')).toBeVisible()
    await expect(page.getByText('Status: Not connected.')).toHaveCount(3)
    expect(await page.content()).not.toContain(GITHUB_TOKEN)
  })

  test('Google and Notion: the Connect buttons point at the sign-in routes, which send the browser to the provider', async ({
    page
  }) => {
    await signInAs(page, 'member')
    await page.goto('/connections')
    const google = page.getByRole('link', { name: 'Connect Google', exact: true })
    const notion = page.getByRole('link', { name: 'Connect Notion', exact: true })
    await expect(google).toHaveAttribute('href', '/api/connections/google/start')
    await expect(notion).toHaveAttribute('href', '/api/connections/notion/start')

    // What the browser does when the link is followed: a same-site GET that is answered with a redirect to the provider
    // and a cookie for the sign-in state. The redirect is read, not followed, so no real provider is called.
    const start = (href: string) =>
      page.request.get(href, { maxRedirects: 0, headers: { 'sec-fetch-site': 'same-origin' } })
    const toGoogle = await start('/api/connections/google/start')
    expect(toGoogle.status()).toBe(302)
    const googleUrl = new URL(toGoogle.headers()['location']!)
    expect(googleUrl.origin + googleUrl.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(googleUrl.searchParams.get('client_id')).toBe('e2e-google-id')
    expect(googleUrl.searchParams.get('redirect_uri')).toBe(
      `http://127.0.0.1:${OPS_PORT}/api/connections/google/callback`
    )
    expect(googleUrl.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file')
    expect(toGoogle.headers()['set-cookie']).toContain('HttpOnly')

    const toNotion = await start('/api/connections/notion/start')
    expect(toNotion.status()).toBe(302)
    const notionUrl = new URL(toNotion.headers()['location']!)
    expect(notionUrl.origin + notionUrl.pathname).toBe('https://api.notion.com/v1/oauth/authorize')
    expect(notionUrl.searchParams.get('client_id')).toBe('e2e-notion-id')

    // The state is in the cookie and in the provider's address, never in the page.
    expect(await page.content()).not.toContain(googleUrl.searchParams.get('state')!)
    // A request from another site is refused.
    expect(
      (
        await page.request.get('/api/connections/google/start', {
          maxRedirects: 0,
          headers: { 'sec-fetch-site': 'cross-site' }
        })
      ).status()
    ).toBe(403)
  })

  test('a sign-in result in the address is read from a short list, never echoed', async ({ page }) => {
    await signInAs(page, 'member')
    await page.goto('/connections?google=google_denied')
    await expect(page.getByText('Google sign-in was cancelled.')).toBeVisible()
    await page.goto('/connections?notion=%3Cb%3Eoops%3C%2Fb%3E')
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'Notion sign-in did not finish. Try connecting again.'
    )
    await expect(page.getByRole('main')).not.toContainText('oops')
    await expectNoAxeViolations(page)
    for (const key of ['__proto__', 'constructor', 'toString']) {
      for (const param of ['notice', 'google', 'notion']) {
        const response = await page.goto(`/connections?${param}=${key}`)
        expect(response?.status()).toBe(200)
        await expect(page.getByRole('heading', { level: 1 })).toHaveText('Connections')
      }
    }
  })

  test('Google: the folder picker gets its token from the server, keeps it in memory and saves the folder', async ({
    page
  }) => {
    const csp = watchCsp(page)
    await signInAs(page, 'linked')
    // Google's script is replaced by a small stand-in that picks `GOOGLE_FOLDER` and records what it was given.
    await page.route('https://apis.google.com/js/api.js', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: `
          window.gapi = { load: (name, done) => done() }
          window.google = { picker: {
            ViewId: { FOLDERS: 'FOLDERS' },
            Action: { PICKED: 'picked', CANCEL: 'cancel' },
            DocsView: class { setSelectFolderEnabled() { return this } setMimeTypes(types) { window.__types = types; return this } },
            PickerBuilder: class {
              setOAuthToken(token) { window.__token = token; return this }
              setDeveloperKey(key) { window.__key = key; return this }
              setAppId(id) { window.__appId = id; return this }
              setOrigin(origin) { window.__origin = origin; return this }
              addView() { return this }
              setCallback(callback) { this.callback = callback; return this }
              build() {
                const callback = this.callback
                return { setVisible: () => setTimeout(() => callback({ action: 'picked', docs: [{ id: '${GOOGLE_FOLDER.id}' }] }), 0), dispose() {} }
              }
            }
          } }`
      })
    )
    await page.goto('/connections')
    await hydrated(page)
    await expect(
      page.getByText('Signed in as linked@example.edu. Exports go to the folder TolongMeeting Exports.')
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Use “TolongMeeting Exports”' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Connect Google', exact: true })).toHaveCount(0)
    await expectNoAxeViolations(page)

    await page.getByRole('button', { name: 'Pick a folder' }).click()
    await expect(page.getByText(`Exports go to the folder ${GOOGLE_FOLDER.name}.`)).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { __token: string }).__token)).toBe(GOOGLE_ACCESS_TOKEN)
    expect(await page.evaluate(() => (window as unknown as { __types: string }).__types)).toBe(
      'application/vnd.google-apps.folder'
    )
    expect(await page.evaluate(() => (window as unknown as { __appId: string }).__appId)).toBe('123456789012')

    // The access token is in the Picker's memory only: not in the page, the address, the cookies or the storage.
    expect(await page.content()).not.toContain(GOOGLE_ACCESS_TOKEN)
    expect(page.url()).not.toContain(GOOGLE_ACCESS_TOKEN)
    expect(JSON.stringify(await page.context().cookies())).not.toContain(GOOGLE_ACCESS_TOKEN)
    expect(await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]))).not.toContain(
      GOOGLE_ACCESS_TOKEN
    )
    expect(csp).toEqual([])

    // Back to the default folder.
    await page.getByRole('button', { name: 'Use “TolongMeeting Exports”' }).click()
    await expect(page).toHaveURL(/\/connections\?notice=folder-default$/)
    await expect(page.getByText('Exports now go to "TolongMeeting Exports" in your Google Drive.')).toBeVisible()
    await expectNoAxeViolations(page)
  })

  test('Notion: the member chooses the page exports go under', async ({ page }) => {
    await signInAs(page, 'linked')
    await page.goto('/connections')
    await hydrated(page)
    await expect(page.getByText('Workspace Lecture workspace. No page is chosen yet.')).toBeVisible()
    await page.getByRole('button', { name: 'Choose a page' }).click()
    await expect(page.getByRole('group', { name: 'Choose where exports go' })).toBeVisible()
    await expectNoAxeViolations(page)
    await page.getByRole('radio', { name: `${NOTION_PARENT.name} (page)` }).check()
    await page.getByRole('button', { name: 'Use this page' }).click()
    await expect(page.getByText(`Workspace Lecture workspace. Exports go under ${NOTION_PARENT.name}.`)).toBeVisible()
    await expectNoAxeViolations(page)
  })

  test('Google: removing it asks first and says what happens at Google', async ({ page }) => {
    await signInAs(page, 'linked')
    await page.goto('/connections')
    await page.getByText('Remove Google', { exact: true }).click()
    await expect(page.getByText('TolongMeeting asks Google to end its access.')).toBeVisible()
    await page.getByRole('button', { name: 'Yes, remove Google' }).click()
    await expect(page).toHaveURL(/\/connections\?notice=removed-google$/)
    await expect(page.getByText('Google is removed, and Google access is revoked.')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Connect Google', exact: true })).toBeVisible()
  })
})

test.describe('admin', () => {
  test('a member who is not an admin gets the not-found page', async ({ page }) => {
    await signInAs(page, 'member')
    const response = await page.goto('/admin')
    expect(response?.status()).toBe(404)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found')
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Admin' })).toHaveCount(0)
    await expectNoAxeViolations(page)
  })

  test('an unknown notice says nothing, also one that names a built-in object property', async ({ page }) => {
    await signInAs(page, 'admin')
    for (const key of ['__proto__', 'constructor', 'toString']) {
      const response = await page.goto(`/admin?notice=${key}`)
      expect(response?.status()).toBe(200)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Admin')
    }
  })

  test('an admin adds a member, changes a role, is refused for the last admin, and removes a member', async ({
    page
  }) => {
    await signInAs(page, 'admin')
    await page.goto('/admin')
    await hydrated(page)
    await expect(page).toHaveTitle('Admin | TolongMeeting')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Admin')
    const members = page.getByRole('listitem').filter({ hasText: 'GitHub:' })
    await expect(members).toHaveCount(3)
    await expect(members.filter({ hasText: 'ops-admin' })).toContainText('Admin')
    await expect(page.getByText('The notification server (ntfy) is set up.')).toBeVisible()
    await expectNoAxeViolations(page)

    // A refused form names the problem and keeps what was typed.
    await page.getByLabel('GitHub username').fill('not a login!')
    await page.getByLabel('Name', { exact: true }).fill('New Person')
    await page.getByRole('button', { name: 'Add member' }).click()
    await expect(page.locator('#github-login-error')).toContainText('Enter a GitHub username')
    await expect(page.getByLabel('GitHub username')).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('New Person')
    await expectNoAxeViolations(page)

    await page.getByLabel('GitHub username').fill('ops-new')
    await page.getByRole('button', { name: 'Add member' }).click()
    await expect(page).toHaveURL(/\/admin\?notice=added$/)
    await expect(page.getByText('Member added. They can now sign in with GitHub.')).toBeVisible()
    const added = members.filter({ hasText: 'ops-new' })
    await expect(added).toContainText('Member.')
    await expect(page.getByLabel('Time zone')).toHaveValue('Asia/Kuala_Lumpur')

    // The same login twice is refused in words.
    await hydrated(page)
    await page.getByLabel('GitHub username').fill('ops-new')
    await page.getByLabel('Name', { exact: true }).fill('Again')
    await page.getByRole('button', { name: 'Add member' }).click()
    await expect(page.locator('#github-login-error')).toContainText('That GitHub login is already a member.')

    // The only admin cannot make themselves a member.
    await page.goto('/admin')
    await members
      .filter({ hasText: 'ops-admin' })
      .getByRole('button', { name: /a member$/ })
      .click()
    await expect(page.getByText('The last admin cannot be removed or made a member.')).toBeVisible()

    // Another member can become an admin, and be removed behind a second step.
    await members
      .filter({ hasText: 'ops-new' })
      .getByRole('button', { name: /an admin$/ })
      .click()
    await expect(page.getByText('The role is changed.')).toBeVisible()
    await expect(members.filter({ hasText: 'ops-new' })).toContainText('Admin.')
    await members.filter({ hasText: 'ops-new' }).locator('summary').click()
    await expect(
      members
        .filter({ hasText: 'ops-new' })
        .getByText(/This deletes their timetable, accounts, summaries and recordings/)
    ).toBeVisible()
    await expectNoAxeViolations(page)
    await page.getByRole('button', { name: 'Yes, remove this member' }).click()
    await expect(page).toHaveURL(/\/admin\?notice=removed$/)
    await expect(page.getByText('Member removed, with their data.')).toBeVisible()
    await expect(members.filter({ hasText: 'ops-new' })).toHaveCount(0)
  })
})
