import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { ChatMessage } from '@tm/core'
import type { Slide } from '../src/slides'
import { buildInventory, InventorySchema, type Inventory } from '../src/summary/inventory'
import { startFakeAi, type FakeAi } from './fakes'
import { makeOccurrence, removeOccurrence, type Occurrence } from './helpers'

let occ: Occurrence
let fake: FakeAi
beforeAll(async () => {
  occ = await makeOccurrence()
  fake = startFakeAi()
})
afterAll(async () => {
  fake.stop()
  await removeOccurrence(occ.root)
})

const inventory: Inventory = {
  sessionLabel: 'Week 7',
  nextAction: 'Submit assignment 2',
  items: [
    {
      kind: 'deadline',
      text: 'Submit assignment 2',
      due: '2026-11-01T23:59',
      source: 'slide',
      ref: 'slide 1',
      conflicts: []
    }
  ],
  covered: ['k-means']
}

const slides: Slide[] = [
  { n: 1, file: 'slides/01.webp', atMs: 0, title: 'Clustering', text: 'k-means\nChoosing k' },
  { n: 2, file: 'slides/02.webp', atMs: 1, title: '', text: 'Assignment 2 due Sunday' },
  { n: 3, file: 'slides/03.webp', atMs: 2, title: '', text: '', failed: true }
]

function message(
  key: string,
  sender: string,
  role: ChatMessage['senderRole'],
  time: string,
  text: string
): ChatMessage {
  return { key, sender, senderRole: role, time, seenAt: `2026-10-21T12:41:0${key}Z`, text, links: [], replyTo: null }
}

const chat: ChatMessage[] = [
  message('1', 'Dr Lecturer', 'host', '8:41 PM', 'Assignment 2 is due Sunday, join https://zoom.us/j/123?pwd=SECRET'),
  message('2', 'Aina', 'participant', '8:42 PM', 'Is it graded?'),
  message('3', 'TA Bob', 'participant', '8:43 PM', 'Office hours moved')
]

test('one uncapped inventory call with thinking off and sources labelled', async () => {
  fake.reply(inventory)
  const cfg = {
    ...occ.cfg,
    ai: { ...occ.cfg.ai, baseUrl: fake.url, models: { ...occ.cfg.ai.models, summary: 'qwen3.7-plus' } },
    entry: { ...occ.cfg.entry, trustedSenders: ['TA Bob'] }
  }
  const inv = await buildInventory(cfg, { transcriptMd: '**[00:00:01]** Welcome', slides, chat })

  expect(fake.requests).toHaveLength(1)
  const body = fake.requests[0]!.json
  expect(body).toMatchObject({
    model: 'qwen3.7-plus',
    enable_thinking: false,
    response_format: { type: 'json_object' }
  })
  expect(body.messages[0].content).toContain('lecture date 2026-10-21')
  const user: string = body.messages[1].content
  expect(user).toContain(
    '## Slides\n\nSlide 01: Clustering\nk-means\nChoosing k\n\nSlide 02\nAssignment 2 due Sunday\n\nSlide 03: [text could not be read; list nothing from this slide]'
  )
  expect(user).toMatch(/## Lecturer chat\n\n\[8:41 PM\] Dr Lecturer: Assignment 2/)
  expect(user).toContain('[8:43 PM] TA Bob: Office hours moved')
  expect(user).toMatch(
    /## Other chat\n\n\[8:42 PM\] Aina: Is it graded\?\n\n## Transcript\n\n\*\*\[00:00:01\]\*\* Welcome/
  )
  expect(user.indexOf('TA Bob')).toBeLessThan(user.indexOf('## Other chat'))
  expect(user).not.toContain('pwd=')
  expect(InventorySchema.parse(inv)).toEqual(inv)
  expect(inv).toEqual(inventory)
})
