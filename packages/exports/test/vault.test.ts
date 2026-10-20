import { expect, test } from 'bun:test'
import { redact } from '../src'

test('redact removes token shapes', () => {
  expect(redact('bad token github_pat_abc123 and ya29.a0Bx-y', [])).toBe('bad token [redacted] and [redacted]')
  expect(redact('refresh 1//0gAbC-d failed', [])).toBe('refresh [redacted] failed')
  expect(redact('ghp_abc123 ntn_abc123 secret_abc123', [])).toBe('[redacted] [redacted] [redacted]')
})

test('redact removes listed secrets of 8 or more characters, longest first', () => {
  expect(redact('key s3cretvalue!', ['s3cretvalue!'])).toBe('key [redacted]')
  expect(redact('a s3cretvalue!2 b', ['s3cretvalue!', 's3cretvalue!2'])).toBe('a [redacted] b')
  expect(redact('short abc is kept', ['abc'])).toBe('short abc is kept')
  expect(redact('regex chars a.b*c+d? gone', ['a.b*c+d?'])).toBe('regex chars [redacted] gone')
})

test('redact removes bearer values and URLs with credentials', () => {
  expect(redact('401 for Authorization: Bearer abc.def-123_xyz', [])).toBe('401 for Authorization: Bearer [redacted]')
  expect(redact('push to https://user:hunter2@github.com/acme/notes.git failed', [])).toBe('push to [redacted] failed')
  expect(redact('clone https://x-access-token@github.com/a/b failed', [])).toBe('clone [redacted] failed')
  expect(redact('GET /v1?access_token=abc123&page=2', [])).toBe('GET /v1?access_token=[redacted]&page=2')
})

test('redact leaves ordinary text and plain URLs alone', () => {
  const text = 'GitHub answered 404 for https://api.github.com/repos/acme/notes (Not Found)'
  expect(redact(text, [])).toBe(text)
})

test('redact removes JSON credential fields', () => {
  const body =
    '{"error":"bad","client_secret":"abc def\\"x","access_token": "t1","refresh_token":"t2","api_key":"k","password":"p w","token":"t3","name":"keep"}'
  const out = redact(body, [])
  for (const leaked of ['abc def', 't1', 't2', '"k"', 'p w', 't3']) expect(out).not.toContain(leaked)
  expect(out).toContain('"client_secret":"[redacted]"')
  expect(out).toContain('"name":"keep"')
})

test('redact removes Basic credentials', () => {
  expect(redact('Authorization: Basic dXNlcjpwYXNz', [])).toBe('Authorization: Basic [redacted]')
})

test('redact removes more credential query parameters', () => {
  const out = redact('GET /cb?code=4%2F0AbC&key=k1&sig=s1&signature=s2&password=p&secret=s&token=t&state=ok', [])
  expect(out).toBe(
    'GET /cb?code=[redacted]&key=[redacted]&sig=[redacted]&signature=[redacted]&password=[redacted]&secret=[redacted]&token=[redacted]&state=ok'
  )
})

test('redact removes Google API key and client secret shapes', () => {
  const key = `AIza${'Sy'.repeat(10)}-_x`
  expect(redact(`key ${key} and GOCSPX-abc_DEF-123 end`, [])).toBe('key [redacted] and [redacted] end')
  expect(redact('short AIzaSy stays', [])).toBe('short AIzaSy stays')
})

test('redact is linear on hostile input', () => {
  for (const unit of ['a-', 'a.', 'a ', 'Bearer ', 'token=', '"token":"', 'https://a']) {
    const text = unit.repeat(Math.ceil(200_000 / unit.length))
    const started = performance.now()
    const out = redact(text, [])
    expect(performance.now() - started).toBeLessThan(50)
    expect(out.length).toBeLessThan(2 * 8 * 1024)
  }
})

test('redact cuts long text at a word boundary and keeps no half token', () => {
  const text = `${'word '.repeat(2000)}ghp_${'x'.repeat(40)}`
  const out = redact(text, [])
  expect(out.endsWith('word [truncated]')).toBe(true)
  expect(out).not.toContain('ghp_')
})
