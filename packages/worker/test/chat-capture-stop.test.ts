import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import type { ChatMessage, EventType } from '@tm/core'
import type { PlatformAdapter } from '../src/adapters/types'
import { startChatCapture } from '../src/chat/capture'

let dir: string
let file: string
let events: Array<{ type: EventType; data: Record<string, unknown> }>

beforeEach(async () => {
  dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tm-chat-stop-'))
  file = join(dir, 'chat.jsonl')
  events = []
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const empty = async (): Promise<void> => undefined

// A reader whose first `readChat` is in flight until the test settles it; later reads return at once.
function gatedReader(): {
  adapter: PlatformAdapter
  reading: Promise<void>
  settle: (error: Error | null) => void
} {
  let settle: (error: Error | null) => void = () => {}
  let markReading: () => void = () => {}
  const reading = new Promise<void>((resolve) => (markReading = resolve))
  let first = true
  const adapter = {
    readChat: () => {
      if (!first) return Promise.resolve({ messages: [], cursor: { seenKeys: [] } })
      first = false
      markReading()
      return new Promise<{ messages: ChatMessage[]; cursor: { seenKeys: string[] } }>((resolve, reject) => {
        settle = (error) => (error === null ? resolve({ messages: [], cursor: { seenKeys: [] } }) : reject(error))
      })
    },
    sweepChat: async () => []
  } as unknown as PlatformAdapter
  return { adapter, reading, settle: (error) => settle(error) }
}

test('a read that fails after stop() was called is ignored, not reported', async () => {
  const { adapter, reading, settle } = gatedReader()
  const capture = await startChatCapture({} as Page, adapter, file, empty, {
    pollMs: 5,
    emit: async (type, data) => {
      events.push({ type, data })
    }
  })
  await reading
  const stopping = capture.stop()
  settle(new Error('Target page, context or browser has been closed'))
  await stopping
  expect(events).toEqual([])
})

test('a read that fails while the capture runs is still reported', async () => {
  const { adapter, reading, settle } = gatedReader()
  const capture = await startChatCapture({} as Page, adapter, file, empty, {
    pollMs: 5,
    emit: async (type, data) => {
      events.push({ type, data })
    }
  })
  await reading
  settle(new Error('read failed'))
  for (let i = 0; i < 100 && events.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(events).toEqual([
    {
      type: 'error',
      data: { where: 'chat', step: 'read', code: null, message: 'read failed' }
    }
  ])
  await capture.stop()
})
