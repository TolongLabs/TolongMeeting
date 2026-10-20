import { expect, test } from 'bun:test'
import { meanDiff, type GreyImage } from '@tm/core'
import sharp from 'sharp'
import { DIFF_WIDTH, KeyframeSelector, hashInput, hashOf, thumbnail } from '../src/frames/keyframes'

const flat = (v: number): GreyImage => ({ width: 128, height: 72, data: new Uint8Array(128 * 72).fill(v) })

// A patterned 128x72 image: a checkerboard whose cell width depends on n, so slide(1) and slide(2) differ a lot.
const slide = (n: number): GreyImage => {
  const data = new Uint8Array(128 * 72)
  for (let y = 0; y < 72; y++)
    for (let x = 0; x < 128; x++) data[y * 128 + x] = (Math.floor(x / (8 * n)) + (y >> 3)) % 2 ? 200 : 40
  return { width: 128, height: 72, data }
}

// Far-apart 256-bit hashes: any two different n are 128 bits apart.
const h = (n: number) => async () => ((1n << 64n) - 1n) << BigInt(n * 64)

test("the session's keyframe rule: settled, changed, not a dHash repeat", async () => {
  const k = new KeyframeSelector()
  expect(await k.consider(slide(1), h(1))).toBe(false) // nothing to compare with yet
  expect(await k.consider(slide(1), h(1))).toBe(true) // settled and new
  expect(await k.consider(slide(1), h(1))).toBe(false) // unchanged
  expect(await k.consider(slide(2), h(2))).toBe(false) // changing, not settled
  expect(await k.consider(slide(2), h(2))).toBe(true)
  expect(await k.consider(slide(1), h(1))).toBe(false) // back to slide 1: not settled yet
  expect(await k.consider(slide(1), h(1))).toBe(false) // settled but a dHash repeat of a kept frame
})

test('the hash is only computed for settled, changed frames', async () => {
  const k = new KeyframeSelector()
  let calls = 0
  const counting = async () => {
    calls++
    return 1n
  }
  await k.consider(slide(1), counting)
  expect(calls).toBe(0)
  await k.consider(slide(1), counting)
  expect(calls).toBe(1)
  await k.consider(slide(1), counting)
  expect(calls).toBe(1)
})

test('a slow fade is never settled and a small change is not new', async () => {
  const k = new KeyframeSelector()
  // steps of 3 grey levels: always more than STABLE from the previous sample
  for (let v = 0; v <= 60; v += 3) expect(await k.consider(flat(v), h(v))).toBe(false)
  // settled, and nothing has been kept yet, so this frame is new
  expect(await k.consider(flat(60), h(1))).toBe(true)
  expect(await k.consider(flat(64), h(2))).toBe(false) // changed by 4 (< 7): not new
  expect(await k.consider(flat(64), h(2))).toBe(false)
})

// A 1920x1080 stage with a 2px-wide red/blue stripe pattern in the left 74% and a white chat panel on the right.
async function stage(left: { r: number; g: number; b: number }, panel = 255): Promise<Buffer> {
  const cut = Math.floor(1920 * DIFF_WIDTH)
  const raw = Buffer.alloc(1920 * 1080 * 3)
  for (let y = 0; y < 1080; y++)
    for (let x = 0; x < 1920; x++) {
      const i = (y * 1920 + x) * 3
      const c = x < cut ? left : { r: panel, g: panel, b: panel }
      raw[i] = c.r
      raw[i + 1] = c.g
      raw[i + 2] = c.b
    }
  return sharp(raw, { raw: { width: 1920, height: 1080, channels: 3 } })
    .png()
    .toBuffer()
}

test('thumbnails are 128x72 and hash inputs 17x16 greyscale of the left 74% only', async () => {
  const dark = await stage({ r: 20, g: 20, b: 20 }, 255)
  const darkOtherPanel = await stage({ r: 20, g: 20, b: 20 }, 0)
  const bright = await stage({ r: 200, g: 200, b: 200 }, 255)
  const t = await thumbnail(dark)
  expect([t.width, t.height, t.data.length]).toEqual([128, 72, 128 * 72])
  const hi = await hashInput(dark)
  expect([hi.width, hi.height, hi.data.length]).toEqual([17, 16, 17 * 16])
  // the chat panel is ignored; the slide area is not
  expect(meanDiff(t, await thumbnail(darkOtherPanel))).toBeLessThan(1)
  expect(meanDiff(t, await thumbnail(bright))).toBeGreaterThan(150)
  expect(Math.abs(t.data[0]! - 20)).toBeLessThanOrEqual(1)
  expect(await hashOf(dark)).toBe(0n)
})
