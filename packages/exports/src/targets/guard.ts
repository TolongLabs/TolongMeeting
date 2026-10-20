import { ExportError } from '../types'

/**
 * Runs a renderer (Markdown parser, zip, PDF, image decoding). An `ExportError` passes through. Anything else is a
 * library failure whose message can quote meeting text, so it becomes `ExportError('failed')` with a fixed message and
 * the original error as `cause` (never shown to the member).
 */
export async function renderGuard<T>(render: () => T | Promise<T>): Promise<T> {
  try {
    return await render()
  } catch (e) {
    if (e instanceof ExportError) throw e
    const error = new ExportError('failed', 'The meeting could not be turned into a file.')
    error.cause = e
    throw error
  }
}
