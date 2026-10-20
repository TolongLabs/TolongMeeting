import type { WebPreferences } from 'electron'
import { isAllowedSigninUrl } from '../local/signin'

// The rules every companion window follows (Electron's security checklist). The functions here are pure, so tests read
// them directly; `main/windows.ts` applies them to real windows and `main/guard.ts` to every web contents.

/**
 * The web preferences of every window. Nothing is switched on beyond the defaults a locked-down page needs: no Node in
 * pages, workers or frames, isolated and sandboxed, web security on, no developer tools, no `<webview>`.
 */
export function secureWebPreferences(preload: string | null): WebPreferences {
  return {
    ...(preload === null ? {} : { preload }),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    devTools: false,
    spellcheck: false
  }
}

/** The CSP of the app's own pages (a `<meta>` tag, because they load from `file:`). Scripts and styles are files. */
export const LOCAL_PAGE_CSP = "default-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'"

/**
 * The CSP set on the response of the loopback noVNC page, and nothing else: its own files, its WebSocket back to the
 * same loopback port, and the images and cursors noVNC draws itself. No other host.
 */
export function vncPageCsp(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('not a port')
  const origin = `127.0.0.1:${port}`
  return [
    `default-src 'self' http://${origin}`,
    `connect-src http://${origin} ws://${origin}`,
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'"
  ].join('; ')
}

/** The loopback port of a sign-in URL that `isAllowedSigninUrl` accepts. Throws for anything else. */
export function signinPort(url: string): number {
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})\//.exec(url)
  const port = match === null ? 0 : Number(match[1])
  if (port < 1 || port > 65535 || !isAllowedSigninUrl(url, port))
    throw new Error('refusing a sign-in address that is not the loopback noVNC page')
  return port
}

/** The part of Electron's `WebFrameMain` a sender check reads. */
export interface SenderFrame {
  url: string
  parent: unknown
}

/**
 * True when an IPC message came from the top frame of the window's own page. `page` is the exact `file:` URL the window
 * loaded; `top` is that window's main frame. A subframe, another window or a page that navigated away fails.
 */
export function isTrustedSender(frame: SenderFrame | null, page: string, top: unknown): boolean {
  return frame !== null && frame === top && frame.parent === null && frame.url === page
}

/** Wraps an IPC handler so that it runs only for a trusted sender. A failed check throws; the caller never sees data. */
export function guardedHandler<A extends unknown[], R>(
  trusted: (frame: SenderFrame | null) => boolean,
  fn: (...args: A) => R
): (event: { senderFrame: SenderFrame | null }, ...args: A) => R {
  return (event, ...args) => {
    if (!trusted(event.senderFrame)) throw new Error('IPC refused: the sender is not the window page')
    return fn(...args)
  }
}
