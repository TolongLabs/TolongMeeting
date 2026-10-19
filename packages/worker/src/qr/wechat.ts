import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { z } from 'zod'

const Message = z.union([
  z.object({ ready: z.literal(true) }),
  z.object({ id: z.number(), texts: z.array(z.string()) }),
  z.object({ id: z.number().nullable(), error: z.string() })
])

const TIMEOUT_MS = 30_000

export class WechatBridgeError extends Error {}

// Where wechat_bridge.py lives: next to this module when run from source, or in ../src/qr from the bundle (dist/).
function bridgeScript(): string {
  const candidates = [
    new URL('./wechat_bridge.py', import.meta.url),
    new URL('../src/qr/wechat_bridge.py', import.meta.url)
  ]
  const found = candidates.map((u) => u.pathname).find((p) => existsSync(p))
  if (!found)
    throw new WechatBridgeError(
      `wechat_bridge.py not found (looked in ${candidates.map((u) => u.pathname).join(', ')})`
    )
  return found
}

interface Pending {
  resolve: (texts: string[]) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// Client of the long-lived OpenCV WeChat process. The process answers requests in the order they were sent.
export class WechatBridge {
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private failure: Error | null = null
  private stderr = ''
  private started = false
  private readonly whenReady: Promise<void>
  private markReady!: () => void
  private markStartFailed!: (err: Error) => void

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.whenReady = new Promise<void>((resolve, reject) => {
      this.markReady = resolve
      this.markStartFailed = reject
    })
    const timer = setTimeout(
      () => this.fail(new WechatBridgeError(`WeChat bridge was not ready after ${TIMEOUT_MS} ms${this.tail()}`)),
      TIMEOUT_MS
    )
    void this.whenReady.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer)
    )
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => (this.stderr = (this.stderr + d).slice(-4000)))
    child.stdin.on('error', () => {}) // a dead child surfaces through 'exit'
    child.on('error', (err) => this.fail(new WechatBridgeError(`WeChat bridge could not start: ${err.message}`)))
    child.on('exit', (code, signal) =>
      this.fail(new WechatBridgeError(`WeChat bridge exited (code ${code}, signal ${signal})${this.tail()}`))
    )
    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line))
  }

  get alive(): boolean {
    return this.failure === null
  }

  // Throws WechatBridgeError when the process cannot start, exits early or does not become ready in time.
  static async start(): Promise<WechatBridge> {
    const models = process.env.TM_WECHAT_MODELS_DIR
    if (!models) throw new WechatBridgeError('TM_WECHAT_MODELS_DIR is not set')
    const python = process.env.TM_WECHAT_PYTHON || 'python3'
    const bridge = new WechatBridge(
      spawn(python, [bridgeScript()], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
    )
    await bridge.whenReady
    return bridge
  }

  private tail(): string {
    return this.stderr.trim() ? `: ${this.stderr.trim().split('\n').slice(-5).join(' | ')}` : ''
  }

  private onLine(line: string): void {
    let msg: z.infer<typeof Message>
    try {
      msg = Message.parse(JSON.parse(line))
    } catch (err) {
      this.fail(new WechatBridgeError(`WeChat bridge sent an unreadable line: ${line.slice(0, 200)}`, { cause: err }))
      return
    }
    if ('ready' in msg) {
      this.started = true
      this.markReady()
      return
    }
    const entry = msg.id === null ? undefined : this.pending.get(msg.id)
    if (msg.id === null || !entry) {
      this.fail(new WechatBridgeError(`WeChat bridge answered an unknown request: ${line.slice(0, 200)}`))
      return
    }
    this.pending.delete(msg.id)
    clearTimeout(entry.timer)
    if ('error' in msg) entry.reject(new WechatBridgeError(`WeChat bridge could not decode the frame: ${msg.error}`))
    else entry.resolve(msg.texts)
  }

  // Marks the bridge dead, stops the process and rejects whatever waits on it. The first failure wins.
  private fail(err: Error): void {
    if (this.failure) return
    this.failure = err
    this.child.kill('SIGKILL')
    if (!this.started) this.markStartFailed(err)
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

  // Ends the process; later decode calls reject.
  close(): void {
    this.fail(new WechatBridgeError('WeChat bridge was closed'))
  }
}
