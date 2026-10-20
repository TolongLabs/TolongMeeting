import type { MenuItemConstructorOptions } from 'electron'

/** What the status line says (docs/DESIGN.md, Companion app, Tray). */
export type TrayStatus = 'connected' | 'offline' | 'not_paired'

export const STATUS_LABELS: Record<TrayStatus, string> = {
  connected: 'Connected',
  offline: 'Offline',
  not_paired: 'Not paired'
}

export interface TrayModel {
  status: TrayStatus
  /** The identities that run on this PC; each gets a "Sign in to <name>" item (plan 08, Task 10). */
  identities: readonly { id: string; name: string }[]
}

export interface TrayActions {
  openSummaries(): void
  openSettings(): void
  openPairing(): void
  signIn(identityId: string): void
  quit(): void
}

const MAX_NAME = 60

/** An identity name is shown as menu text: `&` would mark a keyboard shortcut on Windows, and long names are cut. */
function menuText(name: string): string {
  const cut = name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}…` : name
  return cut.replaceAll('&', '&&')
}

/**
 * The tray menu, in this order: a disabled status line, `Open summaries folder`, `Settings`, `Quit TolongMeeting`.
 * Two items appear only when they apply: `Pair this PC` while the PC is not paired (the way back to the pairing
 * window), and one `Sign in to <name>` per local identity once it is paired. They sit between `Settings` and `Quit`.
 */
export function buildTrayMenu(model: TrayModel, actions: TrayActions): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [
    { label: STATUS_LABELS[model.status], enabled: false },
    { label: 'Open summaries folder', click: actions.openSummaries },
    { label: 'Settings', click: actions.openSettings }
  ]
  if (model.status === 'not_paired') {
    items.push({ label: 'Pair this PC', click: actions.openPairing })
  } else {
    for (const identity of model.identities) {
      items.push({ label: `Sign in to ${menuText(identity.name)}`, click: () => actions.signIn(identity.id) })
    }
  }
  items.push({ type: 'separator' }, { label: 'Quit TolongMeeting', click: actions.quit })
  return items
}
