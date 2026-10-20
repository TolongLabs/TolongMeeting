import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'

// Generates the app's icons: a speech bubble with two lines of text, drawn here with no third-party art, in one
// colour. `bun scripts/make-icons.ts` rewrites `assets/` with the same bytes every time.
//   tray-white.png, tray-black.png (+ `@2x`): for a dark or a light taskbar, glyph on a transparent background.
//   icon.ico: the installer and window icon, a white glyph on a black rounded square (16, 32, 48 and 256 px).

const assets = join(import.meta.dir, '..', 'assets')
const SAMPLES = 8

/** Whether a point (0..1 on both axes) is inside a rounded rectangle. */
function inRoundRect(x: number, y: number, x0: number, y0: number, x1: number, y1: number, r: number): boolean {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = Math.min(Math.max(x, x0 + r), x1 - r)
  const cy = Math.min(Math.max(y, y0 + r), y1 - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

function inTriangle(x: number, y: number, a: number[], b: number[], c: number[]): boolean {
  const side = (p: number[], q: number[]): number => (q[0]! - p[0]!) * (y - p[1]!) - (q[1]! - p[1]!) * (x - p[0]!)
  const s1 = side(a, b)
  const s2 = side(b, c)
  const s3 = side(c, a)
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)
}

/** The glyph: a bubble outline with a tail, and two text lines inside. */
function glyph(x: number, y: number): boolean {
  const outer = inRoundRect(x, y, 0.1, 0.12, 0.9, 0.74, 0.14)
  const inner = inRoundRect(x, y, 0.19, 0.21, 0.81, 0.65, 0.07)
  const tail = inTriangle(x, y, [0.22, 0.7], [0.22, 0.92], [0.46, 0.7])
  const line1 = x >= 0.28 && x <= 0.72 && y >= 0.31 && y <= 0.39
  const line2 = x >= 0.28 && x <= 0.56 && y >= 0.47 && y <= 0.55
  return (outer && !inner) || tail || line1 || line2
}

type Paint = (x: number, y: number) => 'ink' | 'back' | 'none'

/** RGBA pixels, each averaged over SAMPLES x SAMPLES points so the edges are smooth. */
function render(
  size: number,
  ink: [number, number, number],
  back: [number, number, number] | null,
  paint: Paint
): Buffer {
  const pixels = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const kind = paint((px + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size)
          const colour = kind === 'ink' ? ink : kind === 'back' ? back : null
          if (colour === null) continue
          r += colour[0]
          g += colour[1]
          b += colour[2]
          a += 1
        }
      }
      const i = (py * size + px) * 4
      const n = SAMPLES * SAMPLES
      // Straight (non-premultiplied) colour of the covered samples, coverage as alpha.
      pixels[i] = a === 0 ? 0 : Math.round(r / a)
      pixels[i + 1] = a === 0 ? 0 : Math.round(g / a)
      pixels[i + 2] = a === 0 ? 0 : Math.round(b / a)
      pixels[i + 3] = Math.round((a / n) * 255)
    }
  }
  return pixels
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

function png(size: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** An ICO file whose images are PNGs (supported since Windows Vista). A size of 256 is stored as 0. */
function ico(images: { size: number; data: Buffer }[]): Buffer {
  const head = Buffer.alloc(6 + images.length * 16)
  head.writeUInt16LE(1, 2) // type: icon
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  images.forEach(({ size, data }, i) => {
    const e = 6 + i * 16
    head[e] = size === 256 ? 0 : size
    head[e + 1] = size === 256 ? 0 : size
    head.writeUInt16LE(1, e + 4) // colour planes
    head.writeUInt16LE(32, e + 6) // bits per pixel
    head.writeUInt32LE(data.length, e + 8)
    head.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  return Buffer.concat([head, ...images.map((i) => i.data)])
}

await mkdir(assets, { recursive: true })
const trayPaint: Paint = (x, y) => (glyph(x, y) ? 'ink' : 'none')
for (const [name, ink] of [
  ['white', [255, 255, 255]],
  ['black', [0, 0, 0]]
] as const) {
  await Bun.write(join(assets, `tray-${name}.png`), png(16, render(16, [...ink], null, trayPaint)))
  await Bun.write(join(assets, `tray-${name}@2x.png`), png(32, render(32, [...ink], null, trayPaint)))
}
const iconPaint: Paint = (x, y) => (glyph(x, y) ? 'ink' : inRoundRect(x, y, 0, 0, 1, 1, 0.2) ? 'back' : 'none')
await Bun.write(
  join(assets, 'icon.ico'),
  ico([16, 32, 48, 256].map((size) => ({ size, data: png(size, render(size, [255, 255, 255], [0, 0, 0], iconPaint)) })))
)
