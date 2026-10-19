import { afterEach, expect, test } from 'bun:test'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AiKeyError } from '@tm/ai'
import sharp from 'sharp'
import { buildSlides } from '../src/slides'
import { makeOccurrence, removeOccurrence, writeLines } from './helpers'

const STAGE_WIDTH = 1920
const STAGE_HEIGHT = 1080
const SLIDE_REGION = { x: 510, y: 120, width: 1410, height: 840 }
const SCREEN = { x: 100, y: 200, width: 1000, height: 600 }

interface Part {
  type: string
  text?: string
  image_url?: { url: string }
}
interface Recorded {
  model: string
  enable_thinking: boolean
  messages: { role: string; content: string | Part[] }[]
}

type Reply = { status: number; body: unknown }

// A local stand-in for the DashScope endpoint. The reply depends on the slide's width, so the test knows which slide it is.
function fakeAi(reply: (width: number) => Reply) {
  const requests: Recorded[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Recorded
      requests.push(body)
      const user = body.messages[1]!.content as Part[]
      const url = user[1]!.image_url!.url
      const width = (await sharp(Buffer.from(url.split(',')[1]!, 'base64')).metadata()).width!
      const { status, body: out } = reply(width)
      return new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } })
    }
  })
  return { requests, url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

const completion = (content: object) => ({ choices: [{ message: { content: JSON.stringify(content) } }] })

// A 1920x1080 stage frame as the worker writes it: three equal channels, brightness from `pixel`.
async function stagePng(pixel: (x: number, y: number) => number): Promise<Buffer> {
  const raw = Buffer.alloc(STAGE_WIDTH * STAGE_HEIGHT * 3)
  for (let y = 0; y < STAGE_HEIGHT; y++)
    for (let x = 0; x < STAGE_WIDTH; x++)
      raw.fill(pixel(x, y), (y * STAGE_WIDTH + x) * 3, (y * STAGE_WIDTH + x) * 3 + 3)
  return sharp(raw, { raw: { width: STAGE_WIDTH, height: STAGE_HEIGHT, channels: 3 } })
    .png()
    .toBuffer()
}

// Slide A: a left-to-right ramp inside its region (hash: all bits set). Slide B: a ramp rising to the right on a dark
// stage (hash: no bits set), so the two are far apart in hash space.
const slideA = (x: number, y: number): number =>
  x >= SLIDE_REGION.x &&
  x < SLIDE_REGION.x + SLIDE_REGION.width &&
  y >= SLIDE_REGION.y &&
  y < SLIDE_REGION.y + SLIDE_REGION.height
    ? Math.round(255 - ((x - SLIDE_REGION.x) * 255) / SLIDE_REGION.width)
    : 0
const slideB = (x: number, y: number): number =>
  x >= SCREEN.x && x < SCREEN.x + SCREEN.width && y >= SCREEN.y && y < SCREEN.y + SCREEN.height
    ? Math.round(60 + ((x - SCREEN.x) * 190) / SCREEN.width)
    : 0
const blackStage = (): number => 0

const readsAll = (width: number): Reply =>
  width === SLIDE_REGION.width
    ? { status: 200, body: completion({ title: 'Clustering', text: 'k-means, step by step' }) }
    : { status: 200, body: completion({ title: 'Trees', text: 'Splits on [covered] features.' }) }

const occurrences: string[] = []
const servers: { stop: () => void }[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop()
  for (const root of occurrences.splice(0)) await removeOccurrence(root)
})

