// Decode stage frames with zxing-wasm. Appends rows `frame,tSec,decoder,mode,ms,texts` to --out.
// mode full = whole frame; region = the shared-screen rectangle upscaled 2x with Lanczos.
// ms covers PNG decode, crop and resize (region only) and the zxing call, as a caller of decodeQr would pay.
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader'
import sharp from 'sharp'

const { values } = parseArgs({
  options: {
    frames: { type: 'string' },
    rect: { type: 'string' },
    out: { type: 'string' },
    tag: { type: 'string', default: '' },
    limit: { type: 'string', default: '0' }
  }
})
if (!values.frames || !values.rect || !values.out)
  throw new Error('usage: --frames <dir> --rect <x,y,w,h> --out <csv> [--tag <name>]')
const [x, y, w, h] = values.rect.split(',').map(Number)
if ([x, y, w, h].some(Number.isNaN)) throw new Error(`bad --rect ${values.rect}`)

const wasm = readFileSync(new URL('./node_modules/zxing-wasm/dist/reader/zxing_reader.wasm', import.meta.url))
await prepareZXingModule({
  overrides: {
    instantiateWasm(imports, ok) {
      WebAssembly.instantiate(wasm, imports).then(({ instance }) => ok(instance))
      return {}
    }
  },
  fireImmediately: true
})

const READER = {
  formats: ['QRCode'],
  maxNumberOfSymbols: 8,
  tryHarder: true,
  tryRotate: false,
  tryInvert: true,
  tryDownscale: true
}

async function decode(png, mode) {
  let img = sharp(png)
  if (mode === 'region')
    img = img.extract({ left: x, top: y, width: w, height: h }).resize(w * 2, h * 2, { kernel: 'lanczos3' })
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const results = await readBarcodes(
    { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height },
    READER
  )
  return results.filter((r) => r.isValid).map((r) => r.text)
}

const csv = (v) => `"${String(v).replaceAll('"', '""')}"`
if (!existsSync(values.out) || statSync(values.out).size === 0)
  writeFileSync(values.out, 'frame,tSec,decoder,mode,ms,texts\n')

const names = readdirSync(values.frames)
  .filter((n) => /^\d{6}\.png$/.test(n))
  .sort()
const limit = Number(values.limit) || names.length
// warm up the wasm module so start-up cost is not charged to frame 1
await decode(readFileSync(`${values.frames}/${names[0]}`), 'full')
for (const name of names.slice(0, limit)) {
  const png = readFileSync(`${values.frames}/${name}`)
  const tSec = Number(name.slice(0, 2)) * 3600 + Number(name.slice(2, 4)) * 60 + Number(name.slice(4, 6))
  const frame = values.tag ? `${values.tag}/${name}` : name
  for (const mode of ['full', 'region']) {
    const t0 = performance.now()
    const texts = await decode(png, mode)
    const ms = performance.now() - t0
    appendFileSync(values.out, `${csv(frame)},${tSec},zxing,${mode},${ms.toFixed(1)},${csv(JSON.stringify(texts))}\n`)
  }
}
