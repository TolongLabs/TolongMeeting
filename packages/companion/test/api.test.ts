import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CompanionJob, PairResponse } from '@tm/core'
import { CompanionApi, CompanionApiError, DeviceRevokedError, InvalidResponseError, serverOrigin } from '../src/api'
import { completePairing, handleRevoked, pairDevice, PairingInputError, PairingRefusedError } from '../src/pairing'
import { SecretStore, type SafeStorageLike } from '../src/secrets'
import { StateStore } from '../src/state'

const dirs: string[] = []
async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tm-api-'))
  dirs.push(dir)
  return dir
}
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))))

const fakeSafe = (available: boolean): SafeStorageLike => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(s.split('').reverse().join('')),
  decryptString: (b) => b.toString().split('').reverse().join('')
})

/** A fake `fetch`: records each request and answers with `respond()`. */
function recorder(seen: Request[], respond: (r: Request) => Response | Promise<Response>): typeof fetch {
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      seen.push(request)
      return respond(request)
    },
    { preconnect: () => {} }
  )
}

const apiWith = (f: typeof fetch, over: Partial<ConstructorParameters<typeof CompanionApi>[0]> = {}) =>
  new CompanionApi({
    serverUrl: 'https://tm.example',
    token: async () => 'tmd_x',
    onRevoked: () => {},
    fetch: f,
    ...over
  })

const nativeJob: CompanionJob = {
  id: 'j1',
  kind: 'native_transcription',
  state: 'pending',
  occurrenceId: 'occ_1',
  attempts: 0,
  payload: {
    occurrenceId: 'occ_1',
    entryName: 'Maths',
    start: '2026-10-21T08:00:00Z',
    timeZone: 'Asia/Kuala_Lumpur',
    durationSec: 3600,
    flacBytes: 1000
  }
}

const pairResponse: PairResponse = {
  deviceId: 'dev_1',
  token: 'tmd_secret_device_token',
  ntfy: { url: 'https://ntfy.example', topic: 'tm-abc', token: 'tk_ntfy_secret' },
  pairedAt: '2026-10-21T08:00:00.000Z'
}

