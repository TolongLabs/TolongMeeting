import type { App, Session, WebContents } from 'electron'

// Rules for every web contents and session the app ever creates, including ones created later (the sign-in view uses
// its own session). A window can never reach remote content, open another window, be redirected or get a permission.

/** Blocks navigation, redirects, new windows and `<webview>` for one web contents. */
export function guardContents(contents: WebContents): void {
  const refuse = (event: { preventDefault(): void }): void => event.preventDefault()
  contents.on('will-navigate', refuse)
  contents.on('will-frame-navigate', refuse)
  contents.on('will-redirect', refuse)
  contents.on('will-attach-webview', refuse)
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

/** Denies every permission request and every permission check. */
export function guardSession(session: Session): void {
  session.setPermissionRequestHandler((_contents, _permission, allow) => allow(false))
  session.setPermissionCheckHandler(() => false)
}

export function installGuards(app: App, defaultSession: Session): void {
  app.on('web-contents-created', (_event, contents) => guardContents(contents))
  app.on('session-created', guardSession)
  guardSession(defaultSession)
}
