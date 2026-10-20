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

test('a gap longer than 3 expected intervals restarts a black run, so one sample cannot complete it', () => {
  const got: HealthAlert[] = []
  const m = new HealthMonitor((k) => got.push(k))
  for (let t = 0; t <= 8000; t += 2000) m.sample(sample(t, { meanLuma: 3 }))
  // 22 s of nothing observed: the 8 s of black before it do not count
  m.sample(sample(30_000, { meanLuma: 3 }))
  expect(got).toEqual([])
  for (let t = 32_000; t <= 38_000; t += 2000) m.sample(sample(t, { meanLuma: 3 }))
  expect(got).toEqual([])
  m.sample(sample(40_000, { meanLuma: 3 }))
  expect(got).toEqual(['black_frames'])
})

test('a gap also restarts the 5 minute frozen-silent run', () => {
  const got: HealthAlert[] = []
  const m = new HealthMonitor((k) => got.push(k))
  for (let t = 0; t <= 290_000; t += 2000) m.sample(sample(t, { diffPrev: 0, levelDb: -90 }))
  // a 60 s gap (over 3 x 2 s): the 290 s before it do not count towards the 5 minutes
  m.sample(sample(350_000, { diffPrev: 0, levelDb: -90 }))
  expect(got).toEqual([])
  for (let t = 352_000; t <= 648_000; t += 2000) m.sample(sample(t, { diffPrev: 0, levelDb: -90 }))
  expect(got).toEqual([])
  m.sample(sample(650_000, { diffPrev: 0, levelDb: -90 })) // 300 s after the gap
  expect(got).toEqual(['frozen_silent'])
})

test('the expected interval is configurable: a 20 s gap is within 3 x 10 s and does not restart the run', () => {
  const got: HealthAlert[] = []
  const m = new HealthMonitor((k) => got.push(k), 10_000)
  m.sample(sample(0, { meanLuma: 3 }))
  m.sample(sample(20_000, { meanLuma: 3 }))
  expect(got).toEqual(['black_frames'])
})

test('an unknown sink level (null, the audio source failed) is never silent', () => {
  const got: HealthAlert[] = []
  const m = new HealthMonitor((k) => got.push(k))
  for (let t = 0; t <= 600_000; t += 2000) m.sample(sample(t, { diffPrev: 0, levelDb: null }))
  expect(got).toEqual([])
})

test('the expected interval must be positive', () => {
  expect(() => new HealthMonitor(() => {}, 0)).toThrow(RangeError)
})
