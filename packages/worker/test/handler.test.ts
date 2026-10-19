import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import type { EventType, FormCandidate } from '@tm/core'
import type { AlertKind } from '@tm/notify'
import { createFrameHandler, type FrameHandlerDeps } from '../src/frames/handler'
import type { FormPinger } from '../src/forms/pinger'
import { closeQr } from '../src/qr/qr'
import { qrFrame } from './helpers/qr-frame'

// Host setup: the spike's venv (OpenCV) and models (spikes/03-qr/fetch-models.sh). In the image the env comes from Docker.
const spike = fileURLToPath(new URL('../../../spikes/03-qr/', import.meta.url))
process.env.TM_WECHAT_PYTHON ??= `${spike}.venv/bin/python`
process.env.TM_WECHAT_MODELS_DIR ??= `${spike}models`

afterAll(closeQr)

let dataDir: string
let offers: FormCandidate[]
let events: { type: EventType; data: Record<string, unknown> }[]
let alerts: AlertKind[]
let deps: FrameHandlerDeps

beforeEach(async () => {
  dataDir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'tm-frames-'))
  offers = []
  events = []
  alerts = []
  const pinger: FormPinger = {
    ready: Promise.resolve(),
    offer: async (c) => void offers.push(c),
    idle: async () => undefined
  }
  deps = {
    dataDir,
    timeZone: 'UTC',
    recordingStart: new Date('2026-10-21T12:00:00Z'),
    lecture: true,
    region: () => null,
    participants: () => 5,
    levelDb: () => -20,
    emit: async (type, data) => void events.push({ type, data }),
    onAlert: (k) => void alerts.push(k),
    pinger
  }
})
afterEach(() => rm(dataDir, { recursive: true, force: true }))

test('QR seen twice is offered once; keyframes saved with clock names', async () => {
  const h = createFrameHandler({ ...deps, timeZone: 'Asia/Kuala_Lumpur' })
  const f = await qrFrame('https://forms.gle/abc', 300, { x: 800, y: 300 })
  for (const at of ['2026-10-21T12:00:00Z', '2026-10-21T12:00:02Z', '2026-10-21T12:00:04Z'])
    await h({ at: new Date(at), png: f })
  expect(offers).toEqual([
    expect.objectContaining({
      url: 'https://forms.gle/abc',
      source: 'qr',
      sender: null
    })
  ])
  expect(await readdir(join(dataDir, 'frames'))).toEqual(['0001_200002.png'])
  expect(events.find((e) => e.type === 'keyframe')!.data).toMatchObject({
    file: 'frames/0001_200002.png',
    region: null,
    offsetMs: 2000
  })
})

test('work entries read no codes; keyframe numbers go on after an earlier attempt', async () => {
  const f = await qrFrame('https://forms.gle/abc', 300, { x: 800, y: 300 })
  const first = createFrameHandler({ ...deps, lecture: false, pinger: null })
  for (const at of ['2026-10-21T12:00:00Z', '2026-10-21T12:00:02Z']) await first({ at: new Date(at), png: f })
  const second = createFrameHandler({ ...deps, lecture: false, pinger: null })
  for (const at of ['2026-10-21T12:10:00Z', '2026-10-21T12:10:02Z']) await second({ at: new Date(at), png: f })
  expect((await readdir(join(dataDir, 'frames'))).sort()).toEqual(['0001_120002.png', '0002_121002.png'])
  expect(offers).toEqual([])
})

test('black frames raise the health alert; an unknown level and a failing decoder do not stop the loop', async () => {
  const black = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#000000' } })
    .png()
    .toBuffer()
  const h = createFrameHandler({
    ...deps,
    levelDb: () => null,
    decode: async () => {
      throw new Error('bridge died')
    }
  })
  for (let i = 0; i <= 5; i++) await h({ at: new Date(Date.parse('2026-10-21T12:00:00Z') + i * 2000), png: black })
  expect(alerts).toContain('black_frames')
  expect(alerts).toContain('form_ping_failed')
  expect(events.some((e) => e.type === 'error' && e.data.where === 'qr')).toBe(true)
})
