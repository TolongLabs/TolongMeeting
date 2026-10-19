import { expect, test } from 'bun:test'
import { HealthMonitor, type HealthAlert, type HealthSample } from '../src/health/health'

const sample = (atMs: number, over: Partial<HealthSample> = {}): HealthSample => ({
  atMs,
  meanLuma: 90,
  diffPrev: 1,
  levelDb: -20,
  participants: 5,
  ...over
})

test('black frames alert once after 10 s and re-arm', () => {
  const got: HealthAlert[] = []
  const m = new HealthMonitor((k) => got.push(k))
  for (let t = 0; t <= 10_000; t += 2000) m.sample(sample(t, { meanLuma: 3, diffPrev: 0 }))
  expect(got).toEqual(['black_frames'])
  m.sample(sample(12_000))
  for (let t = 14_000; t <= 24_000; t += 2000) m.sample(sample(t, { meanLuma: 3, diffPrev: 0 }))
  expect(got).toEqual(['black_frames', 'black_frames'])
})

test('black frames shorter than 10 s do not alert, and a long run alerts only once', () => {
  const got: HealthAlert[] = []
  const m = new HealthMonitor((k) => got.push(k))
  for (let t = 0; t <= 8000; t += 2000) m.sample(sample(t, { meanLuma: 3 }))
  m.sample(sample(10_000))
  expect(got).toEqual([])
  for (let t = 12_000; t <= 60_000; t += 2000) m.sample(sample(t, { meanLuma: 9.9 }))
  expect(got).toEqual(['black_frames'])
})

test('frozen frame plus silence for 5 minutes with participants; a frozen slide alone is normal', () => {
  const got: HealthAlert[] = []
  const m = new HealthMonitor((k) => got.push(k))
  for (let t = 0; t <= 300_000; t += 2000) m.sample(sample(t, { diffPrev: 0.1, levelDb: -25 }))
  expect(got).toEqual([])
  for (let t = 302_000; t <= 602_000; t += 2000) m.sample(sample(t, { diffPrev: 0.1, levelDb: -70, participants: 1 }))
  expect(got).toEqual([])
  for (let t = 604_000; t <= 904_000; t += 2000) m.sample(sample(t, { diffPrev: 0.1, levelDb: -70, participants: 3 }))
  expect(got).toEqual(['frozen_silent'])
})

test('frozen silence needs a known participant count, and one moving sample re-arms it', () => {
  const got: HealthAlert[] = []
  const m = new HealthMonitor((k) => got.push(k))
  for (let t = 0; t <= 600_000; t += 2000) m.sample(sample(t, { diffPrev: 0, levelDb: -90, participants: null }))
  expect(got).toEqual([])
  for (let t = 602_000; t <= 902_000; t += 2000) m.sample(sample(t, { diffPrev: 0, levelDb: -90 }))
  expect(got).toEqual(['frozen_silent'])
  m.sample(sample(904_000, { diffPrev: 3, levelDb: -90 }))
  for (let t = 906_000; t <= 1_206_000; t += 2000) m.sample(sample(t, { diffPrev: 0, levelDb: -90 }))
  expect(got).toEqual(['frozen_silent', 'frozen_silent'])
})
