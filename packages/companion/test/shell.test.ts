import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_USER_MODEL_ID } from '../src/app-id'
import { resolvePaths, secretsFile } from '../src/paths'
import { EncryptionUnavailableError, SecretStore, type SafeStorageLike } from '../src/secrets'
import { defaultSettings, loadSettings, saveSettings } from '../src/settings'
import { StateStore } from '../src/state'

const dirs: string[] = []
async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tm-companion-'))
  dirs.push(dir)
  return dir
}
async function tmpFile(content?: string): Promise<string> {
  const file = join(await tmpDir(), 'file.json')
  if (content !== undefined) await writeFile(file, content)
  return file
}
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))))

/** Reverses and base64-encodes, so the ciphertext shares nothing with the plaintext. */
function fakeSafe(available: boolean): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from([...s].reverse().join('')),
    decryptString: (b) => [...b.toString()].reverse().join('')
  }
}

const DOCS = '/home/m/Documents'
const SERVER = 'https://tm.example'

describe('settings', () => {
  test('defaults: Documents/Meeting summaries and whisper model medium', () => {
    const s = defaultSettings(DOCS, SERVER)
    expect(s.summariesDir).toBe(join(DOCS, 'Meeting summaries'))
    expect(s.whisper).toEqual({
      command: 'uv run transcriber {audio} -m {model} -f txt,srt,json -o {outDir}',
      cwd: null,
      model: 'medium'
    })
  })

  test('loadSettings rejects a malformed file and keeps defaults for missing keys', async () => {
    const partial = await loadSettings(await tmpFile('{"summariesDir":"/home/m/Notes"}'), DOCS, SERVER)
    expect(partial.summariesDir).toBe('/home/m/Notes')
    expect(partial.whisper.model).toBe('medium')
    await expect(loadSettings(await tmpFile('{"whisper":{"model":5}}'), DOCS, SERVER)).rejects.toThrow()
    await expect(loadSettings(await tmpFile('{"whisperr":{}}'), DOCS, SERVER)).rejects.toThrow()
    await expect(loadSettings(await tmpFile('not json'), DOCS, SERVER)).rejects.toThrow()
  })

  test('a missing settings file gives the defaults', async () => {
    const file = join(await tmpDir(), 'none.json')
    expect(await loadSettings(file, DOCS, SERVER)).toEqual(defaultSettings(DOCS, SERVER))
  })

  test('a Windows summaries path is accepted on any host', async () => {
    const s = await loadSettings(await tmpFile('{"summariesDir":"D:\\\\Notes"}'), 'C:\\Docs', SERVER)
    expect(s.summariesDir).toBe('D:\\Notes')
  })

  test('the server address must be https, or http on localhost, with no credentials', async () => {
    const withUrl = (u: string) => tmpFile(JSON.stringify({ serverUrl: u }))
    await expect(loadSettings(await withUrl('http://tm.example'), DOCS, SERVER)).rejects.toThrow()
    await expect(loadSettings(await withUrl('https://user:pw@tm.example'), DOCS, SERVER)).rejects.toThrow()
    await expect(loadSettings(await withUrl('ftp://tm.example'), DOCS, SERVER)).rejects.toThrow()
    expect((await loadSettings(await withUrl('http://localhost:3000'), DOCS, SERVER)).serverUrl).toBe(
      'http://localhost:3000'
    )
    expect(() => defaultSettings(DOCS, 'http://tm.example')).toThrow()
  })

  test('a relative summaries folder is rejected', async () => {
    await expect(loadSettings(await tmpFile('{"summariesDir":"notes"}'), DOCS, SERVER)).rejects.toThrow()
  })

  test('saveSettings round-trips and creates the folder', async () => {
    const file = join(await tmpDir(), 'nested', 'settings.json')
    const s = {
      ...defaultSettings(DOCS, SERVER),
      whisper: { command: 'w {audio} {outDir}', cwd: '/opt/w', model: 'small' }
    }
    await saveSettings(file, s)
    expect(await loadSettings(file, DOCS, SERVER)).toEqual(s)
  })
})