// Three keyframes: slide A (with a region from the worker), a black frame (no shared screen), and slide B.
async function occurrenceWithKeyframes(reply: (width: number) => Reply) {
  const occ = await makeOccurrence()
  occurrences.push(occ.root)
  const { dataDir } = occ
  await mkdir(join(dataDir, 'frames'), { recursive: true })
  await Bun.write(join(dataDir, 'frames/0001_200002.png'), await stagePng(slideA))
  await Bun.write(join(dataDir, 'frames/0002_200020.png'), await stagePng(blackStage))
  await Bun.write(join(dataDir, 'frames/0003_200040.png'), await stagePng(slideB))
  await writeLines(join(dataDir, 'events.jsonl'), [
    { occurrenceId: 'occ-1', attempt: 1, at: '2026-10-21T12:00:00Z', type: 'state', data: { state: 'in_meeting' } },
    {
      occurrenceId: 'occ-1',
      attempt: 1,
      at: '2026-10-21T12:00:02Z',
      type: 'keyframe',
      data: { file: 'frames/0001_200002.png', region: SLIDE_REGION, offsetMs: 2000 }
    },
    {
      occurrenceId: 'occ-1',
      attempt: 1,
      at: '2026-10-21T12:00:20Z',
      type: 'keyframe',
      data: { file: 'frames/0002_200020.png', region: null, offsetMs: 20000 }
    },
    {
      occurrenceId: 'occ-1',
      attempt: 1,
      at: '2026-10-21T12:00:40Z',
      type: 'keyframe',
      data: { file: 'frames/0003_200040.png', region: null, offsetMs: 40000 }
    }
  ])
  const fake = fakeAi(reply)
  servers.push(fake)
  const cfg = {
    ...occ.cfg,
    ai: { ...occ.cfg.ai, baseUrl: fake.url, models: { ...occ.cfg.ai.models, vision: 'qwen3-vl-plus' } }
  }
  return { cfg, dataDir, fake }
}

test('slides are cropped, saved as WebP, read by the vision model and written to slides.md', async () => {
  const { cfg, dataDir, fake } = await occurrenceWithKeyframes(readsAll)
  const { slides, mdPath } = await buildSlides(cfg)
  expect(slides.map((s) => [s.n, s.file])).toEqual([
    [1, 'slides/01.webp'],
    [2, 'slides/02.webp']
  ])
  expect(await sharp(join(dataDir, 'slides/01.webp')).metadata()).toMatchObject({ width: 1410, height: 840 })
  expect(await sharp(join(dataDir, 'slides/02.webp')).metadata()).toMatchObject({ width: 1000, height: 600 })
  expect(fake.requests[0]).toMatchObject({ model: 'qwen3-vl-plus', enable_thinking: false })
  expect((fake.requests[0]!.messages[1]!.content as Part[])[1]!.image_url!.url).toStartWith('data:image/webp;base64,')
  const md = await Bun.file(mdPath).text()
  expect(md).toContain(
    '# Data Mining: slides\n\n2 slides shown in the meeting, read by a vision model. Covered or unreadable text is marked, never guessed.\n\n## Slide 01: Clustering\n\n![Slide 01: Clustering](../slides/01.webp)\n\n'
  )
  expect(JSON.parse(await Bun.file(join(dataDir, 'slides/slides.json')).text())).toEqual(slides)
})

test('a vision failure keeps the slide image with empty text and records the error', async () => {
  const { cfg, dataDir, fake } = await occurrenceWithKeyframes((width) =>
    width === SCREEN.width ? { status: 500, body: { error: 'upstream down' } } : readsAll(width)
  )
  const { slides } = await buildSlides(cfg)
  expect(fake.requests).toHaveLength(2)
  expect(slides).toEqual([
    { n: 1, file: 'slides/01.webp', atMs: 2000, title: 'Clustering', text: 'k-means, step by step' },
    { n: 2, file: 'slides/02.webp', atMs: 40000, title: '', text: '' }
  ])
  expect(await Bun.file(join(dataDir, 'slides/02.webp')).exists()).toBe(true)
  const events = (await readFile(join(dataDir, 'events.jsonl'), 'utf8'))
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> })
  expect(events.filter((e) => e.type === 'error').map((e) => e.data)).toEqual([
    expect.objectContaining({ step: 'slide', file: 'slides/02.webp' })
  ])
})

test('an AI key error stops the slide reading', async () => {
  const { cfg } = await occurrenceWithKeyframes(() => ({ status: 402, body: { error: 'no balance' } }))
  await expect(buildSlides(cfg)).rejects.toBeInstanceOf(AiKeyError)
})

test('a keyframe outside the occurrence directory is refused', async () => {
  const { cfg, dataDir } = await occurrenceWithKeyframes(readsAll)
  await writeLines(join(dataDir, 'events.jsonl'), [
    {
      occurrenceId: 'occ-1',
      attempt: 1,
      at: '2026-10-21T12:00:02Z',
      type: 'keyframe',
      data: { file: '../../escape.png', region: null, offsetMs: 2000 }
    }
  ])
  await expect(buildSlides(cfg)).rejects.toThrow(/outside the occurrence/)
})
