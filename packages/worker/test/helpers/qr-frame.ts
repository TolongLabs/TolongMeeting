import QRCode from 'qrcode'
import sharp from 'sharp'

const WIDTH = 1920
const HEIGHT = 1080
const QUIET = 4

// A QR code of `size` px (quiet zone included) with sharp module edges on a dark 1920x1080 frame. Size 0: no code.
export async function qrFrame(text: string, size: number, at: { x: number; y: number }): Promise<Buffer> {
  const frame = sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#12161c' } })
  if (size === 0) return frame.png().toBuffer()
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' })
  const n = qr.modules.size + 2 * QUIET
  const pixels = Buffer.alloc(n * n, 255)
  for (let y = 0; y < qr.modules.size; y++)
    for (let x = 0; x < qr.modules.size; x++) if (qr.modules.get(y, x)) pixels[(y + QUIET) * n + x + QUIET] = 0
  const code = await sharp(pixels, { raw: { width: n, height: n, channels: 1 } })
    .resize(size, size, { kernel: 'nearest' })
    .png()
    .toBuffer()
  return frame
    .composite([{ input: code, left: at.x, top: at.y }])
    .png()
    .toBuffer()
}
