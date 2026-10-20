import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { loadBundle } from '../src/bundle'
import { bundleImages, toJpeg } from '../src/render/images'
import { fixture } from './fixture'

test('toJpeg keeps small images and shrinks large ones', async () => {
  const small = await toJpeg(new Uint8Array(await readFile(join(fixture, 'slides/01.webp'))))
  expect([small.bytes[0], small.bytes[1], small.width, small.height]).toEqual([0xff, 0xd8, 64, 36])
  const big = await sharp({ create: { width: 3200, height: 1800, channels: 3, background: '#fff' } })
    .webp()
    .toBuffer()
  expect(await toJpeg(big)).toMatchObject({ width: 1600, height: 900 })
})

test('toJpeg refuses an image over the pixel limit', async () => {
  const huge = await sharp({ create: { width: 8000, height: 8000, channels: 3, background: '#fff' } })
    .webp()
    .toBuffer()
  await expect(toJpeg(huge)).rejects.toThrow(/pixel/i)
})

test('bundleImages keys the slide JPEGs by bundle path', async () => {
  const images = await bundleImages(await loadBundle(fixture))
  expect([...images.keys()]).toEqual(['slides/01.webp', 'slides/02.webp'])
})

test('bundleImages names the slide that cannot be read', async () => {
  const bundle = await loadBundle(fixture)
  bundle.files = bundle.files.map((f) => (f.path === 'slides/02.webp' ? { ...f, bytes: new Uint8Array([1, 2, 3]) } : f))
  await expect(bundleImages(bundle)).rejects.toThrow('The slide image "slides/02.webp" could not be read.')
})
