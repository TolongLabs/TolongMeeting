import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, type SigninApi } from '../ui/api'

// Exposes `window.tm.signin.done`: the toolbar's Done button, and nothing else. The page never sees the address of
// the remote view or its password; only the main process holds them.

const signin: SigninApi = {
  done: () => ipcRenderer.invoke(CHANNELS.signinDone)
}

contextBridge.exposeInMainWorld('tm', Object.freeze({ signin }))
