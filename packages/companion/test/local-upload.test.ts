import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPLOAD_CHUNK_MAX_BYTES } from '@tm/core'
import { CompanionApi, CompanionApiError } from '../src/api'
import { UploadError, isUploadPath, uploadFile, uploadSet, type UploadApi } from '../src/local/upload'
import { TOKEN, fakeServer, type FakeServer } from './fake-upload-server'

const roots: string[] = []
async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tm-upload-'))
  roots.push(dir)
  return dir
}
afterAll(() => Promise.all(roots.map((d) => rm(d, { recursive: true, force: true }))))

/** An occurrence folder holding the given files (a path, or a path with its content). */
async function occWith(files: (string | [string, string | Buffer])[]): Promise<string> {
  const occ = join(await tmp(), 'occurrences', 'o1')
  for (const f of files) {
    const [rel, content] = typeof f === 'string' ? [f, 'x'] : f
    await mkdir(join(occ, rel, '..'), { recursive: true })
    await writeFile(join(occ, rel), content)
  }
  return occ
}

const servers: FakeServer[] = []
function serve(): FakeServer {
  const s = fakeServer()
  servers.push(s)
  return s
}
afterEach(() => {
  for (const s of servers.splice(0)) s.stop()
})

function bytesOf(n: number): Buffer {
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff
  return b
}

describe('uploadSet', () => {
  test('skips the FLAC and the native transcript, and the segments once meeting.mkv exists', async () => {
    const occ = await occWith([
      'events.jsonl',
      'chat.jsonl',
      'audio.flac',
      'recording/meeting.mkv',
      'recording/attempt_1_seg_000.mkv',
      'frames/0001_140002.png',
      'transcript/native/audio.json'
    ])
    expect(await uploadSet(occ)).toEqual([
      'events.jsonl',
      'chat.jsonl',
      'frames/0001_140002.png',
      'recording/meeting.mkv'
    ])
    const noJoin = await occWith(['events.jsonl', 'recording/attempt_1_seg_000.mkv'])
    expect(await uploadSet(noJoin)).toContain('recording/attempt_1_seg_000.mkv')
  })
  test('leaves out a link, a folder and a name the website would refuse', async () => {
    const occ = await occWith(['events.jsonl', 'notes.txt', 'profiles/u1/Cookies'])
    const outside = join(await tmp(), 'secret.jsonl')
    await writeFile(outside, 'secret')
    await symlink(outside, join(occ, 'chat.jsonl'))
    await mkdir(join(occ, 'frames', '0002_140003.png'), { recursive: true })
    expect(await uploadSet(occ)).toEqual(['events.jsonl'])
  })
  test('a missing folder has nothing to upload', async () => {
    expect(await uploadSet(join(await tmp(), 'nope'))).toEqual([])
  })
})

test.each([
  ['recording/meeting.mkv', true],
  ['recording/attempt_2_seg_014.mkv', true],
  ['forms/f1/record.json', true],
  ['transcript/native/audio.srt', true],
  ['audio.flac', false],
  ['../other/events.jsonl', false],
  ['forms/../../x.json', false],
  ['/etc/passwd', false],
  ['recording\\meeting.mkv', false]
])('isUploadPath(%s) is %p', (p, ok) => expect(isUploadPath(p)).toBe(ok))

