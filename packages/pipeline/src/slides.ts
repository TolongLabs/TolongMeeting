import { appendFile, mkdir, realpath } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { AiError, AiKeyError, AiTimeoutError, chatJson, type ChatTurn } from '@tm/ai'
import { dHash256, meanLuma, type GreyImage, type JobConfig } from '@tm/core'
import sharp from 'sharp'
import { z } from 'zod'
import { brightnessCrop, selectSlides, type KeptFrame, type Rect, type SlideCandidate } from './crop'

export interface Slide {
  n: number
  file: string
  atMs: number
  title: string
  text: string
  /** Set when the vision model could not read the slide; `title` and `text` are then empty. */
  failed?: true
}

const STAGE_WIDTH = 1920
const STAGE_HEIGHT = 1080
// The left 74% of the stage, where the shared screen sits; the chat panel is on the right.
const LEFT_OF_STAGE: Rect = { x: 0, y: 0, width: 1421, height: 1080 }
const WEBP = { quality: 90, effort: 6 }
const HASH_WIDTH = 17
const HASH_HEIGHT = 16
const READ_TIMEOUT_MS = 60_000
const DEFAULT_CONCURRENCY = 4

const SYSTEM_PROMPT = `You read one slide from a lecture's shared screen. Reply with JSON {"title": string, "text": string} and nothing else.
- Transcribe the slide's text faithfully, in its own language, keeping lists and line order.
- Ignore the meeting app's interface: toolbars, name labels, chat panels and cursors.
- Write [covered] where something hides text and [illegible] where it can't be read. Never guess or invent.
- Describe a screenshot of an app in one italic line instead of transcribing it.
- Never transcribe other people's usernames or messages shown on the slide.
- "title" is the slide's heading, or a 3 to 6 word description if it has none.`

const EventRow = z.object({ type: z.string(), data: z.unknown() })
const RectSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
const KeyframeData = z.object({ file: z.string(), offsetMs: z.number(), region: RectSchema.nullable() })
const SlideReply = z.object({ title: z.string(), text: z.string() })

const UNREADABLE = '*Slide text could not be read.*'

const slideNumber = (n: number): string => String(n).padStart(2, '0')

// A file path from an event, resolved inside the occurrence directory only. Symlinks are followed first, so a link in
// frames/ that points elsewhere is refused like `../` and an absolute path are.
async function inside(dataDir: string, file: string): Promise<string> {
  const root = await realpath(dataDir)
  const refuse = (): never => {
    throw new RangeError(`keyframe ${file} is outside the occurrence directory`)
  }
  const lexical = resolve(root, file)
  if (!lexical.startsWith(root + sep)) refuse()
  const path = await realpath(lexical)
  if (!path.startsWith(root + sep)) refuse()
  return path
}

async function keyframes(dataDir: string): Promise<KeptFrame[]> {
  const text = await Bun.file(join(dataDir, 'events.jsonl')).text()
  const frames: KeptFrame[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const row = EventRow.parse(JSON.parse(line))
    if (row.type !== 'keyframe') continue
    const frame = KeyframeData.parse(row.data)
    await inside(dataDir, frame.file)
    frames.push(frame)
  }
  return frames.sort((a, b) => a.offsetMs - b.offsetMs)
}

async function stageGrey(path: string): Promise<GreyImage> {
  // removeAlpha first: greyscale alone keeps an alpha channel, which would interleave two bytes per pixel.
  const { data, info } = await sharp(path).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true })
  if (info.channels !== 1) throw new RangeError(`${path} has ${info.channels} channels after greyscale, expected 1`)
  if (info.width !== STAGE_WIDTH || info.height !== STAGE_HEIGHT)
    throw new RangeError(`${path} is ${info.width}x${info.height}, not a ${STAGE_WIDTH}x${STAGE_HEIGHT} stage frame`)
  return { width: info.width, height: info.height, data: new Uint8Array(data) }
}

function cropOf(img: GreyImage, r: Rect): GreyImage {
  const data = new Uint8Array(r.width * r.height)
  for (let y = 0; y < r.height; y++) {
    const start = (r.y + y) * img.width + r.x
    data.set(img.data.subarray(start, start + r.width), y * r.width)
  }
  return { width: r.width, height: r.height, data }
}

