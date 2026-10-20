import { expect, test } from 'bun:test'
import type { GreyImage } from '@tm/core'
import { brightnessCrop, selectSlides, type Rect, type SlideCandidate } from '../src/crop'

const LEFT_OF_STAGE: Rect = { x: 0, y: 0, width: 1421, height: 1080 }

function dark(width: number, height: number): GreyImage {
  return { width, height, data: new Uint8Array(width * height) }
}

function paint(img: GreyImage, r: Rect, value: number): void {
  for (let y = r.y; y < r.y + r.height; y++)
    for (let x = r.x; x < r.x + r.width; x++) img.data[y * img.width + x] = value
}

function k(file: string, offsetMs: number, hash: bigint, luma: number): SlideCandidate {
  return { frame: { file, offsetMs, region: null }, hash, luma }
}

test('brightness crop finds the shared screen on a dark stage', () => {
  const img = dark(1920, 1080)
  paint(img, { x: 100, y: 200, width: 1000, height: 600 }, 200)
  expect(brightnessCrop(img, LEFT_OF_STAGE)).toEqual({ x: 100, y: 200, width: 1000, height: 600 })
  expect(brightnessCrop(dark(1920, 1080), LEFT_OF_STAGE)).toBeNull()
})

test('near-duplicates, build-ups and black frames are dropped', () => {
  // 'b-part' is 33 bits from 'a' (not a near-duplicate) and 12 bits from 'b' (a build-up of it, 4 s before).
  const kept = selectSlides([
    k('a', 0, 0b0n, 90),
    k('a2', 10_000, 0b111n, 90),
    k('black', 15_000, 0xffffn, 3),
    k('b-part', 20_000, (1n << 100n) | 0xffffffffn, 90),
    k('b', 24_000, (1n << 100n) | 0xfffffn, 90)
  ])
  expect(kept.map((f) => f.file)).toEqual(['a', 'b'])
})
