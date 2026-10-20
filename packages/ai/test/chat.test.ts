import { afterEach, beforeEach, expect, test } from 'bun:test'
import { z } from 'zod'
import { AiError, AiKeyError, AiTimeoutError, chatJson, chatText, type AiConfig, type ChatTurn } from '../src/index'

// A real HTTP server on a random local port, answering the scripted replies in order.
interface Scripted {
  status: number
  body: unknown
  delayMs: number
  text?: string
}
interface Seen {
  path: string
  headers: Headers
  body: Record<string, any>
}

function startFake() {
  const seen: Seen[] = []
  const script: Scripted[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, any>
      seen.push({ path: new URL(req.url).pathname, headers: req.headers, body })
      const next = script.shift()
      if (!next) return new Response('no scripted reply', { status: 599 })
      if (next.delayMs > 0) await Bun.sleep(next.delayMs)
      if (next.text !== undefined) {
        return new Response(next.text, { status: next.status, headers: { 'content-type': 'text/plain' } })
      }
      return Response.json(next.body, { status: next.status })
    }
  })
  const cfg: AiConfig = {
    baseUrl: `http://localhost:${server.port}/v1`,
    apiKey: 'sk-test',
    asrUrl: 'wss://unused.invalid/realtime',
    models: {
      summary: 'qwen3.7-plus',
      vision: 'qwen3-vl-plus',
      formMatch: 'qwen-flash',
      asr: 'qwen3-asr-flash-realtime'
    }
  }
  const completion = (content: string) => ({ choices: [{ message: { content } }] })
  return {
    cfg,
    seen,
    get last(): Seen {
      return seen[seen.length - 1]!
    },
    reply(content: string, status = 200, delayMs = 0) {
      script.push({ status, body: completion(content), delayMs })
    },
    error(status: number, body: unknown = { error: { message: 'rejected' } }, delayMs = 0) {
      script.push({ status, body, delayMs })
    },
    raw(body: unknown, status = 200) {
      script.push({ status, body, delayMs: 0 })
    },
    plain(text: string, status = 200) {
      script.push({ status, body: null, delayMs: 0, text })
    },
    stop: () => server.stop(true)
  }
}

const msgs: ChatTurn[] = [{ role: 'user', content: 'hi' }]
let fake: ReturnType<typeof startFake>

beforeEach(() => {
  fake = startFake()
})
afterEach(() => {
  fake.stop()
})

test('sends thinking off, bearer key and returns text', async () => {
  fake.reply('hello')
  expect(await chatText(fake.cfg, 'qwen3.7-plus', msgs, 5000)).toBe('hello')
  expect(fake.last.path).toBe('/v1/chat/completions')
  expect(fake.last.body).toMatchObject({
    model: 'qwen3.7-plus',
    enable_thinking: false,
    stream: false,
    messages: msgs
  })
  expect(fake.last.body.response_format).toBeUndefined()
  expect(fake.last.headers.get('authorization')).toBe('Bearer sk-test')
})

test('chatJson strips fences, validates and retries once on bad JSON', async () => {
  fake.reply('not json')
  fake.reply('```json\n{"a":1}\n```')
  expect(await chatJson(fake.cfg, 'm', msgs, z.object({ a: z.number() }), 5000)).toEqual({ a: 1 })
  expect(fake.seen).toHaveLength(2)
  expect(fake.last.body.response_format).toEqual({ type: 'json_object' })
  expect(fake.last.body.messages).toEqual([
    ...msgs,
    { role: 'user', content: 'Your reply was not valid JSON for the schema. Reply with JSON only.' }
  ])
})

test('chatJson retries when the JSON fails the schema', async () => {
  fake.reply('{"a":"one"}')
  fake.reply('{"a":2}')
  expect(await chatJson(fake.cfg, 'm', msgs, z.object({ a: z.number() }), 5000)).toEqual({ a: 2 })
  expect(fake.seen).toHaveLength(2)
})

test('chatJson throws AiError 422 when the retry is also invalid', async () => {
  fake.reply('not json')
  fake.reply('still not json')
  const e = await chatJson(fake.cfg, 'm', msgs, z.object({ a: z.number() }), 5000).catch((x) => x)
  expect(e).toBeInstanceOf(AiError)
  expect(e.status).toBe(422)
  expect(fake.seen).toHaveLength(2)
})

