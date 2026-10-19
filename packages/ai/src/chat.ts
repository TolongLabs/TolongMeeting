import { z } from 'zod'
import type { AiConfig } from '@tm/core'
import { AiError, AiKeyError, AiTimeoutError } from './errors'

export type { AiConfig } from '@tm/core'

export type ChatPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatPart[]
}

export interface ChatOptions {
  thinking?: boolean
}

const KEY_STATUSES = [401, 402, 429] as const
const ERROR_BODY_CHARS = 200
const RETRY_NOTE = 'Your reply was not valid JSON for the schema. Reply with JSON only.'

const CompletionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1)
})

export async function chatText(
  cfg: AiConfig,
  model: string,
  messages: ChatTurn[],
  timeoutMs: number,
  opts?: ChatOptions
): Promise<string> {
  return complete(cfg, model, messages, timeoutMs, opts)
}

export async function chatJson<T>(
  cfg: AiConfig,
  model: string,
  messages: ChatTurn[],
  schema: z.ZodType<T>,
  timeoutMs: number,
  opts?: ChatOptions
): Promise<T> {
  const first = await complete(cfg, model, messages, timeoutMs, opts, true)
  const parsed = readJson(first, schema)
  if (parsed.ok) return parsed.value

  const retryMessages: ChatTurn[] = [...messages, { role: 'user', content: RETRY_NOTE }]
  const second = await complete(cfg, model, retryMessages, timeoutMs, opts, true)
  const retried = readJson(second, schema)
  if (retried.ok) return retried.value
  throw new AiError('AI reply was not valid JSON for the schema after one retry', 422)
}

async function complete(
  cfg: AiConfig,
  model: string,
  messages: ChatTurn[],
  timeoutMs: number,
  opts: ChatOptions | undefined,
  json = false
): Promise<string> {
  const body = {
    model,
    messages,
    stream: false,
    enable_thinking: opts?.thinking ?? false,
    ...(json ? { response_format: { type: 'json_object' } } : {})
  }
  const signal = AbortSignal.timeout(timeoutMs)
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`

  let raw: unknown
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal
    })
    if (!res.ok) {
      const snippet = (await res.text()).slice(0, ERROR_BODY_CHARS).replaceAll(cfg.apiKey, '[redacted]')
      throw httpError(res.status, snippet)
    }
    raw = await res.json()
  } catch (e) {
    if (signal.aborted) throw new AiTimeoutError(timeoutMs, { cause: e })
    throw e
  }
  return CompletionSchema.parse(raw).choices[0]!.message.content
}

function httpError(status: number, snippet: string): Error {
  const message = `AI request failed with HTTP ${status}: ${snippet}`
  if (KEY_STATUSES.some((s) => s === status)) return new AiKeyError(status as 401 | 402 | 429, message)
  return new AiError(message, status)
}

type Parsed<T> = { ok: true; value: T } | { ok: false }

function readJson<T>(content: string, schema: z.ZodType<T>): Parsed<T> {
  let value: unknown
  try {
    value = JSON.parse(stripFence(content))
  } catch {
    return { ok: false }
  }
  const result = schema.safeParse(value)
  return result.success ? { ok: true, value: result.data } : { ok: false }
}

function stripFence(content: string): string {
  const match = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(content)
  return (match ? match[1]! : content).trim()
}
