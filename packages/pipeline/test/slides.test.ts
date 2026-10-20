import { afterEach, expect, test } from 'bun:test'
import { mkdir, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { AiKeyError } from '@tm/ai'
import sharp from 'sharp'
import { buildSlides } from '../src/slides'
import { makeOccurrence, removeOccurrence, writeLines } from './helpers'

const STAGE_WIDTH = 1920
const STAGE_HEIGHT = 1080
const SLIDE_REGION = { x: 510, y: 120, width: 1410, height: 840 }
const SCREEN = { x: 100, y: 200, width: 1000, height: 600 }
const SCREEN_C = { x: 200, y: 300, width: 800, height: 500 }

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

type Reply = { status: number; body: unknown; delayMs?: number }

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
      const { status, body: out, delayMs } = reply(width)
      if (delayMs !== undefined) await Bun.sleep(delayMs)
      return new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } })
    }
  })
  return { requests, url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

const completion = (content: object) => ({ choices: [{ message: { content: JSON.stringify(content) } }] })

// A 1920x1080 stage frame as the worker writes it: three equal channels, brightness from `pixel`. With `alpha`, a
// fully opaque fourth channel is added (an RGBA PNG).
async function stagePng(pixel: (x: number, y: number) => number, alpha = false): Promise<Buffer> {
  const channels = alpha ? 4 : 3
  const raw = Buffer.alloc(STAGE_WIDTH * STAGE_HEIGHT * channels, 255)
  for (let y = 0; y < STAGE_HEIGHT; y++)
    for (let x = 0; x < STAGE_WIDTH; x++)
      raw.fill(pixel(x, y), (y * STAGE_WIDTH + x) * channels, (y * STAGE_WIDTH + x) * channels + 3)
  return sharp(raw, { raw: { width: STAGE_WIDTH, height: STAGE_HEIGHT, channels } })
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
// Slide C: a tent (rising, then falling) on a dark stage, half the bits of A and half of B away from both.
const slideC = (x: number, y: number): number =>
  x >= SCREEN_C.x && x < SCREEN_C.x + SCREEN_C.width && y >= SCREEN_C.y && y < SCREEN_C.y + SCREEN_C.height
    ? Math.round(60 + 190 * (1 - Math.abs((x - SCREEN_C.x) / SCREEN_C.width - 0.5) * 2))
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

const keyframeRow = (file: string, offsetMs: number, region: object | null) => ({
  occurrenceId: 'occ-1',
  attempt: 1,
  at: '2026-10-21T12:00:00Z',
  type: 'keyframe',
  data: { file, region, offsetMs }
})

// Three keyframes: slide A (with a region from the worker), a black frame (no shared screen), and slide B. With
// `third`, a fourth frame adds slide C, so three slides are kept. `frameB` replaces slide B's PNG.
async function occurrenceWithKeyframes(
  reply: (width: number) => Reply,
  opts: { third?: boolean; frameB?: Buffer } = {}
) {
  const occ = await makeOccurrence()
  occurrences.push(occ.root)
  const { dataDir } = occ
  await mkdir(join(dataDir, 'frames'), { recursive: true })
  await Bun.write(join(dataDir, 'frames/0001_200002.png'), await stagePng(slideA))
  await Bun.write(join(dataDir, 'frames/0002_200020.png'), await stagePng(blackStage))
  await Bun.write(join(dataDir, 'frames/0003_200040.png'), opts.frameB ?? (await stagePng(slideB)))
  if (opts.third) await Bun.write(join(dataDir, 'frames/0004_200060.png'), await stagePng(slideC))
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
    },
    ...(opts.third ? [keyframeRow('frames/0004_200060.png', 60000, null)] : [])
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

const errorEvents = async (dataDir: string) =>
  (await readFile(join(dataDir, 'events.jsonl'), 'utf8'))
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> })
    .filter((e) => e.type === 'error')
    .map((e) => e.data)