test('401, 402 and 429 raise AiKeyError', async () => {
  for (const s of [401, 402, 429] as const) {
    fake.error(s)
    const e = await chatText(fake.cfg, 'm', msgs, 5000).catch((x) => x)
    expect(e).toBeInstanceOf(AiKeyError)
    expect(e).toMatchObject({ name: 'AiKeyError', status: s })
    expect(String(e)).not.toContain('sk-test')
  }
})

test('other HTTP errors raise AiError without the key and with a short body', async () => {
  fake.error(500, { error: { message: 'x'.repeat(1000) } })
  const e = await chatText(fake.cfg, 'm', msgs, 5000).catch((x) => x)
  expect(e).toBeInstanceOf(AiError)
  expect(e).not.toBeInstanceOf(AiKeyError)
  expect(e.status).toBe(500)
  expect(String(e)).not.toContain('sk-test')
  expect(e.message.length).toBeLessThan(260)
})

test('a request past the timeout raises AiTimeoutError', async () => {
  fake.reply('late', 200, 200)
  const e = await chatText(fake.cfg, 'm', msgs, 50).catch((x) => x)
  expect(e).toBeInstanceOf(AiTimeoutError)
})

test('thinking: true is passed through', async () => {
  fake.reply('ok')
  await chatText(fake.cfg, 'm', msgs, 5000, { thinking: true })
  expect(fake.last.body.enable_thinking).toBe(true)
})

test('a 200 reply without choices raises AiError 502 without the body', async () => {
  fake.raw({ error: { message: 'content filtered sk-test' } })
  const e = await chatText(fake.cfg, 'm', msgs, 5000).catch((x) => x)
  expect(e).toBeInstanceOf(AiError)
  expect(e).not.toBeInstanceOf(AiKeyError)
  expect(e.status).toBe(502)
  expect(e.message).not.toContain('sk-test')
  expect(e.message).not.toContain('filtered')
})

test('a 200 reply whose body is not JSON raises AiError 502 without the body', async () => {
  fake.plain('oops')
  const e = await chatText(fake.cfg, 'm', msgs, 5000).catch((x) => x)
  expect(e).toBeInstanceOf(AiError)
  expect(e).not.toBeInstanceOf(AiKeyError)
  expect(e.status).toBe(502)
  expect(e.message).toBe('provider reply was not JSON')
  expect(e.message).not.toContain('oops')
  expect(e.message).not.toContain('sk-test')
})

test('a 200 reply with null message content raises AiError 502', async () => {
  fake.raw({ choices: [{ message: { content: null } }] })
  const e = await chatJson(fake.cfg, 'm', msgs, z.object({ a: z.number() }), 5000).catch((x) => x)
  expect(e).toBeInstanceOf(AiError)
  expect(e.status).toBe(502)
  expect(fake.seen).toHaveLength(1)
})

test('the API key never appears in an error, even when the provider echoes it', async () => {
  fake.error(500, { error: { message: 'bad key sk-test' } })
  const httpErr = await chatText(fake.cfg, 'm', msgs, 5000).catch((x) => x)
  expect(httpErr).toBeInstanceOf(AiError)
  expect(httpErr.message).toContain('[redacted]')
  expect(httpErr.message).not.toContain('sk-test')

  fake.raw({ error: 'sk-test rejected' })
  const malformed = await chatText(fake.cfg, 'm', msgs, 5000).catch((x) => x)
  expect(malformed.status).toBe(502)
  expect(malformed.message).not.toContain('sk-test')
})

test('an empty API key leaves the error body intact instead of inserting markers', async () => {
  const keyless = { ...fake.cfg, apiKey: '' }
  fake.error(500, { error: { message: 'quota exhausted' } })
  const e = await chatText(keyless, 'm', msgs, 5000).catch((x) => x)
  expect(e).toBeInstanceOf(AiError)
  expect(e.message).toContain('quota exhausted')
  expect(e.message).not.toContain('[redacted]')
})
