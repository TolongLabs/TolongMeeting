import { lstat } from 'node:fs/promises'
import { isOpenableSummary } from '../summaries'
import type { DesktopNotification, DesktopNotifier, NotificationHandlers } from '../notifier'
import type { SafeStorageLike } from '../secrets'

// The Electron adapters. Each takes the Electron object it needs, so tests drive them with fakes and `index.ts` is
// the only place that imports `electron`.

// --- safeStorage ---

export interface ElectronSafeStorage extends SafeStorageLike {
  getSelectedStorageBackend(): string
}

/**
 * Electron reports encryption as available on Linux even when it falls back to a fixed built-in key (`basic_text`,
 * or `unknown` before the app is ready). That is plaintext in practice, so it counts as unavailable: no secret is
 * stored without a real password manager (DPAPI on Windows, Keychain on macOS, libsecret or KWallet on Linux).
 */
export function secureSafeStorage(safe: ElectronSafeStorage, platform: NodeJS.Platform): SafeStorageLike {
  return {
    isEncryptionAvailable() {
      if (!safe.isEncryptionAvailable()) return false
      if (platform !== 'linux') return true
      const backend = safe.getSelectedStorageBackend()
      return backend !== 'basic_text' && backend !== 'unknown'
    },
    encryptString: (s) => safe.encryptString(s),
    decryptString: (b) => safe.decryptString(b)
  }
}

// --- Notifications ---

interface ElectronNotificationInstance {
  on(event: 'click' | 'close' | 'failed', listener: () => void): unknown
  on(event: 'action', listener: (details: { actionIndex: number }) => void): unknown
  show(): void
}
export type ElectronNotificationConstructor = new (options: {
  title: string
  body: string
  timeoutType?: 'default' | 'never'
  actions?: { type: 'button'; text: string }[]
}) => ElectronNotificationInstance

export function electronNotifier(Notification: ElectronNotificationConstructor): DesktopNotifier {
  // Electron drops a notification that is garbage-collected before the member acts on it, so hold each until it ends.
  const live = new Set<ElectronNotificationInstance>()
  return {
    show(n: DesktopNotification, on: NotificationHandlers) {
      const toast = new Notification({
        title: n.title,
        body: n.body,
        ...(n.sticky ? { timeoutType: 'never' as const } : {}),
        ...(n.buttons.length > 0 ? { actions: n.buttons.map((text) => ({ type: 'button' as const, text })) } : {})
      })
      live.add(toast)
      toast.on('click', () => on.click())
      toast.on('action', (details) => on.action(details.actionIndex))
      toast.on('close', () => live.delete(toast))
      toast.on('failed', () => {
        live.delete(toast)
        console.error('desktop notification failed to show')
      })
      toast.show()
    }
  }
}

// --- Keep awake ---

export interface PowerSaveBlockerLike {
  start(type: 'prevent-app-suspension'): number
  stop(id: number): void
}

export interface KeepAwake {
  /** Asks the OS not to suspend the app. Call the result to let go. Never touches power settings. */
  acquire(): () => void
}

export function electronKeepAwake(blocker: PowerSaveBlockerLike): KeepAwake {
  return {
    acquire() {
      const id = blocker.start('prevent-app-suspension')
      let held = true
      return () => {
        if (!held) return
        held = false
        blocker.stop(id)
      }
    }
  }
}

// --- Shell ---

export interface ShellLike {
  openPath(path: string): Promise<string>
  openExternal(url: string): Promise<void>
}

/** The folder itself, or a regular `.md` file inside it. */
async function isOpenable(path: string, dir: string): Promise<boolean> {
  if (path === dir) return (await lstat(dir)).isDirectory()
  return isOpenableSummary(path, dir)
}

export interface ShellPort {
  openPath(path: string): Promise<void>
  openExternal(url: string): Promise<void>
}

/**
 * Opens a summary or a web page on the member's click. Only http and https leave the app; `file:` and app links
 * don't. `openPath` hands the system nothing but a regular `.md` file inside the summaries folder (`summariesDir`) or
 * that folder itself, so a name or a link a server chose can never start a program.
 */
export function electronShell(shell: ShellLike, summariesDir: () => string): ShellPort {
  return {
    async openPath(path) {
      if (!(await isOpenable(path, summariesDir()))) throw new Error('refusing to open that path')
      const error = await shell.openPath(path)
      if (error !== '') throw new Error(`could not open the file: ${error}`)
    },
    async openExternal(url) {
      const protocol = new URL(url).protocol
      if (protocol !== 'https:' && protocol !== 'http:') throw new Error(`refusing to open a ${protocol} link`)
      await shell.openExternal(url)
    }
  }
}

export interface Ports {
  safe: SafeStorageLike
  notifier: DesktopNotifier
  keepAwake: KeepAwake
  shell: ShellPort
}
