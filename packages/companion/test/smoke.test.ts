import { type ChildProcess, spawn } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LOCAL_PAGE_CSP, vncPageCsp } from '../src/ui/security'

// Starts the real Electron binary and checks that the app boots with its tray and pairing window, loads its settings and
// quits cleanly, and that each window (pairing, settings, local sign-in) is locked down: it opens each once with fake
// services (`fixtures/windows-harness.ts`) and probes it from inside.
// It needs the binary (`bun run electron:install`) and a display, so it runs only when asked:
//   TM_ELECTRON_SMOKE=1 xvfb-run -a bun test packages/companion/test/smoke.test.ts
// `--no-sandbox` is for this test only (the dev container has no setuid sandbox); the app never sets it.
const enabled = process.env.TM_ELECTRON_SMOKE === '1'

const READY = 'tm-companion ready'
let work = ''
/** The app folder, laid out as the installed app is: `package.json`, `dist/` and `assets/`. */
let app = ''
let electron = ''
const children: ChildProcess[] = []

function launch(
  args: string[] = [],
  env: Record<string, string> = {},
  entry = app
): { child: ChildProcess; lines: string[]; exited: Promise<number | null> } {
  const child = spawn(electron, ['--no-sandbox', entry, ...args], {
    env: { ...process.env, XDG_CONFIG_HOME: join(work, 'config'), ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(child)
  const lines: string[] = []
  for (const stream of [child.stdout, child.stderr]) {
    let pending = ''
    stream.on('data', (chunk: Buffer) => {
      const parts = (pending + chunk.toString()).split('\n')
      pending = parts.pop() ?? ''
      lines.push(...parts)
    })
  }
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  return { child, lines, exited }
}

async function until(what: string, ok: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(100)
  }
}

const LOAD_FAILURES =
  /Failed to load URL|ERR_FILE_NOT_FOUND|Script failed to execute|Unable to load preload|the tray icon is missing/

describe.skipIf(!enabled)('Electron smoke test', () => {
  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'tm-companion-smoke-'))
    // In a subprocess: `Bun.build` fails to resolve the imports when it is called from inside `bun test`.
    app = join(work, 'app')
    const built = Bun.spawnSync(
      [
        'bun',
        join(import.meta.dir, '../scripts/build.ts'),
        join(app, 'dist'),
        join(import.meta.dir, 'fixtures/windows-harness.ts')
      ],
      { env: { ...process.env, TM_PUBLIC_URL: 'https://tm.example' } }
    )
    if (built.exitCode !== 0) throw new Error(`the build failed: ${built.stderr.toString()}`)
    await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'tm-smoke', main: 'dist/main/index.cjs' }))
    await cp(join(import.meta.dir, '../assets'), join(app, 'assets'), { recursive: true })
    const electronDir = dirname(Bun.resolveSync('electron/package.json', join(import.meta.dir, '..')))
    electron = join(electronDir, 'dist', (await readFile(join(electronDir, 'path.txt'), 'utf8')).trim())
    const userData = join(work, 'config', 'TolongMeeting')
    await mkdir(userData, { recursive: true })
    await writeFile(join(userData, 'settings.json'), JSON.stringify({ summariesDir: join(work, 'notes') }))
  })

  afterAll(async () => {
    for (const c of children) if (c.exitCode === null) c.kill('SIGKILL')
    await rm(work, { recursive: true, force: true })
  })

  test('starts, loads settings, refuses a second copy and quits on SIGTERM', async () => {
    const first = launch()
    await until('the ready line', () => first.lines.some((l) => l.startsWith(READY)))
    expect(first.lines.find((l) => l.startsWith(READY))).toBe(`${READY}: summaries in ${join(work, 'notes')}`)

    const second = launch()
    expect(await second.exited).toBe(0)
    expect(second.lines.some((l) => l.startsWith(READY))).toBe(false)

    first.child.kill('SIGTERM')
    expect(await first.exited).toBe(0)
    // The first run (not paired, not `--hidden`) opened the pairing window and the tray: every file they need loaded.
    expect(first.lines.filter((l) => LOAD_FAILURES.test(l))).toEqual([])
  }, 90_000)

  test('started with --hidden an unpaired app also boots and quits', async () => {
    const hidden = launch(['--hidden'])
    await until('the ready line', () => hidden.lines.some((l) => l.startsWith(READY)))
    hidden.child.kill('SIGTERM')
    expect(await hidden.exited).toBe(0)
    expect(hidden.lines.filter((l) => LOAD_FAILURES.test(l))).toEqual([])
  }, 90_000)

  test('each window is locked down: preferences, CSP, no Node, no remote content, no navigation, IPC only from its page', async () => {
    const run = launch(
      [],
      { HARNESS_DIR: join(work, 'harness'), HARNESS_DIST: join(app, 'dist') },
      join(app, 'dist/main/windows-harness.cjs')
    )
    expect(await run.exited).toBe(0)
    const line = run.lines.find((l) => l.startsWith('HARNESS-RESULT '))
    if (line === undefined) throw new Error(`the harness printed no result:\n${run.lines.slice(-20).join('\n')}`)
    const r = JSON.parse(line.slice('HARNESS-RESULT '.length))
    const page = (name: string) => pathToFileURL(join(app, 'dist/renderer', `${name}.html`)).href
    // What Electron says of the renderer process, not what the app asked for.
    const locked = { sandboxed: true, contextIsolated: true, globals: Array(6).fill('undefined').join() }

    for (const [name, window, tm] of [
      ['pairing', r.pairing, { pairing: ['defaults', 'submit'] }],
      ['settings', r.settings, { settings: ['get', 'save', 'chooseFolder'] }],
      ['signin', r.signin.toolbar, { signin: ['done'] }]
    ] as const) {
      expect(window.url).toBe(page(name))
      expect(JSON.parse(window.process)).toEqual(locked)
      expect(window.csp).toBe(LOCAL_PAGE_CSP)
      expect(JSON.parse(window.tm)).toEqual(tm)
      expect(window.remoteFetch).toBe('blocked')
      expect(window.inlineScript).toBe('blocked')
      expect(window.geolocation).toBe('denied')
      expect(window.afterNavigate).toBe(page(name))
      expect(window.afterAboutBlank).toBe(page(name))
      expect(window.windowOpen).toBe('null')
    }
    // Pairing and settings opened no second window. The sign-in toolbar is the one window it opened.
    expect([r.pairing.windowsOpened, r.settings.windowsOpened, r.signin.toolbar.windowsOpened]).toEqual([0, 0, 1])

    // The forms work end to end through the real preload and handlers.
    expect(r.pairing.prefilled).toBe('https://tm.example')
    expect(r.pairing.wrongCode).toBe(
      'The pairing code was not accepted. Make a new code on the Devices page and try again.'
    )
    expect(r.pairing.rightCode).toBe('This PC is paired. You can close this window.')
    expect(r.pairing.requests).toEqual([
      { code: 'WRONG-CODE', deviceName: 'HARNESS-PC' },
      { code: 'ABCD-1234', deviceName: 'HARNESS-PC' }
    ])
    expect(r.pairing.paired).toBe(1)
    expect(r.pairing.secretInPage).toBe(false)
    expect(r.settings.emptyModel).toBe('Whisper model: enter a value')
    expect(r.settings.saved).toBe('Saved.')
    expect(r.settings.liveModel).toBe('small')

    // A page that is not one of ours cannot call any handler, even with raw `ipcRenderer`.
    for (const answer of [
      r.untrusted.settingsGet,
      r.untrusted.settingsSave,
      r.untrusted.pairingSubmit,
      r.untrusted.signinDone
    ]) {
      expect(answer.ok).toBe(false)
      expect(answer.e).toContain('IPC refused')
    }
    expect(r.untrusted.summariesDirAfter).toBe(join(work, 'harness', 'docs', 'Meeting summaries'))

    // The sign-in toolbar never sees the address or the password; the remote view has no bridge and no Node.
    expect(r.signin.toolbarHasPassword).toBe(false)
    const remote = r.signin.remote
    expect(remote.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/vnc\.html#autoconnect=1&resize=scale&password=pw_1$/)
    expect(JSON.parse(remote.process)).toEqual(locked)
    expect(remote.tm).toBe('undefined')
    expect(remote.geolocation).toBe('denied')
    // The page's own permissive CSP was replaced by ours: its inline script did not run, its own file did, and it
    // could fetch from its own origin but from no other host or port.
    expect(remote.external).toBe(true)
    expect(remote.inline).toBe(false)
    expect(remote.results).toEqual([200, 'blocked', 'blocked'])
    expect(remote.violations.map((v: string) => v.split(' ')[0]).sort()).toEqual([
      'connect-src',
      'connect-src',
      'script-src-elem'
    ])
    expect(vncPageCsp(Number(new URL(remote.url).port))).toContain(`ws://127.0.0.1:${new URL(remote.url).port}`)
    expect(r.signin.remoteAfterNavigate).toBe(remote.url)
    expect(r.signin.remoteWindowOpen).toBe('null')
    expect(r.signin.windowsOpened).toBe(1)
    expect(r.signin.hitsWithFragment).toEqual([])
    // Done ran the controller's callback once and closed the window.
    expect(r.signin.done).toBe(1)

    // Sign-in load failure never leaks the password fragment into errors or logs.
    expect(r.signinErrorCheck.hasPassword).toBe(false)
    expect(r.signinErrorCheck.errors[0]).toMatch(/^Failed to load sign-in page: /)
    expect(run.lines.some((l) => l.includes('PW_SECRET_CHECK'))).toBe(false)
  }, 120_000)

  test('a malformed settings file stops the app with an error', async () => {
    await writeFile(join(work, 'config', 'TolongMeeting', 'settings.json'), '{"whisper":{"model":5}}')
    const run = launch()
    expect(await run.exited).toBe(1)
    expect(run.lines.some((l) => l.startsWith(READY))).toBe(false)
  }, 60_000)
})
