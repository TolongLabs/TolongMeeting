import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'

// The Accounts pages: the identities list, the remote sign-in view and the home connection setup. The member is made
// by `accounts-seed.ts` (their own member, so the shared members of the other specs stay as they are).

interface Seeded {
  memberId: string
  siteDb: string
  cookie: { name: string; value: string }
  deviceId: string
  identities: Record<'main' | 'spare' | 'laptop' | 'remote' | 'desk' | 'slow', string>
}

let siteDb: string | undefined
let fake: ChildProcessByStdio<Writable, Readable, null> | undefined

test.afterEach(() => {
  fake?.kill()
  fake = undefined
})

function seed<T>(...args: string[]): T {
  const env = { ...process.env, ...(siteDb && { SITE_DB: siteDb }) }
  const out = execFileSync('bun', [`${import.meta.dirname}/accounts-seed.ts`, ...args], { encoding: 'utf8', env })
  return JSON.parse(out.trim().split('\n').at(-1)!) as T
}

// The stand-in noVNC server (below) listens on another loopback port; Chromium's local-network check refuses that.
test.use({ launchOptions: { args: ['--disable-features=LocalNetworkAccessChecks'] } })

let seeded: Seeded

test.beforeAll(async ({ baseURL }) => {
  seeded = seed<Seeded>('member', baseURL!)
  siteDb = seeded.siteDb
})

test.beforeEach(async ({ page }) => {
  await page.context().addCookies([{ ...seeded.cookie, url: 'http://127.0.0.1' }])
})