describe('CompanionApi requests', () => {
  test('requests carry the token in the Authorization header, never in the URL', async () => {
    const seen: Request[] = []
    const api = apiWith(recorder(seen, () => Response.json({ jobs: [] })))
    await api.jobs()
    expect(seen[0].url).toBe('https://tm.example/api/companion/jobs')
    expect(seen[0].headers.get('authorization')).toBe('Bearer tmd_x')
    expect(seen[0].url).not.toContain('tmd_x')
    expect(seen[0].redirect).toBe('error')
  })

  test('every call goes to the configured origin with a bearer token and no redirects', async () => {
    const seen: Request[] = []
    const api = apiWith(
      recorder(seen, (r) => {
        if (r.url.includes('/summaries/')) return new Response('# Notes')
        if (r.url.includes('/summaries')) return Response.json({ summaries: [] })
        if (r.url.endsWith('/claim')) return Response.json(nativeJob)
        if (r.url.endsWith('/events')) return new Response('', { headers: { 'content-type': 'text/event-stream' } })
        return new Response(null, { status: 204 })
      })
    )
    await api.claim('j1')
    await api.progress('j1')
    await api.fail('j1', 'boom')
    await api.uploadTranscript('j1', { txt: 'a', srt: 'b', json: '{"segments":[]}' })
    await api.summaries('2026-10-21T08:00:00.000Z')
    expect(await api.summary('occ_1')).toBe('# Notes')
    await (await api.events(7, new AbortController().signal)).body?.cancel()
    expect(seen.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      'POST /api/companion/jobs/j1/claim',
      'POST /api/companion/jobs/j1/progress',
      'POST /api/companion/jobs/j1/fail',
      'POST /api/companion/jobs/j1/transcript',
      'GET /api/companion/summaries',
      'GET /api/companion/summaries/occ_1',
      'GET /api/companion/events'
    ])
    for (const r of seen) {
      expect(new URL(r.url).origin).toBe('https://tm.example')
      expect(r.headers.get('authorization')).toBe('Bearer tmd_x')
      expect(r.redirect).toBe('error')
      expect(r.url).not.toContain('tmd_x')
    }
    expect(seen[4].url).toContain('after=2026-10-21T08%3A00%3A00.000Z')
    expect(seen[6].headers.get('last-event-id')).toBe('7')
    const form = await seen[3].formData()
    expect([...form.keys()]).toEqual(['txt', 'srt', 'json'])
    expect(await seen[2].json()).toEqual({ error: 'boom' })
  })

  test('jobs are parsed with the strict core schema', async () => {
    expect(await apiWith(recorder([], () => Response.json({ jobs: [nativeJob] }))).jobs()).toEqual([nativeJob])
    const extra = recorder([], () => Response.json({ jobs: [{ ...nativeJob, extra: 1 }] }))
    await expect(apiWith(extra).jobs()).rejects.toBeInstanceOf(InvalidResponseError)
    const notJson = recorder([], () => new Response('<html>nope</html>'))
    await expect(apiWith(notJson).jobs()).rejects.toBeInstanceOf(InvalidResponseError)
  })

  test('a body larger than the cap is refused, declared or streamed', async () => {
    const big = 'x'.repeat(5 * 1024 * 1024)
    await expect(apiWith(recorder([], () => new Response(big))).jobs()).rejects.toBeInstanceOf(InvalidResponseError)
    const streamed = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(1024 * 1024))
      }
    })
    await expect(apiWith(recorder([], () => new Response(streamed))).jobs()).rejects.toBeInstanceOf(
      InvalidResponseError
    )
    await expect(apiWith(recorder([], () => new Response(big))).summary('occ_1')).rejects.toBeInstanceOf(
      InvalidResponseError
    )
  })

  test('claim answers null on 409 and 404, and refuses a job with another id', async () => {
    for (const status of [409, 404])
      expect(await apiWith(recorder([], () => new Response('{}', { status }))).claim('j1')).toBeNull()
    const other = recorder([], () => Response.json({ ...nativeJob, id: 'j2' }))
    await expect(apiWith(other).claim('j1')).rejects.toBeInstanceOf(InvalidResponseError)
  })

  test('errors are fixed sentences: no server text, no token', async () => {
    const f = recorder([], () => new Response('secret server words tmd_x', { status: 500 }))
    const err = await apiWith(f)
      .jobs()
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CompanionApiError)
    expect((err as CompanionApiError).status).toBe(500)
    expect((err as Error).message).toBe('The website answered with HTTP 500')
  })

  test('ids that could change the path are refused before any request', async () => {
    const seen: Request[] = []
    const api = apiWith(recorder(seen, () => new Response(null, { status: 204 })))
    await expect(api.progress('../../x')).rejects.toBeInstanceOf(TypeError)
    await expect(api.summary('a/b')).rejects.toBeInstanceOf(TypeError)
    await expect(api.summaries('yesterday')).rejects.toBeInstanceOf(TypeError)
    expect(seen).toEqual([])
  })

  test('the server address must be https (http only for localhost) with no login, path or query', () => {
    expect(serverOrigin('https://tm.example')).toBe('https://tm.example')
    expect(serverOrigin('https://tm.example/')).toBe('https://tm.example')
    expect(serverOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
    for (const bad of [
      'http://tm.example',
      'ftp://tm.example',
      'https://u:p@tm.example',
      'https://tm.example/x',
      'https://tm.example/?a=1',
      'not a url'
    ])
      expect(() => serverOrigin(bad)).toThrow('The website address must be an https address')
    expect(() =>
      apiWith(
        recorder([], () => new Response()),
        { serverUrl: 'http://tm.example' }
      )
    ).toThrow()
  })
})

describe('local run secrets', () => {
  test('secrets come from the job route, are checked, and the token stays in the header', async () => {
    const seen: Request[] = []
    const api = apiWith(
      recorder(seen, () => Response.json({ apiKey: 'sk-1', details: [{ key: 'k', value: 'v', labels: [] }] }))
    )
    expect(await api.secrets('j1')).toEqual({ apiKey: 'sk-1', details: [{ key: 'k', value: 'v', labels: [] }] })
    expect(`${seen[0].method} ${new URL(seen[0].url).pathname}`).toBe('GET /api/companion/jobs/j1/secrets')
    expect(seen[0].url).not.toContain('tmd_x')
    expect(seen[0].headers.get('authorization')).toBe('Bearer tmd_x')
    const wrong = apiWith(recorder([], () => Response.json({ apiKey: '', details: [] })))
    await expect(wrong.secrets('j1')).rejects.toBeInstanceOf(InvalidResponseError)
    const gone = apiWith(recorder([], () => Response.json({ error: 'not_found' }, { status: 404 })))
    await expect(gone.secrets('j1')).rejects.toBeInstanceOf(CompanionApiError)
  })
})

