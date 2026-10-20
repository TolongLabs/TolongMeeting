import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import QRCode from 'qrcode'
import sharp from 'sharp'

const QUIET = 4

// A few seconds of moving test picture with a 440 Hz tone, what the lecturer's camera and microphone would send.
export function stageClip(): Buffer {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'tm-e2e-clip-'))
  try {
    const file = join(dir, 'stage.webm')
    execFileSync(
      'ffmpeg',
      [
        ...[
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=320x180:rate=15:duration=4'
        ],
        ...[
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=4',
          '-c:v',
          'libvpx',
          '-b:v',
          '300k',
          '-c:a',
          'libopus',
          file
        ]
      ],
      { stdio: 'pipe' }
    )
    return readFileSync(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function qrPng(text: string, size: number): Promise<Buffer> {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' })
  const n = qr.modules.size + 2 * QUIET
  const pixels = Buffer.alloc(n * n, 255)
  for (let y = 0; y < qr.modules.size; y++)
    for (let x = 0; x < qr.modules.size; x++) if (qr.modules.get(y, x)) pixels[(y + QUIET) * n + x + QUIET] = 0
  return sharp(pixels, { raw: { width: n, height: n, channels: 1 } })
    .resize(size, size, { kernel: 'nearest' })
    .png()
    .toBuffer()
}

const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

// A 1410x840 slide (the size of the fake shared-screen canvas): a heading, some lines and, when `qr` is given, a code.
export async function slidePng(title: string, lines: string[], qr?: string): Promise<Buffer> {
  const text = lines
    .map((line, i) => `<text x="60" y="${230 + i * 70}" font-size="44" fill="#222">${escapeXml(line)}</text>`)
    .join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1410" height="840"><rect width="1410" height="840" fill="#f4f1e8"/><text x="60" y="130" font-size="72" font-weight="bold" fill="#111">${escapeXml(title)}</text>${text}</svg>`
  const base = sharp(Buffer.from(svg))
  if (qr === undefined) return base.png().toBuffer()
  return base
    .composite([{ input: await qrPng(qr, 440), left: 880, top: 330 }])
    .png()
    .toBuffer()
}