describe('uploadFile', () => {
  test('resumes from the server offset in 16 MiB chunks', async () => {
    const size = 40 * 1024 * 1024
    const data = bytesOf(size)
    const occ = await occWith([['recording/meeting.mkv', data]])
    const server = serve()
    server.files.set('recording/meeting.mkv', data.subarray(0, UPLOAD_CHUNK_MAX_BYTES))
    await uploadFile(server.api(), 'j1', occ, 'recording/meeting.mkv')
    expect(server.ranges).toEqual(['bytes 16777216-33554431/41943040', 'bytes 33554432-41943039/41943040'])
    expect(server.files.get('recording/meeting.mkv')?.equals(data)).toBe(true)
  })

  test('a file the server already holds whole sends nothing', async () => {
    const occ = await occWith([['events.jsonl', 'abc']])
    const server = serve()
    server.files.set('events.jsonl', Buffer.from('abc'))
    await uploadFile(server.api(), 'j1', occ, 'events.jsonl')
    expect(server.requests.map((r) => r.method)).toEqual(['HEAD'])
  })

  test('a retry after a crash resumes where the server stopped instead of starting again', async () => {
    const data = bytesOf(35)
    const occ = await occWith([['chat.jsonl', data]])
    const server = serve()
    let puts = 0
    const dying = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init)
        if (req.method === 'PUT' && ++puts === 3) throw new TypeError('connection lost')
        return fetch(req)
      },
      { preconnect: () => {} }
    ) as typeof fetch
    await expect(uploadFile(server.api({ fetch: dying }), 'j1', occ, 'chat.jsonl', 10)).rejects.toBeInstanceOf(
      TypeError
    )
    expect(server.ranges).toEqual(['bytes 0-9/35', 'bytes 10-19/35'])
    await uploadFile(server.api(), 'j1', occ, 'chat.jsonl', 10)
    expect(server.ranges).toEqual(['bytes 0-9/35', 'bytes 10-19/35', 'bytes 20-29/35', 'bytes 30-34/35'])
    expect(server.files.get('chat.jsonl')?.equals(data)).toBe(true)
  })

  test('never sends a chunk past the server offset, and follows the offset a 409 reports', async () => {
    const occ = await occWith([['chat.jsonl', bytesOf(30)]])
    const starts: number[] = []
    let held = 0
    const api: UploadApi = {
      uploadOffset: async () => 0,
      uploadChunk: async (_job, _path, start, _total, bytes) => {
        starts.push(start)
        // The server lost nothing but says it holds 10 bytes: the first chunk (0-9) is "already there".
        if (start !== held) return { accepted: false, offset: held }
        if (starts.length === 1) {
          held = 10
          return { accepted: false, offset: 10 }
        }
        held += bytes.byteLength
        return { accepted: true }
      }
    }
    await uploadFile(api, 'j1', occ, 'chat.jsonl', 10)
    expect(starts).toEqual([0, 10, 20])
  })

  test('stops when the server keeps answering with the wrong offset, or holds more than the file', async () => {
    const occ = await occWith([['chat.jsonl', bytesOf(30)]])
    const stuck: UploadApi = {
      uploadOffset: async () => 0,
      uploadChunk: async () => ({ accepted: false, offset: 0 })
    }
    await expect(uploadFile(stuck, 'j1', occ, 'chat.jsonl', 10)).rejects.toMatchObject({ reason: 'server_out_of_step' })
    const ahead: UploadApi = { uploadOffset: async () => 31, uploadChunk: async () => ({ accepted: true }) }
    await expect(uploadFile(ahead, 'j1', occ, 'chat.jsonl', 10)).rejects.toMatchObject({ reason: 'server_ahead' })
  })

  test('the server itself refuses a chunk that leaves a gap', async () => {
    const server = serve()
    const api = server.api()
    expect(await api.uploadChunk('j1', 'chat.jsonl', 10, 20, bytesOf(10))).toEqual({ accepted: false, offset: 0 })
    expect(await api.uploadChunk('j1', 'chat.jsonl', 0, 20, bytesOf(10))).toEqual({ accepted: true })
  })
})

describe('the request', () => {
  test('goes to https, or to a loopback address over http, and nowhere else', () => {
    const make = (serverUrl: string) => new CompanionApi({ serverUrl, token: async () => TOKEN, onRevoked: () => {} })
    expect(() => make('https://tm.example')).not.toThrow()
    expect(() => make('http://127.0.0.1:3000')).not.toThrow()
    expect(() => make('http://tm.example')).toThrow()
    expect(() => make('http://192.168.1.5:3000')).toThrow()
    expect(() => make('ftp://tm.example')).toThrow()
    expect(() => make('https://user:pass@tm.example')).toThrow()
  })

  test('carries the device token in the Authorization header only', async () => {
    const occ = await occWith([['events.jsonl', 'hello']])
    const server = serve()
    await uploadFile(server.api(), 'j1', occ, 'events.jsonl')
    expect(server.requests.length).toBeGreaterThan(1)
    for (const r of server.requests) {
      expect(r.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
      expect(r.url).not.toContain(TOKEN)
      expect(r.body.toString()).not.toContain(TOKEN)
      const others = [...r.headers.entries()].filter(([k]) => k !== 'authorization')
      expect(others.some(([, v]) => v.includes(TOKEN))).toBe(false)
    }
  })

  test('a redirect is an error and the token is not sent on', async () => {
    const occ = await occWith([['events.jsonl', 'hello']])
    const elsewhere: Request[] = []
    const other = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        elsewhere.push(req)
        return new Response(null, { status: 204, headers: { 'Upload-Offset': '0' } })
      }
    })
    const redirecting = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response(null, { status: 307, headers: { Location: `http://127.0.0.1:${other.port}/x` } })
    })
    try {
      const api = new CompanionApi({
        serverUrl: `http://127.0.0.1:${redirecting.port}`,
        token: async () => TOKEN,
        onRevoked: () => {}
      })
      await expect(uploadFile(api, 'j1', occ, 'events.jsonl')).rejects.toThrow()
      expect(elsewhere).toHaveLength(0)
    } finally {
      await redirecting.stop(true)
      await other.stop(true)
    }
  })
})

