import { afterAll, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { QrConfirmer } from '../src/qr/confirm'
import { closeQr, decodeQr } from '../src/qr/qr'
import { qrFrame } from './helpers/qr-frame'

// Host setup: the spike's venv (OpenCV) and models (spikes/03-qr/fetch-models.sh). In the image the env comes from Docker.
const spike = fileURLToPath(new URL('../../../spikes/03-qr/', import.meta.url))
process.env.TM_WECHAT_PYTHON ??= `${spike}.venv/bin/python`
process.env.TM_WECHAT_MODELS_DIR ??= `${spike}models`

afterAll(closeQr)

// PIDs of the wechat_bridge processes this test process started (its direct children).
async function bridgePids(): Promise<number[]> {
  const { stdout } = await promisify(execFile)('ps', ['-o', 'pid=,args=', '--ppid', String(process.pid)])
  return stdout
    .split('\n')
    .filter((line) => line.includes('wechat_bridge'))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
}

const sample = (name: string) => readFile(`${spike}samples/${name}`)
const A = { x: 0, y: 123, width: 1440, height: 810 } // spike condition A: chat open
const GOOGLE_35 =
  'https://docs.google.com/forms/d/e/1FAIpQLSvEJqa_ZgIFI2g8Pahqfpgi9el_OuOjSXXMUHyQ2pqaWkwfV6/viewform?usp=sf_link'
const GOOGLE_20 =
  'https://docs.google.com/forms/d/e/1FAIpQLS7S1L10e0tza93Ce6KRDiKpFfez3gb9pvMEc0goRqG9hTCzpp/viewform?usp=sf_link'
const GOOGLE_12 =
  'https://docs.google.com/forms/d/e/1FAIpQLSdRpdo9KMleEnmhPxjExF6YGVYS1kWE0u19tZtum-94xrIzsO/viewform?usp=sf_link'

const region = { x: 0, y: 60, width: 1410, height: 840 }
test('decodes a large code from the full frame and a small one through the region', async () => {
  expect(await decodeQr(await qrFrame('https://forms.gle/<form-id>', 300, { x: 800, y: 300 }), null)).toEqual([
    'https://forms.gle/<form-id>'
  ])
  expect(
    await decodeQr(await qrFrame('https://forms.office.com/r/<form-id>', 76, { x: 1300, y: 780 }), region)
  ).toEqual(['https://forms.office.com/r/<form-id>'])
  expect(await decodeQr(await qrFrame('', 0, { x: 0, y: 0 }), region)).toEqual([])
})

test('decodes every spike sample code of 12% of the slide height or more', async () => {
  expect(await decodeQr(await sample('A-s09-msforms-12br.png'), A)).toEqual(['https://forms.office.com/r/TEI1JEzO3j'])
  expect(await decodeQr(await sample('A-s05-google-35centre.png'), A)).toEqual([GOOGLE_35])
  expect(await decodeQr(await sample('C-s17-google-20centre.png'), A)).toEqual([GOOGLE_20])
  expect(await decodeQr(await sample('A-s09-msforms-12br.png'), null)).toEqual([
    'https://forms.office.com/r/TEI1JEzO3j'
  ])
})

test('a slide with two codes returns both, and a blank slide returns none', async () => {
  const both = await decodeQr(await sample('A-s11-dual-12.png'), A)
  expect([...both].sort()).toEqual([GOOGLE_12, 'https://forms.office.com/r/7o2SI9XsQT'].sort())
  expect(await decodeQr(await sample('A-s01-blank.png'), A)).toEqual([])
})

test('a region outside the frame is ignored', async () => {
  const png = await qrFrame('https://forms.gle/<form-id>', 300, { x: 800, y: 300 })
  expect(await decodeQr(png, { x: 5000, y: 5000, width: 10, height: 10 })).toEqual(['https://forms.gle/<form-id>'])
})

test('a region that runs past the frame edge is clipped to the frame', async () => {
  const png = await qrFrame('https://forms.office.com/r/<form-id>', 76, { x: 1300, y: 780 })
  expect(await decodeQr(png, { x: 1250, y: 730, width: 1000, height: 600 })).toEqual([
    'https://forms.office.com/r/<form-id>'
  ])
})

test('a dead bridge fails loudly, and the next call starts a fresh one', async () => {
  const png = await qrFrame('https://forms.gle/<form-id>', 300, { x: 800, y: 300 })
  await closeQr()
  const python = process.env.TM_WECHAT_PYTHON
  process.env.TM_WECHAT_PYTHON = '/nonexistent/python'
  try {
    await expect(decodeQr(png, null)).rejects.toThrow(/could not start/)
  } finally {
    process.env.TM_WECHAT_PYTHON = python
  }
  expect(await decodeQr(png, null)).toEqual(['https://forms.gle/<form-id>'])
})

test('missing models fail loudly instead of falling back to zxing alone', async () => {
  const png = await qrFrame('https://forms.gle/<form-id>', 300, { x: 800, y: 300 })
  await closeQr()
  const models = process.env.TM_WECHAT_MODELS_DIR
  process.env.TM_WECHAT_MODELS_DIR = '/nonexistent/models'
  try {
    await expect(decodeQr(png, null)).rejects.toThrow(/exited[\s\S]*SystemError/)
  } finally {
    process.env.TM_WECHAT_MODELS_DIR = models
  }
})

test('concurrent calls on a dead bridge share one fresh bridge, and closeQr leaves no process', async () => {
  const png = await qrFrame('https://forms.gle/<form-id>', 300, { x: 800, y: 300 })
  await closeQr()
  expect(await decodeQr(png, null)).toEqual(['https://forms.gle/<form-id>'])
  const running = await bridgePids()
  expect(running).toHaveLength(1)
  process.kill(running[0], 'SIGKILL')
  for (let i = 0; i < 500 && (await bridgePids()).length > 0; i++) await Bun.sleep(10)
  await Bun.sleep(100) // the bridge records its exit once the process is reaped

  const results = await Promise.all([decodeQr(png, null), decodeQr(png, null)])
  expect(results).toEqual([['https://forms.gle/<form-id>'], ['https://forms.gle/<form-id>']])
  expect((await bridgePids()).length).toBeLessThanOrEqual(1)
  await closeQr()
  expect(await bridgePids()).toEqual([])
})

test('a bridge line that breaks the protocol is reported without the decoded text', async () => {
  const png = await qrFrame('https://forms.gle/<form-id>', 300, { x: 800, y: 300 })
  const dir = await mkdtemp(join(tmpdir(), 'qr-fake-'))
  // Stands in for python: ready, then a reply whose texts are not a list.
  const fake = join(dir, 'fake-python')
  await writeFile(
    fake,
    '#!/bin/sh\necho \'{"ready":true}\'\nread -r _request\necho \'{"id":1,"texts":"https://forms.gle/SECRET-QR-TEXT"}\'\n',
    { mode: 0o755 }
  )
  await closeQr()
  const python = process.env.TM_WECHAT_PYTHON
  process.env.TM_WECHAT_PYTHON = fake
  try {
    const error = await decodeQr(png, null).then(
      () => null,
      (err: Error) => err
    )
    expect(error?.message).toMatch(/unreadable line/)
    expect(error?.message).not.toContain('SECRET-QR-TEXT')
  } finally {
    process.env.TM_WECHAT_PYTHON = python
    await closeQr()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a code counts after two consecutive frames, once', () => {
  const c = new QrConfirmer()
  expect(c.push(['a'])).toEqual([])
  expect(c.push(['a'])).toEqual(['a'])
  expect(c.push(['a'])).toEqual([])
  expect(c.push(['b'])).toEqual([])
  expect(c.push([])).toEqual([])
  expect(c.push(['b'])).toEqual([])
  expect(c.push(['b'])).toEqual(['b'])
})
