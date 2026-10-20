import { readFileSync } from 'node:fs'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { LINK_PASSCODE, LIVE_ZOOM_ID, UPLOADING_PASSCODE, UPLOADING_ZOOM_ID } from './seed-meetings'
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

/** Waits until React owns the element, so a click is not lost to hydration. */
async function hydrated(locator: Locator) {
  await expect
    .poll(() => locator.evaluate((el) => Object.keys(el).some((key) => key.startsWith('__reactFiber'))))
    .toBe(true)
}

const meetings = () => state().meetings

/**
 * The seeded admin has a connection row with a placeholder token, which the connections route cannot open. The panel
 * tests answer that route themselves; the exports route is the real one unless a test says otherwise.
 */
async function connectionsAre(page: Page, connections: unknown[]) {
  await page.route('**/api/connections', (route) => route.fulfill({ json: { connections } }))
}

test.describe('a completed meeting', () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page, 'admin')
  })

  test('shows the summary, attendance, forms, transcript, slides, chat and timeline', async ({ page }) => {
    await page.goto(`/meetings/${meetings().completed}`)
    await expect(page).toHaveTitle('Meeting | TolongMeeting')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Algorithms')
    await expect(page.getByRole('main')).toContainText('Completed.')

    await expect(page.getByRole('main')).toContainText('Attendance: submitted.')

    const summary = page.locator('section[aria-labelledby="summary"]')
    await expect(summary.getByRole('heading', { level: 2 })).toHaveText('Summary')
    await expect(summary).toContainText('Do next: Submit problem set 3 by Fri 23 Oct, 23:59.')

    const forms = page.locator('section[aria-labelledby="forms"]')
    await expect(forms).toContainText('Submitted.')
    await expect(forms).toContainText('Fields filled: full_name, student_id.')
    await expect(forms).toContainText('Not submitted: the sender is not trusted')
    await expect(forms.getByRole('img')).toHaveCount(2)
    await expect(forms.getByRole('img', { name: 'Screenshot 1 of 2 of this form' })).toBeVisible()

    const transcript = page.locator('section[aria-labelledby="transcript"]')
    const skipTranscript = transcript.getByRole('link', { name: 'Skip transcript' })
    await expect(skipTranscript).toBeVisible()
    await expect(skipTranscript).toHaveAttribute('href', '#slides')
    const listItems = transcript.locator('ol.transcript > li')
    await expect(listItems).toHaveCount(3)
    await expect(listItems.first().getByRole('button', { name: 'Play the video from 00:00:05' })).toBeVisible()
    await expect(transcript).toContainText('Today we cover Mergesort')
    await expect(transcript).toContainText('(as heard: “merge sword”)')
    await expect(transcript).toContainText('Note: Recording gap of 2 minutes.')
    await expect(transcript.getByRole('button', { name: 'Play the video from 00:00:05' })).toBeVisible()
    await expect(page.locator('video#meeting-video')).toHaveAttribute(
      'src',
      `/api/meetings/${meetings().completed}/files/recording/meeting.mp4`
    )

    // SeekButton handles play() promise rejection (AbortError/NotAllowedError) without error
    await page.evaluate(() => {
      const v = document.getElementById('meeting-video') as HTMLVideoElement
      if (v) {
        v.play = () =>
          Promise.reject(new DOMException('The play() request was interrupted by a new load request.', 'AbortError'))
      }
    })
    await transcript.getByRole('button', { name: 'Play the video from 00:00:05' }).click()

    const slides = page.locator('section[aria-labelledby="slides"]')
    await expect(slides.getByRole('heading', { level: 3, name: 'Slide 1: Merge sort' })).toBeVisible()
    await expect(slides).toContainText('Split, sort each half, merge.')
    await expect(slides.getByRole('heading', { level: 3, name: 'Slide 2' })).toBeVisible()
    await expect(slides).toContainText('The text of this slide could not be read.')

    const chat = page.locator('section[aria-labelledby="chat"]')
    await expect(chat).toContainText('Attendance form: see the QR code.')

    const timeline = page.locator('section[aria-labelledby="timeline"]')
    await expect(timeline).toContainText('The bot joined the meeting.')
    await expect(timeline).toContainText('A step failed: chat watcher.')
  })

  test('the summary and chat are Markdown without raw HTML, and the timeline shows no free text', async ({ page }) => {
    await page.goto(`/meetings/${meetings().completed}`)
    const main = page.getByRole('main')
    await expect(main.getByRole('link', { name: 'the course page' })).toHaveAttribute(
      'href',
      'https://example.edu/algorithms'
    )
    // A javascript: link keeps its words and loses the link.
    await expect(main).toContainText('click here')
    await expect(main.getByRole('link', { name: 'click here' })).toHaveCount(0)
    await expect(main.locator('a[href^="javascript:"]')).toHaveCount(0)
    await expect(main.locator('script, b, img[src="x"]')).toHaveCount(0)
    expect(await page.evaluate(() => 'hacked' in window)).toBe(false)
    const html = await page.content()
    expect(html).not.toContain('Boom')
    expect(html).not.toMatch(/EVENTPASS|99999999999|pwd=/)
  })

  test('has no accessibility violations', async ({ page }) => {
    await connectionsAre(page, [])
    await page.goto(`/meetings/${meetings().completed}`)
    await expect(page.getByRole('button', { name: 'Download PDF' })).toBeVisible()
    await expectNoAxeViolations(page)
  })

  test('delete now asks first and does nothing until it is confirmed', async ({ page }) => {
    await page.goto(`/meetings/${meetings().completed}`)
    const question = page.getByText('Delete this meeting and everything saved for it?')
    await expect(question).toBeHidden()
    await page.getByText('Delete now', { exact: true }).click()
    await expect(question).toBeVisible()
    await expect(page.getByRole('button', { name: 'Yes, delete this meeting' })).toBeVisible()
    await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/)
    await expectNoAxeViolations(page)
  })

  test('the recording is served in ranges, to its owner only', async ({ page }) => {
    const url = `/api/meetings/${meetings().completed}/files/recording/meeting.mp4`
    const partial = await page.request.get(url, { headers: { range: 'bytes=0-9' } })
    expect(partial.status()).toBe(206)
    expect(partial.headers()['content-range']).toBe('bytes 0-9/2048')
  })

  test('the export panel offers each target and says why one is disabled', async ({ page }) => {
    await connectionsAre(page, [])
    await page.goto(`/meetings/${meetings().completed}`)
    const panel = page.locator('section[aria-labelledby="export-heading"]')
    await expect(panel.getByRole('button', { name: 'Download Markdown (.zip)' })).toBeEnabled()
    await expect(panel.getByRole('button', { name: 'Download PDF' })).toBeEnabled()
    for (const [name, hint] of [
      ['Export to GitHub', 'Connect GitHub on the Connections page.'],
      ['Export to Google Docs', 'Connect Google Docs on the Connections page.'],
      ['Export to Notion', 'Connect Notion on the Connections page.']
    ] as const) {
      const button = panel.getByRole('button', { name })
      await expect(button).toBeDisabled()
      await expect(button).toHaveAccessibleDescription(hint)
    }
  })

  test('the export panel lists replaced and failed exports with their fixed messages', async ({ page }) => {
    const id = meetings().completed
    const row = (over: Record<string, unknown>) => ({
      id: 'x',
      target: 'zip',
      label: 'Markdown zip',
      status: 'succeeded',
      createdAt: '2026-10-19T08:00:00.000Z',
      finishedAt: '2026-10-19T08:01:00.000Z',
      replaced: false,
      url: null,
      downloadUrl: null,
      note: null,
      error: null,
      ...over
    })
    await connectionsAre(page, [
      { kind: 'github', status: 'ok', ready: true, label: 'octo/notes', detail: 'main' },
      { kind: 'google', status: 'reconnect_needed', ready: false, label: 'me@example.com', detail: '' },
      { kind: 'notion', status: 'ok', ready: false, label: 'Notes', detail: '' }
    ])
    await page.route(`**/api/meetings/${id}/exports`, (route) =>
      route.fulfill({
        json: {
          exports: [
            row({ id: 'a', replaced: true, note: 'Replaced by a newer export.' }),
            row({
              id: 'b',
              target: 'github',
              label: 'GitHub',
              status: 'failed',
              createdAt: '2026-10-19T09:00:00.000Z',
              error: 'The service asked us to slow down. Try again in a few minutes.'
            }),
            row({
              id: 'c',
              target: 'pdf',
              label: 'PDF',
              createdAt: '2026-10-19T10:00:00.000Z',
              downloadUrl: '/api/exports/c/file'
            })
          ]
        }
      })
    )
    await page.goto(`/meetings/${id}`)
    const panel = page.locator('section[aria-labelledby="export-heading"]')
    await expect(panel.getByRole('button', { name: 'Export to GitHub' })).toBeEnabled()
    await expect(panel.getByRole('button', { name: 'Export to Google Docs' })).toHaveAccessibleDescription(
      'Reconnect Google Docs on the Connections page.'
    )
    await expect(panel.getByRole('button', { name: 'Export to Notion' })).toHaveAccessibleDescription(
      'Pick a Notion page on the Connections page.'
    )
    const items = panel.getByRole('listitem').filter({ hasText: /Done|Failed/ })
    await expect(items.nth(0)).toContainText('PDF: Done')
    await expect(items.nth(0).getByRole('link', { name: 'Download the PDF file' })).toHaveAttribute(
      'href',
      '/api/exports/c/file'
    )
    await expect(items.nth(1)).toContainText('GitHub: Failed')
    await expect(items.nth(1)).toContainText('The service asked us to slow down. Try again in a few minutes.')
    await expect(items.nth(2)).toContainText('This download was replaced by a newer export, so its file is gone.')
    await expectNoAxeViolations(page)
  })

  test('an export starts from its button and then shows as running', async ({ page }) => {
    await connectionsAre(page, [])
    await page.goto(`/meetings/${meetings().completed}`)
    const zip = page.getByRole('button', { name: 'Download Markdown (.zip)' })
    await expect(zip).toBeEnabled()
    await hydrated(zip)
    await zip.click()
    await expect(zip).toBeDisabled()
    await expect(page.locator('section[aria-labelledby="export-heading"]')).toContainText(
      'Markdown zip: Waiting to start'
    )
    await expect(zip).toHaveAccessibleDescription('Exporting.')
  })

  test('an expired session when exporting shows session ended message', async ({ page }) => {
    await connectionsAre(page, [])
    const id = meetings().completed
    await page.route(`**/api/meetings/${id}/exports`, async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({ status: 401, body: 'Unauthorized' })
      } else {
        await route.fulfill({ json: { exports: [] } })
      }
    })
    await page.goto(`/meetings/${id}`)
    const zip = page.getByRole('button', { name: 'Download Markdown (.zip)' })
    await hydrated(zip)
    await zip.click()
    await expect(page.getByText('Your session has ended. Reload the page and sign in again.')).toBeVisible()
  })

  test('export status changes are announced in an aria-live region', async ({ page }) => {
    const id = meetings().completed
    let pollCount = 0
    await connectionsAre(page, [])
    await page.route(`**/api/meetings/${id}/exports`, (route) => {
      if (route.request().method() === 'GET') {
        pollCount++
        if (pollCount === 1) {
          route.fulfill({
            json: {
              exports: [
                {
                  id: 'ex1',
                  target: 'zip',
                  label: 'Markdown zip',
                  status: 'running',
                  createdAt: new Date().toISOString(),
                  finishedAt: null,
                  replaced: false,
                  url: null,
                  downloadUrl: null,
                  note: null,
                  error: null
                }
              ]
            }
          })
        } else {
          route.fulfill({
            json: {
              exports: [
                {
                  id: 'ex1',
                  target: 'zip',
                  label: 'Markdown zip',
                  status: 'succeeded',
                  createdAt: new Date().toISOString(),
                  finishedAt: new Date().toISOString(),
                  replaced: false,
                  url: null,
                  downloadUrl: '/api/exports/ex1/file',
                  note: null,
                  error: null
                }
              ]
            }
          })
        }
      } else {
        route.continue()
      }
    })
    await page.goto(`/meetings/${id}`)
    const liveRegion = page.locator('div[aria-live="polite"]')
    await expect(liveRegion).toContainText('Markdown zip export finished.')
  })

  test('polling is capped after 15 minutes of running with a note', async ({ page }) => {
    const id = meetings().completed
    await connectionsAre(page, [])
    const sixteenMinutesAgo = new Date(Date.now() - 16 * 60 * 1000).toISOString()
    await page.route(`**/api/meetings/${id}/exports`, (route) => {
      route.fulfill({
        json: {
          exports: [
            {
              id: 'ex-old',
              target: 'zip',
              label: 'Markdown zip',
              status: 'running',
              createdAt: sixteenMinutesAgo,
              finishedAt: null,
              replaced: false,
              url: null,
              downloadUrl: null,
              note: null,
              error: null
            }
          ]
        }
      })
    })
    await page.goto(`/meetings/${id}`)
    await expect(
      page.getByText('An export has been running for 15 minutes. Polling has stopped. Reload the page to check again.')
    ).toBeVisible()
  })
})