async function dHashOf(crop: GreyImage): Promise<bigint> {
  const small = await sharp(Buffer.from(crop.data), { raw: { width: crop.width, height: crop.height, channels: 1 } })
    .resize(HASH_WIDTH, HASH_HEIGHT, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer()
  return dHash256({ width: HASH_WIDTH, height: HASH_HEIGHT, data: new Uint8Array(small) })
}

// The worker's region clipped to the stage. A region with no area left on the stage is an error.
function onStage(r: Rect): Rect {
  const x0 = Math.max(0, r.x)
  const y0 = Math.max(0, r.y)
  const x1 = Math.min(STAGE_WIDTH, r.x + r.width)
  const y1 = Math.min(STAGE_HEIGHT, r.y + r.height)
  if (x1 <= x0 || y1 <= y0) throw new RangeError(`keyframe region ${JSON.stringify(r)} is off the stage`)
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

// Runs `fn` over `items` with at most `limit` calls in flight. When a call throws, no new call starts, the calls
// already running settle, and then the first error is rethrown, so nothing runs after this rejects. `fn` handles the
// failures that should not stop the others (a slide that cannot be read) by returning a value instead of throwing.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  let failure: { error: unknown } | undefined
  const worker = async (): Promise<void> => {
    while (next < items.length && failure === undefined) {
      const i = next++
      try {
        out[i] = await fn(items[i]!, i)
      } catch (error) {
        failure ??= { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (failure !== undefined) throw failure.error
  return out
}

// A timeout or a 5xx is worth one more try; a 4xx will not change, and a key error stops the whole run.
const isTransient = (e: unknown): boolean =>
  e instanceof AiTimeoutError || (e instanceof AiError && !(e instanceof AiKeyError) && e.status >= 500)

// One model title as one line: no newlines or runs of spaces.
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

// A title is model output and goes into markdown: backslashes and brackets would break the image label or form a
// link, a leading # a heading. Backslashes are escaped too, so `\[` can't undo the bracket escape.
const markdownTitle = (title: string): string => title.replace(/[\\[\]]/g, '\\$&').replace(/^#/, '\\#')

type SlideRead = { title: string; text: string; failed?: true }

// Reads one slide, retrying once on a transient error. A soft failure after that keeps the slide's image, marks the
// slide `failed` and logs an error event; the other slides are still read. An AiKeyError, or any error that is not an
// AI one, is thrown and stops the run (see mapLimit).
async function readSlide(cfg: JobConfig, file: string, webp: Buffer): Promise<SlideRead> {
  const image = `data:image/webp;base64,${webp.toString('base64')}`
  const messages: ChatTurn[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Read this slide.' },
        { type: 'image_url', image_url: { url: image } }
      ]
    }
  ]
  for (let attempt = 1; ; attempt++) {
    try {
      const reply = await chatJson(cfg.ai, cfg.ai.models.vision, messages, SlideReply, READ_TIMEOUT_MS)
      return { title: oneLine(reply.title), text: reply.text }
    } catch (e) {
      if (e instanceof AiKeyError) throw e
      if (!(e instanceof AiError || e instanceof AiTimeoutError)) throw e
      if (attempt === 1 && isTransient(e)) continue
      const event = {
        occurrenceId: cfg.occurrenceId,
        attempt: cfg.attempt,
        at: new Date().toISOString(),
        type: 'error',
        data: { step: 'slide', file, reason: e.message }
      }
      await appendFile(join(cfg.dataDir, 'events.jsonl'), `${JSON.stringify(event)}\n`)
      return { title: '', text: '', failed: true }
    }
  }
}

function slidesMarkdown(name: string, slides: Slide[]): string {
  const count = slides.length === 1 ? '1 slide' : `${slides.length} slides`
  let md = `# ${name}: slides\n\n${count} shown in the meeting, read by a vision model. Covered or unreadable text is marked, never guessed.\n\n`
  for (const s of slides) {
    const title = markdownTitle(oneLine(s.title))
    const label = title === '' ? `Slide ${slideNumber(s.n)}` : `Slide ${slideNumber(s.n)}: ${title}`
    md += `## ${label}\n\n![${label}](../${s.file})\n\n`
    if (s.failed === true) md += `${UNREADABLE}\n\n`
    else if (s.text !== '') md += `${s.text}\n\n`
  }
  return md
}

/**
 * Curates the worker's keyframes into slides: crops each to the shared screen, drops the duplicates and build-ups,
 * saves each as `slides/NN.webp`, reads it with the vision model and writes `slides/slides.json` and `out/slides.md`.
 */
export async function buildSlides(
  cfg: JobConfig,
  opts?: { concurrency?: number }
): Promise<{ slides: Slide[]; mdPath: string }> {
  const frames = await keyframes(cfg.dataDir)
  const crops = new Map<KeptFrame, Rect>()
  const candidates: SlideCandidate[] = []
  for (const frame of frames) {
    const stage = await stageGrey(await inside(cfg.dataDir, frame.file))
    const crop = frame.region === null ? brightnessCrop(stage, LEFT_OF_STAGE) : onStage(frame.region)
    if (crop === null) continue
    const image = cropOf(stage, crop)
    candidates.push({ frame, hash: await dHashOf(image), luma: meanLuma(image) })
    crops.set(frame, crop)
  }

  const kept = selectSlides(candidates)
  await mkdir(join(cfg.dataDir, 'slides'), { recursive: true })
  const slides = await mapLimit(kept, opts?.concurrency ?? DEFAULT_CONCURRENCY, async (frame, index) => {
    const crop = crops.get(frame)
    if (crop === undefined) throw new Error(`no crop for keyframe ${frame.file}`)
    const n = index + 1
    const file = `slides/${slideNumber(n)}.webp`
    const { x, y, width, height } = crop
    const webp = await sharp(await inside(cfg.dataDir, frame.file))
      .extract({ left: x, top: y, width, height })
      .webp(WEBP)
      .toBuffer()
    await Bun.write(join(cfg.dataDir, file), webp)
    const read = await readSlide(cfg, file, webp)
    return { n, file, atMs: frame.offsetMs, ...read }
  })

  await Bun.write(join(cfg.dataDir, 'slides', 'slides.json'), JSON.stringify(slides, null, 2))
  const mdPath = join(cfg.dataDir, 'out', 'slides.md')
  await mkdir(dirname(mdPath), { recursive: true })
  await Bun.write(mdPath, slidesMarkdown(cfg.entry.name, slides))
  return { slides, mdPath }
}
