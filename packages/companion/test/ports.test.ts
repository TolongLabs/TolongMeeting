import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  electronKeepAwake,
  electronNotifier,
  electronShell,
  secureSafeStorage,
  type ElectronNotificationConstructor,
  type ElectronSafeStorage
} from '../src/main/ports'

function safe(available: boolean, backend: string): ElectronSafeStorage {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (s) => Buffer.from(s),
    decryptString: (b) => b.toString()
  }
}

describe('secureSafeStorage', () => {
  test('Linux with the built-in plaintext key counts as unavailable', () => {
    expect(secureSafeStorage(safe(true, 'basic_text'), 'linux').isEncryptionAvailable()).toBe(false)
    expect(secureSafeStorage(safe(true, 'unknown'), 'linux').isEncryptionAvailable()).toBe(false)
  })
  test('Linux with a real password manager is available', () => {
    expect(secureSafeStorage(safe(true, 'gnome_libsecret'), 'linux').isEncryptionAvailable()).toBe(true)
    expect(secureSafeStorage(safe(true, 'kwallet6'), 'linux').isEncryptionAvailable()).toBe(true)
  })
  test('Windows follows safeStorage (DPAPI)', () => {
    expect(secureSafeStorage(safe(true, 'unknown'), 'win32').isEncryptionAvailable()).toBe(true)
    expect(secureSafeStorage(safe(false, 'unknown'), 'win32').isEncryptionAvailable()).toBe(false)
  })
})

type Options = ConstructorParameters<ElectronNotificationConstructor>[0]
function fakeNotification() {
  const made: { options: Options; listeners: Record<string, (d?: { actionIndex: number }) => void>; shown: boolean }[] =
    []
  class Fake {
    private readonly rec: (typeof made)[number]
    constructor(options: Options) {
      this.rec = { options, listeners: {}, shown: false }
      made.push(this.rec)
    }
    on(event: string, listener: (d?: { actionIndex: number }) => void) {
      this.rec.listeners[event] = listener
    }
    show() {
      this.rec.shown = true
    }
  }
  return { made, ctor: Fake as unknown as ElectronNotificationConstructor }
}

describe('electronNotifier', () => {
  test('a sticky notification never times out and its buttons become actions', () => {
    const { made, ctor } = fakeNotification()
    const clicks: string[] = []
    electronNotifier(ctor).show(
      { title: 'Summary ready: CS6013', body: 'Tap to open', sticky: true, buttons: ['Open', 'Dismiss'] },
      { click: () => clicks.push('click'), action: (i) => clicks.push(`action ${i}`) }
    )
    expect(made[0]!.options).toEqual({
      title: 'Summary ready: CS6013',
      body: 'Tap to open',
      timeoutType: 'never',
      actions: [
        { type: 'button', text: 'Open' },
        { type: 'button', text: 'Dismiss' }
      ]
    })
    expect(made[0]!.shown).toBe(true)
    made[0]!.listeners.click!()
    made[0]!.listeners.action!({ actionIndex: 1 })
    expect(clicks).toEqual(['click', 'action 1'])
  })

  test('a plain notification has no timeout override and no actions', () => {
    const { made, ctor } = fakeNotification()
    electronNotifier(ctor).show({ title: 't', body: 'b', sticky: false, buttons: [] }, { click() {}, action() {} })
    expect(made[0]!.options).toEqual({ title: 't', body: 'b' })
  })
})

describe('electronKeepAwake', () => {
  test('holds app suspension until released, once', () => {
    const calls: string[] = []
    const keep = electronKeepAwake({
      start: (type) => {
        calls.push(`start ${type}`)
        return 9
      },
      stop: (id) => calls.push(`stop ${id}`)
    })
    const release = keep.acquire()
    release()
    release()
    expect(calls).toEqual(['start prevent-app-suspension', 'stop 9'])
  })
})

describe('electronShell openPath refuses what is not a summary', () => {
  test('only a regular .md file inside the summaries folder, or the folder itself', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tm-shell-'))
    const outside = await mkdtemp(join(tmpdir(), 'tm-shell-out-'))
    try {
      await writeFile(join(dir, 'ok.md'), 'x')
      for (const name of [
        'evil.bat',
        'evil.cmd',
        'evil.vbs',
        'evil.js',
        'evil.hta',
        'evil.lnk',
        'evil.url',
        'evil.scr'
      ]) {
        await writeFile(join(dir, name), 'x')
      }
      await writeFile(join(outside, 'out.md'), 'x')
      await symlink(join(outside, 'out.md'), join(dir, 'link.md'))
      const opened: string[] = []
      const shell = electronShell(
        { openPath: async (p) => (opened.push(p), ''), openExternal: async () => {} },
        () => dir
      )
      await shell.openPath(join(dir, 'ok.md'))
      await shell.openPath(dir)
      expect(opened).toEqual([join(dir, 'ok.md'), dir])
      for (const bad of [
        join(dir, 'evil.bat'),
        join(dir, 'evil.cmd'),
        join(dir, 'evil.vbs'),
        join(dir, 'evil.js'),
        join(dir, 'evil.hta'),
        join(dir, 'evil.lnk'),
        join(dir, 'evil.url'),
        join(dir, 'evil.scr'),
        join(dir, 'link.md'),
        join(outside, 'out.md'),
        join(dir, 'missing.md'),
        outside
      ]) {
        await expect(shell.openPath(bad)).rejects.toThrow('refusing')
      }
      expect(opened).toHaveLength(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('electronShell', () => {
  test('openPath throws Electron\u2019s error text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tm-shell-'))
    try {
      await writeFile(join(dir, 'a.md'), 'x')
      const ok = electronShell({ openPath: async () => '', openExternal: async () => {} }, () => dir)
      await ok.openPath(join(dir, 'a.md'))
      const bad = electronShell(
        { openPath: async () => 'Failed to open path', openExternal: async () => {} },
        () => dir
      )
      await expect(bad.openPath(join(dir, 'a.md'))).rejects.toThrow('Failed to open path')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('openExternal opens only http and https links', async () => {
    const opened: string[] = []
    const shell = electronShell({ openPath: async () => '', openExternal: async (u) => void opened.push(u) }, () =>
      tmpdir()
    )
    await shell.openExternal('https://tm.example/meetings/1')
    for (const bad of ['file:///etc/passwd', 'ms-settings:privacy', 'javascript:alert(1)'])
      await expect(shell.openExternal(bad)).rejects.toThrow()
    await expect(shell.openExternal('not a url')).rejects.toThrow()
    expect(opened).toEqual(['https://tm.example/meetings/1'])
  })
})