test('a slide that cannot be read is marked failed in slides.json and slides.md, and the error is recorded', async () => {
  const { cfg, dataDir, fake } = await occurrenceWithKeyframes((width) =>
    width === SCREEN.width ? { status: 400, body: { error: 'bad image' } } : readsAll(width)
  )
  const { slides, mdPath } = await buildSlides(cfg)
  expect(fake.requests).toHaveLength(2)
  expect(slides).toEqual([
    { n: 1, file: 'slides/01.webp', atMs: 2000, title: 'Clustering', text: 'k-means, step by step' },
    { n: 2, file: 'slides/02.webp', atMs: 40000, title: '', text: '', failed: true }
  ])
  expect(await Bun.file(join(dataDir, 'slides/02.webp')).exists()).toBe(true)
  expect(JSON.parse(await Bun.file(join(dataDir, 'slides/slides.json')).text())).toEqual(slides)
  const md = await Bun.file(mdPath).text()
  expect(md).toContain('## Slide 02\n\n![Slide 02](../slides/02.webp)\n\n*Slide text could not be read.*\n\n')
  expect(md).not.toContain('Slide 01: Clustering\n\n![Slide 01: Clustering](../slides/01.webp)\n\n*Slide text')
  expect(await errorEvents(dataDir)).toEqual([expect.objectContaining({ step: 'slide', file: 'slides/02.webp' })])
})

test('a 5xx is retried once and the retry can succeed', async () => {
  let calls = 0
  const { cfg, dataDir, fake } = await occurrenceWithKeyframes((width) => {
    if (width !== SCREEN.width) return readsAll(width)
    return ++calls === 1 ? { status: 503, body: { error: 'busy' } } : readsAll(width)
  })
  const { slides } = await buildSlides(cfg)
  expect(fake.requests).toHaveLength(3)
  expect(slides[1]).toEqual({
    n: 2,
    file: 'slides/02.webp',
    atMs: 40000,
    title: 'Trees',
    text: 'Splits on [covered] features.'
  })
  expect(await errorEvents(dataDir)).toEqual([])
})

test('a 5xx that persists is tried twice, then the slide is marked failed', async () => {
  const { cfg, fake } = await occurrenceWithKeyframes((width) =>
    width === SCREEN.width ? { status: 500, body: { error: 'down' } } : readsAll(width)
  )
  const { slides } = await buildSlides(cfg)
  expect(fake.requests).toHaveLength(3)
  expect(slides[1]!.failed).toBe(true)
})

test('a soft failure on the first slide does not stop the later slides from being read', async () => {
  const seen: number[] = []
  const { cfg, fake } = await occurrenceWithKeyframes(
    (width) => {
      seen.push(width)
      return width === SLIDE_REGION.width ? { status: 400, body: { error: 'bad image' } } : readsAll(width)
    },
    { third: true }
  )
  const { slides } = await buildSlides(cfg, { concurrency: 1 })
  expect(fake.requests).toHaveLength(3)
  expect(seen).toEqual([SLIDE_REGION.width, SCREEN.width, SCREEN_C.width])
  expect(slides.map((s) => s.failed)).toEqual([true, undefined, undefined])
})

test('a key error on the first slide starts no new reads', async () => {
  const { cfg, fake } = await occurrenceWithKeyframes(() => ({ status: 402, body: { error: 'no balance' } }), {
    third: true
  })
  await expect(buildSlides(cfg, { concurrency: 1 })).rejects.toBeInstanceOf(AiKeyError)
  expect(fake.requests).toHaveLength(1)
})

