import { describe, expect, mock, test } from 'bun:test'
import { CHANNELS } from '../src/ui/api'

// Loads each real preload against a stand-in `electron`, and checks what a page could ever reach through `window.tm`.

interface Exposed {
  name: string
  api: Record<string, Record<string, (...args: unknown[]) => unknown>>
}
const exposed: Exposed[] = []
const invoked: unknown[][] = []
mock.module('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: Exposed['api']) => exposed.push({ name, api }) },
  ipcRenderer: {
    invoke: (...args: unknown[]) => {
      invoked.push(args)
      return Promise.resolve('answer')
    }
  }
}))

async function load(page: string): Promise<Exposed> {
  const before = exposed.length
  await import(`../src/preload/${page}.ts`)
  expect(exposed).toHaveLength(before + 1)
  return exposed.at(-1)!
}

const pairing = await load('pairing')
const settings = await load('settings')
const signin = await load('signin')

describe('preloads', () => {
  test('each exposes one frozen `tm` object with only its own named functions', () => {
    for (const e of [pairing, settings, signin]) {
      expect(e.name).toBe('tm')
      expect(Object.isFrozen(e.api)).toBe(true)
    }
    expect(Object.keys(pairing.api)).toEqual(['pairing'])
    expect(Object.keys(pairing.api.pairing!)).toEqual(['defaults', 'submit'])
    expect(Object.keys(settings.api)).toEqual(['settings'])
    expect(Object.keys(settings.api.settings!)).toEqual(['get', 'save', 'chooseFolder'])
    expect(Object.keys(signin.api)).toEqual(['signin'])
    expect(Object.keys(signin.api.signin!)).toEqual(['done'])
    for (const e of [pairing, settings, signin]) {
      for (const group of Object.values(e.api))
        for (const fn of Object.values(group)) expect(typeof fn).toBe('function')
    }
  })

  test('a function calls its one fixed channel and nothing else', async () => {
    invoked.length = 0
    await pairing.api.pairing!.defaults!()
    await settings.api.settings!.get!()
    await signin.api.signin!.done!()
    expect(invoked).toEqual([[CHANNELS.pairingDefaults], [CHANNELS.settingsGet], [CHANNELS.signinDone]])
  })

  test('arguments are copied field by field, so extra fields never cross', async () => {
    invoked.length = 0
    await pairing.api.pairing!.submit!({ serverUrl: 'https://tm.example', code: 'ABCD', channel: 'x', extra: { a: 1 } })
    await settings.api.settings!.save!({
      summariesDir: '/s',
      whisperCommand: 'w',
      whisperCwd: '',
      whisperModel: 'm',
      extra: 1
    })
    expect(invoked).toEqual([
      [CHANNELS.pairingSubmit, { serverUrl: 'https://tm.example', code: 'ABCD' }],
      [CHANNELS.settingsSave, { summariesDir: '/s', whisperCommand: 'w', whisperCwd: '', whisperModel: 'm' }]
    ])
  })

  test('arguments of the wrong type or size throw, and nothing is sent', () => {
    invoked.length = 0
    const long = 'x'.repeat(2049)
    expect(() => pairing.api.pairing!.submit!(null)).toThrow(TypeError)
    expect(() => pairing.api.pairing!.submit!({ serverUrl: 5, code: 'a' })).toThrow(TypeError)
    expect(() => pairing.api.pairing!.submit!({ serverUrl: long, code: 'a' })).toThrow(TypeError)
    expect(() => settings.api.settings!.save!({ summariesDir: '/s' })).toThrow(TypeError)
    expect(() => settings.api.settings!.chooseFolder!('documents')).toThrow(TypeError)
    expect(() => settings.api.settings!.chooseFolder!({ toString: () => 'summaries' })).toThrow(TypeError)
    expect(invoked).toEqual([])
  })

  test('the folder picker takes only the two known kinds', async () => {
    invoked.length = 0
    await settings.api.settings!.chooseFolder!('summaries')
    await settings.api.settings!.chooseFolder!('whisper')
    expect(invoked).toEqual([
      [CHANNELS.settingsChooseFolder, 'summaries'],
      [CHANNELS.settingsChooseFolder, 'whisper']
    ])
  })
})
