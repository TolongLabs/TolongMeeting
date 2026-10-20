import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const Message = z.union([
  z.object({ ready: z.literal(true) }),
  z.object({ id: z.number(), texts: z.array(z.string()) }),
  z.object({ id: z.number().nullable(), error: z.string() })
])

const TIMEOUT_MS = 30_000
const EXCERPT_CHARS = 60

export class WechatBridgeError extends Error {}

// Where wechat_bridge.py lives: next to this module when run from source, or in ../src/qr from the bundle (dist/).
function bridgeScript(): string {
  const candidates = [
    fileURLToPath(new URL('./wechat_bridge.py', import.meta.url)),
    fileURLToPath(new URL('../src/qr/wechat_bridge.py', import.meta.url))
  ]
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new WechatBridgeError(`wechat_bridge.py not found (looked in ${candidates.join(', ')})`)
  return found
}

// A protocol error quotes the bridge's line, and that line can carry decoded QR text. Drop URLs, keep a short prefix.
function excerpt(line: string): string {
  return line.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"]*/gi, '<url>').slice(0, EXCERPT_CHARS)
}

interface Pending {
  resolve: (texts: string[]) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// Client of the long-lived OpenCV WeChat process. The process answers requests in the order they were sent.
// A worker holds one bridge in a slot. WechatBridge.shared() fills the slot synchronously, so concurrent callers
// share one process. A bridge that fails empties the slot, and the next call starts a fresh one.
export class WechatBridge {
  private static slot: WechatBridge | null = null
  private readonly pending = new Map<number, Pending>()
  private readonly exited: Promise<void>
  private markExited!: () => void
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private nextId = 1
  private failure: Error | null = null
  private stderr = ''

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.exited = new Promise<void>((resolve) => (this.markExited = resolve))
    this.readyTimer = setTimeout(
      () => this.fail(new WechatBridgeError(`WeChat bridge was not ready after ${TIMEOUT_MS} ms${this.tail()}`)),
      TIMEOUT_MS
    )
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => (this.stderr = (this.stderr + d).slice(-4000)))
    child.stdin.on('error', () => {}) // a dead child surfaces through 'close'
    child.on('error', (err) => this.fail(new WechatBridgeError(`WeChat bridge could not start: ${err.message}`)))
    // 'close' comes after stderr is drained, so the message carries the whole error output. It also follows a spawn error.
    child.on('close', (code, signal) => {
      this.fail(new WechatBridgeError(`WeChat bridge exited (code ${code}, signal ${signal})${this.tail()}`))
      this.markExited()
    })
    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line))
  }

  // The worker's bridge: started on first use, or the one that is already running.
  // Throws WechatBridgeError when the models setting is missing or the bridge script is not found.
  static shared(): WechatBridge {
    WechatBridge.slot ??= WechatBridge.launch()
    return WechatBridge.slot
  }

  // Ends the shared bridge, if one runs, and resolves once its process has exited.
  static async closeShared(): Promise<void> {
    const current = WechatBridge.slot
    WechatBridge.slot = null
    if (current) await current.close()
  }

  private static launch(): WechatBridge {
    if (!process.env.TM_WECHAT_MODELS_DIR) throw new WechatBridgeError('TM_WECHAT_MODELS_DIR is not set')
    const python = process.env.TM_WECHAT_PYTHON || 'python3'
    return new WechatBridge(spawn(python, [bridgeScript()], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env }))
  }

  private tail(): string {
    return this.stderr.trim() ? `: ${this.stderr.trim().split('\n').slice(-5).join(' | ')}` : ''
  }

  private onLine(line: string): void {
    let msg: z.infer<typeof Message>
    try {
      msg = Message.parse(JSON.parse(line))
    } catch {
      this.fail(new WechatBridgeError(`WeChat bridge sent an unreadable line: ${excerpt(line)}`))
      return
    }
    if ('ready' in msg) {
      if (this.readyTimer) clearTimeout(this.readyTimer)
      this.readyTimer = null
      return
    }
    const entry = msg.id === null ? undefined : this.pending.get(msg.id)
    if (msg.id === null || !entry) {
      this.fail(new WechatBridgeError(`WeChat bridge answered an unknown request: ${excerpt(line)}`))
      return
    }
    this.pending.delete(msg.id)
    clearTimeout(entry.timer)
    if ('error' in msg) entry.reject(new WechatBridgeError(`WeChat bridge could not decode the frame: ${msg.error}`))
    else entry.resolve(msg.texts)
  }

  // Marks the bridge dead, empties its slot, stops the process and rejects whatever waits on it. The first failure wins.
  private fail(err: Error): void {
    if (this.failure) return
    this.failure = err
    if (this.readyTimer) clearTimeout(this.readyTimer)
    if (WechatBridge.slot === this) WechatBridge.slot = null
    this.child.kill('SIGKILL')
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
      this.pending.delete(id)
    }
  }

  decode(png: Buffer): Promise<string[]> {
    if (this.failure) return Promise.reject(this.failure)
    const id = this.nextId++
    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new WechatBridgeError(`WeChat bridge did not answer within ${TIMEOUT_MS} ms`)),
        TIMEOUT_MS
      )
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ id, png: png.toString('base64') }) + '\n')
    })
  }

  // Ends the process; later decode calls reject. Resolves once the process has exited.
  close(): Promise<void> {
    this.fail(new WechatBridgeError('WeChat bridge was closed'))
    return this.exited
  }
}
