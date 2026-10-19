// Q5: cost of the Node to Python bridge. Spawns `decode_wechat.py --serve`, sends length-prefixed PNGs and
// compares each round trip with the decode time the child reports.
//   node bridge-check.mjs --frames <dir> --rect x,y,w,h [--n 100] [--out bridge.json] [--python <path>]
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const here = new URL('.', import.meta.url).pathname
const { values } = parseArgs({
  options: {
    frames: { type: 'string', default: `${here}samples` },
    rect: { type: 'string', default: '0,123,1440,810' },
    n: { type: 'string', default: '100' },
    out: { type: 'string', default: '' },
    python: { type: 'string', default: process.env.QR_PYTHON ?? `${here}.venv/bin/python` }
  }
})
const names = readdirSync(values.frames)
  .filter((f) => f.endsWith('.png'))
  .sort()
if (!names.length) throw new Error(`no PNG frames in ${values.frames}`)
const n = Number(values.n)
const pngs = names.map((f) => readFileSync(`${values.frames}/${f}`))

const child = spawn(values.python, [`${here}decode_wechat.py`, '--serve', '--rect', values.rect], {
  stdio: ['pipe', 'pipe', 'inherit']
})
let buf = ''
const waiters = []
child.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    waiters.shift()(JSON.parse(line))
  }
})
child.on('exit', (code) => {
  if (waiters.length) throw new Error(`python exited with ${code} while a frame was pending`)
})
function send(png) {
  return new Promise((resolve) => {
    waiters.push(resolve)
    const head = Buffer.alloc(4)
    head.writeUInt32BE(png.length)
    child.stdin.write(head)
    child.stdin.write(png)
  })
}
const p = (xs, q) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((q / 100) * xs.length) - 1)]

const t0 = performance.now()
await send(pngs[0])
const startMs = performance.now() - t0 // spawn to first answer: interpreter, cv2 import, model load and one decode
const overhead = []
const roundTrip = []
const decode = []
for (let i = 0; i < n; i++) {
  const t = performance.now()
  const r = await send(pngs[i % pngs.length])
  const rt = performance.now() - t
  roundTrip.push(rt)
  decode.push(r.ms)
  overhead.push(rt - r.ms)
}
child.stdin.write(Buffer.alloc(4))
child.stdin.end()
const result = {
  frames: n,
  pngKB: Math.round(pngs.reduce((a, b) => a + b.length, 0) / pngs.length / 1024),
  startMs: Math.round(startMs),
  overheadP50Ms: +p(overhead, 50).toFixed(1),
  overheadP95Ms: +p(overhead, 95).toFixed(1),
  overheadMaxMs: +Math.max(...overhead).toFixed(1),
  roundTripP95Ms: +p(roundTrip, 95).toFixed(1),
  decodeP95Ms: +p(decode, 95).toFixed(1)
}
if (values.out) writeFileSync(values.out, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))