async function expectNoAxeViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze()
  expect(
    violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}: ${n.any[0]?.message ?? v.help}`))
  ).toEqual([])
}

/** Waits until React owns the element, so a click is not lost to hydration. */
async function hydrated(locator: Locator) {
  await expect
    .poll(() => locator.evaluate((el) => Object.keys(el).some((key) => key.startsWith('__reactProps'))))
    .toBe(true)
}

/** One identity's block on the Accounts page. */
const identity = (page: Page, name: string) => page.getByRole('region', { name, exact: true })

test.describe('the accounts list', () => {
  test('shows each identity with its account states, last check and sign-in button', async ({ page }) => {
    await page.goto('/accounts')
    await expect(page).toHaveTitle('Accounts | TolongMeeting')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Accounts')
    await expect(
      page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Accounts' })
    ).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('main').getByRole('status').first()).toContainText(
      "WhatsApp and Discord don't allow automated use of personal accounts."
    )

    const main = identity(page, 'Main')
    const row = (account: string) =>
      main.getByRole('row').filter({ has: page.getByRole('rowheader', { name: account }) })
    await expect(row('Zoom')).toContainText('Signed in')
    await expect(row('Zoom').locator('time')).toHaveAttribute('datetime', /^20\d\d-/)
    await expect(row('Google')).toContainText('Signed out')
    await expect(row('Microsoft')).toContainText('Not checked yet')
    await expect(row('Microsoft')).toContainText('Never')
    await expect(main.getByRole('status').filter({ hasText: 'Google is signed out.' })).toContainText(
      'Meetings that need it will not start'
    )
    await expect(main.getByRole('link', { name: 'Sign in again to Main' })).toHaveAttribute(
      'href',
      `/accounts/${seeded.identities.main}/signin`
    )
    await expect(main).toContainText('WhatsApp is watched only for accounts that run at home or on your PC.')
    await expect(main.getByText('The server', { exact: true })).toBeVisible()
    await expect(main.getByRole('link', { name: 'set up your home connection' })).toHaveAttribute(
      'href',
      '/accounts/home'
    )

    await expect(identity(page, 'Spare').getByRole('link', { name: 'Sign in to Spare' })).toBeVisible()
    await expect(identity(page, 'Laptop')).toContainText('My PC (Test laptop,')
    await expect(identity(page, 'Laptop').getByRole('button', { name: 'Sign in on my PC' })).toBeVisible()
    await expect(identity(page, 'Remote')).toContainText('The server, through your home connection')
    await expect(identity(page, 'Remote')).toContainText(
      'Remote sign-in is only for identities that run on the server.'
    )
    await expectNoAxeViolations(page)
  })

  test('a move to my PC is refused while a meeting is about to start, and the refusal says why', async ({ page }) => {
    await page.goto('/accounts')
    const main = identity(page, 'Main')
    await main.getByText('Move to my PC Test laptop').click()
    await main.getByRole('button', { name: 'Move to Test laptop' }).click()
    await expect(page).toHaveURL(/problem=move_busy/)
    const alert = identity(page, 'Main').getByRole('alert')
    await expect(alert).toContainText('This identity has a meeting or sign-in that has not finished.')
    await expect(alert).toContainText('A meeting that starts within 75 minutes also blocks a move.')
    await expect(identity(page, 'Main').getByText('The server', { exact: true })).toBeVisible()
    await expectNoAxeViolations(page)
  })

  test('a free identity moves to my PC, then asks the PC to open the sign-in', async ({ page }) => {
    await page.goto('/accounts')
    const spare = identity(page, 'Spare')
    await spare.getByText('Move to my PC Test laptop').click()
    await spare.getByRole('button', { name: 'Move to Test laptop' }).click()
    await expect(page).toHaveURL(/notice=moved/)
    await expect(identity(page, 'Spare').getByRole('status').first()).toContainText('The identity was moved.')
    await expect(identity(page, 'Spare')).toContainText('My PC (Test laptop,')

    seed('touch', seeded.deviceId)
    await page.goto('/accounts')
    const open = identity(page, 'Laptop').getByRole('button', { name: 'Sign in on my PC' })
    await hydrated(open)
    await open.click()
    await expect(identity(page, 'Laptop').getByRole('status')).toContainText(
      'Opened on Test laptop. Finish signing in in the TolongMeeting window on that PC'
    )
  })

  test('adds, refuses a duplicate, and deletes an identity after a second step', async ({ page }) => {
    await page.goto('/accounts')
    const add = page.getByRole('region', { name: 'Add an identity' })
    await add.getByLabel('Name', { exact: true }).fill('Main')
    await add.getByRole('button', { name: 'Add identity' }).click()
    await expect(add.getByText('Error: You already have an identity with this name.')).toBeVisible()
    await expectNoAxeViolations(page)

    await add.getByLabel('Name', { exact: true }).fill('Temp')
    await add.getByRole('button', { name: 'Add identity' }).click()
    await expect(page).toHaveURL(/notice=created/)
    await expect(page.getByRole('status').filter({ hasText: 'The identity was added.' })).toBeVisible()

    const temp = identity(page, 'Temp')
    await temp.getByText('Delete Temp', { exact: true }).click()
    await expect(
      temp.getByText('Its past meetings, with their recordings and summaries', { exact: false })
    ).toBeVisible()
    await temp.getByRole('button', { name: 'Delete this identity' }).click()
    await expect(page).toHaveURL(/notice=deleted/)
    await expect(page.getByRole('region', { name: 'Temp', exact: true })).toHaveCount(0)
  })
})

test.describe('the sign-in page', () => {
  test('renders its idle state with the list, the notes and a Start button', async ({ page }) => {
    const response = await page.goto(`/accounts/${seeded.identities.main}/signin`)
    await expect(page).toHaveTitle('Sign in to your accounts | TolongMeeting')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in: Main')
    await expect(page.getByRole('list').filter({ hasText: 'Zoom: sign in at zoom.us.' })).toContainText('Teams')
    await expect(page.getByRole('main')).toContainText("This view shows only the unrecorded side of the bot's screen.")
    await expect(page.getByRole('main')).toContainText('It closes after 15 minutes without input.')
    await expect(page.getByRole('main')).toContainText('Press Start to open the view.')
    await expect(page.getByRole('button', { name: 'Start sign-in' })).toBeVisible()
    await expect(page.locator('canvas')).toHaveCount(0)
    const csp = response!.headers()['content-security-policy']
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    await expectNoAxeViolations(page)
  })

  test('an identity on my PC hands off to the desktop app; one at home explains the rule', async ({ page }) => {
    await page.goto(`/accounts/${seeded.identities.laptop}/signin`)
    await expect(page.getByRole('main')).toContainText('Test laptop')
    await expect(page.getByRole('button', { name: 'Sign in on my PC' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start sign-in' })).toHaveCount(0)
    await expectNoAxeViolations(page)

    await page.goto(`/accounts/${seeded.identities.remote}/signin`)
    await expect(page.getByRole('status')).toContainText(
      'Remote sign-in is only for identities that run on the server.'
    )
    await expectNoAxeViolations(page)
  })

  test('an unknown identity is a plain 404', async ({ page }) => {
    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-an-id']) {
      const response = await page.goto(`/accounts/${id}/signin`)
      expect(response?.status()).toBe(404)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found')
    }
  })

  test('opens noVNC on the member-checked WebSocket path, shows the live view, and a lost connection says so', async ({
    page
  }) => {
    const { sessionId, secret } = seed<{ sessionId: string; secret: string }>(
      'session',
      seeded.identities.desk,
      'ready'
    )
    const problems: string[] = []
    page.on('console', (m) => void (/content security policy|refused to/i.test(m.text()) && problems.push(m.text())))
    const urls: string[] = []
    page.on('request', (r) => urls.push(r.url()))

    // Caddy and the worker are not part of this site, so the page's `/vnc/...` WebSocket is pointed at a stand-in noVNC
    // server (the page still builds and opens the real address; only the host is swapped, in the browser).
    fake = spawn('bun', [`${import.meta.dirname}/fake-vnc.ts`], { stdio: ['pipe', 'pipe', 'inherit'] })
    const { port } = JSON.parse(
      await new Promise<string>((resolve) => fake!.stdout.once('data', (d) => resolve(String(d))))
    ) as {
      port: number
    }
    await page.addInitScript((fakePort) => {
      const Real = window.WebSocket
      const opened: string[] = []
      Object.assign(window, { __opened: opened })
      // A plain function that returns the real socket: noVNC wants the browser's own WebSocket class.
      const Swapped = function (url: string | URL, protocols?: string | string[]) {
        const target = new URL(url)
        opened.push(target.toString())
        if (target.pathname.startsWith('/vnc/')) target.host = `127.0.0.1:${fakePort}`
        return new Real(target.toString(), protocols)
      } as unknown as typeof WebSocket
      Object.assign(Swapped, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, prototype: Real.prototype })
      window.WebSocket = Swapped
    }, port)
    // The page's policy lets it talk to its own origin only. Everything else stays as the site sends it, so noVNC runs
    // under the real policy; only the stand-in server is added to `connect-src`.
    await page.route(/\/accounts\/[^/]+\/signin$/, async (route) => {
      const response = await route.fetch()
      const policy = response
        .headers()
        ['content-security-policy']!.replace("connect-src 'self'", `connect-src 'self' ws://127.0.0.1:${port}`)
      await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy } })
    })

    await page.goto(`/accounts/${seeded.identities.desk}/signin`)
    const start = page.getByRole('button', { name: 'Start sign-in' })
    await hydrated(start)
    await start.click()
    const main = page.getByRole('main')
    await expect(main).toContainText('Sign in to your accounts in the view below. Press Done when you have finished.')
    await expect(page.getByRole('group', { name: "Remote view of the bot's browser" }).locator('canvas')).toBeVisible()
    const sockets = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)
    expect(sockets).toEqual([
      expect.stringMatching(new RegExp(`^ws://127\\.0\\.0\\.1:\\d+/vnc/${sessionId}/websockify$`))
    ])
    // The view's password is never in the page, a URL or the socket address.
    expect(await page.content()).not.toContain(secret)
    expect([...urls, ...sockets].filter((u) => u.includes(secret))).toEqual([])
    await expectNoAxeViolations(page)

    fake!.stdin.write('close\n')
    await expect(main.getByRole('alert')).toContainText('The connection to the view was lost.')
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
    expect(problems).toEqual([])
    expect(await page.content()).not.toContain(secret)
  })

  test('a view that never starts times out with a next step', async ({ page }) => {
    await page.clock.install()
    await page.goto(`/accounts/${seeded.identities.slow}/signin`)
    const start = page.getByRole('button', { name: 'Start sign-in' })
    await hydrated(start)
    await start.click()
    await expect(
      page.getByRole('main').getByRole('status').filter({ hasText: 'Starting the sign-in view.' })
    ).toBeVisible()
    await page.clock.fastForward(130_000)
    await expect(page.getByRole('main').getByRole('alert')).toContainText('The sign-in view did not start in time.')
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
    await expectNoAxeViolations(page)
  })
})

