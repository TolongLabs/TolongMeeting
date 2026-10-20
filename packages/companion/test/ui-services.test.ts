import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PairResponse } from '@tm/core'
import { SecretStore, type SafeStorageLike } from '../src/secrets'
import { defaultSettings, loadSettings, saveSettings, type Settings } from '../src/settings'
import { StateStore } from '../src/state'
import { PairingService, SettingsService } from '../src/ui/services'

const dirs: string[] = []
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))))
async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tm-ui-'))
  dirs.push(dir)
  return dir
}

const safe: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().replace(/^enc:/, '')
}
const DOCS = join(tmpdir(), 'tm-ui-docs')
const SERVER = 'https://tm.example'

const pairResponse: PairResponse = {
  deviceId: 'dev_1',
  token: 'tmd_secret_device_token',
  ntfy: { url: 'https://ntfy.example', topic: 'tm-abc', token: 'tk_ntfy_secret' },
  pairedAt: '2026-10-21T08:00:00.000Z'
}

function fakeFetch(respond: (r: Request) => Response | Promise<Response>, seen: Request[] = []): typeof fetch {
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      seen.push(request)
      return respond(request)
    },
    { preconnect: () => {} }
  )
}

async function pairingRig(respond: (r: Request) => Response | Promise<Response>, seen: Request[] = []) {
  const dir = await tmpDir()
  const settings = defaultSettings(DOCS, SERVER)
  const settingsPath = join(dir, 'settings.json')
  const secrets = new SecretStore(join(dir, 'secrets.json'), safe)
  const state = new StateStore(join(dir, 'state.json'))
  const errors: unknown[] = []
  let paired = 0
  const service = new PairingService({
    settings,
    secrets,
    state,
    deviceName: () => 'DESKTOP-ABC',
    saveServerUrl: async (url) => {
      settings.serverUrl = url
      await saveSettings(settingsPath, settings)
    },
    onPaired: async () => void paired++,
    onError: (e) => void errors.push(e),
    fetch: fakeFetch(respond, seen)
  })
  return { service, settings, settingsPath, secrets, state, errors, paired: () => paired }
}

describe('PairingService', () => {
  test('prefills the website address from the settings', async () => {
    const r = await pairingRig(() => Response.json(pairResponse))
    expect(r.service.defaults()).toEqual({ serverUrl: SERVER })
  })

  test('a good code pairs: tokens go to the secret store, the address is saved, the loops are told', async () => {
    const seen: Request[] = []
    const r = await pairingRig(() => Response.json(pairResponse), seen)
    expect(await r.service.submit({ serverUrl: 'http://localhost:3000', code: ' ABCD-1234 ' })).toEqual({ ok: true })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('http://localhost:3000/api/companion/pair')
    expect(await seen[0]!.json()).toEqual({ code: 'ABCD-1234', deviceName: 'DESKTOP-ABC' })
    expect(await r.secrets.get('deviceToken')).toBe(pairResponse.token)
    expect(await r.secrets.get('ntfyToken')).toBe(pairResponse.ntfy.token)
    expect(r.state.get().summariesAfter).toBe(pairResponse.pairedAt)
    expect((await loadSettings(r.settingsPath, DOCS, SERVER)).serverUrl).toBe('http://localhost:3000')
    expect(r.paired()).toBe(1)
  })

  test('the answer never carries a token, and a refused code gives the fixed sentence', async () => {
    const ok = await pairingRig(() => Response.json(pairResponse))
    expect(JSON.stringify(await ok.service.submit({ serverUrl: SERVER, code: 'ABCD-1234' }))).not.toContain('tmd_')
    const refused = await pairingRig(() => Response.json({ error: 'invalid_code' }, { status: 400 }))
    expect(await refused.service.submit({ serverUrl: SERVER, code: 'ABCD-1234' })).toEqual({
      ok: false,
      message: 'The pairing code was not accepted. Make a new code on the Devices page and try again.'
    })
    expect(refused.paired()).toBe(0)
    expect(await refused.secrets.get('deviceToken')).toBeNull()
  })

  test('a code that is not a code, or an address that is not allowed, is refused before any request', async () => {
    const seen: Request[] = []
    const r = await pairingRig(() => Response.json(pairResponse), seen)
    expect(await r.service.submit({ serverUrl: SERVER, code: '!' })).toEqual({
      ok: false,
      message: 'Enter the pairing code from the Devices page'
    })
    for (const serverUrl of ['http://tm.example', 'https://user:pw@tm.example', 'tm.example', 'https://tm.example/x']) {
      const answer = await r.service.submit({ serverUrl, code: 'ABCD-1234' })
      expect(answer).toEqual({
        ok: false,
        message: 'The website address must be an https address (http only for localhost)'
      })
    }
    expect(seen).toHaveLength(0)
  })

  test('input of the wrong shape is refused', async () => {
    const r = await pairingRig(() => Response.json(pairResponse))
    for (const input of [
      null,
      'x',
      {},
      { serverUrl: SERVER },
      { serverUrl: SERVER, code: 1 },
      { serverUrl: SERVER, code: 'a', extra: 1 }
    ]) {
      expect((await r.service.submit(input)).ok).toBe(false)
    }
    expect((await r.service.submit({ serverUrl: SERVER, code: 'x'.repeat(65) })).ok).toBe(false)
  })

  test('a network failure shows a generic sentence and goes to the log, not to the page', async () => {
    const r = await pairingRig(() => {
      throw new TypeError('connect ECONNREFUSED 10.0.0.9:443 tmd_leak')
    })
    const answer = await r.service.submit({ serverUrl: SERVER, code: 'ABCD-1234' })
    expect(answer).toEqual({
      ok: false,
      message: 'Could not pair. Check the website address and your connection, then try again.'
    })
    expect(JSON.stringify(answer)).not.toContain('ECONNREFUSED')
    expect(r.errors).toHaveLength(1)
  })

  test('a server error shows only the status', async () => {
    const r = await pairingRig(() => new Response('<html>secret stack trace</html>', { status: 500 }))
    expect(await r.service.submit({ serverUrl: SERVER, code: 'ABCD-1234' })).toEqual({
      ok: false,
      message: 'The website answered with HTTP 500'
    })
  })

  test('a PC that is already paired is not paired again', async () => {
    const r = await pairingRig(() => Response.json(pairResponse))
    await r.secrets.set('deviceToken', 'tmd_existing')
    expect(await r.service.submit({ serverUrl: SERVER, code: 'ABCD-1234' })).toEqual({
      ok: false,
      message: 'This PC is already paired.'
    })
    expect(await r.secrets.get('deviceToken')).toBe('tmd_existing')
  })

  test('a second submit while one is running is refused', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const r = await pairingRig(async () => {
      await gate
      return Response.json(pairResponse)
    })
    const first = r.service.submit({ serverUrl: SERVER, code: 'ABCD-1234' })
    await Bun.sleep(10)
    expect(await r.service.submit({ serverUrl: SERVER, code: 'ABCD-1234' })).toEqual({
      ok: false,
      message: 'Pairing is already in progress.'
    })
    release()
    expect(await first).toEqual({ ok: true })
    expect(r.paired()).toBe(1)
  })
})