describe('what is read', () => {
  async function outsideFile(): Promise<string> {
    const file = join(await tmp(), 'secret.jsonl')
    await writeFile(file, 'TOP SECRET')
    return file
  }

  test('a link in place of the file is refused and nothing is sent', async () => {
    const occ = await occWith(['events.jsonl'])
    await symlink(await outsideFile(), join(occ, 'chat.jsonl'))
    const server = serve()
    await expect(uploadFile(server.api(), 'j1', occ, 'chat.jsonl')).rejects.toBeInstanceOf(UploadError)
    expect(server.requests).toHaveLength(0)
  })

  test('a link in place of a folder on the way is refused', async () => {
    const occ = await occWith(['events.jsonl'])
    const outside = join(await tmp(), 'rec')
    await mkdir(outside)
    await writeFile(join(outside, 'meeting.mkv'), 'TOP SECRET')
    await symlink(outside, join(occ, 'recording'))
    const server = serve()
    await expect(uploadFile(server.api(), 'j1', occ, 'recording/meeting.mkv')).rejects.toBeInstanceOf(UploadError)
    expect(server.requests).toHaveLength(0)
  })

  test('a link in place of the run folder itself is refused', async () => {
    const real = await occWith([['events.jsonl', 'x']])
    const linked = join(await tmp(), 'occ-link')
    await symlink(real, linked)
    const server = serve()
    await expect(uploadFile(server.api(), 'j1', linked, 'events.jsonl')).rejects.toBeInstanceOf(UploadError)
    expect(server.requests).toHaveLength(0)
  })

  test('a folder, a missing file and a name outside the patterns are refused', async () => {
    const occ = await occWith(['notes.txt'])
    await mkdir(join(occ, 'events.jsonl'))
    const server = serve()
    for (const rel of ['events.jsonl', 'chat.jsonl', 'notes.txt', '../x', 'audio.flac']) {
      await expect(uploadFile(server.api(), 'j1', occ, rel)).rejects.toBeInstanceOf(UploadError)
    }
    expect(server.requests).toHaveLength(0)
  })

  test('errors name no path, token, content or meeting link', async () => {
    const occ = await occWith(['events.jsonl'])
    await symlink(await outsideFile(), join(occ, 'chat.jsonl'))
    const server = serve()
    server.putFailures = 1
    const errors: Error[] = []
    for (const run of [
      () => uploadFile(server.api(), 'j1', occ, 'chat.jsonl'),
      () => uploadFile(server.api(), 'j1', occ, 'events.jsonl'),
      () => uploadFile(server.api(), 'j1', join(occ, 'missing'), 'events.jsonl'),
      () => server.api().uploadChunk('j1', 'events.jsonl', 0, 1, Buffer.from('https://zoom.us/j/123456789'))
    ]) {
      errors.push(
        await run().then(
          () => new Error('did not fail'),
          (e: Error) => e
        )
      )
    }
    expect(errors[1]).toBeInstanceOf(CompanionApiError)
    for (const e of errors) {
      expect(e.message).not.toContain(occ)
      expect(e.message).not.toContain(TOKEN)
      expect(e.message).not.toContain('TOP SECRET')
      expect(e.message).not.toContain('zoom.us')
      expect(e.message).not.toContain('tm-upload-')
    }
  })
})
