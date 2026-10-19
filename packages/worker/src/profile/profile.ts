import { createCipheriv, createDecipheriv, randomBytes, type CipherGCM, type DecipherGCM } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { hostname as osHostname } from 'node:os'
import { join, posix } from 'node:path'
import { once } from 'node:events'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as tar from 'tar'
import type { Stopper } from '../types'
import { hostnameFor, machineIdFor } from './keys'

const MAGIC = Buffer.from('TMCK1\n')
const IV_BYTES = 12
const TAG_BYTES = 16
const KEEP_CHECKPOINTS = 3
const STALE_TMP_MS = 60_000
const SINGLETON_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie']
const CACHE_SEGMENTS = new Set(['Cache', 'Code Cache', 'GPUCache', 'Crashpad'])
const CHECKPOINT_NAME = /^\d{8}T\d{6}Z\.tar\.enc$/
const TMP_NAME = /\.tar\.enc\.tmp/
const ALLOWED_ENTRY_TYPES = new Set(['File', 'Directory', 'SymbolicLink'])

export interface HostInfo {
  hostname: string
  machineIdPath: string
}

export class ProfileHostMismatch extends Error {
  constructor() {
    super('profile does not belong to this identity host')
    this.name = 'ProfileHostMismatch'
  }
}

export class CheckpointAuthError extends Error {
  constructor() {
    super('checkpoint failed authentication: wrong key or the file was altered')
    this.name = 'CheckpointAuthError'
  }
}

export class CheckpointFormatError extends Error {
  constructor(reason: string) {
    super(`not a TMCK1 checkpoint: ${reason}`)
    this.name = 'CheckpointFormatError'
  }
}

interface Layout {
  iv: Buffer
  tag: Buffer
  cipherStart: number
  cipherEnd: number
}

export async function prepareProfile(dir: string, identityId: string, host?: HostInfo): Promise<void> {
  const info = host ?? { hostname: osHostname(), machineIdPath: '/etc/machine-id' }
  if (info.hostname !== hostnameFor(identityId)) throw new ProfileHostMismatch()
  const machineId = (await readFile(info.machineIdPath, 'utf8')).trim()
  if (machineId !== machineIdFor(identityId)) throw new ProfileHostMismatch()
  for (const name of SINGLETON_FILES) await rm(join(dir, name), { force: true })
}

export function isCacheEntry(entryPath: string): boolean {
  const parts = entryPath.split('/').filter((p) => p !== '' && p !== '.')
  return parts.some(
    (part, i) => CACHE_SEGMENTS.has(part) || (part === 'Service Worker' && parts[i + 1] === 'CacheStorage')
  )
}

export async function checkpointProfile(
  dir: string,
  out: string,
  key: Buffer,
  now: () => Date = () => new Date()
): Promise<string> {
  await mkdir(out, { recursive: true })
  await removeStaleTmp(out)
  const file = join(out, `${stampFor(now())}.tar.enc`)
  // A random suffix keeps two checkpoints in the same second from sharing a tmp file.
  const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const archive = tar.c({ cwd: dir, portable: true, filter: (p) => !isCacheEntry(p) }, ['.'])
  const fh = await open(tmp, 'wx', 0o600)
  let written = false
  try {
    await pipeline(archive, cipher, sealFrame(iv, cipher), writeAllTo(fh))
    await fh.sync()
    written = true
  } finally {
    await fh.close()
    if (!written) await rm(tmp, { force: true })
  }
  await rename(tmp, file)
  await syncDir(out)
  await pruneCheckpoints(out)
  return file
}

