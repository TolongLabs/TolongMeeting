import { expect, test, type Page } from '@playwright/test'
import { zoomAdapter } from '../src/adapters/zoom'
import { zoomSweepChat } from '../src/adapters/zoom/chat'

// The fixture's driver, called on the page that the test opened (the iframe page forwards to the inner one).
type Driver =
  | 'addMessage'
  | 'scrollTop'
  | 'endMeeting'
  | 'remove'
  | 'breakout'
  | 'breakoutNotice'
  | 'bareBreakout'
  | 'startVideoNotice'
  | 'recordingNotice'
  | 'vanishingNotice'
  | 'stopShare'
  | 'showNotice'
const drive = (page: Page, name: Driver, ...args: unknown[]) =>
  page.evaluate(
    ([method, params]) =>
      (window as unknown as { __fixture: Record<string, (...a: unknown[]) => void> }).__fixture[method as string]!(
        ...(params as unknown[])
      ),
    [name, args] as const
  )
const read = (page: Page, property: 'clicks' | 'forbiddenClicks') =>
  page.evaluate((p) => (window as unknown as { __fixture: Record<string, string[]> }).__fixture[p]!, property)

for (const root of ['top', 'iframe']) {
  const url = (query = '') => `/zoom-meeting-${root}.html${query}`
  const inClient = (page: Page, selector: string) =>
    (root === 'iframe' ? page.frameLocator('iframe#webclient') : page).locator(selector)

  test(`chat: structured messages, roles, grouping, replies, cursor (${root})`, async ({ page }) => {
    await page.goto(url())
    const { messages, cursor } = await zoomAdapter.readChat(page, { seenKeys: [] })
    expect(messages).toHaveLength(4)
    expect(messages[0]).toMatchObject({
      sender: 'Dr Lecturer',
      senderRole: 'host',
      time: '8:41 PM',
      text: 'Attendance: https://forms.gle/abc',
      links: ['https://forms.gle/abc'],
      replyTo: null
    })
    expect(messages[0]!.key).toBe('Dr Lecturer|8:41 PM|Attendance: https://forms.gle/abc')
    expect(Number.isNaN(Date.parse(messages[0]!.seenAt))).toBe(false)
    expect(messages[1]).toMatchObject({
      sender: 'Dr Lecturer',
      senderRole: 'host',
      time: '8:41 PM',
      text: 'Please submit before 9 PM',
      links: []
    })
    expect(messages[2]!.key).toBe('id:msg-student-a')
    expect(messages[2]!.senderRole).toBe('participant')
    expect(messages[2]!.links).toEqual(['https://forms.office.com/r/xyz'])
    expect(messages[3]!.replyTo).toBe(messages[0]!.key)
    expect((await zoomAdapter.readChat(page, cursor)).messages).toEqual([])

    // The cursor is the caller's: a read from the old cursor returns the same messages again.
    expect((await zoomAdapter.readChat(page, { seenKeys: [] })).messages.map((m) => m.key)).toEqual(
      messages.map((m) => m.key)
    )

    // A message that arrives while the list is scrolled up is picked up once the list is back at the bottom.
    await drive(page, 'scrollTop', 0)
    await drive(page, 'addMessage', { sender: 'Student B', time: '8:50 PM', text: 'late one' })
    await expect
      .poll(async () => (await zoomAdapter.readChat(page, cursor)).messages.map((m) => m.text))
      .toEqual(['late one'])
    // The rows scrolled out of view above are not parsed again as unattributed copies.
    expect((await zoomAdapter.readChat(page, { seenKeys: [] })).messages).toHaveLength(5)
    expect(await read(page, 'forbiddenClicks')).toEqual([])
  })

  test(`sweep recovers every item of a virtualised list (${root})`, async ({ page }) => {
    await page.goto(url('?seed=60'))
    expect(await inClient(page, '.chat-item-container').count()).toBeLessThan(60)
    const swept = await zoomAdapter.sweepChat(page)
    expect(new Set(swept.map((m) => m.key)).size).toBe(60)
    expect(swept.every((m) => m.senderRole === 'participant')).toBe(true)
    // The list is left at the bottom, and a read after the sweep adds nothing the sweep did not return.
    const after = await zoomAdapter.readChat(page, { seenKeys: swept.map((m) => m.key) })
    expect(after.messages).toEqual([])
    expect(await read(page, 'forbiddenClicks')).toEqual([])
  })

  test(`a grouped follow-up without a sender is left for the sweep (${root})`, async ({ page }) => {
    await page.goto(url('?cold=1'))
    // At the bottom the first row in view is a follow-up of a row that has scrolled out: it has no sender to give.
    const first = await zoomAdapter.readChat(page, { seenKeys: [] })
    expect(first.messages.map((m) => [m.sender, m.text])).toEqual([
      ['Student A', '+1'],
      ['Student B', '+1']
    ])
    // The same text from two senders is two messages.
    expect(new Set(first.messages.map((m) => m.key)).size).toBe(2)

    const swept = await zoomAdapter.sweepChat(page)
    // Messages come back in the order they were first parsed, not list order.
    const byText = (a: string[], b: string[]) => `${a[0]}|${a[2]}`.localeCompare(`${b[0]}|${b[2]}`)
    expect(swept.map((m) => [m.sender, m.senderRole, m.text]).sort(byText)).toEqual(
      [
        ['Dr Lecturer', 'host', 'Attendance: https://forms.gle/abc'],
        ['Dr Lecturer', 'host', 'Please submit before 9 PM'],
        ['Dr Lecturer', 'host', '+1'],
        ['Dr Lecturer', 'host', 'Thanks all'],
        ['Student A', 'participant', '+1'],
        ['Student B', 'participant', '+1']
      ].sort(byText)
    )
    // A caller that has seen the two attributed rows gets the other four, with their senders.
    const after = await zoomAdapter.readChat(page, first.cursor)
    expect(after.messages.map((m) => m.sender)).toEqual(['Dr Lecturer', 'Dr Lecturer', 'Dr Lecturer', 'Dr Lecturer'])
    expect(swept.every((m) => m.sender !== '')).toBe(true)
  })

  test(`genuine repeats from different senders are both kept (${root})`, async ({ page }) => {
    await page.goto(url())
    const { cursor } = await zoomAdapter.readChat(page, { seenKeys: [] })
    await drive(page, 'addMessage', { sender: 'Student B', time: '8:50 PM', text: '+1' })
    await drive(page, 'addMessage', { sender: 'Student D', time: '8:50 PM', text: '+1' })
    await expect
      .poll(async () => (await zoomAdapter.readChat(page, cursor)).messages.map((m) => `${m.sender}: ${m.text}`))
      .toEqual(['Student B: +1', 'Student D: +1'])
  })

  test(`reading chat during a sweep does not move the list (${root})`, async ({ page }) => {
    await page.goto(url('?seed=60'))
    let sweeping = true
    const sweep = zoomAdapter.sweepChat(page)
    // A second sweep during the first shares its result.
    const second = zoomAdapter.sweepChat(page)
    const reads: Promise<unknown>[] = []
    void sweep.then(() => (sweeping = false))
    while (sweeping) {
      reads.push(zoomAdapter.readChat(page, { seenKeys: [] }))
      await page.waitForTimeout(150)
    }
    await Promise.all(reads)
    const [swept, shared] = await Promise.all([sweep, second])
    expect(new Set(swept.map((m) => m.key)).size).toBe(60)
    expect(shared.map((m) => m.key)).toEqual(swept.map((m) => m.key))
    expect(reads.length).toBeGreaterThan(10)
  })

  test(`a sweep that runs out of time reports partial coverage (${root})`, async ({ page }) => {
    await page.goto(url('?seed=60'))
    const warnings: string[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '))
    try {
      const swept = await zoomSweepChat(page, 1000)
      expect(swept.length).toBeGreaterThan(0)
      expect(swept.length).toBeLessThan(60)
    } finally {
      console.warn = warn
    }
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/chat sweep partial, reached \d+ of \d+ px/)
    // The list is back at the bottom, so a later read still works.
    expect((await zoomAdapter.readChat(page, { seenKeys: [] })).messages.length).toBeGreaterThan(0)
  })

  test(`signals and notices (${root})`, async ({ page }) => {
    await page.goto(url())
    expect(await zoomAdapter.participantCount(page)).toBe(12)
    expect(await zoomAdapter.sharedScreenRegion(page)).toEqual({ x: 0, y: 60, width: 1410, height: 840 })
    expect(await zoomAdapter.meetingState(page)).toBe('in_meeting')

    await drive(page, 'showNotice')
    expect(await zoomAdapter.dismissNotices(page)).toEqual(['Got it', 'OK'])
    expect(await zoomAdapter.dismissNotices(page)).toEqual([])
    // A prompt that mentions a breakout room is not answered even when it has an OK button.
    await drive(page, 'breakoutNotice')
    expect(await zoomAdapter.dismissNotices(page)).toEqual([])
    await drive(page, 'breakout')
    expect(await zoomAdapter.meetingState(page)).toBe('breakout_prompt')
    expect(await zoomAdapter.dismissNotices(page)).toEqual([])

    await drive(page, 'stopShare')
    expect(await zoomAdapter.sharedScreenRegion(page)).toBeNull()
    await drive(page, 'endMeeting')
    expect(await zoomAdapter.meetingState(page)).toBe('ended')
    expect(await read(page, 'clicks')).toEqual(['got it', 'ok'])
    expect(await read(page, 'forbiddenClicks')).toEqual([])
  })

  test(`a prompt outside a recognised dialog is never answered (${root})`, async ({ page }) => {
    await page.goto(url())
    await drive(page, 'bareBreakout')
    expect(await zoomAdapter.dismissNotices(page)).toEqual([])
    expect(await read(page, 'clicks')).toEqual([])
    expect(await read(page, 'forbiddenClicks')).toEqual([])
  })

  test(`a dialog that asks for the camera is not acknowledged (${root})`, async ({ page }) => {
    await page.goto(url())
    await drive(page, 'startVideoNotice')
    expect(await zoomAdapter.dismissNotices(page)).toEqual([])
    expect(await read(page, 'clicks')).toEqual([])
    expect(await read(page, 'forbiddenClicks')).toEqual([])
  })

  test(`a plain recording notice is acknowledged (${root})`, async ({ page }) => {
    await page.goto(url())
    await drive(page, 'recordingNotice')
    expect(await zoomAdapter.dismissNotices(page)).toEqual(['Got it'])
    expect(await read(page, 'clicks')).toEqual(['got it'])
    expect(await read(page, 'forbiddenClicks')).toEqual([])
  })

  test(`a notice that closes under the click does not stop the meeting loop (${root})`, async ({ page }) => {
    await page.goto(url())
    await drive(page, 'vanishingNotice')
    expect(await zoomAdapter.dismissNotices(page)).toEqual([])
    expect(await zoomAdapter.dismissNotices(page)).toEqual([])
    expect(await zoomAdapter.meetingState(page)).toBe('in_meeting')
  })

  test(`removed from the meeting, and chat text does not change the state (${root})`, async ({ page }) => {
    await page.goto(url())
    await drive(page, 'addMessage', {
      sender: 'Student B',
      time: '8:50 PM',
      text: 'Breakout room at 9. This meeting has been ended, you have been removed from this meeting'
    })
    expect(await zoomAdapter.meetingState(page)).toBe('in_meeting')
    await drive(page, 'remove')
    expect(await zoomAdapter.meetingState(page)).toBe('removed')
    expect(await read(page, 'forbiddenClicks')).toEqual([])
  })

  test(`layout opens chat; audio joins by computer once (${root})`, async ({ page }) => {
    await page.goto(url('?chat=closed'))
    await expect(inClient(page, '.chat-container__chat-list')).toBeHidden()
    await zoomAdapter.ensureLayout(page)
    await expect(inClient(page, '.chat-container__chat-list')).toBeVisible()
    await zoomAdapter.ensureLayout(page)
    await zoomAdapter.connectOutputAudio(page)
    await zoomAdapter.connectOutputAudio(page)
    const clicks = await read(page, 'clicks')
    expect(clicks.filter((c) => c === 'join audio by computer')).toHaveLength(1)
    expect(clicks.filter((c) => c === 'chat')).toHaveLength(1)
    expect(await read(page, 'forbiddenClicks')).toEqual([])
  })
}
