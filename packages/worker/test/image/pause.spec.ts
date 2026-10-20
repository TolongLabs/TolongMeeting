// Runs in the worker image only (needs Xvfb, openbox, Chrome, x11vnc and websockify):
//   docker run --rm --shm-size=2g tm-worker:dev test packages/worker/test/image/pause.spec.ts
import { execFileSync } from 'node:child_process'
import { createCipheriv } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type BrowserContext } from '@playwright/test'
import { WebSocket } from 'ws'
import { controlTokenHash, vncSecret, type SigninEventData } from '@tm/core'
import { launchBrowser } from '../../src/chrome/launch'
import { DeskPause, type DeskReopenEvent } from '../../src/control/desk-pause'
import { openSigninTabs, restoreDeskAnchor } from '../../src/control/desk-tabs'
import { idleMs, startVnc } from '../../src/control/vnc'
import { startScreen } from '../../src/display/screen'

test.skip(process.env.TM_IN_IMAGE !== '1', 'needs the worker image')

const VNC_PORT = 5900
const WS_PORT = 6080
const TIMEOUT_MS = 10_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const withTimeout = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })

// The listening sockets of a TCP port, as the kernel shows them in /proc/net/tcp: `0100007F:170C` is 127.0.0.1:5900.
async function listeners(port: number): Promise<string[]> {
  const text = await readFile('/proc/net/tcp', 'utf8')
  const hex = port.toString(16).toUpperCase().padStart(4, '0')
  return text
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols[1]?.endsWith(`:${hex}`) && cols[3] === '0A')
    .map((cols) => cols[1]!)
}

async function accepts(host: string, port: number): Promise<boolean> {
  const socket = connect({ host, port })
  socket.once('error', () => undefined)
  const result = await withTimeout(
    once(socket, 'connect').then(
      () => true,
      () => false
    ),
    2000,
    `a connection to ${host}:${port}`
  ).catch(() => false)
  socket.destroy()
  return result
}

// The container's own address on the Docker network: the desk view must not be reachable there, websockify must be.
function containerAddress(): string {
  for (const entry of Object.values(networkInterfaces()).flat())
    if (entry !== undefined && entry.family === 'IPv4' && !entry.internal) return entry.address
  throw new Error('the container has no non-loopback IPv4 address')
}

// Buffers the bytes of a stream until a reader asks for exactly n of them.
class ByteReader {
  private buffer = Buffer.alloc(0)
  private failure: Error | null = null
  private waiters: { size: number; resolve: (bytes: Buffer) => void; reject: (error: Error) => void }[] = []

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    this.drain()
  }

  fail(error: Error): void {
    this.failure = error
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  read(size: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.failure !== null) {
        reject(this.failure)
        return
      }
      this.waiters.push({ size, resolve, reject })
      this.drain()
    })
  }

  private drain(): void {
    while (this.waiters.length > 0 && this.buffer.length >= this.waiters[0]!.size) {
      const waiter = this.waiters.shift()!
      const bytes = this.buffer.subarray(0, waiter.size)
      this.buffer = this.buffer.subarray(waiter.size)
      waiter.resolve(Buffer.from(bytes))
    }
  }
}

interface Wire {
  read(size: number): Promise<Buffer>
  write(data: Buffer): void
  close(): void
}

async function tcpWire(port: number): Promise<Wire> {
  const socket = connect({ host: '127.0.0.1', port })
  const reader = new ByteReader()
  socket.on('data', (chunk) => reader.push(chunk))
  socket.on('error', (error) => reader.fail(error))
  socket.on('close', () => reader.fail(new Error('the VNC connection closed')))
  await once(socket, 'connect')
  return { read: (size) => reader.read(size), write: (data) => void socket.write(data), close: () => socket.destroy() }
}

