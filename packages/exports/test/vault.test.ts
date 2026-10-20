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
