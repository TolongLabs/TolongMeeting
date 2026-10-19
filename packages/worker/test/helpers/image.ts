import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
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

// The command line of the Chrome browser process (the one without --type=), read from /proc.
export function browserCmdline(): string[] {
  const found: string[][] = []
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    let args: string[]
    try {
      args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    } catch {
      continue // the process ended while we scanned
    }
    if (/(^|\/)(chrome|google-chrome)$/.test(args[0] ?? '') && !args.some((a) => a.startsWith('--type=')))
      found.push(args)
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
