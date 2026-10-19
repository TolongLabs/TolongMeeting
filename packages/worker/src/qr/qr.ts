import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import sharp, { type Sharp } from 'sharp'
import { prepareZXingModule, readBarcodes, type ReaderOptions } from 'zxing-wasm/reader'
import type { Rect } from '../adapters/types'
import { WechatBridge } from './wechat'

// Spike 3: zxing and WeChat find different codes, so decodeQr returns the union of three stages (no first-hit stop):
//   1. zxing-wasm on the full stage frame,
//   2. zxing-wasm on the shared-screen region, cropped and upscaled 2x with Lanczos (only when a region is known),
//   3. OpenCV's WeChat detector on the full frame, in a Python process kept alive for the worker's lifetime.
// Env: TM_WECHAT_MODELS_DIR (required: directory with the four WeChat model files), TM_WECHAT_PYTHON (default python3).
// There is no zxing-only fallback. If the bridge cannot start or dies, decodeQr throws WechatBridgeError and the
// caller decides what to do; the next call starts a fresh bridge.
const ZXING: ReaderOptions = {
  formats: ['QRCode'],
  maxNumberOfSymbols: 8,
  tryHarder: true,
  tryRotate: false,
  tryInvert: true,
  tryDownscale: true
}

let zxingReady: Promise<unknown> | null = null
function initZxing(): Promise<unknown> {
  zxingReady ??= (async () => {
    const entry = createRequire(import.meta.url).resolve('zxing-wasm/reader') // <pkg>/dist/cjs/reader/index.js
    const wasm = await readFile(join(dirname(entry), '../../reader/zxing_reader.wasm'))
    await prepareZXingModule({
      overrides: {
        instantiateWasm(imports: WebAssembly.Imports, ok: (instance: WebAssembly.Instance) => void) {
          void WebAssembly.instantiate(wasm, imports).then(({ instance }) => ok(instance))
          return {}
        }
      },
      fireImmediately: true
    })
  })()
  return zxingReady
}

async function zxingDecode(image: Sharp): Promise<string[]> {
  await initZxing()
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const results = await readBarcodes(
    {
      data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
      width: info.width,
      height: info.height,
      colorSpace: 'srgb'
    },
    ZXING
  )
  return results.filter((r) => r.isValid).map((r) => r.text)
}

// The region in whole pixels, clamped to the frame; null when nothing of it lies inside the frame.
async function regionBox(png: Buffer, region: Rect) {
  const { width = 0, height = 0 } = await sharp(png).metadata()
  const left = Math.max(0, Math.floor(region.x))
  const top = Math.max(0, Math.floor(region.y))
  const right = Math.min(width, Math.ceil(region.x + region.width))
  const bottom = Math.min(height, Math.ceil(region.y + region.height))
  if (right <= left || bottom <= top) return null
  return { left, top, width: right - left, height: bottom - top }
}

async function zxingRegion(png: Buffer, region: Rect | null): Promise<string[]> {
  const box = region && (await regionBox(png, region))
  if (!box) return []
  return zxingDecode(
    sharp(png)
      .extract(box)
      .resize(box.width * 2, box.height * 2, { kernel: 'lanczos3' })
  )
}

let bridge: Promise<WechatBridge> | null = null
async function wechatDecode(png: Buffer): Promise<string[]> {
  if (bridge && !(await bridge.catch(() => null))?.alive) bridge = null
  bridge ??= WechatBridge.start()
  return (await bridge).decode(png)
}

// Decodes the QR codes on a stage frame (PNG). `region` is the shared-screen rectangle in stage coordinates, or null.
// Returns the distinct texts, in order of the stages above. Throws WechatBridgeError when the bridge fails.
export async function decodeQr(png: Buffer, region: Rect | null): Promise<string[]> {
  const stages = await Promise.all([zxingDecode(sharp(png)), zxingRegion(png, region), wechatDecode(png)])
  return [...new Set(stages.flat())]
}

// Stops the WeChat bridge, if one runs. Call it when the worker shuts down.
export async function closeQr(): Promise<void> {
  const current = bridge
  bridge = null
  if (current) (await current.catch(() => null))?.close()
}
