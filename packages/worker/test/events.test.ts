import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEventLog, redact } from '../src/events'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tm-events-'))
  file = join(dir, 'nested', 'events.jsonl')
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const lines = async (path: string) =>
  (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>)

test('events are JSON lines with secrets redacted', async () => {
  const log = createEventLog(file, 'occ-1', 1)
  await log.emit('error', {
    url: 'https://zoom.us/wc/join/00000000000?pwd=PWD',
    auth: 'Bearer abc.def'
  })
  const [e] = await lines(file)
  expect(e).toMatchObject({
    occurrenceId: 'occ-1',
    attempt: 1,
    type: 'error',
    data: { url: '<zoom.us/wc/join/00000000000>', auth: 'Bearer REDACTED' }
  })
  expect(typeof e!.at).toBe('string')
})

test('emits stay in order and one failed write does not stop the next', async () => {
  const log = createEventLog(file, 'occ-1', 2)
  await Promise.all([1, 2, 3].map((n) => log.emit('state', { n })))
  expect((await lines(file)).map((e) => (e.data as { n: number }).n)).toEqual([1, 2, 3])
  const blocked = createEventLog(join(dir, 'nested', 'events.jsonl', 'x'), 'occ-1', 2)
  await expect(blocked.emit('state', {})).rejects.toThrow()
  await expect(blocked.emit('state', {})).rejects.toThrow()
})

test('redact rewrites urls inside text, tokens in query strings, secret keys and errors', () => {
  expect(redact('open https://forms.gle/abc?x=1 now, token=abc123 and pwd=zz')).toBe(
    'open <forms.gle/abc> now, token=REDACTED and pwd=REDACTED'
  )
  expect(redact({ apiKey: 'sk-1', nested: [{ token: 't', n: 3 }], err: new Error('bad Bearer xyz') })).toEqual({
    apiKey: 'REDACTED',
    nested: [{ token: 'REDACTED', n: 3 }],
    err: { name: 'Error', message: 'bad Bearer REDACTED' }
  })
})
