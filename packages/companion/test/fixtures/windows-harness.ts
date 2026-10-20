import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, session, webContents, type WebContents } from 'electron'
import { vncUrl } from '../../src/local/signin'
import { installGuards } from '../../src/main/guard'
import { Windows } from '../../src/main/windows'
import { SecretStore } from '../../src/secrets'
import { defaultSettings, saveSettings } from '../../src/settings'
import { StateStore } from '../../src/state'
import { secureWebPreferences } from '../../src/ui/security'
import { PairingService, SettingsService } from '../../src/ui/services'

// The Electron smoke test's window harness (`smoke.test.ts` builds and runs it). It opens each real window once with
// fake services, probes the pages from inside, and prints one `HARNESS-RESULT <json>` line. Nothing here ships.

const dir = process.env.HARNESS_DIR
if (!dir) throw new Error('HARNESS_DIR is not set')

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}
const run = <T>(wc: WebContents, code: string): Promise<T> => wc.executeJavaScript(code) as Promise<T>

/**
 * What the renderer process says about itself. An extra preload (below) runs in every window of every session and
 * exposes `process.sandboxed` and `process.contextIsolated` as the process sees them, so the check reads Electron's
 * effective result and not the options the app passed.
 */
const PROBE_PRELOAD = `
const { contextBridge } = require('electron')
contextBridge.exposeInMainWorld('__probe', { sandboxed: process.sandboxed, contextIsolated: process.contextIsolated })
`
const processFacts = (wc: WebContents): Promise<string> =>
  run(
    wc,
    `JSON.stringify({ ...window.__probe, globals: [typeof require, typeof process, typeof Buffer, typeof module, typeof ipcRenderer, typeof electron].join() })`
  )

/** What a page can reach, and what it cannot do. Each probe runs inside the page. */
async function probe(wc: WebContents, windowsBefore: number): Promise<Record<string, unknown>> {
  const url = wc.getURL()
  const out: Record<string, unknown> = {
    url,
    process: await processFacts(wc),
    csp: await run(wc, `document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null`),
    tm: await run(
      wc,
      `JSON.stringify(Object.fromEntries(Object.entries(window.tm ?? {}).map(([k, v]) => [k, Object.keys(v)])))`
    ),
    remoteFetch: await run(wc, `fetch('https://example.com/').then(() => 'reached', () => 'blocked')`),
    inlineScript: await run(
      wc,
      `(() => { const s = document.createElement('script'); s.textContent = 'window.__ran = 1'; document.head.append(s); return window.__ran === 1 ? 'ran' : 'blocked' })()`
    ),
    geolocation: await run(wc, `navigator.permissions.query({ name: 'geolocation' }).then((s) => s.state)`)
  }
  // A page that tries to leave, or to open a window, stays where it is.
  await run(wc, `location.href = 'https://example.com/'`)
  await sleep(500)
  out.afterNavigate = wc.getURL()
  out.windowOpen = await run(wc, `window.open('https://example.com/') === null ? 'null' : 'opened'`)
  await sleep(300)
  out.windowsOpened = BrowserWindow.getAllWindows().length - windowsBefore
  return out
}

function wcByUrl(prefix: string): WebContents | undefined {
  return webContents.getAllWebContents().find((c) => c.getURL().startsWith(prefix))
}

