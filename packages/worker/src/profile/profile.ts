import { createCipheriv, createDecipheriv, randomBytes, type CipherGCM } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { hostname as osHostname } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import * as tar from 'tar'
import type { Stopper } from '../types'
import { hostnameFor, machineIdFor } from './keys'

const MAGIC = Buffer.from('TMCK1\n')
const IV_BYTES = 12
const TAG_BYTES = 16
const KEEP_CHECKPOINTS = 3
const SINGLETON_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie']
const CACHE_SEGMENTS = new Set(['Cache', 'Code Cache', 'GPUCache', 'Crashpad'])
const CHECKPOINT_NAME = /^\d{8}T\d{6}Z\.tar\.enc$/

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
  const file = join(out, `${stampFor(now())}.tar.enc`)
  const tmp = `${file}.tmp`
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const archive = tar.c({ cwd: dir, portable: true, filter: (p) => !isCacheEntry(p) }, ['.'])
  try {
    await pipeline(archive, cipher, sealFrame(iv, cipher), createWriteStream(tmp))
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
  await rename(tmp, file)
  await pruneCheckpoints(out)
  return file
}

export async function restoreProfile(file: string, dir: string, key: Buffer): Promise<void> {
  const layout = await readLayout(file)
  // Authenticate the whole file before any byte reaches the profile.
  await decryptCheckpoint(file, key, layout, async (plain) => {
    for await (const _chunk of plain) {
      // discard: the pass exists only to check the GCM tag
    }
  })
  const staging = `${dir}.restore-${randomBytes(6).toString('hex')}`
  await mkdir(staging)
  try {
    await decryptCheckpoint(file, key, layout, (plain) => extractStream(plain, staging))
    await rename(staging, dir)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

export function startCheckpoints(dir: string, out: string, key: Buffer, intervalMs = 300_000): Stopper {
  let inFlight: Promise<void> | null = null
  let failure: unknown = null
  const timer = setInterval(() => {
    if (inFlight) return
    inFlight = checkpointProfile(dir, out, key).then(
      () => {
        inFlight = null
      },
      (err: unknown) => {
        failure ??= err
        inFlight = null
      }
    )
  }, intervalMs)
  return {
    async stop() {
      clearInterval(timer)
      await inFlight
      if (failure !== null) throw failure
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

async function readLayout(file: string): Promise<Layout> {
  const { size } = await stat(file)
  const headerLength = MAGIC.length + IV_BYTES
  if (size < headerLength + TAG_BYTES) throw new Error('not a TMCK1 checkpoint: file too short')
  const fh: FileHandle = await open(file, 'r')
  try {
    const head = await readAt(fh, 0, headerLength)
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a TMCK1 checkpoint: bad header')
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

async function decryptCheckpoint(
  file: string,
  key: Buffer,
  layout: Layout,
  sink: (plain: AsyncIterable<Buffer>) => Promise<void>
): Promise<void> {
  const decipher = createDecipheriv('aes-256-gcm', key, layout.iv)
  decipher.setAuthTag(layout.tag)
  let authFailed = false
  decipher.once('error', () => {
    authFailed = true
  })
  const cipherText = createReadStream(file, { start: layout.cipherStart, end: layout.cipherEnd - 1 })
  try {
    await pipeline(cipherText, decipher, sink)
  } catch (err) {
    if (authFailed) throw new CheckpointAuthError()
    throw err
  }
}

async function extractStream(plain: AsyncIterable<Buffer>, dest: string): Promise<void> {
  const unpack = tar.x({ cwd: dest })
  await pipeline(plain, unpack)
}

async function pruneCheckpoints(out: string): Promise<void> {
  const names = (await readdir(out)).filter((f) => CHECKPOINT_NAME.test(f)).sort()
  for (const old of names.slice(0, -KEEP_CHECKPOINTS)) await rm(join(out, old), { force: true })
}
