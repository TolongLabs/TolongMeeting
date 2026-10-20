import { EventEmitter } from 'node:events'
import { describe, expect, test } from 'bun:test'
import type { App, Session, WebContents } from 'electron'
import { vncUrl } from '../src/local/signin'
import { guardContents, guardSession, installGuards } from '../src/main/guard'
import {
  guardedHandler,
  isTrustedSender,
  LOCAL_PAGE_CSP,
  secureWebPreferences,
  signinPort,
  vncPageCsp
} from '../src/ui/security'

describe('window web preferences', () => {
  test('every window is isolated, sandboxed and without Node, with web security on', () => {
    for (const preload of ['/app/dist/preload/pairing.cjs', null]) {
      expect(secureWebPreferences(preload)).toMatchObject({
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        devTools: false
      })
    }
  })

  test('the preload is set only when there is one', () => {
    expect(secureWebPreferences('/p.cjs').preload).toBe('/p.cjs')
    expect('preload' in secureWebPreferences(null)).toBe(false)
  })
})

describe('content security policy', () => {
  test('the app pages allow only their own files, no inline code and no form posts', () => {
    expect(LOCAL_PAGE_CSP.startsWith("default-src 'self';")).toBe(true)
    expect(LOCAL_PAGE_CSP).not.toMatch(/unsafe|\*|https?:|data:/)
    expect(LOCAL_PAGE_CSP).toContain("form-action 'none'")
    expect(LOCAL_PAGE_CSP).toContain("object-src 'none'")
  })

  test('the noVNC page may reach only its own loopback origin', () => {
    const csp = vncPageCsp(49152)
    const hosts = csp.match(/(?:https?|wss?):\/\/[^\s;]+/g) ?? []
    expect(new Set(hosts)).toEqual(new Set(['http://127.0.0.1:49152', 'ws://127.0.0.1:49152']))
    expect(csp).toContain("default-src 'self' http://127.0.0.1:49152")
    expect(csp).not.toContain('*')
    expect(csp).not.toContain("script-src 'unsafe")
  })

  test('a port that is not a port is refused', () => {
    for (const port of [0, 65536, 1.5, Number.NaN]) expect(() => vncPageCsp(port)).toThrow()
  })
})

describe('the sign-in address', () => {
  test('the port comes from a loopback noVNC address', () => {
    expect(signinPort(vncUrl(49152, 'pw_1'))).toBe(49152)
  })

  test('anything else is refused', () => {
    for (const url of [
      'http://127.0.0.1:0/vnc.html',
      'http://localhost:49152/vnc.html',
      'https://127.0.0.1:49152/vnc.html',
      'http://127.0.0.1:49152@evil.example/vnc.html',
      'https://login.microsoftonline.com/',
      'file:///etc/passwd',
      'http://127.0.0.1:99999/vnc.html'
    ]) {
      expect(() => signinPort(url)).toThrow()
    }
  })
})

describe('IPC sender check', () => {
  const page = 'file:///app/dist/renderer/settings.html'
  const top = { url: page, parent: null }

  test('only the top frame of the window page passes', () => {
    expect(isTrustedSender(top, page, top)).toBe(true)
    expect(isTrustedSender(null, page, top)).toBe(false)
    expect(isTrustedSender({ url: page, parent: null }, page, top)).toBe(false) // another frame object
    expect(isTrustedSender({ ...top, url: 'https://evil.example/' }, page, top)).toBe(false)
    const child = { url: page, parent: top }
    expect(isTrustedSender(child, page, child)).toBe(false)
  })

  test('a handler runs only for a trusted sender, and an untrusted one learns nothing', () => {
    let ran = 0
    const handler = guardedHandler(
      (frame) => frame !== null && isTrustedSender(frame, page, top),
      (n: number) => {
        ran += n
        return 'secret'
      }
    )
    expect(handler({ senderFrame: top }, 2)).toBe('secret')
    expect(() => handler({ senderFrame: { url: 'https://evil.example/', parent: null } }, 3)).toThrow('IPC refused')
    expect(() => handler({ senderFrame: null }, 3)).toThrow('IPC refused')
    expect(ran).toBe(2)
  })
})

describe('web contents and session guards', () => {
  function fakeContents() {
    const emitter = new EventEmitter()
    let openHandler: (() => { action: string }) | null = null
    const contents = Object.assign(emitter, {
      setWindowOpenHandler: (h: () => { action: string }) => void (openHandler = h)
    })
    return { contents: contents as unknown as WebContents, emitter, open: () => openHandler?.() }
  }

  test('navigation, frame navigation, redirects and webviews are cancelled, and new windows are denied', () => {
    const { contents, emitter, open } = fakeContents()
    guardContents(contents)
    for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) {
      let prevented = false
      emitter.emit(event, { preventDefault: () => (prevented = true) })
      expect(prevented).toBe(true)
    }
    expect(open()).toEqual({ action: 'deny' })
  })

  test('a session denies every permission request and check', () => {
    let request: ((c: unknown, p: string, cb: (allow: boolean) => void) => void) | null = null
    let check: (() => boolean) | null = null
    guardSession({
      setPermissionRequestHandler: (h: typeof request) => void (request = h),
      setPermissionCheckHandler: (h: typeof check) => void (check = h)
    } as unknown as Session)
    const answers: boolean[] = []
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read']) {
      request!(null, permission, (allow) => answers.push(allow))
    }
    expect(answers).toEqual([false, false, false, false])
    expect(check!()).toBe(false)
  })

  test('installGuards covers contexts and sessions created later, and the default session now', () => {
    const app = new EventEmitter()
    const handlers: string[] = []
    const session = {
      setPermissionRequestHandler: () => void handlers.push('request'),
      setPermissionCheckHandler: () => void handlers.push('check')
    } as unknown as Session
    installGuards(app as unknown as App, session)
    expect(handlers).toEqual(['request', 'check'])
    const { contents, emitter } = fakeContents()
    app.emit('web-contents-created', {}, contents)
    let prevented = false
    emitter.emit('will-navigate', { preventDefault: () => (prevented = true) })
    expect(prevented).toBe(true)
    app.emit('session-created', session)
    expect(handlers).toEqual(['request', 'check', 'request', 'check'])
  })
})
