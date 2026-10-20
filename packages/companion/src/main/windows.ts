import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, dialog, ipcMain, session, WebContentsView, type IpcMainInvokeEvent } from 'electron'
import { CHANNELS, type FolderKind } from '../ui/api'
import { FolderKindSchema } from '../ui/ipc'
import { guardedHandler, isTrustedSender, secureWebPreferences, signinPort, vncPageCsp } from '../ui/security'
import type { PairingService, SettingsService } from '../ui/services'
import type { SigninClosable } from '../local/signin'
import { guardSession } from './guard'

type PageKind = 'pairing' | 'settings' | 'signin'
type SingletonKind = Exclude<PageKind, 'signin'>

/** The sign-in toolbar's height; the remote view fills the rest of the window. */
const TOOLBAR_HEIGHT = 56

export interface WindowsDeps {
  /** The build output folder (`dist`): `renderer/<page>.html` and `preload/<page>.cjs` live in it. */
  distDir: string
  pairing: PairingService
  settings: SettingsService
  /** Gets what a window cannot act on (a sign-in page that did not load). Default `console.error`. */
  onError?: (error: unknown) => void
}

/**
 * The app's windows: pairing, settings and the local sign-in view. Each is created on demand, once at a time, with
 * `secureWebPreferences`, loads a page shipped in the app (`file:`) and has a preload that exposes only that page's
 * named functions. Every IPC handler runs only for the top frame of the window's own page (`isTrustedSender`).
 */
export class Windows {
  /** Pairing and settings: one window each. */
  private readonly open = new Map<SingletonKind, BrowserWindow>()
  /** The sign-in windows, by the id of their toolbar page: one per identity being signed in. */
  private readonly signins = new Map<number, { win: BrowserWindow; done: () => void }>()
  private signinCount = 0
  private readonly report: (error: unknown) => void

  constructor(private readonly d: WindowsDeps) {
    this.report = d.onError ?? ((e) => console.error(e))
    const on = <A extends unknown[], R>(channel: string, kind: SingletonKind, fn: (...args: A) => R): void => {
      const run = guardedHandler<A, R>((frame) => {
        const win = this.open.get(kind)
        return win !== undefined && isTrustedSender(frame, this.pageUrl(kind), win.webContents.mainFrame)
      }, fn)
      ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => run(event, ...(args as A)))
    }
    on(CHANNELS.pairingDefaults, 'pairing', () => d.pairing.defaults())
    on(CHANNELS.pairingSubmit, 'pairing', (input: unknown) => d.pairing.submit(input))
    on(CHANNELS.settingsGet, 'settings', () => d.settings.get())
    on(CHANNELS.settingsSave, 'settings', (form: unknown) => d.settings.save(form))
    on(CHANNELS.settingsChooseFolder, 'settings', (kind: unknown) => this.chooseFolder(FolderKindSchema.parse(kind)))
    ipcMain.handle(CHANNELS.signinDone, (event: IpcMainInvokeEvent) => {
      const entry = this.signins.get(event.sender.id)
      if (
        entry === undefined ||
        !isTrustedSender(event.senderFrame, this.pageUrl('signin'), entry.win.webContents.mainFrame)
      )
        throw new Error('IPC refused: the sender is not a sign-in window page')
      entry.done()
    })
  }

  /** Stops answering the pages. For a clean shutdown and for tests. */
  dispose(): void {
    for (const channel of Object.values(CHANNELS)) ipcMain.removeHandler(channel)
    for (const win of this.open.values()) win.destroy()
    for (const { win } of this.signins.values()) win.destroy()
  }

  openPairing(): void {
    this.show('pairing', { width: 460, height: 380 })
  }

  openSettings(): void {
    this.show('settings', { width: 600, height: 560 })
  }

  /**
   * The local sign-in window (`SigninDeps.openWindow`). `url` is the loopback noVNC page with its password in the
   * fragment: it goes to the remote view only, never to a page script or a log. `onDone` runs once, on the Done button
   * or when the member closes the window; the returned handle closes it without running `onDone`.
   */
  openSignin(url: string, onDone: () => void): SigninClosable {
    const port = signinPort(url)
    const win = this.create('signin', 900, 700)
    let ended = false
    const end = (): void => {
      if (ended) return
      ended = true
      onDone()
    }
    const id = win.webContents.id
    this.signins.set(id, {
      win,
      done: () => {
        end()
        win.close()
      }
    })
    win.on('closed', () => {
      this.signins.delete(id)
      end()
    })

    // The remote desk lives in its own throw-away session: no cookies of the app, no permission, and a CSP that allows
    // only the loopback noVNC origin (the page's own headers say nothing of the kind).
    const remote = session.fromPartition(`tm-signin-${(this.signinCount += 1)}`)
    guardSession(remote)
    const csp = vncPageCsp(port)
    remote.webRequest.onHeadersReceived({ urls: [`http://127.0.0.1:${port}/*`] }, (details, callback) => {
      const headers = Object.fromEntries(
        Object.entries(details.responseHeaders ?? {}).filter(
          ([name]) => name.toLowerCase() !== 'content-security-policy'
        )
      )
      callback({ responseHeaders: { ...headers, 'Content-Security-Policy': [csp] } })
    })
    const view = new WebContentsView({ webPreferences: { ...secureWebPreferences(null), session: remote } })
    win.contentView.addChildView(view)
    const layout = (): void => {
      const { width, height } = win.getContentBounds()
      view.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) })
    }
    layout()
    win.on('resize', layout)
    win.on('closed', () => view.webContents.close())
    view.webContents.loadURL(url).catch((e: unknown) => this.report(e))
    return {
      close: () => {
        ended = true
        win.close()
      }
    }
  }

  private pageUrl(kind: PageKind): string {
    return pathToFileURL(join(this.d.distDir, 'renderer', `${kind}.html`)).href
  }

  private show(kind: SingletonKind, size: { width: number; height: number }): void {
    const existing = this.open.get(kind)
    if (existing !== undefined) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
      return
    }
    this.create(kind, size.width, size.height)
  }

  private create(kind: PageKind, width: number, height: number): BrowserWindow {
    const win = new BrowserWindow({
      width,
      height,
      show: false,
      autoHideMenuBar: true,
      webPreferences: secureWebPreferences(join(this.d.distDir, 'preload', `${kind}.cjs`))
    })
    win.removeMenu()
    if (kind !== 'signin') {
      this.open.set(kind, win)
      win.on('closed', () => this.open.delete(kind))
    }
    win.once('ready-to-show', () => win.show())
    win.loadURL(this.pageUrl(kind)).catch((e: unknown) => this.report(e))
    return win
  }

  private async chooseFolder(kind: FolderKind): Promise<string | null> {
    const win = this.open.get('settings')
    if (win === undefined) throw new Error('the settings window is not open')
    const current = this.d.settings.get()
    const result = await dialog.showOpenDialog(win, {
      title: kind === 'summaries' ? 'Choose the summaries folder' : 'Choose the whisper folder',
      defaultPath: (kind === 'summaries' ? current.summariesDir : current.whisperCwd) || undefined,
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  }
}
