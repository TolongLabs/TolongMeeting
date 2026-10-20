import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, type PairingApi } from '../ui/api'

// Exposes `window.tm.pairing`: two named functions and nothing else. No `ipcRenderer`, no generic invoke. The main
// process checks the sender and every argument again; the checks here only fail fast on a bug in the page.

const MAX = 2048
const text = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || value.length > MAX) throw new TypeError(`${what} must be a short string`)
  return value
}

const pairing: PairingApi = {
  defaults: () => ipcRenderer.invoke(CHANNELS.pairingDefaults),
  submit: (input) => {
    if (typeof input !== 'object' || input === null) throw new TypeError('the pairing form is missing')
    const { serverUrl, code } = input
    return ipcRenderer.invoke(CHANNELS.pairingSubmit, {
      serverUrl: text(serverUrl, 'the website address'),
      code: text(code, 'the pairing code')
    })
  }
}

contextBridge.exposeInMainWorld('tm', Object.freeze({ pairing }))
