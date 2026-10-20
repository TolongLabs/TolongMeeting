import { format } from 'node:util'

type Writer = typeof process.stdout.write
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const

/**
 * Runs `fn` while capturing `console.*`, `process.stdout.write` and `process.stderr.write`, then fails if any of the
 * captured output contains `secret`. The failure message never repeats the secret. Output is not passed through.
 */
export async function expectNotLogged(secret: string, fn: () => Promise<unknown>): Promise<void> {
  if (secret === '') throw new Error('expectNotLogged needs a non-empty secret')
  const captured: string[] = []
  const savedConsole = new Map(CONSOLE_METHODS.map((name) => [name, console[name]]))
  const savedOut = process.stdout.write
  const savedErr = process.stderr.write
  const capture = (chunk: unknown): boolean => {
    captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'))
    return true
  }
  for (const name of CONSOLE_METHODS) console[name] = (...args: unknown[]) => void captured.push(format(...args))
  process.stdout.write = capture as Writer
  process.stderr.write = capture as Writer
  try {
    await fn()
  } finally {
    for (const [name, original] of savedConsole) console[name] = original as never
    process.stdout.write = savedOut
    process.stderr.write = savedErr
  }
  if (captured.some((text) => text.includes(secret))) throw new Error('A secret appeared in captured log output')
}