test.describe('a meeting that is not finished', () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page, 'admin')
  })

  test('a running meeting offers leave and take over, and never shows its link', async ({ page }) => {
    await page.goto(`/meetings/${meetings().live}`)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Live standup')
    await expect(page.getByRole('main')).toContainText('In the meeting.')
    const live = page.locator('section[aria-labelledby="live"]')
    await expect(live.getByRole('link', { name: 'Make the bot leave' })).toHaveAttribute(
      'href',
      `/meetings/${meetings().live}/leave`
    )
    await expect(live.getByRole('link', { name: 'Take over' })).toHaveAttribute(
      'href',
      `/meetings/${meetings().live}/take-over`
    )
    await expect(page.getByRole('main')).toContainText('Make the bot leave before deleting this meeting.')
    await expect(page.getByText('Delete now', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('main')).toContainText('The summary is not ready yet.')
    await expect(page.getByRole('main')).toContainText('You can export this meeting when it is completed.')
    const html = await page.content()
    expect(html).not.toContain(LINK_PASSCODE)
    expect(html).not.toContain(LIVE_ZOOM_ID)
    await expectNoAxeViolations(page)
  })

  test('the leave page changes nothing until the button is pressed, then waits', async ({ page }) => {
    await page.goto(`/meetings/${meetings().live}/leave`)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Make the bot leave')
    await expect(page.getByRole('main')).toContainText(
      'The bot will leave Live standup and stop recording. What it recorded so far stays on the meeting page.'
    )
    const html = await page.content()
    expect(html).not.toContain(LINK_PASSCODE)
    await expectNoAxeViolations(page)
    const button = page.getByRole('button', { name: 'Make the bot leave' })
    await hydrated(button)
    await button.click()
    const status = page.getByRole('status')
    await expect(status).toContainText('Waiting for the bot to leave…')
    await expect(status).toBeFocused()
    await expectNoAxeViolations(page)
  })

  test('the leave page retries a failed poll before giving up', async ({ page }) => {
    let polls = 0
    await page.route(`**/api/meetings/${meetings().live}/state`, (route) => {
      polls++
      if (polls === 1) route.fulfill({ status: 500, body: 'Error' })
      else route.fulfill({ json: { state: 'left_by_member' } })
    })
    await page.goto(`/meetings/${meetings().live}/leave`)
    const button = page.getByRole('button', { name: 'Make the bot leave' })
    await hydrated(button)
    await button.click()
    await expect(page.getByText('The bot has left the meeting.')).toBeVisible()
    expect(polls).toBeGreaterThanOrEqual(2)
  })

  test('the take-over page warns first and then waits for the bot', async ({ page }) => {
    await page.goto(`/meetings/${meetings().live}/take-over`)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Take over the meeting')
    await expect(page.getByRole('main')).toContainText(
      'The bot will leave Live standup first, then this page opens the meeting for you.'
    )
    const html = await page.content()
    expect(html).not.toMatch(new RegExp(`${LINK_PASSCODE}|${LIVE_ZOOM_ID}`))
    const button = page.getByRole('button', { name: 'Take over now' })
    await hydrated(button)
    await button.click()
    await expect(page.getByRole('status')).toContainText('Waiting for the bot to leave…')
  })

  test('a bot that has already left gives the link from the owner’s response only', async ({ page }) => {
    await page.goto(`/meetings/${meetings().uploading}/take-over`)
    const before = await page.content()
    expect(before).not.toContain(UPLOADING_PASSCODE)
    expect(before).not.toContain(UPLOADING_ZOOM_ID)
    const button = page.getByRole('button', { name: 'Take over now' })
    await hydrated(button)
    await button.click()
    await expect(page.getByText('The bot has already left. You can open the meeting now.')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open the meeting' })).toHaveAttribute(
      'href',
      `https://example.zoom.us/j/${UPLOADING_ZOOM_ID}?pwd=${UPLOADING_PASSCODE}`
    )
    await expectNoAxeViolations(page)
  })

  for (const unsafe of ['javascript:alert(1)', 'http://example.zoom.us/j/22222222222', 'data:text/html,hi']) {
    test(`the take-over page does not open ${unsafe.split(':')[0]}: links`, async ({ page }) => {
      await page.route(/\/meetings\/[0-9a-f-]{36}\/take-over$/, async (route) => {
        if (route.request().method() !== 'POST' || !route.request().headers()['next-action']) return route.continue()
        const response = await route.fetch()
        const body = await response.text()
        expect(body).toContain(UPLOADING_PASSCODE)
        await route.fulfill({
          response,
          body: body.replace(/https:\/\/example\.zoom\.us\/j\/[^"\\]*/, unsafe)
        })
      })
      await page.goto(`/meetings/${meetings().uploading}/take-over`)
      const button = page.getByRole('button', { name: 'Take over now' })
      await hydrated(button)
      await button.click()
      await expect(page.getByText('The bot has left. Open the meeting from where its link was posted.')).toBeVisible()
      await expect(page.getByRole('link', { name: 'Open the meeting' })).toHaveCount(0)
      await expect(
        page.locator('main a[href^="javascript:"], main a[href^="http:"], main a[href^="data:"]')
      ).toHaveCount(0)
    })
  }

  test('a summary stopped by the AI key offers a re-run, which queues it once', async ({ page }) => {
    await page.goto(`/meetings/${meetings().stuck}`)
    await expect(page.getByRole('heading', { level: 2, name: 'The summary stopped' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Fix your AI key' })).toHaveAttribute('href', '/ai-keys')
    await expect(page.getByRole('main')).toContainText('Writing the summary.')
    await expectNoAxeViolations(page)
    const rerun = page.getByRole('button', { name: 'Run the summary again' })
    await hydrated(rerun)
    await rerun.click()
    await expect(page).toHaveURL(/\?notice=rerun$/)
    await expect(page.getByText('The summary is being written again. Reload this page in a few minutes.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Run the summary again' })).toHaveCount(0)
  })

  test('an unknown code in the address is never shown', async ({ page }) => {
    await page.goto(`/meetings/${meetings().stuck}?error=%3Cb%3Eoops%3C%2Fb%3E&notice=oops`)
    await expect(page.getByRole('main')).not.toContainText('oops')
    await expect(page.getByRole('alert').filter({ hasText: 'oops' })).toHaveCount(0)
  })
})

test.describe('who may see a meeting', () => {
  test('another member gets the plain not-found page, and no data', async ({ page }) => {
    await signInAs(page, 'member')
    for (const path of ['', '/leave', '/take-over']) {
      const response = await page.goto(`/meetings/${meetings().completed}${path}`)
      expect(response?.status()).toBe(404)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found')
      expect(await page.content()).not.toContain('Algorithms')
    }
    for (const url of [
      `/api/meetings/${meetings().completed}/files/recording/meeting.mp4`,
      `/api/meetings/${meetings().live}/state`
    ]) {
      expect((await page.request.get(url)).status()).toBe(404)
    }
    await page.goto('/meetings/not-an-id')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found')
  })

  test('a visitor who is signed out is sent to sign in', async ({ page }) => {
    await page.goto(`/meetings/${meetings().completed}`)
    await expect(page).toHaveURL(/\/sign-in$/)
  })
})

test.describe('pasting a meeting link', () => {
  test.beforeEach(async ({ page }) => {
    await signInAs(page, 'admin')
  })

  test('a completed or running meeting does not show the paste form', async ({ page }) => {
    await page.goto(`/meetings/${meetings().completed}`)
    await expect(page.getByRole('heading', { level: 2, name: 'Meeting link' })).toHaveCount(0)

    await page.goto(`/meetings/${meetings().live}`)
    await expect(page.getByRole('heading', { level: 2, name: 'Meeting link' })).toHaveCount(0)
  })

  test('a scheduled meeting offers the paste form, validates the link, and masks secrets', async ({ page }) => {
    await page.goto('/')
    const nextSection = page.locator('section[aria-labelledby="next"]')
    const meetingLink = nextSection.getByRole('link').first()
    const href = await meetingLink.getAttribute('href')
    expect(href).toMatch(/\/meetings\/[0-9a-f-]{36}/)

    await page.goto(href!)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    const formSection = page.locator('section[aria-labelledby="paste-link-heading"]')
    await expect(formSection.getByRole('heading', { level: 2, name: 'Meeting link' })).toBeVisible()

    const linkInput = page.getByRole('textbox', { name: 'Meeting link' })
    await expect(linkInput).toBeVisible()
    await expect(
      page.getByText('A Zoom, Teams or Meet link that starts with https://. Paste the whole link.')
    ).toBeVisible()

    // Submit invalid URL
    await linkInput.fill('http://example.zoom.us/j/12345678901')
    await page.getByRole('button', { name: 'Save link' }).click()

    await expect(page).toHaveURL(/\?error=link_bad$/)
    await expect(page.getByRole('main').getByRole('alert')).toContainText('Paste a link that starts with https://.')
    await expect(linkInput).toHaveAttribute('aria-invalid', 'true')
    await expect(page.locator('#meeting-link-error')).toHaveText('Error: Paste a link that starts with https://.')

    // Submit valid link with passcode
    const secretPass = 'SUPERSECRETPASS'
    const zoomId = '98765432100'
    await linkInput.fill(`https://example.zoom.us/j/${zoomId}?pwd=${secretPass}`)
    await page.getByRole('button', { name: 'Save link' }).click()

    await expect(page).toHaveURL(/\?notice=link_saved$/)
    await expect(page.getByText('The meeting link was saved.')).toBeVisible()
    await expect(formSection).toContainText(`Current link: example.zoom.us, meeting ${zoomId}.`)

    // Verify secret is NEVER echoed in the HTML
    const content = await page.content()
    expect(content).not.toContain(secretPass)
    await expect(linkInput).toHaveValue('')

    await expectNoAxeViolations(page)
  })
})
