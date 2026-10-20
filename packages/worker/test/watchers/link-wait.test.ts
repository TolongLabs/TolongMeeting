import { expect, test } from 'bun:test'
import { decideLinkWait, GIVE_UP_AFTER_MS, JOIN_FROM_MS } from '../../src/watchers/link-wait'

const T = new Date('2026-10-21T06:00:00Z')
const at = (min: number) => new Date(T.getTime() + min * 60_000)
const L = 'https://example.zoom.us/j/00000000001'

test.each([
  [-60, L, false, { kind: 'wait' }],
  [-10, L, false, { kind: 'join', url: L }],
  [-1, null, false, { kind: 'wait' }],
  [0, null, false, { kind: 'ping_no_link' }],
  [5, null, true, { kind: 'wait' }],
  [29.99, null, true, { kind: 'wait' }],
  [30, null, true, { kind: 'give_up' }],
  [30, L, true, { kind: 'join', url: L }]
] as const)('at T + %p min, link %p, pinged %p', (min, link, noLinkPinged, want) =>
  expect(decideLinkWait({ now: at(min), start: T, link, noLinkPinged })).toEqual(want)
)

test('a link just before the join time waits; no link at the give-up time gives up even if never pinged', () => {
  expect(
    decideLinkWait({ now: new Date(T.getTime() - JOIN_FROM_MS - 1), start: T, link: L, noLinkPinged: false })
  ).toEqual({ kind: 'wait' })
  expect(
    decideLinkWait({ now: new Date(T.getTime() + GIVE_UP_AFTER_MS), start: T, link: null, noLinkPinged: false })
  ).toEqual({ kind: 'give_up' })
})
