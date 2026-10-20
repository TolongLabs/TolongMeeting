import { mkdir } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { app, Notification, powerSaveBlocker, safeStorage, session, shell } from 'electron'
import { APP_USER_MODEL_ID } from '../app-id'
import { KeepAwake } from '../keep-awake'
import { dockerCli } from '../local/docker'
import { sweepPlaintextAtStart } from '../local/ephemeral'
import { nodeSpawn } from '../jobs/whisper'
import { jobsDir, localRunPaths, resolvePaths, secretsFile, settingsFile, stateFile } from '../paths'
import { SecretStore } from '../secrets'
import { isValidSettingsFolder, loadSettings, saveSettings } from '../settings'
import { StateStore } from '../state'
import { PairingService, SettingsService } from '../ui/services'
import { installGuards } from './guard'
import { Loops } from './loops'
import { electronKeepAwake, electronNotifier, electronShell, secureSafeStorage, type Ports } from './ports'
import { AppTray } from './tray'
import type { TrayModel } from './tray-menu'
import { Windows } from './windows'

/** The default server address, injected at build time from `TM_PUBLIC_URL` (see `scripts/build.ts`). */
declare const TM_PUBLIC_URL: string
/** The repository whose worker images this PC may pull and run, injected at build time (`scripts/build.ts`). */
declare const TM_WORKER_IMAGE_PREFIX: string

// The app folder holds `package.json` (whose `main` is `dist/main/index.cjs`), `dist/` and `assets/`; in the installed app
// it is `app.asar`. It comes from Electron at run time: `__dirname` and `module.filename` are replaced by the build
// machine's source folder when Bun bundles.
const appDir = (): string => app.getAppPath()

let stopping = false

async function main(): Promise<void> {
  const paths = resolvePaths({
    platform: process.platform,
    // TM_APP_DATA_DIR moves the settings, secrets and single-instance lock to another folder; the Electron smoke test uses
    // it so a run never touches the member's real %APPDATA% (Electron reads that folder from Windows, not from the env).
    appData: process.env.TM_APP_DATA_DIR ?? app.getPath('appData'),
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

  // The app lives in the tray, so closing the last window must not quit it.
  app.on('window-all-closed', () => {})
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => app.quit())

  // A bug in one loop is reported, not allowed to take the whole app down without a word.
  process.on('unhandledRejection', (reason) => console.error('unhandled rejection:', reason))

  await app.whenReady()
  // No window may reach remote content, open another, be redirected or hold a permission (see `windows.ts`).
  installGuards(app, session.defaultSession)

  // A crash can leave key files, job files or audio behind: wipe them before anything can start, paired or not.
  const localPaths = localRunPaths(paths)
  await sweepPlaintextAtStart({ runs: localPaths.runs, jobs: jobsDir(paths) }, (message) => console.error(message))

  const settings = await loadSettings(settingsFile(paths), paths.documents, TM_PUBLIC_URL)
  const ports: Ports = {
    safe: secureSafeStorage(safeStorage, process.platform),
    notifier: electronNotifier(Notification),
    keepAwake: electronKeepAwake(powerSaveBlocker),
    // A click opens only a regular `.md` file inside the summaries folder, or the folder itself.
    shell: electronShell(shell, () => settings.summariesDir)
  }
  const state = new StateStore(stateFile(paths))
  const secrets = new SecretStore(secretsFile(paths), ports.safe)

  const saveServerUrl = async (url: string): Promise<void> => {
    const next = { ...settings, serverUrl: url }
    await saveSettings(settingsFile(paths), next)
    settings.serverUrl = next.serverUrl
  }
  const windows = new Windows({
    distDir: join(appDir(), 'dist'),
    pairing: new PairingService({
      settings,
      secrets,
      state,
      deviceName: () => hostname(),
      saveServerUrl,
      onPaired: async () => {
        if (!(await loops.start())) throw new Error('this PC is paired, but the loops did not start')
      },
      onError: (e) => console.error('pairing failed:', e)
    }),
    settings: new SettingsService({ settings, save: (next) => saveSettings(settingsFile(paths), next) })
  })

  let tray: AppTray | null = null
  const trayModel = (): TrayModel => ({ status: loops.status(), identities: loops.identities() })
  const loops = new Loops({
    settings,
    state,
    secrets,
    notifier: ports.notifier,
    keepAwake: new KeepAwake(powerSaveBlocker),
    shell: ports.shell,
    jobsDir: jobsDir(paths),
    // Local meetings (after pairing only, inside `loops.start`): the runner takes `local_run` jobs, and each start
    // finishes the meetings a restart cut off. The sign-in window opens on a tray click or an `open_signin` command.
    local: {
      docker: dockerCli(nodeSpawn, { imagePrefix: TM_WORKER_IMAGE_PREFIX, allowedRoots: [localPaths.root] }),
      dataDir: localPaths.data,
      paths: localPaths,
      imagePrefix: TM_WORKER_IMAGE_PREFIX,
      openSigninWindow: (url, onDone) => windows.openSignin(url, onDone)
    },
    openPairing: () => windows.openPairing(),
    openSettings: () => windows.openSettings(),
    onChange: () => tray?.update(trayModel())
  })

  tray = new AppTray(
    join(appDir(), 'assets'),
    {
      openSummaries: () => {
        if (!isValidSettingsFolder(settings.summariesDir)) {
          console.error('could not open the summaries folder: folder is not valid')
          return
        }
        // The folder may not exist before the first summary; the shell port opens it only when it does.
        mkdir(settings.summariesDir, { recursive: true })
          .then(() => ports.shell.openPath(settings.summariesDir))
          .catch((e: unknown) => console.error('could not open the summaries folder:', e))
      },
      openSettings: () => windows.openSettings(),
      openPairing: () => windows.openPairing(),
      signIn: (identityId) => void loops.signIn(identityId).catch((e: unknown) => console.error(e)),
      quit: () => app.quit()
    },
    trayModel()
  )

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
        // Open windows would keep the quit from finishing, so they go first.
        windows.dispose()
        tray?.destroy()
        app.quit()
      })
  })

  if (!(await loops.start())) {
    console.log('tm-companion: this PC is not paired; no loop started')
    // First run: ask for the pairing code, unless the login item started the app quietly (`--hidden`). The tray's
    // `Pair this PC` item opens the window later.
    if (!process.argv.includes('--hidden')) windows.openPairing()
  }
  console.log(`tm-companion ready: summaries in ${settings.summariesDir}`)
}

main().catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
