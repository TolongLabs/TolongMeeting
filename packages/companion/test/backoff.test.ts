import { describe, expect, test } from 'bun:test'
import { MAX_RECONNECT_DELAY_MS, reconnectDelayMs } from '../src/backoff'

describe('reconnectDelayMs', () => {
  test('climbs 1, 2, 5, 10 then 30 seconds and stays there (no jitter at the middle of the range)', () => {
    const mid = () => 0.5
    expect([0, 1, 2, 3, 4, 5, 50].map((a) => reconnectDelayMs(a, mid))).toEqual([
      1000, 2000, 5000, 10_000, 30_000, 30_000, 30_000
    ])
  })
  test('jitter spreads each wait over 80 to 120 percent and never beats the cap', () => {
    expect(reconnectDelayMs(0, () => 0)).toBe(800)
    expect(reconnectDelayMs(0, () => 0.999)).toBe(1200)
    expect(reconnectDelayMs(2, () => 0)).toBe(4000)
    for (const random of [0, 0.25, 0.5, 0.75, 0.999]) {
      expect(reconnectDelayMs(4, () => random)).toBeLessThanOrEqual(MAX_RECONNECT_DELAY_MS)
      expect(reconnectDelayMs(99, () => random)).toBeLessThanOrEqual(MAX_RECONNECT_DELAY_MS)
    }
  })
  test('uses real randomness by default', () => {
    const seen = new Set(Array.from({ length: 40 }, () => reconnectDelayMs(1)))
    expect(seen.size).toBeGreaterThan(1)
    for (const ms of seen) expect(ms).toBeGreaterThanOrEqual(1600)
  })
  test('refuses a negative or fractional attempt', () => {
    expect(() => reconnectDelayMs(-1)).toThrow(RangeError)
    expect(() => reconnectDelayMs(1.5)).toThrow(RangeError)
  })
})