// websockify in front of x11vnc: noVNC reaches the same RFB stream as a binary WebSocket.
async function wsWire(port: number): Promise<Wire> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`, ['binary'])
  const reader = new ByteReader()
  socket.on('message', (data) => reader.push(Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer)))
  socket.on('error', (error) => reader.fail(error))
  socket.on('close', () => reader.fail(new Error('the WebSocket closed')))
  await once(socket, 'open')
  return { read: (size) => reader.read(size), write: (data) => socket.send(data), close: () => socket.close() }
}

// VNC reverses the bits of every key byte (a bug of the original implementation) and DES-encrypts the 16-byte
// challenge as two ECB blocks. Node has DES only through OpenSSL's legacy provider, so the OpenSSL command line is the
// fallback the image ships.
function reverseBits(value: number): number {
  let out = 0
  for (let bit = 0; bit < 8; bit++) {
    out = (out << 1) | (value & 1)
    value >>= 1
  }
  return out
}

function vncKey(password: string): Buffer {
  const key = Buffer.alloc(8)
  for (let i = 0; i < 8; i++) key[i] = reverseBits(i < password.length ? password.charCodeAt(i) & 0xff : 0)
  return key
}

function desCrypt(key: Buffer, block: Buffer): Buffer {
  try {
    const cipher = createCipheriv('des-ecb', key, null)
    cipher.setAutoPadding(false)
    return Buffer.concat([cipher.update(block), cipher.final()])
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_OSSL_EVP_UNSUPPORTED') throw error
    return execFileSync(
      'openssl',
      ['enc', '-des-ecb', '-K', key.toString('hex'), '-nopad', '-provider', 'legacy', '-provider', 'default'],
      { input: block, maxBuffer: 1024 }
    )
  }
}

function desChallenge(password: string, challenge: Buffer): Buffer {
  const key = vncKey(password)
  return Buffer.concat([desCrypt(key, challenge.subarray(0, 8)), desCrypt(key, challenge.subarray(8, 16))])
}

interface PixelFormat {
  bitsPerPixel: number
  depth: number
  bigEndian: boolean
  trueColour: boolean
  redMax: number
  greenMax: number
  blueMax: number
  redShift: number
  greenShift: number
  blueShift: number
}

interface ServerInit {
  width: number
  height: number
  format: PixelFormat
  name: string
}

type AuthResult = { ok: true; server: ServerInit } | { ok: false; reason: string }

const asText = (bytes: Buffer): string => bytes.toString('utf8').replace(/\0+$/, '')

async function readReason(wire: Wire): Promise<string> {
  const length = (await wire.read(4)).readUInt32BE(0)
  return length === 0 ? '' : asText(await wire.read(length))
}

// RFB 3.8 with security type 2 (VNC authentication), as the member's browser speaks it.
async function authenticate(wire: Wire, password: string): Promise<AuthResult> {
  const version = asText(await wire.read(12))
  const match = /^RFB (\d{3})\.(\d{3})\n$/.exec(version)
  if (match === null) throw new Error(`not an RFB greeting: ${JSON.stringify(version)}`)
  if (Number(match[2]) < 7) throw new Error(`RFB ${version.trim()} does not offer a security type list`)
  wire.write(Buffer.from('RFB 003.008\n'))
  const count = (await wire.read(1))[0]!
  if (count === 0) return { ok: false, reason: await readReason(wire) }
  const types = await wire.read(count)
  if (!types.includes(2)) return { ok: false, reason: `security types ${[...types].join(',')}` }
  wire.write(Buffer.from([2]))
  wire.write(desChallenge(password, await wire.read(16)))
  const result = (await wire.read(4)).readUInt32BE(0)
  if (result !== 0) return { ok: false, reason: await readReason(wire) }
  wire.write(Buffer.from([1])) // ClientInit: shared
  const init = await wire.read(24)
  const nameLength = init.readUInt32BE(20)
  const server: ServerInit = {
    width: init.readUInt16BE(0),
    height: init.readUInt16BE(2),
    format: {
      bitsPerPixel: init[4]!,
      depth: init[5]!,
      bigEndian: init[6] !== 0,
      trueColour: init[7] !== 0,
      redMax: init.readUInt16BE(8),
      greenMax: init.readUInt16BE(10),
      blueMax: init.readUInt16BE(12),
      redShift: init[14]!,
      greenShift: init[15]!,
      blueShift: init[16]!
    },
    name: nameLength === 0 ? '' : asText(await wire.read(nameLength))
  }
  return { ok: true, server }
}

// One pushed pixel (Raw encoding only), so the view must show the desk page, not the stage.
async function readPixel(wire: Wire, server: ServerInit, x: number, y: number): Promise<[number, number, number]> {
  const { bitsPerPixel, bigEndian, trueColour, redMax, greenMax, blueMax, redShift, greenShift, blueShift } =
    server.format
  if (!trueColour || (bitsPerPixel !== 32 && bitsPerPixel !== 16))
    throw new Error(`unsupported pixel format: ${JSON.stringify(server.format)}`)
  const setEncodings = Buffer.alloc(8)
  setEncodings[0] = 2
  setEncodings.writeUInt16BE(1, 2)
  setEncodings.writeInt32BE(0, 4) // Raw
  wire.write(setEncodings)
  const request = Buffer.alloc(10)
  request[0] = 3 // FramebufferUpdateRequest
  request.writeUInt16BE(x, 2)
  request.writeUInt16BE(y, 4)
  request.writeUInt16BE(1, 6)
  request.writeUInt16BE(1, 8)
  wire.write(request)
  for (;;) {
    const type = (await wire.read(1))[0]
    if (type === 1) {
      // SetColourMapEntries
      const header = await wire.read(5)
      await wire.read(header.readUInt16BE(3) * 6)
      continue
    }
    if (type === 2) continue // Bell
    if (type === 3) {
      // ServerCutText
      const header = await wire.read(7)
      await wire.read(header.readUInt32BE(3))
      continue
    }
    if (type !== 0) throw new Error(`unexpected RFB message type ${type}`)
    const header = await wire.read(3)
    const rectangles = header.readUInt16BE(1)
    for (let i = 0; i < rectangles; i++) {
      const rect = await wire.read(12)
      const left = rect.readUInt16BE(0)
      const top = rect.readUInt16BE(2)
      const width = rect.readUInt16BE(4)
      const height = rect.readUInt16BE(6)
      const encoding = rect.readInt32BE(8)
      if (encoding !== 0) throw new Error(`expected a Raw rectangle, got encoding ${encoding}`)
      const data = await wire.read(width * height * (bitsPerPixel / 8))
      if (x < left || y < top || x >= left + width || y >= top + height) continue
      const at = ((y - top) * width + (x - left)) * (bitsPerPixel / 8)
      const value = bigEndian ? data.readUInt32BE(at) : data.readUInt32LE(at)
      const scale = (channel: number, max: number) => Math.round((channel * 255) / max)
      return [
        scale((value >>> redShift) & redMax, redMax),
        scale((value >>> greenShift) & greenMax, greenMax),
        scale((value >>> blueShift) & blueMax, blueMax)
      ]
    }
  }
}

// The command lines of every process, from ps (as the brief asks) and from /proc (which cannot truncate).
function processArgs(): string[] {
  const ps = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.trim() !== '')
  return ps
}

async function procArgs(): Promise<string[]> {
  const lines: string[] = []
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    const text = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (text !== null) lines.push(text.replace(/\0/g, ' ').trim())
  }
  return lines
}

test('a real desk pause shows the desk over VNC and holds form steps until Done', async () => {
  test.setTimeout(180_000)
  const profileDir = await mkdtemp(join(tmpdir(), 'tm-profile-'))
  const screen = await startScreen()
  let context: BrowserContext | null = null
  let pause: DeskPause | null = null
  try {
    const launched = await launchBrowser(profileDir, screen)
    context = launched.context
    let desk = launched.desk
    await launched.stage.setContent('<body style="margin:0;background:#f00"></body>')
    await desk.setContent('<body style="margin:0;background:#00f"></body>')

    const secret = vncSecret(controlTokenHash('image-pause-test'))
    expect(secret).toHaveLength(8)
    const events: (SigninEventData | DeskReopenEvent)[] = []
    const reported: unknown[] = []
    let checkpoints = 0
    // The collaborators of packages/worker/src/run.ts makeDeskPause, with real screen, browser and VNC. The sign-in
    // pages are local: the run must not depend on the internet, and the pause mechanics are what this spec checks.
    const signinPages = [
      'data:text/html,<body style="margin:0;height:100vh;background:%230000ff">one</body>',
      'data:text/html,<body style="margin:0;height:100vh;background:%230000ff">two</body>'
    ]
    pause = new DeskPause({
      startVnc: () => startVnc(screen.display, screen.desk, secret),
      idleMs: () => idleMs(screen.display),
      openTabs: (urls) =>
        openSigninTabs(
          desk,
          urls.map((_, index) => signinPages[index % signinPages.length]!),
          (error) => void reported.push(error)
        ),
      anchor: async () => {
        desk = await restoreDeskAnchor(desk)
      },
      checkpoint: async () => {
        checkpoints += 1
      },
      emit: (data) => events.push(data),
      report: (error) => reported.push(error)
    })

    await pause.pause()
    expect(pause.paused).toBe(true)
    expect(events).toEqual([{ signin: 'paused' }])
    expect(reported).toEqual([])

    // (1) x11vnc on loopback only, websockify on all interfaces of the container (no published ports).
    expect(await listeners(VNC_PORT)).toEqual(['0100007F:170C'])
    expect(await listeners(WS_PORT)).toEqual(['00000000:17C0'])
    const address = containerAddress()
    expect(await accepts('127.0.0.1', VNC_PORT)).toBe(true)
    expect(await accepts(address, VNC_PORT)).toBe(false)
    expect(await accepts(address, WS_PORT)).toBe(true)

    // websockify proxies the same RFB stream as a binary WebSocket.
    const websocket = await wsWire(WS_PORT)
    expect(asText(await withTimeout(websocket.read(12), TIMEOUT_MS, 'the websockify view'))).toBe('RFB 003.008\n')
    websocket.close()

    // The anchor tab shows the desk page; bring it to the front so the pixel below is its background, not a tab's.
    await desk.bringToFront()
    await sleep(500)

    // (2) the password is required: wrong refused, correct accepted.
    const wrong = await tcpWire(VNC_PORT)
    const refused = await withTimeout(authenticate(wrong, 'wrong-one'), TIMEOUT_MS, 'the wrong-password handshake')
    wrong.close()
    expect(refused.ok).toBe(false)

    const client = await tcpWire(VNC_PORT)
    let session: AuthResult
    try {
      session = await withTimeout(authenticate(client, secret), TIMEOUT_MS, 'the VNC handshake')
      if (!session.ok) throw new Error(`the view refused its own password: ${session.reason}`)
      // (3) the visible surface is exactly the desk half, and the pixel in its middle is the desk page, not the stage.
      expect([session.server.width, session.server.height]).toEqual([screen.desk.width, screen.desk.height])
      const pixel = await withTimeout(readPixel(client, session.server, 960, 540), TIMEOUT_MS, 'a framebuffer update')
      expect(pixel).toEqual([0, 0, 255])
    } finally {
      client.close()
    }

    // (6) the password is in no process's command line. The x11vnc command line does carry the clip geometry.
    expect(processArgs().join('\n')).not.toContain(secret)
    expect((await procArgs()).join('\n')).not.toContain(secret)
    const x11vnc = processArgs().find((line) => /(^|\/)x11vnc\s/.test(line))
    expect(x11vnc).toContain(`-clip ${screen.desk.width}x${screen.desk.height}+${screen.desk.x}+${screen.desk.y}`)

    // (4) a form step waits while the member has the desk, then runs after Done.
    const stepStarts: number[] = []
    const step = pause.deskStep(async () => {
      stepStarts.push(Date.now())
      return 'step done'
    })
    await sleep(1000)
    expect(stepStarts).toEqual([])
    const resumedAt = Date.now()
    await pause.resume('command')
    expect(await step).toBe('step done')
    expect(stepStarts).toHaveLength(1)
    expect(stepStarts[0]!).toBeGreaterThanOrEqual(resumedAt)

    // (5) Done stops both processes and closes both ports.
    expect(pause.paused).toBe(false)
    expect(await listeners(VNC_PORT)).toEqual([])
    expect(await listeners(WS_PORT)).toEqual([])
    expect(await accepts('127.0.0.1', VNC_PORT)).toBe(false)
    expect(await accepts('127.0.0.1', WS_PORT)).toBe(false)
    const leftover = [...processArgs(), ...(await procArgs())].filter((line) =>
      /(^|\/)(x11vnc|websockify)\s/.test(line)
    )
    expect(leftover).toEqual([])
    expect(events).toEqual([{ signin: 'paused' }, { signin: 'resumed', reason: 'command' }])
    expect(checkpoints).toBe(1)
    expect(context.pages()).toHaveLength(2)
  } finally {
    await pause?.close()
    await context?.close()
    await screen.stop()
    await rm(profileDir, { recursive: true, force: true })
  }
})