async function main(): Promise<void> {
  await mkdir(dir!, { recursive: true })
  await app.whenReady()
  const probePreload = join(dir!, 'probe-preload.cjs')
  await writeFile(probePreload, PROBE_PRELOAD)
  session.defaultSession.registerPreloadScript({ type: 'frame', filePath: probePreload })
  app.on('session-created', (created) => created.registerPreloadScript({ type: 'frame', filePath: probePreload }))
  installGuards(app, session.defaultSession)
  const dist = process.env.HARNESS_DIST
  if (!dist) throw new Error('HARNESS_DIST is not set')
  const pageUrl = (name: string): string => pathToFileURL(join(dist, 'renderer', `${name}.html`)).href

  const settings = defaultSettings(join(dir!, 'docs'), 'https://tm.example')
  const settingsFile = join(dir!, 'settings.json')
  const secrets = new SecretStore(join(dir!, 'secrets.json'), {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s).reverse(),
    decryptString: (b) => Buffer.from(b).reverse().toString()
  })
  const state = new StateStore(join(dir!, 'state.json'))
  const pairRequests: unknown[] = []
  const fakeFetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const body = (await request.json()) as { code: string }
      pairRequests.push(body)
      if (body.code !== 'ABCD-1234') return Response.json({ error: 'invalid_code' }, { status: 400 })
      return Response.json({
        deviceId: 'dev_1',
        token: 'tmd_secret_device_token',
        ntfy: { url: 'https://ntfy.example', topic: 'tm-abc', token: 'tk_ntfy_secret' },
        pairedAt: '2026-10-21T08:00:00.000Z'
      })
    },
    { preconnect: () => {} }
  )
  let paired = 0
  const windows = new Windows({
    distDir: dist,
    pairing: new PairingService({
      settings,
      secrets,
      state,
      deviceName: () => 'HARNESS-PC',
      saveServerUrl: async (url) => {
        settings.serverUrl = url
        await saveSettings(settingsFile, settings)
      },
      onPaired: async () => void paired++,
      onError: (e) => console.error('harness pairing error:', e),
      fetch: fakeFetch
    }),
    settings: new SettingsService({ settings, save: (next) => saveSettings(settingsFile, next) })
  })
  const result: Record<string, unknown> = {}
  const formText = (wc: WebContents): Promise<string> => run(wc, `document.getElementById('message').textContent`)

  // --- Pairing ---
  windows.openPairing()
  await until('the pairing page', () => wcByUrl(pageUrl('pairing')) !== undefined)
  const pairingWc = wcByUrl(pageUrl('pairing'))!
  await until('the pairing page to load', () => !pairingWc.isLoading())
  await until(
    'the website address to be prefilled',
    async () => (await run<string>(pairingWc, `document.getElementById('server-url').value`)) !== ''
  )
  const submit = (code: string): Promise<string> =>
    run(
      pairingWc,
      `(async () => {
        const code = document.getElementById('code'); code.value = ${JSON.stringify(code)}
        document.getElementById('pairing-form').requestSubmit()
        await new Promise((r) => setTimeout(r, 700))
        return document.getElementById('message').textContent
      })()`
    )
  const pairing = await probe(pairingWc, BrowserWindow.getAllWindows().length)
  pairing.prefilled = await run(pairingWc, `document.getElementById('server-url').value`)
  pairing.wrongCode = await submit('WRONG-CODE')
  pairing.rightCode = await submit('ABCD-1234')
  pairing.secretInPage = (
    await run<string>(pairingWc, `document.documentElement.outerHTML + document.body.innerText`)
  ).includes('tmd_')
  pairing.paired = paired
  pairing.requests = pairRequests
  pairing.deviceToken = await secrets.get('deviceToken')
  result.pairing = pairing

  // --- Settings ---
  windows.openSettings()
  await until('the settings page', () => wcByUrl(pageUrl('settings')) !== undefined)
  const settingsWc = wcByUrl(pageUrl('settings'))!
  await until(
    'the settings form to fill',
    async () => (await run<string>(settingsWc, `document.getElementById('summaries-dir').value`)) !== ''
  )
  const settingsProbe = await probe(settingsWc, BrowserWindow.getAllWindows().length)
  const saveWith = (model: string): Promise<string> =>
    run(
      settingsWc,
      `(async () => {
        document.getElementById('whisper-model').value = ${JSON.stringify(model)}
        document.getElementById('settings-form').requestSubmit()
        await new Promise((r) => setTimeout(r, 500))
        return document.getElementById('message').textContent
      })()`
    )
  settingsProbe.emptyModel = await saveWith('')
  settingsProbe.saved = await saveWith('small')
  settingsProbe.liveModel = settings.whisper.model
  result.settings = settingsProbe

  // --- A page that is not ours cannot use the handlers ---
  const raw = join(dir!, 'raw-preload.cjs')
  await writeFile(
    raw,
    `const { contextBridge, ipcRenderer } = require('electron'); contextBridge.exposeInMainWorld('raw', { invoke: (c, ...a) => ipcRenderer.invoke(c, ...a).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: String(e) })) })`
  )
  await writeFile(join(dir!, 'other.html'), '<!doctype html><title>other</title>')
  const other = new BrowserWindow({ show: false, webPreferences: secureWebPreferences(raw) })
  await other.loadURL(pathToFileURL(join(dir!, 'other.html')).href)
  const asOther = (channel: string, ...args: unknown[]): Promise<{ ok: boolean; e?: string }> =>
    run(other.webContents, `window.raw.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`)
  result.untrusted = {
    settingsGet: await asOther('tm:settings:get'),
    settingsSave: await asOther('tm:settings:save', {
      summariesDir: '/evil',
      whisperCommand: 'x',
      whisperCwd: '',
      whisperModel: 'x'
    }),
    pairingSubmit: await asOther('tm:pairing:submit', { serverUrl: 'https://tm.example', code: 'ABCD-1234' }),
    signinDone: await asOther('tm:signin:done'),
    summariesDirAfter: settings.summariesDir
  }
  other.destroy()

  // --- Sign-in ---
  const hits: string[] = []
  const server = createServer((req, res) => {
    hits.push(req.url ?? '')
    const port = (server.address() as { port: number }).port
    if (req.url?.startsWith('/vnc.html')) {
      // The page asks for everything; the app's CSP, set on this response, must win.
      res.setHeader('Content-Type', 'text/html')
      res.setHeader('Content-Security-Policy', "default-src * 'unsafe-inline' 'unsafe-eval'")
      res.end(
        `<!doctype html><title>noVNC</title><script src="/app.js"></script><script>window.__inline = true</script>`
      )
    } else if (req.url === '/app.js') {
      res.setHeader('Content-Type', 'text/javascript')
      res.end(
        `window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
         window.__external = true;
         window.__results = Promise.all([
           fetch('/ok').then((r) => r.status, () => 'blocked'),
           fetch('http://127.0.0.1:${port + 1}/other').then(() => 'reached', () => 'blocked'),
           fetch('http://localhost:${port}/name').then(() => 'reached', () => 'blocked')
         ]);`
      )
    } else res.end('ok')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  let done = 0
  const before = BrowserWindow.getAllWindows().length
  windows.openSignin(vncUrl(port, 'pw_1'), () => void done++)
  await until('the sign-in toolbar', () => wcByUrl(pageUrl('signin')) !== undefined)
  await until('the remote page', () => wcByUrl(`http://127.0.0.1:${port}/`) !== undefined)
  const remote = wcByUrl(`http://127.0.0.1:${port}/`)!
  await until('the remote page to load', () => !remote.isLoading())
  const toolbar = wcByUrl(pageUrl('signin'))!
  await until('the toolbar to load', () => !toolbar.isLoading())
  const signin: Record<string, unknown> = {
    toolbar: await probe(toolbar, before),
    toolbarText: await run(toolbar, `document.body.innerText`),
    toolbarHasPassword: (await run<string>(toolbar, `document.documentElement.outerHTML`)).includes('pw_1')
  }
  await sleep(300)
  signin.remote = {
    url: remote.getURL(),
    process: await processFacts(remote),
    tm: await run(remote, `typeof window.tm`),
    external: await run(remote, `window.__external === true`),
    inline: await run(remote, `window.__inline === true`),
    results: await run(remote, `window.__results`),
    violations: await run(remote, `window.__csp`),
    geolocation: await run(remote, `navigator.permissions.query({ name: 'geolocation' }).then((s) => s.state)`)
  }
  await run(remote, `location.href = 'https://example.com/'`)
  await sleep(500)
  signin.remoteAfterNavigate = remote.getURL()
  signin.remoteWindowOpen = await run(remote, `window.open('https://example.com/') === null ? 'null' : 'opened'`)
  await sleep(300)
  signin.windowsOpened = BrowserWindow.getAllWindows().length - before
  signin.hitsWithFragment = hits.filter((h) => h.includes('pw_1') || h.includes('password'))
  void run(toolbar, `document.getElementById('done').click()`).catch(() => {})
  await until('the window to close', () => BrowserWindow.getAllWindows().length === before)
  await sleep(200)
  signin.done = done
  result.signin = signin
  server.close()

  console.log(`HARNESS-RESULT ${JSON.stringify(result)}`)
  windows.dispose()
  app.exit(0)
}

main().catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
