import { app, Notification, powerSaveBlocker, safeStorage, session, shell } from 'electron'
import { APP_USER_MODEL_ID } from '../app-id'
import { resolvePaths, secretsFile, settingsFile, stateFile } from '../paths'
import { SecretStore } from '../secrets'
import { loadSettings } from '../settings'
import { StateStore } from '../state'
import { electronKeepAwake, electronNotifier, electronShell, secureSafeStorage, type Ports } from './ports'

/** The default server address, injected at build time from `TM_PUBLIC_URL` (see `scripts/build.ts`). */
declare const TM_PUBLIC_URL: string

// TODO(figma-gate): the tray icon and menu (`main/tray.ts`), the preload script, the settings window
// (`renderer/settings.html`) and `assets/` wait for the Figma design approval (docs/DESIGN.md). Until then the app
// is headless: no window of any kind exists, and there is no IPC.

function guardWebContents(): void {
  // No window may reach remote content or open another. Windows added later keep `nodeIntegration: false`,
  // `contextIsolation: true` and `sandbox: true`, and load only files shipped in the app.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  })
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, allow) => allow(false))
}

async function main(): Promise<void> {
  const paths = resolvePaths({
    platform: process.platform,
    appData: app.getPath('appData'),
    localAppData: process.env.LOCALAPPDATA,
    documents: app.getPath('documents')
  })
  // Before the single-instance lock, which lives in the user data folder.
  app.setPath('userData', paths.userData)

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.setAppUserModelId(APP_USER_MODEL_ID)
  // Windows only, and only for the installed app: a development run must not register `electron.exe`.
  if (process.platform === 'win32' && app.isPackaged)
    app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] })

  // The app lives in the tray, so closing the last window must not quit it. (No window exists yet.)
  app.on('window-all-closed', () => {})
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => app.quit())

  await app.whenReady()
  guardWebContents()

  const ports: Ports = {
    safe: secureSafeStorage(safeStorage, process.platform),
    notifier: electronNotifier(Notification),
    keepAwake: electronKeepAwake(powerSaveBlocker),
    shell: electronShell(shell)
  }
  const settings = await loadSettings(settingsFile(paths), paths.documents, TM_PUBLIC_URL)
  const state = new StateStore(stateFile(paths))
  const secrets = new SecretStore(secretsFile(paths), ports.safe)

  // Later tasks start their loops here with `ports`, `state` and `secrets`: pairing, ntfy, summaries, commands and
  // the native job runner.
  console.log(`tm-companion ready: summaries in ${settings.summariesDir}`)
}

main().catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
