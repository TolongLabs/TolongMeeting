import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, type SettingsApi } from '../ui/api'

// Exposes `window.tm.settings`: three named functions and nothing else. See `pairing.ts`.

const MAX = 2048
const text = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || value.length > MAX) throw new TypeError(`${what} must be a short string`)
  return value
}

const settings: SettingsApi = {
  get: () => ipcRenderer.invoke(CHANNELS.settingsGet),
  save: (form) => {
    if (typeof form !== 'object' || form === null) throw new TypeError('the settings form is missing')
    return ipcRenderer.invoke(CHANNELS.settingsSave, {
      summariesDir: text(form.summariesDir, 'the summaries folder'),
      whisperCommand: text(form.whisperCommand, 'the whisper command'),
      whisperCwd: text(form.whisperCwd, 'the whisper folder'),
      whisperModel: text(form.whisperModel, 'the whisper model')
    })
  },
  chooseFolder: (kind) => {
    if (kind !== 'summaries' && kind !== 'whisper') throw new TypeError('unknown folder')
    return ipcRenderer.invoke(CHANNELS.settingsChooseFolder, kind)
  }
}

contextBridge.exposeInMainWorld('tm', Object.freeze({ settings }))
