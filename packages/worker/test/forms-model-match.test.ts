import { afterEach, expect, test } from 'bun:test'
import { AiError, AiTimeoutError, type AiConfig } from '@tm/ai'
import { FORM_MATCH_SYSTEM_PROMPT, matchWithModel } from '../src/forms/model-match'

// Real local HTTP servers answer the OpenAI-compatible endpoint; nothing mocks fetch.
type Body = { model: string; enable_thinking: boolean; messages: { role: string; content: string }[] }
type Stub = { url: string; requests: Body[] }

const servers: ReturnType<typeof Bun.serve>[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

function startStub(respond: () => Promise<Response> | Response): Stub {
  const requests: Body[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (req.method !== 'POST' || new URL(req.url).pathname !== '/chat/completions') {
        return new Response('not found', { status: 404 })
      }
      requests.push((await req.json()) as Body)
      return respond()
    }
  })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}`, requests }
}

function completion(content: string): Response {
  return Response.json({ choices: [{ message: { content } }] })
}

// Answers with the reply as JSON in the message content, after an optional delay.
function stubCompletions(reply: unknown, delayMs = 0): Stub {
  return startStub(async () => {
    if (delayMs > 0) await Bun.sleep(delayMs)
    return completion(JSON.stringify(reply))
  })
}

function stubRaw(content: string): Stub {
  return startStub(() => completion(content))
}

function stubStatus(code: number): Stub {
  return startStub(() => new Response('boom', { status: code }))
}

const ai = (url: string): AiConfig => ({
  baseUrl: url,
  apiKey: 'test',
  asrUrl: 'wss://unused',
  models: { summary: 's', vision: 'v', formMatch: 'qwen-flash', asr: 'a' }
})

test('sends keys, labels and options cut to 120 characters, with thinking off', async () => {
  const s = stubCompletions({
    matches: [{ question: 'p1q0', detail: 'programme', confidence: 'high' }]
  })
  const out = await matchWithModel(
    ai(s.url),
    [
      {
        id: 'p1q0',
        label: 'Programme of study '.repeat(20),
        options: ['x'.repeat(300)]
      }
    ],
    ['full_name', 'programme']
  )
  const body = s.requests[0]!
  expect(s.requests).toHaveLength(1)
  expect(body.model).toBe('qwen-flash')
  expect(body.enable_thinking).toBe(false)
  expect(body.messages[0]!.content).toBe(FORM_MATCH_SYSTEM_PROMPT)
  const user = JSON.parse(body.messages[1]!.content)
  expect(user.details).toEqual(['full_name', 'programme'])
  expect(Object.keys(user).sort()).toEqual(['details', 'questions'])
  expect(Object.keys(user.questions[0]).sort()).toEqual(['id', 'label', 'options'])
  expect([user.questions[0].label.length, user.questions[0].options[0].length]).toEqual([120, 120])
  expect(out).toEqual(new Map([['p1q0', 'programme']]))
})

test('sends every question of a page in one call', async () => {
  const s = stubCompletions({
    matches: [
      { question: 'p1q0', detail: 'full_name', confidence: 'high' },
      { question: 'p1q2', detail: 'student_id', confidence: 'high' }
    ]
  })
  const qs = [
    { id: 'p1q0', label: 'Nama', options: [] },
    { id: 'p1q1', label: 'Hobi', options: ['Membaca', 'Sukan'] },
    { id: 'p1q2', label: 'Matric', options: [] }
  ]
  const out = await matchWithModel(ai(s.url), qs, ['full_name', 'student_id'])
  expect(s.requests).toHaveLength(1)
  const user = JSON.parse(s.requests[0]!.messages[1]!.content)
  expect(user.questions.map((q: { id: string }) => q.id)).toEqual(['p1q0', 'p1q1', 'p1q2'])
  expect(out).toEqual(
    new Map([
      ['p1q0', 'full_name'],
      ['p1q2', 'student_id']
    ])
  )
})

test('cuts labels without leaving half of a surrogate pair', async () => {
  const s = stubCompletions({ matches: [] })
  await matchWithModel(ai(s.url), [{ id: 'p1q0', label: 'x'.repeat(119) + '😀', options: [] }], ['full_name'])
  const user = JSON.parse(s.requests[0]!.messages[1]!.content)
  expect(user.questions[0].label).toBe('x'.repeat(119))
})

test('keeps only high-confidence matches to known keys and questions', async () => {
  const s = stubCompletions({
    matches: [
      { question: 'p1q0', detail: 'full_name', confidence: 'high' },
      { question: 'p1q1', detail: 'student_id', confidence: 'medium' },
      { question: 'p1q2', detail: 'password', confidence: 'high' },
      { question: 'p9q9', detail: 'full_name', confidence: 'high' },
      { question: 'p1q3', detail: null, confidence: 'high' }
    ]
  })
  const qs = ['p1q0', 'p1q1', 'p1q2', 'p1q3'].map((id) => ({
    id,
    label: id,
    options: []
  }))
  expect(await matchWithModel(ai(s.url), qs, ['full_name', 'student_id'])).toEqual(new Map([['p1q0', 'full_name']]))
})

test('drops a question whose high-confidence answers name different keys, keeps same-key repeats', async () => {
  const s = stubCompletions({
    matches: [
      { question: 'p1q0', detail: 'full_name', confidence: 'high' },
      { question: 'p1q0', detail: 'student_id', confidence: 'high' },
      { question: 'p1q1', detail: 'full_name', confidence: 'high' },
      { question: 'p1q1', detail: 'full_name', confidence: 'high' },
      { question: 'p1q2', detail: 'full_name', confidence: 'high' },
      { question: 'p1q2', detail: 'student_id', confidence: 'medium' }
    ]
  })
  const qs = ['p1q0', 'p1q1', 'p1q2'].map((id) => ({ id, label: id, options: [] }))
  expect(await matchWithModel(ai(s.url), qs, ['full_name', 'student_id'])).toEqual(
    new Map([
      ['p1q1', 'full_name'],
      ['p1q2', 'full_name']
    ])
  )
})

test('returns no matches when the model takes longer than 5 seconds', async () => {
  const s = stubCompletions(
    {
      matches: [{ question: 'p1q0', detail: 'full_name', confidence: 'high' }]
    },
    8_000
  )
  const t0 = Date.now()
  const out = await matchWithModel(ai(s.url), [{ id: 'p1q0', label: 'Nama', options: [] }], ['full_name'])
  expect(out.size).toBe(0)
  expect(Date.now() - t0).toBeLessThan(6_000)
}, 10_000)

test('returns no matches on malformed JSON or an HTTP error, and makes no call without questions', async () => {
  const q = [{ id: 'p1q0', label: 'Nama', options: [] }]
  expect((await matchWithModel(ai(stubRaw('not json').url), q, ['full_name'])).size).toBe(0)
  expect((await matchWithModel(ai(stubStatus(500).url), q, ['full_name'])).size).toBe(0)
  expect((await matchWithModel(ai(stubStatus(401).url), q, ['full_name'])).size).toBe(0)
  const s = stubCompletions({ matches: [] })
  expect((await matchWithModel(ai(s.url), [], ['full_name'])).size).toBe(0)
  expect(s.requests).toHaveLength(0)
})

test('rethrows errors that are not AI errors', async () => {
  const dead = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const url = `http://127.0.0.1:${dead.port}`
  dead.stop(true)
  const error = await matchWithModel(ai(url), [{ id: 'p1q0', label: 'Nama', options: [] }], ['full_name']).then(
    () => null,
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(Error)
  expect(error).not.toBeInstanceOf(AiError)
  expect(error).not.toBeInstanceOf(AiTimeoutError)
})
