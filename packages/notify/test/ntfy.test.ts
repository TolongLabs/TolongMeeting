import { test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { sendPing, PingError, type NtfyConfig } from '../src/index'

interface Recorded {
  method: string
  path: string
  headers: Record<string, string>
  body: string
  json?: Record<string, unknown>
}

// A real HTTP server that records every request it receives.
let server: ReturnType<typeof Bun.serve>
let requests: Recorded[] = []
let failStatus: number | null = null

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text()
      const url = new URL(req.url)
      const recorded: Recorded = {
        method: req.method,
        path: url.pathname,
        headers: Object.fromEntries(req.headers.entries()),
        body
      }
      if (req.headers.get('content-type') === 'application/json') {
        recorded.json = JSON.parse(body)
      }
      requests.push(recorded)
      if (failStatus !== null) {
        return new Response('nope', { status: failStatus })
      }
      return new Response('{"id":"x"}', { status: 200 })
    }
  })
})

afterAll(() => {
  server.stop(true)
})

beforeEach(() => {
  requests = []
  failStatus = null
})

const cfg = (): NtfyConfig => ({ url: `http://localhost:${server.port}`, topic: 'member-topic', token: 'tk_test' })

const ping = { title: 'Joined: Data Mining', message: 'm', priority: 'default' as const }

test('JSON publish with bearer token, priority and view actions', async () => {
  await sendPing(cfg(), {
    title: 'Joined: Data Mining',
    message: 'm',
    priority: 'high',
    actions: [{ label: 'Open form', url: 'https://forms.gle/<form-id>' }]
  })
  const r = requests[0]
  expect(r.method).toBe('POST')
  expect(r.path).toBe('/')
  expect(r.headers.authorization).toBe('Bearer tk_test')
  expect(r.json).toEqual({
    topic: 'member-topic',
    title: 'Joined: Data Mining',
    message: 'm',
    priority: 4,
    actions: [
      {
        action: 'view',
        label: 'Open form',
        url: 'https://forms.gle/<form-id>',
        clear: false
      }
    ]
  })
})

test('attachment is a PUT to the topic with RFC 2047 headers for non-ASCII', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-test-'))
  const tmpFile = join(dir, 'Ringkasan kuliah 5.md')
  writeFileSync(tmpFile, '# Ringkasan\n\nisi')

  await sendPing(cfg(), {
    title: 'Ringkasan: Kuliah 5 — Pengenalan',
    message: 'x',
    priority: 'default',
    attachPath: tmpFile
  })
  const r = requests[0]
  expect(r.method).toBe('PUT')
  expect(r.path).toBe('/member-topic')
  expect(r.headers.title).toStartWith('=?UTF-8?B?')
  expect(r.headers.priority).toBe('3')
  expect(r.headers.filename).toBe(basename(tmpFile))
  expect(r.body).toBe('# Ringkasan\n\nisi')
})

test('5xx retried twice then PingError; 4xx not retried', async () => {
  failStatus = 503
  await expect(sendPing(cfg(), ping)).rejects.toBeInstanceOf(PingError)
  expect(requests.length).toBe(3)

  requests = []
  failStatus = 403
  await expect(sendPing(cfg(), ping)).rejects.toThrow('403')
  expect(requests.length).toBe(1)
}, 10_000)

test('tags go in the JSON body on a plain ping', async () => {
  await sendPing(cfg(), { ...ping, tags: ['tm_summary'] })
  expect(requests[0].json).toMatchObject({ tags: ['tm_summary'] })
  requests = []
  await sendPing(cfg(), ping)
  expect(requests[0].json).not.toHaveProperty('tags')
})

test('tags go in the Tags header on an attachment ping', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-test-'))
  const file = join(dir, 'summary.md')
  writeFileSync(file, '# x')
  await sendPing(cfg(), { ...ping, tags: ['tm_summary'], attachPath: file })
  expect(requests[0].headers.tags).toBe('tm_summary')
  requests = []
  await sendPing(cfg(), { ...ping, attachPath: file })
  expect(requests[0].headers.tags).toBeUndefined()
})

test('a tag outside the fixed list is refused before anything is sent', async () => {
  await expect(sendPing(cfg(), { ...ping, tags: ['Data Mining' as 'tm_summary'] })).rejects.toThrow('PING_TAGS')
  expect(requests.length).toBe(0)
})
