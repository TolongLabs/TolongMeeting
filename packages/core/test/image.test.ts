import { describe, expect, test } from 'bun:test'
import { dHash256, hamming, meanDiff, meanLuma, type GreyImage } from '@tm/core'

const flat = (width: number, height: number, value: number): GreyImage => ({
  width,
  height,
  data: new Uint8Array(width * height).fill(value)
})

test('image maths', () => {
  expect(meanLuma(flat(128, 72, 40))).toBe(40)
  expect(meanDiff(flat(128, 72, 10), flat(128, 72, 17))).toBe(7)
  expect(dHash256(flat(17, 16, 5))).toBe(0n)
  expect(hamming(0b1011n, 0b0001n)).toBe(2)
})

describe('edge cases', () => {
  test('meanDiff is symmetric and averages per pixel', () => {
    const a = flat(2, 2, 0)
    const b: GreyImage = { width: 2, height: 2, data: Uint8Array.from([0, 0, 0, 200]) }
    expect(meanDiff(a, b)).toBe(50)
    expect(meanDiff(b, a)).toBe(50)
  })

  test('dHash256 sets bit row*16+col where a pixel is brighter than its right neighbour', () => {
    const img = flat(17, 16, 0)
    img.data[3 * 17 + 5] = 255 // row 3, col 5 beats col 6; col 4 is darker than col 5, so it stays clear
    expect(dHash256(img)).toBe(1n << BigInt(3 * 16 + 5))
    const falling = flat(17, 16, 0)
    for (let row = 0; row < 16; row++) for (let col = 0; col < 17; col++) falling.data[row * 17 + col] = 255 - col
    expect(dHash256(falling)).toBe((1n << 256n) - 1n)
  })

  test('hamming counts bits across the whole 256-bit range', () => {
    expect(hamming(0n, (1n << 256n) - 1n)).toBe(256)
    expect(hamming(5n << 200n, 5n << 200n)).toBe(0)
  })

  test('mismatched or malformed images throw', () => {
    expect(() => meanDiff(flat(2, 2, 0), flat(3, 2, 0))).toThrow(RangeError)
    expect(() => dHash256(flat(16, 16, 0))).toThrow(RangeError)
    expect(() => hamming(-1n, 0n)).toThrow(RangeError)
    expect(() => meanLuma({ width: 2, height: 2, data: new Uint8Array(3) })).toThrow(RangeError)
  })
})