describe('revoked devices', () => {
  const revoked = () => Response.json({ error: 'device_revoked_or_unknown' }, { status: 401 })

  test('a 401 calls onRevoked and throws DeviceRevokedError', async () => {
    let calls = 0
    const api = apiWith(recorder([], revoked), { onRevoked: () => calls++ })
    const err = await api.jobs().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DeviceRevokedError)
    expect((err as Error).message).toBe('PC was unpaired')
    expect(calls).toBe(1)
  })

  test('only the exact revoked answer unpairs: another 401 and a 5xx keep the secrets', async () => {
    let calls = 0
    for (const respond of [
      () => new Response('', { status: 401 }),
      () => Response.json({ error: 'something_else' }, { status: 401 }),
      () => new Response('', { status: 503 })
    ]) {
      const api = apiWith(recorder([], respond), { onRevoked: () => calls++ })
      await expect(api.jobs()).rejects.toBeInstanceOf(CompanionApiError)
    }
    expect(calls).toBe(0)
  })

  test('without a stored token the call fails as unpaired and sends nothing', async () => {
    const seen: Request[] = []
    const api = apiWith(
      recorder(seen, () => Response.json({ jobs: [] })),
      { token: async () => null }
    )
    await expect(api.jobs()).rejects.toBeInstanceOf(DeviceRevokedError)
    expect(seen).toEqual([])
  })
})

describe('downloadAudio', () => {
  test('resumes from the partial file with a Range header', async () => {
    const dest = join(await tmpDir(), 'audio.flac')
    await Bun.write(`${dest}.part`, new Uint8Array(400))
    const seen: Request[] = []
    const api = apiWith(
      recorder(
        seen,
        () => new Response(new Uint8Array(600), { status: 206, headers: { 'content-range': 'bytes 400-999/1000' } })
      )
    )
    await api.downloadAudio('j1', dest)
    expect(seen[0].headers.get('range')).toBe('bytes=400-')
    expect(Bun.file(dest).size).toBe(1000)
    expect(await readdir(join(dest, '..'))).toEqual(['audio.flac'])
  })

  test('a server that ignores the range sends the whole file again', async () => {
    const dest = join(await tmpDir(), 'audio.flac')
    await Bun.write(`${dest}.part`, new Uint8Array(400))
    const api = apiWith(recorder([], () => new Response(new Uint8Array(1000))))
    await api.downloadAudio('j1', dest)
    expect(Bun.file(dest).size).toBe(1000)
  })

  test('a download that stops early keeps the partial file for the next try', async () => {
    const dest = join(await tmpDir(), 'audio.flac')
    const short = new Response(new Uint8Array(300), { status: 206, headers: { 'content-range': 'bytes 0-999/1000' } })
    await expect(apiWith(recorder([], () => short)).downloadAudio('j1', dest)).rejects.toBeInstanceOf(
      InvalidResponseError
    )
    expect(Bun.file(`${dest}.part`).size).toBe(300)
    expect(await Bun.file(dest).exists()).toBe(false)
  })

  test('a range that does not match the request is refused', async () => {
    const dest = join(await tmpDir(), 'audio.flac')
    await Bun.write(`${dest}.part`, new Uint8Array(400))
    const wrong = new Response(new Uint8Array(900), { status: 206, headers: { 'content-range': 'bytes 100-999/1000' } })
    await expect(apiWith(recorder([], () => wrong)).downloadAudio('j1', dest)).rejects.toBeInstanceOf(
      InvalidResponseError
    )
    expect(Bun.file(`${dest}.part`).size).toBe(400)
  })

  test('a 410 or 404 is an API error and writes nothing', async () => {
    const dest = join(await tmpDir(), 'audio.flac')
    await expect(
      apiWith(recorder([], () => new Response('', { status: 410 }))).downloadAudio('j1', dest)
    ).rejects.toMatchObject({ status: 410 })
    expect(await readdir(join(dest, '..'))).toEqual([])
  })
})

