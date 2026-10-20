import { expect, test } from 'bun:test'
import type { Page } from 'playwright'
import { LeaveIncomplete, leaveWithFallback, withPanel } from '../src/adapters/common'

// A page that only counts the times it was closed: the leave fallback needs nothing else of it.
function closablePage(): { page: Page; closed: () => number } {
  let closed = 0
  const page = {
    close: async () => {
      closed += 1
    }
  }
  return { page: page as unknown as Page, closed: () => closed }
}

test.each([
  ['a Playwright timeout', Object.assign(new Error('Timeout 10000ms exceeded'), { name: 'TimeoutError' })],
  ['a failed Playwright call', new Error('locator.click: Target page, context or browser has been closed')],
  ['no end screen', new LeaveIncomplete('meet')]
])('%s closes the page and ends the leave quietly', async (_name, failure) => {
  const { page, closed } = closablePage()
  await leaveWithFallback(page, 'meet', () => Promise.reject(failure))
  expect(closed()).toBe(1)
})

test('a bug in the leave step closes the page, then reaches the caller', async () => {
  const { page, closed } = closablePage()
  const bug = new TypeError('cannot read properties of undefined')
  await expect(leaveWithFallback(page, 'teams', () => Promise.reject(bug))).rejects.toBe(bug)
  expect(closed()).toBe(1)
})

test('a clean leave leaves the page open', async () => {
  const { page, closed } = closablePage()
  await leaveWithFallback(page, 'teams', async () => undefined)
  expect(closed()).toBe(0)
})

test('panel jobs on one page run one at a time, in order, even after a failure', async () => {
  const { page } = closablePage()
  const order: string[] = []
  const job =
    (name: string, ms: number, fail = false) =>
    () =>
      new Promise<string>((resolve, reject) => {
        order.push(`${name} start`)
        setTimeout(() => {
          order.push(`${name} end`)
          if (fail) reject(new Error(name))
          else resolve(name)
        }, ms)
      })
  const first = withPanel(page, job('a', 30, true))
  const second = withPanel(page, job('b', 5))
  await expect(first).rejects.toThrow('a')
  expect(await second).toBe('b')
  expect(order).toEqual(['a start', 'a end', 'b start', 'b end'])
})
