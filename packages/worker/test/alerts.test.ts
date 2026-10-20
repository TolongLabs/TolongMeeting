import { expect, test } from 'bun:test'
import type { EventType } from '@tm/core'
import type { Ping } from '@tm/notify'
import { ALERT_WINDOW_MS, createAlerter } from '../src/alerts'

function setup(send: (p: Ping) => Promise<void> = async () => undefined) {
  let t = Date.parse('2026-10-21T12:00:00Z')
  const sent: string[] = []
  const events: { type: EventType; data: Record<string, unknown> }[] = []
  const alerter = createAlerter({
    entry: 'Data Mining',
    send: async (p) => {
      await send(p)
      sent.push(p.message)
    },
    emit: async (type, data) => void events.push({ type, data }),
    now: () => new Date(t)
  })
  return { alerter, sent, events, advance: (ms: number) => void (t += ms) }
}

test('a ping that cannot be sent is recorded as alert_failed and may be tried again at once', async () => {
  let fail = true
  const { alerter, sent, events } = setup(async () => {
    if (fail) throw new Error('ntfy down https://ntfy.example.com/t?token=SECRET')
  })
  alerter.alert('removed')
  await alerter.idle()
  expect(sent).toEqual([])
  const failed = events.find((e) => e.data.kind === 'alert_failed')!
  expect(failed.type).toBe('alert')
  expect(failed.data).toMatchObject({ failed: 'removed' })
  expect(JSON.stringify(failed.data)).not.toContain('SECRET')
  // The slot was released: no wait for the 10-minute window.
  fail = false
  alerter.alert('removed')
  await alerter.idle()
  expect(sent).toEqual(['The host removed the bot from the meeting.'])
})

test('alerts held back by the window are counted in one event', async () => {
  const { alerter, sent, events, advance } = setup()
  alerter.alert('dropped')
  alerter.alert('dropped')
  advance(1000)
  alerter.alert('dropped')
  await alerter.idle()
  expect(sent).toHaveLength(1)
  expect(events.filter((e) => e.data.kind === 'alerts_suppressed').map((e) => e.data)).toEqual([
    { kind: 'alerts_suppressed', suppressed: 'dropped', count: 2 }
  ])
  advance(ALERT_WINDOW_MS)
  alerter.alert('dropped')
  await alerter.idle()
  expect(sent).toHaveLength(2)
})

test('join_failed and recording_gap are limited per detail', async () => {
  const { alerter, sent } = setup()
  alerter.alert('join_failed', 'goto')
  alerter.alert('join_failed', 'goto')
  alerter.alert('join_failed', 'the account is busy')
  alerter.alert('recording_gap', '5')
  alerter.alert('recording_gap', '9')
  await alerter.idle()
  expect(sent).toEqual([
    "The bot couldn't join: goto.",
    "The bot couldn't join: the account is busy.",
    'The recorder restarted; 5 seconds are missing from the recording.',
    'The recorder restarted; 9 seconds are missing from the recording.'
  ])
})