describe('SecretStore', () => {
  test('round-trips through safeStorage and never writes plaintext', async () => {
    const file = await tmpFile()
    const store = new SecretStore(file, fakeSafe(true))
    await store.set('deviceToken', 'tmd_secret')
    await store.set('ntfyToken', 'tk_other')
    expect(await store.get('deviceToken')).toBe('tmd_secret')
    expect(await store.get('ntfyToken')).toBe('tk_other')
    const text = await readFile(file, 'utf8')
    expect(text).not.toContain('tmd_secret')
    expect(text).not.toContain('tk_other')
  })

  test('refuses to store when encryption is unavailable, and writes nothing', async () => {
    const file = await tmpFile()
    const store = new SecretStore(file, fakeSafe(false))
    await expect(store.set('deviceToken', 'tmd_secret')).rejects.toBeInstanceOf(EncryptionUnavailableError)
    expect(await Bun.file(file).exists()).toBe(false)
  })

  test('refuses to read a stored secret when encryption has become unavailable', async () => {
    const file = await tmpFile()
    await new SecretStore(file, fakeSafe(true)).set('deviceToken', 'tmd_secret')
    await expect(new SecretStore(file, fakeSafe(false)).get('deviceToken')).rejects.toBeInstanceOf(
      EncryptionUnavailableError
    )
  })

  test('an unset secret and a missing file read as null', async () => {
    const store = new SecretStore(join(await tmpDir(), 'none.json'), fakeSafe(true))
    expect(await store.get('deviceToken')).toBeNull()
  })

  test('rejects a value that is not a device token, and an empty one', async () => {
    const store = new SecretStore(await tmpFile(), fakeSafe(true))
    await expect(store.set('deviceToken', 'secret')).rejects.toThrow()
    await expect(store.set('ntfyToken', '')).rejects.toThrow()
  })

  test('clear forgets everything, even without encryption', async () => {
    const file = await tmpFile()
    await new SecretStore(file, fakeSafe(true)).set('deviceToken', 'tmd_secret')
    const store = new SecretStore(file, fakeSafe(false))
    await store.clear()
    expect(await store.get('deviceToken')).toBeNull()
  })

  test('concurrent sets keep every secret', async () => {
    const store = new SecretStore(await tmpFile(), fakeSafe(true))
    await Promise.all([store.set('deviceToken', 'tmd_a'), store.set('ntfyToken', 'tk_b')])
    expect([await store.get('deviceToken'), await store.get('ntfyToken')]).toEqual(['tmd_a', 'tk_b'])
  })

  test('the secrets file is private to the member', async () => {
    const file = await tmpFile()
    await new SecretStore(file, fakeSafe(true)).set('deviceToken', 'tmd_secret')
    expect((await Bun.file(file).stat()).mode & 0o077).toBe(0)
  })

  test('a corrupt secrets file throws instead of reading as empty', async () => {
    await expect(
      new SecretStore(await tmpFile('{"deviceToken":5}'), fakeSafe(true)).get('deviceToken')
    ).rejects.toThrow()
  })
})

describe('StateStore', () => {
  test('starts empty, saves updates and survives a restart', async () => {
    const file = join(await tmpDir(), 'state.json')
    const store = new StateStore(file)
    expect(store.get()).toEqual({ ntfyLastId: null, summariesAfter: null, lastEventId: 0 })
    await store.update({ lastEventId: 7 })
    await store.update({ ntfyLastId: 'abc', summariesAfter: '2026-10-20T10:00:00+08:00' })
    expect(new StateStore(file).get()).toEqual({
      ntfyLastId: 'abc',
      summariesAfter: '2026-10-20T10:00:00+08:00',
      lastEventId: 7
    })
  })

  test('a bad patch is refused and leaves the state alone', async () => {
    const store = new StateStore(join(await tmpDir(), 'state.json'))
    await store.update({ lastEventId: 3 })
    await expect(store.update({ lastEventId: -1 })).rejects.toThrow()
    await expect(store.update({ summariesAfter: 'yesterday' })).rejects.toThrow()
    expect(store.get().lastEventId).toBe(3)
  })

  test('a malformed state file throws', async () => {
    expect(() => new StateStore(join(tmpdir(), 'nonexistent-dir-tm', 'x.json'))).not.toThrow()
    const file = await tmpFile('{"lastEventId":"x"}')
    expect(() => new StateStore(file)).toThrow()
  })

  test('concurrent updates all land', async () => {
    const file = join(await tmpDir(), 'state.json')
    const store = new StateStore(file)
    await Promise.all([
      store.update({ lastEventId: 1 }),
      store.update({ ntfyLastId: 'x' }),
      store.update({ lastEventId: 2 })
    ])
    expect(new StateStore(file).get()).toEqual({ ntfyLastId: 'x', summariesAfter: null, lastEventId: 2 })
  })
})

describe('paths', () => {
  test('Windows: AppData and LocalAppData folders named TolongMeeting', () => {
    const p = resolvePaths({
      platform: 'win32',
      appData: '/r/AppData/Roaming',
      localAppData: '/r/AppData/Local',
      documents: '/r/Documents'
    })
    expect(p).toEqual({
      userData: join('/r/AppData/Roaming', 'TolongMeeting'),
      localData: join('/r/AppData/Local', 'TolongMeeting'),
      documents: '/r/Documents'
    })
    expect(secretsFile(p)).toBe(join('/r/AppData/Roaming', 'TolongMeeting', 'secrets.json'))
  })

  test('Windows without LOCALAPPDATA throws', () => {
    expect(() => resolvePaths({ platform: 'win32', appData: '/a', localAppData: undefined, documents: '/d' })).toThrow(
      'LOCALAPPDATA'
    )
  })

  test('other platforms keep local data under the user data folder', () => {
    const p = resolvePaths({ platform: 'linux', appData: '/home/m/.config', localAppData: undefined, documents: '/d' })
    expect(p.localData).toBe(join('/home/m/.config', 'TolongMeeting', 'local'))
  })
})

describe('installer', () => {
  test('the installer app ID is the app user model ID', async () => {
    const pkg = await Bun.file(join(import.meta.dir, '../package.json')).json()
    expect(APP_USER_MODEL_ID).toBe('com.tolonglabs.tolongmeeting')
    expect(pkg.build.appId).toBe(APP_USER_MODEL_ID)
    expect(pkg.build.win.target).toBe('nsis')
    expect(pkg.build.nsis).toMatchObject({ oneClick: true, perMachine: false })
  })

  test('Electron and the builder are pinned exactly', async () => {
    const pkg = await Bun.file(join(import.meta.dir, '../package.json')).json()
    for (const dep of ['electron', 'electron-builder']) expect(pkg.devDependencies[dep]).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