test('after a key error buildSlides waits for the reads in flight and writes nothing', async () => {
  const { cfg, dataDir, fake } = await occurrenceWithKeyframes(
    (width) =>
      width === SLIDE_REGION.width
        ? { status: 402, body: { error: 'no balance' } }
        : { status: 400, body: { error: 'bad image' }, delayMs: 300 },
    { third: true }
  )
  await expect(buildSlides(cfg, { concurrency: 3 })).rejects.toBeInstanceOf(AiKeyError)
  expect(fake.requests).toHaveLength(3)
  // The slow reads failed softly after the key error; their error events are already on disk when buildSlides rejects.
  expect((await errorEvents(dataDir)).map((e) => e.file).sort()).toEqual(['slides/02.webp', 'slides/03.webp'])
  expect(await Bun.file(join(dataDir, 'slides/slides.json')).exists()).toBe(false)
  expect(await Bun.file(join(dataDir, 'out/slides.md')).exists()).toBe(false)
})

test('an AI key error stops the slide reading', async () => {
  const { cfg } = await occurrenceWithKeyframes(() => ({ status: 402, body: { error: 'no balance' } }))
  await expect(buildSlides(cfg)).rejects.toBeInstanceOf(AiKeyError)
})

test('a backslash in a model title cannot turn escaped brackets into a link', async () => {
  const { cfg } = await occurrenceWithKeyframes((width) =>
    width === SCREEN.width
      ? { status: 200, body: completion({ title: 'x\\[y\\](https://evil.example)', text: 'body' }) }
      : readsAll(width)
  )
  const { mdPath } = await buildSlides(cfg)
  const md = await Bun.file(mdPath).text()
  expect(md).toContain('## Slide 02: x\\\\\\[y\\\\\\](https://evil.example)\n')
})

test('a model title is one line and cannot break the markdown', async () => {
  const { cfg } = await occurrenceWithKeyframes((width) =>
    width === SCREEN.width
      ? { status: 200, body: completion({ title: '#1 [intro]\n\n## Hacked   title ](x)', text: 'body' }) }
      : readsAll(width)
  )
  const { slides, mdPath } = await buildSlides(cfg)
  expect(slides[1]!.title).toBe('#1 [intro] ## Hacked title ](x)')
  const md = await Bun.file(mdPath).text()
  expect(md).toContain(
    '## Slide 02: \\#1 \\[intro\\] ## Hacked title \\](x)\n\n![Slide 02: \\#1 \\[intro\\] ## Hacked title \\](x)](../slides/02.webp)\n\n'
  )
  expect(md.split('\n').filter((line) => line.startsWith('#'))).toEqual([
    '# Data Mining: slides',
    '## Slide 01: Clustering',
    '## Slide 02: \\#1 \\[intro\\] ## Hacked title \\](x)'
  ])
})

test('an RGBA stage frame is read like an RGB one', async () => {
  const { cfg } = await occurrenceWithKeyframes(readsAll, { frameB: await stagePng(slideB, true) })
  const { slides } = await buildSlides(cfg)
  expect(slides.map((s) => s.n)).toEqual([1, 2])
  expect(await sharp(join(cfg.dataDir, 'slides/02.webp')).metadata()).toMatchObject({ width: 1000, height: 600 })
})

async function withKeyframeFile(file: string, prepare?: (dataDir: string) => Promise<void>) {
  const { cfg, dataDir } = await occurrenceWithKeyframes(readsAll)
  await prepare?.(dataDir)
  await writeLines(join(dataDir, 'events.jsonl'), [keyframeRow(file, 2000, null)])
  return cfg
}

test('a keyframe outside the occurrence directory is refused', async () => {
  await expect(buildSlides(await withKeyframeFile('../../escape.png'))).rejects.toThrow(/outside the occurrence/)
})

test('an absolute keyframe path is refused', async () => {
  await expect(buildSlides(await withKeyframeFile('/etc/passwd'))).rejects.toThrow(/outside the occurrence/)
})

test('a symlink in frames/ that points outside the occurrence directory is refused', async () => {
  const cfg = await withKeyframeFile('frames/link.png', async (dataDir) => {
    await symlink('/etc/passwd', join(dataDir, 'frames/link.png'))
  })
  await expect(buildSlides(cfg)).rejects.toThrow(/outside the occurrence/)
})
