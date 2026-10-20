import { app, Notification, powerSaveBlocker, safeStorage, session, shell } from 'electron'
import { APP_USER_MODEL_ID } from '../app-id'
import { KeepAwake } from '../keep-awake'
import { dockerCli } from '../local/docker'
import { sweepPlaintext } from '../local/ephemeral'
import { nodeSpawn } from '../jobs/whisper'
import { jobsDir, localRunPaths, resolvePaths, secretsFile, settingsFile, stateFile } from '../paths'
import { SecretStore } from '../secrets'
import { loadSettings } from '../settings'
import { StateStore } from '../state'
import { Loops } from './loops'
import { electronKeepAwake, electronNotifier, electronShell, secureSafeStorage, type Ports } from './ports'

/** The default server address, injected at build time from `TM_PUBLIC_URL` (see `scripts/build.ts`). */
declare const TM_PUBLIC_URL: string
/** The repository whose worker images this PC may pull and run, injected at build time (`scripts/build.ts`). */
declare const TM_WORKER_IMAGE_PREFIX: string

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

let stopping = false

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

  // A bug in one loop is reported, not allowed to take the whole app down without a word.
  process.on('unhandledRejection', (reason) => console.error('unhandled rejection:', reason))

  await app.whenReady()
  guardWebContents()

  // A crash can leave key files, job files or audio behind: wipe them before anything can start, paired or not.
  const localPaths = localRunPaths(paths)
  await sweepPlaintext({ runs: localPaths.runs, jobs: jobsDir(paths) })

  const ports: Ports = {
    safe: secureSafeStorage(safeStorage, process.platform),
    notifier: electronNotifier(Notification),
    keepAwake: electronKeepAwake(powerSaveBlocker),
    shell: electronShell(shell)
  }
  const settings = await loadSettings(settingsFile(paths), paths.documents, TM_PUBLIC_URL)
  const state = new StateStore(stateFile(paths))
  const secrets = new SecretStore(secretsFile(paths), ports.safe)

  // TODO(figma-gate): `openPairing` and `openSettings` open the pairing and settings windows once they exist.
  const loops = new Loops({
    settings,
    state,
    secrets,
    notifier: ports.notifier,
    keepAwake: new KeepAwake(powerSaveBlocker),
    shell: ports.shell,
    jobsDir: jobsDir(paths),
    // Local meetings (after pairing only, inside `loops.start`): the runner takes `local_run` jobs, and each start
    // finishes the meetings a restart cut off. TODO(figma-gate): `openSigninWindow` comes with the sign-in window; until
    // then `open_signin` commands are ignored.
    local: {
      docker: dockerCli(nodeSpawn, { imagePrefix: TM_WORKER_IMAGE_PREFIX, allowedRoots: [localPaths.root] }),
      dataDir: localPaths.data,
      paths: localPaths,
      imagePrefix: TM_WORKER_IMAGE_PREFIX
    },
    openPairing: () => console.error('This PC was unpaired. Pair it again (the pairing window is not built yet).'),
    openSettings: () => console.error('Set the whisper folder in settings (the settings window is not built yet).')
  })

  // Quit (including SIGTERM) first stops the loops in reverse order and waits for the runner to let go.
  let quitReady = false
  app.on('before-quit', (event) => {
    if (quitReady) return
    event.preventDefault()
    if (stopping) return
    stopping = true
    void loops
      .stop()
      .catch((e: unknown) => console.error(e))
      .finally(() => {
        quitReady = true
        app.quit()
      })
  })

  if (!(await loops.start())) console.log('tm-companion: this PC is not paired; no loop started')
  console.log(`tm-companion ready: summaries in ${settings.summariesDir}`)
}

main().catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
