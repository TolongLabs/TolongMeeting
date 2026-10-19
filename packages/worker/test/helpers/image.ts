import { execFileSync, spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { expect } from '@playwright/test'
import type { BrowserContext, Page } from 'playwright'

export interface WindowBounds {
  left: number
  top: number
  width: number
  height: number
}

// The outer bounds of the browser window that holds `page`, from Chrome itself.
export async function windowBounds(context: BrowserContext, page: Page): Promise<WindowBounds> {
  const cdp = await context.newCDPSession(page)
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget')
    const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId })
    const { left, top, width, height } = bounds
    return { left: left!, top: top!, width: width!, height: height! }
  } finally {
    await cdp.detach()
  }
}

// The command line of the Chrome browser process (the one without --type=), read from /proc. `userDataDir` picks the
// browser of one profile; a host may run other Chrome browsers, the image never does.
export function browserCmdline(userDataDir?: string): string[] {
  const found: string[][] = []
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    let args: string[]
    try {
      args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    } catch {
      continue // the process ended while we scanned
    }
    if (/(^|\/)(chrome|google-chrome)$/.test(args[0] ?? '') && !args.some((a) => a.startsWith('--type=')))
      if (userDataDir === undefined || args.includes(`--user-data-dir=${userDataDir}`)) found.push(args)
  }
  if (found.length !== 1) throw new Error(`expected one Chrome browser process, found ${found.length}`)
  return found[0]!
}

// Starts a 440 Hz tone in the page.
export async function playTone(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const ctx = new AudioContext()
    const osc = new OscillatorNode(ctx, { frequency: 440 })
    osc.connect(ctx.destination)
    osc.start()
    await ctx.resume()
  })
}

// Records the sink's monitor for `ms` and returns the RMS level in dBFS (-120 for silence).
export async function sinkLevelDb(ms: number): Promise<number> {
  const parec = spawn('parec', ['-d', 'tm_sink.monitor', '--format=s16le', '--rate=48000', '--channels=1'], {
    stdio: ['ignore', 'pipe', 'inherit']
  })
  const chunks: Buffer[] = []
  parec.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
  const done = new Promise<void>((resolve, reject) => {
    parec.on('error', reject)
    parec.on('close', () => resolve())
  })
  await new Promise((resolve) => setTimeout(resolve, ms))
  parec.kill('SIGTERM')
  await done
  const pcm = Buffer.concat(chunks)
  const samples = Math.floor(pcm.length / 2)
  if (samples === 0) throw new Error('parec recorded no samples from tm_sink.monitor')
  let sum = 0
  for (let i = 0; i < samples; i++) sum += (pcm.readInt16LE(i * 2) / 32768) ** 2
  const rms = Math.sqrt(sum / samples)
  return rms === 0 ? -120 : Math.max(-120, 20 * Math.log10(rms))
}

// Paints a page-filling test pattern on the stage (a lime frame, magenta inside, both drawn edge to edge) and checks
// what the X display really shows at the stage rectangle: the pattern must reach every edge, so there is no browser
// frame, infobar or offset around the 1920x1080 content.
export async function expectStageFilled(stage: Page, display: string): Promise<void> {
  await stage.setContent(
    '<body style="margin:0"><div style="position:fixed;inset:0;background:#00ff00"></div>' +
      '<div style="position:fixed;inset:4px;background:#ff00ff"></div></body>'
  )
  await stage.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await new Promise((resolve) => setTimeout(resolve, 500))
  const rgb = execFileSync(
    'ffmpeg',
    ['-loglevel', 'error', '-f', 'x11grab', '-video_size', '1920x1080', '-i', `${display}+0,0`].concat([
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-'
    ]),
    { maxBuffer: 1920 * 1080 * 3 + 1024 }
  )
  const at = (x: number, y: number) => [...rgb.subarray((y * 1920 + x) * 3, (y * 1920 + x) * 3 + 3)]
  const lime = [0, 255, 0]
  const magenta = [255, 0, 255]
  const frame = [
    [0, 0],
    [1919, 0],
    [0, 1079],
    [1919, 1079],
    [3, 540],
    [1916, 540],
    [960, 3],
    [960, 1076]
  ]
  for (const [x, y] of frame) expect({ x, y, rgb: at(x!, y!) }).toEqual({ x, y, rgb: lime })
  const inside = [
    [4, 4],
    [1915, 4],
    [4, 1075],
    [1915, 1075],
    [960, 540]
  ]
  for (const [x, y] of inside) expect({ x, y, rgb: at(x!, y!) }).toEqual({ x, y, rgb: magenta })
}
