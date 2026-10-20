import type { App, Session, WebContents } from 'electron'

// Rules for every web contents and session the app ever creates, including ones created later (the sign-in view uses
// its own session). A window can never reach remote content, open another window, be redirected or get a permission.

let filterInstalled = false

export function sanitizeLogMessage(message: string): string {
  if (message.includes('Failed to load URL:') && message.includes('#')) {
    return message.replace(/#[^\s]*/g, '')
  }
  return message
}

/** Installs console and warning filters so Electron's load failure logs never leak URL fragments/passwords. */
export function installConsoleFilter(): void {
  if (filterInstalled) return
  filterInstalled = true

  const origError = console.error
  console.error = function (...args: unknown[]) {
    const sanitized = args.map((arg) => (typeof arg === 'string' ? sanitizeLogMessage(arg) : arg))
    return origError.apply(this, sanitized)
  }

  const origWarn = console.warn
  console.warn = function (...args: unknown[]) {
    const sanitized = args.map((arg) => (typeof arg === 'string' ? sanitizeLogMessage(arg) : arg))
    return origWarn.apply(this, sanitized)
  }

  process.on('warning', (warning) => {
    if (typeof warning.message === 'string') {
      warning.message = sanitizeLogMessage(warning.message)
    }
  })
}

/** Blocks navigation, redirects, new windows and `<webview>` for one web contents. */
export function guardContents(contents: WebContents): void {
  const refuse = (event: { preventDefault(): void }): void => event.preventDefault()
  contents.on('will-navigate', refuse)
  contents.on('will-frame-navigate', refuse)
  contents.on('will-redirect', refuse)
  contents.on('will-attach-webview', refuse)
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))

  let allowedUrl: string | null = null
  contents.on('did-start-navigation', (event) => {
    if (allowedUrl === null) {
      allowedUrl = event.url
      return
    }
    if (event.isSameDocument) return
    if (event.url !== allowedUrl) {
      setImmediate(() => {
        if (!contents.isDestroyed()) {
          contents.stop()
          contents.loadURL(allowedUrl!).catch(() => {})
        }
      })
    }
  })
}

/** Denies every permission request and every permission check. */
export function guardSession(session: Session): void {
  session.setPermissionRequestHandler((_contents, _permission, allow) => allow(false))
  session.setPermissionCheckHandler(() => false)
}

export function installGuards(app: App, defaultSession: Session): void {
  installConsoleFilter()
  app.on('web-contents-created', (_event, contents) => guardContents(contents))
  app.on('session-created', guardSession)
  guardSession(defaultSession)
}
