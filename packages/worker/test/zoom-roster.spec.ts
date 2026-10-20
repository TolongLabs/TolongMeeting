import { expect, test, type Page } from '@playwright/test'
import { zoomAdapter } from '../src/adapters/zoom'

const drive = (page: Page, name: string, ...args: unknown[]) =>
  page.evaluate(
    ([method, params]) =>
      (window as unknown as { __fixture: Record<string, (...a: unknown[]) => void> }).__fixture[method as string]!(
        ...(params as unknown[])
      ),
    [name, args] as const
  )

test.describe('Zoom roster role rule', () => {
  test('real host trusted when alone', async ({ page }) => {
    await page.goto('/zoom-meeting-top.html?seed=0')
    await drive(page, 'setParticipants', [{ name: 'Dr Example', role: '(Host)' }])
    await drive(page, 'addMessage', {
      sender: 'Dr Example (Host)',
      time: '8:41 PM',
      text: 'Attendance: https://forms.gle/abc'
    })

    const { messages, rosterError } = await zoomAdapter.readChat(page, { seenKeys: [] })
    expect(rosterError).toBeUndefined()
    expect(messages).toHaveLength(1)
    expect(messages[0]!.sender).toBe('Dr Example')
    expect(messages[0]!.senderRole).toBe('host')
  })

  test('spoofer named "Dr Example (Host)" makes both untrusted', async ({ page }) => {
    await page.goto('/zoom-meeting-top.html?seed=0')
    await drive(page, 'setParticipants', [
      { name: 'Dr Example', role: '(Host)' },
      { name: 'Dr Example (Host)', role: '' }
    ])
    await drive(page, 'addMessage', {
      sender: 'Dr Example (Host)',
      time: '8:41 PM',
      text: 'Attendance: https://forms.gle/abc'
    })

    const { messages, rosterError } = await zoomAdapter.readChat(page, { seenKeys: [] })
    expect(rosterError).toBeUndefined()
    expect(messages).toHaveLength(1)
    expect(messages[0]!.senderRole).toBe('unknown')
  })

  test('a name element containing "(Host)" never host', async ({ page }) => {
    await page.goto('/zoom-meeting-top.html?seed=0')
    await drive(page, 'setParticipants', [{ name: 'Student (Host)', role: '(Host)' }])
    await drive(page, 'addMessage', {
      sender: 'Student (Host) (Host)',
      time: '8:41 PM',
      text: 'Attendance: https://forms.gle/abc'
    })

    const { messages, rosterError } = await zoomAdapter.readChat(page, { seenKeys: [] })
    expect(rosterError).toBeUndefined()
    expect(messages).toHaveLength(1)
    expect(messages[0]!.senderRole).toBe('unknown')
  })

  test('unreadable roster gives unknown', async ({ page }) => {
    await page.goto('/zoom-meeting-top.html?seed=0')
    // Remove the participants list element from DOM so the roster read fails
    await page.evaluate(() => document.getElementById('participants-panel')?.remove())
    await drive(page, 'addMessage', {
      sender: 'Dr Example (Host)',
      time: '8:41 PM',
      text: 'Attendance: https://forms.gle/abc'
    })

    const { messages, rosterError } = await zoomAdapter.readChat(page, { seenKeys: [] })
    expect(rosterError).toBeDefined()
    expect(messages).toHaveLength(1)
    expect(messages[0]!.senderRole).toBe('unknown')
  })
})
