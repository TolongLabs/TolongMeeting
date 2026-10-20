import { expect, test } from 'bun:test'
import { renderGuard } from '../src/targets/guard'
import { ExportError } from '../src/types'

test('an ExportError passes through unchanged', async () => {
  const original = new ExportError('not_ready', 'This meeting has no summary yet.')
  await expect(renderGuard(() => Promise.reject(original))).rejects.toBe(original)
})

test('any other error becomes a failed ExportError with a fixed message and the cause kept', async () => {
  const boom = new RangeError('Maximum call stack size exceeded at "my secret meeting text"')
  const err = await renderGuard(() => {
    throw boom
  }).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(ExportError)
  expect(err).toMatchObject({ code: 'failed', message: 'The meeting could not be turned into a file.', cause: boom })
  expect(String((err as Error).message)).not.toContain('secret')
})

test('a result passes through', async () => {
  expect(await renderGuard(() => 5)).toBe(5)
  expect(await renderGuard(async () => 'x')).toBe('x')
})