describe('pairing', () => {
  test('completePairing stores both tokens in the SecretStore and starts summaries at pairedAt', async () => {
    const dir = await tmpDir()
    const secrets = new SecretStore(join(dir, 'secrets.json'), fakeSafe(true))
    const state = new StateStore(join(dir, 'state.json'))
    const saved: string[] = []
    const seen: Request[] = []
    await completePairing({
      serverUrl: 'https://tm.example',
      code: 'ABCD-EFGH',
      deviceName: 'PC',
      secrets,
      state,
      saveServerUrl: async (u) => void saved.push(u),
      fetch: recorder(seen, () => Response.json(pairResponse))
    })
    expect(await secrets.get('deviceToken')).toBe(pairResponse.token)
    expect(await secrets.get('ntfyToken')).toBe(pairResponse.ntfy.token)
    expect(state.get().summariesAfter).toBe(pairResponse.pairedAt)
    expect(state.get().ntfy).toEqual({ url: 'https://ntfy.example', topic: 'tm-abc' })
    expect(saved).toEqual(['https://tm.example'])
    expect(seen[0].url).toBe('https://tm.example/api/companion/pair')
    expect(seen[0].headers.get('authorization')).toBeNull()
    expect(seen[0].redirect).toBe('error')
    expect(await seen[0].json()).toEqual({ code: 'ABCD-EFGH', deviceName: 'PC' })
    // Neither token reaches a plain-text file.
    for (const name of await readdir(dir)) {
      const text = await Bun.file(join(dir, name)).text()
      expect(text).not.toContain(pairResponse.token)
      expect(text).not.toContain(pairResponse.ntfy.token)
    }
  })

  test('a refused code throws a fixed error and stores nothing', async () => {
    const dir = await tmpDir()
    const secrets = new SecretStore(join(dir, 'secrets.json'), fakeSafe(true))
    const state = new StateStore(join(dir, 'state.json'))
    let saved = 0
    const err = await completePairing({
      serverUrl: 'https://tm.example',
      code: 'ABCD-EFGH',
      deviceName: 'PC',
      secrets,
      state,
      saveServerUrl: async () => void saved++,
      fetch: recorder([], () => Response.json({ error: 'invalid_code' }, { status: 400 }))
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PairingRefusedError)
    expect(await secrets.get('deviceToken')).toBeNull()
    expect(state.get().summariesAfter).toBeNull()
    expect(saved).toBe(0)
  })

  test('without secure storage the token is not kept and the address is not saved', async () => {
    const dir = await tmpDir()
    const secrets = new SecretStore(join(dir, 'secrets.json'), fakeSafe(false))
    let saved = 0
    await expect(
      completePairing({
        serverUrl: 'https://tm.example',
        code: 'ABCD-EFGH',
        deviceName: 'PC',
        secrets,
        state: new StateStore(join(dir, 'state.json')),
        saveServerUrl: async () => void saved++,
        fetch: recorder([], () => Response.json(pairResponse))
      })
    ).rejects.toThrow('Secure storage is not available')
    expect(saved).toBe(0)
    expect(await readdir(dir)).toEqual([])
  })

  test('pairDevice refuses bad input, a plain-http ntfy address and an answer outside the schema', async () => {
    const never = recorder([], () => Response.json(pairResponse))
    await expect(pairDevice('https://tm.example', { code: '!!', deviceName: 'PC' }, never)).rejects.toBeInstanceOf(
      PairingInputError
    )
    await expect(pairDevice('http://tm.example', { code: 'ABCD-EFGH', deviceName: 'PC' }, never)).rejects.toThrow(
      'https address'
    )
    const plain = recorder([], () =>
      Response.json({ ...pairResponse, ntfy: { ...pairResponse.ntfy, url: 'http://ntfy.example' } })
    )
    await expect(
      pairDevice('https://tm.example', { code: 'ABCD-EFGH', deviceName: 'PC' }, plain)
    ).rejects.toBeInstanceOf(InvalidResponseError)
    const extra = recorder([], () => Response.json({ ...pairResponse, extra: true }))
    await expect(
      pairDevice('https://tm.example', { code: 'ABCD-EFGH', deviceName: 'PC' }, extra)
    ).rejects.toBeInstanceOf(InvalidResponseError)
    const down = recorder([], () => new Response('words', { status: 502 }))
    await expect(pairDevice('https://tm.example', { code: 'ABCD-EFGH', deviceName: 'PC' }, down)).rejects.toMatchObject(
      {
        status: 502
      }
    )
  })

  test('handleRevoked clears secrets, stops loops and shows the unpaired notification', async () => {
    const dir = await tmpDir()
    const shown: { title: string; body: string }[] = []
    let stopped = false
    let opened = false
    const secrets = new SecretStore(join(dir, 'secrets.json'), fakeSafe(true))
    await secrets.set('deviceToken', 'tmd_x')
    await secrets.set('ntfyToken', 'tk_y')
    await handleRevoked({
      secrets,
      stopAll: () => (stopped = true),
      openPairing: () => (opened = true),
      notifier: {
        show: (n, on) => {
          shown.push(n)
          on.click()
        }
      }
    })
    expect(await secrets.get('deviceToken')).toBeNull()
    expect(await secrets.get('ntfyToken')).toBeNull()
    expect(stopped).toBe(true)
    expect(shown[0]).toMatchObject({
      title: 'TolongMeeting is unpaired',
      body: 'This PC was removed from your account. Click to pair it again.'
    })
    expect(opened).toBe(true)
  })
})