test.describe('the home connection', () => {
  test('explains the setup, and says so when this server has no Tailscale', async ({ page }) => {
    await page.goto('/accounts/home')
    await expect(page).toHaveTitle('Home connection | TolongMeeting')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home connection')
    await expect(page.getByRole('main')).toContainText('No home device is set up yet.')
    await expect(page.getByRole('main')).toContainText("TolongMeeting can't reach other devices on your home network")
    await expectNoAxeViolations(page)

    const create = page.getByRole('button', { name: 'Create setup key' })
    await hydrated(create)
    await create.click()
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'Home connection setup is not available on this server.'
    )
  })

  test('shows a setup key once with its commands, and the key is gone after a reload', async ({ page }) => {
    const KEY = 'tskey-auth-FAKEKEY123-abcdef'
    await page.route('**/api/home-route/key', (route) =>
      route.fulfill({
        json: { key: KEY, hostname: 'tm-home-0123456789abcdef01234567' },
        headers: { 'cache-control': 'no-store' }
      })
    )
    await page.goto('/accounts/home')
    expect(await page.content()).not.toContain(KEY)
    const create = page.getByRole('button', { name: 'Create setup key' })
    await hydrated(create)
    await create.click()
    await expect(page.getByText(KEY).first()).toBeVisible()
    await expect(page.getByText('This key is shown once.')).toBeVisible()
    await expect(page.getByRole('heading', { level: 3, name: 'Windows (administrator terminal)' })).toBeVisible()
    await expect(page.locator('pre').first()).toContainText(
      `tailscale up --auth-key=${KEY} --hostname=tm-home-0123456789abcdef01234567 --advertise-exit-node --unattended`
    )
    await expectNoAxeViolations(page)

    await page.reload()
    await expect(page.getByText(KEY)).toHaveCount(0)
    expect(await page.content()).not.toContain(KEY)
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(KEY)
    await expect(page.getByRole('button', { name: 'Create setup key' })).toBeVisible()
  })

  test('check connection shows ready, offline and not enrolled', async ({ page }) => {
    let status = 'not_enrolled'
    await page.route('**/api/home-route/check', (route) =>
      route.fulfill({ json: { status, hostname: 'tm-home-0123456789abcdef01234567' } })
    )
    await page.goto('/accounts/home')
    const check = page.getByRole('button', { name: 'Check connection' })
    await hydrated(check)
    const expected: Record<string, string> = {
      not_enrolled: 'Not enrolled: no device has joined with your setup key yet.',
      offline: 'Offline: your home device is not connected to Tailscale.',
      not_exit_node: 'Online, but not sharing its connection.',
      ready: 'Ready: your home device is online and sharing its connection.'
    }
    for (const [next, text] of Object.entries(expected)) {
      status = next
      await check.click()
      await expect(page.getByRole('main')).toContainText(text)
    }
    await expectNoAxeViolations(page)
  })

  test('asking for a new key says it forgets the old device', async ({ page }) => {
    seed('home', seeded.memberId)
    await page.goto('/accounts/home')
    await expect(page.getByRole('main')).toContainText('A home device was found ready on')
    await page.getByText('Replace my home device').click()
    await expect(page.getByText('TolongMeeting forgets your current home device now.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Create a new setup key' })).toBeVisible()
    await expectNoAxeViolations(page)
  })
})
