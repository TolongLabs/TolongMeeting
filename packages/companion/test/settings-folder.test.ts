import { describe, expect, test } from 'bun:test'
import { defaultSettings, isValidSettingsFolder, SettingsSchema, validateFolderPath } from '../src/settings'
import { SettingsService } from '../src/ui/services'

describe('settings folder validation', () => {
  const ok = {
    summariesDir: '/home/user/Documents/Meeting summaries',
    whisperCommand: 'w {audio}',
    whisperCwd: '',
    whisperModel: 'medium'
  }

  test('accepts valid POSIX and Windows directories', () => {
    expect(validateFolderPath('/home/user/Documents').ok).toBe(true)
    expect(validateFolderPath('C:\\Users\\user\\Documents').ok).toBe(true)
    expect(validateFolderPath('d:\\projects\\notes').ok).toBe(true)
  })

  test('refuses UNC and device paths', () => {
    const cases = ['\\\\evil\\share', '//evil/share', '\\\\?\\C:\\Windows', '\\\\.\\pipe', '//?/C:/Windows', '//./pipe']
    for (const p of cases) {
      const res = validateFolderPath(p)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toBe('UNC and device paths are not allowed')
    }
  })

  test('refuses relative paths and paths that still escape with ..', () => {
    const resRelative = validateFolderPath('notes')
    expect(resRelative.ok).toBe(false)
    if (!resRelative.ok) expect(resRelative.error).toBe('the path must be absolute')

    const resRelativeEscape = validateFolderPath('../../etc')
    expect(resRelativeEscape.ok).toBe(false)
    if (!resRelativeEscape.ok) expect(resRelativeEscape.error).toBe('the path must be absolute')
  })

  test('refuses drive roots and filesystem roots', () => {
    for (const r of ['/', 'C:\\', 'C:/', 'c:\\', 'D:\\']) {
      const res = validateFolderPath(r)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toBe('drive and filesystem roots are not allowed')
    }
  })

  test('refuses POSIX system folders and subdirectories', () => {
    const posixDirs = [
      '/etc',
      '/etc/passwd',
      '/bin',
      '/bin/bash',
      '/sbin',
      '/usr',
      '/usr/local/bin',
      '/var',
      '/var/log',
      '/proc',
      '/sys',
      '/dev',
      '/boot',
      '/tmp/../etc'
    ]
    for (const d of posixDirs) {
      const res = validateFolderPath(d)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toBe('system folders are not allowed')
    }
  })

  test('refuses Windows system folders case-insensitively', () => {
    const winDirs = [
      'C:\\Windows',
      'c:\\windows',
      'C:\\Windows\\System32',
      'C:\\Users\\me\\..\\..\\Windows',
      'C:\\Program Files',
      'c:\\program files\\common files',
      'C:\\Program Files (x86)',
      'C:\\ProgramData',
      'C:\\ProgramData\\app',
      'D:\\Windows\\System32'
    ]
    for (const d of winDirs) {
      const res = validateFolderPath(d)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toBe('system folders are not allowed')
    }
  })

  test('SettingsService.save rejects hostile directories with fixed sentences', async () => {
    let saved: unknown = null
    const svc = new SettingsService({
      settings: defaultSettings('/home/user/Documents', 'https://tm.example'),
      save: async (n) => {
        saved = n
      }
    })

    const rSys = await svc.save({ ...ok, summariesDir: 'C:\\Windows\\System32' })
    expect(rSys).toEqual({ ok: false, message: 'Summaries folder: system folders are not allowed' })
    expect(saved).toBeNull()

    const rUnc = await svc.save({ ...ok, summariesDir: '\\\\evil\\share' })
    expect(rUnc).toEqual({ ok: false, message: 'Summaries folder: UNC and device paths are not allowed' })
    expect(saved).toBeNull()

    const rDotDot = await svc.save({ ...ok, summariesDir: '/tmp/../etc' })
    expect(rDotDot).toEqual({ ok: false, message: 'Summaries folder: system folders are not allowed' })
    expect(saved).toBeNull()

    const rRoot = await svc.save({ ...ok, summariesDir: '/' })
    expect(rRoot).toEqual({ ok: false, message: 'Summaries folder: drive and filesystem roots are not allowed' })
    expect(saved).toBeNull()

    const rDrive = await svc.save({ ...ok, summariesDir: 'C:\\' })
    expect(rDrive).toEqual({ ok: false, message: 'Summaries folder: drive and filesystem roots are not allowed' })
    expect(saved).toBeNull()

    const rCwdUnc = await svc.save({ ...ok, whisperCwd: '\\\\attacker\\share' })
    expect(rCwdUnc).toEqual({ ok: false, message: 'Whisper folder: UNC and device paths are not allowed' })
    expect(saved).toBeNull()

    const rCwdSys = await svc.save({ ...ok, whisperCwd: 'C:\\Windows\\System32' })
    expect(rCwdSys).toEqual({ ok: false, message: 'Whisper folder: system folders are not allowed' })
    expect(saved).toBeNull()
  })

  test('isValidSettingsFolder helper returns boolean', () => {
    expect(isValidSettingsFolder('/home/user/Documents')).toBe(true)
    expect(isValidSettingsFolder('C:\\Windows\\System32')).toBe(false)
    expect(isValidSettingsFolder(null)).toBe(false)
    expect(isValidSettingsFolder(123)).toBe(false)
  })
})