describe('SettingsService', () => {
  async function settingsRig() {
    const dir = await tmpDir()
    const file = join(dir, 'settings.json')
    const settings: Settings = defaultSettings(DOCS, SERVER)
    const service = new SettingsService({ settings, save: (next) => saveSettings(file, next) })
    return { service, settings, file }
  }
  const form = (over: Record<string, string> = {}) => ({
    summariesDir: join(tmpdir(), 'notes'),
    whisperCommand: 'w {audio} {outDir}',
    whisperCwd: join(tmpdir(), 'whisper'),
    whisperModel: 'small',
    ...over
  })

  test('shows the whisper folder as empty when there is none', async () => {
    const r = await settingsRig()
    expect(r.service.get()).toEqual({
      summariesDir: join(DOCS, 'Meeting summaries'),
      whisperCommand: 'uv run transcriber {audio} -m {model} -f txt,srt,json -o {outDir}',
      whisperCwd: '',
      whisperModel: 'medium'
    })
  })

  test('a saved form is written to the file and changes the live settings in place', async () => {
    const r = await settingsRig()
    const live = r.settings
    expect(await r.service.save(form())).toEqual({ ok: true })
    expect(r.settings).toBe(live)
    expect(live.whisper).toEqual({ command: 'w {audio} {outDir}', cwd: join(tmpdir(), 'whisper'), model: 'small' })
    expect(live.summariesDir).toBe(join(tmpdir(), 'notes'))
    expect(await loadSettings(r.file, DOCS, SERVER)).toEqual(live)
    expect(await readFile(r.file, 'utf8')).toContain('"small"')
  })

  test('an empty whisper folder means none, and fields are trimmed', async () => {
    const r = await settingsRig()
    expect(await r.service.save(form({ whisperCwd: '  ', whisperModel: ' base ' }))).toEqual({ ok: true })
    expect(r.settings.whisper.cwd).toBeNull()
    expect(r.settings.whisper.model).toBe('base')
  })

  test('a bad field says which one and why, and changes nothing', async () => {
    const r = await settingsRig()
    const before = structuredClone(r.settings)
    expect(await r.service.save(form({ summariesDir: 'notes' }))).toEqual({
      ok: false,
      message: 'Summaries folder: the path must be absolute'
    })
    expect(await r.service.save(form({ summariesDir: '\\\\evil\\share' }))).toEqual({
      ok: false,
      message: 'Summaries folder: UNC and device paths are not allowed'
    })
    expect(await r.service.save(form({ summariesDir: 'C:\\Windows\\System32' }))).toEqual({
      ok: false,
      message: 'Summaries folder: system folders are not allowed'
    })
    expect(await r.service.save(form({ summariesDir: 'C:\\' }))).toEqual({
      ok: false,
      message: 'Summaries folder: drive and filesystem roots are not allowed'
    })
    expect(await r.service.save(form({ whisperCommand: ' ' }))).toEqual({
      ok: false,
      message: 'Whisper command: enter a value'
    })
    expect(await r.service.save(form({ whisperCwd: 'relative' }))).toEqual({
      ok: false,
      message: 'Whisper folder: the path must be absolute'
    })
    expect(await r.service.save(form({ whisperCwd: '\\\\attacker\\share' }))).toEqual({
      ok: false,
      message: 'Whisper folder: UNC and device paths are not allowed'
    })
    expect(await r.service.save(form({ whisperModel: 'x'.repeat(65) }))).toEqual({
      ok: false,
      message: 'The form is not valid. Close the window and open it again.'
    })
    expect(r.settings).toEqual(before)
    expect(await Bun.file(r.file).exists()).toBe(false)
  })

  test('input of the wrong shape is refused, and the website address cannot be set from here', async () => {
    const r = await settingsRig()
    for (const input of [null, {}, form({ serverUrl: 'https://evil.example' }), { ...form(), whisperModel: 5 }]) {
      expect((await r.service.save(input)).ok).toBe(false)
    }
    expect(r.settings.serverUrl).toBe(SERVER)
  })
})