export async function restoreProfile(file: string, dir: string, key: Buffer): Promise<void> {
  const layout = await readLayout(file)
  // Authenticate the whole file before any byte reaches the profile.
  await authenticate(file, key, layout)
  const staging = `${dir}.restore-${randomBytes(6).toString('hex')}`
  await mkdir(staging)
  try {
    // The second pass runs on bytes the first pass already authenticated, so its errors are extraction errors.
    await extractCheckpoint(file, key, layout, staging)
    await rename(staging, dir)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

// Ticks never overlap. A failed tick goes to onError and the timer keeps running.
export function startCheckpoints(
  dir: string,
  out: string,
  key: Buffer,
  onError: (err: unknown) => void,
  intervalMs = 300_000
): Stopper {
  let inFlight: Promise<void> | null = null
  const timer = setInterval(() => {
    if (inFlight) return
    const tick = checkpointProfile(dir, out, key).then(
      () => undefined,
      (err: unknown) => onError(err)
    )
    inFlight = tick.finally(() => {
      inFlight = null
    })
  }, intervalMs)
  timer.unref()
  return {
    async stop() {
      clearInterval(timer)
      await inFlight
    }
  }
}

function stampFor(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
}

// Output layout: MAGIC, IV, ciphertext, then the GCM tag as the final 16 bytes.
function sealFrame(iv: Buffer, cipher: CipherGCM): (body: AsyncIterable<Buffer>) => AsyncGenerator<Buffer> {
  return async function* (body) {
    yield Buffer.concat([MAGIC, iv])
    for await (const chunk of body) yield chunk
    yield cipher.getAuthTag()
  }
}

function writeAllTo(fh: FileHandle): (body: AsyncIterable<Buffer>) => Promise<void> {
  return async (body) => {
    for await (const chunk of body) {
      let offset = 0
      while (offset < chunk.length) {
        const { bytesWritten } = await fh.write(chunk, offset, chunk.length - offset)
        offset += bytesWritten
      }
    }
  }
}

async function syncDir(path: string): Promise<void> {
  const dh = await open(path, 'r')
  try {
    await dh.sync()
  } finally {
    await dh.close()
  }
}

// Removes tmp files left by a killed process. A fresh one may belong to a checkpoint still running.
async function removeStaleTmp(out: string): Promise<void> {
  const cutoff = Date.now() - STALE_TMP_MS
  for (const name of await readdir(out)) {
    if (!TMP_NAME.test(name)) continue
    const path = join(out, name)
    const st = await stat(path).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    if (st !== null && st.mtimeMs < cutoff) await rm(path, { force: true })
  }
}

async function readLayout(file: string): Promise<Layout> {
  const { size } = await stat(file)
  const headerLength = MAGIC.length + IV_BYTES
  if (size <= headerLength + TAG_BYTES) throw new CheckpointFormatError('file too short')
  const fh: FileHandle = await open(file, 'r')
  try {
    const head = await readAt(fh, 0, headerLength)
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new CheckpointFormatError('bad header')
    const tag = await readAt(fh, size - TAG_BYTES, TAG_BYTES)
    return { iv: head.subarray(MAGIC.length), tag, cipherStart: headerLength, cipherEnd: size - TAG_BYTES }
  } finally {
    await fh.close()
  }
}

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  const { bytesRead } = await fh.read(buf, 0, length, position)
  if (bytesRead !== length) throw new Error('checkpoint changed while reading')
  return buf
}

function openDecipher(key: Buffer, layout: Layout): DecipherGCM {
  const decipher = createDecipheriv('aes-256-gcm', key, layout.iv)
  decipher.setAuthTag(layout.tag)
  return decipher
}

function readCipherText(file: string, layout: Layout): Readable {
  return createReadStream(file, { start: layout.cipherStart, end: layout.cipherEnd - 1 })
}

// Reads the whole ciphertext and discards it. Only the GCM check in the final step can fail here.
async function authenticate(file: string, key: Buffer, layout: Layout): Promise<void> {
  const decipher = openDecipher(key, layout)
  const cipherText = readCipherText(file, layout)
  // A read failure destroys the decipher too, so it must not be reported as an authentication failure.
  let readFailed = false
  let authFailed = false
  cipherText.once('error', () => {
    readFailed = true
  })
  decipher.once('error', () => {
    authFailed = true
  })
  try {
    await pipeline(cipherText, decipher, async (plain: AsyncIterable<Buffer>) => {
      for await (const _chunk of plain) {
        // discard: the pass exists only to check the GCM tag
      }
    })
  } catch (err) {
    if (authFailed && !readFailed) throw new CheckpointAuthError()
    throw err
  }
}

// Any entry that could write outside the profile, or that node-tar would silently skip, is an error.
function acceptEntry(entryPath: string, type: string | undefined): true {
  const segments = entryPath.split(/[\\/]/)
  if (posix.isAbsolute(entryPath) || segments.includes('..')) {
    throw new Error(`checkpoint entry escapes the profile: ${entryPath}`)
  }
  if (type === undefined || !ALLOWED_ENTRY_TYPES.has(type)) {
    throw new Error(`checkpoint entry type ${type ?? 'unknown'} is not allowed: ${entryPath}`)
  }
  return true
}

function acceptSymlink(entryPath: string, target: string): void {
  // A link target is relative to the link's own directory and must stay inside the profile.
  const resolved = posix.normalize(posix.join(posix.dirname(entryPath), target))
  if (posix.isAbsolute(target) || resolved === '..' || resolved.startsWith('../')) {
    throw new Error(`checkpoint symlink points outside the profile: ${entryPath} -> ${target}`)
  }
}

async function extractCheckpoint(file: string, key: Buffer, layout: Layout, dest: string): Promise<void> {
  const cipherText = readCipherText(file, layout)
  const plain = openDecipher(key, layout)
  cipherText.once('error', (err) => plain.destroy(err))
  cipherText.pipe(plain)
  // pipeline() cannot be used here: a node-tar filter error makes it call destroy() on Unpack, which has none.
  const unpack = tar.x({
    cwd: dest,
    strict: true,
    onwarn: (code, message) => {
      throw new Error(`checkpoint archive rejected (${code}): ${message}`)
    },
    filter: (entryPath, entry) => {
      if (!('type' in entry)) throw new Error(`checkpoint entry has no header: ${entryPath}`)
      acceptEntry(entryPath, entry.type)
      if (entry.type === 'SymbolicLink') acceptSymlink(entryPath, entry.linkpath ?? '')
      return true
    }
  })
  const closed = once(unpack, 'close')
  // Rejects with any extraction error. The handler only stops this promise from being unhandled while the loop runs.
  closed.catch(() => undefined)
  for await (const chunk of plain) {
    if (!unpack.write(chunk)) await Promise.race([once(unpack, 'drain'), closed])
  }
  unpack.end()
  await closed
}

async function pruneCheckpoints(out: string): Promise<void> {
  const names = (await readdir(out)).filter((f) => CHECKPOINT_NAME.test(f)).sort()
  for (const old of names.slice(0, -KEEP_CHECKPOINTS)) await rm(join(out, old), { force: true })
}
