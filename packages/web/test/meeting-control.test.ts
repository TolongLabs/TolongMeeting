import { expect, test } from 'bun:test'
import type { OccurrenceState } from '@tm/core'
import { CONTROL_COPY, waitUntilLeft } from '../lib/meeting-control'

test('waits until the bot is out of the active states', async () => {
  const states: OccurrenceState[] = ['in_meeting', 'in_meeting', 'left_by_member']
  let calls = 0
  expect(await waitUntilLeft(async () => states[Math.min(calls++, 2)]!, { sleep: async () => {} })).toBe('left')
  expect(calls).toBe(3)
})

test('gives up after the timeout', async () => {
  let t = 0
  expect(
    await waitUntilLeft(async () => 'in_meeting', {
      intervalMs: 1_000,
      timeoutMs: 60_000,
      sleep: async (ms) => void (t += ms)
    })
  ).toBe('timeout')
  expect(t).toBe(60_000)
})

test('a bot that has already left is seen at once', async () => {
  let slept = 0
  expect(await waitUntilLeft(async () => 'completed', { sleep: async () => void slept++ })).toBe('left')
  expect(slept).toBe(0)
})

test('the take-over copy warns before it acts', () => {
  expect(CONTROL_COPY.takeOverIntro).toStartWith('The bot will leave <entry> first')
  expect(CONTROL_COPY.takeOverButton).toBe('Take over now')
})
